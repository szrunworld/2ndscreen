import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeError, type ExplorerProvider } from '../src/contracts.ts';
import { agentUnitKey, createUnitService, unitProblems, type AgentUnit } from '../src/agent-units.ts';
import { createLearner } from '../src/learning.ts';
import { createProcedureEngine } from '../src/procedures.ts';
import { openTaskStore } from '../src/store.ts';
import { FakeApp, FakeBridge, FakeSession } from './procedures-fixtures.ts';

// An agent's unit, said in its own words: the resume of {{candidate.name}} is open.
const OPEN_RESUME: AgentUnit = {
  name: 'open_resume',
  goal: '打开 {{candidate.name}} 的在线简历',
  allowedEffects: ['read', 'navigation'],
  postconditions: [
    { kind: 'element', locator: { kind: 'element', role: 'AXButton', label: '关闭' }, present: true },
    { kind: 'text', pattern: '{{candidate.name}}', present: true },
  ],
};

test('a unit may only read, navigate or make artifacts the agent declares, and is judged by postconditions it can state', () => {
  assert.deepEqual(unitProblems(OPEN_RESUME, ['read', 'navigation']), { errors: [], forbidden: false });
  assert.equal(unitProblems({ ...OPEN_RESUME, allowedEffects: ['navigation', 'external-submit'] }, ['navigation', 'external-submit']).forbidden, true);
  const undeclared = unitProblems(OPEN_RESUME, ['read']);
  assert.match(undeclared.errors.join(), /navigation, which the agent does not declare/);
  assert.match(unitProblems({ ...OPEN_RESUME, postconditions: [] }, ['read', 'navigation']).errors.join(), /postconditions must be a list/);
  assert.match(unitProblems({ ...OPEN_RESUME, postconditions: [{ kind: 'file', path: '/etc/passwd' }] }, ['read', 'navigation']).errors.join(), /may not check files/);
  assert.match(
    unitProblems({ ...OPEN_RESUME, postconditions: [{ kind: 'any', conditions: [{ kind: 'page', pageClass: 'x' }] }] }, ['read', 'navigation']).errors.join(),
    /page classes/,
  );
  assert.match(unitProblems({ ...OPEN_RESUME, name: 'Open Resume' }, ['read', 'navigation']).errors.join(), /unit.name/);
});

async function world(explorer?: ExplorerProvider) {
  const store = await openTaskStore({ path: ':memory:' });
  const app = new FakeApp();
  const session = new FakeSession(app);
  const bridge = new FakeBridge(app, [{}]);
  let explorations = 0;
  const service = createUnitService({
    engine: createProcedureEngine({ repository: store }),
    learner: createLearner({ repository: store }),
    explorer:
      explorer ??
      (async () => {
        explorations += 1;
        return bridge;
      }),
  });
  const request = (name: string, itemId: string) => ({
    agentId: 'demo.recruiter',
    agentVersion: '0.2.0',
    taskId: 'task-1',
    itemId,
    profile: { id: 'boss-macos-1440x900', appVersion: '4.2' },
    unit: OPEN_RESUME,
    bindings: { 'candidate.name': name },
    session,
  });
  return { store, app, session, bridge, service, request, explorations: () => explorations };
}

test('run_unit: done already is verified; then the model explores once, its path is learned for this agent, and later items replay it until it is stable', async () => {
  const w = await world();
  const signal = new AbortController().signal;
  try {
    // The page already shows the resume: nothing is sent.
    w.app.show('张三');
    w.app.page = 'online_resume';
    const done = await w.service.run(w.request('张三', 'c-0'), signal);
    assert.equal(done.ok && done.route, 'verified');
    assert.equal(w.session.acts.length + w.explorations(), 0);

    // First candidate: no procedure, the bridge explores and what it did is learned, not sent again.
    w.app.show('李四');
    const first = await w.service.run(w.request('李四', 'c-1'), signal);
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.route, 'repaired');
    assert.equal(first.procedure?.status, 'trial');
    assert.equal(w.explorations(), 1);
    assert.equal(w.session.acts.length, 0, 'the runtime never re-executes what the bridge did');
    assert.equal(first.usage.repairModelCalls + first.usage.uiModelCalls, 1);
    assert.equal(w.bridge.requests[0]!.parameters['candidate.name'], '李四');

    // The procedure is the agent's own, in the task ledger.
    const key = agentUnitKey(w.request('x', 'x'), 'open_resume');
    assert.equal(key.skill, 'agent:demo.recruiter');
    const stored = await w.store.listProcedures(key);
    assert.equal(stored.length, 1);

    // Next candidates replay it with no model; distinct verified items make it stable.
    const statuses: string[] = [];
    for (const [i, name] of ['王五', '赵六', '钱七'].entries()) {
      w.app.show(name);
      const r = await w.service.run(w.request(name, `c-${i + 2}`), signal);
      assert.ok(r.ok && r.route === 'replay', JSON.stringify(r));
      if (r.ok) statuses.push(r.procedure!.status);
    }
    assert.deepEqual(statuses, ['trial', 'stable', 'stable']);
    assert.equal(w.explorations(), 1, 'one model exploration for four candidates');
    assert.equal(w.session.acts.length, 3);
    assert.equal(w.service.usage('task-1').replayedUnits >= 0, true);
  } finally {
    await w.store.close();
  }
});

test('run_unit: with no model a missing path says model_unavailable, and a unit that may not be learned is only verified', async () => {
  const w = await world(async () => {
    throw new RuntimeError('model_unavailable', 'no model');
  });
  const signal = new AbortController().signal;
  try {
    w.app.show('张三');
    const r = await w.service.run(w.request('张三', 'c-1'), signal);
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'model_unavailable']);
    const fixed = await w.service.run({ ...w.request('张三', 'c-1'), unit: { ...OPEN_RESUME, learnable: false } }, signal);
    assert.deepEqual([fixed.ok, !fixed.ok && fixed.reason], [false, 'not_learnable']);
    assert.equal(w.session.acts.length, 0);
  } finally {
    await w.store.close();
  }
});
