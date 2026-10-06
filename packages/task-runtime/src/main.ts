// Entry of `2ndscreen task …` (main.mjs once built). It answers one command
// with one JSON line through runCli and exits; after `run` and `resume` it
// makes sure the background worker (worker.ts) is running, so the task goes
// on after this process is gone.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeError, isRuntimeError, type TaskControl } from './contracts.ts';
import { runCli, type AgentViewControl } from './cli.ts';
import { openControlClient, resolveConfig, runtimePaths, type ControlClient } from './bootstrap.ts';
import { agentDataPaths, createFileUsageLedger, formatUsage, readPriceTable, summarizeUsage } from './agent-ledgers.ts';
import { formatAgentList, readStatusFile } from './agent-status.ts';

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
} satisfies TaskControl & Pick<ControlClient['control'], 'bindAccount'> & AgentViewControl;

const code = await runCli(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
}, control);
if (client) await (await client.catch(() => undefined))?.close().catch(() => undefined);
process.exitCode = code;
