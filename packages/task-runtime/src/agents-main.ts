// Entry of the agent host (agents.mjs once built): `2ndscreen task host
// start` runs it detached. It claims <tasksDir>/agents/host.pid, starts
// every enabled resident agent in <tasksDir>/agents/config.json on
// 2ndscreen agent screens, and runs until SIGTERM, SIGINT or SIGHUP, when
// it stops the agents politely and gives their sessions back.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLineProcessSpawner } from './adapters/agent-bridge.ts';
import { createCommandRunner, createSecondScreenAdapter } from './adapters/second-screen.ts';
import { claimHost, startAgentHostDaemon } from './agent-daemon.ts';
import { agentDataPaths } from './agent-ledgers.ts';
import { preparePrivateDirs, resolveConfig } from './bootstrap.ts';
import { createSessionManager } from './session.ts';
import { openTaskStore } from './store.ts';

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} agent host ${process.pid}: ${line}\n`);
const config = resolveConfig(dirname(fileURLToPath(import.meta.url)));
preparePrivateDirs(config.paths);
const paths = agentDataPaths(config.paths.tasksDir);
const release = claimHost(paths);

const screenshotDir = join(config.paths.screenshotsDir, `agents-${process.pid}`);
mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
const store = await openTaskStore({ path: config.paths.dbPath });
const adapter = createSecondScreenAdapter({
  cli: config.cli,
  socket: config.socket,
  ...(config.app ? { app: config.app } : {}),
  run: createCommandRunner(),
  screenshotDir,
});
const managers = new Map<string, ReturnType<typeof createSessionManager>>();
const manager = (submitAllowed: boolean, foregroundAllowed: boolean) => {
  const key = `${submitAllowed}/${foregroundAllowed}`;
  let m = managers.get(key);
  if (!m) managers.set(key, (m = createSessionManager({ adapter, leases: store, policy: { submitAllowed, foregroundAllowed } })));
  return m;
};

// Agents run with this Node unless their package bundles a runtime; python only when the host names one.
const interpreters: Record<string, string> = { node: process.execPath };
if (process.env.SECONDSCREEN_AGENT_PYTHON) interpreters.python = process.env.SECONDSCREEN_AGENT_PYTHON;

let host: Awaited<ReturnType<typeof startAgentHostDaemon>>;
try {
  host = await startAgentHostDaemon({
    tasksDir: config.paths.tasksDir,
    openSession: (r, signal) =>
      manager(r.submitAllowed, r.foregroundAllowed).open({ taskId: `agent:${r.agentId}`, profile: r.profile, takeOver: r.takeOver, leaseTtlMs: 60_000 }, signal),
    quitApp: (binding) => adapter.quitApp!(binding),
    spawn: createLineProcessSpawner({ inheritEnv: false }),
    interpreters,
    log,
  });
} catch (error) {
  log(`cannot start: ${error instanceof Error ? error.message : String(error)}`);
  await store.close().catch(() => undefined);
  release();
  process.exit(1);
}
log(`started; ${host.agents.length} agent(s) hosted, ${host.skipped.length} skipped; tasks ${config.paths.tasksDir}`);

let leaving = false;
async function leave(why: string, code = 0): Promise<void> {
  if (leaving) return;
  leaving = true;
  log(`stopping: ${why}`);
  try {
    await host.stop();
  } catch (error) {
    log(`error while stopping: ${error instanceof Error ? error.message : String(error)}`);
    code ||= 1;
  }
  await store.close().catch(() => undefined);
  release();
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void leave(signal));
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error.stack ?? error.message}`);
  void leave('uncaught error', 1);
});
// Nothing to keep running: say so and leave, so `task host status` does not report an idle host.
if (host.agents.length === 0) void leave('no resident agent is enabled in the config');
// The agents keep the event loop alive; when every one has stopped for good, so does the host.
void Promise.all(host.agents.map((a) => a.agent.done)).then(() => void leave('every agent has stopped'));
