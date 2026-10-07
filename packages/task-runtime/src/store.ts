// The task ledger: tasks, work items, checkpoints, artifacts, events, app
// leases and procedure versions in one SQLite file (built-in node:sqlite).
// Every read-check-write runs inside one IMMEDIATE transaction, so two
// processes sharing the file cannot both pass a check. The file system and
// the database cannot share a transaction; artifacts.ts reconciles the two.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RuntimeError,
  TERMINAL_TASK_STATUSES,
  assertValid,
  canTransitionTask,
  canTransitionWorkItem,
  candidateDedupeKey,
  isCountable,
  leaseScopesOverlap,
  procedureKeyString,
  safePathSegment,
  systemClock,
  validateCollectResumesInput,
  validateProcedure,
} from './contracts.ts';
import { artifactRecordProblems } from './artifacts.ts';
import { checkTaskRequest, INTERRUPTED_MESSAGE, type AgentTaskLedger, type TaskOutcomeRecord, type TaskRequest, type TaskState } from './agent-requests.ts';
import type {
  AccountScope,
  ArtifactCompleteness,
  ArtifactKind,
  ArtifactRecord,
  CandidateIdentity,
  CandidateRef,
  Clock,
  CollectResumesInput,
  LeaseHolder,
  ProcedureKey,
  ProcedureStatus,
  ProcedureV2,
  SessionLease,
  TaskCheckpoint,
  TaskCounts,
  TaskEvent,
  TaskPatch,
  TaskPhase,
  TaskRecord,
  TaskSpec,
  TaskStatus,
  TaskStore,
  TerminationReason,
  WaitReason,
  WorkItem,
  WorkItemStatus,
} from './contracts.ts';

/**
 * Schema migrations, oldest first; entry i brings the file to version i + 1.
 * Exported only so tests can build an older file; never edit a shipped entry.
 */
export const TASK_STORE_MIGRATIONS: readonly string[] = [
  // v1: the ledger.
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    skill_version TEXT NOT NULL,
    input_json TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT,
    wait_reason TEXT,
    termination_reason TEXT,
    account_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE checkpoints (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    unit TEXT,
    item_id TEXT,
    cursor TEXT,
    last_committed_item_id TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    dedupe_key TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    identity_json TEXT NOT NULL,
    ref_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    last_completed_unit TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, dedupe_key),
    UNIQUE (task_id, candidate_id)
  );
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    item_id TEXT NOT NULL REFERENCES work_items(id),
    kind TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    completeness TEXT NOT NULL,
    validation_json TEXT NOT NULL,
    capture_json TEXT,
    procedure_ids_json TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    committed_at TEXT NOT NULL
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    item_id TEXT,
    unit TEXT,
    step_id TEXT,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    result TEXT,
    evidence_ref TEXT,
    detail_json TEXT
  );
  CREATE TABLE leases (
    lease_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    holder TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    task_id TEXT,
    expires_ms INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE procedures (
    id TEXT PRIMARY KEY,
    key_string TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (key_string, version)
  );
  `,
  // v2: lookup indexes for the per-task queries.
  `
  CREATE INDEX work_items_task_status ON work_items(task_id, status);
  CREATE INDEX artifacts_task_item ON artifacts(task_id, item_id);
  CREATE INDEX events_task_item ON events(task_id, item_id, seq);
  `,
  // v3: tasks run by agents (RFC 0001), in the same ledger as the skills' tasks.
  `
  CREATE TABLE agent_tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    origin TEXT NOT NULL,
    state TEXT NOT NULL,
    input_json TEXT,
    timeout_ms INTEGER,
    taken_at TEXT,
    submitted_at TEXT,
    started_at TEXT,
    ended_at TEXT,
    result_json TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX agent_tasks_state ON agent_tasks(state, submitted_at);
  `,
];

export const TASK_STORE_SCHEMA_VERSION: number = TASK_STORE_MIGRATIONS.length;

/** ~/Library/Application Support/2ndscreen/tasks/tasks.db */
export function defaultTaskDbPath(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', '2ndscreen', 'tasks', 'tasks.db');
}

const BUSY_TIMEOUT_MS = 5_000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

const TASK_PHASES: readonly TaskPhase[] = ['preparing', 'learning', 'executing', 'repairing', 'finalizing'];
const WAIT_REASONS: readonly WaitReason[] = [
  'login_required', 'captcha', 'job_ambiguous', 'account_changed', 'model_unavailable',
  'budget_exhausted', 'capability_missing', 'permission_missing', 'window_moved', 'storage_full',
];
const TERMINATION_REASONS: readonly TerminationReason[] = [
  'target_reached', 'source_exhausted', 'browse_limit', 'deadline', 'budget_exhausted', 'cancelled', 'fatal_error',
];
const ARTIFACT_KINDS: readonly ArtifactKind[] = ['original', 'captured_page', 'captured_image', 'resume_text', 'metadata', 'diagnostic'];
const COMPLETENESS: readonly ArtifactCompleteness[] = ['complete', 'partial_capture', 'unverified', 'invalid'];
const PROCEDURE_STATUSES: readonly ProcedureStatus[] = ['seeded', 'trial', 'stable', 'degraded', 'retired'];
const LEASE_HOLDERS: readonly LeaseHolder[] = ['runtime', 'bridge', 'legacy-assistant'];

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const json = <T>(v: unknown): T | undefined => (typeof v === 'string' ? (JSON.parse(v) as T) : undefined);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Turns SQLite failures into runtime errors callers can branch on. */
function mapError(error: unknown): unknown {
  if (error instanceof RuntimeError) return error;
  const e = error as { errcode?: number; message?: string };
  const primary = typeof e?.errcode === 'number' ? e.errcode & 0xff : undefined;
  const message = e?.message ?? String(error);
  if (primary === 13) return new RuntimeError('storage_full', `task database is full: ${message}`);
  if (primary === 19) return new RuntimeError('conflict', `constraint failed: ${message}`);
  if (primary === 5 || primary === 6) return new RuntimeError('io', `task database is busy: ${message}`, { busy: true });
  return new RuntimeError('io', `task database error: ${message}`);
}

/** The task ledger, which also records the tasks agents run. */
export type TaskLedgerStore = TaskStore & { readonly agentTasks: AgentTaskLedger };

const AGENT_TASK_STATES: readonly TaskState[] = ['queued', 'running', 'succeeded', 'partial', 'failed'];

/** Open (and create or migrate) the task ledger at `path`; ':memory:' for tests. */
export async function openTaskStore(options: { path: string; clock?: Clock; newId?: () => string }): Promise<TaskLedgerStore> {
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? (() => randomUUID());
  const memory = options.path === ':memory:';
  if (!memory) mkdirSync(dirname(options.path), { recursive: true });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.path, { enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS });
  } catch (error) {
    throw mapError(error);
  }
  try {
    // Also set explicitly: the constructor's timeout option is newer than Node 22.13.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!memory) {
      await enableWal(db);
      db.exec('PRAGMA synchronous = FULL');
    }
    migrate(db, options.path, clock);
  } catch (error) {
    db.close();
    throw mapError(error);
  }
  return new SqliteTaskStore(db, clock, newId);
}

/**
 * Switches the file to WAL once. Changing the journal mode does not wait on
 * the busy handler, so processes opening a fresh file together retry it with
 * a bounded backoff; WAL is persistent, so later opens skip the switch.
 */
async function enableWal(db: DatabaseSync): Promise<void> {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      const mode = String((db.prepare('PRAGMA journal_mode').get() as Row).journal_mode);
      if (mode === 'wal') return;
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      const busy = mapError(error);
      if (!(busy instanceof RuntimeError && busy.details?.busy) || Date.now() + wait > deadline) throw busy;
      await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * wait)));
    }
  }
}

const schemaVersion = (db: DatabaseSync): number => Number((db.prepare('PRAGMA user_version').get() as Row).user_version);

/**
 * Brings the file to TASK_STORE_SCHEMA_VERSION. The version is read again
 * inside the IMMEDIATE transaction that applies the migrations, so two
 * processes opening the same file at once cannot both migrate from a stale
 * version; the loser sees the finished schema and does nothing.
 */
function migrate(db: DatabaseSync, path: string, clock: Clock): void {
  const refuseNewer = (found: number) => {
    if (found > TASK_STORE_SCHEMA_VERSION)
      throw new RuntimeError('conflict', `task database schema ${found} is newer than supported ${TASK_STORE_SCHEMA_VERSION}`, {
        found,
        supported: TASK_STORE_SCHEMA_VERSION,
      });
  };
  const seen = schemaVersion(db);
  refuseNewer(seen);
  if (seen === TASK_STORE_SCHEMA_VERSION) return;
  let backup: string | undefined;
  if (seen > 0 && path !== ':memory:') {
    // A consistent copy, even in WAL mode, before anything is altered; the
    // name is unique so processes racing to migrate never collide.
    const stamp = clock.now().toISOString().replace(/[:.]/g, '-');
    backup = `${path}.v${seen}-${stamp}-${process.pid}-${randomUUID().slice(0, 8)}.bak`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = schemaVersion(db);
    refuseNewer(current);
    if (current === TASK_STORE_SCHEMA_VERSION) {
      // Another process migrated while this one was backing up.
      db.exec('ROLLBACK');
      if (backup) rmSync(backup, { force: true });
      return;
    }
    if (current === 0) {
      const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as Row;
      if (Number(tables.n) > 0) throw new RuntimeError('conflict', 'file has tables but no task store schema version; refusing to adopt it');
    }
    for (let version = current + 1; version <= TASK_STORE_SCHEMA_VERSION; version++) db.exec(TASK_STORE_MIGRATIONS[version - 1]!);
    db.exec(`PRAGMA user_version = ${TASK_STORE_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

class SqliteTaskStore implements TaskLedgerStore {
  private closed = false;
  readonly agentTasks: AgentTaskLedger;

  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(db: DatabaseSync, clock: Clock, newId: () => string) {
    this.db = db;
    this.clock = clock;
    this.newId = newId;
    this.agentTasks = this.agentTaskLedger();
  }

  // -------------------------------------------------------------------------
  // agent tasks

  private agentTaskLedger(): AgentTaskLedger {
    const toRecord = (row: Row): TaskOutcomeRecord => {
      const result = json<Partial<TaskOutcomeRecord>>(row.result_json) ?? {};
      return {
        taskId: String(row.id),
        agentId: String(row.agent_id),
        taskType: String(row.task_type),
        origin: row.origin === 'agent' ? 'agent' : 'runtime',
        state: row.state as TaskState,
        ...(str(row.submitted_at) && { submittedAt: String(row.submitted_at) }),
        ...(str(row.started_at) && { startedAt: String(row.started_at) }),
        ...(str(row.ended_at) && { endedAt: String(row.ended_at) }),
        ...result,
      };
    };
    const toRequest = (row: Row): TaskRequest => ({
      taskId: String(row.id),
      agentId: String(row.agent_id),
      taskType: String(row.task_type),
      input: json<unknown>(row.input_json) ?? null,
      submittedAt: String(row.submitted_at ?? row.updated_at),
      ...(typeof row.timeout_ms === 'number' && { timeoutMs: row.timeout_ms }),
      ...(typeof row.timeout_ms === 'bigint' && { timeoutMs: Number(row.timeout_ms) }),
    });
    return {
      submit: async (request) => {
        checkTaskRequest(request);
        if (typeof request.agentId !== 'string' || typeof request.taskType !== 'string' || !isIso(request.submittedAt))
          throw new RuntimeError('invalid_input', 'an agent task needs an agent id, a task type and a submit time');
        this.tx((db) => {
          if (db.prepare('SELECT 1 FROM agent_tasks WHERE id = ?').get(request.taskId) || db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(request.taskId))
            throw new RuntimeError('conflict', `task ${request.taskId} already exists`);
          db.prepare(
            `INSERT INTO agent_tasks (id, agent_id, task_type, origin, state, input_json, timeout_ms, submitted_at, updated_at)
             VALUES (?, ?, ?, 'runtime', 'queued', ?, ?, ?, ?)`,
          ).run(request.taskId, request.agentId, request.taskType, JSON.stringify(request.input ?? null), request.timeoutMs ?? null, request.submittedAt, this.now());
        });
      },
      take: async () =>
        this.tx((db) => {
          const rows = db
            .prepare(`SELECT * FROM agent_tasks WHERE state = 'queued' AND origin = 'runtime' AND taken_at IS NULL ORDER BY submitted_at, id`)
            .all();
          const now = this.now();
          for (const row of rows) db.prepare('UPDATE agent_tasks SET taken_at = ?, updated_at = ? WHERE id = ?').run(now, now, String(row.id));
          return rows.map(toRequest);
        }),
      record: async (record) => {
        if (!AGENT_TASK_STATES.includes(record.state)) throw new RuntimeError('invalid_input', `bad agent task state ${record.state}`);
        const { taskId, agentId, taskType, origin, state, submittedAt, startedAt, endedAt, ...result } = record;
        const now = this.now();
        this.tx((db) => {
          db.prepare(
            `INSERT INTO agent_tasks (id, agent_id, task_type, origin, state, submitted_at, started_at, ended_at, result_json, taken_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               state = excluded.state,
               task_type = CASE WHEN excluded.task_type = '?' THEN agent_tasks.task_type ELSE excluded.task_type END,
               submitted_at = COALESCE(agent_tasks.submitted_at, excluded.submitted_at),
               started_at = COALESCE(excluded.started_at, agent_tasks.started_at),
               ended_at = excluded.ended_at,
               result_json = excluded.result_json,
               taken_at = COALESCE(agent_tasks.taken_at, excluded.taken_at),
               updated_at = excluded.updated_at`,
          ).run(taskId, agentId, taskType, origin, state, submittedAt ?? null, startedAt ?? null, endedAt ?? null, Object.keys(result).length ? JSON.stringify(result) : null, now, now);
        });
      },
      get: async (taskId) => this.read((db) => {
        const row = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId);
        return row ? toRecord(row) : undefined;
      }),
      list: async (filter = {}) =>
        this.read((db) => {
          const where: string[] = [];
          const args: string[] = [];
          if (filter.states?.length) {
            where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
            args.push(...filter.states);
          }
          if (filter.agentId) {
            where.push('agent_id = ?');
            args.push(filter.agentId);
          }
          const limit = Number.isInteger(filter.limit) && filter.limit! > 0 ? ` LIMIT ${filter.limit}` : '';
          return db
            .prepare(`SELECT * FROM agent_tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(submitted_at, started_at, updated_at) DESC, id${limit}`)
            .all(...args)
            .map(toRecord);
        }),
      recover: async (options = {}) =>
        this.tx((db) => {
          let releasedLeases = 0;
          for (const pid of options.deadOwners ?? [])
            releasedLeases += Number(db.prepare(`DELETE FROM leases WHERE owner_pid = ? AND task_id LIKE 'agent:%'`).run(pid).changes);
          const now = this.now();
          const stale = db.prepare(`SELECT * FROM agent_tasks WHERE state = 'running' OR (state = 'queued' AND origin = 'agent')`).all();
          for (const row of stale) {
            const result = { ...(json<Record<string, unknown>>(row.result_json) ?? {}), failure: 'interrupted', message: INTERRUPTED_MESSAGE };
            db.prepare(`UPDATE agent_tasks SET state = 'failed', ended_at = ?, result_json = ?, updated_at = ? WHERE id = ?`).run(now, JSON.stringify(result), now, String(row.id));
          }
          const taken = db.prepare(`SELECT id FROM agent_tasks WHERE state = 'queued' AND origin = 'runtime' AND taken_at IS NOT NULL`).all();
          db.prepare(`UPDATE agent_tasks SET taken_at = NULL, updated_at = ? WHERE state = 'queued' AND origin = 'runtime' AND taken_at IS NOT NULL`).run(now);
          return { interrupted: stale.map((r) => String(r.id)), requeued: taken.map((r) => String(r.id)), releasedLeases };
        }),
    };
  }

  // -------------------------------------------------------------------------
  // plumbing

  private now(): string {
    return this.clock.now().toISOString();
  }

  private open(): DatabaseSync {
    if (this.closed) throw new RuntimeError('io', 'task store is closed');
    return this.db;
  }

  private tx<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.open();
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw mapError(error);
    }
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back by SQLite
      }
      throw mapError(error);
    }
  }

  private read<T>(fn: (db: DatabaseSync) => T): T {
    try {
      return fn(this.open());
    } catch (error) {
      throw mapError(error);
    }
  }

  private taskRow(db: DatabaseSync, taskId: string): Row {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!row) throw new RuntimeError('not_found', `no task ${taskId}`);
    return row;
  }

  private itemRow(db: DatabaseSync, itemId: string): Row {
    const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId);
    if (!row) throw new RuntimeError('not_found', `no work item ${itemId}`);
    return row;
  }

  private countsFor(db: DatabaseSync, taskId: string, requested: number): TaskCounts {
    const counts: TaskCounts = { requested, browsed: 0, committed: 0, unavailable: 0, failed: 0, ambiguous: 0, diagnostic: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM work_items WHERE task_id = ? GROUP BY status').all(taskId)) {
      const n = Number(r.n);
      if (r.status === 'committed') counts.committed = n;
      else if (r.status === 'unavailable') counts.unavailable = n;
      else if (r.status === 'failed') counts.failed = n;
      else if (r.status === 'ambiguous') counts.ambiguous = n;
    }
    const browsed = db
      .prepare("SELECT COUNT(*) AS n FROM work_items WHERE task_id = ? AND (attempt > 0 OR status <> 'discovered')")
      .get(taskId) as Row;
    counts.browsed = Number(browsed.n);
    const diagnostic = db
      .prepare(
        `SELECT COUNT(DISTINCT w.id) AS n FROM work_items w JOIN artifacts a ON a.item_id = w.id
         WHERE w.task_id = ? AND w.status <> 'committed'`,
      )
      .get(taskId) as Row;
    counts.diagnostic = Number(diagnostic.n);
    return counts;
  }

  private toTask(db: DatabaseSync, row: Row): TaskRecord {
    const input = json<CollectResumesInput>(row.input_json)!;
    const task: TaskRecord = {
      id: String(row.id),
      skillId: String(row.skill_id),
      skillVersion: String(row.skill_version),
      input,
      status: row.status as TaskStatus,
      counts: this.countsFor(db, String(row.id), input.requestedCount),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.phase) task.phase = row.phase as TaskPhase;
    if (row.wait_reason) task.waitReason = row.wait_reason as WaitReason;
    if (row.termination_reason) task.terminationReason = row.termination_reason as TerminationReason;
    const account = json<AccountScope>(row.account_json);
    if (account) task.account = account;
    const error = json<TaskRecord['error']>(row.error_json);
    if (error) task.error = error;
    return task;
  }

  private toItem(row: Row): WorkItem {
    const item: WorkItem = {
      id: String(row.id),
      taskId: String(row.task_id),
      identity: json<CandidateIdentity>(row.identity_json)!,
      ref: json<CandidateRef>(row.ref_json)!,
      status: row.status as WorkItemStatus,
      attempt: Number(row.attempt),
      updatedAt: String(row.updated_at),
    };
    if (row.last_completed_unit) item.lastCompletedUnit = String(row.last_completed_unit);
    if (row.reason) item.reason = String(row.reason);
    return item;
  }

  private toArtifact(row: Row): ArtifactRecord {
    const record: ArtifactRecord = {
      id: String(row.id),
      itemId: String(row.item_id),
      kind: row.kind as ArtifactKind,
      relativePath: String(row.relative_path),
      sha256: String(row.sha256),
      bytes: Number(row.bytes),
      completeness: row.completeness as ArtifactCompleteness,
      validation: json(row.validation_json)!,
      procedureIds: json<string[]>(row.procedure_ids_json) ?? [],
      acquiredAt: String(row.acquired_at),
    };
    const capture = json<ArtifactRecord['capture']>(row.capture_json);
    if (capture) record.capture = capture;
    return record;
  }

  private insertEvent(db: DatabaseSync, event: TaskEvent): void {
    db.prepare(
      `INSERT INTO events (task_id, item_id, unit, step_id, type, at, result, evidence_ref, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.taskId,
      event.itemId ?? null,
      event.unit ?? null,
      event.stepId ?? null,
      event.type,
      event.at,
      event.result ?? null,
      event.evidenceRef ?? null,
      event.detail === undefined ? null : JSON.stringify(event.detail),
    );
  }

  // -------------------------------------------------------------------------
  // tasks

  async createTask(spec: Pick<TaskSpec, 'id' | 'version'>, input: CollectResumesInput): Promise<TaskRecord> {
    if (!spec?.id || !spec.version) throw new RuntimeError('invalid_input', 'spec id and version are required');
    const value = assertValid(validateCollectResumesInput(input, this.clock.now()), 'task input');
    const id = this.newId();
    // The task id names the output folder <outputDir>/<taskId>.
    if (!safePathSegment(id)) throw new RuntimeError('invalid_input', `task id ${id} is not a safe path segment`);
    const now = this.now();
    return this.tx((db) => {
      db.prepare(
        `INSERT INTO tasks (id, skill_id, skill_version, input_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(id, spec.id, spec.version, JSON.stringify(value), now, now);
      this.insertEvent(db, { taskId: id, type: 'task_created', at: now });
      return this.toTask(db, this.taskRow(db, id));
    });
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    return this.read((db) => {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      return row ? this.toTask(db, row) : undefined;
    });
  }

  async listTasks(filter?: { status?: TaskStatus[] }): Promise<TaskRecord[]> {
    return this.read((db) => {
      const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at, rowid').all();
      return rows
        .filter((r) => !filter?.status || filter.status.includes(r.status as TaskStatus))
        .map((r) => this.toTask(db, r));
    });
  }

  /**
   * Moves a task by the contract's transition table. A call whose `to` equals
   * the current non-terminal status only applies the patch (e.g. a phase
   * change while running); the table itself has no self-transitions.
   */
  async transitionTask(taskId: string, to: TaskStatus, patch: TaskPatch = {}, from?: TaskStatus): Promise<TaskRecord> {
    if (patch.phase !== undefined && !TASK_PHASES.includes(patch.phase)) throw new RuntimeError('invalid_input', `bad phase ${patch.phase}`);
    if (patch.waitReason && !WAIT_REASONS.includes(patch.waitReason)) throw new RuntimeError('invalid_input', `bad wait reason ${patch.waitReason}`);
    if (patch.terminationReason !== undefined && !TERMINATION_REASONS.includes(patch.terminationReason))
      throw new RuntimeError('invalid_input', `bad termination reason ${patch.terminationReason}`);
    if (patch.account !== undefined && (patch.account.platform !== 'boss' || !patch.account.accountKey || !['observed', 'explicit'].includes(patch.account.binding)))
      throw new RuntimeError('invalid_input', 'account must be a boss account scope with a key and binding');
    return this.tx((db) => {
      const row = this.taskRow(db, taskId);
      const current = row.status as TaskStatus;
      if (from !== undefined && current !== from) throw new RuntimeError('conflict', `task ${taskId} is ${current}, not ${from}`, { current });
      const patchOnly = to === current && !TERMINAL_TASK_STATUSES.includes(current);
      if (!patchOnly && !canTransitionTask(current, to))
        throw new RuntimeError('conflict', `task ${taskId} cannot move from ${current} to ${to}`, { current, to });

      let waitReason = str(row.wait_reason) ?? null;
      if (patch.waitReason !== undefined) waitReason = patch.waitReason;
      else if (to === 'running' || TERMINAL_TASK_STATUSES.includes(to)) waitReason = null;
      if (to === 'waiting_user' && !waitReason) throw new RuntimeError('invalid_input', 'waiting_user needs a wait reason');

      let accountJson = str(row.account_json) ?? null;
      if (patch.account) {
        const old = json<AccountScope>(row.account_json);
        if (old && old.accountKey !== patch.account.accountKey) {
          const items = db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE task_id = ?').get(taskId) as Row;
          if (Number(items.n) > 0)
            throw new RuntimeError('conflict', 'the task already holds candidates of another account; start a new task', {
              bound: old.accountKey,
              seen: patch.account.accountKey,
            });
        }
        accountJson = JSON.stringify(patch.account);
      }
      let errorJson = str(row.error_json) ?? null;
      if (patch.error === null) errorJson = null;
      else if (patch.error) errorJson = JSON.stringify(patch.error);

      const now = this.now();
      db.prepare(
        `UPDATE tasks SET status = ?, phase = ?, wait_reason = ?, termination_reason = ?, account_json = ?, error_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        to,
        patch.phase ?? str(row.phase) ?? null,
        waitReason,
        patch.terminationReason ?? str(row.termination_reason) ?? null,
        accountJson,
        errorJson,
        now,
        taskId,
      );
      if (!patchOnly) this.insertEvent(db, { taskId, type: 'task_status', at: now, detail: { from: current, to } });
      return this.toTask(db, this.taskRow(db, taskId));
    });
  }

  async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<void> {
    if (!isIso(checkpoint.updatedAt)) throw new RuntimeError('invalid_input', 'checkpoint.updatedAt must be an ISO time');
    this.tx((db) => {
      this.taskRow(db, checkpoint.taskId);
      for (const id of [checkpoint.itemId, checkpoint.lastCommittedItemId]) {
        if (id === undefined) continue;
        const item = db.prepare('SELECT task_id FROM work_items WHERE id = ?').get(id);
        if (!item || item.task_id !== checkpoint.taskId) throw new RuntimeError('invalid_input', `checkpoint item ${id} is not in task ${checkpoint.taskId}`);
      }
      db.prepare(
        `INSERT INTO checkpoints (task_id, unit, item_id, cursor, last_committed_item_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET unit = excluded.unit, item_id = excluded.item_id, cursor = excluded.cursor,
           last_committed_item_id = excluded.last_committed_item_id, updated_at = excluded.updated_at`,
      ).run(
        checkpoint.taskId,
        checkpoint.unit ?? null,
        checkpoint.itemId ?? null,
        checkpoint.cursor ?? null,
        checkpoint.lastCommittedItemId ?? null,
        checkpoint.updatedAt,
      );
    });
  }

  async getCheckpoint(taskId: string): Promise<TaskCheckpoint | undefined> {
    return this.read((db) => {
      const row = db.prepare('SELECT * FROM checkpoints WHERE task_id = ?').get(taskId);
      if (!row) return undefined;
      const checkpoint: TaskCheckpoint = { taskId, updatedAt: String(row.updated_at) };
      if (row.unit) checkpoint.unit = String(row.unit);
      if (row.item_id) checkpoint.itemId = String(row.item_id);
      if (row.cursor) checkpoint.cursor = String(row.cursor);
      if (row.last_committed_item_id) checkpoint.lastCommittedItemId = String(row.last_committed_item_id);
      return checkpoint;
    });
  }

  // -------------------------------------------------------------------------
  // work items

  /**
   * Idempotent on candidateDedupeKey within the task. A known candidate keeps
   * its id, status and identity; only the snapshot-bound ref is refreshed.
   * The identity must belong to the task's bound account, and its
   * candidateId (the folder name) must not already name another candidate.
   */
  async upsertWorkItem(taskId: string, identity: CandidateIdentity, ref: CandidateRef): Promise<WorkItem> {
    if (!identity || !safePathSegment(identity.candidateId))
      throw new RuntimeError('invalid_input', `candidateId ${identity?.candidateId} is not a safe path segment`);
    if (!identity.accountKey || !identity.fingerprint) throw new RuntimeError('invalid_input', 'identity needs accountKey and fingerprint');
    if (!['platform_id', 'strong', 'weak'].includes(identity.confidence)) throw new RuntimeError('invalid_input', 'bad identity confidence');
    if (identity.confidence === 'platform_id' && !identity.platformId) throw new RuntimeError('invalid_input', 'platform_id confidence needs a platformId');
    if (!ref || typeof ref.sourceRef !== 'string' || typeof ref.name !== 'string') throw new RuntimeError('invalid_input', 'ref needs sourceRef and name');
    const key = candidateDedupeKey(identity);
    return this.tx((db) => {
      const task = this.taskRow(db, taskId);
      if (TERMINAL_TASK_STATUSES.includes(task.status as TaskStatus)) throw new RuntimeError('conflict', `task ${taskId} has ended`);
      const account = json<AccountScope>(task.account_json);
      if (!account) throw new RuntimeError('conflict', `task ${taskId} has no bound account; bind it before adding candidates`);
      if (account.accountKey !== identity.accountKey)
        throw new RuntimeError('conflict', 'candidate belongs to a different account than the task', { bound: account.accountKey, seen: identity.accountKey });
      const now = this.now();
      const existing = db.prepare('SELECT * FROM work_items WHERE task_id = ? AND dedupe_key = ?').get(taskId, key);
      if (existing) {
        db.prepare('UPDATE work_items SET ref_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ref), now, String(existing.id));
        return this.toItem(this.itemRow(db, String(existing.id)));
      }
      const clash = db.prepare('SELECT id FROM work_items WHERE task_id = ? AND candidate_id = ?').get(taskId, identity.candidateId);
      if (clash) throw new RuntimeError('conflict', `candidateId ${identity.candidateId} already names another candidate`, { itemId: clash.id });
      const id = this.newId();
      if (!safePathSegment(id)) throw new RuntimeError('invalid_input', `item id ${id} is not a safe path segment`);
      db.prepare(
        `INSERT INTO work_items (id, task_id, dedupe_key, candidate_id, account_key, identity_json, ref_json, status, attempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', 0, ?, ?)`,
      ).run(id, taskId, key, identity.candidateId, identity.accountKey, JSON.stringify(identity), JSON.stringify(ref), now, now);
      this.insertEvent(db, { taskId, itemId: id, type: 'item_discovered', at: now, detail: { confidence: identity.confidence } });
      return this.toItem(this.itemRow(db, id));
    });
  }

  /** Moves an item by the contract table. `committed` is reachable only through commitItem. */
  async transitionWorkItem(itemId: string, to: WorkItemStatus, patch: { lastCompletedUnit?: string; reason?: string } = {}): Promise<WorkItem> {
    if (to === 'committed') throw new RuntimeError('conflict', 'an item becomes committed only through commitItem with its artifacts');
    return this.tx((db) => {
      const row = this.itemRow(db, itemId);
      const current = row.status as WorkItemStatus;
      if (!canTransitionWorkItem(current, to))
        throw new RuntimeError('conflict', `item ${itemId} cannot move from ${current} to ${to}`, { current, to });
      const now = this.now();
      const attempt = Number(row.attempt) + (to === 'processing' ? 1 : 0);
      // A new attempt starts without the previous attempt's failure reason.
      const reason = patch.reason ?? (to === 'processing' ? null : str(row.reason) ?? null);
      db.prepare('UPDATE work_items SET status = ?, attempt = ?, last_completed_unit = ?, reason = ?, updated_at = ? WHERE id = ?').run(
        to,
        attempt,
        patch.lastCompletedUnit ?? str(row.last_completed_unit) ?? null,
        reason,
        now,
        itemId,
      );
      this.insertEvent(db, { taskId: String(row.task_id), itemId, type: 'item_status', at: now, detail: { from: current, to, reason: patch.reason } });
      return this.toItem(this.itemRow(db, itemId));
    });
  }

  async listWorkItems(taskId: string, filter?: { status?: WorkItemStatus[] }): Promise<WorkItem[]> {
    return this.read((db) =>
      db
        .prepare('SELECT * FROM work_items WHERE task_id = ? ORDER BY created_at, rowid')
        .all(taskId)
        .filter((r) => !filter?.status || filter.status.includes(r.status as WorkItemStatus))
        .map((r) => this.toItem(r)),
    );
  }

  /**
   * In one transaction: insert the artifact records and move the validated
   * item to committed if they are countable for the task's capture mode,
   * otherwise to failed with the artifacts kept as diagnostics. Every record
   * must sit under candidates/<the item's candidateId>/. Repeating the
   * commit of an already committed item with the same records is a no-op.
   */
  async commitItem(itemId: string, artifacts: ArtifactRecord[]): Promise<{ item: WorkItem; counted: boolean }> {
    if (!Array.isArray(artifacts) || artifacts.length === 0) throw new RuntimeError('invalid_input', 'commitItem needs at least one artifact');
    return this.tx((db) => {
      const row = this.itemRow(db, itemId);
      const taskId = String(row.task_id);
      const task = this.taskRow(db, taskId);
      const candidateId = String(row.candidate_id);
      const ids = new Set<string>();
      for (const a of artifacts) {
        const problems = artifactProblems(a, itemId, candidateId);
        if (ids.has(a.id)) problems.push(`artifact ${a.id} is repeated`);
        ids.add(a.id);
        if (problems.length) throw new RuntimeError('invalid_input', `artifact ${a.id} cannot be committed: ${problems.join('; ')}`, { problems });
      }
      const same = (a: ArtifactRecord): boolean => {
        const old = db.prepare('SELECT item_id, sha256, relative_path, kind, completeness FROM artifacts WHERE id = ?').get(a.id);
        if (!old) return false;
        if (old.item_id !== itemId || old.sha256 !== a.sha256 || old.relative_path !== a.relativePath || old.kind !== a.kind || old.completeness !== a.completeness)
          throw new RuntimeError('conflict', `artifact ${a.id} is already recorded with different content`);
        return true;
      };

      const status = row.status as WorkItemStatus;
      if (status === 'committed') {
        if (artifacts.every(same)) return { item: this.toItem(row), counted: true };
        throw new RuntimeError('conflict', `item ${itemId} is already committed with other artifacts`);
      }
      if (status !== 'validated') throw new RuntimeError('conflict', `item ${itemId} is ${status}; only a validated item can be committed`, { current: status });

      const now = this.now();
      const insert = db.prepare(
        `INSERT INTO artifacts (id, task_id, item_id, kind, relative_path, sha256, bytes, completeness, validation_json, capture_json,
           procedure_ids_json, acquired_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of artifacts) {
        if (same(a)) continue;
        insert.run(
          a.id, taskId, itemId, a.kind, a.relativePath, a.sha256, a.bytes, a.completeness, JSON.stringify(a.validation),
          a.capture === undefined ? null : JSON.stringify(a.capture), JSON.stringify(a.procedureIds ?? []), a.acquiredAt, now,
        );
      }
      const mode = json<CollectResumesInput>(task.input_json)!.captureMode;
      const counted = isCountable(artifacts, mode);
      const reason = counted
        ? null
        : `not_countable: ${artifacts.map((a) => `${a.kind}/${a.completeness}`).join(', ')} under ${mode}`;
      db.prepare("UPDATE work_items SET status = ?, reason = ?, last_completed_unit = 'persist_candidate', updated_at = ? WHERE id = ?").run(
        counted ? 'committed' : 'failed',
        reason,
        now,
        itemId,
      );
      if (counted) {
        db.prepare(
          `INSERT INTO checkpoints (task_id, last_committed_item_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET last_committed_item_id = excluded.last_committed_item_id, updated_at = excluded.updated_at`,
        ).run(taskId, itemId, now);
      }
      this.insertEvent(db, {
        taskId,
        itemId,
        unit: 'persist_candidate',
        type: counted ? 'item_committed' : 'item_not_counted',
        at: now,
        result: counted ? 'ok' : 'failed',
        evidenceRef: artifacts.map((a) => a.relativePath).join(','),
        detail: { artifacts: artifacts.map((a) => a.id), mode },
      });
      return { item: this.toItem(this.itemRow(db, itemId)), counted };
    });
  }

  async listArtifacts(taskId: string, itemId?: string): Promise<ArtifactRecord[]> {
    return this.read((db) => {
      const rows = itemId === undefined
        ? db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY committed_at, rowid').all(taskId)
        : db.prepare('SELECT * FROM artifacts WHERE task_id = ? AND item_id = ? ORDER BY committed_at, rowid').all(taskId, itemId);
      return rows.map((r) => this.toArtifact(r));
    });
  }

  // -------------------------------------------------------------------------
  // events and counts

  async appendEvent(event: TaskEvent): Promise<void> {
    if (!event?.type || !isIso(event.at)) throw new RuntimeError('invalid_input', 'event needs a type and an ISO time');
    if (event.result !== undefined && !['ok', 'failed', 'skipped'].includes(event.result)) throw new RuntimeError('invalid_input', 'bad event result');
    this.tx((db) => {
      this.taskRow(db, event.taskId);
      this.insertEvent(db, event);
    });
  }

  /** Events in the order they were written; `limit` keeps the most recent ones. */
  async listEvents(taskId: string, filter?: { itemId?: string; limit?: number }): Promise<TaskEvent[]> {
    return this.read((db) => {
      const limit = filter?.limit !== undefined && filter.limit >= 0 ? Math.floor(filter.limit) : -1;
      const rows = filter?.itemId === undefined
        ? db.prepare('SELECT * FROM (SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(taskId, limit)
        : db
            .prepare('SELECT * FROM (SELECT * FROM events WHERE task_id = ? AND item_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
            .all(taskId, filter.itemId, limit);
      return rows.map((r) => {
        const event: TaskEvent = { taskId: String(r.task_id), type: String(r.type), at: String(r.at) };
        if (r.item_id) event.itemId = String(r.item_id);
        if (r.unit) event.unit = String(r.unit);
        if (r.step_id) event.stepId = String(r.step_id);
        if (r.result) event.result = r.result as TaskEvent['result'];
        if (r.evidence_ref) event.evidenceRef = String(r.evidence_ref);
        const detail = json<Record<string, unknown>>(r.detail_json);
        if (detail) event.detail = detail;
        return event;
      });
    });
  }

  async counts(taskId: string): Promise<TaskCounts> {
    return this.read((db) => {
      const task = this.taskRow(db, taskId);
      return this.countsFor(db, taskId, json<CollectResumesInput>(task.input_json)!.requestedCount);
    });
  }

  // -------------------------------------------------------------------------
  // leases

  async acquireLease(request: Omit<SessionLease, 'leaseId' | 'expiresAt'> & { ttlMs: number }): Promise<SessionLease> {
    if (!request?.scopeKey || !request.scopeKey.includes(':')) throw new RuntimeError('invalid_input', 'lease scopeKey must come from leaseScopeKey');
    if (!LEASE_HOLDERS.includes(request.holder)) throw new RuntimeError('invalid_input', `bad lease holder ${request.holder}`);
    if (!Number.isInteger(request.ownerPid) || request.ownerPid <= 0) throw new RuntimeError('invalid_input', 'ownerPid must be a positive integer');
    checkTtl(request.ttlMs);
    return this.tx((db) => {
      const nowMs = this.clock.now().getTime();
      for (const row of db.prepare('SELECT * FROM leases').all()) {
        if (!leaseScopesOverlap(String(row.scope_key), request.scopeKey)) continue;
        if (Number(row.expires_ms) > nowMs)
          throw new RuntimeError('lease_held', `${row.holder} (pid ${row.owner_pid}) holds ${row.scope_key} until ${row.expires_at}`, {
            leaseId: row.lease_id,
            scopeKey: row.scope_key,
            holder: row.holder,
            ownerPid: Number(row.owner_pid),
            taskId: row.task_id ?? undefined,
            expiresAt: row.expires_at,
          });
        db.prepare('DELETE FROM leases WHERE lease_id = ?').run(String(row.lease_id));
      }
      const lease: SessionLease = {
        leaseId: this.newId(),
        scopeKey: request.scopeKey,
        holder: request.holder,
        ownerPid: request.ownerPid,
        expiresAt: new Date(nowMs + request.ttlMs).toISOString(),
      };
      if (request.taskId !== undefined) lease.taskId = request.taskId;
      db.prepare('INSERT INTO leases (lease_id, scope_key, holder, owner_pid, task_id, expires_ms, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        lease.leaseId, lease.scopeKey, lease.holder, lease.ownerPid, lease.taskId ?? null, nowMs + request.ttlMs, lease.expiresAt,
      );
      return lease;
    });
  }

  /** Extends an unexpired lease. An expired lease is not revived: acquire a new one. */
  async renewLease(leaseId: string, ttlMs: number): Promise<SessionLease> {
    checkTtl(ttlMs);
    return this.tx((db) => {
      const row = db.prepare('SELECT * FROM leases WHERE lease_id = ?').get(leaseId);
      if (!row) throw new RuntimeError('not_found', `no lease ${leaseId}`);
      const nowMs = this.clock.now().getTime();
      if (Number(row.expires_ms) <= nowMs) throw new RuntimeError('conflict', `lease ${leaseId} expired at ${row.expires_at}; acquire a new one`);
      const expiresAt = new Date(nowMs + ttlMs).toISOString();
      db.prepare('UPDATE leases SET expires_ms = ?, expires_at = ? WHERE lease_id = ?').run(nowMs + ttlMs, expiresAt, leaseId);
      const lease: SessionLease = {
        leaseId,
        scopeKey: String(row.scope_key),
        holder: row.holder as LeaseHolder,
        ownerPid: Number(row.owner_pid),
        expiresAt,
      };
      if (row.task_id) lease.taskId = String(row.task_id);
      return lease;
    });
  }

  async releaseLease(leaseId: string): Promise<void> {
    this.tx((db) => db.prepare('DELETE FROM leases WHERE lease_id = ?').run(leaseId));
  }

  // -------------------------------------------------------------------------
  // procedures

  private toProcedure(row: Row): ProcedureV2 {
    const definition = json<ProcedureV2>(row.definition_json)!;
    return {
      ...definition,
      status: row.status as ProcedureStatus,
      counters: json(row.counters_json)!,
      updatedAt: String(row.updated_at),
    };
  }

  async listProcedures(key: ProcedureKey): Promise<ProcedureV2[]> {
    return this.read((db) =>
      db
        .prepare('SELECT * FROM procedures WHERE key_string = ? ORDER BY version DESC')
        .all(procedureKeyString(key))
        .map((r) => this.toProcedure(r)),
    );
  }

  async getProcedure(id: string): Promise<ProcedureV2 | undefined> {
    return this.read((db) => {
      const row = db.prepare('SELECT * FROM procedures WHERE id = ?').get(id);
      return row ? this.toProcedure(row) : undefined;
    });
  }

  /**
   * Stores a new version. The structure is checked here; whether an
   * external-submit step may run is the engine's policy decision.
   */
  async insertProcedure(procedure: ProcedureV2): Promise<void> {
    const value = assertValid(validateProcedure(procedure, { submitAllowed: true }), 'procedure');
    this.tx((db) => {
      const keyString = procedureKeyString(value.key);
      const clash = db.prepare('SELECT id FROM procedures WHERE id = ? OR (key_string = ? AND version = ?)').get(value.id, keyString, value.version);
      if (clash) throw new RuntimeError('conflict', `procedure ${value.id} or version ${value.version} of ${keyString} already exists`);
      db.prepare('INSERT INTO procedures (id, key_string, version, status, definition_json, counters_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        value.id, keyString, value.version, value.status, JSON.stringify(value), JSON.stringify(value.counters), value.updatedAt,
      );
    });
  }

  /** Replaces status and counters only; the merged procedure must still satisfy validateProcedure. */
  async updateProcedureState(id: string, state: Pick<ProcedureV2, 'status' | 'counters' | 'updatedAt'>): Promise<ProcedureV2> {
    const c = state?.counters;
    if (!PROCEDURE_STATUSES.includes(state?.status)) throw new RuntimeError('invalid_input', `bad procedure status ${state?.status}`);
    if (!c || ![c.successes, c.failures, c.consecutiveFailures].every((n) => Number.isInteger(n) && n >= 0))
      throw new RuntimeError('invalid_input', 'counters must hold non-negative successes, failures and consecutiveFailures');
    if (!Array.isArray(c.successItemIds) || !c.successItemIds.every((i) => typeof i === 'string' && i !== '') || new Set(c.successItemIds).size !== c.successItemIds.length)
      throw new RuntimeError('invalid_input', 'successItemIds must be distinct non-empty item ids');
    if (c.successItemIds.length > c.successes) throw new RuntimeError('invalid_input', 'the success streak cannot exceed the successes');
    if (!isIso(state.updatedAt)) throw new RuntimeError('invalid_input', 'updatedAt must be an ISO time');
    const counters = { successes: c.successes, failures: c.failures, successItemIds: [...c.successItemIds], consecutiveFailures: c.consecutiveFailures };
    return this.tx((db) => {
      const row = db.prepare('SELECT * FROM procedures WHERE id = ?').get(id);
      if (!row) throw new RuntimeError('not_found', `no procedure ${id}`);
      const merged: ProcedureV2 = { ...this.toProcedure(row), status: state.status, counters, updatedAt: state.updatedAt };
      assertValid(validateProcedure(merged, { submitAllowed: true }), 'procedure state');
      db.prepare('UPDATE procedures SET status = ?, counters_json = ?, updated_at = ? WHERE id = ?').run(state.status, JSON.stringify(counters), state.updatedAt, id);
      return this.toProcedure(db.prepare('SELECT * FROM procedures WHERE id = ?').get(id)!);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function checkTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS)
    throw new RuntimeError('invalid_input', `lease ttlMs must be an integer in 1..${MAX_LEASE_TTL_MS}`);
}

/** Why an artifact record may not be committed for this item; empty when it may. */
function artifactProblems(a: ArtifactRecord, itemId: string, candidateId: string): string[] {
  const problems: string[] = [];
  if (!a || typeof a.id !== 'string' || !a.id) return ['artifact needs an id'];
  if (a.itemId !== itemId) problems.push(`belongs to item ${a.itemId}, not ${itemId}`);
  if (!ARTIFACT_KINDS.includes(a.kind)) problems.push(`bad kind ${a.kind}`);
  if (!COMPLETENESS.includes(a.completeness)) problems.push(`bad completeness ${a.completeness}`);
  if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) problems.push('sha256 must be 64 hex characters');
  if (!Number.isInteger(a.bytes) || a.bytes <= 0) problems.push('bytes must be a positive integer');
  if (!isIso(a.acquiredAt)) problems.push('acquiredAt must be an ISO time');
  if (!problems.length) problems.push(...artifactRecordProblems(a));
  const segments = typeof a.relativePath === 'string' ? a.relativePath.split('/') : [];
  if (segments[0] !== 'candidates' || segments[1] !== candidateId || segments.length < 3 || !segments.slice(2).every(safePathSegment))
    problems.push(`path ${a.relativePath} is not under candidates/${candidateId}/`);
  return problems;
}
