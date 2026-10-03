// Synthetic fakes for the procedure, learning and recovery tests: an
// in-memory procedure repository, a tiny fake "candidate detail → online
// resume" app behind a contract Session, a counting telemetry recorder and a
// scripted exploration bridge. Nothing here touches a real desktop, BOSS直聘
// or a model.

import {
  RuntimeError,
  emptyUsage,
  procedureKeyString,
  throwIfAborted,
  type Action,
  type ActionRequest,
  type ActionResult,
  type ActionStatus,
  type ActorGrant,
  type BridgeEvent,
  type CheckResult,
  type Condition,
  type ExecutedStep,
  type ExplorationOutcome,
  type ExplorationRequest,
  type ExplorerBridge,
  type Locator,
  type ObserveOptions,
  type Observation,
  type ProcedureKey,
  type ProcedureRepository,
  type ProcedureV2,
  type Session,
  type TelemetryEvent,
  type TelemetryRecorder,
  type UnitDefinition,
  type Usage,
  type WaitSpec,
  type WindowBinding,
} from '../src/contracts.ts';

export const KEY: ProcedureKey = {
  skill: 'boss.collect-resumes',
  skillVersion: '1.0.0',
  unit: 'open_resume',
  platform: 'macos',
  appVersion: '5.0.0',
  profile: 'boss-macos-1440x900',
  branch: 'online',
};

export const UNIT: UnitDefinition = {
  name: 'open_resume',
  goal: '打开 {{candidate.name}} 的在线简历',
  allowedEffects: ['read', 'navigation'],
  preconditions: [
    { kind: 'page', pageClass: 'candidate_detail' },
    { kind: 'text', pattern: '{{candidate.name}}', present: true },
  ],
  postconditions: [
    { kind: 'page', pageClass: 'online_resume' },
    { kind: 'text', pattern: '{{candidate.name}}', present: true },
  ],
  learnable: true,
  timeoutMs: 300,
};

export const CLICK_RESUME: Action = { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' };

/** A clock tests move by hand, to cross a deadline at an exact point. */
export class FakeClock {
  t = Date.parse('2026-10-04T08:00:00Z');
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

let seq = 0;
export const newId = (): string => `id-${++seq}`;

export function procedure(over: Partial<ProcedureV2> = {}): ProcedureV2 {
  const at = '2026-10-04T08:00:00.000Z';
  return {
    schemaVersion: 2,
    id: newId(),
    key: { ...KEY },
    version: 1,
    status: 'stable',
    source: 'seed',
    parameters: ['candidate.name'],
    preconditions: structuredClone(UNIT.preconditions),
    postconditions: structuredClone(UNIT.postconditions),
    steps: [{ id: 's1', action: structuredClone(CLICK_RESUME), expect: { condition: { kind: 'page', pageClass: 'online_resume' }, timeoutMs: 300, pollMs: 50 } }],
    counters: { successes: 0, failures: 0, consecutiveFailures: 0, successItemIds: [] },
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

// ---------------------------------------------------------------------------

export class MemoryRepository implements ProcedureRepository {
  readonly rows = new Map<string, ProcedureV2>();
  inserts = 0;

  async listProcedures(key: ProcedureKey): Promise<ProcedureV2[]> {
    const k = procedureKeyString(key);
    return [...this.rows.values()].filter((p) => procedureKeyString(p.key) === k).sort((a, b) => b.version - a.version).map((p) => structuredClone(p));
  }
  async getProcedure(id: string): Promise<ProcedureV2 | undefined> {
    const p = this.rows.get(id);
    return p && structuredClone(p);
  }
  async insertProcedure(p: ProcedureV2): Promise<void> {
    const k = procedureKeyString(p.key);
    if ([...this.rows.values()].some((x) => procedureKeyString(x.key) === k && x.version === p.version))
      throw new RuntimeError('conflict', `version ${p.version} exists`);
    this.inserts += 1;
    this.rows.set(p.id, structuredClone(p));
  }
  async updateProcedureState(id: string, state: Pick<ProcedureV2, 'status' | 'counters' | 'updatedAt'>): Promise<ProcedureV2> {
    const p = this.rows.get(id);
    if (!p) throw new RuntimeError('not_found', id);
    const next = { ...p, status: state.status, counters: structuredClone(state.counters), updatedAt: state.updatedAt };
    this.rows.set(id, next);
    return structuredClone(next);
  }
  /** The definition part, to show versions are never rewritten. */
  definition(id: string): string {
    const { status: _s, counters: _c, updatedAt: _u, ...rest } = this.rows.get(id)!;
    return JSON.stringify(rest);
  }
}

// ---------------------------------------------------------------------------

interface FakeElement {
  role: string;
  label: string;
}

/** A two-page app: candidate detail with a "在线简历" button, then the online resume. */
export class FakeApp {
  page = 'candidate_detail';
  name = '';
  /** The button's current label; a UI change renames it. */
  buttonLabel = '在线简历';
  /** Observations to pass before a click's page change shows. */
  transitionDelay = 0;
  /** Make every click report this status without changing the page. */
  clickStatus?: ActionStatus;
  private pending?: { page: string; after: number };
  snapshots = 0;

  show(name: string): void {
    this.page = 'candidate_detail';
    this.name = name;
    this.pending = undefined;
  }

  elements(): FakeElement[] {
    const name = { role: 'AXStaticText', label: this.name };
    return this.page === 'candidate_detail' ? [{ role: 'AXButton', label: this.buttonLabel }, name] : [{ role: 'AXButton', label: '关闭' }, name];
  }

  tick(): void {
    if (this.pending && --this.pending.after <= 0) {
      this.page = this.pending.page;
      this.pending = undefined;
    }
  }

  find(locator: Locator | undefined): FakeElement | undefined {
    if (!locator) return undefined;
    const els = this.elements();
    switch (locator.kind) {
      case 'element':
        return els.find(
          (e) =>
            (!locator.role || e.role === locator.role) &&
            (locator.label === undefined || e.label === locator.label) &&
            (locator.labelPattern === undefined || new RegExp(locator.labelPattern).test(e.label)),
        );
      case 'relative':
        // The button sits around the middle of the content area.
        return Math.abs(locator.point.x - 0.5) < 0.1 && Math.abs(locator.point.y - 0.5) < 0.1 ? els[0] : undefined;
      default:
        return undefined;
    }
  }

  /** Perform an action as the desktop would. */
  apply(action: Action): ActionStatus {
    if (action.kind === 'scroll') return 'ok';
    if (this.clickStatus) return this.clickStatus;
    if (action.kind !== 'click') return 'no_effect';
    const target = this.find(action.target);
    if (!target) return 'failed';
    if (this.page === 'candidate_detail' && target.label === this.buttonLabel && target.role === 'AXButton') {
      if (this.transitionDelay > 0) this.pending = { page: 'online_resume', after: this.transitionDelay };
      else this.page = 'online_resume';
      return 'ok';
    }
    return 'no_effect';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeSession implements Session {
  readonly id = 'session-1';
  readonly taskId = 'task-1';
  readonly profile = { id: 'boss-macos-1440x900', version: 1, logicalWidth: 1440, logicalHeight: 900, bundleId: 'com.zhipin.www' };
  readonly lease = { leaseId: 'lease-1', scopeKey: 'com.zhipin.www:*', holder: 'runtime' as const, ownerPid: 1, expiresAt: '2026-10-04T09:00:00Z' };
  acts: ActionRequest[] = [];
  observeOptions: ObserveOptions[] = [];
  busy = false;
  /** Runs after each delivered action, e.g. to let a fake clock pass. */
  onAct?: (request: ActionRequest) => void;

  readonly app: FakeApp;
  constructor(app: FakeApp) {
    this.app = app;
  }

  binding(): WindowBinding {
    return {
      screenId: 'boss',
      socket: '/tmp/fake.sock',
      launchedByRuntime: true,
      window: {
        pid: 4242,
        windowId: 77,
        bundleId: 'com.zhipin.www',
        title: 'BOSS直聘',
        frame: { x: 0, y: 0, width: 1440, height: 900 },
        contentFrame: { x: 0, y: 28, width: 1440, height: 872 },
        scale: 2,
        displayId: 1,
      },
    };
  }

  async observe(options: ObserveOptions = {}, signal?: AbortSignal): Promise<Observation> {
    throwIfAborted(signal);
    this.observeOptions.push(options);
    this.app.tick();
    this.app.snapshots += 1;
    return {
      snapshotId: `snap-${this.app.snapshots}`,
      sessionId: this.id,
      takenAt: new Date().toISOString(),
      window: this.binding().window,
      elements: this.app.elements().map((e, index) => ({ index, ...e })),
      text: `${this.app.name} ${this.app.page}`,
      pageClass: this.app.page,
    };
  }

  async act(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    throwIfAborted(signal);
    if (this.busy) throw new RuntimeError('actor_busy', 'bridge holds the window');
    if (request.action.effect === 'external-submit') throw new RuntimeError('forbidden_effect', 'no submit');
    this.acts.push(structuredClone(request));
    const at = new Date().toISOString();
    const status = this.app.apply(request.action);
    this.onAct?.(request);
    return { actionId: request.actionId, status, route: 'element', startedAt: at, finishedAt: at };
  }

  async check(condition: Condition, observation: Observation): Promise<CheckResult> {
    const ok = evaluate(condition, observation, this.app);
    return { ok, snapshotId: observation.snapshotId, evidence: [`${condition.kind}:${ok ? 'pass' : 'fail'}`] };
  }

  async waitFor(spec: WaitSpec, signal?: AbortSignal): Promise<CheckResult> {
    const started = Date.now();
    for (;;) {
      throwIfAborted(signal);
      const observation = await this.observe({}, signal);
      const result = await this.check(spec.condition, observation);
      const elapsedMs = Date.now() - started;
      if (result.ok || elapsedMs >= spec.timeoutMs) return { ...result, elapsedMs };
      await sleep(Math.min(spec.pollMs ?? 20, 20));
    }
  }

  async rebind(): Promise<WindowBinding> {
    return this.binding();
  }

  async withExclusiveActor<T>(holder: ActorGrant['holder'], fn: (grant: ActorGrant) => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    this.busy = true;
    try {
      return await fn({ holder, binding: this.binding(), signal: signal ?? new AbortController().signal });
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {}
}

function evaluate(c: Condition, o: Observation, app: FakeApp): boolean {
  switch (c.kind) {
    case 'page':
      return o.pageClass === c.pageClass;
    case 'text':
      return new RegExp(c.pattern).test(o.text ?? '') === c.present;
    case 'element':
      return (app.find(c.locator) !== undefined) === c.present;
    case 'all':
      return c.conditions.every((x) => evaluate(x, o, app));
    case 'any':
      return c.conditions.some((x) => evaluate(x, o, app));
    default:
      return false;
  }
}

/** The local verifier the workflow would supply: online resume of the right person. */
export const verifyResume = (name: string) => async (o: Observation): Promise<CheckResult> => {
  const ok = o.pageClass === 'online_resume' && (o.text ?? '').includes(name);
  return { ok, snapshotId: o.snapshotId, evidence: ok ? ['page=online_resume', 'identity=match'] : ['page or identity differs'] };
};

// ---------------------------------------------------------------------------

export class FakeTelemetry implements TelemetryRecorder {
  events: TelemetryEvent[] = [];
  record(event: TelemetryEvent): void {
    this.events.push(event);
  }
  usage(): Usage {
    const u = emptyUsage();
    for (const e of this.events) {
      if (e.type === 'model_call') {
        if (e.purpose === 'ui') u.uiModelCalls += 1;
        else if (e.purpose === 'repair') u.repairModelCalls += 1;
        else u.analysisModelCalls += 1;
        u.inputTokens = u.inputTokens === 'unknown' || e.inputTokens === 'unknown' ? 'unknown' : u.inputTokens + e.inputTokens;
        u.outputTokens = u.outputTokens === 'unknown' || e.outputTokens === 'unknown' ? 'unknown' : u.outputTokens + e.outputTokens;
      } else if (e.type === 'unit' && e.route === 'replay' && e.ok) u.replayedUnits += 1;
      else if (e.type === 'unit' && (e.route === 'explore' || e.route === 'repair')) u.exploredUnits += 1;
      else if (e.type === 'local_recovery') u.localRecoveries += 1;
    }
    return u;
  }
  modelCalls(): number {
    return this.events.filter((e) => e.type === 'model_call').length;
  }
}

export interface BridgeScript {
  /** Model calls to report before acting. */
  calls?: number;
  inputTokens?: number | 'unknown';
  /** What the bridge clicks; default a model coordinate on the button. */
  action?: Action;
  resolvedElement?: ExecutedStep['resolvedElement'];
  /** End with unit_failed for this reason instead of acting. */
  fail?: ExplorationOutcome['failure'];
  /** Wait for the grant's signal before finishing, as a long exploration would. */
  hang?: boolean;
  /** Report more calls in the outcome than it emitted events for. */
  silentCalls?: number;
  /** Keep calling and acting after the grant is aborted, as a misbehaving bridge would. */
  ignoreAbort?: boolean;
  /** Token totals the outcome reports, whatever the events said. */
  reportTokens?: number | 'unknown';
}

/** A bridge that acts on the fake app directly, as the Swift agent would, never through the session. */
export class FakeBridge implements ExplorerBridge {
  requests: ExplorationRequest[] = [];
  readonly app: FakeApp;
  readonly scripts: BridgeScript[];
  constructor(app: FakeApp, scripts: BridgeScript[]) {
    this.app = app;
    this.scripts = scripts;
  }

  async explore(request: ExplorationRequest, grant: ActorGrant, onEvent?: (event: BridgeEvent) => void): Promise<ExplorationOutcome> {
    this.requests.push(request);
    const script = this.scripts[Math.min(this.requests.length - 1, this.scripts.length - 1)] ?? {};
    const base = { v: 1 as const, taskId: request.taskId, unitAttemptId: request.unitAttemptId, at: new Date().toISOString() };
    const calls = script.calls ?? 1;
    const tokens = script.inputTokens ?? 100;
    let input: number | 'unknown' = 0;
    let emitted = 0;
    const aborted = () => grant.signal.aborted && !script.ignoreAbort;
    for (let i = 0; i < calls; i++) {
      if (aborted()) break;
      emitted += 1;
      onEvent?.({ ...base, type: 'model_usage', purpose: 'ui', reason: 'missing_procedure', inputTokens: tokens, outputTokens: 10 });
      input = input === 'unknown' || tokens === 'unknown' ? 'unknown' : input + tokens;
    }
    const outcome = (o: Partial<ExplorationOutcome>): ExplorationOutcome => ({
      status: 'failed',
      executed: [],
      modelCalls: emitted + (script.silentCalls ?? 0),
      inputTokens: script.reportTokens ?? input,
      outputTokens: script.reportTokens ?? emitted * 10,
      ...o,
    });
    if (script.hang) {
      await new Promise<void>((resolve) => {
        if (grant.signal.aborted) resolve();
        grant.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return outcome({ failure: 'cancelled' });
    }
    if (aborted()) return outcome({ failure: 'cancelled' });
    if (script.fail) return outcome({ failure: script.fail });
    const action = script.action ?? { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.5 } }, effect: 'navigation' };
    onEvent?.({ ...base, type: 'action_started', stepId: 'b1', action });
    const before = this.app.page;
    const status = this.app.apply(action);
    this.app.tick();
    const result: ActionResult = { actionId: 'b1', status, route: 'coordinate', startedAt: base.at, finishedAt: base.at };
    const resolvedElement = script.resolvedElement ?? { role: 'AXButton', label: this.app.buttonLabel };
    onEvent?.({ ...base, type: 'action_finished', stepId: 'b1', action, result, resolvedElement });
    onEvent?.({ ...base, type: 'unit_finished', steps: 1 });
    return outcome({
      status: 'finished',
      executed: [{ stepId: 'b1', action, result, resolvedElement, before: { snapshotId: 'b-before', pageClass: before }, after: { snapshotId: 'b-after', pageClass: this.app.page }, executedBy: 'bridge' }],
    });
  }
}
