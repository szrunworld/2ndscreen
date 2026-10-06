import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLineProcessSpawner } from '../src/adapters/agent-bridge.ts';
import { AGENT_PROTOCOL, validateAgentSpec, type AgentSpec, type Grant } from '../src/agent-contracts.ts';
import {
  agentCommand,
  checkAction,
  createMemoryEffectLedger,
  effectiveLimit,
  runAgentTask,
  type AgentTaskOptions,
  type Approver,
  type Asker,
  type EffectUse,
  type UserQuestion,
  type HostEvent,
} from '../src/agent-host.ts';
import { createStatusBoard } from '../src/agent-status.ts';
import { createFileEffectLedger, createMemoryUsageLedger, summarizeUsage } from '../src/agent-ledgers.ts';
import { DEFAULT_BUDGET, RuntimeError, isRuntimeError, type ActionRequest, type ActionStatus, type Clock, type Session, type WindowGeometry } from '../src/contracts.ts';

// A real child process plays the agent: it sends the steps its task input
// lists, one at a time, waiting for each answer, then reports the answers
// and what its environment held. Sessions are fakes; nothing touches a
// desktop, an app or a model.

const AGENT_SOURCE = String.raw`
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let seq = 0, runId, taskId, input, n = 0, lastSnapshot, lastApproval;
const responses = [];
const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, agentRunId: runId, seq: ++seq, at: new Date().toISOString(), ...m }) + '\n');
const ask = (m, key) => new Promise((r) => { pending.set(key, r); send(m); });
process.on('SIGTERM', () => { if (!input?.ignoreSigterm) process.exit(143); });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'agent_start') { runId = m.agentRunId; return; }
  if (m.type === 'task_start') { taskId = m.taskId; input = m.input; void run(); return; }
  if (m.type === 'cancel') {
    if (input?.ignoreCancel) return;
    send({ type: 'task_failed', taskId, reason: 'cancelled', message: 'cancelled' });
    process.exit(1);
  }
  const key = m.requestId ?? m.approvalId ?? m.questionId;
  const resolve = pending.get(key);
  if (resolve) { pending.delete(key); resolve(m); }
});
const fill = (step) => JSON.parse(JSON.stringify(step)
  .replaceAll('"$snapshot"', JSON.stringify(lastSnapshot ?? 'none'))
  .replaceAll('"$approval"', JSON.stringify(lastApproval ?? 'none')));
function summarize(r) {
  if (r.type === 'observation') return { type: r.type, snapshotId: r.observation.snapshotId, ...(r.check && { check: r.check.ok }) };
  if (r.type === 'action_result') return r.refusal
    ? { type: r.type, refusal: r.refusal.reason, wait: r.refusal.nextSteps.find((s) => s.kind === 'wait')?.ms ?? null }
    : { type: r.type, status: r.result.status };
  if (r.type === 'provider_result') return { type: r.type, ok: r.ok, reason: r.reason ?? null, output: r.output ?? null };
  return { type: r.type };
}
async function run() {
  if (input.hang) return;
  for (const raw of input.steps ?? []) {
    if (raw.rawLine) { process.stdout.write(raw.rawLine + '\n'); continue; }
    const step = fill(raw);
    if (step.type === 'ask_user' && step.questionId) {
      const r = await ask({ taskId, ...step }, step.questionId);
      responses.push({ type: r.type, answer: r.answer });
      continue;
    }
    if (step.pauseMs) { await new Promise((r) => setTimeout(r, step.pauseMs)); continue; }
    if (['heartbeat', 'item', 'artifact', 'ask_user', 'unit_started', 'unit_finished'].includes(step.type)) { send({ taskId, ...step }); continue; }
    if (step.type === 'ask_approval') {
      const id = 'a' + ++n;
      const r = await ask({ taskId, approvalId: id, ...step }, id);
      if (r.type === 'grant') lastApproval = id;
      responses.push({ type: r.type, hints: r.guidance?.hints ?? null });
      continue;
    }
    const id = 'r' + ++n;
    const r = await ask({ taskId, requestId: id, ...step }, id);
    if (r.type === 'observation') lastSnapshot = r.observation.snapshotId;
    responses.push(summarize(r));
  }
  send({ type: 'item', taskId, itemId: 'report', status: 'committed', data: {
    responses,
    env: {
      secret: process.env.SECRET_FOR_TEST ?? null,
      socket: process.env.SECONDSCREEN_SOCKET ?? null,
      runIdMatches: process.env.AGENT_DESKTOP_RUN_ID === runId,
      agent: process.env.AGENT_DESKTOP_AGENT_ID ?? null,
      protocol: process.env.AGENT_DESKTOP_PROTOCOL ?? null,
    },
  } });
  if (input.waitForCancel) return;
  if (input.finish === 'exit') process.exit(0);
  send({ type: 'task_finished', taskId, status: input.finish ?? 'succeeded' });
  rl.close();
}
`;

const BOSS = 'com.zhipin.www';
const MAIL = 'com.apple.mail';
const FRAME = { x: 3000, y: 25, width: 1440, height: 900 };
const windowOf = (bundleId: string, pid: number): WindowGeometry => ({ pid, windowId: pid + 1, bundleId, title: bundleId, frame: FRAME, contentFrame: FRAME, scale: 2, displayId: 7 });

const spec: AgentSpec = {
  schemaVersion: 2,
  id: 'test.echo',
  version: '0.1.0',
  runtimeContract: '>=2 <3',
  platforms: ['macos'],
  applications: [
    { bundleId: BOSS, windowProfile: 'boss-macos-1440x900' },
    { bundleId: MAIL, windowProfile: 'mail-1440x900' },
  ],
  mode: 'task',
  executor: { kind: 'process', command: ['bin/echo-agent.mjs'], protocol: AGENT_PROTOCOL, runtime: { kind: 'node', bundled: false } },
  tasks: { echo: { inputSchema: 'echo-input-v1' } },
  effects: ['read', 'navigation', 'external-submit'],
  capabilities: ['ui.read'],
  providers: [{ id: 'ark-text', purposes: ['draft'] }],
  limits: {},
  approval: { 'external-submit': 'human_in_the_loop' },
  foregroundAllowed: false,
  learning: { promoteAfterSuccesses: 3 },
  skills: ['SKILL.md'],
};

/** An agent whose own manifest lets a trusted grant skip per-action approval. */
const trustedSpec: AgentSpec = { ...spec, approval: { 'external-submit': 'trusted_within_ceiling' } };

let packageDir: string;
test.before(async () => {
  assert.equal(validateAgentSpec(spec).ok, true, JSON.stringify(validateAgentSpec(spec)));
  packageDir = await mkdtemp(join(tmpdir(), 'agent-host-'));
  await mkdir(join(packageDir, 'bin'));
  await writeFile(join(packageDir, 'bin', 'echo-agent.mjs'), AGENT_SOURCE);
});
test.after(async () => {
  await rm(packageDir, { recursive: true, force: true });
});

interface FakeSession extends Session {
  readonly acts: ActionRequest[];
}

function fakeSession(bundleId: string, pid: number, statuses: ActionStatus[] = []): FakeSession {
  let k = 0;
  const acts: ActionRequest[] = [];
  const window = windowOf(bundleId, pid);
  const session = {
    id: `ses-${bundleId}`,
    taskId: 't1',
    acts,
    binding: () => ({ screenId: 'agents', socket: '/tmp/never-given-to-agents.sock', window, launchedByRuntime: false }),
    observe: async () => ({ snapshotId: `${bundleId}#${++k}`, sessionId: `ses-${bundleId}`, takenAt: new Date().toISOString(), window }),
    act: async (request: ActionRequest) => {
      acts.push(request);
      const now = new Date().toISOString();
      return { actionId: request.actionId, status: statuses.shift() ?? 'ok', startedAt: now, finishedAt: now };
    },
    waitFor: async () => ({ ok: true, evidence: ['matched'], elapsedMs: 5 }),
  };
  return session as unknown as FakeSession;
}

/** A clock that moves a minute every time it is read, so interval limits never get in the way unless a test wants them to. */
function steppingClock(start = Date.parse('2026-10-07T02:00:00Z'), stepMs = 60_000): Clock {
  let t = start;
  return { now: () => new Date((t += stepMs)) };
}

const grantFor = (mode: Grant['mode'], overrides: Partial<Grant> = {}): Grant => ({
  agentId: spec.id,
  application: BOSS,
  accountKey: 'hr-zhang',
  effect: 'external-submit',
  mode,
  grantedAt: '2026-10-07T00:00:00Z',
  expiresAt: '2026-10-14T00:00:00Z',
  durable: false,
  grantedBy: 'user',
  ...overrides,
});

const submit = (target?: string, extra: Record<string, unknown> = {}) => ({
  type: 'act',
  app: BOSS,
  action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '求简历' }, effect: 'external-submit' },
  ...(target !== undefined && { target }),
  ...extra,
});
const navigate = (app = BOSS, extra: Record<string, unknown> = {}) => ({
  type: 'act',
  app,
  action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '沟通' }, effect: 'navigation' },
  ...extra,
});

async function runEcho(input: Record<string, unknown>, overrides: Partial<AgentTaskOptions> = {}) {
  const sessions = (overrides.sessions as Map<string, FakeSession> | undefined) ?? new Map([
    [BOSS, fakeSession(BOSS, 4242)],
    [MAIL, fakeSession(MAIL, 5252)],
  ]);
  const events: HostEvent[] = [];
  const ledger = overrides.ledger ?? createMemoryEffectLedger();
  const outcome = await runAgentTask({
    packageDir,
    spec,
    task: { taskId: 't1', taskType: 'echo', input, budget: DEFAULT_BUDGET },
    account: { platform: 'boss', accountKey: 'hr-zhang', binding: 'explicit' },
    sessions,
    screenId: 'agents',
    grants: [],
    ledger,
    spawn: createLineProcessSpawner({ inheritEnv: false }),
    interpreters: { node: process.execPath },
    hostEnv: { ...process.env, SECRET_FOR_TEST: 'must-not-leak', SECONDSCREEN_SOCKET: '/tmp/2ndscreen.sock' },
    timeoutMs: 10_000,
    killGraceMs: 300,
    clock: steppingClock(),
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  const report = outcome.items.find((i) => i.itemId === 'report')?.data as { responses: Array<Record<string, unknown>>; env: Record<string, unknown> } | undefined;
  return { outcome, report, events, sessions, ledger };
}

test('an agent observes, acts, waits and calls a provider across two apps, and sees none of the host environment', async () => {
  const { outcome, report, sessions } = await runEcho(
    {
      steps: [
        { type: 'observe', app: BOSS, elements: true },
        navigate(BOSS, { snapshotId: '$snapshot' }),
        { type: 'wait', app: BOSS, wait: { condition: { kind: 'text', pattern: '沟通中', present: true }, timeoutMs: 1000 } },
        { type: 'observe', app: MAIL },
        { type: 'provider', providerId: 'ark-text', purpose: 'draft', input: { prompt: 'hi' } },
        { type: 'provider', providerId: 'ark-text', purpose: 'submit', input: {} },
        { type: 'provider', providerId: 'openai', purpose: 'draft', input: {} },
        { type: 'heartbeat', state: 'working' },
        { type: 'artifact', path: 'out/resume.pdf', kind: 'original', completeness: 'complete' },
      ],
    },
    { providers: { call: async ({ input }) => ({ output: { echoed: input }, usage: { inputTokens: 3, outputTokens: 'unknown' } }) } },
  );
  assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome));
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(report!.responses, [
    { type: 'observation', snapshotId: `${BOSS}#1` },
    { type: 'action_result', status: 'ok' },
    { type: 'observation', snapshotId: `${BOSS}#2`, check: true },
    { type: 'observation', snapshotId: `${MAIL}#1` },
    { type: 'provider_result', ok: true, reason: null, output: { echoed: { prompt: 'hi' } } },
    { type: 'provider_result', ok: false, reason: 'purpose_not_allowed', output: null },
    { type: 'provider_result', ok: false, reason: 'provider_undeclared', output: null },
  ]);
  assert.deepEqual(report!.env, { secret: null, socket: null, runIdMatches: true, agent: 'test.echo', protocol: AGENT_PROTOCOL });
  assert.equal((sessions.get(BOSS) as FakeSession).acts.length, 1);
  assert.equal((sessions.get(BOSS) as FakeSession).acts[0]!.snapshotId, `${BOSS}#1`);
  assert.deepEqual(outcome.artifacts, [{ type: 'artifact', path: 'out/resume.pdf', kind: 'original', completeness: 'complete' }]);
});

test('without a grant, external-submit is refused and never reaches the app', async () => {
  const { outcome, report, sessions, events } = await runEcho({ steps: [submit('cand-1')], finish: 'partial' });
  assert.equal(outcome.status, 'partial');
  assert.deepEqual(report!.responses, [{ type: 'action_result', refusal: 'not_granted', wait: null }]);
  assert.equal((sessions.get(BOSS) as FakeSession).acts.length, 0);
  const audit = events.filter((e) => e.type === 'audit');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.type === 'audit' && audit[0]!.record.reason, 'not_granted');
});

test('human in the loop: each external-submit needs its own granted approval, shown with computed consequences', async () => {
  const asked: Parameters<Approver['request']>[0][] = [];
  const approver: Approver = {
    request: async (request) => {
      asked.push(request);
      return asked.length === 1 ? { decision: 'grant' } : { decision: 'deny', guidance: { text: '今天够了', hints: ['outside_quota'] } };
    },
  };
  const { outcome, report, sessions, ledger } = await runEcho(
    {
      steps: [
        submit('cand-1'),
        { type: 'ask_approval', effect: 'external-submit', summary: '向陈一求简历', app: BOSS, target: 'cand-1' },
        submit('cand-1', { approvalId: '$approval' }),
        submit('cand-1', { approvalId: '$approval' }),
        { type: 'ask_approval', effect: 'external-submit', summary: '向王二求简历', target: 'cand-2' },
      ],
    },
    { grants: [grantFor('human_in_the_loop')], approver },
  );
  assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome));
  assert.deepEqual(report!.responses, [
    { type: 'action_result', refusal: 'approval_required', wait: null },
    { type: 'grant', hints: null },
    { type: 'action_result', status: 'ok' },
    { type: 'action_result', refusal: 'approval_required', wait: null },
    { type: 'deny', hints: ['outside_quota'] },
  ]);
  assert.equal((sessions.get(BOSS) as FakeSession).acts.length, 1);
  assert.equal((ledger as ReturnType<typeof createMemoryEffectLedger>).all.length, 1);
  assert.deepEqual(asked[0]!.consequences, {
    application: BOSS,
    accountKey: 'hr-zhang',
    usedInWindow: 0,
    remainingInWindow: 20,
    targetHadUnknownResult: false,
    inWorkHours: true,
  });
  assert.equal(asked[1]!.consequences.usedInWindow, 1);
  assert.equal(asked[1]!.consequences.remainingInWindow, 19);
});

test('trusted within ceiling: no per-action approval, but limits still hold', async () => {
  const now = Date.parse('2026-10-07T02:01:00Z');
  const seeded: EffectUse[] = [
    { agentId: 'other.agent', taskId: 'x', application: BOSS, accountKey: 'hr-zhang', effect: 'external-submit', at: new Date(now - 10_000).toISOString(), status: 'ok' },
  ];
  const { report } = await runEcho(
    { steps: [submit('cand-1')] },
    { grants: [grantFor('trusted_within_ceiling')], ledger: createMemoryEffectLedger(seeded), clock: { now: () => new Date(now) } },
  );
  // Another agent's use on the same account 10 s ago counts: 35 s to go.
  assert.deepEqual(report!.responses, [{ type: 'action_result', refusal: 'too_fast', wait: 35_000 }]);

  const { report: second, sessions } = await runEcho(
    { steps: [submit('cand-1'), submit('cand-2'), submit('cand-3')] },
    { spec: trustedSpec, grants: [grantFor('trusted_within_ceiling')], ceilings: { user: { 'external-submit': { perDay: 2 } } } },
  );
  assert.deepEqual(second!.responses, [
    { type: 'action_result', status: 'ok' },
    { type: 'action_result', status: 'ok' },
    { type: 'action_result', refusal: 'quota_exhausted', wait: second!.responses[2]!.wait },
  ]);
  assert.ok((second!.responses[2]!.wait as number) > 0);
  assert.equal((sessions.get(BOSS) as FakeSession).acts.length, 2);
});

test('an unknown external-submit result is never repeated on that target, or on any when no target is given', async () => {
  const sessions = new Map([
    [BOSS, fakeSession(BOSS, 4242, ['unknown', 'ok', 'unknown'])],
    [MAIL, fakeSession(MAIL, 5252)],
  ]);
  const { report } = await runEcho(
    { steps: [submit('cand-1'), submit('cand-1'), submit('cand-2'), submit(), submit('cand-3')] },
    { spec: trustedSpec, grants: [grantFor('trusted_within_ceiling')], sessions },
  );
  assert.deepEqual(report!.responses, [
    { type: 'action_result', status: 'unknown' },
    { type: 'action_result', refusal: 'target_unknown_result', wait: null },
    { type: 'action_result', status: 'ok' },
    { type: 'action_result', status: 'unknown' },
    { type: 'action_result', refusal: 'target_unknown_result', wait: null },
  ]);
});

test('the check chain refuses undeclared apps and effects, stale snapshots, locked-down and expired grants, and work hours', async () => {
  const { report } = await runEcho({
    steps: [
      { type: 'observe', app: BOSS },
      navigate('com.apple.finder'),
      { type: 'act', app: BOSS, action: { kind: 'key', key: 's', effect: 'artifact' } },
      navigate(BOSS, { snapshotId: `${BOSS}#0` }),
      navigate(BOSS, { snapshotId: '$snapshot' }),
    ],
  });
  assert.deepEqual(report!.responses.map((r) => r.refusal ?? r.status ?? r.type), ['observation', 'app_undeclared', 'effect_undeclared', 'snapshot_stale', 'ok']);

  const { report: manifestWins } = await runEcho({ steps: [submit('c')] }, { grants: [grantFor('trusted_within_ceiling')] });
  assert.equal(manifestWins!.responses[0]!.refusal, 'approval_required', 'a trusted grant cannot loosen what the manifest declares');
  const { report: locked } = await runEcho({ steps: [submit('c')] }, { grants: [grantFor('locked_down')] });
  assert.equal(locked!.responses[0]!.refusal, 'approval_denied');
  const { report: floor } = await runEcho({ steps: [submit('c')] }, { spec: trustedSpec, grants: [grantFor('trusted_within_ceiling')], ceilings: { approvalFloor: { 'external-submit': 'locked_down' } } });
  assert.equal(floor!.responses[0]!.refusal, 'approval_denied');
  const { report: expired } = await runEcho({ steps: [submit('c')] }, { grants: [grantFor('trusted_within_ceiling', { expiresAt: '2026-10-01T00:00:00Z' })] });
  assert.equal(expired!.responses[0]!.refusal, 'grant_expired');
  const { report: otherAccount } = await runEcho({ steps: [submit('c')] }, { grants: [grantFor('trusted_within_ceiling', { accountKey: 'hr-li' })] });
  assert.equal(otherAccount!.responses[0]!.refusal, 'not_granted');
  const { report: night } = await runEcho({ steps: [navigate()] }, { workHours: () => false });
  assert.equal(night!.responses[0]!.refusal, 'outside_work_hours');
});

test('a malformed line, or a message for another task, ends the task as a protocol failure', async () => {
  const { outcome } = await runEcho({ steps: [{ rawLine: '{"not":"a message"}' }] });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'protocol');
  const { outcome: other } = await runEcho({ steps: [{ type: 'observe', app: BOSS, taskId: 't-other' }] });
  assert.equal(other.failure, 'protocol');
  const { outcome: undeclared } = await runEcho({ steps: [{ type: 'observe', app: 'com.apple.finder' }] });
  assert.equal(undeclared.failure, 'protocol');
});

test('an agent that exits without finishing has failed', async () => {
  const { outcome, report } = await runEcho({ steps: [], finish: 'exit' });
  assert.ok(report);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'exited');
});

test('cancelling asks the agent to stop and resolves once it has exited', async () => {
  const controller = new AbortController();
  const events: HostEvent[] = [];
  const running = runEcho(
    { steps: [], waitForCancel: true },
    { signal: controller.signal, onEvent: (e) => {
      events.push(e);
      if (e.type === 'item') controller.abort();
    } },
  );
  const { outcome } = await running;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'cancelled');
  assert.equal(outcome.exitCode, 1);
});

test('an agent that ignores cancel and SIGTERM is killed at the timeout', async () => {
  const started = Date.now();
  const { outcome } = await runEcho({ hang: true, ignoreCancel: true, ignoreSigterm: true }, { timeoutMs: 400, killGraceMs: 200 });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'timeout');
  assert.ok(Date.now() - started < 5000);
});

test('the command must stay in the package, and only task-mode agents with every session run here', async () => {
  assert.throws(() => agentCommand('/pkg', { ...spec, executor: { ...spec.executor, command: ['../evil'] } as AgentSpec['executor'] }, { node: '/n' }), /leaves the package/);
  assert.throws(() => agentCommand('relative', spec, { node: '/n' }), /absolute/);
  assert.throws(() => agentCommand('/pkg', spec, {}), (e) => isRuntimeError(e, 'capability_missing'));
  assert.deepEqual(agentCommand('/pkg', spec, { node: '/usr/bin/node' }), { file: '/usr/bin/node', args: ['/pkg/bin/echo-agent.mjs'] });
  await assert.rejects(runEcho({}, { spec: { ...spec, mode: 'resident', schedule: { workHours: 'org', idlePollSeconds: 60 } } }), /resident agents are scheduled/);
  await assert.rejects(runEcho({}, { sessions: new Map([[BOSS, fakeSession(BOSS, 1)]]) }), /no session for com.apple.mail/);
  await assert.rejects(runEcho({}, { task: { taskId: 't1', taskType: 'other', input: {}, budget: DEFAULT_BUDGET } }), /not one the agent accepts/);
});

test('the effective limit is the tightest of every level', () => {
  assert.deepEqual(effectiveLimit('external-submit', spec, {}), { perDay: 20, minIntervalMs: 45_000 });
  assert.deepEqual(effectiveLimit('external-submit', { ...spec, limits: { 'external-submit': { perDay: 50, minIntervalMs: 60_000 } } }, { org: { 'external-submit': { perDay: 10 } } }), {
    perDay: 10,
    minIntervalMs: 60_000,
  });
  assert.deepEqual(effectiveLimit('navigation', spec, {}), {});
  // Pure chain: a navigation act with no snapshot and no limits passes.
  assert.equal(
    checkAction({
      spec,
      accountKey: 'hr-zhang',
      app: BOSS,
      action: { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.5 } }, effect: 'navigation' },
      now: new Date(),
      grants: [],
      ceilings: {},
      uses: [],
      inWorkHours: true,
      unknownTargets: new Set(),
      approvals: new Map(),
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Status board, questions and provider usage (herdr's status model, nasiko's two pauses and per-agent cost)

test('the status board follows the run: working, blocked on approval then on input, then done', async () => {
  const board = createStatusBoard();
  const seen: Array<{ state: string; kind?: string }> = [];
  board.subscribe((e) => {
    const last = seen.at(-1);
    const next = { state: e.state, ...(e.blockedOn && { kind: e.blockedOn.kind }) };
    if (!last || last.state !== next.state || last.kind !== next.kind) seen.push(next);
  });
  const asked: UserQuestion[] = [];
  const asker: Asker = {
    ask: async (q) => {
      asked.push(q);
      // A first answer outside the choices is asked again.
      return asked.length === 1 ? '运营' : '前端';
    },
  };
  const approver: Approver = { request: async () => ({ decision: 'grant' }) };
  const { outcome, report } = await runEcho(
    {
      steps: [
        { type: 'heartbeat', state: 'working', summary: '读取消息列表' },
        { type: 'observe', app: BOSS },
        { type: 'ask_approval', effect: 'external-submit', summary: '向陈一求简历', target: 'c1' },
        { type: 'ask_user', reason: 'job_ambiguous', message: '两个岗位都叫工程师，选哪个？', questionId: 'q1', choices: ['前端', '后端'] },
        { type: 'heartbeat', state: 'idle', summary: '没有新消息' },
      ],
    },
    { status: board, approver, asker, grants: [grantFor('human_in_the_loop')] },
  );
  assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome));
  assert.deepEqual(report!.responses.slice(1), [
    { type: 'grant', hints: null },
    { type: 'user_answer', answer: '前端' },
  ]);
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0]!.choices, ['前端', '后端']);
  assert.deepEqual(seen, [
    { state: 'starting' },
    { state: 'working' },
    { state: 'blocked', kind: 'approval' },
    { state: 'working' },
    { state: 'blocked', kind: 'input' },
    { state: 'working' },
    { state: 'idle' },
    { state: 'working' },
    { state: 'done' },
  ]);
  const [run] = board.list({ includeFinished: true });
  assert.equal(run!.state, 'done');
  assert.equal(run!.summary, '没有新消息');
});

test('a question nobody can answer keeps the run blocked on input until it is cancelled', async () => {
  const board = createStatusBoard();
  const controller = new AbortController();
  board.subscribe((e) => {
    if (e.state === 'blocked') controller.abort();
  });
  const { outcome } = await runEcho(
    { steps: [{ type: 'ask_user', reason: 'login_required', message: '请扫码登录', questionId: 'q1' }] },
    { status: board, signal: controller.signal },
  );
  assert.equal(outcome.failure, 'cancelled');
  const [run] = board.list({ includeFinished: true });
  assert.equal(run!.state, 'failed');
  assert.equal(run!.failure, 'cancelled');
});

test('a note without a question blocks the run until the agent moves on, and an agent may report itself blocked', async () => {
  const board = createStatusBoard();
  const states: string[] = [];
  board.subscribe((e) => states.push(e.state === 'blocked' ? `blocked:${e.blockedOn!.kind}:${e.blockedOn!.message}` : e.state));
  await runEcho(
    {
      steps: [
        { type: 'ask_user', reason: 'captcha', message: '出现验证码' },
        { type: 'observe', app: BOSS },
        { type: 'heartbeat', state: 'blocked', summary: '等待 BOSS 加载' },
      ],
    },
    { status: board },
  );
  assert.ok(states.includes('blocked:input:出现验证码'), states.join(' | '));
  assert.ok(states.includes('blocked:agent:等待 BOSS 加载'), states.join(' | '));
  assert.equal(states.at(-1), 'done');
});

test('asking the same question id twice ends the task as a protocol failure', async () => {
  const asker: Asker = { ask: async () => 'ok' };
  const { outcome } = await runEcho(
    {
      steps: [
        { type: 'ask_user', reason: 'job_ambiguous', message: 'a', questionId: 'q1' },
        { type: 'ask_user', reason: 'job_ambiguous', message: 'b', questionId: 'q1' },
      ],
    },
    { asker },
  );
  assert.equal(outcome.failure, 'protocol');
});

test('every provider call is recorded against the agent, task and run, with the model and tokens', async () => {
  const usage = createMemoryUsageLedger();
  let calls = 0;
  const { outcome } = await runEcho(
    {
      steps: [
        { type: 'provider', providerId: 'ark-text', purpose: 'draft', input: 'a' },
        { type: 'provider', providerId: 'ark-text', purpose: 'draft', input: 'b' },
        { type: 'provider', providerId: 'ark-text', purpose: 'draft', input: 'c' },
        { type: 'provider', providerId: 'openai', purpose: 'draft', input: 'never called' },
      ],
    },
    {
      usage,
      providers: {
        call: async () => {
          calls += 1;
          if (calls === 2) throw new RuntimeError('model_unavailable', 'down');
          return calls === 1
            ? { output: 'x', model: 'doubao-seed-2-1-lite', usage: { inputTokens: 1000, outputTokens: 200 } }
            : { output: 'y', model: 'doubao-seed-2-1-lite', usage: { inputTokens: 500, outputTokens: 'unknown' } };
        },
      },
    },
  );
  assert.equal(outcome.status, 'succeeded');
  assert.equal(usage.all.length, 3, 'the undeclared provider is never called, so never recorded');
  assert.deepEqual(
    usage.all.map((r) => [r.agentId, r.taskId, r.providerId, r.model ?? null, r.ok, r.inputTokens, r.outputTokens]),
    [
      ['test.echo', 't1', 'ark-text', 'doubao-seed-2-1-lite', true, 1000, 200],
      ['test.echo', 't1', 'ark-text', null, false, 'unknown', 'unknown'],
      ['test.echo', 't1', 'ark-text', 'doubao-seed-2-1-lite', true, 500, 'unknown'],
    ],
  );
  assert.equal(new Set(usage.all.map((r) => r.runId)).size, 1);
  const [row] = summarizeUsage(usage.all, 'agent', { 'ark-text/doubao-seed-2-1-lite': { currency: 'CNY', inputPerMTok: 0.3, outputPerMTok: 0.6 } });
  assert.equal(row!.key, 'test.echo');
  assert.equal(row!.calls, 3);
  assert.equal(row!.failed, 1);
  assert.equal(row!.inputTokens, 'unknown');
  assert.deepEqual(row!.costs, { CNY: (1000 * 0.3 + 200 * 0.6) / 1_000_000 });
  assert.equal(row!.uncosted, 2);
});

test('limits recorded in the file ledger survive a new host, and an unreadable line fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'effects-'));
  try {
    const path = join(dir, 'effects.jsonl');
    const opts = { spec: trustedSpec, grants: [grantFor('trusted_within_ceiling')], ceilings: { user: { 'external-submit': { perDay: 1 } } } };
    const first = await runEcho({ steps: [submit('c1')] }, { ...opts, ledger: createFileEffectLedger(path) });
    assert.deepEqual(first.report!.responses, [{ type: 'action_result', status: 'ok' }]);
    // A new ledger object over the same file, as after a restart.
    const second = await runEcho({ steps: [submit('c2')] }, { ...opts, ledger: createFileEffectLedger(path) });
    assert.equal(second.report!.responses[0]!.refusal, 'quota_exhausted');
    await writeFile(path, 'garbage\n', { flag: 'a' });
    const third = await runEcho({ steps: [submit('c3')] }, { ...opts, ledger: createFileEffectLedger(path) });
    assert.equal(third.outcome.status, 'failed');
    assert.equal(third.outcome.actions.length, 0, 'nothing is sent when the limits cannot be read');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
