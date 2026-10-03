import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSS_UNITS,
  DEFAULT_BUDGET,
  RuntimeError,
  TERMINAL_TASK_STATUSES,
  addTokens,
  assertValid,
  bindSlots,
  canTransitionTask,
  canTransitionWorkItem,
  candidateDedupeKey,
  captureCompleteness,
  checkBudget,
  emptyUsage,
  encodeJsonLine,
  globalToRelative,
  globalToScreenshotRect,
  isCountable,
  isRuntimeError,
  leaseScopeKey,
  leaseScopesOverlap,
  nextProcedureState,
  normalizedToGlobal,
  parseBridgeEvent,
  procedureKeyString,
  relativeToGlobal,
  safePathSegment,
  screenshotToGlobal,
  stepSlots,
  throwIfAborted,
  validateActionRequest,
  validateCollectResumesInput,
  validateExplorationRequest,
  validateProcedure,
  validateTaskSpec,
  validateWaitSpec,
  type ExplorationRequest,
  type ProcedureV2,
  type TaskStatus,
  type WorkItemStatus,
} from '../src/contracts.ts';

const now = new Date('2026-10-04T08:00:00Z');

const input = {
  job: '前端工程师',
  requestedCount: 20,
  outputDir: '/Users/someone/招聘/前端',
  source: 'conversations',
  captureMode: 'available',
};

test('a well-formed collect-resumes input passes', () => {
  assert.deepEqual(validateCollectResumesInput(input, now), { ok: true, value: input });
});

test('bad inputs are rejected with every problem named', () => {
  const result = validateCollectResumesInput(
    { ...input, job: ' ', requestedCount: 0, outputDir: 'relative/dir', captureMode: 'screenshots', extra: 1 },
    now,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 5);
  assert.ok(result.errors.some((e) => e.includes('outputDir')));
  assert.ok(result.errors.some((e) => e.includes('unknown field extra')));
});

test('a past deadline, a browse limit below the target and stray budget keys fail', () => {
  const result = validateCollectResumesInput(
    { ...input, deadline: '2026-10-04T07:00:00Z', browseLimit: 5, budget: { taskModelCalls: 3, retries: 9 } },
    now,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors, [
    'browseLimit must not be below requestedCount',
    'deadline is already past',
    'budget.retries is not a budget field',
  ]);
});

test('assertValid throws invalid_input with the errors attached', () => {
  assert.throws(
    () => assertValid(validateCollectResumesInput({}, now), 'input'),
    (e: unknown) => isRuntimeError(e, 'invalid_input') && Array.isArray(e.details?.errors),
  );
});

test('the planned boss task.json is a valid spec', () => {
  const spec = {
    schemaVersion: 1,
    id: 'boss.collect-resumes',
    version: '1.0.0',
    platforms: ['macos'],
    application: 'com.zhipin.www',
    windowProfile: 'boss-macos-1440x900',
    workflow: 'boss-resumes-v1',
    inputSchema: 'collect-resumes-input-v1',
    capabilities: ['ui.read', 'ui.navigate', 'resume.capture', 'artifact.write'],
    submitAllowed: false,
    foregroundAllowed: false,
    learning: { promoteAfterSuccesses: 3 },
    defaults: { captureMode: 'available', analysis: 'off' },
  };
  assert.equal(validateTaskSpec(spec).ok, true);
  assert.equal(validateTaskSpec({ ...spec, platforms: ['windows'] }).ok, false);
});

test('task statuses move only along the documented lifecycle', () => {
  assert.ok(canTransitionTask('queued', 'running'));
  assert.ok(canTransitionTask('running', 'waiting_user'));
  assert.ok(canTransitionTask('waiting_user', 'running'));
  assert.ok(canTransitionTask('running', 'cancelling'));
  assert.ok(canTransitionTask('cancelling', 'cancelled'));
  // Cancellation passes through cancelling once the task has started.
  assert.ok(!canTransitionTask('running', 'cancelled'));
  // Paused tasks resume before they can finish.
  assert.ok(!canTransitionTask('paused', 'succeeded'));
  for (const terminal of TERMINAL_TASK_STATUSES)
    for (const to of ['queued', 'running', 'succeeded', 'cancelled'] as TaskStatus[]) assert.ok(!canTransitionTask(terminal, to));
});

test('a committed work item is final and only committed items get there from validated', () => {
  const all: WorkItemStatus[] = ['discovered', 'processing', 'acquired', 'validated', 'committed', 'unavailable', 'failed', 'ambiguous'];
  for (const to of all) assert.ok(!canTransitionWorkItem('committed', to));
  assert.deepEqual(all.filter((from) => canTransitionWorkItem(from, 'committed')), ['validated']);
  // A crash in processing returns the item to be checked again.
  assert.ok(canTransitionWorkItem('processing', 'discovered'));
  assert.ok(canTransitionWorkItem('failed', 'processing'));
  assert.ok(!canTransitionWorkItem('ambiguous', 'processing'));
});

test('candidates dedupe within an account, by platform id before fingerprint', () => {
  assert.equal(candidateDedupeKey({ accountKey: 'acct1', platformId: 'p9', fingerprint: 'f' }), 'acct1:id:p9');
  assert.equal(candidateDedupeKey({ accountKey: 'acct1', fingerprint: 'f' }), 'acct1:fp:f');
  assert.notEqual(candidateDedupeKey({ accountKey: 'a', fingerprint: 'f' }), candidateDedupeKey({ accountKey: 'b', fingerprint: 'f' }));
});

test('path segments refuse traversal, separators and hidden names', () => {
  for (const ok of ['c_0001', '候选人-7', 'a.b']) assert.ok(safePathSegment(ok), ok);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a:b', 'tab\tname', 'x'.repeat(129)]) assert.ok(!safePathSegment(bad), bad);
});

test('coordinates convert between content fractions, screenshot pixels, model space and points', () => {
  const window = { frame: { x: 2600, y: 30, width: 1360, height: 848 }, contentFrame: { x: 2600, y: 58, width: 1360, height: 820 }, scale: 2 };
  const point = relativeToGlobal(window, { x: 0.5, y: 0.5 });
  assert.deepEqual(point, { x: 3280, y: 468 });
  assert.deepEqual(globalToRelative(window, point), { x: 0.5, y: 0.5 });
  // P0: a 1360x848 pt window came back as a 2720x1696 px screenshot.
  const shot = { covers: window.frame, widthPx: 2720, heightPx: 1696 };
  assert.deepEqual(screenshotToGlobal(shot, { x: 2720, y: 0 }), { x: 3960, y: 30 });
  assert.deepEqual(globalToScreenshotRect(shot, { x: 2663, y: 52, width: 734, height: 826 }), { x: 126, y: 44, width: 1468, height: 1652 });
  assert.deepEqual(normalizedToGlobal(window, { x: 500, y: 1000 }), { x: 3280, y: 878 });
});

test('element indexes need the snapshot they came from', () => {
  const policy = { submitAllowed: false };
  const click = { kind: 'click', target: { kind: 'element', index: 12 }, effect: 'navigation' };
  assert.deepEqual(validateActionRequest({ actionId: 'a1', action: click }, policy), {
    ok: false,
    errors: ['an element index needs the snapshotId it came from'],
  });
  assert.equal(validateActionRequest({ actionId: 'a1', action: click, snapshotId: 's1' }, policy).ok, true);
  const byLabel = { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '返回' }, effect: 'navigation' };
  assert.equal(validateActionRequest({ actionId: 'a2', action: byLabel }, policy).ok, true);
});

test('external-submit actions are refused unless the task allows them', () => {
  const send = { actionId: 'a3', action: { kind: 'key', key: 'return', effect: 'external-submit' } };
  assert.equal(validateActionRequest(send, { submitAllowed: false }).ok, false);
  assert.equal(validateActionRequest(send, { submitAllowed: true }).ok, true);
  const noEffect = { actionId: 'a4', action: { kind: 'key', key: 'return' } };
  assert.equal(validateActionRequest(noEffect, { submitAllowed: true }).ok, false);
});

test('waits are bounded and their conditions well formed', () => {
  const condition = { kind: 'page', pageClass: 'online_resume' };
  assert.deepEqual(validateWaitSpec({ condition, timeoutMs: 5000, pollMs: 200 }), []);
  assert.equal(validateWaitSpec({ condition, timeoutMs: 0 }).length, 1);
  assert.equal(validateWaitSpec({ condition, timeoutMs: 600_000 }).length, 1);
  assert.equal(validateWaitSpec({ condition, timeoutMs: 1000, pollMs: 1 }).length, 1);
  assert.ok(validateWaitSpec({ condition: { kind: 'text', pattern: '(', present: true }, timeoutMs: 10 })[0]?.includes('not a valid pattern'));
  assert.ok(validateWaitSpec({ condition: { kind: 'file', path: 'rel.pdf' }, timeoutMs: 10 })[0]?.includes('absolute'));
  let deep: unknown = condition;
  for (let i = 0; i < 6; i++) deep = { kind: 'all', conditions: [deep] };
  assert.ok(validateWaitSpec({ condition: deep, timeoutMs: 10 }).some((e) => e.includes('too deeply')));
});

test('a capture is complete only with a confirmed top and two bottom signals', () => {
  const base = { pages: 4, topConfirmed: true, bottomSignals: ['scroll_position_end', 'end_marker'] as const, stop: 'bottom_confirmed' as const };
  assert.equal(captureCompleteness({ ...base, bottomSignals: [...base.bottomSignals] }), 'complete');
  assert.equal(captureCompleteness({ ...base, bottomSignals: ['end_marker', 'end_marker'] }), 'partial_capture');
  assert.equal(captureCompleteness({ ...base, bottomSignals: [...base.bottomSignals], topConfirmed: false }), 'partial_capture');
  assert.equal(captureCompleteness({ ...base, bottomSignals: [...base.bottomSignals], stop: 'page_limit' }), 'partial_capture');
  assert.equal(captureCompleteness({ ...base, bottomSignals: [], stop: 'scroll_ineffective' }), 'partial_capture');
  assert.equal(captureCompleteness({ ...base, bottomSignals: [], pages: 0 }), 'invalid');
});

test('the capture mode decides which artifacts count', () => {
  const original = { kind: 'original', completeness: 'complete' } as const;
  const captured = { kind: 'captured_image', completeness: 'complete' } as const;
  const partial = { kind: 'captured_image', completeness: 'partial_capture' } as const;
  const text = { kind: 'resume_text', completeness: 'complete' } as const;
  assert.ok(isCountable([original], 'available'));
  assert.ok(isCountable([captured, text], 'available'));
  assert.ok(isCountable([original], 'original-only'));
  assert.ok(!isCountable([captured], 'original-only'));
  assert.ok(!isCountable([partial, text], 'available'));
  assert.ok(!isCountable([{ kind: 'original', completeness: 'unverified' }], 'available'));
  assert.ok(!isCountable([], 'available'));
});

test('unknown token counts stay unknown', () => {
  assert.equal(addTokens(3, 4), 7);
  assert.equal(addTokens(3, 'unknown'), 'unknown');
  assert.equal(addTokens('unknown', 0), 'unknown');
});

test('with a token cap, unknown tokens exhaust the budget and known ones are compared', () => {
  const budget = { ...DEFAULT_BUDGET, taskModelCalls: 3, taskTokens: 100 };
  assert.deepEqual(checkBudget(budget, emptyUsage()), { ok: true });
  assert.deepEqual(checkBudget(budget, { ...emptyUsage(), inputTokens: 60, outputTokens: 39 }), { ok: true });
  assert.deepEqual(checkBudget(budget, { ...emptyUsage(), inputTokens: 60, outputTokens: 40 }), { ok: false, exhausted: 'tokens' });
  assert.deepEqual(checkBudget(budget, { ...emptyUsage(), inputTokens: 'unknown', uiModelCalls: 1 }), { ok: false, exhausted: 'tokens' });
  assert.deepEqual(checkBudget(budget, { ...emptyUsage(), inputTokens: 10, outputTokens: 'unknown' }), { ok: false, exhausted: 'tokens' });
  // The call cap is checked first, so its reason wins when both apply.
  assert.deepEqual(checkBudget(budget, { ...emptyUsage(), inputTokens: 'unknown', uiModelCalls: 3 }), { ok: false, exhausted: 'model_calls' });
});

test('without a token cap, unknown tokens are allowed and calls and time still bound', () => {
  const budget = { ...DEFAULT_BUDGET, taskModelCalls: 3 };
  const unknown = { ...emptyUsage(), inputTokens: 'unknown' as const, outputTokens: 'unknown' as const };
  assert.deepEqual(checkBudget(budget, { ...unknown, uiModelCalls: 2 }), { ok: true });
  assert.deepEqual(checkBudget(budget, { ...unknown, uiModelCalls: 2, repairModelCalls: 1 }), { ok: false, exhausted: 'model_calls' });
  assert.deepEqual(checkBudget(budget, { ...unknown, elapsedMs: budget.wallClockMs }), { ok: false, exhausted: 'wall_clock' });
});

const counters = { successes: 0, failures: 0, successItemIds: [] as string[], consecutiveFailures: 0 };

test('a procedure becomes stable after three distinct work items succeed', () => {
  let state = { status: 'trial' as ProcedureV2['status'], counters };
  state = nextProcedureState(state, { itemId: 'i1', ok: true });
  state = nextProcedureState(state, { itemId: 'i1', ok: true });
  state = nextProcedureState(state, { itemId: 'i2', ok: true });
  assert.equal(state.status, 'trial');
  assert.deepEqual(state.counters.successItemIds, ['i1', 'i2']);
  assert.equal(state.counters.successes, 3);
  state = nextProcedureState(state, { itemId: 'i3', ok: true });
  assert.equal(state.status, 'stable');
});

test('a seeded procedure turns trial on its first verified success', () => {
  assert.equal(nextProcedureState({ status: 'seeded', counters }, { itemId: 'i1', ok: true }).status, 'trial');
});

test('a failure degrades a procedure, and a degraded one stays put until repaired', () => {
  const stable = { status: 'stable' as const, counters: { ...counters, successes: 3, successItemIds: ['a', 'b', 'c'] } };
  const failed = nextProcedureState(stable, { itemId: 'd', ok: false });
  assert.equal(failed.status, 'degraded');
  assert.equal(failed.counters.failures, 1);
  assert.deepEqual(nextProcedureState(failed, { itemId: 'e', ok: true }), failed);
  const lenient = nextProcedureState(stable, { itemId: 'd', ok: false }, { promoteAfterSuccesses: 3, degradeAfterFailures: 2 });
  assert.equal(lenient.status, 'stable');
  assert.deepEqual(lenient.counters.successItemIds, []);
  assert.equal(lenient.counters.successes, 3);
});

test('a failure below the degrade threshold breaks the promotion streak', () => {
  const rule = { promoteAfterSuccesses: 3, degradeAfterFailures: 2 };
  let state = { status: 'trial' as ProcedureV2['status'], counters };
  state = nextProcedureState(state, { itemId: 'i1', ok: true }, rule);
  state = nextProcedureState(state, { itemId: 'i2', ok: true }, rule);
  state = nextProcedureState(state, { itemId: 'i3', ok: false }, rule);
  assert.equal(state.status, 'trial');
  assert.deepEqual(state.counters.successItemIds, []);
  // Successes before the failure do not count toward stable.
  state = nextProcedureState(state, { itemId: 'i3', ok: true }, rule);
  state = nextProcedureState(state, { itemId: 'i4', ok: true }, rule);
  assert.equal(state.status, 'trial');
  assert.equal(state.counters.consecutiveFailures, 0);
  state = nextProcedureState(state, { itemId: 'i1', ok: true }, rule);
  assert.equal(state.status, 'stable');
  assert.deepEqual(state.counters.successItemIds, ['i3', 'i4', 'i1']);
  assert.equal(state.counters.successes, 5);
  assert.equal(state.counters.failures, 1);
});

test('lease scopes on the same app overlap whatever the account part', () => {
  assert.equal(leaseScopeKey('com.zhipin.www'), 'com.zhipin.www:*');
  assert.equal(leaseScopeKey('com.zhipin.www', 'acct1'), 'com.zhipin.www:acct1');
  assert.throws(() => leaseScopeKey('bad:id'), (e: unknown) => isRuntimeError(e, 'invalid_input'));
  assert.ok(leaseScopesOverlap('com.zhipin.www:*', 'com.zhipin.www:acct1'));
  assert.ok(leaseScopesOverlap('com.zhipin.www:acct1', 'com.zhipin.www:*'));
  assert.ok(leaseScopesOverlap('com.zhipin.www:acct1', 'com.zhipin.www:acct2'));
  assert.ok(leaseScopesOverlap('com.zhipin.www:acct1', 'com.zhipin.www:acct1'));
  assert.ok(!leaseScopesOverlap('com.zhipin.www:acct1', 'com.tencent.xinWeChat:acct1'));
});

const procedure = {
  schemaVersion: 2,
  id: 'proc-open-resume-1',
  key: { skill: 'boss.collect-resumes', skillVersion: '1.0.0', unit: 'open_resume', platform: 'macos', appVersion: '1.7.4', profile: 'boss-macos-1440x900' },
  version: 1,
  status: 'trial',
  source: 'learned',
  parameters: ['candidate.name'],
  preconditions: [{ kind: 'page', pageClass: 'conversation_detail' }],
  postconditions: [{ kind: 'any', conditions: [{ kind: 'page', pageClass: 'online_resume' }, { kind: 'page', pageClass: 'attachment_preview' }] }],
  steps: [
    {
      id: 's1',
      action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' },
      fallbacks: [{ kind: 'relative', point: { x: 0.82, y: 0.11 } }],
      expect: { condition: { kind: 'text', pattern: '{{candidate.name}}', present: true }, timeoutMs: 8000 },
    },
  ],
  counters: { ...counters, successes: 1, successItemIds: ['i1'] },
  createdAt: '2026-10-04T08:00:00Z',
  updatedAt: '2026-10-04T08:00:00Z',
};

test('a learned procedure validates and its slots are found', () => {
  const result = validateProcedure(procedure, { submitAllowed: false });
  assert.deepEqual(result, { ok: true, value: procedure });
  assert.deepEqual(stepSlots(procedure.steps[0] as ProcedureV2['steps'][number]), []);
  assert.equal(procedureKeyString(procedure.key as ProcedureV2['key']), 'boss.collect-resumes|1.0.0|open_resume|macos|1.7.4|boss-macos-1440x900|-');
});

test('stored procedures reject element indexes, unknown slots, submits and unearned stability', () => {
  const step = procedure.steps[0]!;
  const bad = {
    ...procedure,
    status: 'stable',
    counters,
    steps: [
      { ...step, action: { kind: 'click', target: { kind: 'element', index: 4 }, effect: 'navigation' } },
      { id: 's2', action: { kind: 'type', target: { kind: 'element', role: 'AXTextArea' }, value: 'hi {{greeting}}', effect: 'external-submit' } },
      { id: 's2', action: { kind: 'key', key: 'escape', effect: 'navigation' } },
    ],
  };
  const result = validateProcedure(bad, { submitAllowed: false });
  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const expected of ['cannot use element indexes', 'slot greeting', 'external-submit is not allowed', 'is repeated', 'verified successes'])
    assert.ok(result.errors.some((e) => e.includes(expected)), expected);
});

test('slots bind to values and an unbound slot is an error', () => {
  assert.equal(bindSlots('打开 {{candidate.name}} 的简历', { 'candidate.name': '张三' }), '打开 张三 的简历');
  assert.throws(() => bindSlots('{{missing}}', {}), (e: unknown) => isRuntimeError(e, 'invalid_input'));
});

const request: ExplorationRequest = {
  v: 1,
  taskId: 't1',
  unitAttemptId: 'u1',
  session: { socket: '/tmp/boss.sock', screenId: 'boss', pid: 4242, windowId: 77 },
  unit: { name: 'open_resume', goal: 'Open the online resume of {{candidate.name}}', allowedEffects: ['read', 'navigation'], expectedPostconditions: [{ kind: 'page', pageClass: 'online_resume' }] },
  parameters: { 'candidate.name': '张三' },
  budget: { maxRounds: 6, timeoutMs: 120_000 },
  submitAllowed: false,
};

test('exploration requests never allow submitting', () => {
  assert.equal(validateExplorationRequest(request).ok, true);
  assert.equal(validateExplorationRequest({ ...request, submitAllowed: true }).ok, false);
  assert.equal(validateExplorationRequest({ ...request, unit: { ...request.unit, allowedEffects: ['external-submit'] } }).ok, false);
  assert.equal(validateExplorationRequest({ ...request, budget: { maxRounds: 0, timeoutMs: 1 } }).ok, false);
});

const at = '2026-10-04T08:00:01Z';
const ids = { v: 1, taskId: 't1', unitAttemptId: 'u1', at };

test('every bridge event type parses from one JSON line', () => {
  const action = { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' };
  const window = { pid: 1, windowId: 2, bundleId: 'com.zhipin.www', title: 'BOSS直聘', frame: { x: 0, y: 0, width: 1360, height: 848 }, contentFrame: { x: 0, y: 28, width: 1360, height: 820 }, scale: 2, displayId: 5 };
  const events = [
    { ...ids, type: 'observed', snapshotId: 'snap1', window },
    { ...ids, type: 'action_started', stepId: 'st1', action },
    { ...ids, type: 'action_finished', stepId: 'st1', action, result: { actionId: 'st1', status: 'ok', startedAt: at, finishedAt: at } },
    { ...ids, type: 'model_usage', purpose: 'ui', reason: 'missing_procedure', inputTokens: 1200, outputTokens: 'unknown' },
    { ...ids, type: 'unit_finished', steps: 1 },
    { ...ids, type: 'unit_failed', reason: 'model_unavailable', message: 'no model key' },
  ];
  for (const event of events) {
    const line = encodeJsonLine(event);
    assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
    const parsed = parseBridgeEvent(line.trim(), { taskId: 't1', unitAttemptId: 'u1' });
    assert.deepEqual(parsed, { ok: true, value: event }, event.type);
  }
});

test('bridge lines that are malformed, foreign or submitting are rejected', () => {
  assert.deepEqual(parseBridgeEvent('not json'), { ok: false, errors: ['line is not JSON'] });
  const foreign = parseBridgeEvent(JSON.stringify({ ...ids, taskId: 'other', type: 'unit_finished', steps: 0 }), { taskId: 't1', unitAttemptId: 'u1' });
  assert.equal(foreign.ok, false);
  const submit = { ...ids, type: 'action_started', stepId: 's', action: { kind: 'key', key: 'return', effect: 'external-submit' } };
  assert.equal(parseBridgeEvent(JSON.stringify(submit)).ok, false);
  const zeroTokens = { ...ids, type: 'model_usage', purpose: 'ui', reason: 'missing_procedure', inputTokens: null, outputTokens: 0 };
  assert.equal(parseBridgeEvent(JSON.stringify(zeroTokens)).ok, false);
  assert.equal(parseBridgeEvent(JSON.stringify({ ...ids, type: 'dance' })).ok, false);
});

test('aborted signals turn into cancelled errors before side effects', () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal));
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), (e: unknown) => e instanceof RuntimeError && e.code === 'cancelled');
});

test('the BOSS units are the eight in the plan, in order', () => {
  assert.deepEqual(BOSS_UNITS, ['select_source', 'enumerate_candidates', 'open_candidate', 'open_resume', 'acquire_resume', 'persist_candidate', 'return_to_list', 'advance_list']);
});
