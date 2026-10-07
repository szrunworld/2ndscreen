import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLineProcessSpawner } from '../src/adapters/agent-bridge.ts';
import { grantsOf, loadAgentPackage, localTime, validateHostConfig, workHoursFunction, type HostConfig } from '../src/agent-config.ts';
import { claimHost, runningHostPid, startAgentHostDaemon, type OpenSessionRequest } from '../src/agent-daemon.ts';
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
  const opened: OpenSessionRequest[] = [];
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
