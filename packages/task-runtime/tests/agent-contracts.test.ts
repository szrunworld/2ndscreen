import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_PROTOCOL,
  AGENT_RUNTIME_CONTRACT_VERSION,
  agentSpecFromTaskSpec,
  isPackagePath,
  parseAgentMessage,
  parseRuntimeMessage,
  parseVersionRange,
  satisfiesRange,
  stricterApproval,
  validateAgentSpec,
  type AgentMessage,
  type AgentSpec,
  type ExpectedMessage,
  type RuntimeMessage,
} from '../src/agent-contracts.ts';
import { assertValid, encodeJsonLine, validateTaskSpec } from '../src/contracts.ts';

const spec: AgentSpec = {
  schemaVersion: 2,
  id: 'remotedesk.boss-recruiter',
  version: '0.1.0',
  runtimeContract: '>=2 <3',
  platforms: ['macos'],
  applications: [{ bundleId: 'com.zhipin.www', versions: '>=1.7.4 <2', windowProfile: 'boss-macos-1440x900' }],
  mode: 'resident',
  executor: { kind: 'process', command: ['bin/boss-agent', 'serve'], protocol: AGENT_PROTOCOL, runtime: { kind: 'python', version: '3.12', bundled: true } },
  tasks: { 'request-resumes': { inputSchema: 'request-resumes-input-v1' }, 'collect-resumes': { inputSchema: 'collect-resumes-input-v1' } },
  effects: ['read', 'navigation', 'artifact', 'external-submit'],
  capabilities: ['ui.read', 'ui.navigate', 'artifact.write'],
  providers: [{ id: 'ark-text', purposes: ['draft'] }],
  identity: { required: true, audience: 'recruiting.remotedesk.io' },
  limits: { 'external-submit': { perDay: 20, minIntervalMs: 45_000 } },
  approval: { 'external-submit': 'human_in_the_loop' },
  schedule: { workHours: 'org', idlePollSeconds: 60 },
  foregroundAllowed: false,
  learning: { promoteAfterSuccesses: 3 },
  skills: ['SKILL.md'],
};

const errorsOf = (raw: unknown): string[] => {
  const r = validateAgentSpec(raw);
  return r.ok ? [] : r.errors;
};
const hasError = (errors: string[], fragment: string) => assert.ok(errors.some((e) => e.includes(fragment)), `expected an error mentioning "${fragment}" in ${JSON.stringify(errors)}`);

test('the RFC example manifest passes', () => {
  assert.deepEqual(validateAgentSpec(spec), { ok: true, value: spec });
  assert.ok(satisfiesRange(AGENT_RUNTIME_CONTRACT_VERSION, spec.runtimeContract));
});

test('a task-mode process agent without external-submit needs no schedule or approval', () => {
  const quiet: AgentSpec = {
    ...spec,
    id: 'wechat.add-friends',
    mode: 'task',
    effects: ['read', 'navigation'],
    identity: undefined,
    limits: {},
    approval: {},
    schedule: undefined,
  };
  const { identity: _i, schedule: _s, ...raw } = quiet;
  assert.equal(validateAgentSpec(raw).ok, true);
});

test('every manifest problem is named at once', () => {
  const errors = errorsOf({
    ...spec,
    schemaVersion: 1,
    id: '/bad id',
    version: '1.0',
    runtimeContract: 'latest',
    platforms: ['windows'],
    applications: [
      { bundleId: 'com.zhipin.www', windowProfile: 'p' },
      { bundleId: 'com.zhipin.www', windowProfile: 'p', extra: 1 },
    ],
    mode: 'daemon',
    tasks: { 'Bad Type': { inputSchema: '' } },
    effects: ['read', 'read', 'teleport'],
    providers: [{ id: 'x', purposes: ['fly'] }],
    identity: { required: true },
    limits: { 'external-submit': {} , navigation: { perDay: 0 } },
    approval: { 'external-submit': 'maybe' },
    schedule: { workHours: 'never', idlePollSeconds: 1 },
    learning: { promoteAfterSuccesses: 0 },
    skills: ['../SKILL.md'],
    unknownField: true,
  });
  for (const fragment of [
    'schemaVersion must be 2',
    'id must be',
    'version must be a semantic version',
    'runtimeContract',
    'platforms must be',
    'applications[1].bundleId repeats',
    'applications[1].extra',
    'mode must be task or resident',
    'tasks.Bad Type',
    'effects repeats read',
    'teleport is not an effect class',
    'providers[0].purposes',
    'identity.audience is required',
    'limits.external-submit must set',
    'limits.navigation.perDay',
    'approval.external-submit must be one of',
    'schedule.workHours',
    'schedule.idlePollSeconds',
    'learning.promoteAfterSuccesses',
    'skills must list',
    'unknownField is not a field',
  ])
    hasError(errors, fragment);
});

test('external-submit must come with an explicit approval mode', () => {
  hasError(errorsOf({ ...spec, approval: {} }), 'approval.external-submit is required');
});

test('limits and approval may only name declared effects', () => {
  const errors = errorsOf({ ...spec, effects: ['read'], limits: { navigation: { perDay: 1 } }, approval: {} });
  hasError(errors, 'limits.navigation names an effect the agent does not declare');
});

test('a resident agent needs a schedule and cannot be built in', () => {
  const { schedule: _s, ...noSchedule } = spec;
  hasError(errorsOf(noSchedule), 'schedule is required for a resident agent');
  hasError(errorsOf({ ...spec, executor: { kind: 'builtin', workflow: 'boss-resumes-v1' } }), 'builtin runs tasks only');
});

test('executor commands stay inside the package', () => {
  hasError(errorsOf({ ...spec, executor: { ...spec.executor, command: ['/usr/bin/python3'] } }), 'executor.command[0] must be a path inside the package');
  hasError(errorsOf({ ...spec, executor: { ...spec.executor, command: ['../x/run'] } }), 'executor.command[0]');
  hasError(errorsOf({ ...spec, executor: { ...spec.executor, protocol: 'skill-jsonl/1' } }), `executor.protocol must be ${AGENT_PROTOCOL}`);
  hasError(errorsOf({ ...spec, executor: { kind: 'mcp', command: ['bin/serve'], protocol: 'agent-jsonl/1' } }), 'executor.protocol must be agent-mcp/1');
  assert.equal(isPackagePath('bin/run'), true);
  assert.equal(isPackagePath('./bin/run'), false);
  assert.equal(isPackagePath('bin//run'), false);
  assert.equal(isPackagePath('C:\\run'), false);
});

test('the shipped boss-resumes task.json reads as a read-only task agent', () => {
  const taskJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../skills/boss-resumes/task.json'), 'utf8'));
  const adapted = agentSpecFromTaskSpec(assertValid(validateTaskSpec(taskJson), 'task.json'));
  assert.equal(validateAgentSpec(adapted).ok, true, JSON.stringify(validateAgentSpec(adapted)));
  assert.equal(adapted.mode, 'task');
  assert.deepEqual(adapted.executor, { kind: 'builtin', workflow: 'boss-resumes-v1' });
  assert.deepEqual(adapted.applications, [{ bundleId: 'com.zhipin.www', windowProfile: 'boss-macos-1440x900' }]);
  assert.deepEqual(Object.keys(adapted.tasks), ['collect-resumes']);
  assert.ok(!adapted.effects.includes('external-submit'));
  assert.ok(satisfiesRange(AGENT_RUNTIME_CONTRACT_VERSION, adapted.runtimeContract));
});

test('version ranges', () => {
  assert.deepEqual(parseVersionRange('>=2 <3'), { ok: true, value: [{ op: '>=', version: [2] }, { op: '<', version: [3] }] });
  assert.deepEqual(parseVersionRange('1.7.4'), { ok: true, value: [{ op: '=', version: [1, 7, 4] }] });
  assert.equal(parseVersionRange('').ok, false);
  assert.equal(parseVersionRange('>=2 || <1').ok, false);
  assert.equal(parseVersionRange('^1.2').ok, false);
  assert.equal(satisfiesRange('2.0.0', '>=2 <3'), true);
  assert.equal(satisfiesRange('2.9.9', '>=2 <3'), true);
  assert.equal(satisfiesRange('3.0.0', '>=2 <3'), false);
  assert.equal(satisfiesRange('1.7.4', '>=1.7.4 <2'), true);
  assert.equal(satisfiesRange('1.7.3', '>=1.7.4 <2'), false);
  assert.equal(satisfiesRange('1.8', '>=1.7.4 <2'), true);
  assert.equal(satisfiesRange('2.0.0-beta.1', '>=2 <3'), true);
  assert.equal(satisfiesRange('1.7.4', '=1.7.4'), true);
  assert.equal(satisfiesRange('1.7.4', '1.7.5'), false);
  assert.equal(satisfiesRange('not a version', '>=1'), false);
  assert.equal(satisfiesRange('1.0.0', 'nonsense'), false);
});

test('the stricter approval mode wins', () => {
  assert.equal(stricterApproval('trusted_within_ceiling', 'human_in_the_loop'), 'human_in_the_loop');
  assert.equal(stricterApproval('locked_down', 'human_in_the_loop'), 'locked_down');
  assert.equal(stricterApproval('trusted_within_ceiling', 'trusted_within_ceiling'), 'trusted_within_ceiling');
});

// ---------------------------------------------------------------------------
// Agent → runtime

const run: ExpectedMessage = { agentRunId: 'run-1' };
const base = { v: 1, agentRunId: 'run-1', at: '2026-10-07T08:00:00Z' } as const;
const line = (m: Record<string, unknown>) => encodeJsonLine({ ...base, ...m });
const accept = (m: Record<string, unknown>, expected = run): AgentMessage => assertValid(parseAgentMessage(line(m), expected), 'message');
const refuse = (m: Record<string, unknown>, fragment: string, expected = run) => {
  const r = parseAgentMessage(line(m), expected);
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(m)}`);
  if (!r.ok) hasError(r.errors, fragment);
};

test('every agent message type parses when well-formed', () => {
  const click = { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '求简历' }, effect: 'external-submit' };
  const messages: Array<Record<string, unknown>> = [
    { seq: 1, type: 'observe', taskId: 't1', requestId: 'r1', app: 'com.zhipin.www', elements: true, screenshot: { region: { x: 0, y: 0, width: 10, height: 10 } } },
    { seq: 2, type: 'act', taskId: 't1', requestId: 'r2', app: 'com.zhipin.www', action: click, snapshotId: 's1' },
    { seq: 3, type: 'wait', taskId: 't1', requestId: 'r3', app: 'com.zhipin.www', wait: { condition: { kind: 'text', pattern: '已发送', present: true }, timeoutMs: 5000 } },
    { seq: 4, type: 'provider', taskId: 't1', requestId: 'r4', providerId: 'ark-text', purpose: 'draft', input: { prompt: '…' } },
    { seq: 5, type: 'ask_approval', taskId: 't1', approvalId: 'a1', effect: 'external-submit', summary: '向 1 位候选人求简历', action: click, target: 'cand:abc' },
    { seq: 6, type: 'ask_user', taskId: 't1', reason: 'login_required', message: '请登录' },
    { seq: 7, type: 'create_task', requestId: 'r5', taskType: 'request-resumes', input: { candidateKey: 'k' } },
    { seq: 8, type: 'item', taskId: 't1', itemId: 'i1', status: 'committed', data: { count: 1 } },
    { seq: 9, type: 'artifact', taskId: 't1', path: 'resume.pdf', kind: 'original', completeness: 'complete', sha256: 'a'.repeat(64) },
    { seq: 10, type: 'unit_started', taskId: 't1', unitAttemptId: 'u1', unit: 'open_resume' },
    { seq: 11, type: 'unit_finished', taskId: 't1', unitAttemptId: 'u1', unit: 'open_resume', ok: true },
    { seq: 12, type: 'heartbeat', state: 'idle', summary: '0 new' },
    { seq: 13, type: 'task_finished', taskId: 't1', status: 'succeeded', terminationReason: 'target_reached' },
    { seq: 14, type: 'task_failed', taskId: 't1', reason: 'provider_unavailable', message: 'no model' },
    { seq: 15, type: 'agent_stopped', reason: 'work_hours' },
  ];
  let last = 0;
  for (const m of messages) {
    const parsed = accept(m, { agentRunId: 'run-1', lastSeq: last });
    assert.equal(parsed.type, m.type);
    last = parsed.seq;
  }
});

test('agent messages from another run, out of order, or of unknown type are refused', () => {
  refuse({ seq: 1, type: 'heartbeat', state: 'idle' }, 'another agent run', { agentRunId: 'run-2' });
  refuse({ seq: 3, type: 'heartbeat', state: 'idle' }, 'seq must be greater than 3', { agentRunId: 'run-1', lastSeq: 3 });
  refuse({ seq: 0, type: 'heartbeat', state: 'idle' }, 'seq must be an integer >= 1');
  refuse({ seq: 1, type: 'teleport' }, 'type is not an agent message type');
  refuse({ seq: 1, type: 'heartbeat', state: 'idle', v: 2 }, 'v must be 1');
  assert.deepEqual(parseAgentMessage('not json'), { ok: false, errors: ['line is not JSON'] });
  assert.deepEqual(parseAgentMessage('[1]'), { ok: false, errors: ['message must be an object'] });
});

test('task-scoped agent messages must say which task', () => {
  for (const type of ['observe', 'act', 'wait', 'ask_approval', 'ask_user', 'item', 'artifact', 'unit_started', 'unit_finished', 'task_finished', 'task_failed'])
    refuse({ seq: 1, type }, `${type} must carry taskId`);
  // create_task and heartbeat are run-scoped.
  accept({ seq: 1, type: 'create_task', requestId: 'r', taskType: 'collect-resumes', input: {} });
  accept({ seq: 1, type: 'heartbeat', state: 'working' });
});

test('malformed agent message bodies are named', () => {
  refuse({ seq: 1, type: 'observe', taskId: 't', requestId: 'r', app: 'bad:app' }, 'app must be a bundle id');
  refuse({ seq: 1, type: 'observe', taskId: 't', requestId: 'r', app: 'com.x', screenshot: { region: { x: 0 } } }, 'screenshot must be boolean or { region }');
  refuse({ seq: 1, type: 'act', taskId: 't', requestId: 'r', app: 'com.x', action: { kind: 'click', target: { kind: 'element' } } }, 'effect');
  refuse({ seq: 1, type: 'act', taskId: 't', requestId: 'r', app: 'com.x', action: { kind: 'fly', effect: 'read' } }, 'action');
  refuse({ seq: 1, type: 'wait', taskId: 't', requestId: 'r', app: 'com.x', wait: { condition: { kind: 'text', pattern: 'x', present: true }, timeoutMs: 10_000_000 } }, 'wait');
  refuse({ seq: 1, type: 'provider', requestId: 'r', providerId: 'p', purpose: 'fly', input: 1 }, 'purpose must be one of');
  refuse({ seq: 1, type: 'provider', requestId: 'r', providerId: 'p', purpose: 'draft' }, 'input is required');
  refuse({ seq: 1, type: 'ask_approval', taskId: 't', approvalId: 'a', effect: 'read' }, 'summary is required');
  refuse({ seq: 1, type: 'create_task', requestId: 'r', taskType: 'Bad', input: {} }, 'taskType must be a task type name');
  refuse({ seq: 1, type: 'item', taskId: 't', itemId: 'i', status: 'done' }, 'status is not a work item status');
  refuse({ seq: 1, type: 'artifact', taskId: 't', path: 'a', kind: 'original', completeness: 'complete', sha256: 'xyz' }, 'sha256 must be 64 hex digits');
  refuse({ seq: 1, type: 'heartbeat', state: 'sleeping' }, 'state must be');
  refuse({ seq: 1, type: 'task_finished', taskId: 't', status: 'failed' }, 'status must be succeeded or partial');
  refuse({ seq: 1, type: 'task_failed', taskId: 't', reason: 'oops', message: 'x' }, 'reason is not a failure reason');
  refuse({ seq: 1, type: 'agent_stopped', reason: 'bored' }, 'reason must be stop, work_hours or error');
});

test('the parser does not judge effects; external-submit parses and the check chain decides', () => {
  const parsed = accept({
    seq: 1,
    type: 'act',
    taskId: 't',
    requestId: 'r',
    app: 'com.zhipin.www',
    action: { kind: 'click', target: { kind: 'element', label: '确定' }, effect: 'external-submit' },
  });
  assert.equal(parsed.type, 'act');
  if (parsed.type === 'act') assert.equal(parsed.action.effect, 'external-submit');
});

// ---------------------------------------------------------------------------
// Runtime → agent

const acceptRuntime = (m: Record<string, unknown>, expected = run): RuntimeMessage => assertValid(parseRuntimeMessage(line(m), expected), 'message');
const refuseRuntime = (m: Record<string, unknown>, fragment: string) => {
  const r = parseRuntimeMessage(line(m), run);
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(m)}`);
  if (!r.ok) hasError(r.errors, fragment);
};

const grant = {
  agentId: spec.id,
  application: 'com.zhipin.www',
  accountKey: 'hr-zhang',
  effect: 'external-submit',
  mode: 'human_in_the_loop',
  grantedAt: '2026-10-07T00:00:00Z',
  expiresAt: '2026-10-14T00:00:00Z',
  durable: false,
  grantedBy: 'user',
};

test('every runtime message type parses when well-formed', () => {
  const messages: Array<Record<string, unknown>> = [
    {
      seq: 1,
      type: 'agent_start',
      agent: { id: spec.id, version: '0.1.0', mode: 'resident' },
      account: { platform: 'boss', accountKey: 'hr-zhang', binding: 'explicit' },
      grants: [grant],
      schedule: { workHours: 'org', windows: ['09:00-12:00', '13:30-18:30'], timezone: 'Asia/Shanghai', idlePollSeconds: 60 },
      identity: { displayName: '张三', organization: 'RemoteDesk', role: 'recruiter' },
      resume: { tasks: [{ taskId: 't0', taskType: 'request-resumes', checkpoint: { cursor: 3 } }] },
    },
    { seq: 2, type: 'task_start', taskId: 't1', taskType: 'request-resumes', input: {}, budget: {}, session: { screenId: 'boss', apps: [{ bundleId: 'com.zhipin.www', pid: 4242, windowId: 77 }] } },
    { seq: 3, type: 'observation', taskId: 't1', requestId: 'r1', app: 'com.zhipin.www', observation: { snapshotId: 's1', sessionId: 'ses', takenAt: base.at, window: { frame: {}, contentFrame: {}, scale: 2 } } },
    { seq: 4, type: 'action_result', taskId: 't1', requestId: 'r2', result: { actionId: 'r2', status: 'ok', startedAt: base.at, finishedAt: base.at } },
    { seq: 5, type: 'action_result', taskId: 't1', requestId: 'r3', refusal: { reason: 'too_fast', message: 'wait', nextSteps: [{ kind: 'wait', ms: 30_000 }, { kind: 'use_read_only' }] } },
    { seq: 6, type: 'provider_result', requestId: 'r4', ok: true, output: { text: '您好' }, usage: { inputTokens: 100, outputTokens: 'unknown' } },
    { seq: 7, type: 'provider_result', requestId: 'r5', ok: false, reason: 'provider_undeclared', message: 'not in manifest' },
    { seq: 8, type: 'grant', taskId: 't1', approvalId: 'a1' },
    { seq: 9, type: 'deny', taskId: 't1', approvalId: 'a2', guidance: { text: '太快了', hints: ['too_fast', 'not_now'] } },
    { seq: 10, type: 'task_created', requestId: 'r6', taskId: 't2' },
    { seq: 11, type: 'pause', taskId: 't1' },
    { seq: 12, type: 'resume', taskId: 't1' },
    { seq: 13, type: 'cancel', taskId: 't1' },
    { seq: 14, type: 'stop' },
  ];
  let last = 0;
  for (const m of messages) {
    const parsed = acceptRuntime(m, { agentRunId: 'run-1', lastSeq: last });
    assert.equal(parsed.type, m.type);
    last = parsed.seq;
  }
});

test('runtime messages are checked for the same base and shape rules', () => {
  refuseRuntime({ seq: 1, type: 'agent_start', agent: { id: 'x' }, grants: [] }, 'agent must carry id, version and mode');
  refuseRuntime({ seq: 1, type: 'agent_start', agent: { id: 'x', version: '1.0.0', mode: 'task' }, grants: [{ ...grant, durable: false, expiresAt: undefined }] }, 'grants[0].expiresAt is required unless durable');
  refuseRuntime({ seq: 1, type: 'agent_start', agent: { id: 'x', version: '1.0.0', mode: 'task' }, grants: [], schedule: { workHours: 'org', timezone: 'Asia/Shanghai', idlePollSeconds: 60, windows: ['9-18'] } }, 'schedule.windows');
  refuseRuntime({ seq: 1, type: 'task_start', taskId: 't', taskType: 'x', input: {}, budget: {}, session: { screenId: 's', apps: [{ bundleId: 'b', pid: 0, windowId: 1 }] } }, 'session.apps[0]');
  refuseRuntime({ seq: 1, type: 'action_result', taskId: 't', requestId: 'r' }, 'exactly one of result or refusal');
  refuseRuntime({ seq: 1, type: 'action_result', taskId: 't', requestId: 'r', result: { actionId: 'r', status: 'ok' }, refusal: { reason: 'too_fast', message: '', nextSteps: [] } }, 'exactly one of result or refusal');
  refuseRuntime({ seq: 1, type: 'action_result', taskId: 't', requestId: 'r', refusal: { reason: 'because', message: '', nextSteps: [] } }, 'refusal must carry reason and message');
  refuseRuntime({ seq: 1, type: 'action_result', taskId: 't', requestId: 'r', refusal: { reason: 'too_fast', message: '', nextSteps: [{ kind: 'wait', ms: 0 }] } }, 'refusal.nextSteps[0].ms');
  refuseRuntime({ seq: 1, type: 'provider_result', requestId: 'r', ok: 'yes' }, 'ok must be boolean');
  refuseRuntime({ seq: 1, type: 'deny', taskId: 't', approvalId: 'a', guidance: { hints: ['because'] } }, 'guidance.hints must be approval hints');
  refuseRuntime({ seq: 1, type: 'stop', agentRunId: 'other' }, 'another agent run');
  refuseRuntime({ seq: 1, type: 'teleport' }, 'type is not a runtime message type');
});
