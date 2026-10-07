// Entry of `2ndscreen task …` (main.mjs once built). It answers one command
// with one JSON line through runCli and exits; after `run` and `resume` it
// makes sure the background worker (worker.ts) is running, so the task goes
// on after this process is gone.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeError, isRuntimeError, type TaskControl } from './contracts.ts';
import { runCli, type AgentViewControl } from './cli.ts';
import { agentHostCommand, openControlClient, resolveConfig, runtimePaths, type ControlClient } from './bootstrap.ts';
import { readFileSync } from 'node:fs';
import { readHostConfig } from './agent-config.ts';
import { runningHostPid } from './agent-daemon.ts';
import { spawnDetachedWorker } from './daemon.ts';
import { agentDataPaths, createFileUsageLedger, formatUsage, readPriceTable, summarizeUsage } from './agent-ledgers.ts';
import { formatAgentList, readStatusFile } from './agent-status.ts';
import { decide, formatInbox, inboxPaths, listInbox } from './agent-inbox.ts';
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

const control = {
  async submit(skillId, input, ...rest: unknown[]) {
    const submit = (await open()).control.submit as (...args: unknown[]) => Promise<{ taskId: string }>;
    const result = await submit(skillId, input, ...rest);
    return withWorker(result.taskId, result);
  },
  status: async (taskId) => (await open()).control.status(taskId),
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
    const tail = () => {
      try {
        return readFileSync(paths.hostLog, 'utf8').trimEnd().split('\n').slice(-5);
      } catch {
        return [];
      }
    };
    if (action === 'status') {
      let configured: number | string;
      try {
        configured = readHostConfig(paths.config).agents.filter((a) => a.enabled).length;
      } catch (error) {
        configured = error instanceof Error ? error.message : String(error);
      }
      const snapshot = readStatusFile(paths.status);
      return { running: pid !== undefined, ...(pid !== undefined && { pid }), enabledAgents: configured, runs: pid !== undefined ? snapshot.runs : [], log: paths.hostLog };
    }
    if (action === 'stop') {
      if (pid === undefined) return { running: false, stopped: false };
      process.kill(pid, 'SIGTERM');
      // The agents are asked to stop and then made to; give that its time.
      for (let i = 0; i < 300 && runningHostPid(paths) === pid; i++) await new Promise((r) => setTimeout(r, 100));
      if (runningHostPid(paths) === pid) throw new RuntimeError('timeout', `the agent host (pid ${pid}) has not stopped after 30 s`, { pid });
      return { running: false, stopped: true, pid };
    }
    if (pid !== undefined) return { running: true, started: false, pid };
    // A config that would not start is said here, not only in the log.
    readHostConfig(paths.config);
    const command = agentHostCommand(resolveConfig(entryDir));
    const child = await spawnDetachedWorker({ ...command, logPath: paths.hostLog });
    for (let i = 0; i < 100; i++) {
      const now = runningHostPid(paths);
      if (now === child) return { running: true, started: true, pid: child, log: paths.hostLog };
      if (now === undefined) {
        try {
          process.kill(child, 0);
        } catch {
          throw new RuntimeError('io', 'the agent host exited at once', { log: tail() });
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new RuntimeError('timeout', 'the agent host did not take over within 10 s', { pid: child, log: tail() });
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
