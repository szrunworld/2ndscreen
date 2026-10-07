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

import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { grantsOf, loadAgentPackage, readHostConfig, workHoursFunction, type AgentEntryConfig, type AgentPackage, type HostConfig } from './agent-config.ts';
import type { Grant } from './agent-contracts.ts';
import { runAgentTask, startResidentAgent, type AgentTaskOutcome, type Ceilings, type ResidentAgent, type ResidentAgentOptions } from './agent-host.ts';
import { createFileTaskLedger, outcomeRecord, requestPaths, takeTaskRequests, type AgentTaskLedger, type TaskOutcomeRecord, type TaskRequest } from './agent-requests.ts';
import { createInboxApprover, createInboxAsker, inboxPaths } from './agent-inbox.ts';
import { agentDataPaths, appendJsonLine, createFileEffectLedger, createFileUsageLedger, prepareAgentDataDir, type AgentDataPaths } from './agent-ledgers.ts';
import { createProviderService } from './agent-providers.ts';
import type { UnitService } from './agent-units.ts';
import { createFileStatusPersister, createStatusBoard, type StatusBoard } from './agent-status.ts';
import { DEFAULT_BUDGET, RuntimeError, systemClock, type Clock, type LineProcessSpawner, type Session, type WindowBinding, type WindowProfile } from './contracts.ts';

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
  /** How often submitted tasks are looked for; default 1 s. */
  requestPollMs?: number;
  /** Timing knobs for every resident agent, for tests. */
  resident?: Pick<ResidentAgentOptions, 'heartbeatTimeoutMs' | 'workHoursPollMs' | 'maxRestarts' | 'restartDelaysMs' | 'killGraceMs'>;
  fetch?: typeof fetch;
  /** The run_unit service (agent-units.ts); without it agents' run_unit answers not_offered. */
  units?: UnitService;
  /**
   * Where tasks are taken from and their outcomes kept: the task database in
   * the worker. Default: the request and outcome files under agents/. Either
   * way, request files an older command line wrote are taken too.
   */
  tasks?: AgentTaskLedger;
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
  /** Task agents the host runs on request, by agent id. */
  taskAgents(): string[];
  /** Take submitted tasks now, as the poller does every requestPollMs. */
  takeRequests(): Promise<void>;
  /** Tasks under way or waiting in this host: on request, queued for a task agent, or given to a resident one. */
  busy(): boolean;
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
  /**
   * Apps the runtime launched, by pid and start time; kept across runs, ended
   * when the host stops. Also on file, so a host that starts after this one
   * died ends them (endLeftoverApps).
   */
  const launched = new Map<string, WindowBinding>();
  const keepLaunched = (binding: WindowBinding) => {
    launched.set(`${binding.window.pid}@${binding.window.processStartedAt ?? '?'}`, binding);
    writeLaunched(paths, [...launched.values()]);
  };
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

  const requests = requestPaths(paths.dir);
  const tasks = options.tasks ?? createFileTaskLedger(requests);
  /** When each runtime task was submitted, for its outcome record. */
  const submitted = new Map<string, string>();
  /** Records are written in the order they are made. */
  let recording: Promise<void> = Promise.resolve();
  const record = (r: TaskOutcomeRecord) => {
    recording = recording.then(
      () => tasks.record(r),
    ).catch((error: unknown) => log(`could not record the state of ${r.taskId}: ${error instanceof Error ? error.message : String(error)}`));
  };
  const ended = (agentId: string, taskId: string, taskType: string, origin: 'runtime' | 'agent', outcome: AgentTaskOutcome, startedAt?: string) =>
    record(
      outcomeRecord(
        { taskId, agentId, taskType, origin, ...(submitted.has(taskId) && { submittedAt: submitted.get(taskId)! }), ...(startedAt && { startedAt }) },
        outcome,
        clock.now().toISOString(),
      ),
    );
  const types = new Map<string, { taskType: string; origin: 'runtime' | 'agent'; startedAt: string }>();
  /** Task agents: run one task at a time each, on request. */
  interface TaskAgent {
    pkg: AgentPackage;
    state: Live;
    queue: TaskRequest[];
    running?: Promise<void>;
  }
  const taskAgents = new Map<string, TaskAgent>();
  const stopping_ = new AbortController();

  function registerTaskAgent(pkg: AgentPackage, entry: AgentEntryConfig, grantedAt: string): void {
    const state: Live = { entry, grants: [], ceilings: {}, hours: { inHours: () => true } };
    fill(state, entry, pkg.spec.id, grantedAt);
    const existing = taskAgents.get(pkg.spec.id);
    if (existing) {
      existing.pkg = pkg;
      existing.state = state;
    } else taskAgents.set(pkg.spec.id, { pkg, state, queue: [] });
    log(`${pkg.spec.id} ${pkg.spec.version}: runs tasks on request, from ${pkg.dir}`);
  }

  const unitsFor = (pkg: AgentPackage) =>
    options.units
      ? { units: { service: options.units, profiles: new Map([...pkg.profiles].map(([bundleId, p]) => [bundleId, { id: p.id, ...(p.appVersion !== undefined && { appVersion: p.appVersion }) }] as const)) } }
      : {};

  async function openFor(pkg: AgentPackage, entry: AgentEntryConfig, signal: AbortSignal): Promise<Map<string, Session>> {
    const { spec } = pkg;
    const opened = new Map<string, Session>();
    try {
      for (const app of spec.applications) {
        const session = await options.openSession(
          { agentId: spec.id, profile: pkg.profiles.get(app.bundleId)!, takeOver: entry.takeOver ?? false, submitAllowed: spec.effects.includes('external-submit'), foregroundAllowed: spec.foregroundAllowed },
          signal,
        );
        opened.set(app.bundleId, session);
        const binding = session.binding();
        if (binding.launchedByRuntime) keepLaunched(binding);
      }
      return opened;
    } catch (error) {
      for (const s of opened.values()) await s.close({ keepWindow: true }).catch(() => undefined);
      throw error;
    }
  }

  function pump(agentId: string): void {
    const ta = taskAgents.get(agentId);
    if (!ta || ta.running || ta.queue.length === 0 || stopping_.signal.aborted) return;
    const request = ta.queue.shift()!;
    ta.running = (async () => {
      const { pkg, state } = ta;
      const startedAt = clock.now().toISOString();
      const base = { taskId: request.taskId, agentId, taskType: request.taskType, origin: 'runtime' as const, submittedAt: request.submittedAt, startedAt };
      record({ ...base, state: 'running' });
      log(`${agentId}: task ${request.taskId} (${request.taskType}) started on request`);
      let sessions: Map<string, Session> | undefined;
      try {
        sessions = await openFor(pkg, state.entry, stopping_.signal);
        const outcome = await runAgentTask({
          packageDir: pkg.dir,
          spec: pkg.spec,
          task: { taskId: request.taskId, taskType: request.taskType, input: request.input, budget: DEFAULT_BUDGET },
          account: state.entry.account,
          sessions,
          screenId: pkg.profiles.get(pkg.spec.applications[0]!.bundleId)!.id,
          grants: state.grants,
          ledger,
          ceilings: state.ceilings,
          approver,
          asker,
          providers,
          ...unitsFor(pkg),
          usage,
          status: board,
          workHours: (now) => state.hours.inHours(now),
          spawn: options.spawn,
          ...(options.interpreters && { interpreters: options.interpreters }),
          hostEnv,
          clock,
          ...(options.resident?.killGraceMs !== undefined && { killGraceMs: options.resident.killGraceMs }),
          timeoutMs: request.timeoutMs ?? 30 * 60_000,
          signal: stopping_.signal,
          onEvent: (event) => {
            if (event.type === 'audit') {
              try {
                appendJsonLine(paths.audit, event.record);
              } catch {
                log(`${agentId}: could not write the audit log`);
              }
            }
          },
        });
        record(outcomeRecord(base, outcome, clock.now().toISOString()));
        log(`${agentId}: task ${request.taskId} ${outcome.status}${outcome.failure ? ` (${outcome.failure}${outcome.message ? `: ${outcome.message}` : ''})` : ''}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record({ ...base, state: 'failed', failure: isRuntimeErrorLike(error) ?? 'error', message, endedAt: clock.now().toISOString() });
        log(`${agentId}: task ${request.taskId} failed: ${message}`);
      } finally {
        if (sessions) for (const s of sessions.values()) await s.close({ keepWindow: true }).catch(() => undefined);
        ta.running = undefined;
        pump(agentId);
      }
    })();
  }

  let taking: Promise<void> | undefined;
  function take(): Promise<void> {
    return (taking ??= takeNow().finally(() => (taking = undefined)));
  }
  async function takeNow(): Promise<void> {
    if (stopping_.signal.aborted) return;
    const taken: TaskRequest[] = [];
    // Request files: the form an older command line writes, and the whole queue without a database.
    const files = takeTaskRequests(requests);
    for (const p of files.problems) log(`request ${p.file} dropped: ${p.reason}`);
    if (options.tasks) {
      for (const r of files.requests)
        await tasks.submit(r).catch((error: unknown) => log(`request ${r.taskId} dropped: ${error instanceof Error ? error.message : String(error)}`));
      try {
        taken.push(...(await tasks.take()));
      } catch (error) {
        log(`could not take submitted tasks: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else taken.push(...files.requests);
    for (const request of taken) {
      submitted.set(request.taskId, request.submittedAt);
      const fail = (failure: string, message: string) => {
        record({ taskId: request.taskId, agentId: request.agentId, taskType: request.taskType, origin: 'runtime', state: 'failed', submittedAt: request.submittedAt, endedAt: clock.now().toISOString(), failure, message });
        log(`task ${request.taskId} for ${request.agentId} refused: ${message}`);
      };
      const resident = agents.find((a) => a.agentId === request.agentId);
      if (resident) {
        try {
          // Queued first: a running agent starts the task inside submit, and its 'running' must not be overwritten.
          record({ taskId: request.taskId, agentId: request.agentId, taskType: request.taskType, origin: 'runtime', state: 'queued', submittedAt: request.submittedAt });
          resident.agent.submit({ taskId: request.taskId, taskType: request.taskType, input: request.input });
        } catch (error) {
          fail(isRuntimeErrorLike(error) ?? 'error', error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      const ta = taskAgents.get(request.agentId);
      if (!ta) {
        fail('not_found', `no enabled agent ${request.agentId} in the host config`);
        continue;
      }
      if (!(request.taskType in ta.pkg.spec.tasks)) {
        fail('invalid_input', `${request.agentId} takes no task type ${request.taskType}`);
        continue;
      }
      ta.queue.push(request);
      record({ taskId: request.taskId, agentId: request.agentId, taskType: request.taskType, origin: 'runtime', state: 'queued', submittedAt: request.submittedAt });
      pump(request.agentId);
    }
  }

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
    taken.add(spec.id);
    if (spec.mode !== 'resident') {
      registerTaskAgent(pkg, entry, grantedAt);
      return undefined;
    }
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
              if (binding.launchedByRuntime) keepLaunched(binding);
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
      ...unitsFor(pkg),
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
      onTaskStarted: (t) => {
        const startedAt = clock.now().toISOString();
        types.set(t.taskId, { taskType: t.taskType, origin: t.origin, startedAt });
        record({ taskId: t.taskId, agentId: spec.id, taskType: t.taskType, origin: t.origin, state: 'running', startedAt, ...(submitted.has(t.taskId) && { submittedAt: submitted.get(t.taskId)! }) });
        log(`${spec.id}: task ${t.taskId} (${t.taskType}) started by the ${t.origin}`);
      },
      onTaskEnded: (id, o) => {
        const t = types.get(id);
        ended(spec.id, id, t?.taskType ?? '?', t?.origin ?? 'runtime', o, t?.startedAt);
        types.delete(id);
        log(`${spec.id}: task ${id} ${o.status}${o.failure ? ` (${o.failure})` : ''}`);
      },
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
      const asTaskAgent = [...taskAgents.values()].find((t) => t.pkg.dir === dir);
      if (asTaskAgent) {
        wanted.add(asTaskAgent.pkg.spec.id);
        let pkg: AgentPackage;
        try {
          pkg = loadAgentPackage(entry.package);
        } catch {
          continue;
        }
        if (pkg.spec.mode !== 'resident') {
          // The next task runs with the new grants, package and binding; one under way finishes as it began.
          registerTaskAgent(pkg, entry, at);
          continue;
        }
        taskAgents.delete(asTaskAgent.pkg.spec.id);
        taken.delete(asTaskAgent.pkg.spec.id);
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
      // A task agent is registered, not started: keep it too.
      for (const [id, ta] of taskAgents) if (ta.pkg.dir === dir) wanted.add(id);
    }
    for (const hosted of [...agents])
      if (!wanted.has(hosted.agentId)) {
        log(`${hosted.agentId}: no longer enabled; stopping it`);
        await stopAgent(hosted);
      }
    for (const [id, ta] of [...taskAgents])
      if (!wanted.has(id)) {
        log(`${id}: no longer enabled; its queued tasks are dropped`);
        for (const r of ta.queue.splice(0))
          record({ taskId: r.taskId, agentId: id, taskType: r.taskType, origin: 'runtime', state: 'failed', submittedAt: r.submittedAt, endedAt: clock.now().toISOString(), failure: 'cancelled', message: 'the agent was disabled' });
        taskAgents.delete(id);
      }
    for (const s of skipped) log(`skipped ${s.package}: ${s.reason}`);
    log(`config reloaded: ${agents.length} agent(s) hosted, ${taskAgents.size} on request`);
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

  const poller = setInterval(() => void take(), options.requestPollMs ?? 1000);
  poller.unref();

  let stopping: Promise<void> | undefined;
  return {
    taskAgents: () => [...taskAgents.keys()],
    takeRequests: take,
    busy: () => taking !== undefined || [...taskAgents.values()].some((t) => t.running || t.queue.length > 0) || types.size > 0,
    paths,
    board,
    agents,
    skipped,
    reload: () => (reloading = reloading.then(reload, reload)),
    stop() {
      stopping ??= (async () => {
        clearInterval(watcher);
        clearInterval(poller);
        await reloading.catch(() => undefined);
        await taking?.catch(() => undefined);
        // Task agents: the one under way is cancelled. Queued ones stay queued in a ledger for the
        // next host (its recover() puts them back); without one they end here.
        stopping_.abort();
        for (const [id, ta] of taskAgents)
          for (const r of ta.queue.splice(0))
            if (!options.tasks) record({ taskId: r.taskId, agentId: id, taskType: r.taskType, origin: 'runtime', state: 'failed', submittedAt: r.submittedAt, endedAt: clock.now().toISOString(), failure: 'cancelled', message: 'the agent host stopped' });
        await Promise.all([...taskAgents.values()].map((t) => t.running).filter(Boolean));
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
        writeLaunched(paths, []);
        await recording;
      })();
      return stopping;
    },
  };
}

// ---------------------------------------------------------------------------
// Apps a host launched, on file

const launchedPath = (paths: AgentDataPaths) => join(paths.dir, 'launched.json');

function writeLaunched(paths: AgentDataPaths, bindings: WindowBinding[]): void {
  try {
    const path = launchedPath(paths);
    writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify({ hostPid: process.pid, bindings }) + '\n', { mode: 0o600 });
    renameSync(`${path}.${process.pid}.tmp`, path);
  } catch {
    // Only a host that dies loses this; the apps then stay until someone quits them.
  }
}

/**
 * Ends the apps a host that is gone launched and left running. Call it only
 * holding the host pid file, so the host that wrote the list cannot be
 * alive. quitApp makes sure each pid is still that app process.
 */
export async function endLeftoverApps(paths: AgentDataPaths, quitApp: (binding: WindowBinding) => Promise<void>, log: (line: string) => void = () => {}): Promise<number> {
  let left: { hostPid?: number; bindings?: WindowBinding[] };
  try {
    left = JSON.parse(readFileSync(launchedPath(paths), 'utf8')) as typeof left;
  } catch {
    return 0;
  }
  let ended = 0;
  for (const binding of left.bindings ?? []) {
    try {
      await quitApp(binding);
      ended += 1;
      log(`ended ${binding.window.bundleId} (pid ${binding.window.pid}), left by agent host ${left.hostPid ?? '?'}`);
    } catch (error) {
      log(`could not end ${binding.window.bundleId} (pid ${binding.window.pid}) left by agent host ${left.hostPid ?? '?'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  rmSync(launchedPath(paths), { force: true });
  return ended;
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

/** The code of a runtime error, whichever copy of contracts threw it. */
function isRuntimeErrorLike(error: unknown): string | undefined {
  return error instanceof RuntimeError ? error.code : undefined;
}
