// Entry of `2ndscreen task …` (main.mjs once built). It answers one command
// with one JSON line through runCli and exits; after `run`, `resume`,
// `submit` and `host start` it makes sure the background worker (worker.ts)
// is running, so the task goes on after this process is gone. The worker
// also hosts the agents: there is one background process.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeError, isRuntimeError, type TaskControl } from './contracts.ts';
import { runCli, type AgentViewControl } from './cli.ts';
import { openControlClient, resolveConfig, runtimePaths, type ControlClient } from './bootstrap.ts';
import { readFileSync } from 'node:fs';
import { grantInConfig, listGrants, readHostConfig, revokeInConfig, type GrantRequest } from './agent-config.ts';
import { runningHostPid } from './agent-daemon.ts';
import { readHostingState } from './agent-hosting.ts';
import { agentDataPaths, createFileUsageLedger, formatUsage, readPriceTable, summarizeUsage } from './agent-ledgers.ts';
import { formatAgentList, readStatusFile } from './agent-status.ts';
import { decide, formatInbox, inboxPaths, listInbox } from './agent-inbox.ts';
import { readOutcome, requestPaths } from './agent-requests.ts';
import { randomUUID } from 'node:crypto';
import type { ApprovalHint } from './agent-contracts.ts';

const entryDir = dirname(fileURLToPath(import.meta.url));

let client: Promise<ControlClient> | undefined;
/** Opened on the first call, so help and bad words touch no file. */
const open = (): Promise<ControlClient> => (client ??= (async () => openControlClient(resolveConfig(entryDir)))());

/** After a call that leaves work for the worker: start one if none owns the ledger. */
async function withWorker<T>(taskId: string, result: T): Promise<T> {
  try {
    await (await open()).ensureWorker();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(isRuntimeError(error) ? error.code : 'capability_missing',
      `task ${taskId} is recorded, but the background worker could not be started: ${message}`, { taskId });
  }
  return result;
}

function runningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const grantLine = (g: { agentId: string; accountKey: string; application: string; effect: string; mode: string; durable: boolean; expiresAt?: string; active: boolean }) =>
  `${g.active ? '+' : 'x'}  ${g.agentId}  ${g.accountKey}  ${g.application}  ${g.effect}  ${g.mode}  ${g.durable ? '长期' : `至 ${g.expiresAt}`}${g.active ? '' : '（已失效）'}`;

const control = {
  async submit(skillId, input, ...rest: unknown[]) {
    const submit = (await open()).control.submit as (...args: unknown[]) => Promise<{ taskId: string }>;
    const result = await submit(skillId, input, ...rest);
    return withWorker(result.taskId, result);
  },
  async status(taskId) {
    const client = await open();
    try {
      return await client.control.status(taskId);
    } catch (error) {
      // One id space: a task an agent runs answers here too.
      if (!isRuntimeError(error, 'not_found')) throw error;
      const record = await client.agentTasks.get(taskId);
      if (!record) throw error;
      return record as unknown as Awaited<ReturnType<TaskControl['status']>>;
    }
  },
  pause: async (taskId) => (await open()).control.pause(taskId),
  async resume(taskId) {
    return withWorker(taskId, await (await open()).control.resume(taskId));
  },
  cancel: async (taskId) => (await open()).control.cancel(taskId),
  artifacts: async (taskId) => (await open()).control.artifacts(taskId),
  inspectProcedure: async (procedureId) => (await open()).control.inspectProcedure(procedureId),
  bindAccount: async (taskId: string, account: Parameters<ControlClient['control']['bindAccount']>[1]) =>
    (await open()).control.bindAccount(taskId, account),
  // Agent views read what the hosts wrote; they open no ledger and start no worker.
  async agents({ includeFinished }) {
    const snapshot = readStatusFile(agentDataPaths(runtimePaths().tasksDir).status);
    const runs = includeFinished ? snapshot.runs : snapshot.runs.filter((r) => r.state !== 'done' && r.state !== 'failed');
    return { writtenAt: snapshot.writtenAt, runs, lines: formatAgentList(runs) };
  },
  async usage({ by, since }) {
    const paths = agentDataPaths(runtimePaths().tasksDir);
    const from = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ledger = createFileUsageLedger(paths.usage);
    const rows = summarizeUsage(await ledger.list({ since: from }), by, readPriceTable(paths.prices));
    return { by, since: from, rows, skippedLines: ledger.skipped(), lines: formatUsage(rows) };
  },
  async inbox() {
    const entries = listInbox(inboxPaths(agentDataPaths(runtimePaths().tasksDir).dir));
    return { entries, lines: formatInbox(entries) };
  },
  async approve(id) {
    return { decided: decide(inboxPaths(agentDataPaths(runtimePaths().tasksDir).dir), id, { kind: 'approval', decision: 'grant' }).id, decision: 'grant' };
  },
  async deny(id, guidance) {
    const answer = { kind: 'approval' as const, decision: 'deny' as const, guidance: { hints: guidance.hints as ApprovalHint[], ...(guidance.text !== undefined && { text: guidance.text }) } };
    return { decided: decide(inboxPaths(agentDataPaths(runtimePaths().tasksDir).dir), id, answer).id, decision: 'deny' };
  },
  async host(action) {
    const paths = agentDataPaths(runtimePaths().tasksDir);
    const pid = runningHostPid(paths);
    const workerLog = () => resolveConfig(entryDir).paths.workerLog;
    const tail = () => {
      try {
        return readFileSync(workerLog(), 'utf8').trimEnd().split('\n').slice(-5);
      } catch {
        return [];
      }
    };
    const hosting = () => {
      const state = readHostingState(paths);
      return state && runningPid(state.pid) ? state : undefined;
    };
    if (action === 'status') {
      let configured: number | string;
      try {
        configured = readHostConfig(paths.config).agents.filter((a) => a.enabled).length;
      } catch (error) {
        configured = error instanceof Error ? error.message : String(error);
      }
      const snapshot = readStatusFile(paths.status);
      const state = hosting();
      return {
        running: pid !== undefined,
        ...(pid !== undefined && { pid }),
        ...(state && state.state !== 'hosting' && { waiting: state.reason }),
        enabledAgents: configured,
        runs: pid !== undefined ? snapshot.runs : [],
        log: workerLog(),
      };
    }
    if (action === 'stop') {
      if (pid === undefined) return { running: false, stopped: false };
      // The host is the background worker: its skills' tasks become paused, its agents are stopped.
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 300 && runningHostPid(paths) === pid; i++) await new Promise((r) => setTimeout(r, 100));
      if (runningHostPid(paths) === pid) throw new RuntimeError('timeout', `the agent host (pid ${pid}) has not stopped after 30 s`, { pid });
      return { running: false, stopped: true, pid };
    }
    if (pid !== undefined) return { running: true, started: false, pid };
    // A config that would not start is said here, not only in the log.
    readHostConfig(paths.config);
    const since = Date.now();
    await (await open()).ensureWorker();
    for (let i = 0; i < 200; i++) {
      const now = runningHostPid(paths);
      if (now !== undefined) return { running: true, started: true, pid: now, log: workerLog() };
      const state = hosting();
      if (state?.state === 'waiting' && Date.parse(state.at) >= since - 1000)
        return { running: false, started: true, pid: state.pid, waiting: state.reason, log: workerLog() };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new RuntimeError('timeout', 'the worker did not start hosting the agents within 20 s', { log: tail() });
  },
  async submitTask(request) {
    const client = await open();
    const taskId = randomUUID();
    await client.agentTasks.submit({ taskId, ...request, submittedAt: new Date().toISOString() });
    return withWorker(taskId, { taskId, state: 'queued' });
  },
  async outcome(taskId) {
    const record = (await (await open()).agentTasks.get(taskId)) ?? readOutcome(requestPaths(agentDataPaths(runtimePaths().tasksDir).dir), taskId);
    if (!record) throw new RuntimeError('not_found', `no agent task ${taskId}`);
    return record;
  },
  async grants(agentId) {
    const views = listGrants(agentDataPaths(runtimePaths().tasksDir).config, agentId);
    return { grants: views, lines: views.length ? views.map(grantLine) : ['no grants'] };
  },
  async grant(request) {
    const views = grantInConfig(agentDataPaths(runtimePaths().tasksDir).config, request as GrantRequest);
    return { grants: views, lines: views.map(grantLine), applies: 'within seconds if the agent host runs' };
  },
  async revoke(request) {
    const views = revokeInConfig(agentDataPaths(runtimePaths().tasksDir).config, request as { agentId: string; application: string });
    return { grants: views, lines: views.length ? views.map(grantLine) : ['no grants left'], applies: 'within seconds if the agent host runs' };
  },
  async answer(id, text) {
    return { decided: decide(inboxPaths(agentDataPaths(runtimePaths().tasksDir).dir), id, { kind: 'question', answer: text }).id, answer: text };
  },
} satisfies TaskControl & Pick<ControlClient['control'], 'bindAccount'> & AgentViewControl;

const code = await runCli(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
}, control);
if (client) await (await client.catch(() => undefined))?.close().catch(() => undefined);
process.exitCode = code;
