import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRuntimeError, validateProcedure, type ProcedureV2 } from '../src/contracts.ts';
import { createProcedureEngine, importV1Procedure } from '../src/procedures.ts';
import { FakeApp, FakeSession, FakeTelemetry, KEY, MemoryRepository, newId, procedure } from './procedures-fixtures.ts';

function setup(...procedures: ProcedureV2[]) {
  const repository = new MemoryRepository();
  for (const p of procedures) repository.rows.set(p.id, structuredClone(p));
  const telemetry = new FakeTelemetry();
  const engine = createProcedureEngine({ repository, telemetry, newId });
  const app = new FakeApp();
  const session = new FakeSession(app);
  return { repository, telemetry, engine, app, session };
}

test('select prefers stable, then trial, then seeded, newest first, and skips degraded, retired and invalid versions', async () => {
  const seeded = procedure({ version: 1, status: 'seeded' });
  const trial = procedure({ version: 2, status: 'trial' });
  const olderStable = procedure({ version: 3, status: 'stable' });
  const stable = procedure({ version: 4, status: 'stable' });
  const degraded = procedure({ version: 5, status: 'degraded' });
  const retired = procedure({ version: 6, status: 'retired' });
  const indexed = procedure({ version: 7, status: 'stable', steps: [{ id: 's1', action: { kind: 'click', target: { kind: 'element', index: 3 }, effect: 'navigation' } }] });
  const submit = procedure({ version: 8, status: 'stable', steps: [{ id: 's1', action: { kind: 'click', target: { kind: 'element', label: '发送' }, effect: 'external-submit' } }] });
  const { engine, repository } = setup(seeded, trial, olderStable, stable, degraded, retired, indexed, submit);
  assert.equal((await engine.select(KEY))?.id, stable.id);
  repository.rows.delete(stable.id);
  repository.rows.delete(olderStable.id);
  assert.equal((await engine.select(KEY))?.id, trial.id);
  repository.rows.delete(trial.id);
  assert.equal((await engine.select(KEY))?.id, seeded.id);
  repository.rows.delete(seeded.id);
  assert.equal(await engine.select(KEY), undefined);
  assert.equal(await engine.select({ ...KEY, branch: 'attachment' }), undefined, 'other keys never share versions');
});

test('replay binds parameters, escapes them inside patterns, and leaves the stored definition alone', async () => {
  const p = procedure();
  const { engine, app, session, repository } = setup(p);
  const before = repository.definition(p.id);
  app.show('李(前端)+1');
  const result = await engine.replay(p, session, { 'candidate.name': '李(前端)+1' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.stepsRun, 1);
  assert.equal(session.acts.length, 1);
  assert.equal(result.lastObservation?.pageClass, 'online_resume');
  assert.ok(result.checks.every((c) => c.ok));
  assert.equal(repository.definition(p.id), before);
  assert.equal(p.preconditions[1]!.kind === 'text' && p.preconditions[1]!.pattern, '{{candidate.name}}');
});

test('an unbound parameter fails before any action', async () => {
  const p = procedure();
  const { engine, session } = setup(p);
  await assert.rejects(engine.replay(p, session, {}), (e) => isRuntimeError(e, 'invalid_input'));
  assert.equal(session.acts.length, 0);
});

test('replay checks preconditions first: the wrong candidate on screen means no action', async () => {
  const p = procedure();
  const { engine, app, session } = setup(p);
  app.show('王五');
  const result = await engine.replay(p, session, { 'candidate.name': '张三' });
  assert.equal(result.status, 'precondition_failed');
  assert.equal(session.acts.length, 0);
});

test('a renamed control fails the step; a stored fallback locator recovers it deterministically', async () => {
  const p = procedure();
  const { engine, app, session } = setup(p);
  app.show('张三');
  app.buttonLabel = '查看简历';
  const failed = await engine.replay(p, session, { 'candidate.name': '张三' });
  assert.equal(failed.status, 'step_failed');
  assert.equal(failed.failedStepId, 's1');

  const withFallback = procedure({ steps: [{ ...p.steps[0]!, fallbacks: [{ kind: 'relative', point: { x: 0.5, y: 0.5 } }] }] });
  app.show('张三');
  session.acts = [];
  const ok = await engine.replay(withFallback, session, { 'candidate.name': '张三' });
  assert.equal(ok.status, 'succeeded');
  assert.deepEqual(session.acts.map((a) => (a.action.kind === 'click' ? a.action.target.kind : '')), ['element', 'relative']);
});

test('an action whose outcome is unknown is never resent through a fallback', async () => {
  const p = procedure({ steps: [{ id: 's1', action: procedure().steps[0]!.action, fallbacks: [{ kind: 'relative', point: { x: 0.5, y: 0.5 } }] }] });
  const { engine, app, session } = setup(p);
  app.show('张三');
  app.clickStatus = 'unknown';
  const result = await engine.replay(p, session, { 'candidate.name': '张三' });
  assert.equal(result.status, 'step_failed');
  assert.equal(session.acts.length, 1);
});

test('postconditions are checked on a fresh observation', async () => {
  const p = procedure({ steps: [{ id: 's1', action: procedure().steps[0]!.action }], postconditions: [{ kind: 'page', pageClass: 'attachment_preview' }] });
  const { engine, app, session } = setup(p);
  app.show('张三');
  assert.equal((await engine.replay(p, session, { 'candidate.name': '张三' })).status, 'postcondition_failed');
});

test('a step expectation is a bounded wait: a slow page passes, a page that never comes fails in time', async () => {
  const p = procedure();
  const { engine, app, session } = setup(p);
  app.show('张三');
  app.transitionDelay = 3;
  assert.equal((await engine.replay(p, session, { 'candidate.name': '张三' })).status, 'succeeded');
  app.show('张三');
  app.transitionDelay = 10_000;
  const started = Date.now();
  const result = await engine.replay(p, session, { 'candidate.name': '张三' });
  assert.equal(result.status, 'step_failed');
  assert.ok(Date.now() - started < 2_000);
});

test('cancellation stops replay before the next action', async () => {
  const p = procedure();
  const { engine, app, session } = setup(p);
  app.show('张三');
  const controller = new AbortController();
  controller.abort();
  const result = await engine.replay(p, session, { 'candidate.name': '张三' }, controller.signal);
  assert.equal(result.status, 'cancelled');
  assert.equal(session.acts.length, 0);
});

test('replay refuses unauthorized and non-runnable procedures before acting', async () => {
  const submit = procedure({ steps: [{ id: 's1', action: { kind: 'click', target: { kind: 'element', label: '发送' }, effect: 'external-submit' } }] });
  const { engine, app, session } = setup();
  app.show('张三');
  await assert.rejects(engine.replay(submit, session, { 'candidate.name': '张三' }), (e) => isRuntimeError(e, 'invalid_input'));
  await assert.rejects(engine.replay(procedure({ status: 'degraded' }), session, { 'candidate.name': '张三' }), (e) => isRuntimeError(e, 'conflict'));
  assert.equal(session.acts.length, 0);
});

test('20 distinct candidates replay a stable procedure with zero model calls and no model configured', async () => {
  // The engine factory takes no model or explorer at all; nothing here can reach a network.
  const stable = procedure({ status: 'stable' });
  const { engine, app, session, telemetry, repository } = setup(stable);
  for (let i = 1; i <= 20; i++) {
    const name = `候选人${String(i).padStart(2, '0')}`;
    app.show(name);
    const selected = await engine.select(KEY);
    assert.equal(selected?.id, stable.id);
    const result = await engine.replay(selected!, session, { 'candidate.name': name });
    assert.equal(result.status, 'succeeded', name);
    await engine.recordOutcome(selected!.id, { itemId: `item-${i}`, ok: true });
  }
  assert.equal(telemetry.modelCalls(), 0);
  assert.equal(telemetry.usage().uiModelCalls, 0);
  assert.equal(telemetry.usage().replayedUnits, 20);
  assert.equal(session.acts.length, 20);
  const after = (await repository.getProcedure(stable.id))!;
  assert.equal(after.status, 'stable');
  assert.equal(after.counters.successes, 20);
});

test('recordOutcome: three distinct consecutive items promote a trial; repeats do not; any failure resets; failures degrade', async () => {
  const trial = procedure({ status: 'trial', source: 'learned', counters: { successes: 1, failures: 0, consecutiveFailures: 0, successItemIds: ['a'] } });
  const { engine, repository } = setup(trial);
  const before = repository.definition(trial.id);
  let p = await engine.recordOutcome(trial.id, { itemId: 'a', ok: true });
  assert.equal(p.status, 'trial', 'the same item twice is one candidate');
  p = await engine.recordOutcome(trial.id, { itemId: 'b', ok: true });
  assert.equal(p.status, 'trial');
  p = await engine.recordOutcome(trial.id, { itemId: 'c', ok: true });
  assert.equal(p.status, 'stable');
  assert.deepEqual(p.counters.successItemIds, ['a', 'b', 'c']);
  assert.equal(repository.definition(trial.id), before, 'promotion changes state only');

  const lenient = createProcedureEngine({ repository, rule: { promoteAfterSuccesses: 3, degradeAfterFailures: 2 } });
  const t2 = procedure({ status: 'trial', source: 'learned', version: 2, counters: { successes: 2, failures: 0, consecutiveFailures: 0, successItemIds: ['a', 'b'] } });
  repository.rows.set(t2.id, t2);
  p = await lenient.recordOutcome(t2.id, { itemId: 'x', ok: false });
  assert.equal(p.status, 'trial');
  assert.deepEqual(p.counters.successItemIds, [], 'a failure below the threshold still resets the streak');
  p = await lenient.recordOutcome(t2.id, { itemId: 'c', ok: true });
  assert.equal(p.status, 'trial');
  p = await lenient.recordOutcome(t2.id, { itemId: 'd', ok: false });
  p = await lenient.recordOutcome(t2.id, { itemId: 'e', ok: false });
  assert.equal(p.status, 'degraded');

  p = await engine.recordOutcome(trial.id, { itemId: 'd', ok: false });
  assert.equal(p.status, 'degraded', 'default rule degrades a stable version on the first failure');
  await assert.rejects(engine.recordOutcome('missing', { itemId: 'a', ok: true }), (e) => isRuntimeError(e, 'not_found'));
  await assert.rejects(engine.recordOutcome(trial.id, { itemId: '', ok: true }), (e) => isRuntimeError(e, 'invalid_input'));
});

test('rollback inserts a proven version again as the newest stable; old definitions never change', async () => {
  const v1 = procedure({ version: 1, status: 'degraded', source: 'learned', counters: { successes: 5, failures: 1, consecutiveFailures: 1, successItemIds: [] } });
  const v2 = procedure({ version: 2, parentVersion: 1, status: 'trial', source: 'repair', counters: { successes: 1, failures: 0, consecutiveFailures: 0, successItemIds: ['z'] } });
  const { engine, repository } = setup(v1, v2);
  const defs = [repository.definition(v1.id), repository.definition(v2.id)];
  const v3 = await engine.rollback(KEY, 1);
  assert.equal(v3.version, 3);
  assert.equal(v3.parentVersion, 1);
  assert.equal(v3.status, 'stable');
  assert.deepEqual(v3.steps, v1.steps);
  assert.ok(validateProcedure(v3, { submitAllowed: false }).ok);
  assert.equal((await engine.select(KEY))?.id, v3.id);
  assert.deepEqual([repository.definition(v1.id), repository.definition(v2.id)], defs);
  await assert.rejects(engine.rollback(KEY, 2), (e) => isRuntimeError(e, 'conflict'), 'a trial was never proven');
  await assert.rejects(engine.rollback(KEY, 9), (e) => isRuntimeError(e, 'not_found'));
});

test('V1 import keeps named-control procedures as seeded with slots, and rejects the rest', () => {
  const now = new Date('2026-10-04T08:00:00Z');
  const v1 = {
    app: 'com.zhipin.www',
    instruction: '打开张三的在线简历',
    template: '打开⟦0⟧的在线简历',
    slots: 1,
    steps: [
      { kind: 'click', target: { role: 'AXStaticText', label: '⟦0⟧…', x: 0.1, y: 0.2 } },
      { kind: 'wait', seconds: 1 },
      { kind: 'click', target: { role: 'AXButton', label: '在线简历', x: 0.5, y: 0.5 } },
      { kind: 'type', value: '⟦0⟧' },
    ],
    finish: 'steps',
    reason: 'done',
    endControls: [],
    allowSubmit: false,
    learned: '2026-09-01T00:00:00Z',
    successes: 9,
    failures: 0,
  };
  const p = importV1Procedure(v1, KEY, now)!;
  assert.ok(p);
  assert.equal(p.status, 'seeded');
  assert.equal(p.source, 'v1-import');
  assert.deepEqual(p.parameters, ['slot0']);
  assert.equal(p.steps.length, 3);
  assert.deepEqual(p.steps[0]!.action, { kind: 'click', target: { kind: 'element', role: 'AXStaticText', labelPattern: '^{{slot0}}' }, effect: 'navigation' });
  assert.equal(p.counters.successes, 0, 'V1 evidence does not carry over');
  assert.ok(validateProcedure(p, { submitAllowed: false }).ok);

  assert.equal(importV1Procedure({ ...v1, allowSubmit: true }, KEY, now), undefined);
  assert.equal(importV1Procedure({ ...v1, steps: [{ kind: 'click', target: { role: 'AXButton', label: '', x: 0.5, y: 0.5 } }] }, KEY, now), undefined);
  assert.equal(importV1Procedure({ ...v1, steps: [{ kind: 'click', target: { role: 'AXButton', label: 'OK', x: 0, y: 0 }, offsetX: 0.3, offsetY: 0.4 }] }, KEY, now), undefined);
  assert.equal(importV1Procedure({ nonsense: true }, KEY, now), undefined);
});
