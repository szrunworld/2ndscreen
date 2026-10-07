import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLineProcessSpawner } from '../src/adapters/agent-bridge.ts';
import { AGENT_PROTOCOL, validateAgentSpec, type AgentSpec } from '../src/agent-contracts.ts';
import { createMemoryEffectLedger, startResidentAgent, type AgentTaskOutcome, type ResidentAgentOptions } from '../src/agent-host.ts';
import { createStatusBoard } from '../src/agent-status.ts';
import { isRuntimeError, type ActionRequest, type ActionStatus, type Clock, type Session, type WindowGeometry } from '../src/contracts.ts';

// A real child process plays a resident agent. Its first argument picks a
// scenario, its second names a counter file in the package, so a scenario
// can behave differently on the first start and after a restart.

const AGENT = String.raw`
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [scenario, tag] = process.argv.slice(2);
const counter = join(dirname(fileURLToPath(import.meta.url)), '..', 'state', tag);
mkdirSync(dirname(counter), { recursive: true });
const count = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(count));
const BOSS = 'com.zhipin.www';
const rl = createInterface({ input: process.stdin });
let seq = 0, runId, resumed = [], hb;
const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, agentRunId: runId, seq: ++seq, at: new Date().toISOString(), ...m }) + '\n');
const ask = (m, k) => new Promise((r) => { pending.set(k, r); send(m); });
process.on('SIGTERM', () => { if (scenario !== 'silent') process.exit(143); });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'agent_start') { runId = m.agentRunId; resumed = (m.resume?.tasks ?? []).map((t) => t.taskId); started(); return; }
  if (m.type === 'task_start') { void work(m.taskId, m.input); return; }
  if (m.type === 'stop') { clearInterval(hb); send({ type: 'agent_stopped', reason: 'stop' }); rl.close(); return; }
  const k = m.requestId ?? m.approvalId;
  const r = pending.get(k);
  if (r) { pending.delete(k); r(m); }
});
function started() {
  if (scenario === 'crash') process.exit(1);
  if (scenario === 'silent') return;
  hb = setInterval(() => send({ type: 'heartbeat', state: 'idle', summary: 'run ' + count }), 50);
  if (scenario === 'create' && count === 1) void (async () => {
    const r = await ask({ type: 'create_task', requestId: 'c1', taskType: 'request-resumes', input: { from: 'agent' } }, 'c1');
    await work(r.taskId, { from: 'agent' });
  })();
}
async function work(taskId, input) {
  send({ type: 'heartbeat', state: 'working', summary: 'task ' + taskId });
  await ask({ type: 'observe', taskId, requestId: 'o-' + taskId, app: BOSS }, 'o-' + taskId);
  if (scenario === 'crash-mid-task' && count === 1) process.exit(1);
  if (scenario === 'unknown-submit') {
    const id = 'a-' + taskId + '-' + count;
    const a = await ask({ type: 'act', taskId, requestId: id, app: BOSS, target: 'cand-1',
      action: { kind: 'click', target: { kind: 'element', label: '求简历' }, effect: 'external-submit' } }, id);
    send({ type: 'item', taskId, itemId: 'act-' + count, status: 'committed', data: { status: a.result?.status ?? null, refusal: a.refusal?.reason ?? null } });
    if (count === 1) process.exit(1);
  }
  send({ type: 'item', taskId, itemId: 'done', status: 'committed', data: { run: count, resumed, input } });
  send({ type: 'task_finished', taskId, status: 'succeeded' });
}
`;

const BOSS = 'com.zhipin.www';
const FRAME = { x: 3000, y: 25, width: 1440, height: 900 };
const WINDOW: WindowGeometry = { pid: 4242, windowId: 77, bundleId: BOSS, title: 'BOSS直聘', frame: FRAME, contentFrame: FRAME, scale: 2, displayId: 7 };

function spec(scenario: string, tag: string): AgentSpec {
  return {
    schemaVersion: 2,
    id: 'test.resident',
    version: '0.1.0',
    runtimeContract: '>=2 <3',
    platforms: ['macos'],
    applications: [{ bundleId: BOSS, windowProfile: 'boss-macos-1440x900' }],
    mode: 'resident',
    executor: { kind: 'process', command: ['bin/resident.mjs', scenario, tag], protocol: AGENT_PROTOCOL, runtime: { kind: 'node', bundled: false } },
    tasks: { 'request-resumes': { inputSchema: 'request-resumes-input-v1' } },
    effects: ['read', 'navigation', 'external-submit'],
    capabilities: ['ui.read'],
    providers: [],
    limits: {},
    approval: { 'external-submit': 'trusted_within_ceiling' },
    schedule: { workHours: 'org', idlePollSeconds: 5 },
    foregroundAllowed: false,
    learning: { promoteAfterSuccesses: 3 },
    skills: ['SKILL.md'],
  };
}

let packageDir: string;
let tags = 0;
test.before(async () => {
  assert.equal(validateAgentSpec(spec('x', 'y')).ok, true, JSON.stringify(validateAgentSpec(spec('x', 'y'))));
  packageDir = await mkdtemp(join(tmpdir(), 'agent-resident-'));
  await mkdir(join(packageDir, 'bin'));
  await writeFile(join(packageDir, 'bin', 'resident.mjs'), AGENT);
});
test.after(async () => {
  await rm(packageDir, { recursive: true, force: true });
});

function session(statuses: ActionStatus[] = []): Session {
  let k = 0;
  return {
    binding: () => ({ screenId: 'agents', socket: '/tmp/never.sock', window: WINDOW, launchedByRuntime: false }),
    observe: async () => ({ snapshotId: `s${++k}`, sessionId: 'ses', takenAt: new Date().toISOString(), window: WINDOW }),
    act: async (r: ActionRequest) => ({ actionId: r.actionId, status: statuses.shift() ?? 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
    waitFor: async () => ({ ok: true, evidence: [] }),
  } as unknown as Session;
}

/** Moves a minute per read, so interval limits never interfere unless a test wants them to. */
const stepping = (): Clock => {
  let t = Date.parse('2026-10-07T02:00:00Z');
  return { now: () => new Date((t += 60_000)) };
};

function start(scenario: string, overrides: Partial<ResidentAgentOptions> = {}) {
  const ended = new Map<string, AgentTaskOutcome>();
  const startedTasks: Array<{ taskId: string; origin: string }> = [];
  const agent = startResidentAgent({
    packageDir,
    spec: spec(scenario, `${scenario}-${++tags}`),
    account: { platform: 'boss', accountKey: 'hr-zhang', binding: 'explicit' },
    sessions: new Map([[BOSS, session()]]),
    screenId: 'agents',
    grants: [],
    ledger: createMemoryEffectLedger(),
    spawn: createLineProcessSpawner({ inheritEnv: false }),
    interpreters: { node: process.execPath },
    killGraceMs: 200,
    heartbeatTimeoutMs: 1500,
    workHoursPollMs: 30,
    restartDelaysMs: [20],
    onTaskStarted: (t) => startedTasks.push({ taskId: t.taskId, origin: t.origin }),
    onTaskEnded: (id, outcome) => {
      assert.ok(!ended.has(id), `task ${id} ended twice`);
      ended.set(id, outcome);
    },
    ...overrides,
  });
  return { agent, ended, startedTasks };
}

const until = async (what: string, ok: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const doneItem = (o: AgentTaskOutcome | undefined) => o?.items.find((i) => i.itemId === 'done')?.data as { run: number; resumed: string[]; input: unknown } | undefined;

test('a resident agent creates its own task, takes one from the runtime, and stops when asked', async () => {
  const board = createStatusBoard();
  const { agent, ended, startedTasks } = start('create', { status: board });
  await until('the agent to finish its own task', () => ended.size === 1);
  const own = [...ended.entries()][0]!;
  assert.equal(own[1].status, 'succeeded');
  assert.deepEqual(doneItem(own[1])!.input, { from: 'agent' });
  const id = agent.submit({ taskType: 'request-resumes', input: { from: 'runtime' } });
  await until('the runtime task', () => ended.has(id));
  assert.equal(ended.get(id)!.status, 'succeeded');
  assert.deepEqual(doneItem(ended.get(id))!.input, { from: 'runtime' });
  assert.deepEqual(startedTasks.map((t) => t.origin), ['agent', 'runtime']);
  await until('an idle heartbeat', () => board.list()[0]?.state === 'idle');
  agent.stop();
  const outcome = await agent.done;
  assert.equal(outcome.stoppedBy, 'signal');
  assert.deepEqual(outcome.runs.map((r) => r.end), ['cancelled']);
  assert.equal(board.list({ includeFinished: true })[0]!.state, 'done');
});

test('outside work hours nothing runs; the agent starts when they begin and is stopped politely when they end', async () => {
  let open = false;
  const { agent, ended } = start('worker', { workHours: () => open });
  const queued = agent.submit({ taskType: 'request-resumes', input: { n: 1 } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(agent.currentRunId(), undefined, 'no process outside work hours');
  assert.equal(ended.size, 0);
  open = true;
  await until('the queued task to run once hours begin', () => ended.has(queued));
  assert.equal(ended.get(queued)!.status, 'succeeded');
  open = false;
  await until('the agent to be stopped for the end of the hours', () => agent.currentRunId() === undefined);
  agent.stop();
  const outcome = await agent.done;
  assert.equal(outcome.stoppedBy, 'signal');
  assert.equal(outcome.runs[0]!.end, 'work_hours');
});

test('after a crash mid-task the agent restarts and the open task goes on in the new process', async () => {
  const { agent, ended } = start('crash-mid-task');
  const id = agent.submit({ taskType: 'request-resumes', input: { n: 7 } });
  await until('the task to finish after a restart', () => ended.has(id));
  const data = doneItem(ended.get(id))!;
  assert.equal(data.run, 2);
  assert.deepEqual(data.resumed, [id], 'agent_start lists the task as resumed');
  assert.deepEqual(data.input, { n: 7 }, 'the task is sent again with its input');
  agent.stop();
  const outcome = await agent.done;
  assert.deepEqual(outcome.runs.map((r) => [r.end, r.carried]), [['crashed', 1], ['cancelled', 0]]);
});

test('an agent that keeps crashing is given up after maxRestarts, and its open task fails', async () => {
  const { agent, ended } = start('crash', { maxRestarts: 2 });
  const id = agent.submit({ taskType: 'request-resumes', input: {} });
  const outcome = await agent.done;
  assert.equal(outcome.stoppedBy, 'gave_up');
  assert.deepEqual(outcome.runs.map((r) => r.end), ['crashed', 'crashed', 'crashed']);
  assert.equal(ended.get(id)!.status, 'failed');
  assert.equal(ended.get(id)!.failure, 'exited');
  assert.throws(() => agent.submit({ taskType: 'request-resumes', input: {} }), (e) => isRuntimeError(e, 'conflict'));
});

test('a silent agent is lost after the heartbeat timeout and is killed even though it ignores SIGTERM', async () => {
  const started = Date.now();
  const { agent } = start('silent', { heartbeatTimeoutMs: 300, maxRestarts: 0 });
  const outcome = await agent.done;
  assert.equal(outcome.stoppedBy, 'gave_up');
  assert.equal(outcome.runs[0]!.end, 'heartbeat_lost');
  assert.ok(Date.now() - started < 5000);
});

test('an external-submit with an unknown result is never repeated, even by the restarted process', async () => {
  const { agent, ended } = start('unknown-submit', {
    sessions: new Map([[BOSS, session(['unknown'])]]),
    grants: [{ agentId: 'test.resident', application: BOSS, accountKey: 'hr-zhang', effect: 'external-submit', mode: 'trusted_within_ceiling', grantedAt: '2026-10-07T00:00:00Z', durable: true, grantedBy: 'user' }],
    clock: stepping(),
  });
  const id = agent.submit({ taskType: 'request-resumes', input: {} });
  await until('the task to finish in the second process', () => ended.has(id));
  const items = ended.get(id)!.items;
  assert.deepEqual(items.find((i) => i.itemId === 'act-1')!.data, { status: 'unknown', refusal: null });
  assert.deepEqual(items.find((i) => i.itemId === 'act-2')!.data, { status: null, refusal: 'target_unknown_result' });
  assert.equal(ended.get(id)!.actions.length, 2);
  agent.stop();
  await agent.done;
});

test('only resident agents with every session start, and only declared task types are taken', async () => {
  const resident = spec('worker', 'v');
  const base = {
    packageDir,
    account: { platform: 'boss' as const, accountKey: 'k', binding: 'explicit' as const },
    sessions: new Map([[BOSS, session()]]),
    screenId: 'agents',
    grants: [],
    ledger: createMemoryEffectLedger(),
    spawn: createLineProcessSpawner({ inheritEnv: false }),
    interpreters: { node: process.execPath },
  };
  assert.throws(() => startResidentAgent({ ...base, spec: { ...resident, mode: 'task' } }), /resident agents with a schedule/);
  assert.throws(() => startResidentAgent({ ...base, spec: resident, sessions: new Map() }), /no session for/);
  const { agent } = start('worker');
  assert.throws(() => agent.submit({ taskType: 'other', input: {} }), (e) => isRuntimeError(e, 'invalid_input'));
  const id = agent.submit({ taskType: 'request-resumes', input: {}, taskId: 'fixed-1' });
  assert.equal(id, 'fixed-1');
  assert.throws(() => agent.submit({ taskType: 'request-resumes', input: {}, taskId: 'fixed-1' }), (e) => isRuntimeError(e, 'conflict'));
  agent.stop();
  await agent.done;
});

test('sessions that cannot be opened count as failed runs, start no process, and are given up on', async () => {
  let opens = 0;
  let spawned = 0;
  const spawner = createLineProcessSpawner({ inheritEnv: false });
  const { agent } = start('worker', {
    sessions: undefined,
    sessionSource: {
      open: async () => {
        opens += 1;
        throw new Error('BOSS直聘 is not installed');
      },
      close: async () => {},
    },
    spawn: (file, args, env) => ((spawned += 1), spawner(file, args, env)),
    maxRestarts: 1,
  });
  const outcome = await agent.done;
  assert.equal(outcome.stoppedBy, 'gave_up');
  assert.deepEqual(outcome.runs.map((r) => r.end), ['no_session', 'no_session']);
  assert.equal(opens, 2);
  assert.equal(spawned, 0);
});
