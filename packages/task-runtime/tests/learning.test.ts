import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeError, isRuntimeError, validateProcedure, type ActionResult, type ExecutedStep, type ProcedureV2 } from '../src/contracts.ts';
import { createLearner } from '../src/learning.ts';
import { KEY, MemoryRepository, UNIT, newId } from './procedures-fixtures.ts';

const at = '2026-10-04T08:00:00.000Z';
const result = (status: ActionResult['status']): ActionResult => ({ actionId: newId(), status, startedAt: at, finishedAt: at });
const bindings = { 'candidate.name': '张三', 'job.title': '前端工程师' };

function trace(): ExecutedStep[] {
  return [
    // A miss the model corrected: it changed nothing and is not part of the path.
    { stepId: 'b0', action: { kind: 'click', target: { kind: 'relative', point: { x: 0.9, y: 0.9 } }, effect: 'navigation' }, result: result('no_effect'), executedBy: 'bridge' },
    {
      stepId: 'b1',
      action: { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.5 } }, effect: 'navigation' },
      result: result('ok'),
      resolvedElement: { role: 'AXButton', label: '在线简历' },
      before: { snapshotId: 's1', pageClass: 'candidate_detail' },
      after: { snapshotId: 's2', pageClass: 'online_resume' },
      executedBy: 'bridge',
    },
    { stepId: 'b2', action: { kind: 'type', target: { kind: 'element', role: 'AXTextField', label: '搜索' }, value: '张三 前端工程师', effect: 'read' }, result: result('ok'), executedBy: 'bridge' },
    { stepId: 'b3', action: { kind: 'click', target: { kind: 'element', role: 'AXStaticText', labelPattern: '^张三' }, effect: 'read' }, result: result('ok'), executedBy: 'bridge' },
  ];
}

const verified = { ok: true, snapshotId: 's9', evidence: ['page=online_resume', 'identity=match'] };

test('propose drops steps that did nothing, maps model coordinates to controls, and turns bound values into slots', () => {
  const learner = createLearner({ repository: new MemoryRepository(), newId });
  const p = learner.propose(UNIT, KEY, trace(), bindings);
  assert.equal(p.source, 'learned');
  assert.equal(p.steps.length, 3);
  assert.deepEqual(p.steps[0]!.action, { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' });
  assert.deepEqual(p.steps[0]!.fallbacks, [{ kind: 'relative', point: { x: 0.5, y: 0.5 } }]);
  assert.deepEqual(p.steps[0]!.expect?.condition, { kind: 'page', pageClass: 'online_resume' });
  assert.ok(p.steps[0]!.expect!.timeoutMs <= 120_000);
  assert.equal(p.steps[1]!.action.kind === 'type' && p.steps[1]!.action.value, '{{candidate.name}} {{job.title}}');
  assert.deepEqual(p.steps[2]!.action.kind === 'click' && p.steps[2]!.action.target, { kind: 'element', role: 'AXStaticText', labelPattern: '^{{candidate.name}}' });
  assert.deepEqual(p.parameters, ['candidate.name', 'job.title']);
  assert.deepEqual(p.postconditions, UNIT.postconditions);
  assert.ok(!JSON.stringify(p).includes('张三'), 'no candidate name is stored');
});

test('a value that is regex-escaped inside a pattern is still recognised as its slot', () => {
  const learner = createLearner({ repository: new MemoryRepository(), newId });
  const step: ExecutedStep = { stepId: 'b1', action: { kind: 'click', target: { kind: 'element', labelPattern: '^李\\(前端\\)' }, effect: 'navigation' }, result: result('ok'), executedBy: 'bridge' };
  const p = learner.propose(UNIT, KEY, [step], { 'candidate.name': '李(前端)' });
  assert.deepEqual(p.steps[0]!.action.kind === 'click' && p.steps[0]!.action.target, { kind: 'element', labelPattern: '^{{candidate.name}}' });
});

test('propose rejects actions outside the unit, unauthorized submits and traces it cannot store', () => {
  const learner = createLearner({ repository: new MemoryRepository(), newId });
  const step = (effect: 'artifact' | 'external-submit'): ExecutedStep => ({ stepId: 'x', action: { kind: 'click', target: { kind: 'element', label: '发送' }, effect }, result: result('ok'), executedBy: 'bridge' });
  assert.throws(() => learner.propose(UNIT, KEY, [...trace(), step('artifact')], bindings), (e) => isRuntimeError(e, 'forbidden_effect'));
  assert.throws(() => learner.propose(UNIT, KEY, [step('external-submit')], bindings), (e) => isRuntimeError(e, 'forbidden_effect'));
  assert.throws(() => learner.propose(UNIT, { ...KEY, unit: 'return_to_list' }, trace(), bindings), (e) => isRuntimeError(e, 'invalid_input'));
  assert.throws(() => learner.propose({ ...UNIT, learnable: false }, KEY, trace(), bindings), (e) => isRuntimeError(e, 'invalid_input'));
  const indexOnly: ExecutedStep = { stepId: 'i', action: { kind: 'click', target: { kind: 'element', index: 4 }, effect: 'navigation' }, result: result('ok'), executedBy: 'bridge' };
  assert.throws(() => learner.propose(UNIT, KEY, [indexOnly], bindings), (e) => isRuntimeError(e, 'invalid_input'));
  assert.throws(() => learner.propose(UNIT, KEY, [trace()[0]!], bindings), (e) => isRuntimeError(e, 'invalid_input'), 'nothing took effect');
  // Index plus a semantic hint keeps the hint and drops the index.
  const p = learner.propose(UNIT, KEY, [{ ...indexOnly, resolvedElement: { role: 'AXButton', label: '在线简历' } }], bindings);
  assert.deepEqual(p.steps[0]!.action.kind === 'click' && p.steps[0]!.action.target, { kind: 'element', role: 'AXButton', label: '在线简历' });
});

test('accept stores a trial only with passing, non-empty evidence', async () => {
  const repository = new MemoryRepository();
  const learner = createLearner({ repository, newId });
  const proposal = learner.propose(UNIT, KEY, trace(), bindings);
  for (const bad of [
    { ...verified, ok: false },
    { ...verified, evidence: [] },
    { ...verified, evidence: ['  '] },
    { ok: true } as unknown as typeof verified,
  ])
    await assert.rejects(learner.accept(proposal, bad, 'item-1'), (e) => isRuntimeError(e, 'invalid_input'));
  await assert.rejects(learner.accept(proposal, verified, ''), (e) => isRuntimeError(e, 'invalid_input'));
  const tampered = structuredClone(proposal);
  tampered.steps[0]!.action.effect = 'external-submit';
  await assert.rejects(learner.accept(tampered, verified, 'item-1'), (e) => isRuntimeError(e, 'invalid_input'));
  assert.equal(repository.inserts, 0);

  const v1 = await learner.accept(proposal, verified, 'item-1');
  assert.equal(v1.status, 'trial');
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.counters, { successes: 1, failures: 0, consecutiveFailures: 0, successItemIds: ['item-1'] });
  assert.ok(validateProcedure(v1, { submitAllowed: false }).ok);
});

test('proposals become new versions; a repair names its parent; earlier versions are never rewritten', async () => {
  const repository = new MemoryRepository();
  const learner = createLearner({ repository, newId });
  const proposal = learner.propose(UNIT, KEY, trace(), bindings);
  const v1 = await learner.accept(proposal, verified, 'item-1');
  const def1 = repository.definition(v1.id);
  const v2 = await learner.accept({ ...proposal, source: 'repair', parentVersion: 1 }, verified, 'item-2');
  assert.equal(v2.version, 2);
  assert.equal(v2.parentVersion, 1);
  assert.equal(v2.source, 'repair');
  await assert.rejects(learner.accept({ ...proposal, source: 'repair', parentVersion: 7 }, verified, 'item-3'), (e) => isRuntimeError(e, 'invalid_input'));
  const other = await learner.accept({ ...proposal, key: { ...KEY, branch: 'attachment' } }, verified, 'item-3');
  assert.equal(other.version, 1, 'versions count per key');
  // Mutating the caller's proposal afterwards does not reach the store.
  proposal.steps.length = 0;
  assert.equal(repository.definition(v1.id), def1);
});

test('accept takes the next version when another writer inserted the same one first', async () => {
  const repository = new MemoryRepository();
  let raced = false;
  const insert = repository.insertProcedure.bind(repository);
  repository.insertProcedure = async (p: ProcedureV2) => {
    if (!raced) {
      raced = true;
      await insert({ ...structuredClone(p), id: 'other-writer' });
      throw new RuntimeError('conflict', 'taken');
    }
    return insert(p);
  };
  const learner = createLearner({ repository, newId });
  const v = await learner.accept(learner.propose(UNIT, KEY, trace(), bindings), verified, 'item-1');
  assert.equal(v.version, 2);
});
