// Agents hosted by the worker (RFC 0001, "one background process"). The
// worker that owns the task ledger also keeps the enabled agents running:
// their tasks are in the same tasks.db, their processes are on the worker's
// actor record, and the worker leaves only when neither its skills' tasks
// nor its agents have work.
//
// Hosting starts once the worker owns the ledger and, before any agent is
// started, makes sure nothing a dead worker started can still act: every
// worker that died without closing its record must be proven stopped (its
// recorded process groups gone or stopped, as for a task it held). Until
// then hosting waits and says why. Tasks a dead host was running end as
// interrupted; ones it had taken but not started go back to the queue.
//
// One host per tasks directory still holds: agents/host.pid names the
// hosting worker, so an agent host of an older build keeps its agents and
// this worker hosts none until it is gone.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimHost, endLeftoverApps, startAgentHostDaemon, type AgentHostDaemon, type AgentHostDaemonOptions } from './agent-daemon.ts';
import { agentDataPaths, prepareAgentDataDir, type AgentDataPaths } from './agent-ledgers.ts';
import type { AgentTaskLedger } from './agent-requests.ts';

export interface HostingState {
  pid: number;
  state: 'hosting' | 'waiting' | 'stopped';
  /** Why it is not hosting. */
  reason?: string;
  at: string;
}

export function hostingStatePath(paths: AgentDataPaths): string {
  return join(paths.dir, 'hosting.json');
}

export function readHostingState(paths: AgentDataPaths): HostingState | undefined {
  try {
    return JSON.parse(readFileSync(hostingStatePath(paths), 'utf8')) as HostingState;
  } catch {
    return undefined;
  }
}

export interface AgentHostingOptions extends Omit<AgentHostDaemonOptions, 'tasks'> {
  tasks: AgentTaskLedger;
  /**
   * Whether every worker that died without closing its record is proven
   * stopped. Called before hosting starts; hosting waits while it is not.
   */
  previousStopped(): Promise<{ stopped: true; workers?: number[] } | { stopped: false; reason: string }>;
  /** Replaces startAgentHostDaemon (tests). */
  start?: typeof startAgentHostDaemon;
}

export interface AgentHosting {
  /** The running host, once hosting started. */
  readonly host: AgentHostDaemon | undefined;
  /** Try to start hosting if it has not started; cheap when it has. */
  tick(): Promise<void>;
  /** Agents or agent tasks that need this worker to stay. */
  busy(): Promise<boolean>;
  stop(): Promise<void>;
}

export function createAgentHosting(options: AgentHostingOptions): AgentHosting {
  const paths = agentDataPaths(options.tasksDir);
  const log = options.log ?? (() => {});
  const clock = { now: () => (options.clock ?? { now: () => new Date() }).now() };
  let host: AgentHostDaemon | undefined;
  let release: (() => void) | undefined;
  let lastReason: string | undefined;
  let ticking: Promise<void> | undefined;
  let stopped = false;

  const publish = (state: HostingState['state'], reason?: string) => {
    const value: HostingState = { pid: process.pid, state, ...(reason && { reason }), at: clock.now().toISOString() };
    try {
      prepareAgentDataDir(paths);
      const path = hostingStatePath(paths);
      writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(value) + '\n', { mode: 0o600 });
      renameSync(`${path}.${process.pid}.tmp`, path);
    } catch {
      // The state is a courtesy for `task host status`; hosting goes on without it.
    }
  };
  const wait = (reason: string) => {
    if (reason !== lastReason) log(`agents not hosted yet: ${reason}`);
    lastReason = reason;
    publish('waiting', reason);
  };

  async function attempt(): Promise<void> {
    if (host || stopped) return;
    if (!existsSync(paths.config)) return wait(`no agent config at ${paths.config}`);
    if (!release) {
      try {
        release = claimHost(paths);
      } catch (error) {
        return wait(error instanceof Error ? error.message : String(error));
      }
    }
    const previous = await options.previousStopped();
    if (!previous.stopped) return wait(`a worker that died may still have agents running: ${previous.reason}`);
    if (stopped) return;
    // Apps a dead host launched sit on screens that went with it, or on the user's displays by now.
    if (options.quitApp) await endLeftoverApps(paths, options.quitApp, log);
    const recovered = await options.tasks.recover({ deadOwners: previous.workers ?? [] });
    if (recovered.releasedLeases) log(`gave up ${recovered.releasedLeases} session lease(s) of stopped worker(s) ${previous.workers!.join(', ')}`);
    if (recovered.interrupted.length) log(`agent task(s) a stopped host was running ended as interrupted: ${recovered.interrupted.join(', ')}`);
    if (recovered.requeued.length) log(`agent task(s) back in the queue: ${recovered.requeued.join(', ')}`);
    const { previousStopped: _p, start, ...hostOptions } = options;
    try {
      host = await (start ?? startAgentHostDaemon)(hostOptions);
    } catch (error) {
      return wait(`the agent config does not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    lastReason = undefined;
    publish('hosting');
    log(`hosting agents: ${host.agents.length} resident, ${host.taskAgents().length} on request${host.skipped.length ? `, ${host.skipped.length} skipped` : ''}`);
  }

  return {
    get host() {
      return host;
    },
    tick() {
      return (ticking ??= attempt()
        .catch((error: unknown) => wait(error instanceof Error ? error.message : String(error)))
        .finally(() => (ticking = undefined)));
    },
    async busy() {
      if (!host) return false;
      if (host.agents.length > 0 || host.busy()) return true;
      return (await options.tasks.list({ states: ['queued', 'running'], limit: 1 })).length > 0;
    },
    async stop() {
      stopped = true;
      await ticking?.catch(() => undefined);
      try {
        await host?.stop();
      } finally {
        host = undefined;
        if (release) publish('stopped');
        release?.();
        release = undefined;
      }
    },
  };
}
