import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGET,
  RuntimeError,
  emptyUsage,
  isRuntimeError,
  type Budget,
  type ExplorerProvider,
  type ProcedureV2,
  type RecoveryContext,
  type ReplayResult,
  type Usage,
} from '../src/contracts.ts';
import { createLearner } from '../src/learning.ts';
import { createProcedureEngine } from '../src/procedures.ts';
import { createRecovery } from '../src/recovery.ts';
import { FakeApp, FakeBridge, FakeClock, FakeSession, FakeTelemetry, KEY, MemoryRepository, UNIT, newId, procedure, verifyResume, type BridgeScript } from './procedures-fixtures.ts';

function world(options: { scripts?: BridgeScript[]; procedures?: ProcedureV2[]; explorer?: ExplorerProvider; clock?: FakeClock } = {}) {
  const repository = new MemoryRepository();
  for (const p of options.procedures ?? []) repository.rows.set(p.id, structuredClone(p));
  const telemetry = new FakeTelemetry();
  const engine = createProcedureEngine({ repository, telemetry, newId });
  const learner = createLearner({ repository, newId });
  const app = new FakeApp();
  const session = new FakeSession(app);
  const bridge = new FakeBridge(app, options.scripts ?? [{}]);
  let explorerCalls = 0;
  const explorer: ExplorerProvider =
    options.explorer ??
    (async () => {
      explorerCalls += 1;
      return bridge;
    });
  const recovery = createRecovery({ engine, learner, explorer, telemetry, newId, ...(options.clock ? { clock: options.clock } : {}) });
  const context = (name: string, failure: RecoveryContext['failure'], over: Partial<RecoveryContext> = {}): RecoveryContext => ({
    unit: UNIT,
    key: KEY,
    session,
    taskId: 'task-1',
    itemId: `item-${name}`,
    bindings: { 'candidate.name': name },
    failure,
    usage: telemetry.usage(),
    budget: DEFAULT_BUDGET,
    itemRepairs: 0,
    verify: verifyResume(name),
    ...over,
  });
  return { repository, telemetry, engine, learner, app, session, bridge, recovery, context, explorerCalls: () => explorerCalls };
}

const noModel: ExplorerProvider = async () => {
  throw new RuntimeError('model_unavailable', 'no model configured');
};

test('first candidate explores, the next item reuses the trial at once, three distinct successes make it stable, and 20 candidates cost one model call', async () => {
  const w = world();
  const names = Array.from({ length: 20 }, (_, i) => `候选人${String(i + 1).padStart(2, '0')}`);

  // Candidate 1: no procedure, so the bridge explores; its actions are not resent.
  w.app.show(names[0]!);
  const outcome = await w.recovery.recover(w.context(names[0]!, { status: 'no_procedure' }));
  assert.equal(outcome.status, 'repaired');
  assert.equal(w.session.acts.length, 0, 'the runtime never re-executes what the bridge did');
  assert.equal(w.app.page, 'online_resume');
  if (outcome.status !== 'repaired') return;
  assert.equal(outcome.outcome.executed[0]!.executedBy, 'bridge');
  assert.ok(outcome.proposal);
  assert.equal(outcome.proposal.source, 'learned');
  const trial = await w.learner.accept(outcome.proposal, outcome.verification, `item-${names[0]}`);
  assert.equal(trial.status, 'trial');

  // Candidates 2..20 replay with no model.
  for (const [i, name] of names.slice(1).entries()) {
    w.app.show(name);
    const p = await w.engine.select(KEY);
    assert.equal(p?.id, trial.id, 'the learned version is reused for the very next item');
    const replay = await w.engine.replay(p!, w.session, { 'candidate.name': name });
    assert.equal(replay.status, 'succeeded', name);
    const verified = await verifyResume(name)(replay.lastObservation!);
    const after = await w.engine.recordOutcome(p!.id, { itemId: `item-${name}`, ok: verified.ok });
    assert.equal(after.status, i === 0 ? 'trial' : 'stable', `after ${name}`);
  }
  assert.equal(w.telemetry.modelCalls(), 1);
  assert.equal(w.bridge.requests.length, 1);
  assert.equal(w.telemetry.usage().replayedUnits, 19);
  assert.equal(w.session.acts.length, 19);
});

test('with no model configured, exploration reports model_unavailable while a stable procedure still replays', async () => {
  const stable = procedure();
  const w = world({ procedures: [stable], explorer: noModel });
  w.app.show('张三');
  assert.deepEqual(await w.recovery.recover(w.context('张三', { status: 'no_procedure' })), { status: 'model_unavailable' });
  const replay = await w.engine.replay((await w.engine.select(KEY))!, w.session, { 'candidate.name': '张三' });
  assert.equal(replay.status, 'succeeded');
  assert.equal(w.telemetry.modelCalls(), 0);
});

test('a slow page is recovered by a bounded wait without any model', async () => {
  const w = world({ explorer: noModel });
  w.app.show('张三');
  w.app.transitionDelay = 4;
  w.app.apply({ kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' });
  const failure: ReplayResult = { status: 'postcondition_failed', procedureId: 'p', stepsRun: 1, actions: [], checks: [] };
  const outcome = await w.recovery.recover(w.context('张三', failure));
  assert.equal(outcome.status, 'recovered');
  assert.equal(outcome.status === 'recovered' && outcome.route, 'wait');
  assert.deepEqual(w.telemetry.events.filter((e) => e.type === 'local_recovery'), [{ type: 'local_recovery', unit: 'open_resume', ok: true }]);
});

test('relocate resumes at the failed step only; the steps before it are not sent again', async () => {
  const p = procedure({
    preconditions: [],
    steps: [
      { id: 's0', action: { kind: 'scroll', direction: 'down', effect: 'read' } },
      { id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' } },
    ],
  });
  const w = world({ procedures: [p], explorer: noModel });
  w.app.show('张三');
  w.app.clickStatus = 'failed';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  assert.equal(failure.status, 'step_failed');
  assert.equal(failure.failedStepId, 's1');
  w.app.clickStatus = undefined;
  w.session.acts = [];
  const outcome = await w.recovery.recover(w.context('张三', failure, { unit: { ...UNIT, timeoutMs: 60 } }));
  assert.equal(outcome.status, 'recovered');
  assert.equal(outcome.status === 'recovered' && outcome.route, 'relocate');
  assert.deepEqual(w.session.acts.map((a) => a.action.kind), ['click']);
});

test('a UI change exhausts local recovery, then one bridge repair proposes a new version under the failed one, and rollback restores the old', async () => {
  const v1 = procedure({ status: 'stable', source: 'learned', counters: { successes: 5, failures: 0, consecutiveFailures: 0, successItemIds: ['a', 'b', 'c'] } });
  const w = world({ procedures: [v1] });
  w.app.show('张三');
  w.app.buttonLabel = '查看简历';
  const failure = await w.engine.replay(v1, w.session, { 'candidate.name': '张三' });
  assert.equal(failure.status, 'step_failed');
  const actsBefore = w.session.acts.length;

  const outcome = await w.recovery.recover(w.context('张三', failure, { unit: { ...UNIT, timeoutMs: 60 } }));
  assert.equal(outcome.status, 'repaired');
  if (outcome.status !== 'repaired') return;
  assert.equal(w.telemetry.events.filter((e) => e.type === 'local_recovery').length, DEFAULT_BUDGET.localRecoveriesPerStep);
  assert.equal(w.session.acts.length - actsBefore, 1, 'only the bounded relocate re-sent the failed step; nothing the bridge did');
  assert.equal(outcome.proposal?.source, 'repair');
  assert.equal(outcome.proposal?.parentVersion, 1);
  assert.equal(w.bridge.requests[0]!.submitAllowed, false);
  assert.deepEqual(w.bridge.requests[0]!.unit.allowedEffects, ['read', 'navigation']);
  assert.deepEqual(w.bridge.requests[0]!.unit.expectedPostconditions[1], { kind: 'text', pattern: '张三', present: true });
  assert.ok(w.bridge.requests[0]!.budget.maxRounds <= DEFAULT_BUDGET.modelRoundsPerRepair);

  // The runner's part: degrade the failed version, store the verified repair.
  assert.equal((await w.engine.recordOutcome(v1.id, { itemId: 'item-张三', ok: false })).status, 'degraded');
  const v2 = await w.learner.accept(outcome.proposal!, outcome.verification, 'item-张三');
  assert.equal(v2.version, 2);
  assert.equal(v2.parentVersion, 1);
  assert.equal((await w.engine.select(KEY))?.id, v2.id);
  w.app.show('李四');
  assert.equal((await w.engine.replay(v2, w.session, { 'candidate.name': '李四' })).status, 'succeeded');

  // The UI changes back: the old stable definition can be made current again.
  const v3 = await w.engine.rollback(KEY, 1);
  assert.equal(v3.version, 3);
  assert.equal(v3.status, 'trial', 'degraded, so it returns conservatively as trial');
  assert.equal((await w.engine.select(KEY))?.id, v3.id);
});

test('budgets stop repair before any model call: item repairs, task calls, unknown tokens under a cap, wall clock', async () => {
  const cases: Array<[Partial<RecoveryContext>, unknown]> = [
    [{ itemRepairs: DEFAULT_BUDGET.modelRepairsPerItem }, 'item_repairs'],
    [{ usage: { ...emptyUsage(), uiModelCalls: 60 } }, { ok: false, exhausted: 'model_calls' }],
    [{ usage: { ...emptyUsage(), inputTokens: 'unknown' }, budget: { ...DEFAULT_BUDGET, taskTokens: 10_000 } }, { ok: false, exhausted: 'tokens' }],
    [{ usage: { ...emptyUsage(), elapsedMs: DEFAULT_BUDGET.wallClockMs } }, { ok: false, exhausted: 'wall_clock' }],
  ];
  for (const [over, budget] of cases) {
    const w = world();
    w.app.show('张三');
    assert.deepEqual(await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, over)), { status: 'exhausted', budget });
    assert.equal(w.explorerCalls(), 0, 'the model client is not even created');
    assert.equal(w.telemetry.modelCalls(), 0);
  }
});

test('a bridge that overruns the task call budget is stopped, and every call it made is recorded', async () => {
  const w = world({ scripts: [{ calls: 10 }] });
  w.app.show('张三');
  const budget: Budget = { ...DEFAULT_BUDGET, taskModelCalls: 3 };
  const outcome = await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, { budget }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: { ok: false, exhausted: 'model_calls' } });
  assert.equal(w.telemetry.modelCalls(), 4, 'stopped right after the call that went over');
  assert.equal(w.app.page, 'candidate_detail', 'the stopped bridge did not act');
});

test('a token cap stops a bridge that reports unknown tokens', async () => {
  const w = world({ scripts: [{ calls: 3, inputTokens: 'unknown' }] });
  w.app.show('张三');
  const outcome = await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, { budget: { ...DEFAULT_BUDGET, taskTokens: 50_000 } }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: { ok: false, exhausted: 'tokens' } });
  const usage: Usage = w.telemetry.usage();
  assert.equal(usage.inputTokens, 'unknown', 'unknown is never counted as 0');
});

test('a failed or unverified exploration is retried only within the item repair budget', async () => {
  const w = world({ scripts: [{ fail: 'error' }, {}] });
  w.app.show('张三');
  assert.equal((await w.recovery.recover(w.context('张三', { status: 'no_procedure' }))).status, 'repaired');
  assert.equal(w.bridge.requests.length, 2);

  // "Finished" but the page is wrong: the verifier, not the bridge, decides.
  const v = world({ scripts: [{ action: { kind: 'click', target: { kind: 'relative', point: { x: 0.9, y: 0.9 } }, effect: 'navigation' } }] });
  v.app.show('张三');
  const outcome = await v.recovery.recover(v.context('张三', { status: 'no_procedure' }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: 'item_repairs' });
  assert.equal(v.bridge.requests.length, DEFAULT_BUDGET.modelRepairsPerItem);
  assert.equal(v.repository.inserts, 0, 'nothing unverified is stored');
});

test('a bridge action outside the unit is rejected as forbidden_effect', async () => {
  const w = world({ scripts: [{ action: { kind: 'click', target: { kind: 'element', label: '下载' }, effect: 'artifact' } }] });
  w.app.show('张三');
  await assert.rejects(w.recovery.recover(w.context('张三', { status: 'no_procedure' })), (e) => isRuntimeError(e, 'forbidden_effect'));
  assert.equal(w.session.busy, false, 'the grant was returned');
});

test('cancellation: before recovery nothing runs; during exploration the bridge is stopped and recovery returns cancelled', async () => {
  const w = world({ scripts: [{ hang: true }] });
  w.app.show('张三');
  const pre = new AbortController();
  pre.abort();
  assert.deepEqual(await w.recovery.recover(w.context('张三', { status: 'no_procedure' }), pre.signal), { status: 'cancelled' });
  assert.equal(w.explorerCalls(), 0);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  assert.deepEqual(await w.recovery.recover(w.context('张三', { status: 'no_procedure' }), controller.signal), { status: 'cancelled' });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(w.session.busy, false);
});

test('model calls the bridge did not report as events still count, with unknown tokens', async () => {
  const w = world({ scripts: [{ calls: 1, silentCalls: 2 }] });
  w.app.show('张三');
  assert.equal((await w.recovery.recover(w.context('张三', { status: 'no_procedure' }))).status, 'repaired');
  const calls = w.telemetry.events.filter((e) => e.type === 'model_call');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((e) => e.type === 'model_call' && e.reason === 'missing_procedure'));
  assert.equal(w.telemetry.usage().inputTokens, 'unknown');
});

test('a failed step with an unknown outcome is not handed to the model when it may have written an artifact', async () => {
  const p = procedure({
    key: { ...KEY, unit: 'acquire_resume' },
    preconditions: [],
    steps: [{ id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'artifact' } }],
  });
  const unit = { ...UNIT, name: 'acquire_resume', allowedEffects: ['read', 'navigation', 'artifact'] as const, timeoutMs: 40 };
  const w = world({ procedures: [p] });
  w.app.show('张三');
  w.app.clickStatus = 'unknown';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  const outcome = await w.recovery.recover(w.context('张三', failure, { unit: { ...unit, allowedEffects: [...unit.allowedEffects] }, key: p.key }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: 'local' });
  assert.equal(w.explorerCalls(), 0);
});

test('the wall clock fences local recovery too: no wait or action once time is up, and waits are cut to what is left', async () => {
  const p = procedure({ preconditions: [] });
  const w = world({ procedures: [p], explorer: noModel });
  w.app.show('张三');
  w.app.clickStatus = 'failed';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  w.app.clickStatus = undefined;
  w.session.acts = [];
  const snapshots = w.app.snapshots;
  const out = await w.recovery.recover(w.context('张三', failure, { usage: { ...emptyUsage(), elapsedMs: DEFAULT_BUDGET.wallClockMs } }));
  assert.deepEqual(out, { status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });
  assert.equal(w.session.acts.length, 0);
  assert.equal(w.app.snapshots, snapshots, 'not even an observation');

  // 60 ms left: the wait is cut short, then relocate does not start.
  const started = Date.now();
  const late = await w.recovery.recover(
    w.context('张三', failure, { unit: { ...UNIT, timeoutMs: 5_000 }, usage: { ...emptyUsage(), elapsedMs: DEFAULT_BUDGET.wallClockMs - 60 } }),
  );
  assert.deepEqual(late, { status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(w.session.acts.length, 0);
});

test('a bridge that overruns the task budget is not a repair even when it finished and the page verifies', async () => {
  const w = world({ scripts: [{ calls: 5, ignoreAbort: true }] });
  w.app.show('张三');
  const outcome = await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, { budget: { ...DEFAULT_BUDGET, taskModelCalls: 3 } }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: { ok: false, exhausted: 'model_calls' } });
  assert.equal(w.app.page, 'online_resume', 'the misbehaving bridge did reach the page');
  assert.equal(w.telemetry.modelCalls(), 5, 'every call is still counted');
});

test('a bridge that runs over its rounds is a failed attempt, not a repair', async () => {
  const w = world({ scripts: [{ calls: 4, ignoreAbort: true }] });
  w.app.show('张三');
  const budget = { ...DEFAULT_BUDGET, modelRoundsPerRepair: 2, modelRepairsPerItem: 1 };
  assert.deepEqual(await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, { budget })), { status: 'exhausted', budget: 'item_repairs' });
});

test('relocate never resends a step outside the current unit', async () => {
  const p = procedure({
    preconditions: [],
    steps: [
      { id: 's0', action: { kind: 'scroll', direction: 'down', effect: 'read' } },
      { id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'artifact' } },
    ],
  });
  const w = world({ procedures: [p], explorer: noModel });
  w.app.show('张三');
  w.app.clickStatus = 'failed';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  w.app.clickStatus = undefined;
  w.session.acts = [];
  const outcome = await w.recovery.recover(w.context('张三', failure, { unit: { ...UNIT, timeoutMs: 40 } }));
  assert.equal(outcome.status, 'model_unavailable');
  assert.equal(w.session.acts.length, 0, 'open_resume does not allow artifact');
});

test('relocate never repeats a navigation step whose outcome is unknown', async () => {
  const p = procedure({ preconditions: [] });
  const w = world({ procedures: [p], explorer: noModel });
  w.app.show('张三');
  w.app.clickStatus = 'unknown';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  assert.equal(failure.status, 'step_failed');
  w.app.clickStatus = undefined;
  w.session.acts = [];
  const outcome = await w.recovery.recover(w.context('张三', failure, { unit: { ...UNIT, timeoutMs: 40 } }));
  assert.equal(outcome.status, 'model_unavailable', 'the model may look; nothing is resent locally');
  assert.equal(w.session.acts.length, 0);
});

// ---------------------------------------------------------------------------
// Wall-clock and usage holes found in review: each of these used to report a
// success past the task's limits.

const WALL = { ...DEFAULT_BUDGET, wallClockMs: 10_000 };

test('a verify that succeeds only after the deadline does not recover or repair the unit', async () => {
  // Local wait route: the page is already right, but verifying takes past the deadline.
  const clock = new FakeClock();
  const w = world({ clock, explorer: noModel });
  w.app.show('张三');
  w.app.page = 'online_resume';
  const slowVerify = async (o: Parameters<RecoveryContext['verify']>[0]) => {
    clock.advance(20_000);
    return verifyResume('张三')(o);
  };
  const failure: ReplayResult = { status: 'postcondition_failed', procedureId: 'p', stepsRun: 1, actions: [], checks: [] };
  const local = await w.recovery.recover(w.context('张三', failure, { budget: WALL, verify: slowVerify }));
  assert.deepEqual(local, { status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });

  // Bridge route: it finished and the page verifies, but only after the deadline.
  const c2 = new FakeClock();
  const b = world({ clock: c2 });
  b.app.show('李四');
  const late = async (o: Parameters<RecoveryContext['verify']>[0]) => {
    c2.advance(20_000);
    return verifyResume('李四')(o);
  };
  const repaired = await b.recovery.recover(b.context('李四', { status: 'no_procedure' }, { budget: WALL, verify: late }));
  assert.deepEqual(repaired, { status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });
});

test('a multi-step local replay stops before the next action once the deadline passes', async () => {
  const clock = new FakeClock();
  const p = procedure({
    preconditions: [],
    postconditions: [],
    steps: [
      { id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' } },
      { id: 's2', action: { kind: 'scroll', direction: 'down', effect: 'read' } },
      { id: 's3', action: { kind: 'scroll', direction: 'down', effect: 'read' } },
    ],
  });
  const w = world({ procedures: [p], clock, explorer: noModel });
  w.app.show('张三');
  w.app.clickStatus = 'failed';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  assert.equal(failure.failedStepId, 's1');
  w.app.clickStatus = undefined;
  w.session.acts = [];
  // Each delivered action takes 6 s of the 10 s budget.
  w.session.onAct = () => clock.advance(6_000);
  const unit = { ...UNIT, postconditions: [], timeoutMs: 40 };
  const outcome = await w.recovery.recover(w.context('张三', failure, { unit, budget: WALL, usage: { ...emptyUsage(), elapsedMs: 3_000 } }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });
  // The wait route acted on nothing; relocate sent s1, then s2 would start at 9 s and finish
  // past 10 s: it is sent (the fence is before each action) and s3 is not.
  assert.deepEqual(w.session.acts.map((a) => a.action.kind), ['click', 'scroll']);
});

test('the deadline timer aborts a long in-flight local wait in real time', async () => {
  const p = procedure({ preconditions: [] });
  const w = world({ procedures: [p], explorer: noModel });
  w.app.show('张三');
  w.app.clickStatus = 'failed';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  w.app.clickStatus = undefined;
  w.app.transitionDelay = 1_000_000; // the page never comes
  const started = Date.now();
  const outcome = await w.recovery.recover(
    w.context('张三', failure, { unit: { ...UNIT, timeoutMs: 60_000 }, usage: { ...emptyUsage(), elapsedMs: DEFAULT_BUDGET.wallClockMs - 80 } }),
  );
  assert.deepEqual(outcome, { status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });
  assert.ok(Date.now() - started < 1_000);
});

test('a finished bridge with no usage events but modelCalls over the task cap is not a repair', async () => {
  const w = world({ scripts: [{ calls: 0, silentCalls: 5 }] });
  w.app.show('张三');
  const outcome = await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, { budget: { ...DEFAULT_BUDGET, taskModelCalls: 3 } }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: { ok: false, exhausted: 'model_calls' } });
  assert.equal(w.app.page, 'online_resume', 'the bridge did act; the result still does not count');
  assert.equal(w.telemetry.modelCalls(), 5);
});

test('silent calls over the rounds of one repair are a failed attempt', async () => {
  const w = world({ scripts: [{ calls: 0, silentCalls: 4 }] });
  w.app.show('张三');
  const budget = { ...DEFAULT_BUDGET, modelRoundsPerRepair: 2, modelRepairsPerItem: 1 };
  assert.deepEqual(await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, { budget })), { status: 'exhausted', budget: 'item_repairs' });
});

test('unknown tokens under a configured cap exhaust the budget even with no usage events', async () => {
  const capped = { ...DEFAULT_BUDGET, taskTokens: 50_000 };
  // Silent calls: their tokens are unknown.
  const a = world({ scripts: [{ calls: 0, silentCalls: 1 }] });
  a.app.show('张三');
  assert.deepEqual(await a.recovery.recover(a.context('张三', { status: 'no_procedure' }, { budget: capped })), { status: 'exhausted', budget: { ok: false, exhausted: 'tokens' } });
  // No calls reported at all, but the outcome's token total is unknown.
  const b = world({ scripts: [{ calls: 0, reportTokens: 'unknown' }] });
  b.app.show('张三');
  assert.deepEqual(await b.recovery.recover(b.context('张三', { status: 'no_procedure' }, { budget: capped })), { status: 'exhausted', budget: { ok: false, exhausted: 'tokens' } });
  // A known total above what the events said counts too.
  const c = world({ scripts: [{ calls: 1, inputTokens: 100, reportTokens: 60_000 }] });
  c.app.show('张三');
  assert.deepEqual(await c.recovery.recover(c.context('张三', { status: 'no_procedure' }, { budget: capped })), { status: 'exhausted', budget: { ok: false, exhausted: 'tokens' } });
  // Without a cap, unknown tokens are allowed and the repair stands.
  const d = world({ scripts: [{ calls: 0, reportTokens: 'unknown' }] });
  d.app.show('张三');
  assert.equal((await d.recovery.recover(d.context('张三', { status: 'no_procedure' }))).status, 'repaired');
});

test('a slow explorer setup that uses up the wall clock starts no bridge', async () => {
  const clock = new FakeClock();
  let bridge: FakeBridge | undefined;
  const w = world({
    clock,
    explorer: async () => {
      clock.advance(20_000);
      return bridge!;
    },
  });
  bridge = w.bridge;
  w.app.show('张三');
  const outcome = await w.recovery.recover(w.context('张三', { status: 'no_procedure' }, { budget: WALL }));
  assert.deepEqual(outcome, { status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });
  assert.equal(w.bridge.requests.length, 0);
  assert.equal(w.app.page, 'candidate_detail');
});

test('the caller cancelling during local recovery is still cancelled, not a budget stop', async () => {
  const p = procedure({ preconditions: [] });
  const w = world({ procedures: [p], explorer: noModel });
  w.app.show('张三');
  w.app.clickStatus = 'failed';
  const failure = await w.engine.replay(p, w.session, { 'candidate.name': '张三' });
  w.app.clickStatus = undefined;
  w.app.transitionDelay = 1_000_000;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const outcome = await w.recovery.recover(w.context('张三', failure, { unit: { ...UNIT, timeoutMs: 5_000 } }), controller.signal);
  assert.deepEqual(outcome, { status: 'cancelled' });
});

test('the exploration request says why the model is called: ui/missing_procedure to learn, repair with the failure to fix', async () => {
  // First learning: no procedure.
  const learn = world();
  learn.app.show('张三');
  assert.equal((await learn.recovery.recover(learn.context('张三', { status: 'no_procedure' }))).status, 'repaired');
  assert.deepEqual(learn.bridge.requests[0]!.usageContext, { purpose: 'ui', reason: 'missing_procedure' });

  // A replay that failed at a step.
  const v1 = procedure({ status: 'stable', source: 'learned', counters: { successes: 5, failures: 0, consecutiveFailures: 0, successItemIds: ['a', 'b', 'c'] } });
  const repair = world({ procedures: [v1] });
  repair.app.show('张三');
  repair.app.buttonLabel = '查看简历';
  const failure = await repair.engine.replay(v1, repair.session, { 'candidate.name': '张三' });
  assert.equal(failure.status, 'step_failed');
  assert.equal((await repair.recovery.recover(repair.context('张三', failure, { unit: { ...UNIT, timeoutMs: 60 } }))).status, 'repaired');
  assert.deepEqual(repair.bridge.requests[0]!.usageContext, { purpose: 'repair', reason: 'replay_failed' });

  // A unit whose result did not verify.
  const unverified = world();
  unverified.app.show('张三');
  const check = { ok: false, evidence: ['online resume not shown'] };
  assert.equal((await unverified.recovery.recover(unverified.context('张三', { status: 'verify_failed', check }, { unit: { ...UNIT, timeoutMs: 60 } }))).status, 'repaired');
  assert.deepEqual(unverified.bridge.requests[0]!.usageContext, { purpose: 'repair', reason: 'postcondition_failed' });
});
