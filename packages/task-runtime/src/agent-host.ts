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
} from './agent-contracts.ts';
import type { StatusBoard } from './agent-status.ts';
import type { ProviderUsageLedger } from './agent-ledgers.ts';
import {
  RuntimeError,
  encodeJsonLine,
  isRuntimeError,
  systemClock,
  type AccountScope,
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

export interface AgentTaskOptions {
  /** Absolute directory of the installed package. */
  packageDir: string;
  spec: AgentSpec;
  task: { taskId: string; taskType: string; input: unknown; budget: Budget };
  account: AccountScope;
  /** One open session per application the spec declares, by bundle id. */
  sessions: ReadonlyMap<string, Session>;
  screenId: string;
  grants: readonly Grant[];
  ledger: EffectLedger;
  ceilings?: Ceilings;
  approver?: Approver;
  /** Answers questions; without one a question stays open until the task is cancelled or times out. */
  asker?: Asker;
  providers?: ProviderService;
  /** Where every provider call is recorded, attributed to the agent, task and run. */
  usage?: ProviderUsageLedger;
  /** Kept current for the whole run: working, idle, blocked on what, finished. */
  status?: StatusBoard;
  /** Whether now is inside the work hours; absent means always. */
  workHours?: (now: Date) => boolean;
  identity?: { displayName: string; organization?: string; role?: string };
  spawn: LineProcessSpawner;
  /** Programs for executors whose language runtime is not bundled, by `executor.runtime.kind`. */
  interpreters?: Readonly<Record<string, string>>;
  /** The host's environment, of which only PASSED_ENV reaches the agent. Defaults to process.env. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  killGraceMs?: number;
  clock?: Clock;
  newId?: () => string;
  onEvent?: (event: HostEvent) => void;
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

/**
 * Run one task of a task-mode process agent to its end. Never throws for
 * anything the agent does; the outcome says what happened. Throws
 * `invalid_input` / `capability_missing` only for a call that cannot start.
 */
export async function runAgentTask(options: AgentTaskOptions): Promise<AgentTaskOutcome> {
  const { spec, task } = options;
  if (spec.mode !== 'task') throw new RuntimeError('invalid_input', 'runAgentTask runs task-mode agents; resident agents are scheduled');
  if (!(task.taskType in spec.tasks)) throw new RuntimeError('invalid_input', `task type ${task.taskType} is not one the agent accepts`);
  for (const app of spec.applications)
    if (!options.sessions.has(app.bundleId)) throw new RuntimeError('invalid_input', `no session for ${app.bundleId}`);
  const command = agentCommand(options.packageDir, spec, options.interpreters);

  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const runId = newId();
  const run = new HostRun(options, clock, runId);
  const controller = new AbortController();
  const outer = options.signal;

  options.status?.start({ runId, agentId: spec.id, mode: spec.mode, taskId: task.taskId });
  const settle = (outcome: AgentTaskOutcome): AgentTaskOutcome => {
    options.status?.finish(runId, { ok: outcome.status !== 'failed', ...(outcome.failure !== undefined && { failure: outcome.failure }) });
    return outcome;
  };
  if (outer?.aborted) return settle(run.outcome(null, 'cancelled'));
  const child = options.spawn(command.file, command.args, agentEnvironment(runId, spec, options.hostEnv ?? process.env));
  run.attach(child);

  let gone = false;
  let stopping: AgentTaskFailure | undefined;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const kill = (name: 'SIGTERM' | 'SIGKILL') => {
    if (gone) return;
    try {
      child.kill(name);
    } catch {
      // Already gone.
    }
  };
  /** Ask, then insist: cancel message, SIGTERM after the grace, SIGKILL after another. */
  const stop = (reason: AgentTaskFailure, politely: boolean) => {
    if (stopping) return;
    stopping = reason;
    run.stoppedBy(reason);
    controller.abort();
    if (politely && !run.finished) run.send({ type: 'cancel', taskId: task.taskId });
    const first = politely ? killGraceMs : 0;
    timers.push(setTimeout(() => kill('SIGTERM'), first));
    timers.push(setTimeout(() => kill('SIGKILL'), first + killGraceMs));
  };
  const onAbort = () => stop('cancelled', true);
  outer?.addEventListener('abort', onAbort, { once: true });
  timers.push(setTimeout(() => stop('timeout', true), options.timeoutMs));

  try {
    run.send({
      type: 'agent_start',
      agent: { id: spec.id, version: spec.version, mode: spec.mode },
      account: options.account,
      grants: options.grants.filter((g) => g.agentId === spec.id),
      ...(options.identity && { identity: options.identity }),
    });
    run.send({
      type: 'task_start',
      taskId: task.taskId,
      taskType: task.taskType,
      input: task.input,
      budget: task.budget,
      session: {
        screenId: options.screenId,
        apps: spec.applications.map((a) => {
          const w = options.sessions.get(a.bundleId)!.binding().window;
          return { bundleId: a.bundleId, pid: w.pid, windowId: w.windowId };
        }),
      },
    });

    const reading = (async () => {
      for await (const line of child.lines()) {
        if (stopping === 'protocol' || run.broken) continue; // keep draining so the child never blocks
        const verdict = await run.take(line, controller.signal);
        if (verdict === 'protocol') stop('protocol', false);
        else if (verdict === 'finished') {
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
    return settle(run.outcome(exit.code, stopping));
  } finally {
    for (const t of timers) clearTimeout(t);
    outer?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

type Verdict = 'ok' | 'protocol' | 'finished';

class HostRun {
  private child?: LineProcess;
  private outSeq = 0;
  private inSeq = 0;
  private readonly latest = new Map<string, string>();
  private readonly unknownTargets = new Set<string>();
  private readonly approvals = new Map<string, { effect: EffectClass; app?: string; target?: string; granted: boolean; used: boolean }>();
  readonly actions: HostedAction[] = [];
  readonly items: AgentTaskOutcome['items'] = [];
  readonly artifacts: AgentTaskOutcome['artifacts'] = [];
  private terminal?: Extract<AgentMessage, { type: 'task_finished' | 'task_failed' }>;
  private stopReason?: AgentTaskFailure;
  /** The id under which a question-less ask_user blocks the run, until the agent's next message. */
  private openNote?: string;
  private readonly askedQuestions = new Set<string>();
  broken = false;
  finished = false;

  private readonly options: AgentTaskOptions;
  private readonly clock: Clock;
  private readonly runId: string;

  constructor(options: AgentTaskOptions, clock: Clock, runId: string) {
    this.options = options;
    this.clock = clock;
    this.runId = runId;
  }

  attach(child: LineProcess): void {
    this.child = child;
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

  private emit(event: HostEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // An observer's failure must not change what the agent is told.
    }
  }

  stoppedBy(reason: AgentTaskFailure): void {
    this.stopReason ??= reason;
  }

  /** Handle one line. Requests are answered before the next line is read. */
  async take(line: string, signal: AbortSignal): Promise<Verdict> {
    const parsed = parseAgentMessage(line, { agentRunId: this.runId, ...(this.inSeq > 0 && { lastSeq: this.inSeq }) });
    if (!parsed.ok) return this.breakWith();
    const m = parsed.value;
    this.inSeq = m.seq;
    if (this.terminal) return this.breakWith();
    const { task } = this.options;
    if ('taskId' in m && m.taskId !== undefined && m.taskId !== task.taskId) return this.breakWith();
    const board = this.options.status;
    // A note without a question blocks the run only until the agent moves on.
    if (this.openNote !== undefined && m.type !== 'ask_user') {
      board?.unblock(this.runId, this.openNote);
      this.openNote = undefined;
    }
    if (board && m.type !== 'heartbeat' && m.type !== 'ask_user' && m.type !== 'task_finished' && m.type !== 'task_failed') board.activity(this.runId, m.seq);
    switch (m.type) {
      case 'observe': {
        const session = this.session(m.app);
        if (!session) return this.breakWith();
        const opts: ObserveOptions = {
          ...(m.elements !== undefined && { elements: m.elements }),
          ...(m.screenshot !== undefined && { screenshot: m.screenshot !== false }),
          ...(typeof m.screenshot === 'object' && { region: m.screenshot.region }),
        };
        const observation = await this.observe(session, opts, signal);
        if (!observation) return signal.aborted ? 'ok' : this.breakWith();
        this.latest.set(m.app, observation.snapshotId);
        this.send({ type: 'observation', taskId: task.taskId, requestId: m.requestId, app: m.app, observation });
        return 'ok';
      }
      case 'wait': {
        const session = this.session(m.app);
        if (!session) return this.breakWith();
        let check;
        try {
          check = await session.waitFor(m.wait, signal);
        } catch (error) {
          if (signal.aborted) return 'ok';
          check = { ok: false, evidence: [isRuntimeError(error) ? error.code : 'error'] };
        }
        const observation = await this.observe(session, { elements: true }, signal);
        if (!observation) return signal.aborted ? 'ok' : this.breakWith();
        this.latest.set(m.app, observation.snapshotId);
        this.send({
          type: 'observation',
          taskId: task.taskId,
          requestId: m.requestId,
          app: m.app,
          observation,
          check: { ok: check.ok, evidence: check.evidence, ...(check.elapsedMs !== undefined && { elapsedMs: check.elapsedMs }) },
        });
        return 'ok';
      }
      case 'act':
        await this.act(m, signal);
        return 'ok';
      case 'provider':
        await this.provider(m, signal);
        return 'ok';
      case 'ask_approval':
        await this.askApproval(m, signal);
        return 'ok';
      case 'ask_user':
        await this.askUser(m, signal);
        return this.broken ? 'protocol' : 'ok';
      case 'item': {
        const event = { type: 'item' as const, itemId: m.itemId, status: m.status, ...(m.data && { data: m.data }) };
        this.items.push(event);
        this.emit(event);
        return 'ok';
      }
      case 'artifact': {
        const event = { type: 'artifact' as const, path: m.path, kind: m.kind, completeness: m.completeness, ...(m.sha256 && { sha256: m.sha256 }) };
        this.artifacts.push(event);
        this.emit(event);
        return 'ok';
      }
      case 'unit_started':
        this.emit({ type: 'unit', unit: m.unit, unitAttemptId: m.unitAttemptId, phase: 'started' });
        return 'ok';
      case 'unit_finished':
        this.emit({ type: 'unit', unit: m.unit, unitAttemptId: m.unitAttemptId, phase: 'finished', ok: m.ok });
        return 'ok';
      case 'heartbeat':
        board?.reportAgent(this.runId, m.seq, m.state, m.summary);
        this.emit({ type: 'heartbeat', state: m.state, ...(m.summary !== undefined && { summary: m.summary }) });
        return 'ok';
      case 'task_finished':
      case 'task_failed':
        this.terminal = m;
        this.finished = true;
        return 'finished';
      case 'create_task':
      case 'agent_stopped':
        // Resident-only messages from a task-mode agent.
        return this.breakWith();
    }
  }

  private breakWith(): Verdict {
    this.broken = true;
    return 'protocol';
  }

  private session(app: string): Session | undefined {
    return this.options.spec.applications.some((a) => a.bundleId === app) ? this.options.sessions.get(app) : undefined;
  }

  private async observe(session: Session, opts: ObserveOptions, signal: AbortSignal): Promise<Observation | undefined> {
    try {
      return await session.observe(opts, signal);
    } catch {
      // The window is gone or the run is stopping; the caller ends the task either way.
      return undefined;
    }
  }

  private async act(m: Extract<AgentMessage, { type: 'act' }>, signal: AbortSignal): Promise<void> {
    const o = this.options;
    const now = this.clock.now();
    const effect = m.action.effect;
    const accountKey = o.account.accountKey;
    const limited = effectiveLimit(effect, o.spec, o.ceilings ?? {});
    const uses =
      limited.perDay !== undefined || limited.minIntervalMs !== undefined
        ? await o.ledger.uses({ application: m.app, accountKey, effect, since: new Date(now.getTime() - LIMIT_WINDOW_MS).toISOString() })
        : [];
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
      unknownTargets: this.unknownTargets,
      approvals: this.approvals,
    });
    const audit = (decision: AuditRecord['decision'], extra: Partial<AuditRecord>) => {
      if (effect !== 'external-submit') return;
      this.emit({
        type: 'audit',
        record: {
          at: now.toISOString(),
          agentId: o.spec.id,
          taskId: o.task.taskId,
          requestId: m.requestId,
          application: m.app,
          accountKey,
          effect,
          ...(m.target !== undefined && { target: m.target }),
          decision,
          ...extra,
        },
      });
    };
    const entry: HostedAction = { requestId: m.requestId, app: m.app, action: m.action, ...(m.target !== undefined && { target: m.target }) };
    this.actions.push(entry);
    if (refusal) {
      entry.refusal = refusal;
      audit('refused', { reason: refusal.reason });
      this.send({ type: 'action_result', taskId: o.task.taskId, requestId: m.requestId, refusal });
      return;
    }

    if (m.approvalId !== undefined) {
      const approval = this.approvals.get(m.approvalId);
      if (approval) approval.used = true;
    }
    const session = this.options.sessions.get(m.app)!;
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
    if (effect === 'external-submit' && result.status === 'unknown') this.unknownTargets.add(m.target ?? '*');
    if (limited.perDay !== undefined || limited.minIntervalMs !== undefined)
      await o.ledger.record({
        agentId: o.spec.id,
        taskId: o.task.taskId,
        application: m.app,
        accountKey,
        effect,
        at: now.toISOString(),
        ...(m.target !== undefined && { target: m.target }),
        status: result.status,
      });
    audit('allowed', { result: result.status });
    this.send({ type: 'action_result', taskId: o.task.taskId, requestId: m.requestId, result });
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
          taskId: o.task.taskId,
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
      const answer = await o.providers.call({ agentId: o.spec.id, taskId: o.task.taskId, providerId: m.providerId, purpose: m.purpose, input: m.input }, signal);
      await record(true, answer.usage, answer.model);
      this.send({ ...base, ok: true, output: answer.output, ...(answer.usage && { usage: answer.usage }) });
    } catch (error) {
      await record(false);
      if (signal.aborted) return;
      const unavailable = isRuntimeError(error, 'model_unavailable');
      this.send({ ...base, ok: false, reason: unavailable ? 'provider_unavailable' : 'error', message: unavailable ? 'the provider is unavailable' : 'the provider call failed' });
    }
  }

  private async askApproval(m: Extract<AgentMessage, { type: 'ask_approval' }>, signal: AbortSignal): Promise<void> {
    const o = this.options;
    const app = m.app ?? o.spec.applications[0]!.bundleId;
    if (this.approvals.has(m.approvalId)) {
      this.send({ type: 'deny', taskId: o.task.taskId, approvalId: m.approvalId, guidance: { text: 'approvalId was already used', hints: ['not_now'] } });
      return;
    }
    const record = { effect: m.effect, app, ...(m.target !== undefined && { target: m.target }), granted: false, used: false };
    this.approvals.set(m.approvalId, record);
    const now = this.clock.now();
    const limit = effectiveLimit(m.effect, o.spec, o.ceilings ?? {});
    const uses = await o.ledger.uses({ application: app, accountKey: o.account.accountKey, effect: m.effect, since: new Date(now.getTime() - LIMIT_WINDOW_MS).toISOString() });
    const last = uses.length ? Math.max(...uses.map((u) => Date.parse(u.at))) : undefined;
    const request: ApprovalRequest = {
      agentId: o.spec.id,
      taskId: o.task.taskId,
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
        targetHadUnknownResult: this.unknownTargets.has('*') || this.unknownTargets.has(m.target ?? '*'),
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
    this.emit({ type: 'approval', request, decision });
    if (decision.decision === 'grant') {
      record.granted = true;
      this.send({ type: 'grant', taskId: o.task.taskId, approvalId: m.approvalId });
    } else this.send({ type: 'deny', taskId: o.task.taskId, approvalId: m.approvalId, ...(decision.guidance && { guidance: decision.guidance }) });
  }

  private async askUser(m: Extract<AgentMessage, { type: 'ask_user' }>, signal: AbortSignal): Promise<void> {
    const o = this.options;
    if (m.questionId === undefined) {
      const id = `note:${m.seq}`;
      o.status?.block(this.runId, { kind: 'input', id, message: m.message });
      this.openNote = id;
      this.emit({ type: 'ask_user', reason: m.reason, message: m.message });
      return;
    }
    if (this.askedQuestions.has(m.questionId)) {
      // One answer per question id; asking again under the same id is a protocol slip.
      this.broken = true;
      return;
    }
    this.askedQuestions.add(m.questionId);
    o.status?.block(this.runId, { kind: 'input', id: m.questionId, message: m.message });
    this.emit({ type: 'ask_user', reason: m.reason, message: m.message, questionId: m.questionId });
    if (!o.asker) return; // Stays blocked; cancel or the timeout ends it.
    let answer: string | undefined;
    try {
      // Ask again, up to three times, until the answer is one of the choices offered.
      for (let attempt = 0; attempt < 3 && answer === undefined; attempt++) {
        const given = await o.asker.ask(
          { agentId: o.spec.id, taskId: o.task.taskId, questionId: m.questionId, reason: m.reason, message: m.message, ...(m.choices && { choices: m.choices }) },
          signal,
        );
        if (!m.choices || m.choices.includes(given)) answer = given;
      }
    } catch {
      return; // Cancelled, or the asker failed: the run is stopping or stays blocked.
    }
    if (answer === undefined) return;
    o.status?.unblock(this.runId, m.questionId);
    this.emit({ type: 'ask_user', reason: m.reason, message: m.message, questionId: m.questionId, answer });
    this.send({ type: 'user_answer', taskId: o.task.taskId, questionId: m.questionId, answer });
  }

  outcome(exitCode: number | null, stopped?: AgentTaskFailure): AgentTaskOutcome {
    const base = { actions: this.actions, items: this.items, artifacts: this.artifacts, exitCode };
    const failure = stopped ?? this.stopReason ?? (this.broken ? 'protocol' : undefined);
    if (failure) return { status: 'failed', failure, ...base };
    const t = this.terminal;
    if (!t) return { status: 'failed', failure: 'exited', ...base };
    if (t.type === 'task_failed') {
      const reason: AgentTaskFailure = t.reason === 'cancelled' ? 'cancelled' : t.reason === 'timeout' ? 'timeout' : t.reason;
      return { status: 'failed', failure: reason, message: t.message, ...base };
    }
    if (exitCode !== 0) return { status: 'failed', failure: 'error', message: `the agent exited with ${exitCode} after finishing`, ...base };
    return { status: t.status, ...(t.terminationReason && { terminationReason: t.terminationReason }), ...base };
  }
}
