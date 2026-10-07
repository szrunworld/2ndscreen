import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { readOutcome, requestPaths, submitTaskRequest } from '../src/agent-requests.ts';
import { parseSubmit } from '../src/cli.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLineProcessSpawner } from '../src/adapters/agent-bridge.ts';
import { grantInConfig, grantsOf, listGrants, loadAgentPackage, localTime, revokeInConfig, validateHostConfig, workHoursFunction, type HostConfig } from '../src/agent-config.ts';
import { claimHost, runningHostPid, startAgentHostDaemon, type AgentSessionRequest } from '../src/agent-daemon.ts';
import { decide, inboxPaths, listInbox } from '../src/agent-inbox.ts';
import { agentDataPaths } from '../src/agent-ledgers.ts';
import { createProviderService } from '../src/agent-providers.ts';
import { readStatusFile } from '../src/agent-status.ts';
import { AGENT_PROTOCOL } from '../src/agent-contracts.ts';
import { isRuntimeError, type ActionRequest, type Session, type WindowGeometry } from '../src/contracts.ts';

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Config

const goodConfig = (pkg = '/abs/pkg'): HostConfig => ({
  agents: [
    {
      package: pkg,
      enabled: true,
      account: { platform: 'boss', accountKey: 'hr-zhang' },
      grants: [{ application: 'com.zhipin.www', effect: 'external-submit', mode: 'human_in_the_loop', expiresAt: '2026-10-14T00:00:00+08:00', durable: false }],
      ceilings: { user: { 'external-submit': { perDay: 10 } }, approvalFloor: { 'external-submit': 'human_in_the_loop' } },
      workHours: { timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5], windows: ['09:00-12:00', '13:30-18:30'] },
    },
  ],
  providers: { 'ark-text': { kind: 'openai-chat', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao', apiKeyEnv: 'ARK_API_KEY' } },
});

test('a good host config passes, and every problem of a bad one is named', () => {
  assert.equal(validateHostConfig(goodConfig()).ok, true, JSON.stringify(validateHostConfig(goodConfig())));
  const r = validateHostConfig({
    agents: [
      {
        package: 'relative/pkg',
        enabled: 'yes',
        account: { platform: 'boss', accountKey: 'has space' },
        grants: [{ application: 'x', effect: 'external-submit', mode: 'whatever' }, { application: 'x', effect: 'read', mode: 'locked_down', durable: true, expiresAt: '2026-01-01T00:00:00Z' }],
        ceilings: { user: { teleport: { perDay: 1 } }, approvalFloor: { read: 'maybe' } },
        workHours: { timezone: 'Mars/Olympus', windows: ['9-18'], days: [0] },
        extra: 1,
      },
    ],
    providers: { 'ark-text': { kind: 'grpc', baseUrl: 'http://evil.example.com', model: '', apiKeyEnv: 'lower' } },
    more: true,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  for (const fragment of [
    'more is not a config field',
    'package must be an absolute directory',
    'enabled must be boolean',
    'account must name',
    'extra is not a field',
    'grants[0].mode',
    'grants[0] must say when it ends',
    'grants[1] is durable and cannot also expire',
    'ceilings.user.teleport is not an effect class',
    'approvalFloor.read',
    'workHours.timezone',
    'workHours.windows',
    'workHours.days',
    'kind must be openai-chat',
    'baseUrl must be an https URL',
    'model must name',
    'apiKeyEnv',
  ])
    assert.ok(r.errors.some((e) => e.includes(fragment)), `${fragment} in ${JSON.stringify(r.errors)}`);
  const grants = grantsOf(goodConfig().agents[0]!, 'remotedesk.boss-recruiter', '2026-10-07T00:00:00.000Z');
  assert.deepEqual(grants, [
    {
      agentId: 'remotedesk.boss-recruiter',
      application: 'com.zhipin.www',
      accountKey: 'hr-zhang',
      effect: 'external-submit',
      mode: 'human_in_the_loop',
      grantedAt: '2026-10-07T00:00:00.000Z',
      durable: false,
      expiresAt: '2026-10-13T16:00:00.000Z',
      grantedBy: 'user',
    },
  ]);
});

test('work hours are read in their timezone, by weekday, and a window may run past midnight', () => {
  const office = workHoursFunction({ timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5], windows: ['09:00-12:00', '13:30-18:30'] });
  // 2026-10-07 is a Wednesday.
  assert.deepEqual(localTime(new Date('2026-10-07T01:00:00Z'), 'Asia/Shanghai'), { day: 3, minute: 9 * 60 });
  assert.equal(office(new Date('2026-10-07T01:00:00Z')), true); // 09:00
  assert.equal(office(new Date('2026-10-07T00:59:00Z')), false); // 08:59
  assert.equal(office(new Date('2026-10-07T04:00:00Z')), false); // 12:00, end exclusive
  assert.equal(office(new Date('2026-10-07T05:30:00Z')), true); // 13:30
  assert.equal(office(new Date('2026-10-10T02:00:00Z')), false); // Saturday 10:00
  const night = workHoursFunction({ timezone: 'Asia/Shanghai', days: [5], windows: ['22:00-02:00'] });
  assert.equal(night(new Date('2026-10-09T14:30:00Z')), true); // Friday 22:30
  assert.equal(night(new Date('2026-10-09T17:30:00Z')), true); // Saturday 01:30, the Friday window
  assert.equal(night(new Date('2026-10-10T14:30:00Z')), false); // Saturday 22:30
  const always = workHoursFunction({ timezone: 'UTC', windows: ['00:00-24:00'] });
  assert.equal(always(new Date('2026-10-11T23:59:00Z')), true);
});

// ---------------------------------------------------------------------------
// Packages

const AGENT_JSON = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  id: 'test.hosted',
  version: '0.1.0',
  runtimeContract: '>=2 <3',
  platforms: ['macos'],
  applications: [{ bundleId: 'com.apple.calculator', windowProfile: 'calc-800x600' }],
  mode: 'resident',
  executor: { kind: 'process', command: ['bin/agent.mjs'], protocol: AGENT_PROTOCOL, runtime: { kind: 'node', bundled: false } },
  tasks: { press: { inputSchema: 'press-input-v1' } },
  effects: ['read', 'navigation', 'external-submit'],
  capabilities: ['ui.read'],
  providers: [{ id: 'echo', purposes: ['draft'] }],
  limits: {},
  approval: { 'external-submit': 'human_in_the_loop' },
  schedule: { workHours: 'user', idlePollSeconds: 5 },
  foregroundAllowed: false,
  learning: { promoteAfterSuccesses: 3 },
  skills: ['SKILL.md'],
  ...overrides,
});
const PROFILE = { id: 'calc-800x600', version: 1, logicalWidth: 800, logicalHeight: 600, bundleId: 'com.apple.calculator' };

async function makePackage(dir: string, agentSource: string, overrides: Record<string, unknown> = {}): Promise<string> {
  await mkdir(join(dir, 'bin'), { recursive: true });
  await mkdir(join(dir, 'profiles', 'macos'), { recursive: true });
  await writeFile(join(dir, 'agent.json'), JSON.stringify(AGENT_JSON(overrides)));
  await writeFile(join(dir, 'profiles', 'macos', 'calc-800x600.json'), JSON.stringify(PROFILE));
  await writeFile(join(dir, 'SKILL.md'), '# test\n');
  await writeFile(join(dir, 'bin', 'agent.mjs'), agentSource);
  return dir;
}

test('a package loads only when its manifest, contract, profiles and program check out', async () => {
  const root = await tmp('agent-pkg-');
  try {
    const good = await makePackage(join(root, 'good'), '');
    const pkg = loadAgentPackage(good);
    assert.equal(pkg.spec.id, 'test.hosted');
    assert.equal(pkg.profiles.get('com.apple.calculator')!.logicalWidth, 800);
    assert.throws(() => loadAgentPackage('relative'), (e) => isRuntimeError(e, 'invalid_input'));
    assert.throws(() => loadAgentPackage(join(root, 'missing')), (e) => isRuntimeError(e, 'not_found'));
    const future = await makePackage(join(root, 'future'), '', { runtimeContract: '>=3' });
    assert.throws(() => loadAgentPackage(future), (e) => isRuntimeError(e, 'capability_missing'));
    const noProgram = await makePackage(join(root, 'noprog'), '', { executor: { kind: 'process', command: ['bin/missing.mjs'], protocol: AGENT_PROTOCOL } });
    assert.throws(() => loadAgentPackage(noProgram), /not in the package/);
    const outside = await makePackage(join(root, 'outside'), '');
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify(PROFILE));
    await rm(join(outside, 'profiles', 'macos', 'calc-800x600.json'));
    await symlink(join(root, 'elsewhere.json'), join(outside, 'profiles', 'macos', 'calc-800x600.json'));
    assert.throws(() => loadAgentPackage(outside), /leaves the package/);
    const wrongProfile = await makePackage(join(root, 'wrong'), '');
    await writeFile(join(wrongProfile, 'profiles', 'macos', 'calc-800x600.json'), JSON.stringify({ ...PROFILE, bundleId: 'com.other' }));
    assert.throws(() => loadAgentPackage(wrongProfile), /must have id/);
    const tooWide = await makePackage(join(root, 'wide'), '');
    await writeFile(join(tooWide, 'profiles', 'macos', 'calc-800x600.json'), JSON.stringify({ ...PROFILE, mainWindowMinWidth: 900 }));
    assert.throws(() => loadAgentPackage(tooWide), /mainWindowMinWidth/);
    await writeFile(join(tooWide, 'profiles', 'macos', 'calc-800x600.json'), JSON.stringify({ ...PROFILE, mainWindowMinWidth: 180 }));
    assert.equal(loadAgentPackage(tooWide).profiles.get('com.apple.calculator')!.mainWindowMinWidth, 180);
    await writeFile(join(tooWide, 'profiles', 'macos', 'calc-800x600.json'), JSON.stringify({ ...PROFILE, logicalWidth: 300, logicalHeight: 400 }));
    assert.throws(() => loadAgentPackage(tooWide), /between 320x240 and 6016x3384/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Providers

async function server(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v3`, close: () => new Promise((r) => s.close(() => r())) };
}

test('the provider service sends the key only to the configured URL and reports usage and model', async () => {
  const seen: Array<{ path: string; auth: string; body: Record<string, unknown> }> = [];
  const api = await server((req, body, res) => {
    seen.push({ path: req.url!, auth: String(req.headers.authorization), body: JSON.parse(body) });
    if (req.url === '/v3/chat/completions' && seen.length === 1) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'doubao-x', choices: [{ message: { content: '您好' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    } else if (seen.length === 2) {
      res.statusCode = 503;
      res.end('busy');
    } else {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/steal');
      res.end();
    }
  });
  try {
    const service = createProviderService({
      providers: { ark: { kind: 'openai-chat', baseUrl: api.url, model: 'doubao', apiKeyEnv: 'TEST_KEY' } },
      env: { TEST_KEY: 'sk-test' },
    });
    const signal = new AbortController().signal;
    const answer = await service.call({ agentId: 'a', providerId: 'ark', purpose: 'draft', input: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 } }, signal);
    assert.deepEqual(answer, { output: { text: '您好' }, usage: { inputTokens: 12, outputTokens: 3 }, model: 'doubao-x' });
    assert.equal(seen[0]!.auth, 'Bearer sk-test');
    assert.deepEqual(seen[0]!.body, { model: 'doubao', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
    await assert.rejects(service.call({ agentId: 'a', providerId: 'ark', purpose: 'draft', input: 'x' }, signal), (e) => isRuntimeError(e, 'model_unavailable'));
    await assert.rejects(service.call({ agentId: 'a', providerId: 'ark', purpose: 'draft', input: 'x' }, signal), (e) => isRuntimeError(e, 'model_unavailable'));
    assert.equal(seen.length, 3, 'the redirect is not followed');
    await assert.rejects(service.call({ agentId: 'a', providerId: 'nope', purpose: 'draft', input: 'x' }, signal), (e) => isRuntimeError(e, 'model_unavailable'));
    const keyless = createProviderService({ providers: { ark: { kind: 'openai-chat', baseUrl: api.url, model: 'm', apiKeyEnv: 'MISSING_KEY' } }, env: {} });
    await assert.rejects(keyless.call({ agentId: 'a', providerId: 'ark', purpose: 'draft', input: 'x' }, signal), /MISSING_KEY is not set/);
    await assert.rejects(service.call({ agentId: 'a', providerId: 'ark', purpose: 'draft', input: { messages: [{ role: 'root', content: 'x' }] } }, signal), (e) => isRuntimeError(e, 'invalid_input'));
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// The host end to end, with fake sessions and a real agent process

const HOSTED_AGENT = String.raw`
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let seq = 0, runId; const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, agentRunId: runId, seq: ++seq, at: new Date().toISOString(), ...m }) + '\n');
const ask = (m, k) => new Promise((r) => { pending.set(k, r); send(m); });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'agent_start') { runId = m.agentRunId; void go(); return; }
  if (m.type === 'stop') { send({ type: 'agent_stopped', reason: 'stop' }); rl.close(); return; }
  const k = m.requestId ?? m.approvalId; const r = pending.get(k); if (r) { pending.delete(k); r(m); }
});
setInterval(() => runId && send({ type: 'heartbeat', state: 'idle' }), 100);
async function go() {
  const c = await ask({ type: 'create_task', requestId: 'c', taskType: 'press', input: { key: '=' } }, 'c');
  const t = c.taskId;
  const o = await ask({ type: 'observe', taskId: t, requestId: 'o', app: 'com.apple.calculator' }, 'o');
  const d = await ask({ type: 'provider', taskId: t, requestId: 'p', providerId: 'echo', purpose: 'draft', input: 'ping' }, 'p');
  const g = await ask({ type: 'ask_approval', taskId: t, approvalId: 'a1', effect: 'external-submit', summary: '按下等号', target: 'equals' }, 'a1');
  const a = await ask({ type: 'act', taskId: t, requestId: 'r', app: 'com.apple.calculator', snapshotId: o.observation.snapshotId, target: 'equals', approvalId: 'a1',
    action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: 'Equals' }, effect: 'external-submit' } }, 'r');
  send({ type: 'item', taskId: t, itemId: 'report', status: 'committed', data: { provider: d.ok ? d.output.text : d.reason, grant: g.type, act: a.result?.status ?? a.refusal?.reason } });
  send({ type: 'task_finished', taskId: t, status: 'succeeded' });
}
`;

const WINDOW: WindowGeometry = { pid: 99, windowId: 100, bundleId: 'com.apple.calculator', title: 'Calculator', frame: { x: 0, y: 0, width: 800, height: 600 }, contentFrame: { x: 0, y: 0, width: 800, height: 600 }, scale: 2, displayId: 9 };

test('the host runs an enabled resident agent with the inbox, provider, ledgers, status and audit; sessions open per run', async () => {
  const tasksDir = await tmp('agent-hostd-');
  const pkgDir = await makePackage(join(tasksDir, 'pkg'), HOSTED_AGENT);
  const paths = agentDataPaths(tasksDir);
  const api = await server((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const opened: AgentSessionRequest[] = [];
  let closed = 0;
  const acts: ActionRequest[] = [];
  let snaps = 0;
  try {
    await mkdir(paths.dir, { recursive: true });
    const config: HostConfig = {
      agents: [
        {
          package: pkgDir,
          enabled: true,
          account: { platform: 'macos', accountKey: 'local' },
          grants: [{ application: 'com.apple.calculator', effect: 'external-submit', mode: 'human_in_the_loop', durable: true }],
        },
        { package: join(tasksDir, 'nowhere'), enabled: true, account: { platform: 'x', accountKey: 'k' } },
        { package: join(tasksDir, 'off'), enabled: false, account: { platform: 'x', accountKey: 'k' } },
      ],
      providers: { echo: { kind: 'openai-chat', baseUrl: api.url, model: 'm', apiKeyEnv: 'ECHO_KEY' } },
    };
    await writeFile(paths.config, JSON.stringify(config));
    const lines: string[] = [];
    const quit: number[] = [];
    const host = await startAgentHostDaemon({
      tasksDir,
      quitApp: async (b) => void quit.push(b.window.pid),
      openSession: async (r) => {
        opened.push(r);
        return {
          binding: () => ({ screenId: r.profile.id, socket: '/tmp/x', window: WINDOW, launchedByRuntime: true }),
          observe: async () => ({ snapshotId: `s${++snaps}`, sessionId: 's', takenAt: new Date().toISOString(), window: WINDOW }),
          act: async (req: ActionRequest) => (acts.push(req), { actionId: req.actionId, status: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
          waitFor: async () => ({ ok: true, evidence: [] }),
          close: async () => void (closed += 1),
        } as unknown as Session;
      },
      spawn: createLineProcessSpawner({ inheritEnv: false }),
      interpreters: { node: process.execPath },
      hostEnv: { ...process.env, ECHO_KEY: 'k' },
      inboxPollMs: 20,
      log: (l) => lines.push(l),
      resident: { killGraceMs: 300, heartbeatTimeoutMs: 3000, workHoursPollMs: 50, restartDelaysMs: [50] },
    });
    assert.deepEqual(host.agents.map((a) => a.agentId), ['test.hosted']);
    assert.equal(host.skipped.length, 1);
    assert.match(host.skipped[0]!.reason, /no agent package/);

    // The approval lands in the inbox; the status file shows the run blocked on it.
    const inbox = inboxPaths(paths.dir);
    const deadline = Date.now() + 8000;
    while (listInbox(inbox).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const [entry] = listInbox(inbox);
    assert.equal(entry?.kind, 'approval');
    assert.equal(readStatusFile(paths.status).runs[0]!.blockedOn?.kind, 'approval');
    decide(inbox, entry!.id, { kind: 'approval', decision: 'grant' });

    while (!lines.some((l) => /task .* succeeded/.test(l)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.some((l) => /task .* succeeded/.test(l)), lines.join('\n'));
    assert.equal(acts.length, 1);
    assert.deepEqual(opened.map((o) => [o.agentId, o.profile.id, o.submitAllowed]), [['test.hosted', 'calc-800x600', true]]);
    const audit = (await readFile(paths.audit, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a) => [a.decision, a.result, a.target]), [['allowed', 'ok', 'equals']]);
    const usage = (await readFile(paths.usage, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(usage.map((u) => [u.agentId, u.providerId, u.ok]), [['test.hosted', 'echo', true]]);

    assert.deepEqual(quit, [], 'apps stay while the host runs');
    await host.stop();
    assert.equal(closed, 1, 'the session is given back when the run ends');
    assert.deepEqual(quit, [99], 'the app the runtime launched is ended once the host stops, never left for the user\'s screen');
    const runs = readStatusFile(paths.status).runs;
    assert.equal(runs[0]!.state, 'done');
  } finally {
    await api.close();
    await rm(tasksDir, { recursive: true, force: true });
  }
});

test('one host per tasks directory; a pid file left by a dead host is taken over', async () => {
  const tasksDir = await tmp('agent-claim-');
  try {
    const paths = agentDataPaths(tasksDir);
    const release = claimHost(paths);
    assert.equal(runningHostPid(paths), process.pid);
    // Another live process holds it.
    await writeFile(paths.hostPid, `${process.ppid}\n`);
    assert.throws(() => claimHost(paths, 1234567), (e) => isRuntimeError(e, 'conflict'));
    // A dead one does not.
    await writeFile(paths.hostPid, '999999\n');
    const again = claimHost(paths, process.pid);
    assert.equal(runningHostPid(paths), process.pid);
    again();
    assert.equal(runningHostPid(paths), undefined);
    release();
  } finally {
    await rm(tasksDir, { recursive: true, force: true });
  }
});

test('a host without a valid config does not start', async () => {
  const tasksDir = await tmp('agent-noconf-');
  try {
    await assert.rejects(
      startAgentHostDaemon({ tasksDir, openSession: async () => { throw new Error('unused'); }, spawn: createLineProcessSpawner({ inheritEnv: false }) }),
      (e) => isRuntimeError(e, 'not_found'),
    );
    await writeFile(agentDataPaths(tasksDir).config, JSON.stringify({ agents: [{ package: 'rel', enabled: true }] }));
    await assert.rejects(
      startAgentHostDaemon({ tasksDir, openSession: async () => { throw new Error('unused'); }, spawn: createLineProcessSpawner({ inheritEnv: false }) }),
      (e) => isRuntimeError(e, 'invalid_input'),
    );
  } finally {
    await rm(tasksDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Grants and reload

const RETRYING_AGENT = String.raw`
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let seq = 0, runId, n = 0; const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, agentRunId: runId, seq: ++seq, at: new Date().toISOString(), ...m }) + '\n');
const ask = (m, k) => new Promise((r) => { pending.set(k, r); send(m); });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'agent_start') { runId = m.agentRunId; void go(); return; }
  if (m.type === 'task_start') {
    send({ type: 'item', taskId: m.taskId, itemId: 'given', status: 'committed', data: { input: m.input } });
    send({ type: 'task_finished', taskId: m.taskId, status: 'succeeded' });
    return;
  }
  if (m.type === 'stop') { send({ type: 'agent_stopped', reason: 'stop' }); process.exit(0); }
  const k = m.requestId ?? m.approvalId; const r = pending.get(k); if (r) { pending.delete(k); r(m); }
});
setInterval(() => runId && send({ type: 'heartbeat', state: 'idle' }), 100);
async function go() {
  const c = await ask({ type: 'create_task', requestId: 'c', taskType: 'press', input: {} }, 'c');
  for (;;) {
    const id = 'r' + ++n;
    const a = await ask({ type: 'act', taskId: c.taskId, requestId: id, app: 'com.apple.calculator',
      action: { kind: 'click', target: { kind: 'element', label: 'Equals' }, effect: 'external-submit' } }, id);
    if (a.result) {
      send({ type: 'item', taskId: c.taskId, itemId: 'done', status: 'committed', data: { tries: n } });
      send({ type: 'task_finished', taskId: c.taskId, status: 'succeeded' });
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
`;

test('grants are edited in the config with an end, replaced per application and effect, and listed with whether they hold', async () => {
  const tasksDir = await tmp('agent-grants-');
  try {
    const pkg = await makePackage(join(tasksDir, 'pkg'), RETRYING_AGENT);
    const paths = agentDataPaths(tasksDir);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.config, JSON.stringify({ agents: [{ package: pkg, enabled: true, account: { platform: 'macos', accountKey: 'local' } }], providers: {} }));
    const now = new Date('2026-10-07T08:00:00Z');
    assert.throws(() => grantInConfig(paths.config, { agentId: 'test.hosted', application: 'com.apple.calculator', effect: 'external-submit', mode: 'human_in_the_loop' }, now), /one of the two/);
    assert.throws(() => grantInConfig(paths.config, { agentId: 'test.hosted', application: 'x', effect: 'external-submit', mode: 'human_in_the_loop', expiresAt: '2026-10-01T00:00:00Z' }, now), /already have ended/);
    assert.throws(() => grantInConfig(paths.config, { agentId: 'nobody', application: 'x', effect: 'external-submit', mode: 'human_in_the_loop', durable: true }, now), (e) => isRuntimeError(e, 'not_found'));
    assert.throws(() => grantInConfig(paths.config, { agentId: 'test.hosted', application: 'x', effect: 'external-submit', mode: 'whenever' as never, durable: true }, now), (e) => isRuntimeError(e, 'invalid_input'));
    grantInConfig(paths.config, { agentId: 'test.hosted', application: 'com.apple.calculator', effect: 'external-submit', mode: 'human_in_the_loop', expiresAt: '2026-10-08T08:00:00Z' }, now);
    const replaced = grantInConfig(paths.config, { agentId: 'test.hosted', application: 'com.apple.calculator', effect: 'external-submit', mode: 'trusted_within_ceiling', durable: true }, now);
    assert.deepEqual(replaced.map((g) => [g.application, g.effect, g.mode, g.durable, g.active]), [['com.apple.calculator', 'external-submit', 'trusted_within_ceiling', true, true]]);
    grantInConfig(paths.config, { agentId: 'test.hosted', application: 'com.apple.mail', effect: 'external-submit', mode: 'human_in_the_loop', expiresAt: '2026-10-07T09:00:00Z' }, now);
    const later = listGrants(paths.config, undefined, new Date('2026-10-07T10:00:00Z'));
    assert.deepEqual(later.map((g) => [g.application, g.active]), [['com.apple.calculator', true], ['com.apple.mail', false]]);
    const left = revokeInConfig(paths.config, { agentId: 'test.hosted', application: 'com.apple.mail' }, now);
    assert.equal(left.length, 1);
    assert.throws(() => revokeInConfig(paths.config, { agentId: 'test.hosted', application: 'com.apple.mail' }, now), (e) => isRuntimeError(e, 'not_found'));
    assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
  } finally {
    await rm(tasksDir, { recursive: true, force: true });
  }
});

test('a grant given while the agent runs takes effect at once, without restarting it; other changes restart or stop only what they touch', async () => {
  const tasksDir = await tmp('agent-reload-');
  const paths = agentDataPaths(tasksDir);
  try {
    const pkg = await makePackage(join(tasksDir, 'pkg'), RETRYING_AGENT, { approval: { 'external-submit': 'trusted_within_ceiling' } });
    await mkdir(paths.dir, { recursive: true });
    const entry = { package: pkg, enabled: true, account: { platform: 'macos', accountKey: 'local' } };
    await writeFile(paths.config, JSON.stringify({ agents: [entry], providers: {} }));
    const lines: string[] = [];
    const opened: boolean[] = [];
    const acts: ActionRequest[] = [];
    let snaps = 0;
    const host = await startAgentHostDaemon({
      tasksDir,
      openSession: async (r) => {
        opened.push(r.takeOver);
        return {
          binding: () => ({ screenId: r.profile.id, socket: '/tmp/x', window: WINDOW, launchedByRuntime: false }),
          observe: async () => ({ snapshotId: `s${++snaps}`, sessionId: 's', takenAt: new Date().toISOString(), window: WINDOW }),
          act: async (req: ActionRequest) => (acts.push(req), { actionId: req.actionId, status: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
          waitFor: async () => ({ ok: true, evidence: [] }),
          close: async () => {},
        } as unknown as Session;
      },
      spawn: createLineProcessSpawner({ inheritEnv: false }),
      interpreters: { node: process.execPath },
      configPollMs: 60_000, // reloads are driven by the test
      log: (l) => lines.push(l),
      resident: { killGraceMs: 300, heartbeatTimeoutMs: 3000, workHoursPollMs: 50, restartDelaysMs: [50] },
    });
    const until = async (what: string, ok: () => boolean) => {
      const deadline = Date.now() + 8000;
      while (!ok()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${lines.join('\n')}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const audits = async () => (await readFile(paths.audit, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let refused = 0;
    await until('refusals without a grant', () => {
      void audits().then((a) => (refused = a.filter((x) => x.reason === 'not_granted').length));
      return refused >= 2;
    });
    assert.equal(acts.length, 0);
    const runId = host.agents[0]!.agent.currentRunId();

    grantInConfig(paths.config, { agentId: 'test.hosted', application: 'com.apple.calculator', effect: 'external-submit', mode: 'trusted_within_ceiling', durable: true });
    await host.reload();
    await until('the task to succeed once granted', () => lines.some((l) => /task .* succeeded/.test(l)));
    assert.equal(acts.length, 1);
    assert.equal(host.agents[0]!.agent.currentRunId(), runId, 'the same process: the grant applied in place');

    // An invalid config changes nothing.
    await writeFile(paths.config, JSON.stringify({ agents: [{ ...entry, enabled: 'yes' }], providers: {} }));
    await host.reload();
    assert.ok(lines.some((l) => /config not reloaded/.test(l)));
    assert.equal(host.agents.length, 1);

    // takeOver changes the binding: that agent is restarted with it.
    await writeFile(paths.config, JSON.stringify({ agents: [{ ...entry, takeOver: true }], providers: {} }));
    await host.reload();
    assert.ok(lines.some((l) => /restarting it/.test(l)));
    await until('a session opened with takeOver', () => opened.includes(true));
    assert.notEqual(host.agents[0]!.agent.currentRunId(), runId);

    // Disabled: stopped.
    await writeFile(paths.config, JSON.stringify({ agents: [{ ...entry, enabled: false }], providers: {} }));
    await host.reload();
    assert.equal(host.agents.length, 0);
    assert.ok(lines.some((l) => /no longer enabled/.test(l)));
    await host.stop();
  } finally {
    await rm(tasksDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tasks on request

const TASK_AGENT = String.raw`
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let seq = 0, runId; const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, agentRunId: runId, seq: ++seq, at: new Date().toISOString(), ...m }) + '\n');
const ask = (m, k) => new Promise((r) => { pending.set(k, r); send(m); });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'agent_start') { runId = m.agentRunId; return; }
  if (m.type === 'task_start') { void go(m); return; }
  const k = m.requestId; const r = pending.get(k); if (r) { pending.delete(k); r(m); }
});
async function go(t) {
  await ask({ type: 'observe', taskId: t.taskId, requestId: 'o', app: 'com.apple.calculator' }, 'o');
  await new Promise((r) => setTimeout(r, Number(t.input.waitMs ?? 0)));
  send({ type: 'item', taskId: t.taskId, itemId: 'echo', status: 'committed', data: { input: t.input } });
  send({ type: 'task_finished', taskId: t.taskId, status: 'succeeded' });
  rl.close();
}
`;

test('submitted tasks run on task agents one at a time, reach resident agents, and every task leaves an outcome', async () => {
  const tasksDir = await tmp('agent-requests-');
  const paths = agentDataPaths(tasksDir);
  const req = requestPaths(paths.dir);
  let hostRef: { stop(): Promise<void> } | undefined;
  try {
    const taskPkg = await makePackage(join(tasksDir, 'task-pkg'), TASK_AGENT, { id: 'test.task', mode: 'task', schedule: undefined, effects: ['read'], approval: {} });
    const residentPkg = await makePackage(join(tasksDir, 'res-pkg'), RETRYING_AGENT, { id: 'test.resident', approval: { 'external-submit': 'trusted_within_ceiling' } });
    await mkdir(paths.dir, { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        agents: [
          { package: taskPkg, enabled: true, account: { platform: 'macos', accountKey: 'local' } },
          {
            package: residentPkg,
            enabled: true,
            account: { platform: 'macos', accountKey: 'local' },
            grants: [{ application: 'com.apple.calculator', effect: 'external-submit', mode: 'trusted_within_ceiling', durable: true }],
          },
        ],
        providers: {},
      }),
    );
    let openNow = 0;
    let maxOpen = 0;
    const host = await startAgentHostDaemon({
      tasksDir,
      openSession: async (r) => {
        openNow += 1;
        maxOpen = Math.max(maxOpen, openNow);
        return {
          binding: () => ({ screenId: r.profile.id, socket: '/tmp/x', window: WINDOW, launchedByRuntime: false }),
          observe: async () => ({ snapshotId: 's', sessionId: 's', takenAt: new Date().toISOString(), window: WINDOW }),
          act: async (q: ActionRequest) => ({ actionId: q.actionId, status: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
          waitFor: async () => ({ ok: true, evidence: [] }),
          close: async () => void (openNow -= 1),
        } as unknown as Session;
      },
      spawn: createLineProcessSpawner({ inheritEnv: false }),
      interpreters: { node: process.execPath },
      requestPollMs: 30,
      configPollMs: 60_000,
      resident: { killGraceMs: 300, heartbeatTimeoutMs: 3000, workHoursPollMs: 50, restartDelaysMs: [50] },
    });
    hostRef = host;
    assert.deepEqual(host.taskAgents(), ['test.task']);
    const at = () => new Date().toISOString();
    submitTaskRequest(req, { taskId: 'job-1', agentId: 'test.task', taskType: 'press', input: { n: 1, waitMs: 150 }, submittedAt: at() });
    submitTaskRequest(req, { taskId: 'job-2', agentId: 'test.task', taskType: 'press', input: { n: 2 }, submittedAt: at() });
    submitTaskRequest(req, { taskId: 'job-3', agentId: 'nobody', taskType: 'press', input: {}, submittedAt: at() });
    submitTaskRequest(req, { taskId: 'job-4', agentId: 'test.task', taskType: 'fly', input: {}, submittedAt: at() });
    submitTaskRequest(req, { taskId: 'job-5', agentId: 'test.resident', taskType: 'press', input: {}, submittedAt: at() });
    assert.throws(() => submitTaskRequest(req, { taskId: 'job-1', agentId: 'test.task', taskType: 'press', input: {}, submittedAt: at() }), (e) => isRuntimeError(e, 'conflict'));
    assert.equal(readOutcome(req, 'job-2')!.state, 'queued');

    const ended = (id: string) => ['succeeded', 'partial', 'failed'].includes(readOutcome(req, id)?.state ?? '');
    const deadline = Date.now() + 10_000;
    while (!['job-1', 'job-2', 'job-3', 'job-4', 'job-5'].every(ended) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
    const o = (id: string) => readOutcome(req, id)!;
    assert.equal(o('job-1').state, 'succeeded', JSON.stringify(o('job-1')));
    assert.deepEqual(o('job-1').items![0]!.data, { input: { n: 1, waitMs: 150 } });
    assert.equal(o('job-2').state, 'succeeded');
    assert.ok(o('job-2').startedAt! >= o('job-1').endedAt!, 'one task at a time per task agent');
    assert.deepEqual([o('job-3').state, o('job-3').failure], ['failed', 'not_found']);
    assert.deepEqual([o('job-4').state, o('job-4').failure], ['failed', 'invalid_input']);
    assert.equal(o('job-5').state, 'succeeded', 'a resident agent takes a submitted task');
    // The resident agent's own task has an outcome too.
    const own = readdirSync(req.outcomes).map((f) => o(f.replace(/\.json$/, ''))).filter((r) => r.origin === 'agent');
    assert.equal(own.length >= 1, true);
    assert.equal(maxOpen <= 2, true, 'sessions are opened per task and closed after');

    // Stopping the host: a queued task never starts and says so.
    submitTaskRequest(req, { taskId: 'job-6', agentId: 'test.task', taskType: 'press', input: { waitMs: 2000 }, submittedAt: at() });
    submitTaskRequest(req, { taskId: 'job-7', agentId: 'test.task', taskType: 'press', input: {}, submittedAt: at() });
    host.takeRequests();
    await host.stop();
    assert.deepEqual([o('job-7').state, o('job-7').failure], ['failed', 'cancelled']);
    assert.equal(o('job-6').state, 'failed');
  } finally {
    await hostRef?.stop();
    await rm(tasksDir, { recursive: true, force: true });
  }
});

test('submit words: an agent id, a task type, JSON input and an optional timeout', () => {
  assert.deepEqual(parseSubmit(['a.b', 'press']), { agentId: 'a.b', taskType: 'press', input: {} });
  assert.deepEqual(parseSubmit(['a.b', 'press', '--input', '{"k":[1,2]}', '--timeout', '2h']), { agentId: 'a.b', taskType: 'press', input: { k: [1, 2] }, timeoutMs: 7_200_000 });
  assert.throws(() => parseSubmit(['a.b', 'Press', '--input', '{bad', '--timeout', 'soon', '--x']), (e) => isRuntimeError(e, 'invalid_input') && (e.details as { errors: string[] }).errors.length === 4);
});
