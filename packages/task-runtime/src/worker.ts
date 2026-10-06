// The background worker (worker.mjs once built): the one process that runs
// tasks and drives the app. `2ndscreen task run|resume` starts it detached
// when no worker owns the ledger, and it keeps going after that command
// exits. It leaves on SIGTERM, SIGINT or SIGHUP (running tasks become
// paused), when another worker owns the ledger, or after a quiet spell with
// nothing to run — and if work arrived while it was leaving, it starts its
// successor first.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_DEFAULTS, ensureDaemon } from './daemon.ts';
import { openTaskStore } from './store.ts';
import { resolveConfig, startWorker, workerCommand } from './bootstrap.ts';

const IDLE_MS = Number(process.env.SECONDSCREEN_WORKER_IDLE_MS) > 0 ? Number(process.env.SECONDSCREEN_WORKER_IDLE_MS) : 10 * 60_000;
/**
 * A worker that cannot own the ledger this long is a duplicate. Longer than
 * the daemon lease, so a standby started after a crash outlasts the dead
 * owner's lease and takes over.
 */
const STANDBY_MS = 2 * DAEMON_DEFAULTS.leaseTtlMs + 5_000;
const CHECK_MS = Math.min(5_000, IDLE_MS);

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} worker ${process.pid}: ${line}\n`);
const config = resolveConfig(dirname(fileURLToPath(import.meta.url)));
const worker = await startWorker(config);
log(`started; ledger ${config.paths.dbPath}`);
if (worker.registry.current.pgid !== process.pid)
  log(`not leading its own process group (${worker.registry.current.pgid}): if it dies mid-task, that task stays blocked until resolved by hand`);

let leaving = false;
async function leave(why: string, code = 0): Promise<void> {
  if (leaving) return;
  leaving = true;
  clearInterval(timer);
  log(`stopping: ${why}`);
  try {
    await worker.close();
    // Work that arrived after the last look was not seen by any CLI as unowned: hand it on.
    const store = await openTaskStore({ path: config.paths.dbPath });
    try {
      const waiting = await store.listTasks({ status: ['queued', 'running', 'cancelling'] });
      if (waiting.length > 0 && why !== 'signal') {
        const next = await ensureDaemon(store, workerCommand(config));
        log(`handed ${waiting.length} task(s) on${next.started ? ` to worker ${next.pid}` : ''}`);
      }
    } finally {
      await store.close();
    }
  } catch (error) {
    log(`error while stopping: ${error instanceof Error ? error.message : String(error)}`);
    code = code || 1;
  }
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void leave('signal'));
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error.stack ?? error.message}`);
  void leave('uncaught error', 1);
});
process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});

const startedAt = Date.now();
let lastBusy = Date.now();
let lastOwner = Date.now();
const timer = setInterval(() => {
  void (async () => {
    if (leaving) return;
    const now = Date.now();
    if (worker.daemon.isOwner()) lastOwner = now;
    else if (now - Math.max(lastOwner, startedAt) > STANDBY_MS) return leave('another worker owns the ledger');
    const busy = await worker.store.listTasks({ status: ['queued', 'running', 'cancelling'] }).catch(() => [{}]);
    if (busy.length > 0) lastBusy = now;
    else if (now - lastBusy > IDLE_MS) return leave('idle');
  })();
}, CHECK_MS);
