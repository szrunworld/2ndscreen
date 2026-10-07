// The runtime side of agent-jsonl/1 for one task of a process agent
// (RFC 0001 §5, phase P1). The host starts the agent's process with an
// environment it builds itself (no inherited keys, no 2ndscreen socket),
// tells it about the run and the task, and then answers its requests: it
// observes, acts and waits through the runtime's own sessions, calls
// providers on the agent's behalf, and passes every action through the
// pre-action check chain before anything reaches an app. The agent only
// ever proposes.
//
// Scope of this first version: `mode: task` only (resident scheduling comes
// next); grants and approvals govern external-submit, as in RFC §7; work
// hours are checked on acts. `runAgentTask` resolves only after the agent
// process is confirmed gone, so whoever holds the sessions gets the windows
// back from a process that can no longer ask for anything.

import { isAbsolute, resolve, sep } from 'node:path';
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  type AgentAccount,
  type AgentMode,
  type ScheduleInfo,
  stricterApproval,
  parseAgentMessage,
  type ActionRefusal,
  type AgentMessage,
  type AgentSpec,
  type ApprovalHint,
  type ApprovalMode,
  type EffectLimit,
  type Grant,
  type ProviderPurpose,
  type RuntimeMessage,
  type UnitRefusalReason,
} from './agent-contracts.ts';
import type { StatusBoard } from './agent-status.ts';
import { unitProblems, type UnitRunResult, type UnitService } from './agent-units.ts';
import type { ProviderUsageLedger } from './agent-ledgers.ts';
import {
  DEFAULT_BUDGET,
  RuntimeError,
  encodeJsonLine,
  isRuntimeError,
  systemClock,
  type Action,
  type ActionResult,
  type ActionStatus,
  type ArtifactCompleteness,
  type ArtifactKind,
  type Budget,
  type Clock,
  type EffectClass,
  type LineProcess,
  type LineProcessSpawner,
  type Observation,
  type ObserveOptions,
  type Session,
  type TerminationReason,
  type Usage,
  type WaitReason,
  type WorkItemStatus,
} from './contracts.ts';

/** Ceilings no organization, user or agent can loosen (RFC §7; BOSS 安全验证 incident, 2026-10-06). */
export const HARD_LIMITS: Readonly<Partial<Record<EffectClass, Required<EffectLimit>>>> = {
  'external-submit': { perDay: 20, minIntervalMs: 45_000 },
};

/** "Per day" is a rolling 24 hours, so a restart or a timezone change cannot reset it. */
export const LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_KILL_GRACE_MS = 3000;
/** How long an agent may take to exit after its last task message before it is stopped. */
const EXIT_AFTER_FINISH_MS = 5000;
/** Variables an agent process gets from the host's own environment; nothing else is passed through. */
const PASSED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'TZ'] as const;

// ---------------------------------------------------------------------------
// Injected services

/** One use of a limited effect, kept across runs and agents. */
export interface EffectUse {
  agentId: string;
  taskId: string;
  application: string;
  accountKey: string;
  effect: EffectClass;
  at: string;
  target?: string;
  status: ActionStatus | 'not_sent';
}

/**
 * Where effect uses are counted. Limits apply per application and account
 * across every agent, so two agents cannot share one account's quota twice.
 */
export interface EffectLedger {
  uses(query: { application: string; accountKey: string; effect: EffectClass; since: string }): Promise<EffectUse[]>;
  record(use: EffectUse): Promise<void>;
}

export function createMemoryEffectLedger(seed: EffectUse[] = []): EffectLedger & { readonly all: EffectUse[] } {
  const all = [...seed];
  return {
    all,
    async uses(q) {
      return all.filter((u) => u.application === q.application && u.accountKey === q.accountKey && u.effect === q.effect && u.at >= q.since);
    },
    async record(use) {
      all.push(use);
    },
  };
}

/** What the runtime tells a person before they approve, computed rather than taken from the agent. */
export interface ApprovalConsequences {
  application: string;
  accountKey: string;
  usedInWindow: number;
  remainingInWindow?: number;
  msSinceLast?: number;
  targetHadUnknownResult: boolean;
  inWorkHours: boolean;
}

export interface ApprovalRequest {
  agentId: string;
  taskId: string;
  approvalId: string;
  effect: EffectClass;
  /** The agent's words; shown after the consequences, never instead of them. */
  summary: string;
  target?: string;
  action?: Action;
  consequences: ApprovalConsequences;
}

export type ApprovalDecision = { decision: 'grant' } | { decision: 'deny'; guidance?: { text?: string; hints: ApprovalHint[] } };

export interface Approver {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface ProviderService {
  /** Throw RuntimeError('model_unavailable') when the provider cannot be reached. */
  call(request: { agentId: string; taskId?: string; providerId: string; purpose: ProviderPurpose; input: unknown }, signal: AbortSignal): Promise<{
    output: unknown;
    usage?: { inputTokens: number | 'unknown'; outputTokens: number | 'unknown' };
    /** The model that answered, for cost attribution. */
    model?: string;
  }>;
}

/** A question an agent put to a person (ask_user with a questionId). */
export interface UserQuestion {
  agentId: string;
  taskId: string;
  questionId: string;
  reason: WaitReason;
  message: string;
  choices?: string[];
}

/** Gets a person's answer; rejects when the signal fires. An answer outside `choices` is asked again. */
export interface Asker {
  ask(question: UserQuestion, signal: AbortSignal): Promise<string>;
}

export interface AuditRecord {
  at: string;
  agentId: string;
  taskId: string;
  requestId: string;
  application: string;
  accountKey: string;
  effect: EffectClass;
  target?: string;
  decision: 'allowed' | 'refused';
  reason?: ActionRefusal['reason'];
  result?: ActionStatus;
}

export type HostEvent =
  | { type: 'item'; itemId: string; status: WorkItemStatus; data?: Record<string, unknown> }
  | { type: 'artifact'; path: string; kind: ArtifactKind; completeness: ArtifactCompleteness; sha256?: string }
  | { type: 'ask_user'; reason: string; message: string; questionId?: string; answer?: string }
  | { type: 'unit'; unit: string; unitAttemptId: string; phase: 'started' | 'finished'; ok?: boolean }
  | { type: 'heartbeat'; state: string; summary?: string }
  | { type: 'audit'; record: AuditRecord }
  | { type: 'approval'; request: ApprovalRequest; decision: ApprovalDecision };

export interface Ceilings {
  org?: Partial<Record<EffectClass, EffectLimit>>;
  user?: Partial<Record<EffectClass, EffectLimit>>;
  /** The loosest approval mode the organization or user allows, per effect. */
  approvalFloor?: Partial<Record<EffectClass, ApprovalMode>>;
}

/** What every hosted agent process gets, whatever its mode. */
export interface AgentHostOptions {
  /** Absolute directory of the installed package. */
  packageDir: string;
  spec: AgentSpec;
  account: AgentAccount;
  /** One open session per application the spec declares, by bundle id, held by the caller for the whole run. */
  sessions: ReadonlyMap<string, Session>;
  screenId: string;
  grants: readonly Grant[];
  ledger: EffectLedger;
  ceilings?: Ceilings;
  approver?: Approver;
  /** Answers questions; without one a question stays open until the task is cancelled or times out. */
  asker?: Asker;
  providers?: ProviderService;
  /**
   * The `run_unit` service (agent-units.ts) and each application's window
   * profile, which keys the procedures learned for it. Without it run_unit
   * answers `not_offered`.
   */
  units?: { service: UnitService; profiles: ReadonlyMap<string, { id: string; appVersion?: string }> };
  /** Where every provider call is recorded, attributed to the agent, task and run. */
  usage?: ProviderUsageLedger;
  /** Kept current for the whole run: working, idle, blocked on what, finished. */
  status?: StatusBoard;
  /** Whether now is inside the work hours; absent means always. Checked on acts, and schedules resident agents. */
  workHours?: (now: Date) => boolean;
  identity?: { displayName: string; organization?: string; role?: string };
  spawn: LineProcessSpawner;
  /** Programs for executors whose language runtime is not bundled, by `executor.runtime.kind`. */
  interpreters?: Readonly<Record<string, string>>;
  /** The host's environment, of which only PASSED_ENV reaches the agent. Defaults to process.env. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  killGraceMs?: number;
  clock?: Clock;
  newId?: () => string;
  /** Every event, with the run and, when it belongs to one, the task it came from. */
  onEvent?: (event: HostEvent, context: { runId: string; taskId?: string }) => void;
}

export interface AgentTaskOptions extends AgentHostOptions {
  task: { taskId: string; taskType: string; input: unknown; budget: Budget };
  timeoutMs: number;
  signal?: AbortSignal;
}

export type AgentTaskFailure =
  | 'cancelled'
  | 'timeout'
  | 'protocol'
  | 'exited'
  | 'error'
  | 'budget_exhausted'
  | 'provider_unavailable'
  | 'forbidden_effect';

export interface HostedAction {
  requestId: string;
  app: string;
  action: Action;
  target?: string;
  result?: ActionResult;
  refusal?: ActionRefusal;
}

export interface AgentTaskOutcome {
  status: 'succeeded' | 'partial' | 'failed';
  failure?: AgentTaskFailure;
  terminationReason?: TerminationReason;
  message?: string;
  /** Every act the agent asked for, in order, with what the runtime did about it. */
  actions: HostedAction[];
  items: Array<Extract<HostEvent, { type: 'item' }>>;
  artifacts: Array<Extract<HostEvent, { type: 'artifact' }>>;
  exitCode: number | null;
}

// ---------------------------------------------------------------------------
// The check chain, pure

export interface CheckInput {
  spec: AgentSpec;
  accountKey: string;
  app: string;
  action: Action;
  snapshotId?: string;
  target?: string;
  approvalId?: string;
  now: Date;
  grants: readonly Grant[];
  ceilings: Ceilings;
  /** Uses of this effect for this app and account within LIMIT_WINDOW_MS. */
  uses: readonly EffectUse[];
  inWorkHours: boolean;
  latestSnapshot?: string;
  unknownTargets: ReadonlySet<string>;
  approvals: ReadonlyMap<string, { effect: EffectClass; app?: string; target?: string; granted: boolean; used: boolean }>;
}

/** The limit that applies: the tightest of every level that sets one. */
export function effectiveLimit(effect: EffectClass, spec: AgentSpec, ceilings: Ceilings): EffectLimit {
  const levels = [HARD_LIMITS[effect], ceilings.org?.[effect], ceilings.user?.[effect], spec.limits[effect]].filter((l): l is EffectLimit => l !== undefined);
  const perDay = levels.map((l) => l.perDay).filter((n): n is number => n !== undefined);
  const interval = levels.map((l) => l.minIntervalMs).filter((n): n is number => n !== undefined);
  return { ...(perDay.length && { perDay: Math.min(...perDay) }), ...(interval.length && { minIntervalMs: Math.max(...interval) }) };
}

/** A grant that covers the action, or why there is none. */
export function findGrant(input: Pick<CheckInput, 'spec' | 'app' | 'accountKey' | 'grants' | 'now'>, effect: EffectClass): Grant | 'not_granted' | 'grant_expired' {
  const matching = input.grants.filter((g) => g.agentId === input.spec.id && g.application === input.app && g.accountKey === input.accountKey && g.effect === effect);
  const live = matching.find((g) => g.durable || (g.expiresAt !== undefined && Date.parse(g.expiresAt) > input.now.getTime()));
  if (live) return live;
  return matching.length > 0 ? 'grant_expired' : 'not_granted';
}

const refuse = (reason: ActionRefusal['reason'], message: string, nextSteps: ActionRefusal['nextSteps']): ActionRefusal => ({ reason, message, nextSteps });

/**
 * RFC §5 rule 2, in its fixed order: declared app and effect → grant →
 * limits → work hours → snapshot → target → approval. The first refusal
 * wins. Undefined means the action may be sent; the caller then consumes
 * the approval, records the use and audits.
 */
export function checkAction(input: CheckInput): ActionRefusal | undefined {
  const { spec, action, now } = input;
  const effect = action.effect;
  if (!spec.applications.some((a) => a.bundleId === input.app))
    return refuse('app_undeclared', `${input.app} is not among the agent's applications`, [{ kind: 'stop' }]);
  if (!spec.effects.includes(effect)) return refuse('effect_undeclared', `effect ${effect} is not declared`, [{ kind: 'use_read_only' }]);

  const submit = effect === 'external-submit';
  let mode: ApprovalMode | undefined;
  if (submit) {
    const grant = findGrant(input, effect);
    if (grant === 'not_granted') return refuse('not_granted', 'no grant covers this agent, application, account and effect', [{ kind: 'request_approval', effect }, { kind: 'use_read_only' }]);
    if (grant === 'grant_expired') return refuse('grant_expired', 'the grant for this effect has expired', [{ kind: 'request_approval', effect }, { kind: 'use_read_only' }]);
    mode = [spec.approval[effect] ?? 'human_in_the_loop', grant.mode, input.ceilings.approvalFloor?.[effect] ?? 'trusted_within_ceiling'].reduce(stricterApproval);
  }

  const limit = effectiveLimit(effect, spec, input.ceilings);
  if (limit.perDay !== undefined && input.uses.length >= limit.perDay) {
    const oldest = Math.min(...input.uses.map((u) => Date.parse(u.at)));
    return refuse('quota_exhausted', `${input.uses.length} of ${limit.perDay} ${effect} used in the last 24 hours`, [
      { kind: 'wait', ms: Math.max(1, oldest + LIMIT_WINDOW_MS - now.getTime()) },
      { kind: 'use_read_only' },
    ]);
  }
  if (limit.minIntervalMs !== undefined && input.uses.length > 0) {
    const last = Math.max(...input.uses.map((u) => Date.parse(u.at)));
    const since = now.getTime() - last;
    if (since < limit.minIntervalMs)
      return refuse('too_fast', `${since} ms since the last ${effect}; at least ${limit.minIntervalMs} ms apart`, [{ kind: 'wait', ms: limit.minIntervalMs - since }]);
  }

  if (!input.inWorkHours) return refuse('outside_work_hours', 'outside the work hours', [{ kind: 'stop' }]);

  if (input.snapshotId !== undefined && input.snapshotId !== input.latestSnapshot)
    return refuse('snapshot_stale', 'the snapshot is not the latest observation of this application', [{ kind: 'observe_again' }]);

  if (submit && (input.unknownTargets.has('*') || input.unknownTargets.has(input.target ?? '*')))
    return refuse('target_unknown_result', 'an earlier external-submit on this target has an unknown result and is never repeated', [{ kind: 'skip_target' }]);

  if (mode === 'locked_down') return refuse('approval_denied', 'external-submit is locked down for this agent', [{ kind: 'use_read_only' }]);
  if (mode === 'human_in_the_loop') {
    const approval = input.approvalId === undefined ? undefined : input.approvals.get(input.approvalId);
    const fits =
      approval !== undefined &&
      approval.granted &&
      !approval.used &&
      approval.effect === effect &&
      (approval.app === undefined || approval.app === input.app) &&
      (approval.target === undefined || approval.target === input.target);
    if (!fits) return refuse('approval_required', 'each external-submit needs its own granted approval', [{ kind: 'request_approval', effect }]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The host

/** The program and arguments that start the agent, resolved inside its package. */
export function agentCommand(packageDir: string, spec: AgentSpec, interpreters: Readonly<Record<string, string>> = {}): { file: string; args: string[] } {
  if (spec.executor.kind !== 'process') throw new RuntimeError('invalid_input', `executor ${spec.executor.kind} is not a process executor`);
  if (!isAbsolute(packageDir)) throw new RuntimeError('invalid_input', 'packageDir must be absolute');
  const [first, ...rest] = spec.executor.command;
  const root = resolve(packageDir);
  const program = resolve(root, first!);
  if (!program.startsWith(root + sep)) throw new RuntimeError('invalid_input', 'the executor command leaves the package');
  const runtime = spec.executor.runtime;
  if (runtime && !runtime.bundled) {
    const interpreter = interpreters[runtime.kind];
    if (!interpreter) throw new RuntimeError('capability_missing', `no ${runtime.kind} interpreter is configured for this agent`);
    return { file: interpreter, args: [program, ...rest] };
  }
  return { file: program, args: rest };
}

/** The whole environment an agent process gets. */
export function agentEnvironment(runId: string, spec: AgentSpec, hostEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, AGENT_DESKTOP: '1', AGENT_DESKTOP_RUN_ID: runId, AGENT_DESKTOP_AGENT_ID: spec.id, AGENT_DESKTOP_PROTOCOL: AGENT_PROTOCOL };
}

function checkSessions(options: AgentHostOptions): void {
  for (const app of options.spec.applications)
    if (!options.sessions.has(app.bundleId)) throw new RuntimeError('invalid_input', `no session for ${app.bundleId}`);
}

/** How a run's failure reads as a task's. */
function asTaskFailure(reason: StopReason | undefined): AgentTaskFailure | undefined {
  switch (reason) {
    case undefined:
      return undefined;
    case 'work_hours':
      return 'cancelled';
    case 'heartbeat_lost':
      return 'exited';
    default:
      return reason;
  }
}

/**
 * Run one task of a task-mode process agent to its end. Never throws for
 * anything the agent does; the outcome says what happened. Throws
 * `invalid_input` / `capability_missing` only for a call that cannot start.
 */
export async function runAgentTask(options: AgentTaskOptions): Promise<AgentTaskOutcome> {
  const { spec, task } = options;
  if (spec.mode !== 'task') throw new RuntimeError('invalid_input', 'runAgentTask runs task-mode agents; resident agents are scheduled');
  if (!(task.taskType in spec.tasks)) throw new RuntimeError('invalid_input', `task type ${task.taskType} is not one the agent accepts`);
  checkSessions(options);
  const command = agentCommand(options.packageDir, spec, options.interpreters);

  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const runId = newId();
  const run = new HostRun(options, clock, runId, 'task', { newId, unknownTargets: new Set() });
  run.addTask({ ...task, origin: 'runtime' });

  options.status?.start({ runId, agentId: spec.id, mode: spec.mode, taskId: task.taskId });
  const settle = (outcome: AgentTaskOutcome): AgentTaskOutcome => {
    options.status?.finish(runId, { ok: outcome.status !== 'failed', ...(outcome.failure !== undefined && { failure: outcome.failure }) });
    return outcome;
  };
  if (options.signal?.aborted) return settle(run.taskOutcome(task.taskId, null, 'cancelled'));
  const child = options.spawn(command.file, command.args, agentEnvironment(runId, spec, options.hostEnv ?? process.env));
  const result = await drive(run, child, {
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    timeoutMs: options.timeoutMs,
    ...(options.signal && { signal: options.signal }),
    begin: () => {
      run.sendAgentStart();
      run.sendTaskStart(task.taskId);
    },
  });
  return settle(run.taskOutcome(task.taskId, result.exitCode, asTaskFailure(result.stopping)));
}

// ---------------------------------------------------------------------------
// One agent process, from spawn to confirmed exit

type StopReason = 'cancelled' | 'timeout' | 'protocol' | 'error' | 'heartbeat_lost' | 'work_hours';

interface DriveControl {
  killGraceMs: number;
  /** Writes the opening messages, once the process is attached. */
  begin(): void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** No line for this long and the agent counts as lost. */
  heartbeatTimeoutMs?: number;
  /** Polled; false stops the agent politely with `reason`. */
  stillWanted?: { check: () => boolean; pollMs: number; reason: StopReason };
}

/**
 * Talk to one agent process until it is confirmed gone. Stopping asks first
 * (cancel for a task agent, stop for a resident one), sends SIGTERM after the
 * grace and SIGKILL after another; a lost or misbehaving agent is not asked.
 */
async function drive(run: HostRun, child: LineProcess, ctl: DriveControl): Promise<{ exitCode: number | null; stopping?: StopReason }> {
  run.attach(child);
  let gone = false;
  let stopping: StopReason | undefined;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const kill = (name: 'SIGTERM' | 'SIGKILL') => {
    if (gone) return;
    try {
      child.kill(name);
    } catch {
      // Already gone.
    }
  };
  const stop = (reason: StopReason, politely: boolean) => {
    if (stopping) return;
    stopping = reason;
    run.abort();
    if (politely) run.askToStop();
    const first = politely ? ctl.killGraceMs : 0;
    timers.push(setTimeout(() => kill('SIGTERM'), first));
    timers.push(setTimeout(() => kill('SIGKILL'), first + ctl.killGraceMs));
  };
  const onAbort = () => stop('cancelled', true);
  ctl.signal?.addEventListener('abort', onAbort, { once: true });
  if (ctl.timeoutMs !== undefined) timers.push(setTimeout(() => stop('timeout', true), ctl.timeoutMs));
  if (ctl.heartbeatTimeoutMs !== undefined) {
    const limit = ctl.heartbeatTimeoutMs;
    timers.push(setInterval(() => {
      if (run.answering === 0 && Date.now() - run.lastHeardAt > limit) stop('heartbeat_lost', false);
    }, Math.max(10, Math.min(1000, Math.floor(limit / 4)))));
  }
  const wanted = ctl.stillWanted;
  if (wanted) timers.push(setInterval(() => {
    if (!wanted.check()) stop(wanted.reason, true);
  }, wanted.pollMs));

  try {
    ctl.begin();
    if (ctl.signal?.aborted) onAbort();
    const reading = (async () => {
      for await (const line of child.lines()) {
        if (stopping === 'protocol' || run.broken) continue; // keep draining so the child never blocks
        const verdict = await run.take(line);
        if (verdict === 'protocol') stop('protocol', false);
        else if (verdict === 'failed') stop('error', false);
        else if (verdict === 'finished' || verdict === 'stopped') {
          try {
            child.closeInput();
          } catch {
            // Gone already.
          }
          timers.push(setTimeout(() => stop('error', false), EXIT_AFTER_FINISH_MS));
        }
      }
    })().catch(() => stop('error', false));

    const exit = await child.exited();
    gone = true;
    await reading;
    return { exitCode: exit.code, ...(stopping !== undefined && { stopping }) };
  } finally {
    for (const t of timers) clearTimeout(t);
    ctl.signal?.removeEventListener('abort', onAbort);
    run.abort();
  }
}

// ---------------------------------------------------------------------------
// The conversation with one process

type Verdict = 'ok' | 'protocol' | 'failed' | 'finished' | 'stopped';

interface TaskState {
  taskId: string;
  taskType: string;
  input: unknown;
  budget: Budget;
  origin: 'agent' | 'runtime';
  actions: HostedAction[];
  items: AgentTaskOutcome['items'];
  artifacts: AgentTaskOutcome['artifacts'];
  terminal?: Extract<AgentMessage, { type: 'task_finished' | 'task_failed' }>;
}

interface RunHooks {
  newId: () => string;
  /** Targets whose external-submit had an unknown result; shared across a resident agent's restarts. */
  unknownTargets: Set<string>;
  createTask?: (request: { taskType: string; input: unknown }) => Promise<string>;
  onTaskStarted?: (task: { taskId: string; taskType: string; input: unknown; origin: 'agent' | 'runtime' }) => void;
  onTaskEnded?: (taskId: string, outcome: AgentTaskOutcome) => void;
  defaultBudget?: Budget;
}

class HostRun {
  private child?: LineProcess;
  private outSeq = 0;
  private inSeq = 0;
  private readonly latest = new Map<string, string>();
  private readonly approvals = new Map<string, { effect: EffectClass; app?: string; target?: string; granted: boolean; used: boolean }>();
  private readonly tasks = new Map<string, TaskState>();
  /** The id under which a question-less ask_user blocks the run, until the agent's next message. */
  private openNote?: string;
  private readonly askedQuestions = new Set<string>();
  private readonly controller = new AbortController();
  /** Wall-clock time of the last line, for the heartbeat watchdog. */
  lastHeardAt = Date.now();
  stopped?: Extract<AgentMessage, { type: 'agent_stopped' }>;
  broken = false;
  /** Why the run broke or failed, for logs and run records. */
  problem?: string;
  private lastObserveError?: string;

  private readonly options: AgentHostOptions;
  private readonly clock: Clock;
  private readonly runId: string;
  private readonly mode: AgentMode;
  private readonly hooks: RunHooks;

  constructor(options: AgentHostOptions, clock: Clock, runId: string, mode: AgentMode, hooks: RunHooks) {
    this.options = options;
    this.clock = clock;
    this.runId = runId;
    this.mode = mode;
    this.hooks = hooks;
  }

  attach(child: LineProcess): void {
    this.child = child;
    this.lastHeardAt = Date.now();
  }

  abort(): void {
    this.controller.abort();
  }

  addTask(task: { taskId: string; taskType: string; input: unknown; budget: Budget; origin: 'agent' | 'runtime' }): TaskState {
    const state: TaskState = { ...task, actions: [], items: [], artifacts: [] };
    this.tasks.set(task.taskId, state);
    return state;
  }

  /** A task an earlier process of the same agent left unfinished; its record so far carries over. */
  adoptTask(state: TaskState): void {
    this.tasks.set(state.taskId, state);
  }

  activeTasks(): TaskState[] {
    return [...this.tasks.values()].filter((t) => !t.terminal);
  }

  hasTask(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  send(body: Record<string, unknown>): void {
    this.outSeq += 1;
    const message = { v: AGENT_PROTOCOL_VERSION, agentRunId: this.runId, seq: this.outSeq, at: this.clock.now().toISOString(), ...body } as RuntimeMessage;
    try {
      this.child?.write(encodeJsonLine(message));
    } catch {
      // The child is gone; its exit tells the rest.
    }
  }

  sendAgentStart(extra: { schedule?: ScheduleInfo; resume?: Array<{ taskId: string; taskType: string }> } = {}): void {
    const { spec, account, grants, identity } = this.options;
    this.send({
      type: 'agent_start',
      agent: { id: spec.id, version: spec.version, mode: spec.mode },
      account,
      grants: grants.filter((g) => g.agentId === spec.id),
      ...(identity && { identity }),
      ...(extra.schedule && { schedule: extra.schedule }),
      ...(extra.resume && extra.resume.length > 0 && { resume: { tasks: extra.resume } }),
    });
  }

  sendTaskStart(taskId: string): void {
    const t = this.tasks.get(taskId)!;
    const { spec, sessions, screenId } = this.options;
    this.send({
      type: 'task_start',
      taskId: t.taskId,
      taskType: t.taskType,
      input: t.input,
      budget: t.budget,
      session: {
        screenId,
        apps: spec.applications.map((a) => {
          const w = sessions.get(a.bundleId)!.binding().window;
          return { bundleId: a.bundleId, pid: w.pid, windowId: w.windowId };
        }),
      },
    });
  }

  /** The polite half of a stop: cancel each open task of a task agent, or stop a resident one. */
  askToStop(): void {
    if (this.mode === 'resident') this.send({ type: 'stop' });
    else for (const t of this.activeTasks()) this.send({ type: 'cancel', taskId: t.taskId });
  }

  private emit(event: HostEvent, taskId?: string): void {
    try {
      this.options.onEvent?.(event, { runId: this.runId, ...(taskId !== undefined && { taskId }) });
    } catch {
      // An observer's failure must not change what the agent is told.
    }
  }

  /**
   * Handle one line. Requests are answered before the next line is read.
   * While the host works on an answer (an approval a person has not decided,
   * a question, a slow act) the agent is waiting on the host, not silent:
   * the heartbeat watchdog does not count that time, and silence counts
   * again from the answer.
   */
  async take(line: string): Promise<Verdict> {
    this.answering += 1;
    try {
      return await this.takeLine(line);
    } finally {
      this.answering -= 1;
      this.lastHeardAt = Date.now();
    }
  }

  /** Lines the host is still answering; the heartbeat watchdog waits while there are any. */
  answering = 0;

  private async takeLine(line: string): Promise<Verdict> {
    this.lastHeardAt = Date.now();
    const signal = this.controller.signal;
    const parsed = parseAgentMessage(line, { agentRunId: this.runId, ...(this.inSeq > 0 && { lastSeq: this.inSeq }) });
    if (!parsed.ok) return this.breakWith(`malformed line: ${parsed.errors.slice(0, 3).join('; ')}`);
    const m = parsed.value;
    this.inSeq = m.seq;
    if (this.stopped) return this.breakWith(`${m.type} after agent_stopped`);
    // A task agent has one task; nothing may follow its end.
    if (this.mode === 'task' && [...this.tasks.values()].some((t) => t.terminal)) return this.breakWith(`${m.type} after the task ended`);
    const task = 'taskId' in m && m.taskId !== undefined ? this.tasks.get(m.taskId) : undefined;
    if ('taskId' in m && m.taskId !== undefined && (!task || task.terminal)) return this.breakWith(`${m.type} for ${task ? 'an ended' : 'an unknown'} task ${m.taskId}`);
    const board = this.options.status;
    // A note without a question blocks the run only until the agent moves on.
    if (this.openNote !== undefined && m.type !== 'ask_user') {
      board?.unblock(this.runId, this.openNote);
      this.openNote = undefined;
    }
    if (board && m.type !== 'heartbeat' && m.type !== 'ask_user' && m.type !== 'task_finished' && m.type !== 'task_failed' && m.type !== 'agent_stopped')
      board.activity(this.runId, m.seq);
    switch (m.type) {
      case 'observe': {
        const session = this.session(m.app);
        if (!session) return this.breakWith(`${m.type} on ${m.app}, which the agent does not declare`);
        const opts: ObserveOptions = {
          ...(m.elements !== undefined && { elements: m.elements }),
          ...(m.screenshot !== undefined && { screenshot: m.screenshot !== false }),
          ...(typeof m.screenshot === 'object' && { region: m.screenshot.region }),
        };
        const observation = await this.observe(session, opts, signal);
        if (!observation) return signal.aborted ? 'ok' : this.failWith(this.lastObserveError ?? `cannot observe ${m.app}`);
        this.latest.set(m.app, observation.snapshotId);
        this.send({ type: 'observation', taskId: m.taskId, requestId: m.requestId, app: m.app, observation });
        return 'ok';
      }
      case 'wait': {
        const session = this.session(m.app);
        if (!session) return this.breakWith(`${m.type} on ${m.app}, which the agent does not declare`);
        let check;
        try {
          check = await session.waitFor(m.wait, signal);
        } catch (error) {
          if (signal.aborted) return 'ok';
          check = { ok: false, evidence: [isRuntimeError(error) ? error.code : 'error'] };
        }
        const observation = await this.observe(session, { elements: true }, signal);
        if (!observation) return signal.aborted ? 'ok' : this.failWith(this.lastObserveError ?? `cannot observe ${m.app}`);
        this.latest.set(m.app, observation.snapshotId);
        this.send({
          type: 'observation',
          taskId: m.taskId,
          requestId: m.requestId,
          app: m.app,
          observation,
          check: { ok: check.ok, evidence: check.evidence, ...(check.elapsedMs !== undefined && { elapsedMs: check.elapsedMs }) },
        });
        return 'ok';
      }
      case 'act':
        await this.act(m, task!, signal);
        return 'ok';
      case 'provider':
        await this.provider(m, signal);
        return 'ok';
      case 'run_unit': {
        const session = this.session(m.app);
        if (!session) return this.breakWith(`${m.type} on ${m.app}, which the agent does not declare`);
        await this.runUnit(m, task!, session, signal);
        return 'ok';
      }
      case 'ask_approval':
        await this.askApproval(m, signal);
        return 'ok';
      case 'ask_user':
        await this.askUser(m, signal);
        return this.broken ? 'protocol' : 'ok';
      case 'item': {
        const event = { type: 'item' as const, itemId: m.itemId, status: m.status, ...(m.data && { data: m.data }) };
        task!.items.push(event);
        this.emit(event, m.taskId);
        return 'ok';
      }
      case 'artifact': {
        const event = { type: 'artifact' as const, path: m.path, kind: m.kind, completeness: m.completeness, ...(m.sha256 && { sha256: m.sha256 }) };
        task!.artifacts.push(event);
        this.emit(event, m.taskId);
        return 'ok';
      }
      case 'unit_started':
        this.emit({ type: 'unit', unit: m.unit, unitAttemptId: m.unitAttemptId, phase: 'started' }, m.taskId);
        return 'ok';
      case 'unit_finished':
        this.emit({ type: 'unit', unit: m.unit, unitAttemptId: m.unitAttemptId, phase: 'finished', ok: m.ok }, m.taskId);
        return 'ok';
      case 'heartbeat':
        board?.reportAgent(this.runId, m.seq, m.state, m.summary);
        this.emit({ type: 'heartbeat', state: m.state, ...(m.summary !== undefined && { summary: m.summary }) });
        return 'ok';
      case 'task_finished':
      case 'task_failed':
        task!.terminal = m;
        this.options.units?.service.release(task!.taskId);
        this.unitUsage.delete(task!.taskId);
        if (this.mode === 'task') return 'finished';
        this.hooks.onTaskEnded?.(task!.taskId, this.taskOutcome(task!.taskId, null));
        return 'ok';
      case 'create_task': {
        if (this.mode === 'task' || !(m.taskType in this.options.spec.tasks))
          return this.breakWith(this.mode === 'task' ? 'create_task from a task agent' : `create_task for undeclared task type ${m.taskType}`);
        const taskId = this.hooks.createTask ? await this.hooks.createTask({ taskType: m.taskType, input: m.input }) : this.hooks.newId();
        this.addTask({ taskId, taskType: m.taskType, input: m.input, budget: this.hooks.defaultBudget ?? DEFAULT_BUDGET, origin: 'agent' });
        this.send({ type: 'task_created', requestId: m.requestId, taskId });
        this.hooks.onTaskStarted?.({ taskId, taskType: m.taskType, input: m.input, origin: 'agent' });
        return 'ok';
      }
      case 'agent_stopped':
        if (this.mode === 'task') return this.breakWith('agent_stopped from a task agent');
        this.stopped = m;
        return 'stopped';
    }
  }

  private breakWith(problem: string): Verdict {
    this.broken = true;
    this.problem ??= problem;
    return 'protocol';
  }

  /** The desktop failed under the agent, e.g. its window went away: an error, not the agent's fault. */
  private failWith(problem: string): Verdict {
    this.problem ??= problem;
    return 'failed';
  }

  private session(app: string): Session | undefined {
    return this.options.spec.applications.some((a) => a.bundleId === app) ? this.options.sessions.get(app) : undefined;
  }

  private async observe(session: Session, opts: ObserveOptions, signal: AbortSignal): Promise<Observation | undefined> {
    try {
      return await session.observe(opts, signal);
    } catch (error) {
      // The window is gone or the run is stopping; the caller ends the task either way.
      this.lastObserveError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  private async act(m: Extract<AgentMessage, { type: 'act' }>, task: TaskState, signal: AbortSignal): Promise<void> {
    const o = this.options;
    const now = this.clock.now();
    const effect = m.action.effect;
    const accountKey = o.account.accountKey;
    const limited = effectiveLimit(effect, o.spec, o.ceilings ?? {});
    const uses =
      limited.perDay !== undefined || limited.minIntervalMs !== undefined
        ? await o.ledger.uses({ application: m.app, accountKey, effect, since: new Date(now.getTime() - LIMIT_WINDOW_MS).toISOString() })
        : [];
    const unknownTargets = this.hooks.unknownTargets;
    const refusal = checkAction({
      spec: o.spec,
      accountKey,
      app: m.app,
      action: m.action,
      ...(m.snapshotId !== undefined && { snapshotId: m.snapshotId }),
      ...(m.target !== undefined && { target: m.target }),
      ...(m.approvalId !== undefined && { approvalId: m.approvalId }),
      now,
      grants: o.grants,
      ceilings: o.ceilings ?? {},
      uses,
      inWorkHours: o.workHours ? o.workHours(now) : true,
      ...(this.latest.has(m.app) && { latestSnapshot: this.latest.get(m.app)! }),
      unknownTargets,
      approvals: this.approvals,
    });
    const audit = (decision: AuditRecord['decision'], extra: Partial<AuditRecord>) => {
      if (effect !== 'external-submit') return;
      this.emit(
        {
          type: 'audit',
          record: {
            at: now.toISOString(),
            agentId: o.spec.id,
            taskId: task.taskId,
            requestId: m.requestId,
            application: m.app,
            accountKey,
            effect,
            ...(m.target !== undefined && { target: m.target }),
            decision,
            ...extra,
          },
        },
        task.taskId,
      );
    };
    const entry: HostedAction = { requestId: m.requestId, app: m.app, action: m.action, ...(m.target !== undefined && { target: m.target }) };
    task.actions.push(entry);
    if (refusal) {
      entry.refusal = refusal;
      audit('refused', { reason: refusal.reason });
      this.send({ type: 'action_result', taskId: task.taskId, requestId: m.requestId, refusal });
      return;
    }

    if (m.approvalId !== undefined) {
      const approval = this.approvals.get(m.approvalId);
      if (approval) approval.used = true;
    }
    const session = o.sessions.get(m.app)!;
    let result: ActionResult;
    try {
      result = await session.act({ actionId: m.requestId, action: m.action, ...(m.snapshotId !== undefined && { snapshotId: m.snapshotId }) }, signal);
    } catch (error) {
      const code = isRuntimeError(error) ? error.code : 'io';
      // Cut off mid-delivery, an external-submit may have reached the app: never treat it as not sent.
      const status: ActionStatus = effect === 'external-submit' && (code === 'cancelled' || code === 'timeout') ? 'unknown' : 'failed';
      const at = this.clock.now().toISOString();
      result = { actionId: m.requestId, status, startedAt: now.toISOString(), finishedAt: at, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
    entry.result = result;
    if (effect === 'external-submit' && result.status === 'unknown') unknownTargets.add(m.target ?? '*');
    if (limited.perDay !== undefined || limited.minIntervalMs !== undefined)
      await o.ledger.record({
        agentId: o.spec.id,
        taskId: task.taskId,
        application: m.app,
        accountKey,
        effect,
        at: now.toISOString(),
        ...(m.target !== undefined && { target: m.target }),
        status: result.status,
      });
    audit('allowed', { result: result.status });
    this.send({ type: 'action_result', taskId: task.taskId, requestId: m.requestId, result });
  }

  private async provider(m: Extract<AgentMessage, { type: 'provider' }>, signal: AbortSignal): Promise<void> {
    const o = this.options;
    const base = { type: 'provider_result', requestId: m.requestId, ...(m.taskId !== undefined && { taskId: m.taskId }) };
    const need = o.spec.providers.find((p) => p.id === m.providerId);
    if (!need) return this.send({ ...base, ok: false, reason: 'provider_undeclared', message: `${m.providerId} is not declared` });
    if (!need.purposes.includes(m.purpose)) return this.send({ ...base, ok: false, reason: 'purpose_not_allowed', message: `${m.purpose} is not a declared purpose of ${m.providerId}` });
    if (!o.providers) return this.send({ ...base, ok: false, reason: 'provider_unavailable', message: 'no provider service is configured' });
    const started = this.clock.now();
    const record = async (ok: boolean, usage?: { inputTokens: number | 'unknown'; outputTokens: number | 'unknown' }, model?: string) => {
      try {
        await o.usage?.record({
          at: started.toISOString(),
          agentId: o.spec.id,
          runId: this.runId,
          ...(m.taskId !== undefined && { taskId: m.taskId }),
          providerId: m.providerId,
          ...(model !== undefined && { model }),
          purpose: m.purpose,
          ok,
          inputTokens: usage?.inputTokens ?? 'unknown',
          outputTokens: usage?.outputTokens ?? 'unknown',
          latencyMs: this.clock.now().getTime() - started.getTime(),
        });
      } catch {
        // Accounting that cannot be written must not change the agent's answer.
      }
    };
    try {
      const answer = await o.providers.call({ agentId: o.spec.id, ...(m.taskId !== undefined && { taskId: m.taskId }), providerId: m.providerId, purpose: m.purpose, input: m.input }, signal);
      await record(true, answer.usage, answer.model);
      this.send({ ...base, ok: true, output: answer.output, ...(answer.usage && { usage: answer.usage }) });
    } catch (error) {
      await record(false);
      if (signal.aborted) return;
      const unavailable = isRuntimeError(error, 'model_unavailable');
      this.send({ ...base, ok: false, reason: unavailable ? 'provider_unavailable' : 'error', message: unavailable ? 'the provider is unavailable' : 'the provider call failed' });
    }
  }

  private async runUnit(m: Extract<AgentMessage, { type: 'run_unit' }>, task: TaskState, session: Session, signal: AbortSignal): Promise<void> {
    const o = this.options;
    const base = { type: 'unit_result' as const, taskId: m.taskId, requestId: m.requestId };
    const refuse = (reason: UnitRefusalReason, message: string, observation?: Observation) =>
      this.send({ ...base, ok: false, reason, message, ...(observation && { observation }) });
    const units = o.units;
    const profile = units?.profiles.get(m.app);
    if (!units || !profile) return refuse('not_offered', 'this runtime does not run units for this application');
    const problems = unitProblems(m.unit, o.spec.effects);
    if (problems.forbidden) return refuse('forbidden_effect', 'a unit may not send anything: external-submit goes through act and the check chain');
    if (problems.errors.length) return refuse('invalid_unit', problems.errors.slice(0, 5).join('; '));
    const started = this.clock.now();
    this.emit({ type: 'unit', unit: m.unit.name, unitAttemptId: m.requestId, phase: 'started' }, m.taskId);
    let result: UnitRunResult;
    try {
      result = await units.service.run(
        {
          agentId: o.spec.id,
          agentVersion: o.spec.version,
          taskId: m.taskId,
          ...(m.itemId !== undefined && { itemId: m.itemId }),
          profile,
          unit: m.unit,
          bindings: m.bindings ?? {},
          session,
          budget: task.budget,
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      this.emit({ type: 'unit', unit: m.unit.name, unitAttemptId: m.requestId, phase: 'finished', ok: false }, m.taskId);
      return refuse('error', error instanceof Error ? error.message.slice(0, 300) : 'the unit failed');
    }
    if (signal.aborted) return;
    // Model calls the unit made, attributed like the agent's own provider calls.
    const before = this.unitUsage.get(m.taskId);
    const calls = result.usage.uiModelCalls + result.usage.repairModelCalls - ((before?.uiModelCalls ?? 0) + (before?.repairModelCalls ?? 0));
    this.unitUsage.set(m.taskId, result.usage);
    if (calls > 0) {
      const tokens = (now: Usage['inputTokens'], then: Usage['inputTokens'] | undefined) =>
        now === 'unknown' || then === 'unknown' ? ('unknown' as const) : now - (then ?? 0);
      try {
        await o.usage?.record({
          at: started.toISOString(),
          agentId: o.spec.id,
          runId: this.runId,
          taskId: m.taskId,
          providerId: 'runtime.exploration',
          purpose: 'repair',
          ok: result.ok,
          inputTokens: tokens(result.usage.inputTokens, before?.inputTokens),
          outputTokens: tokens(result.usage.outputTokens, before?.outputTokens),
          latencyMs: this.clock.now().getTime() - started.getTime(),
        });
      } catch {
        // Accounting that cannot be written must not change the agent's answer.
      }
    }
    this.emit({ type: 'unit', unit: m.unit.name, unitAttemptId: m.requestId, phase: 'finished', ok: result.ok }, m.taskId);
    if (result.ok) {
      this.latest.set(m.app, result.observation.snapshotId);
      this.send({
        ...base,
        ok: true,
        route: result.route,
        observation: result.observation,
        check: { ok: result.check.ok, evidence: result.check.evidence },
        ...(result.procedure && { procedure: result.procedure }),
      });
    } else {
      if (result.observation) this.latest.set(m.app, result.observation.snapshotId);
      refuse(result.reason, result.message, result.observation);
    }
  }

  /** What each task's units had spent at their last answer, to record only what is new. */
  private readonly unitUsage = new Map<string, Usage>();

  private async askApproval(m: Extract<AgentMessage, { type: 'ask_approval' }>, signal: AbortSignal): Promise<void> {
    const o = this.options;
    const app = m.app ?? o.spec.applications[0]!.bundleId;
    if (this.approvals.has(m.approvalId)) {
      this.send({ type: 'deny', taskId: m.taskId, approvalId: m.approvalId, guidance: { text: 'approvalId was already used', hints: ['not_now'] } });
      return;
    }
    const record = { effect: m.effect, app, ...(m.target !== undefined && { target: m.target }), granted: false, used: false };
    this.approvals.set(m.approvalId, record);
    const now = this.clock.now();
    const limit = effectiveLimit(m.effect, o.spec, o.ceilings ?? {});
    const uses = await o.ledger.uses({ application: app, accountKey: o.account.accountKey, effect: m.effect, since: new Date(now.getTime() - LIMIT_WINDOW_MS).toISOString() });
    const last = uses.length ? Math.max(...uses.map((u) => Date.parse(u.at))) : undefined;
    const unknownTargets = this.hooks.unknownTargets;
    const request: ApprovalRequest = {
      agentId: o.spec.id,
      taskId: m.taskId,
      approvalId: m.approvalId,
      effect: m.effect,
      summary: m.summary,
      ...(m.target !== undefined && { target: m.target }),
      ...(m.action !== undefined && { action: m.action }),
      consequences: {
        application: app,
        accountKey: o.account.accountKey,
        usedInWindow: uses.length,
        ...(limit.perDay !== undefined && { remainingInWindow: Math.max(0, limit.perDay - uses.length) }),
        ...(last !== undefined && { msSinceLast: now.getTime() - last }),
        targetHadUnknownResult: unknownTargets.has('*') || unknownTargets.has(m.target ?? '*'),
        inWorkHours: o.workHours ? o.workHours(now) : true,
      },
    };
    let decision: ApprovalDecision = { decision: 'deny', guidance: { text: 'no one can approve on this machine', hints: ['not_now'] } };
    if (o.approver) {
      o.status?.block(this.runId, { kind: 'approval', id: m.approvalId, message: m.summary });
      try {
        decision = await o.approver.request(request, signal);
      } catch {
        if (signal.aborted) return;
        decision = { decision: 'deny', guidance: { text: 'the approval could not be asked', hints: ['not_now'] } };
      } finally {
        o.status?.unblock(this.runId, m.approvalId);
      }
    }
    this.emit({ type: 'approval', request, decision }, m.taskId);
    if (decision.decision === 'grant') {
      record.granted = true;
      this.send({ type: 'grant', taskId: m.taskId, approvalId: m.approvalId });
    } else this.send({ type: 'deny', taskId: m.taskId, approvalId: m.approvalId, ...(decision.guidance && { guidance: decision.guidance }) });
  }

  private async askUser(m: Extract<AgentMessage, { type: 'ask_user' }>, signal: AbortSignal): Promise<void> {
    const o = this.options;
    if (m.questionId === undefined) {
      const id = `note:${m.seq}`;
      o.status?.block(this.runId, { kind: 'input', id, message: m.message });
      this.openNote = id;
      this.emit({ type: 'ask_user', reason: m.reason, message: m.message }, m.taskId);
      return;
    }
    if (this.askedQuestions.has(m.questionId)) {
      // One answer per question id; asking again under the same id is a protocol slip.
      this.breakWith(`question ${m.questionId} asked twice`);
      return;
    }
    this.askedQuestions.add(m.questionId);
    o.status?.block(this.runId, { kind: 'input', id: m.questionId, message: m.message });
    this.emit({ type: 'ask_user', reason: m.reason, message: m.message, questionId: m.questionId }, m.taskId);
    if (!o.asker) return; // Stays blocked; cancel or the timeout ends it.
    let answer: string | undefined;
    try {
      // Ask again, up to three times, until the answer is one of the choices offered.
      for (let attempt = 0; attempt < 3 && answer === undefined; attempt++) {
        const given = await o.asker.ask(
          { agentId: o.spec.id, taskId: m.taskId, questionId: m.questionId, reason: m.reason, message: m.message, ...(m.choices && { choices: m.choices }) },
          signal,
        );
        if (!m.choices || m.choices.includes(given)) answer = given;
      }
    } catch {
      return; // Cancelled, or the asker failed: the run is stopping or stays blocked.
    }
    if (answer === undefined) return;
    o.status?.unblock(this.runId, m.questionId);
    this.emit({ type: 'ask_user', reason: m.reason, message: m.message, questionId: m.questionId, answer }, m.taskId);
    this.send({ type: 'user_answer', taskId: m.taskId, questionId: m.questionId, answer });
  }

  /**
   * How a task ended. For a task agent a stop or a broken protocol decides,
   * and a clean end also needs exit code 0. A resident agent's task that the
   * agent ended stands as the agent reported it.
   */
  taskOutcome(taskId: string, exitCode: number | null, stopped?: AgentTaskFailure): AgentTaskOutcome {
    const t = this.tasks.get(taskId)!;
    const base = { actions: t.actions, items: t.items, artifacts: t.artifacts, exitCode };
    const end = t.terminal;
    if (!end || this.mode === 'task') {
      const failure = stopped ?? (this.broken ? 'protocol' : undefined);
      if (failure) return { status: 'failed', failure, ...(this.problem !== undefined && { message: this.problem }), ...base };
    }
    if (!end) return { status: 'failed', failure: 'exited', ...base };
    if (end.type === 'task_failed') return { status: 'failed', failure: end.reason, message: end.message, ...base };
    if (this.mode === 'task' && exitCode !== 0) return { status: 'failed', failure: 'error', message: `the agent exited with ${exitCode} after finishing`, ...base };
    return { status: end.status, ...(end.terminationReason && { terminationReason: end.terminationReason }), ...base };
  }
}

// ---------------------------------------------------------------------------
// Resident agents

export type ResidentRunEnd = 'work_hours' | 'cancelled' | 'crashed' | 'protocol' | 'heartbeat_lost' | 'stopped_itself' | 'error' | 'no_session';

/** Sessions opened for each process run of a resident agent and closed after it, so no app is held outside the hours. */
export interface SessionSource {
  open(signal: AbortSignal): Promise<ReadonlyMap<string, Session>>;
  close(sessions: ReadonlyMap<string, Session>): Promise<void>;
}

/** One process lifetime of a resident agent. */
export interface ResidentRunRecord {
  runId: string;
  startedAt: string;
  endedAt: string;
  end: ResidentRunEnd;
  exitCode: number | null;
  /** Tasks still open when the process ended; they go on in the next one. */
  carried: number;
  /** What went wrong, when the runtime knows: a malformed line, a window that went away. */
  detail?: string;
}

export interface ResidentOutcome {
  /** `signal`: asked to stop. `gave_up`: crashed more than maxRestarts times in one stretch of work hours. */
  stoppedBy: 'signal' | 'gave_up';
  runs: ResidentRunRecord[];
}

export interface ResidentAgentOptions extends Omit<AgentHostOptions, 'sessions'> {
  /** Sessions held for the agent's whole life; or give `sessionSource` to open them per run. */
  sessions?: ReadonlyMap<string, Session>;
  sessionSource?: SessionSource;
  /** Stops the agent for good. */
  signal?: AbortSignal;
  /** No line for this long and the agent counts as lost. Default: twice the manifest's idlePollSeconds. */
  heartbeatTimeoutMs?: number;
  /** How often work hours are checked, in and out of them. Default 60 s. */
  workHoursPollMs?: number;
  /** Abnormal ends tolerated in one stretch of work hours before giving up. Default 3. */
  maxRestarts?: number;
  /** Waits before each restart; the last repeats. Default 2 s, 10 s, 30 s. */
  restartDelaysMs?: readonly number[];
  /**
   * How often to try again when the app is in someone else's hands (a
   * session conflict or a held lease): the user is using it, or it was not
   * handed over. Such tries never count toward maxRestarts. Default 60 s.
   */
  sessionWaitMs?: number;
  /** The timezone the agent is told its work hours are in. Default: this machine's. */
  timezone?: string;
  /** The budget of a task the agent creates itself. Default DEFAULT_BUDGET. */
  defaultBudget?: Budget;
  /** Records a task the agent asks for and returns its id; default a fresh id. */
  createTask?: (request: { taskType: string; input: unknown }) => Promise<string>;
  onTaskStarted?: (task: { taskId: string; taskType: string; input: unknown; origin: 'agent' | 'runtime' }) => void;
  /** Every task ends here exactly once: as the agent reported it, or failed when the agent stops for good without finishing it. */
  onTaskEnded?: (taskId: string, outcome: AgentTaskOutcome) => void;
  onRunEnded?: (record: ResidentRunRecord) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ResidentAgent {
  /** Give the agent a task; it starts at once if the agent is up, otherwise when it next starts. Returns the task id. */
  submit(task: { taskType: string; input: unknown; budget?: Budget; taskId?: string }): string;
  /** Stop for good: the agent is asked to stop, then made to. */
  stop(): void;
  /** The process run under way, if any. */
  currentRunId(): string | undefined;
  readonly done: Promise<ResidentOutcome>;
}

const DEFAULT_RESTART_DELAYS_MS = [2000, 10_000, 30_000] as const;

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RuntimeError('cancelled', 'stopped'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RuntimeError('cancelled', 'stopped'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Keep a resident agent running through its work hours (RFC 0001 §5): start
 * it when the hours begin, stop it politely when they end, treat silence
 * longer than the heartbeat timeout as lost, and restart it after a crash
 * with a growing pause, giving up after `maxRestarts` in one stretch of work
 * hours. Tasks it has not finished go to the next process, sent again with
 * their input and listed in `agent_start.resume`. Targets with an unknown
 * external-submit result stay blocked across restarts.
 */
export function startResidentAgent(options: ResidentAgentOptions): ResidentAgent {
  const { spec } = options;
  if (spec.mode !== 'resident' || !spec.schedule) throw new RuntimeError('invalid_input', 'startResidentAgent runs resident agents with a schedule');
  if (options.sessions) checkSessions({ ...options, sessions: options.sessions });
  else if (!options.sessionSource) throw new RuntimeError('invalid_input', 'a resident agent needs sessions or a sessionSource');
  const command = agentCommand(options.packageDir, spec, options.interpreters);
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? spec.schedule.idlePollSeconds * 2000;
  const workHoursPollMs = options.workHoursPollMs ?? 60_000;
  const maxRestarts = options.maxRestarts ?? 3;
  const sessionWaitMs = options.sessionWaitMs ?? 60_000;
  /** The status board entry that shows the agent waiting for its app, while it does. */
  let waitingRun: string | undefined;
  let waitingMessage: string | undefined;
  const delays = options.restartDelaysMs && options.restartDelaysMs.length > 0 ? options.restartDelaysMs : DEFAULT_RESTART_DELAYS_MS;
  const sleep = options.sleep ?? sleepFor;
  const schedule: ScheduleInfo = {
    workHours: spec.schedule.workHours,
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    idlePollSeconds: spec.schedule.idlePollSeconds,
  };
  const inHours = () => !options.workHours || options.workHours(clock.now());

  const stopper = new AbortController();
  if (options.signal?.aborted) stopper.abort();
  else options.signal?.addEventListener('abort', () => stopper.abort(), { once: true });

  const unknownTargets = new Set<string>();
  /** Runtime tasks not yet handed to a process. */
  const queue: TaskState[] = [];
  /** Tasks a process left open. */
  let carried: TaskState[] = [];
  let current: { runId: string; run: HostRun; live: boolean } | undefined;
  const runs: ResidentRunRecord[] = [];
  const ended = new Set<string>();
  const endTask = (taskId: string, outcome: AgentTaskOutcome) => {
    if (ended.has(taskId)) return;
    ended.add(taskId);
    try {
      options.onTaskEnded?.(taskId, outcome);
    } catch {
      // The caller's.
    }
  };
  const failed = (t: TaskState, failure: AgentTaskFailure): AgentTaskOutcome => ({ status: 'failed', failure, actions: t.actions, items: t.items, artifacts: t.artifacts, exitCode: null });

  const done = (async (): Promise<ResidentOutcome> => {
    let strikes = 0;
    let gaveUp = false;
    try {
      while (!stopper.signal.aborted) {
        if (!inHours()) {
          strikes = 0;
          try {
            await sleep(workHoursPollMs, stopper.signal);
          } catch {
            break;
          }
          continue;
        }
        const runId = newId();
        let sessions = options.sessions;
        if (!sessions) {
          try {
            sessions = await options.sessionSource!.open(stopper.signal);
            checkSessions({ ...options, sessions });
          } catch (error) {
            if (sessions) await options.sessionSource!.close(sessions).catch(() => undefined);
            if (stopper.signal.aborted) break;
            const at = clock.now().toISOString();
            const record: ResidentRunRecord = {
              runId,
              startedAt: at,
              endedAt: at,
              end: 'no_session',
              exitCode: null,
              carried: carried.length,
              detail: error instanceof Error ? error.message : String(error),
            };
            runs.push(record);
            try {
              options.onRunEnded?.(record);
            } catch {
              // The caller's.
            }
            // An app the user is using, or one not handed over, is no crash: wait for it, without end.
            const occupied = isRuntimeError(error, 'conflict') || isRuntimeError(error, 'lease_held') || isRuntimeError(error, 'login_required');
            if (!occupied) strikes += 1;
            else {
              // Shown on the status board as what the agent waits for, until its sessions open.
              const message = error instanceof Error ? error.message : String(error);
              if (!waitingRun) {
                waitingRun = runId;
                options.status?.start({ runId, agentId: spec.id, mode: 'resident' });
              }
              if (waitingMessage !== message) {
                if (waitingMessage !== undefined) options.status?.unblock(waitingRun, 'session');
                options.status?.block(waitingRun, { kind: isRuntimeError(error, 'login_required') ? 'input' : 'agent', id: 'session', message });
                waitingMessage = message;
              }
            }
            if (strikes > maxRestarts) {
              gaveUp = true;
              break;
            }
            try {
              await sleep(occupied ? sessionWaitMs : delays[Math.min(strikes - 1, delays.length - 1)]!, stopper.signal);
            } catch {
              break;
            }
            continue;
          }
        }
        if (waitingRun) {
          options.status?.finish(waitingRun, { ok: true });
          waitingRun = undefined;
          waitingMessage = undefined;
        }
        const runOptions: AgentHostOptions = { ...options, sessions };
        const run = new HostRun(runOptions, clock, runId, 'resident', {
          newId,
          unknownTargets,
          ...(options.createTask && { createTask: options.createTask }),
          onTaskStarted: (t) => options.onTaskStarted?.(t),
          onTaskEnded: endTask,
          ...(options.defaultBudget && { defaultBudget: options.defaultBudget }),
        });
        const resumed = carried;
        for (const t of resumed) run.adoptTask(t);
        options.status?.start({ runId, agentId: spec.id, mode: 'resident' });
        const startedAt = clock.now().toISOString();
        const child = options.spawn(command.file, command.args, agentEnvironment(runId, spec, options.hostEnv ?? process.env));
        current = { runId, run, live: true };
        const result = await drive(run, child, {
          killGraceMs,
          signal: stopper.signal,
          heartbeatTimeoutMs,
          ...(options.workHours && { stillWanted: { check: inHours, pollMs: workHoursPollMs, reason: 'work_hours' as const } }),
          begin: () => {
            run.sendAgentStart({ schedule, resume: resumed.map((t) => ({ taskId: t.taskId, taskType: t.taskType })) });
            for (const t of resumed) run.sendTaskStart(t.taskId);
            for (const t of queue.splice(0)) {
              run.adoptTask(t);
              run.sendTaskStart(t.taskId);
              options.onTaskStarted?.({ taskId: t.taskId, taskType: t.taskType, input: t.input, origin: 'runtime' });
            }
          },
        });
        current.live = false;
        current = undefined;
        if (!options.sessions) await options.sessionSource!.close(sessions).catch(() => undefined);

        let end: ResidentRunEnd;
        switch (result.stopping) {
          case 'cancelled':
          case 'heartbeat_lost':
          case 'protocol':
          case 'error':
          case 'work_hours':
            end = result.stopping;
            break;
          default:
            // It stopped on its own: fine at the end of the hours, a failure otherwise.
            end = run.stopped ? (run.stopped.reason === 'work_hours' && !inHours() ? 'work_hours' : 'stopped_itself') : 'crashed';
        }
        carried = run.activeTasks();
        const record: ResidentRunRecord = {
          runId,
          startedAt,
          endedAt: clock.now().toISOString(),
          end,
          exitCode: result.exitCode,
          carried: carried.length,
          ...(run.problem !== undefined && { detail: run.problem }),
        };
        runs.push(record);
        options.status?.finish(runId, { ok: end === 'work_hours' || end === 'cancelled', ...(end !== 'work_hours' && end !== 'cancelled' && { failure: run.problem ? `${end}: ${run.problem}` : end }) });
        try {
          options.onRunEnded?.(record);
        } catch {
          // The caller's.
        }
        if (end === 'cancelled') break;
        if (end === 'work_hours') {
          strikes = 0;
          continue;
        }
        strikes += 1;
        if (strikes > maxRestarts) {
          gaveUp = true;
          break;
        }
        try {
          await sleep(delays[Math.min(strikes - 1, delays.length - 1)]!, stopper.signal);
        } catch {
          break;
        }
      }
    } finally {
      // Stopped for good, whichever way: nothing more is taken.
      stopper.abort();
      // Whatever is still open will not be finished by this agent.
      for (const t of carried) endTask(t.taskId, failed(t, gaveUp ? 'exited' : 'cancelled'));
      for (const t of queue.splice(0)) endTask(t.taskId, failed(t, 'cancelled'));
    }
    if (waitingRun) options.status?.finish(waitingRun, { ok: !gaveUp, ...(gaveUp && { failure: 'gave_up' }) });
    return { stoppedBy: gaveUp ? 'gave_up' : 'signal', runs };
  })();

  return {
    submit(task) {
      if (!(task.taskType in spec.tasks)) throw new RuntimeError('invalid_input', `task type ${task.taskType} is not one the agent accepts`);
      if (stopper.signal.aborted) throw new RuntimeError('conflict', 'the agent is stopped');
      const taskId = task.taskId ?? newId();
      if (current?.run.hasTask(taskId) || queue.some((t) => t.taskId === taskId) || carried.some((t) => t.taskId === taskId) || ended.has(taskId))
        throw new RuntimeError('conflict', `task ${taskId} already exists`);
      const state: TaskState = {
        taskId,
        taskType: task.taskType,
        input: task.input,
        budget: task.budget ?? options.defaultBudget ?? DEFAULT_BUDGET,
        origin: 'runtime',
        actions: [],
        items: [],
        artifacts: [],
      };
      if (current?.live) {
        current.run.adoptTask(state);
        current.run.sendTaskStart(taskId);
        options.onTaskStarted?.({ taskId, taskType: task.taskType, input: task.input, origin: 'runtime' });
      } else queue.push(state);
      return taskId;
    },
    stop() {
      stopper.abort();
    },
    currentRunId: () => current?.runId,
    done,
  };
}
