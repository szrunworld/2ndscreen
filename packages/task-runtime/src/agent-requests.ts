// Tasks handed to agents from other processes, and what became of them.
//
// The ledger of record is the task database (tasks.db, table agent_tasks),
// the same file the builtin skills' tasks live in: `2ndscreen task submit`
// records the task there, the worker that hosts the agents takes it, and
// `2ndscreen task outcome` / `task status` read how it stands. That is the
// AgentTaskLedger below; store.ts implements it.
//
// The files under <tasksDir>/agents/requests and agents/outcomes are the
// older form, kept so a request written by an older command line is still
// taken and an outcome an older host wrote can still be read. Files are
// private to the user and written atomically.

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTaskOutcome } from './agent-host.ts';
import { RuntimeError, TERMINAL_TASK_STATUSES, type TaskRecord } from './contracts.ts';

export interface RequestPaths {
  requests: string;
  outcomes: string;
}

export function requestPaths(agentDataDir: string): RequestPaths {
  return { requests: join(agentDataDir, 'requests'), outcomes: join(agentDataDir, 'outcomes') };
}

export interface TaskRequest {
  taskId: string;
  agentId: string;
  taskType: string;
  input: unknown;
  submittedAt: string;
  /** For a task agent's run; default 30 minutes. */
  timeoutMs?: number;
}

export type TaskState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | BuiltinOnlyState;
/** States only a builtin skill's task reaches: agents' tasks never pause or wait for a person in the ledger. */
export type BuiltinOnlyState = 'paused' | 'waiting_user' | 'cancelled';

/** A builtin skill's task (tasks table) in the shape of an agent task's outcome, so one command reads both. */
export function outcomeOfSkillTask(task: TaskRecord, outputPath?: string): TaskOutcomeRecord {
  const state: TaskState =
    task.status === 'cancelling' ? 'running' : task.status;
  const ended = TERMINAL_TASK_STATUSES.includes(task.status);
  return {
    taskId: task.id,
    agentId: task.skillId,
    taskType: task.skillId.includes('.') ? task.skillId.slice(task.skillId.lastIndexOf('.') + 1) : task.skillId,
    origin: 'runtime',
    state,
    submittedAt: task.createdAt,
    ...(ended && { endedAt: task.updatedAt }),
    ...(task.error && { failure: task.error.code, message: task.error.message }),
    ...(task.terminationReason && { terminationReason: task.terminationReason }),
    builtin: { status: task.status, ...(task.phase && { phase: task.phase }), ...(task.waitReason && { waitReason: task.waitReason }), counts: task.counts, ...(outputPath && { outputPath }) },
  };
}

export interface TaskOutcomeRecord {
  taskId: string;
  agentId: string;
  taskType: string;
  origin: 'runtime' | 'agent';
  state: TaskState;
  submittedAt?: string;
  startedAt?: string;
  endedAt?: string;
  failure?: string;
  message?: string;
  terminationReason?: string;
  actions?: { total: number; refused: number; unknown: number };
  items?: AgentTaskOutcome['items'];
  artifacts?: AgentTaskOutcome['artifacts'];
  /** For a builtin skill's task: its own status, phase, wait reason and counts. */
  builtin?: { status: TaskRecord['status']; phase?: TaskRecord['phase']; waitReason?: TaskRecord['waitReason']; counts: TaskRecord['counts']; outputPath?: string };
}

/**
 * Where agent tasks are recorded. Every call is answered from the ledger's
 * state when it is made: a record written by one call is seen by the next.
 */
export interface AgentTaskLedger {
  /** Record a runtime task as queued. Refuses with `conflict` an id already used. */
  submit(request: TaskRequest): Promise<void>;
  /** Queued runtime tasks no host has taken yet, oldest first; each is marked taken. */
  take(): Promise<TaskRequest[]>;
  /** The task's state as it stands now; the input and submit time of an earlier record are kept. */
  record(record: TaskOutcomeRecord): Promise<void>;
  get(taskId: string): Promise<TaskOutcomeRecord | undefined>;
  list(filter?: { states?: TaskState[]; agentId?: string; limit?: number }): Promise<TaskOutcomeRecord[]>;
  /**
   * For a host starting where another one stopped: tasks it was running end
   * as failed (interrupted), since whether their effects happened is only in
   * the effect ledger; runtime tasks it had taken but not started go back to
   * the queue. The agents' session leases of `deadOwners` (pids proven
   * stopped) are given up, so the apps are free at once, not when the leases
   * run out.
   */
  recover(options?: { deadOwners?: readonly number[] }): Promise<{ interrupted: string[]; requeued: string[]; releasedLeases?: number }>;
}

export const INTERRUPTED_MESSAGE = 'the host stopped while the task ran; the effect ledger says which of its actions happened';

/** The older form: request and outcome files under <tasksDir>/agents. */
export function createFileTaskLedger(paths: RequestPaths): AgentTaskLedger {
  return {
    async submit(request) {
      submitTaskRequest(paths, request);
    },
    async take() {
      return takeTaskRequests(paths).requests;
    },
    async record(record) {
      writeOutcome(paths, record);
    },
    async get(taskId) {
      return readOutcome(paths, taskId);
    },
    async list(filter = {}) {
      return listOutcomeFiles(paths)
        .filter((r) => (!filter.states || filter.states.includes(r.state)) && (!filter.agentId || r.agentId === filter.agentId))
        .slice(0, filter.limit ?? Infinity);
    },
    async recover() {
      const interrupted: string[] = [];
      for (const r of listOutcomeFiles(paths))
        if (r.state === 'running' || (r.state === 'queued' && r.origin === 'agent')) {
          writeOutcome(paths, { ...r, state: 'failed', failure: 'interrupted', message: INTERRUPTED_MESSAGE, endedAt: new Date().toISOString() });
          interrupted.push(r.taskId);
        }
      return { interrupted, requeued: [] };
    },
  };
}

function listOutcomeFiles(paths: RequestPaths): TaskOutcomeRecord[] {
  let names: string[];
  try {
    names = readdirSync(paths.outcomes).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: TaskOutcomeRecord[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(paths.outcomes, n), 'utf8')) as TaskOutcomeRecord);
    } catch {
      // being written
    }
  }
  return out.sort((a, b) => (b.submittedAt ?? b.startedAt ?? '').localeCompare(a.submittedAt ?? a.startedAt ?? ''));
}

export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID = TASK_ID;
export const MAX_INPUT_BYTES = 64 * 1024;

/** Refuses a request the ledger may not take: bad ids or an input over 64 KB. */
export function checkTaskRequest(request: Pick<TaskRequest, 'taskId' | 'agentId' | 'input'>): void {
  if (!ID.test(request.taskId) || !ID.test(request.agentId)) throw new RuntimeError('invalid_input', 'task and agent ids are letters, digits, ".", "_", ":" or "-"');
  if (Buffer.byteLength(JSON.stringify(request.input ?? null)) > MAX_INPUT_BYTES) throw new RuntimeError('invalid_input', 'the task input is larger than 64 KB');
}

function writeAtomic(path: string, value: unknown, exclusive = false): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (exclusive) {
    try {
      // Fails if the name is taken, so a task id is never reused.
      closeSync(openSync(path, 'wx', 0o600));
    } catch {
      rmSync(temporary, { force: true });
      throw new RuntimeError('conflict', `a request ${path} already exists`);
    }
  }
  renameSync(temporary, path);
}

function prepare(paths: RequestPaths): void {
  for (const dir of [paths.requests, paths.outcomes]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Queue a task for the host. The id must be new; the input is JSON of at most 64 KB. */
export function submitTaskRequest(paths: RequestPaths, request: TaskRequest): void {
  checkTaskRequest(request);
  prepare(paths);
  if (readOutcome(paths, request.taskId) !== undefined) throw new RuntimeError('conflict', `task ${request.taskId} already exists`);
  writeAtomic(join(paths.requests, `${request.taskId}.json`), request, true);
}

/** Take every waiting request, oldest first; each is removed as it is taken. Unreadable ones are removed and returned as problems. */
export function takeTaskRequests(paths: RequestPaths): { requests: TaskRequest[]; problems: Array<{ file: string; reason: string }> } {
  let names: string[];
  try {
    names = readdirSync(paths.requests).filter((n) => n.endsWith('.json'));
  } catch {
    return { requests: [], problems: [] };
  }
  const requests: TaskRequest[] = [];
  const problems: Array<{ file: string; reason: string }> = [];
  for (const name of names) {
    const path = join(paths.requests, name);
    let raw: Partial<TaskRequest> | undefined;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TaskRequest>;
    } catch {
      // Still being written (the exclusive placeholder is empty): leave it for the next look.
      continue;
    }
    rmSync(path, { force: true });
    if (!raw || typeof raw.taskId !== 'string' || !ID.test(raw.taskId) || typeof raw.agentId !== 'string' || typeof raw.taskType !== 'string' || typeof raw.submittedAt !== 'string')
      problems.push({ file: name, reason: 'not a task request' });
    else requests.push(raw as TaskRequest);
  }
  requests.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return { requests, problems };
}

export function writeOutcome(paths: RequestPaths, record: TaskOutcomeRecord): void {
  prepare(paths);
  writeAtomic(join(paths.outcomes, `${record.taskId}.json`), record);
}

/** The task's outcome; a request not yet taken reads as queued; undefined when the id is unknown. */
export function readOutcome(paths: RequestPaths, taskId: string): TaskOutcomeRecord | undefined {
  if (!ID.test(taskId)) throw new RuntimeError('invalid_input', 'the task id is not valid');
  try {
    return JSON.parse(readFileSync(join(paths.outcomes, `${taskId}.json`), 'utf8')) as TaskOutcomeRecord;
  } catch {
    // not ended or not started
  }
  try {
    const request = JSON.parse(readFileSync(join(paths.requests, `${taskId}.json`), 'utf8')) as TaskRequest;
    return { taskId, agentId: request.agentId, taskType: request.taskType, origin: 'runtime', state: 'queued', submittedAt: request.submittedAt };
  } catch {
    return undefined;
  }
}

/** The record of an ended task, from what the host knows of it. */
export function outcomeRecord(base: Omit<TaskOutcomeRecord, 'state'>, outcome: AgentTaskOutcome, endedAt: string): TaskOutcomeRecord {
  return {
    ...base,
    state: outcome.status,
    endedAt,
    ...(outcome.failure !== undefined && { failure: outcome.failure }),
    ...(outcome.message !== undefined && { message: outcome.message }),
    ...(outcome.terminationReason !== undefined && { terminationReason: outcome.terminationReason }),
    actions: {
      total: outcome.actions.length,
      refused: outcome.actions.filter((a) => a.refusal).length,
      unknown: outcome.actions.filter((a) => a.result?.status === 'unknown').length,
    },
    items: outcome.items,
    artifacts: outcome.artifacts,
  };
}
