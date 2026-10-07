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
import { grantsOf, loadAgentPackage, readHostConfig, workHoursFunction, type AgentPackage, type HostConfig } from './agent-config.ts';
import { startResidentAgent, type ResidentAgent, type ResidentAgentOptions } from './agent-host.ts';
import { createInboxApprover, createInboxAsker, inboxPaths } from './agent-inbox.ts';
import { agentDataPaths, appendJsonLine, createFileEffectLedger, createFileUsageLedger, prepareAgentDataDir, type AgentDataPaths } from './agent-ledgers.ts';
import { createProviderService } from './agent-providers.ts';
import { createFileStatusPersister, createStatusBoard, type StatusBoard } from './agent-status.ts';
import { RuntimeError, systemClock, type Clock, type LineProcessSpawner, type Session, type WindowBinding, type WindowProfile } from './contracts.ts';

export interface OpenSessionRequest {
  agentId: string;
  profile: WindowProfile;
  takeOver: boolean;
  /** Whether the session lets external-submit actions through; the host's check chain still decides each one. */
  submitAllowed: boolean;
  foregroundAllowed: boolean;
}

export interface AgentHostDaemonOptions {
  tasksDir: string;
  openSession(request: OpenSessionRequest, signal: AbortSignal): Promise<Session>;
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
  const providers = createProviderService({ providers: config.providers, env: hostEnv, ...(options.fetch && { fetch: options.fetch }) });

  const agents: HostedAgent[] = [];
  const skipped: AgentHostDaemon['skipped'] = [];
  /** Apps the runtime launched, by pid and start time; kept across runs, ended when the host stops. */
  const launched = new Map<string, WindowBinding>();
  const seen = new Set<string>();
  for (const entry of config.agents) {
    if (!entry.enabled) continue;
    let pkg: AgentPackage;
    try {
      pkg = loadAgentPackage(entry.package);
    } catch (error) {
      skipped.push({ package: entry.package, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const { spec } = pkg;
    if (seen.has(spec.id)) {
      skipped.push({ package: entry.package, reason: `${spec.id} is configured twice` });
      continue;
    }
    if (spec.mode !== 'resident') {
      skipped.push({ package: entry.package, reason: `${spec.id} is a task agent; the host keeps resident agents running` });
      continue;
    }
    seen.add(spec.id);
    for (const need of spec.providers)
      if (!config.providers[need.id]) log(`${spec.id}: provider ${need.id} is not configured; its calls will answer provider_unavailable`);

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
      grants: grantsOf(entry, spec.id, configAt),
      ledger,
      ...(entry.ceilings && { ceilings: entry.ceilings }),
      approver,
      asker,
      providers,
      usage,
      status: board,
      ...(entry.workHours && { workHours: workHoursFunction(entry.workHours), timezone: entry.workHours.timezone }),
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
    agents.push({ agentId: spec.id, package: pkg.dir, agent });
    log(`${spec.id} ${spec.version}: hosted from ${pkg.dir}`);
  }
  for (const s of skipped) log(`skipped ${s.package}: ${s.reason}`);

  let stopping: Promise<void> | undefined;
  return {
    paths,
    board,
    agents,
    skipped,
    stop() {
      stopping ??= (async () => {
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
