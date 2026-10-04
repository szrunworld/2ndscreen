// The task loop against a synthetic list app: a real ledger in a temp
// SQLite file, a real artifact store in a temp output dir, the real
// procedure engine, learner and recovery, and fakes for the screen (session),
// the BOSS workflow and the exploration bridge. Nothing here touches a real
// desktop, BOSS直聘 or a model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  RuntimeError,
  emptyUsage,
  throwIfAborted,
  type AccountScope,
  type Action,
  type ActionRequest,
  type ActionResult,
  type ActorGrant,
  type BossPageClass,
  type BossUnitName,
  type BossWorkflow,
  type CandidateListing,
  type CandidateRef,
  type CheckResult,
  type Condition,
  type ExplorationOutcome,
  type ExplorationRequest,
  type ExplorerBridge,
  type BridgeEvent,
  type IdentityMatch,
  type Locator,
  type Observation,
  type ObserveOptions,
  type ProcedureV2,
  type Session,
  type SessionManager,
  type TaskSpec,
  type TaskStore,
  type UIElement,
  type UnitContext,
  type UnitDefinition,
  type UnitRunResult,
  type WaitSpec,
  type WindowBinding,
  type WindowProfile,
  type ExecutedStep,
} from '../src/contracts.ts';
import { openTaskStore } from '../src/store.ts';
import { createArtifactStore, type MediaInspector } from '../src/artifacts.ts';
import { createProcedureEngine } from '../src/procedures.ts';
import { createLearner } from '../src/learning.ts';
import { createRecovery } from '../src/recovery.ts';
import { createTaskRunner, RUNNER_LIMITS } from '../src/runner.ts';
import { createTelemetryHub } from '../src/telemetry.ts';

// ---------------------------------------------------------------------------
// fixtures

const SPEC: TaskSpec = {
  schemaVersion: 1,
  id: 'boss.collect-resumes',
  version: '1.0.0',
  platforms: ['macos'],
  application: 'com.zhipin.www',
  windowProfile: 'boss-macos-1440x900',
  workflow: 'boss-resumes-v1',
  inputSchema: 'collect-resumes-input-v1',
  capabilities: ['ui.read'],
  submitAllowed: false,
  foregroundAllowed: false,
  learning: { promoteAfterSuccesses: 3 },
  defaults: { captureMode: 'available', analysis: 'off' },
};

const PROFILE: WindowProfile = { id: 'boss-macos-1440x900', version: 1, logicalWidth: 1440, logicalHeight: 900, bundleId: 'com.zhipin.www', appVersion: '5.0.0' };

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}

/** A valid RGB PNG whose pixels depend on `seed`, so each candidate's file is distinct. */
function png(seed: number, width = 6, height = 4): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, (seed * 7 + y) % 256)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inspector: MediaInspector = {
  inspect: async () => {
    throw new Error('no PDF or JPEG in these tests');
  },
  parseXml: async () => ({ ok: false, problem: 'no XML in these tests' }),
};

// ---------------------------------------------------------------------------
// a synthetic candidate list app

interface Person {
  name: string;
  summary: string;
  /** How the online capture ends; default complete. */
  capture?: 'complete' | 'partial';
  /** Opening the resume shows the request-resume confirm instead. */
  dialog?: boolean;
  weak?: boolean;
}

type Page = 'list' | 'detail' | 'resume' | 'login' | 'dialog';

class World {
  people: Person[];
  page: Page = 'list';
  opened = -1;
  offset = 0;
  pageSize = 4;
  /** The resume link's label for person i; a change models a new app version. */
  linkLabel: (index: number) => string = () => '在线简历';
  endConfirmable = true;
  /** Actions delivered, in order, by whom. */
  actions: Array<{ seq: number; by: 'runtime' | 'bridge'; label: string }> = [];
  acquired = new Map<string, number>();
  /** Makes a runtime click hang until its signal fires, when it returns true. */
  hangWhen?: (element: UIElement) => boolean;
  hanging?: () => void;
  account?: AccountScope;
  /** Lifecycle marks in the order they happened: bridge exits, session closes. */
  order: string[] = [];

  constructor(people: Person[]) {
    this.people = people;
  }

  visible(): Person[] {
    return this.people.slice(this.offset, this.offset + this.pageSize);
  }

  elements(): UIElement[] {
    const out: Array<Omit<UIElement, 'index'>> = [];
    if (this.page !== 'login') for (const p of this.visible()) out.push({ role: 'AXRow', label: p.name });
    const person = this.people[this.opened];
    if (person && (this.page === 'detail' || this.page === 'resume')) out.push({ role: 'AXStaticText', label: `header:${person.name}` });
    if (person && this.page === 'detail') out.push({ role: 'AXLink', label: this.linkLabel(this.opened) });
    if (this.page === 'resume' || this.page === 'dialog') out.push({ role: 'AXButton', label: '关闭' });
    return out.map((e, index) => ({ ...e, index }));
  }

  text(): string {
    return [`page:${this.page}`, ...this.elements().map((e) => e.label ?? '')].join('\n');
  }

  /** Applies a click on an element of the current screen; false if nothing matched. */
  click(element: UIElement, by: 'runtime' | 'bridge'): void {
    const label = element.label ?? '';
    this.actions.push({ seq: this.actions.length + 1, by, label });
    if (element.role === 'AXRow') {
      this.opened = this.people.findIndex((p) => p.name === label);
      this.page = 'detail';
    } else if (element.role === 'AXLink') {
      this.page = this.people[this.opened]?.dialog ? 'dialog' : 'resume';
    } else if (element.role === 'AXButton' && label === '关闭' && this.opened >= 0) {
      this.page = 'detail';
    }
  }

  scroll(by: 'runtime' | 'bridge'): void {
    this.actions.push({ seq: this.actions.length + 1, by, label: 'scroll' });
    if (this.offset + this.pageSize < this.people.length) this.offset += this.pageSize;
  }
}

const people = (n: number, over: Record<number, Partial<Person>> = {}): Person[] =>
  Array.from({ length: n }, (_, i) => ({ name: `候选人${String(i).padStart(2, '0')}`, summary: `经历${i}`, ...over[i] }));

function matches(locator: Locator, e: UIElement): boolean {
  if (locator.kind !== 'element') return false;
  if (locator.role && e.role !== locator.role) return false;
  if (locator.label !== undefined && e.label !== locator.label) return false;
  if (locator.labelPattern !== undefined && !new RegExp(locator.labelPattern).test(e.label ?? '')) return false;
  return true;
}

function evaluate(condition: Condition, o: Observation): boolean {
  const text = o.text ?? '';
  switch (condition.kind) {
    case 'page':
      return text.includes(`page:${condition.pageClass}`);
    case 'text':
      return new RegExp(condition.pattern).test(text) === condition.present;
    case 'element':
      return (o.elements ?? []).filter((e) => matches(condition.locator, e)).length === 1 === condition.present;
    case 'window':
      return condition.present;
    case 'file':
      return existsSync(condition.path);
    case 'all':
      return condition.conditions.every((c) => evaluate(c, o));
    case 'any':
      return condition.conditions.some((c) => evaluate(c, o));
  }
}

const BINDING: WindowBinding = {
  screenId: 'boss',
  socket: '/tmp/fake.sock',
  launchedByRuntime: true,
  window: {
    pid: 4242,
    windowId: 77,
    bundleId: 'com.zhipin.www',
    title: 'BOSS直聘',
    frame: { x: 0, y: 0, width: 1440, height: 900 },
    contentFrame: { x: 0, y: 0, width: 1440, height: 900 },
    scale: 2,
    displayId: 1,
  },
};

class FakeSession implements Session {
  readonly id = 'session-1';
  readonly taskId: string;
  readonly profile = PROFILE;
  readonly lease = { leaseId: 'lease-1', scopeKey: 'com.zhipin.www:*', holder: 'runtime' as const, ownerPid: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
  closed = false;
  /** World.actions.length when close() finished. */
  actionsAtClose = -1;
  private granted = false;
  private snapshot = 0;
  private inFlight: Promise<unknown> = Promise.resolve();
  private readonly world: World;

  constructor(world: World, taskId: string) {
    this.world = world;
    this.taskId = taskId;
  }

  binding(): WindowBinding {
    return BINDING;
  }

  async observe(_options?: ObserveOptions, signal?: AbortSignal): Promise<Observation> {
    throwIfAborted(signal);
    if (this.closed) throw new RuntimeError('io', 'session closed');
    return {
      snapshotId: `snap-${++this.snapshot}`,
      sessionId: this.id,
      takenAt: new Date().toISOString(),
      window: BINDING.window,
      elements: this.world.elements(),
      text: this.world.text(),
    };
  }

  act(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    const run = this.deliver(request, signal);
    this.inFlight = run.catch(() => undefined);
    return run;
  }

  private async deliver(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    throwIfAborted(signal);
    if (this.closed) throw new RuntimeError('io', 'session closed');
    if (this.granted) throw new RuntimeError('actor_busy', 'the bridge holds the window');
    const startedAt = new Date().toISOString();
    const result = (status: ActionResult['status'], error?: ActionResult['error']): ActionResult => ({
      actionId: request.actionId,
      status,
      route: 'element',
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    });
    const action = request.action;
    if (action.kind === 'scroll') {
      this.world.scroll('runtime');
      return result('ok');
    }
    if (action.kind !== 'click') return result('failed', { code: 'invalid_input', message: 'only clicks and scrolls here' });
    const found = this.world.elements().filter((e) => matches(action.target, e));
    if (found.length !== 1) return result('failed', { code: found.length ? 'conflict' : 'not_found', message: `${found.length} elements match` });
    const element = found[0]!;
    if (this.world.hangWhen?.(element)) {
      this.world.hanging?.();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => setTimeout(resolve, 30), { once: true });
      });
      throw new RuntimeError('cancelled', 'the operation was cancelled');
    }
    this.world.click(element, 'runtime');
    return result('ok');
  }

  async check(condition: Condition, observation: Observation): Promise<CheckResult> {
    const ok = evaluate(condition, observation);
    return { ok, snapshotId: observation.snapshotId, evidence: [`${condition.kind} ${ok ? 'holds' : 'fails'}`] };
  }

  async waitFor(spec: WaitSpec, signal?: AbortSignal): Promise<CheckResult> {
    const o = await this.observe({}, signal);
    return { ...(await this.check(spec.condition, o)), elapsedMs: 0 };
  }

  async rebind(): Promise<WindowBinding> {
    return BINDING;
  }

  async withExclusiveActor<T>(holder: ActorGrant['holder'], fn: (grant: ActorGrant) => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    this.granted = true;
    try {
      return await fn({ holder, binding: BINDING, signal: signal ?? new AbortController().signal });
    } finally {
      this.granted = false;
    }
  }

  async close(): Promise<void> {
    await this.inFlight;
    this.world.order.push('session_closed');
    this.closed = true;
    this.actionsAtClose = this.world.actions.length;
  }
}

class FakeSessions implements SessionManager {
  opened: FakeSession[] = [];
  failWith?: RuntimeError;
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  async open(request: { taskId: string }): Promise<Session> {
    if (this.failWith) throw this.failWith;
    const session = new FakeSession(this.world, request.taskId);
    this.opened.push(session);
    return session;
  }
}

// ---------------------------------------------------------------------------
// the workflow's business knowledge, for the synthetic app

const text = (pattern: string, present = true): Condition => ({ kind: 'text', pattern, present });

const UNITS: Record<BossUnitName, UnitDefinition> = {
  select_source: { name: 'select_source', goal: '选择职位 {{job}}', allowedEffects: ['read', 'navigation'], preconditions: [], postconditions: [], learnable: false, timeoutMs: 5_000 },
  enumerate_candidates: { name: 'enumerate_candidates', goal: '读取列表', allowedEffects: ['read'], preconditions: [], postconditions: [], learnable: false, timeoutMs: 5_000 },
  open_candidate: {
    name: 'open_candidate',
    goal: '打开 {{candidate.name}}',
    allowedEffects: ['read', 'navigation'],
    preconditions: [],
    postconditions: [text('page:detail'), text('header:{{candidate.name}}')],
    learnable: true,
    timeoutMs: 5_000,
  },
  open_resume: {
    name: 'open_resume',
    goal: '打开 {{candidate.name}} 的在线简历',
    allowedEffects: ['read', 'navigation'],
    preconditions: [],
    postconditions: [text('page:resume'), text('header:{{candidate.name}}')],
    learnable: true,
    timeoutMs: 5_000,
  },
  acquire_resume: { name: 'acquire_resume', goal: '保存简历', allowedEffects: ['read', 'navigation', 'artifact'], preconditions: [], postconditions: [], learnable: false, timeoutMs: 5_000 },
  persist_candidate: { name: 'persist_candidate', goal: '归档', allowedEffects: ['artifact'], preconditions: [], postconditions: [], learnable: false, timeoutMs: 5_000 },
  return_to_list: {
    name: 'return_to_list',
    goal: '回到列表',
    allowedEffects: ['read', 'navigation'],
    preconditions: [],
    postconditions: [text('page:resume', false), text('page:dialog', false)],
    learnable: true,
    timeoutMs: 5_000,
  },
  advance_list: { name: 'advance_list', goal: '下一屏', allowedEffects: ['read'], preconditions: [], postconditions: [], learnable: false, timeoutMs: 5_000 },
};

const COMPLETE = { pages: 3, topConfirmed: true, bottomSignals: ['scroll_position_end', 'end_marker'] as Array<'scroll_position_end' | 'end_marker'>, stop: 'bottom_confirmed' as const };
const PARTIAL = { pages: 12, topConfirmed: true, bottomSignals: [] as Array<'end_marker'>, stop: 'page_limit' as const };

function fakeWorkflow(world: World, noScripted: readonly BossUnitName[] = []): BossWorkflow & { scripted: string[] } {
  const scripted: string[] = [];
  const page = (o: Observation): BossPageClass => {
    const t = o.text ?? '';
    if (t.includes('page:login')) return 'login';
    if (t.includes('page:dialog')) return 'request_resume_dialog';
    if (t.includes('page:resume')) return 'online_resume';
    if (t.includes('page:detail')) return 'conversation_detail';
    return 'conversation_list';
  };
  const header = (o: Observation) => (o.elements ?? []).find((e) => e.label?.startsWith('header:'))?.label?.slice('header:'.length);
  const run = async (context: UnitContext, step: () => void, executed: ExecutedStep[] = []): Promise<Observation> => {
    throwIfAborted(context.signal);
    step();
    return context.session.observe({ elements: true }, context.signal);
  };
  const clickBy = async (context: UnitContext, locator: Locator, effect: Action['effect'] = 'navigation'): Promise<ActionResult> =>
    context.session.act({ actionId: `a-${Math.random()}`, action: { kind: 'click', target: locator, effect } }, context.signal);
  const result = (ok: boolean, observation: Observation, reason?: string): UnitRunResult => ({ ok, executed: [], observation, ...(reason ? { reason } : {}) });

  return {
    id: 'boss-resumes-v1',
    units: UNITS,
    scripted,
    classifyPage: page,
    readAccount: () => world.account,
    listCandidates(observation, account): CandidateListing {
      const rows = (observation.elements ?? []).filter((e) => e.role === 'AXRow');
      const candidates: CandidateRef[] = rows.map((r) => ({ sourceRef: `row:${r.label}`, name: r.label!, jobTitle: '前端工程师', hints: [], snapshotId: observation.snapshotId }));
      return { candidates, fingerprint: sha(account.accountKey + rows.map((r) => r.label).join('|')), endReached: false, snapshotId: observation.snapshotId };
    },
    identify(observation, ref, account): IdentityMatch {
      const seen = header(observation);
      if (seen !== ref.name) return { kind: 'mismatch', expected: sha(ref.name).slice(0, 8), seen: sha(seen ?? '').slice(0, 8) };
      const person = world.people.find((p) => p.name === ref.name)!;
      return {
        kind: 'match',
        identity: {
          candidateId: `c-${sha(person.name).slice(0, 24)}`,
          accountKey: account.accountKey,
          fingerprint: sha(`${account.accountKey}|${person.name}|${person.summary}`),
          confidence: person.weak ? 'weak' : 'strong',
          evidence: ['name', person.weak ? 'confidence weak' : 'summary'],
        },
      };
    },
    async verifyUnit(unit, context, observation): Promise<CheckResult> {
      const name = context.candidate?.name ?? context.item?.ref.name;
      let ok: boolean;
      switch (unit) {
        case 'open_candidate':
          ok = page(observation) === 'conversation_detail' && header(observation) === name;
          break;
        case 'open_resume':
          ok = page(observation) === 'online_resume' && header(observation) === name;
          break;
        case 'return_to_list':
          ok = page(observation) !== 'online_resume';
          break;
        case 'acquire_resume':
          ok = !!context.staging && readdirSync(context.staging.dir).some((f) => f.endsWith('.png'));
          break;
        case 'persist_candidate':
          ok = context.item?.status === 'committed';
          break;
        default:
          ok = page(observation) !== 'login';
      }
      return { ok, snapshotId: observation.snapshotId, evidence: [`${unit} ${ok ? 'verified' : 'not verified'}`] };
    },
    runScripted(unit, context) {
      if (noScripted.includes(unit)) return undefined;
      scripted.push(unit);
      switch (unit) {
        case 'select_source':
          return (async () => {
            const o = await run(context, () => {
              if (world.page === 'resume' || world.page === 'dialog') world.page = 'detail';
            });
            return page(o) === 'login' ? result(false, o, 'login_required') : result(true, o);
          })();
        case 'enumerate_candidates':
          return run(context, () => undefined).then((o) => result(true, o));
        case 'open_candidate':
          return (async () => {
            const r = await clickBy(context, { kind: 'element', role: 'AXRow', label: context.candidate!.name });
            const o = await context.session.observe({ elements: true }, context.signal);
            return r.status === 'ok' ? result(true, o) : result(false, o, 'candidate_not_in_list');
          })();
        case 'open_resume':
          return (async () => {
            await clickBy(context, { kind: 'element', role: 'AXLink', label: '在线简历' });
            const o = await context.session.observe({ elements: true }, context.signal);
            const person = world.people[world.opened];
            if (person?.dialog) return result(false, o, 'request_dialog');
            return result(page(o) === 'online_resume', o, page(o) === 'online_resume' ? undefined : 'resume_not_open');
          })();
        case 'return_to_list':
          return (async () => {
            if (world.page === 'resume' || world.page === 'dialog') await clickBy(context, { kind: 'element', role: 'AXButton', label: '关闭' });
            const o = await context.session.observe({ elements: true }, context.signal);
            return result(page(o) !== 'online_resume', o);
          })();
        case 'advance_list':
          return (async () => {
            const end = world.offset + world.pageSize >= world.people.length;
            if (!end) await context.session.act({ actionId: 'scroll', action: { kind: 'scroll', direction: 'down', effect: 'read' } }, context.signal);
            const o = await context.session.observe({ elements: true }, context.signal);
            if (!end) return result(true, o);
            return world.endConfirmable ? result(true, o, 'end_reached') : result(false, o, 'list_end_unconfirmed');
          })();
        default:
          return undefined;
      }
    },
    async acquireResume(context, _mode) {
      throwIfAborted(context.signal);
      const name = context.item!.ref.name;
      const index = world.people.findIndex((p) => p.name === name);
      const person = world.people[index]!;
      if (world.page !== 'resume' || world.people[world.opened]?.name !== name) return { status: 'failed', reason: 'resume_not_open' };
      world.acquired.set(name, (world.acquired.get(name) ?? 0) + 1);
      const path = join(context.staging!.dir, 'resume.png');
      writeFileSync(path, png(index));
      return { status: 'acquired', branch: 'online', artifacts: [{ itemId: context.item!.id, kind: 'captured_image', path, capture: person.capture === 'partial' ? PARTIAL : COMPLETE }] };
    },
  };
}

// ---------------------------------------------------------------------------
// the exploration bridge, standing in for the Swift agent

class FakeBridge implements ExplorerBridge {
  requests: ExplorationRequest[] = [];
  /** Wait for the grant's signal, then take a while to exit, as a stopped child process does. */
  hang = false;
  started?: () => void;
  private readonly world: World;
  private readonly tokens: { input: number | 'unknown'; output: number | 'unknown' };

  constructor(world: World, tokens: { input: number | 'unknown'; output: number | 'unknown' } = { input: 1200, output: 'unknown' }) {
    this.world = world;
    this.tokens = tokens;
  }

  async explore(request: ExplorationRequest, grant: ActorGrant, onEvent?: (event: BridgeEvent) => void): Promise<ExplorationOutcome> {
    throwIfAborted(grant.signal);
    this.requests.push(request);
    const base = { v: 1 as const, taskId: request.taskId, unitAttemptId: request.unitAttemptId, at: new Date().toISOString() };
    // As the A5 bridge does without a usageContext: purpose ui, reason missing_procedure.
    onEvent?.({ ...base, type: 'model_usage', purpose: request.usageContext?.purpose ?? 'ui', reason: request.usageContext?.reason ?? 'missing_procedure', inputTokens: this.tokens.input, outputTokens: this.tokens.output });
    if (this.hang) {
      this.started?.();
      await new Promise<void>((resolve) => grant.signal.addEventListener('abort', () => setTimeout(resolve, 80), { once: true }));
      this.world.order.push('bridge_exited');
      return { status: 'failed', failure: 'cancelled', executed: [], modelCalls: 1, inputTokens: this.tokens.input, outputTokens: this.tokens.output };
    }
    const link = this.world.elements().find((e) => e.role === 'AXLink');
    const executed: ExecutedStep[] = [];
    if (link) {
      const action: Action = { kind: 'click', target: { kind: 'element', role: 'AXLink', label: link.label! }, effect: 'navigation' };
      this.world.click(link, 'bridge');
      const result: ActionResult = { actionId: 'b1', status: 'ok', route: 'element', startedAt: base.at, finishedAt: new Date().toISOString() };
      onEvent?.({ ...base, type: 'action_finished', stepId: 'b1', action, result });
      executed.push({ stepId: 'b1', action, result, resolvedElement: { role: link.role, label: link.label! }, executedBy: 'bridge' });
    }
    onEvent?.({ ...base, type: 'unit_finished', steps: executed.length });
    return { status: 'finished', executed, modelCalls: 1, inputTokens: this.tokens.input, outputTokens: this.tokens.output };
  }
}

// ---------------------------------------------------------------------------
// harness

function stableProcedure(unit: BossUnitName, steps: ProcedureV2['steps'], parameters: string[], postconditions: Condition[]): ProcedureV2 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: `seed-${unit}`,
    key: { skill: SPEC.id, skillVersion: SPEC.version, unit, platform: 'macos', appVersion: PROFILE.appVersion!, profile: PROFILE.id },
    version: 1,
    status: 'stable',
    source: 'seed',
    parameters,
    preconditions: [],
    postconditions,
    steps,
    counters: { successes: 0, failures: 0, successItemIds: [], consecutiveFailures: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

async function seedStable(store: TaskStore): Promise<void> {
  await store.insertProcedure(
    stableProcedure('open_candidate', [{ id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXRow', label: '{{candidate.name}}' }, effect: 'navigation' } }], ['candidate.name'], UNITS.open_candidate.postconditions),
  );
  await store.insertProcedure(
    stableProcedure('open_resume', [{ id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXLink', label: '在线简历' }, effect: 'navigation' } }], ['candidate.name'], UNITS.open_resume.postconditions),
  );
  await store.insertProcedure(
    stableProcedure('return_to_list', [{ id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '关闭' }, effect: 'navigation' } }], [], UNITS.return_to_list.postconditions),
  );
}

interface Harness {
  dir: string;
  dbPath: string;
  store: TaskStore;
  world: World;
  sessions: FakeSessions;
  workflow: ReturnType<typeof fakeWorkflow>;
  hub: ReturnType<typeof createTelemetryHub>;
  explorerCalls: number;
  bridge?: FakeBridge;
  runner: ReturnType<typeof createTaskRunner>;
  /** Builds a fresh runner (and recovery) over `store`, as a restarted worker would. */
  rebuild(options?: { store?: TaskStore; explorer?: 'unavailable' | FakeBridge }): void;
  submit(input?: Partial<Parameters<TaskStore['createTask']>[1]>): Promise<string>;
  cleanup(): Promise<void>;
}

const ACCOUNT: AccountScope = { platform: 'boss', accountKey: 'acct-test', binding: 'explicit' };

async function harness(
  world: World,
  options: { explorer?: 'unavailable' | FakeBridge; stable?: boolean; noScripted?: BossUnitName[]; resolveAccount?: AccountScope | null } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const dbPath = join(dir, 'tasks.db');
  const store = await openTaskStore({ path: dbPath });
  if (options.stable !== false) await seedStable(store);
  const h: Harness = {
    dir,
    dbPath,
    store,
    world,
    sessions: new FakeSessions(world),
    workflow: fakeWorkflow(world, options.noScripted),
    hub: createTelemetryHub(),
    explorerCalls: 0,
    runner: undefined as unknown as Harness['runner'],
    rebuild(opts = {}) {
      const s = opts.store ?? h.store;
      h.store = s;
      const explorer = opts.explorer ?? options.explorer ?? 'unavailable';
      h.bridge = explorer === 'unavailable' ? undefined : explorer;
      const engine = createProcedureEngine({ repository: s });
      const learner = createLearner({ repository: s });
      const recovery = createRecovery({
        engine,
        learner,
        telemetry: h.hub.shared,
        explorer: async () => {
          h.explorerCalls += 1;
          if (explorer === 'unavailable') throw new RuntimeError('model_unavailable', 'no model configured');
          return explorer;
        },
      });
      h.workflow = fakeWorkflow(world, options.noScripted);
      const account = options.resolveAccount === undefined ? ACCOUNT : options.resolveAccount;
      h.runner = createTaskRunner({
        ...(account ? { resolveAccount: () => account } : {}),
        store: s,
        sessions: h.sessions,
        artifacts: (task) => createArtifactStore({ outputDir: task.input.outputDir, taskId: task.id, inspector }),
        engine,
        learner,
        recovery,
        workflow: h.workflow,
        spec: SPEC,
        profile: PROFILE,
        telemetry: (taskId) => h.hub.forTask(taskId),
      });
    },
    async submit(input = {}) {
      const task = await h.store.createTask(SPEC, {
        job: '前端工程师',
        requestedCount: 5,
        outputDir: join(dir, 'out'),
        source: 'conversations',
        captureMode: 'available',
        ...input,
      });
      return task.id;
    },
    async cleanup() {
      await h.store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  h.rebuild();
  return h;
}

const run = (h: Harness, taskId: string, signal = new AbortController().signal) => h.runner.run(taskId, signal);

// ---------------------------------------------------------------------------
// tests

test('20 candidates on stable procedures: all committed and associated, no model and no explorer started', async () => {
  const world = new World(people(22));
  const h = await harness(world);
  try {
    const checkpoints: Array<{ unit?: string; itemId?: string }> = [];
    const realSave = h.store.saveCheckpoint.bind(h.store);
    h.store.saveCheckpoint = async (c) => {
      checkpoints.push({ unit: c.unit, itemId: c.itemId });
      return realSave(c);
    };
    const taskId = await h.submit({ requestedCount: 20 });
    const outcome = await run(h, taskId);

    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.terminationReason, 'target_reached');
    assert.equal(outcome.counts.committed, 20);
    assert.equal(outcome.usage.uiModelCalls, 0);
    assert.equal(outcome.usage.repairModelCalls, 0);
    assert.equal(outcome.usage.analysisModelCalls, 0);
    assert.equal(outcome.usage.inputTokens, 0, 'no call was made, so zero tokens is known, not guessed');
    assert.equal(outcome.usage.replayedUnits, 60, 'open_candidate, open_resume and return_to_list replayed for each');
    assert.equal(h.explorerCalls, 0, 'the explorer (and so any model client) is never created on the stable path');
    assert.deepEqual([...new Set(h.workflow.scripted)].sort(), ['advance_list', 'enumerate_candidates', 'select_source']);

    // Each committed item's file is that candidate's own file, under its own folder.
    const items = await h.store.listWorkItems(taskId, { status: ['committed'] });
    const artifacts = await h.store.listArtifacts(taskId);
    assert.equal(items.length, 20);
    for (const item of items) {
      const index = world.people.findIndex((p) => p.name === item.ref.name);
      const own = artifacts.filter((a) => a.itemId === item.id);
      assert.equal(own.length, 1);
      assert.equal(own[0]!.relativePath, `candidates/${item.identity.candidateId}/captured/resume.png`);
      assert.equal(own[0]!.sha256, sha(png(index)));
      assert.equal(item.identity.accountKey, 'acct-test');
      assert.equal(world.acquired.get(item.ref.name), 1, 'fetched exactly once');
    }
    assert.equal(world.acquired.size, 20, 'the two candidates past the target were never opened');

    const task = (await h.store.getTask(taskId))!;
    assert.deepEqual(task.account, ACCOUNT, 'bound from the explicit configuration, never invented');
    const manifest = JSON.parse(readFileSync(join(outcome.outputPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.delivered, 20);
    assert.equal(manifest.task.status, 'succeeded');

    // A checkpoint before every candidate, naming the unit about to run.
    const starts = checkpoints.filter((c) => c.unit === 'open_candidate');
    assert.ok(starts.length >= 20);
    for (const item of items) assert.ok(checkpoints.some((c) => c.unit === 'open_resume' && c.itemId === item.id));
    assert.equal((await h.store.getCheckpoint(taskId))?.lastCommittedItemId, items.at(-1)!.id);

    // The session was closed (and so the lease released) at the end.
    assert.equal(h.sessions.opened.length, 1);
    assert.ok(h.sessions.opened[0]!.closed);
  } finally {
    await h.cleanup();
  }
});

test('a page change repairs only the failing unit; the repair is learned and replayed, committed candidates are not redone', async () => {
  const world = new World(people(8));
  world.linkLabel = (i) => (i >= 3 ? '查看简历' : '在线简历');
  const bridge = new FakeBridge(world, { input: 1200, output: 'unknown' });
  const h = await harness(world, { explorer: bridge });
  try {
    const taskId = await h.submit({ requestedCount: 8 });
    const outcome = await run(h, taskId);
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.counts.committed, 8);

    // One exploration, for open_resume only, on the first changed candidate.
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0]!.unit.name, 'open_resume');
    assert.equal(bridge.requests[0]!.parameters['candidate.name'], world.people[3]!.name);
    assert.equal(world.actions.filter((a) => a.by === 'bridge').length, 1);
    // The runtime never resent what the bridge did: one click on the new link for candidate 3.
    const clicksOnNewLink = world.actions.filter((a) => a.label === '查看简历');
    assert.equal(clicksOnNewLink.length, 5, 'the bridge once for candidate 3, then replays for 4..7');
    assert.equal(clicksOnNewLink[0]!.by, 'bridge');

    for (const p of world.people) assert.equal(world.acquired.get(p.name), 1, `${p.name} fetched once`);
    assert.equal(outcome.usage.repairModelCalls, 1, 'one model call, during the repair');
    assert.equal(outcome.usage.uiModelCalls, 0, 'a repair is not counted as a ui call');
    assert.deepEqual(bridge.requests[0]!.usageContext, { purpose: 'repair', reason: 'replay_failed' });
    assert.equal(outcome.usage.inputTokens, 1200);
    assert.equal(outcome.usage.outputTokens, 'unknown', 'an unreported count stays unknown');

    // The old stable version is degraded and kept; the repair is a new version from it.
    const key = { skill: SPEC.id, skillVersion: SPEC.version, unit: 'open_resume', platform: 'macos' as const, appVersion: '5.0.0', profile: PROFILE.id };
    const versions = await h.store.listProcedures(key);
    assert.equal(versions.length, 2);
    const [repaired, old] = versions;
    assert.equal(old!.status, 'degraded');
    assert.equal(repaired!.source, 'repair');
    assert.equal(repaired!.parentVersion, 1);
    assert.equal(repaired!.status, 'stable', 'promoted after three distinct candidates in a row');
    // The other units' procedures never failed.
    for (const unit of ['open_candidate', 'return_to_list']) {
      const [only, ...rest] = await h.store.listProcedures({ ...key, unit });
      assert.equal(rest.length, 0);
      assert.equal(only!.counters.failures, 0);
    }

    // Usage persisted with the unknown count, and read back by a later run.
    h.rebuild();
    const again = await run(h, taskId);
    assert.equal(again.status, 'succeeded');
    assert.equal(again.usage.outputTokens, 'unknown');
    assert.equal(again.usage.inputTokens, 1200);
    const persisted = (await h.store.listEvents(taskId)).filter((e) => e.type === 'usage').at(-1)!;
    assert.equal(persisted.detail!.outputTokens, 'unknown');
  } finally {
    await h.cleanup();
  }
});

test('no model: the task waits for the user with model_unavailable, then resumes from the ledger without redoing work', async () => {
  const world = new World(people(5));
  world.linkLabel = (i) => (i >= 2 ? '查看简历' : '在线简历');
  const h = await harness(world, { explorer: 'unavailable' });
  try {
    const taskId = await h.submit({ requestedCount: 5 });
    const first = await run(h, taskId);
    assert.equal(first.status, 'waiting_user');
    assert.equal(first.waitReason, 'model_unavailable');
    assert.equal(first.counts.committed, 2, 'stable units kept replaying until a unit needed a model');
    assert.equal(h.explorerCalls, 1);
    const stuck = (await h.store.listWorkItems(taskId)).find((i) => i.ref.name === world.people[2]!.name)!;
    assert.equal(stuck.status, 'discovered', 'the interrupted candidate goes back to be checked again');
    assert.ok(h.sessions.opened.at(-1)!.closed);

    // A model is configured now; resume.
    const bridge = new FakeBridge(world, { input: 10, output: 20 });
    h.rebuild({ explorer: bridge });
    const second = await run(h, taskId);
    assert.equal(second.status, 'succeeded');
    assert.equal(second.counts.committed, 5);
    assert.equal(bridge.requests.length, 1);
    for (const p of world.people) assert.equal(world.acquired.get(p.name), 1, `${p.name} fetched once over both runs`);
    assert.equal(second.usage.inputTokens, 10);
    assert.equal(second.usage.outputTokens, 20);
  } finally {
    await h.cleanup();
  }
});

test('a crash between archiving and committing is reconciled from disk first; the file is never fetched again', async () => {
  const world = new World(people(5));
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 5 });
    // The process "dies" in the third commit: from then on nothing reaches the ledger.
    let commits = 0;
    let dead = false;
    const dying = new Proxy(h.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (dead) return Promise.reject(new Error('process gone'));
          if (prop === 'commitItem' && ++commits === 3) {
            dead = true;
            return Promise.reject(new Error('process gone'));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as TaskStore;
    const original = h.store;
    h.rebuild({ store: dying });
    await assert.rejects(run(h, taskId), /process gone/);
    await original.close();

    // Restart: a new connection to the same ledger file and a new runner.
    const reopened = await openTaskStore({ path: h.dbPath });
    const left = (await reopened.getTask(taskId))!;
    assert.equal(left.status, 'running', 'the dead worker could not record anything');
    const third = world.people[2]!.name;
    assert.equal((await reopened.listWorkItems(taskId)).find((i) => i.ref.name === third)!.status, 'validated');
    h.rebuild({ store: reopened });
    const outcome = await run(h, taskId);
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.counts.committed, 5);
    for (const p of world.people) assert.equal(world.acquired.get(p.name), 1, `${p.name} fetched once`);
    const events = await reopened.listEvents(taskId);
    const reconciled = events.find((e) => e.type === 'reconciled');
    assert.equal(reconciled?.detail?.adopted, 1);
    const manifest = JSON.parse(readFileSync(join(outcome.outputPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.delivered, 5);
  } finally {
    await h.cleanup();
  }
});

test('cancel: the runner stops mid-action, closes the session before returning, and acts no more', async () => {
  const world = new World(people(5));
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 5 });
    // The first candidate goes through; the second hangs in the middle of opening its resume.
    let clicks = 0;
    world.hangWhen = (e) => e.role === 'AXLink' && ++clicks === 2;
    const hanging = new Promise<void>((r) => (world.hanging = r));
    const controller = new AbortController();
    const running = run(h, taskId, controller.signal);
    await hanging;
    // What the daemon does: record the request, then fire the signal.
    await h.store.transitionTask(taskId, 'cancelling', {}, 'running');
    controller.abort();
    const outcome = await running;
    const session = h.sessions.opened[0]!;
    assert.ok(session.closed, 'closed before run() resolved');
    assert.equal(session.actionsAtClose, world.actions.length);
    const actions = world.actions.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(world.actions.length, actions, 'nothing acts after the runner returned');
    assert.equal(outcome.status, 'cancelling', 'the runner leaves the confirmation to whoever cancelled');
    const items = await h.store.listWorkItems(taskId);
    assert.ok(items.every((i) => i.status === 'committed' || i.status === 'discovered'), 'no half-done item is left processing');
  } finally {
    await h.cleanup();
  }
});

test('incomplete captures are saved as diagnostics and never counted; a short source ends partial', async () => {
  const world = new World(people(4, { 1: { capture: 'partial' }, 2: { dialog: true }, 3: { capture: 'partial' } }));
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 4 });
    const outcome = await run(h, taskId);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.terminationReason, 'source_exhausted');
    assert.equal(outcome.counts.committed, 1);
    assert.equal(outcome.counts.unavailable, 1);
    assert.equal(outcome.counts.failed, 2);
    assert.equal(outcome.counts.diagnostic, 2);
    const items = await h.store.listWorkItems(taskId);
    const partial = items.find((i) => i.ref.name === world.people[1]!.name)!;
    assert.match(partial.reason ?? '', /not_countable/);
    assert.equal(items.find((i) => i.ref.name === world.people[2]!.name)!.reason, 'request_dialog');
    const manifest = JSON.parse(readFileSync(join(outcome.outputPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.delivered, 1);
    const failures = JSON.parse(readFileSync(join(outcome.outputPath, 'failures.json'), 'utf8')).failures;
    assert.equal(failures.filter((f: { failure: string }) => f.failure === 'saved_not_counted').length, 2);
  } finally {
    await h.cleanup();
  }
});

test('an unconfirmed list end pauses after a bounded number of tries instead of looping', async () => {
  const world = new World(people(2));
  world.endConfirmable = false;
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 5 });
    const outcome = await run(h, taskId);
    assert.equal(outcome.status, 'paused');
    assert.equal(outcome.counts.committed, 2);
    const task = (await h.store.getTask(taskId))!;
    assert.match(task.error?.message ?? '', /not confirmed/);
    assert.ok(h.workflow.scripted.filter((u) => u === 'advance_list').length <= RUNNER_LIMITS.maxStalledAdvances);
    assert.notEqual(outcome.terminationReason, 'source_exhausted', 'an unproven end is not reported as exhausted');
  } finally {
    await h.cleanup();
  }
});

test('a weak identity is never archived, and the browse limit ends the task partial', async () => {
  const world = new World(people(6, { 0: { weak: true } }));
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 5, browseLimit: 5 });
    const outcome = await run(h, taskId);
    const weak = (await h.store.listWorkItems(taskId)).find((i) => i.ref.name === world.people[0]!.name)!;
    assert.equal(weak.status, 'ambiguous');
    assert.equal(weak.reason, 'identity_weak');
    assert.equal(world.acquired.get(world.people[0]!.name), undefined);
    assert.equal((await h.store.listArtifacts(taskId, weak.id)).length, 0);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.terminationReason, 'browse_limit');
    assert.equal(outcome.counts.committed, 4);
  } finally {
    await h.cleanup();
  }
});

test('another visible account, or a login page, waits for the user before any candidate is opened', async () => {
  const world = new World(people(3));
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 3 });
    await h.store.transitionTask(taskId, 'queued', { account: { platform: 'boss', accountKey: 'acct-a', binding: 'explicit' } });
    world.account = { platform: 'boss', accountKey: 'acct-b', binding: 'observed' };
    const outcome = await run(h, taskId);
    assert.equal(outcome.status, 'waiting_user');
    assert.equal(outcome.waitReason, 'account_changed');
    assert.equal(world.actions.length, 0);

    world.account = undefined;
    world.page = 'login';
    const login = await run(h, taskId);
    assert.equal(login.waitReason, 'login_required');
    assert.equal(world.actions.length, 0);
    assert.equal((await h.store.listWorkItems(taskId)).length, 0);

    world.page = 'list';
    const done = await run(h, taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(((await h.store.getTask(taskId))!.account!).accountKey, 'acct-a', 'the bound account is kept');
  } finally {
    await h.cleanup();
  }
});

test('a session that cannot be opened leaves the task resumable; the next run clears the old error', async () => {
  const world = new World(people(2));
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 2 });
    h.sessions.failWith = new RuntimeError('lease_held', 'legacy-assistant holds com.zhipin.www:*');
    const blocked = await run(h, taskId);
    assert.equal(blocked.status, 'paused');
    assert.equal((await h.store.getTask(taskId))!.error?.code, 'lease_held');

    h.sessions.failWith = new RuntimeError('permission_missing', 'accessibility not granted');
    const perm = await run(h, taskId);
    assert.equal(perm.status, 'waiting_user');
    assert.equal(perm.waitReason, 'permission_missing');

    h.sessions.failWith = undefined;
    const done = await run(h, taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal((await h.store.getTask(taskId))!.error, undefined, 'a resumed run clears the old error');
    assert.deepEqual(done.usage.uiModelCalls, emptyUsage().uiModelCalls);
  } finally {
    await h.cleanup();
  }
});

test('with no bound account and none configured the task waits for the user; an explicit binding then lets it run', async () => {
  const world = new World(people(3));
  const h = await harness(world, { resolveAccount: null });
  try {
    const taskId = await h.submit({ requestedCount: 3 });
    const waiting = await run(h, taskId);
    assert.equal(waiting.status, 'waiting_user');
    assert.equal(waiting.waitReason, 'account_changed');
    assert.match((await h.store.getTask(taskId))!.error?.message ?? '', /no BOSS account is bound/);
    assert.equal(world.actions.length, 0);
    assert.equal((await h.store.listWorkItems(taskId)).length, 0);

    // A key that would break lease scopes is refused, not used.
    await h.store.transitionTask(taskId, 'waiting_user', { account: { platform: 'boss', accountKey: 'a:b', binding: 'explicit' } });
    assert.equal((await run(h, taskId)).waitReason, 'account_changed');
    assert.equal(world.actions.length, 0);

    await h.store.transitionTask(taskId, 'waiting_user', { account: { platform: 'boss', accountKey: 'acct-7', binding: 'explicit' } });
    const done = await run(h, taskId);
    assert.equal(done.status, 'succeeded');
    assert.ok((await h.store.listWorkItems(taskId)).every((i) => i.identity.accountKey === 'acct-7'));
  } finally {
    await h.cleanup();
  }
});

test('analysis "on" is not implemented and fails clearly before anything runs', async () => {
  const world = new World(people(2));
  const h = await harness(world);
  try {
    const taskId = await h.submit({ requestedCount: 2, analysis: 'on' });
    const outcome = await run(h, taskId);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.terminationReason, 'fatal_error');
    assert.equal((await h.store.getTask(taskId))!.error?.code, 'capability_missing');
    assert.equal(h.sessions.opened.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('first candidate explores a unit with no procedure (ui/missing_procedure); the second replays the learned trial at once', async () => {
  const world = new World(people(6));
  const bridge = new FakeBridge(world, { input: 500, output: 40 });
  const h = await harness(world, { explorer: bridge, stable: false, noScripted: ['open_resume'] });
  try {
    const taskId = await h.submit({ requestedCount: 6 });
    const outcome = await run(h, taskId);
    assert.equal(outcome.status, 'succeeded');
    assert.equal(bridge.requests.length, 1, 'one exploration for the whole batch');
    assert.equal(bridge.requests[0]!.parameters['candidate.name'], world.people[0]!.name);
    assert.deepEqual(bridge.requests[0]!.usageContext, { purpose: 'ui', reason: 'missing_procedure' });
    assert.equal(outcome.usage.uiModelCalls, 1);
    assert.equal(outcome.usage.repairModelCalls, 0);
    assert.equal(outcome.usage.exploredUnits, 1);
    assert.equal(outcome.usage.replayedUnits, 5, 'candidates 2..6 replay open_resume');
    const key = { skill: SPEC.id, skillVersion: SPEC.version, unit: 'open_resume', platform: 'macos' as const, appVersion: '5.0.0', profile: PROFILE.id };
    const [learned, ...older] = await h.store.listProcedures(key);
    assert.equal(older.length, 0);
    assert.equal(learned!.source, 'learned');
    assert.equal(learned!.status, 'stable', 'three distinct candidates in a row after the first');
    assert.equal(learned!.counters.failures, 0);
    for (const p of world.people) assert.equal(world.acquired.get(p.name), 1);
    // The runtime never resent the bridge's click for candidate 1.
    assert.equal(world.actions.filter((a) => a.label === '在线简历').length, 6);
    assert.equal(world.actions.filter((a) => a.label === '在线简历' && a.by === 'bridge').length, 1);
  } finally {
    await h.cleanup();
  }
});

test('cancel during an exploration: the bridge is stopped and has exited before the session closes, and nothing acts afterwards', async () => {
  const world = new World(people(4));
  world.linkLabel = (i) => (i >= 1 ? '查看简历' : '在线简历');
  const bridge = new FakeBridge(world);
  bridge.hang = true;
  const started = new Promise<void>((r) => (bridge.started = r));
  const h = await harness(world, { explorer: bridge });
  try {
    const taskId = await h.submit({ requestedCount: 4 });
    const controller = new AbortController();
    const running = run(h, taskId, controller.signal);
    await started;
    await h.store.transitionTask(taskId, 'cancelling', {}, 'running');
    controller.abort();
    const outcome = await running;
    assert.deepEqual(world.order, ['bridge_exited', 'session_closed']);
    assert.equal(outcome.status, 'cancelling');
    assert.equal(outcome.counts.committed, 1);
    const actions = world.actions.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(world.actions.length, actions);
    const second = (await h.store.listWorkItems(taskId)).find((i) => i.ref.name === world.people[1]!.name)!;
    assert.equal(second.status, 'discovered');
    // The model call made before the cancel is still counted.
    assert.equal(outcome.usage.uiModelCalls + outcome.usage.repairModelCalls, 1);
  } finally {
    await h.cleanup();
  }
});
