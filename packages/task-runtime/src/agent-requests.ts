// Tasks handed to the agent host from other processes, and what became of
// them. `2ndscreen task submit` writes a request under
// <tasksDir>/agents/requests; the host takes it, runs it on the agent it
// names, and keeps its outcome under agents/outcomes, which `2ndscreen task
// outcome` reads. Outcomes are also written for tasks agents create
// themselves. Files are private to the user and written atomically.

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTaskOutcome } from './agent-host.ts';
import { RuntimeError } from './contracts.ts';

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

export type TaskState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

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
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_INPUT_BYTES = 64 * 1024;

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
  if (!ID.test(request.taskId) || !ID.test(request.agentId)) throw new RuntimeError('invalid_input', 'task and agent ids are letters, digits, ".", "_", ":" or "-"');
  if (Buffer.byteLength(JSON.stringify(request.input ?? null)) > MAX_INPUT_BYTES) throw new RuntimeError('invalid_input', 'the task input is larger than 64 KB');
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
