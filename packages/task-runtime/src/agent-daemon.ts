// The agent host: the long-lived process that keeps the enabled resident
// agents running (RFC 0001 P1). It reads <tasksDir>/agents/config.json,
// loads each agent package, and runs every resident agent through its work
// hours with what the runtime provides once for all of them: sessions on
// the agent's apps (opened per run, so no app is held outside the hours),
// the effect ledger, provider calls and their accounting, the status board,
// the inbox for approvals and questions, and an audit log of every
// external-submit decision.
//
// Desktop access comes in through `openSession`, so this module runs in
// tests with fake sessions and in agents-main.ts with 2ndscreen.

import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { grantsOf, loadAgentPackage, readHostConfig, workHoursFunction, type AgentEntryConfig, type AgentPackage, type HostConfig } from './agent-config.ts';
import type { Grant } from './agent-contracts.ts';
import { startResidentAgent, type Ceilings, type ResidentAgent, type ResidentAgentOptions } from './agent-host.ts';
import { createInboxApprover, createInboxAsker, inboxPaths } from './agent-inbox.ts';
import { agentDataPaths, appendJsonLine, createFileEffectLedger, createFileUsageLedger, prepareAgentDataDir, type AgentDataPaths } from './agent-ledgers.ts';
import { createProviderService } from './agent-providers.ts';
import { createFileStatusPersister, createStatusBoard, type StatusBoard } from './agent-status.ts';
import { RuntimeError, systemClock, type Clock, type LineProcessSpawner, type Session, type WindowBinding, type WindowProfile } from './contracts.ts';

export interface AgentSessionRequest {
  agentId: string;
  profile: WindowProfile;
  takeOver: boolean;
  /** Whether the session lets external-submit actions through; the host's check chain still decides each one. */
  submitAllowed: boolean;
  foregroundAllowed: boolean;
}

export interface AgentHostDaemonOptions {
  tasksDir: string;
  openSession(request: AgentSessionRequest, signal: AbortSignal): Promise<Session>;
  /**
   * Ends an app the runtime launched for an agent. Called once the host stops
   * for good, for every such app still running: left on its agent screen, it
   * would be moved onto the user's displays when that screen goes away.
   */
  quitApp?(binding: WindowBinding): Promise<void>;
  spawn: LineProcessSpawner;
  interpreters?: Readonly<Record<string, string>>;
  /** Where agents' passed variables and provider keys are read from; default process.env. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  log?: (line: string) => void;
  inboxPollMs?: number;
  /** How often the config file is checked for changes; default 5 s. */
  configPollMs?: number;
  /** Timing knobs for every resident agent, for tests. */
  resident?: Pick<ResidentAgentOptions, 'heartbeatTimeoutMs' | 'workHoursPollMs' | 'maxRestarts' | 'restartDelaysMs' | 'killGraceMs'>;
  fetch?: typeof fetch;
}

export interface HostedAgent {
  agentId: string;
  package: string;
  agent: ResidentAgent;
}

export interface AgentHostDaemon {
  paths: AgentDataPaths;
  board: StatusBoard;
  agents: HostedAgent[];
  /** Entries not started, with why. */
  skipped: Array<{ package: string; reason: string }>;
  /** Read the config again now, as the watcher does when it changes. */
  reload(): Promise<void>;
  /** Stop every agent politely, then by force; resolves when all are gone. */
  stop(): Promise<void>;
}

export async function startAgentHostDaemon(options: AgentHostDaemonOptions): Promise<AgentHostDaemon> {
  const paths = agentDataPaths(options.tasksDir);
  prepareAgentDataDir(paths);
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => {});
  const hostEnv = options.hostEnv ?? process.env;
  const config: HostConfig = readHostConfig(paths.config);
  const configAt = new Date(statSync(paths.config).mtimeMs).toISOString();

  const persist = createFileStatusPersister(paths.status);
  // Runs an earlier host left in the file are not running now.
  persist({ writtenAt: clock.now().toISOString(), runs: [] });
  const board = createStatusBoard({ clock, persist });
  const ledger = createFileEffectLedger(paths.effects);
  const usage = createFileUsageLedger(paths.usage);
  const inbox = inboxPaths(paths.dir);
  const inboxOptions = { paths: inbox, ...(options.inboxPollMs !== undefined && { pollMs: options.inboxPollMs }), clock, onPending: (e: { kind: string; id: string }) => log(`inbox: ${e.kind} ${e.id} waits for a person`) };
  const approver = createInboxApprover(inboxOptions);
  const asker = createInboxAsker(inboxOptions);
  // Read through on every call, so a reloaded config takes effect without a restart.
  const liveProviders: HostConfig['providers'] = { ...config.providers };
  const providers = createProviderService({ providers: liveProviders, env: hostEnv, ...(options.fetch && { fetch: options.fetch }) });

  const agents: HostedAgent[] = [];
  const skipped: AgentHostDaemon['skipped'] = [];
  /** Apps the runtime launched, by pid and start time; kept across runs, ended when the host stops. */
  const launched = new Map<string, WindowBinding>();
  /** What a running agent reads on every check; replaced in place when the config changes. */
  interface Live {
    entry: AgentEntryConfig;
    grants: Grant[];
    ceilings: Ceilings;
    hours: { inHours: (now: Date) => boolean };
  }
  const live = new Map<string, Live>();
  /** Changing any of these needs a new agent; the rest applies in place. */
  const restartKey = (e: AgentEntryConfig) => JSON.stringify([e.package, e.account.platform, e.account.accountKey, e.takeOver ?? false]);
  const fill = (target: Live, entry: AgentEntryConfig, agentId: string, grantedAt: string) => {
    target.entry = entry;
    target.grants.splice(0, target.grants.length, ...grantsOf(entry, agentId, grantedAt));
    for (const k of Object.keys(target.ceilings) as Array<keyof Ceilings>) delete target.ceilings[k];
    Object.assign(target.ceilings, entry.ceilings ?? {});
    target.hours.inHours = entry.workHours ? workHoursFunction(entry.workHours) : () => true;
  };

  function startOne(entry: AgentEntryConfig, grantedAt: string, taken: Set<string>): HostedAgent | undefined {
    let pkg: AgentPackage;
    try {
      pkg = loadAgentPackage(entry.package);
    } catch (error) {
      skipped.push({ package: entry.package, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
    const { spec } = pkg;
    if (taken.has(spec.id)) {
      skipped.push({ package: entry.package, reason: `${spec.id} is configured twice` });
      return undefined;
    }
    if (spec.mode !== 'resident') {
      skipped.push({ package: entry.package, reason: `${spec.id} is a task agent; the host keeps resident agents running` });
      return undefined;
    }
    taken.add(spec.id);
    for (const need of spec.providers)
      if (!liveProviders[need.id]) log(`${spec.id}: provider ${need.id} is not configured; its calls will answer provider_unavailable`);
    const state: Live = { entry, grants: [], ceilings: {}, hours: { inHours: () => true } };
    fill(state, entry, spec.id, grantedAt);
    live.set(spec.id, state);

    const submitAllowed = spec.effects.includes('external-submit');
    const agent = startResidentAgent({
      packageDir: pkg.dir,
      spec,
      account: entry.account,
      sessionSource: {
        async open(signal) {
          const opened = new Map<string, Session>();
          try {
            for (const app of spec.applications) {
              const session = await options.openSession(
                { agentId: spec.id, profile: pkg.profiles.get(app.bundleId)!, takeOver: entry.takeOver ?? false, submitAllowed, foregroundAllowed: spec.foregroundAllowed },
                signal,
              );
              opened.set(app.bundleId, session);
              const binding = session.binding();
              if (binding.launchedByRuntime) launched.set(`${binding.window.pid}@${binding.window.processStartedAt ?? '?'}`, binding);
            }
            return opened;
          } catch (error) {
            for (const s of opened.values()) await s.close({ keepWindow: true }).catch(() => undefined);
            log(`${spec.id}: could not open its sessions: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        },
        async close(sessions) {
          // The app stays on its screen, signed in, for the next stretch of hours; the lease is given back.
          for (const s of sessions.values()) await s.close({ keepWindow: true }).catch(() => undefined);
        },
      },
      screenId: pkg.profiles.get(spec.applications[0]!.bundleId)!.id,
      // Arrays and objects the reload replaces in place: the check chain reads them on every act.
      grants: state.grants,
      ledger,
      ceilings: state.ceilings,
      approver,
      asker,
      providers,
      usage,
      status: board,
      workHours: (now) => state.hours.inHours(now),
      ...(entry.workHours && { timezone: entry.workHours.timezone }),
      spawn: options.spawn,
      ...(options.interpreters && { interpreters: options.interpreters }),
      hostEnv,
      clock,
      ...options.resident,
      onEvent: (event, context) => {
        if (event.type === 'audit') {
          try {
            appendJsonLine(paths.audit, event.record);
          } catch {
            log(`${spec.id}: could not write the audit log`);
          }
        }
        if (event.type === 'ask_user' && event.answer === undefined) log(`${spec.id}: ${context.taskId ?? '-'} asks: ${event.message}`);
      },
      onTaskStarted: (t) => log(`${spec.id}: task ${t.taskId} (${t.taskType}) started by the ${t.origin}`),
      onTaskEnded: (id, o) => log(`${spec.id}: task ${id} ${o.status}${o.failure ? ` (${o.failure})` : ''}`),
      onRunEnded: (r) =>
        log(`${spec.id}: run ${r.runId} ended: ${r.end}${r.detail ? ` (${r.detail})` : ''}${r.exitCode !== null ? `, exit ${r.exitCode}` : ''}${r.carried ? `, ${r.carried} task(s) carried` : ''}`),
    });
    log(`${spec.id} ${spec.version}: hosted from ${pkg.dir}`);
    return { agentId: spec.id, package: pkg.dir, agent };
  }

  {
    const taken = new Set<string>();
    for (const entry of config.agents) {
      if (!entry.enabled) continue;
      const hosted = startOne(entry, configAt, taken);
      if (hosted) agents.push(hosted);
    }
    for (const s of skipped) log(`skipped ${s.package}: ${s.reason}`);
  }

  async function stopAgent(hosted: HostedAgent): Promise<void> {
    hosted.agent.stop();
    await hosted.agent.done;
    live.delete(hosted.agentId);
    agents.splice(agents.indexOf(hosted), 1);
  }

  /**
   * Apply a changed config. Grants, ceilings, work hours and providers change
   * in place; an agent whose package, account or takeOver changed is
   * restarted, a disabled or removed one stopped, a new one started. A config
   * that does not validate changes nothing.
   */
  async function reload(): Promise<void> {
    let next: HostConfig;
    let at: string;
    try {
      next = readHostConfig(paths.config);
      at = new Date(statSync(paths.config).mtimeMs).toISOString();
    } catch (error) {
      log(`config not reloaded, the running one stays: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const k of Object.keys(liveProviders)) delete liveProviders[k];
    Object.assign(liveProviders, next.providers);
    skipped.splice(0);
    const byPackage = new Map(agents.map((a) => [a.package, a] as const));
    const wanted = new Set<string>();
    const taken = new Set<string>(agents.map((a) => a.agentId));
    for (const entry of next.agents) {
      if (!entry.enabled) continue;
      let dir: string;
      try {
        dir = loadAgentPackage(entry.package).dir;
      } catch (error) {
        skipped.push({ package: entry.package, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const running = byPackage.get(dir);
      if (running) {
        wanted.add(running.agentId);
        const state = live.get(running.agentId)!;
        if (restartKey(state.entry) === restartKey(entry)) {
          fill(state, entry, running.agentId, at);
          continue;
        }
        log(`${running.agentId}: package, account or takeOver changed; restarting it`);
        await stopAgent(running);
        taken.delete(running.agentId);
      }
      const hosted = startOne(entry, at, taken);
      if (hosted) {
        agents.push(hosted);
        wanted.add(hosted.agentId);
      }
    }
    for (const hosted of [...agents])
      if (!wanted.has(hosted.agentId)) {
        log(`${hosted.agentId}: no longer enabled; stopping it`);
        await stopAgent(hosted);
      }
    for (const s of skipped) log(`skipped ${s.package}: ${s.reason}`);
    log(`config reloaded: ${agents.length} agent(s) hosted`);
  }

  // Watch the config by its modification time and size; reloads run one at a time.
  let seenStamp = (() => {
    const st = statSync(paths.config);
    return `${st.mtimeMs}/${st.size}`;
  })();
  let reloading: Promise<void> = Promise.resolve();
  const watcher = setInterval(() => {
    let stamp: string;
    try {
      const st = statSync(paths.config);
      stamp = `${st.mtimeMs}/${st.size}`;
    } catch {
      return;
    }
    if (stamp === seenStamp) return;
    seenStamp = stamp;
    reloading = reloading.then(reload, reload);
  }, options.configPollMs ?? 5000);
  watcher.unref();

  let stopping: Promise<void> | undefined;
  return {
    paths,
    board,
    agents,
    skipped,
    reload: () => (reloading = reloading.then(reload, reload)),
    stop() {
      stopping ??= (async () => {
        clearInterval(watcher);
        await reloading.catch(() => undefined);
        for (const a of agents) a.agent.stop();
        await Promise.all(agents.map((a) => a.agent.done));
        for (const binding of launched.values()) {
          try {
            await options.quitApp?.(binding);
            log(`ended ${binding.window.bundleId} (pid ${binding.window.pid}), launched for its agent`);
          } catch (error) {
            log(`could not end ${binding.window.bundleId} (pid ${binding.window.pid}): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        launched.clear();
      })();
      return stopping;
    },
  };
}

// ---------------------------------------------------------------------------
// One host per tasks directory

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid of a running host, if one holds the pid file. */
export function runningHostPid(paths: AgentDataPaths): number | undefined {
  try {
    const pid = Number(readFileSync(paths.hostPid, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claims the host's pid file for this process. Refuses with `conflict` when
 * another live host holds it; a file left by a dead one is taken over.
 * Returns the release.
 */
export function claimHost(paths: AgentDataPaths, pid: number = process.pid): () => void {
  prepareAgentDataDir(paths);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.hostPid, 'wx', 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return () => {
        try {
          if (Number(readFileSync(paths.hostPid, 'utf8').trim()) === pid) rmSync(paths.hostPid, { force: true });
        } catch {
          // Gone already.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new RuntimeError('io', `cannot write ${paths.hostPid}`);
      const holder = runningHostPid(paths);
      if (holder !== undefined && holder !== pid) throw new RuntimeError('conflict', `an agent host is already running (pid ${holder})`, { pid: holder });
      rmSync(paths.hostPid, { force: true });
    }
  }
  throw new RuntimeError('conflict', 'could not claim the agent host');
}
