// Which agents are running, and which one is stuck (after herdr's agent
// status model). Every agent run has one entry. The state comes from two
// places: what the agent reports (heartbeats, ordered by the protocol's seq,
// so a late report never overwrites a newer one) and what the runtime knows
// better than the agent (an approval or a question waiting for a person,
// the end of the run). A run blocked on a person always says on what.
//
// The board lives in the process that hosts the agents. It can mirror
// itself to a file after every change, so `2ndscreen task agents` in
// another process reads the same list.

import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuntimeError, systemClock, type Clock } from './contracts.ts';
import type { AgentMode, HeartbeatState } from './agent-contracts.ts';

export type AgentRunState = 'starting' | 'working' | 'idle' | 'blocked' | 'paused' | 'done' | 'failed';
export const TERMINAL_RUN_STATES: readonly AgentRunState[] = ['done', 'failed'];

/** What a blocked run waits for: a person's approval, a person's input, or something only the agent knows. */
export interface BlockedOn {
  kind: 'approval' | 'input' | 'agent';
  /** approvalId or questionId, when a person is asked. */
  id?: string;
  message: string;
  since: string;
}

export interface AgentRunEntry {
  runId: string;
  agentId: string;
  mode: AgentMode;
  taskId?: string;
  state: AgentRunState;
  blockedOn?: BlockedOn;
  /** The agent's own latest summary line, if it gave one. */
  summary?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  /** Why a failed run failed. */
  failure?: string;
  /** Seq of the last agent report taken; older reports are ignored. */
  agentSeq: number;
  /** Bumped on every accepted change, for watchers. */
  version: number;
}

export interface StatusSnapshot {
  writtenAt: string;
  runs: AgentRunEntry[];
}

export type StatusListener = (entry: AgentRunEntry) => void;

/** Blocked first, then working, idle, paused, starting; finished runs last; newest change first within a group. */
const ORDER: Record<AgentRunState, number> = { blocked: 0, working: 1, idle: 2, paused: 3, starting: 4, failed: 5, done: 6 };

export function sortRuns(runs: readonly AgentRunEntry[]): AgentRunEntry[] {
  return [...runs].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updatedAt.localeCompare(a.updatedAt));
}

export interface StatusBoard {
  start(run: { runId: string; agentId: string; mode: AgentMode; taskId?: string }): AgentRunEntry;
  /** The agent's own report. Ignored when `seq` is not newer than the last one taken. Returns whether it was taken. */
  reportAgent(runId: string, seq: number, state: HeartbeatState, summary?: string): boolean;
  /** The runtime saw the agent act: a run that was idle or starting is working. */
  activity(runId: string, seq: number): void;
  /** A person is asked; the run is blocked until `unblock` with the same id. */
  block(runId: string, on: Omit<BlockedOn, 'since'>): void;
  unblock(runId: string, id: string): void;
  finish(runId: string, outcome: { ok: boolean; failure?: string }): void;
  get(runId: string): AgentRunEntry | undefined;
  list(options?: { includeFinished?: boolean }): AgentRunEntry[];
  subscribe(listener: StatusListener): () => void;
  /** Resolves with the entry once the run is in one of `states` (at once if it already is); rejects on abort. */
  waitFor(runId: string, states: readonly AgentRunState[], signal?: AbortSignal): Promise<AgentRunEntry>;
  /** Forget finished runs that ended before `before`. */
  prune(before: string): number;
}

export function createStatusBoard(options: { clock?: Clock; persist?: (snapshot: StatusSnapshot) => void } = {}): StatusBoard {
  const clock = options.clock ?? systemClock;
  const runs = new Map<string, AgentRunEntry>();
  /** Pending person requests per run, oldest first; the run shows the oldest. */
  const pending = new Map<string, BlockedOn[]>();
  /** The agent's own last state, to return to once nobody is waiting on a person. */
  const reported = new Map<string, { state: HeartbeatState; summary?: string; message?: string }>();
  const listeners = new Set<StatusListener>();

  const now = () => clock.now().toISOString();
  const snapshot = (): StatusSnapshot => ({ writtenAt: now(), runs: sortRuns([...runs.values()]).map((r) => ({ ...r })) });
  const need = (runId: string): AgentRunEntry => {
    const entry = runs.get(runId);
    if (!entry) throw new RuntimeError('not_found', `no agent run ${runId}`);
    return entry;
  };

  /** Recompute the visible state from what is pending and what the agent last said. */
  const settle = (entry: AgentRunEntry): void => {
    if (TERMINAL_RUN_STATES.includes(entry.state)) return;
    const waiting = pending.get(entry.runId)?.[0];
    const own = reported.get(entry.runId);
    if (waiting) {
      entry.state = 'blocked';
      entry.blockedOn = waiting;
    } else if (own?.state === 'blocked') {
      entry.state = 'blocked';
      entry.blockedOn = { kind: 'agent', message: own.message ?? own.summary ?? 'blocked', since: entry.blockedOn?.kind === 'agent' ? entry.blockedOn.since : now() };
    } else {
      delete entry.blockedOn;
      if (own) entry.state = own.state;
      else if (entry.state === 'blocked') entry.state = 'working';
    }
  };

  const changed = (entry: AgentRunEntry): void => {
    entry.version += 1;
    entry.updatedAt = now();
    try {
      options.persist?.(snapshot());
    } catch {
      // A status file that cannot be written must not stop the agent.
    }
    for (const listener of [...listeners]) {
      try {
        listener({ ...entry });
      } catch {
        // A watcher's failure is the watcher's.
      }
    }
  };

  const board: StatusBoard = {
    start(run) {
      if (runs.has(run.runId)) throw new RuntimeError('conflict', `agent run ${run.runId} already exists`);
      const at = now();
      const entry: AgentRunEntry = { ...run, state: 'starting', startedAt: at, updatedAt: at, agentSeq: 0, version: 0 };
      runs.set(run.runId, entry);
      changed(entry);
      return { ...entry };
    },
    reportAgent(runId, seq, state, summary) {
      const entry = need(runId);
      if (seq <= entry.agentSeq || TERMINAL_RUN_STATES.includes(entry.state)) return false;
      entry.agentSeq = seq;
      reported.set(runId, { state, ...(summary !== undefined && { summary, message: summary }) });
      if (summary !== undefined) entry.summary = summary;
      settle(entry);
      changed(entry);
      return true;
    },
    activity(runId, seq) {
      const entry = need(runId);
      if (seq <= entry.agentSeq || TERMINAL_RUN_STATES.includes(entry.state)) return;
      entry.agentSeq = seq;
      const own = reported.get(runId);
      // Acting is working, whatever the last heartbeat said.
      if (!own || own.state !== 'working') reported.set(runId, { state: 'working', ...(own?.summary !== undefined && { summary: own.summary }) });
      const before = entry.state;
      settle(entry);
      if (entry.state !== before) changed(entry);
    },
    block(runId, on) {
      const entry = need(runId);
      if (TERMINAL_RUN_STATES.includes(entry.state)) return;
      const list = pending.get(runId) ?? [];
      list.push({ ...on, since: now() });
      pending.set(runId, list);
      settle(entry);
      changed(entry);
    },
    unblock(runId, id) {
      const entry = need(runId);
      const list = pending.get(runId) ?? [];
      const rest = list.filter((b) => b.id !== id);
      if (rest.length === list.length) return;
      pending.set(runId, rest);
      settle(entry);
      changed(entry);
    },
    finish(runId, outcome) {
      const entry = need(runId);
      if (TERMINAL_RUN_STATES.includes(entry.state)) return;
      pending.delete(runId);
      delete entry.blockedOn;
      entry.state = outcome.ok ? 'done' : 'failed';
      if (outcome.failure !== undefined) entry.failure = outcome.failure;
      entry.endedAt = now();
      changed(entry);
    },
    get(runId) {
      const entry = runs.get(runId);
      return entry && { ...entry };
    },
    list(opts = {}) {
      const all = [...runs.values()].filter((r) => opts.includeFinished || !TERMINAL_RUN_STATES.includes(r.state));
      return sortRuns(all).map((r) => ({ ...r }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitFor(runId, states, signal) {
      const current = need(runId);
      if (states.includes(current.state)) return Promise.resolve({ ...current });
      return new Promise((resolve, reject) => {
        const done = () => {
          unsubscribe();
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          done();
          reject(new RuntimeError('cancelled', 'stopped waiting'));
        };
        // Pinned to this run id: another run reaching the state does not count.
        const unsubscribe = board.subscribe((entry) => {
          if (entry.runId !== runId) return;
          if (states.includes(entry.state)) {
            done();
            resolve(entry);
          } else if (TERMINAL_RUN_STATES.includes(entry.state)) {
            done();
            reject(new RuntimeError('not_found', `agent run ${runId} ended as ${entry.state} without reaching ${states.join(' or ')}`));
          }
        });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    prune(before) {
      let removed = 0;
      for (const [id, entry] of runs)
        if (entry.endedAt !== undefined && entry.endedAt < before) {
          runs.delete(id);
          pending.delete(id);
          reported.delete(id);
          removed += 1;
        }
      if (removed) {
        try {
          options.persist?.(snapshot());
        } catch {
          // As above.
        }
      }
      return removed;
    },
  };
  return board;
}

// ---------------------------------------------------------------------------
// The status file

/** Writes the snapshot atomically, readable by the user alone. */
export function createFileStatusPersister(path: string): (snapshot: StatusSnapshot) => void {
  return (snapshot) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(snapshot) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  };
}

/** The last snapshot written, or an empty one when there is none. */
export function readStatusFile(path: string): StatusSnapshot {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { writtenAt: new Date(0).toISOString(), runs: [] };
  }
  const parsed = JSON.parse(text) as StatusSnapshot;
  if (!parsed || !Array.isArray(parsed.runs)) throw new RuntimeError('io', `${path} is not a status snapshot`);
  return parsed;
}

// ---------------------------------------------------------------------------
// The list a person reads

const MARK: Record<AgentRunState, string> = { blocked: '!', working: '*', idle: '-', paused: '=', starting: '~', done: 'v', failed: 'x' };

function ago(fromIso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const BLOCKED_LABEL: Record<BlockedOn['kind'], string> = { approval: '等待审批', input: '等待输入', agent: '受阻' };

/**
 * One line per run, the stuck ones first, so nobody hunts for them:
 *   ! blocked  remotedesk.boss-recruiter  t-12  等待审批：向陈一求简历  2m
 */
export function formatAgentList(runs: readonly AgentRunEntry[], now: Date = new Date()): string[] {
  if (runs.length === 0) return ['no agent runs'];
  const rows = sortRuns(runs).map((r) => {
    const detail = r.state === 'blocked' && r.blockedOn ? `${BLOCKED_LABEL[r.blockedOn.kind]}：${r.blockedOn.message}` : r.state === 'failed' ? (r.failure ?? '') : (r.summary ?? '');
    const since = r.state === 'blocked' && r.blockedOn ? r.blockedOn.since : r.updatedAt;
    return [MARK[r.state], r.state, r.agentId, r.taskId ?? '-', detail, ago(since, now)];
  });
  const widths = [1, 2, 3].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map(([mark, state, agent, task, detail, age]) =>
    [mark, state!.padEnd(widths[0]!), agent!.padEnd(widths[1]!), task!.padEnd(widths[2]!), detail, age].filter((w) => w !== '').join('  '),
  );
}
