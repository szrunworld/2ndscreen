import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionManager, matchElements } from '../src/session.ts';
import {
  RuntimeError,
  isRuntimeError,
  leaseScopesOverlap,
  type ActionRequest,
  type ActionResult,
  type DesktopAdapter,
  type LeaseStore,
  type LocalVision,
  type Locator,
  type Observation,
  type ObserveOptions,
  type SessionLease,
  type UIElement,
  type WindowBinding,
  type WindowGeometry,
  type WindowProfile,
} from '../src/contracts.ts';

// Synthetic desktop and lease store: no 2ndscreen, no screen, no app.

const BUNDLE = 'com.example.synthetic';
const profile: WindowProfile = { id: 'synthetic-1440x900', version: 1, logicalWidth: 1440, logicalHeight: 900, bundleId: BUNDLE };
const FRAME = { x: 3000, y: 25, width: 1360, height: 848 };

function windowOf(pid = 4242, windowId = 77, startedAt = '2026-09-17T21:55:13.000Z'): WindowGeometry {
  return { pid, windowId, processStartedAt: startedAt, bundleId: BUNDLE, title: 'Synthetic', frame: FRAME, contentFrame: FRAME, scale: 2, displayId: 7 };
}

/** In-memory LeaseStore following the contract: overlapping unexpired scopes conflict. */
function memoryLeases(now: () => number = Date.now) {
  const leases = new Map<string, SessionLease>();
  let next = 0;
  const calls: string[] = [];
  let failRenew = false;
  const store: LeaseStore & { leases: typeof leases; calls: string[]; failRenewals(): void } = {
    leases,
    calls,
    failRenewals: () => {
      failRenew = true;
    },
    async acquireLease(request) {
      calls.push(`acquire ${request.scopeKey}`);
      for (const held of leases.values())
        if (leaseScopesOverlap(held.scopeKey, request.scopeKey) && Date.parse(held.expiresAt) > now())
          throw new RuntimeError('lease_held', `${held.scopeKey} is held`);
      const { ttlMs, ...rest } = request;
      const lease: SessionLease = { ...rest, leaseId: `lease-${++next}`, expiresAt: new Date(now() + ttlMs).toISOString() };
      leases.set(lease.leaseId, lease);
      return lease;
    },
    async renewLease(leaseId, ttlMs) {
      calls.push(`renew ${leaseId}`);
      const held = leases.get(leaseId);
      if (!held || failRenew) throw new RuntimeError('lease_held', 'lease lost');
      const renewed = { ...held, expiresAt: new Date(now() + ttlMs).toISOString() };
      leases.set(leaseId, renewed);
      return renewed;
    },
    async releaseLease(leaseId) {
      calls.push(`release ${leaseId}`);
      leases.delete(leaseId);
    },
  };
  return store;
}

interface FakeAdapter extends DesktopAdapter {
  acts: Array<{ binding: WindowBinding; request: ActionRequest }>;
  observes: ObserveOptions[];
  released: WindowBinding[];
  bindCalls: Array<{ takeOver: boolean }>;
  elements: UIElement[];
  text?: string;
  screenshot?: Observation['screenshot'];
  /** What bindApp does next; defaults to attaching the current window. */
  bind?: (takeOver: boolean) => WindowBinding;
  window: WindowGeometry;
  actDelayMs: number;
}

function fakeAdapter(): FakeAdapter {
  let n = 0;
  const adapter: FakeAdapter = {
    acts: [],
    observes: [],
    released: [],
    bindCalls: [],
    elements: [
      { index: 0, role: 'AXButton', label: 'Open', frame: { x: 3010, y: 40, width: 50, height: 20 } },
      { index: 1, role: 'AXButton', label: 'Close', frame: { x: 3100, y: 40, width: 50, height: 20 } },
      { index: 2, role: 'AXRow', label: 'Row A', frame: { x: 3010, y: 100, width: 300, height: 30 } },
      { index: 3, role: 'AXRow', label: 'Row B', frame: { x: 3010, y: 140, width: 300, height: 30 } },
    ],
    window: windowOf(),
    actDelayMs: 0,
    async capabilities() {
      return { version: 'x', backgroundClick: true, backgroundScroll: true, backgroundType: false, screenshot: true, accessibility: true, screenRecordingPermission: true, accessibilityPermission: true };
    },
    async ensureScreen() {
      return { screenId: profile.id, socket: '/tmp/s.sock' };
    },
    async bindApp(screenId, _profile, options) {
      adapter.bindCalls.push({ takeOver: options.takeOver });
      if (adapter.bind) return adapter.bind(options.takeOver);
      return { screenId, socket: '/tmp/s.sock', window: adapter.window, launchedByRuntime: true };
    },
    async observe(binding, options, signal) {
      if (signal?.aborted) throw new RuntimeError('cancelled', 'cancelled');
      adapter.observes.push(options);
      const o: Observation = { snapshotId: `snap-${++n}`, sessionId: '', takenAt: new Date().toISOString(), window: binding.window, text: adapter.text };
      if (options.elements !== false) o.elements = adapter.elements;
      if (options.screenshot) o.screenshot = adapter.screenshot;
      return o;
    },
    async act(binding, request, signal) {
      if (signal?.aborted) throw new RuntimeError('cancelled', 'cancelled');
      adapter.acts.push({ binding, request });
      if (adapter.actDelayMs) await new Promise((r) => setTimeout(r, adapter.actDelayMs));
      const at = new Date().toISOString();
      const result: ActionResult = { actionId: request.actionId, status: 'ok', route: 'element', startedAt: at, finishedAt: at };
      return result;
    },
    async releaseWindow(binding) {
      adapter.released.push(binding);
    },
  };
  return adapter;
}

const policy = { submitAllowed: false, foregroundAllowed: false };

async function openSession(options: { takeOver?: boolean; ttl?: number; vision?: LocalVision; adapter?: FakeAdapter; leases?: ReturnType<typeof memoryLeases> } = {}) {
  const adapter = options.adapter ?? fakeAdapter();
  const leases = options.leases ?? memoryLeases();
  const manager = createSessionManager({ adapter, leases, policy, vision: options.vision, ownerPid: 31337, pollMs: 50 });
  const session = await manager.open({ taskId: 't1', profile, takeOver: options.takeOver ?? false, leaseTtlMs: options.ttl ?? 60_000 });
  return { adapter, leases, manager, session };
}

const click = (target: Locator, snapshotId?: string): ActionRequest => ({
  actionId: `a-${Math.random()}`,
  snapshotId,
  action: { kind: 'click', target, effect: 'navigation' },
});

test('open takes one app-wide lease for the worker, binds the window, and gives the lease back on failure', async () => {
  const { session, leases } = await openSession();
  assert.equal(session.lease.scopeKey, `${BUNDLE}:*`);
  assert.equal(session.lease.ownerPid, 31337);
  assert.equal(session.lease.holder, 'runtime');
  assert.equal(session.lease.taskId, 't1');
  assert.equal(session.binding().window.windowId, 77);

  // Another task on the same app, even with an account, is refused before any desktop work.
  const other = fakeAdapter();
  const second = createSessionManager({ adapter: other, leases, policy });
  await assert.rejects(
    second.open({ taskId: 't2', profile, takeOver: false, account: { platform: 'boss', accountKey: 'acct1', binding: 'observed' }, leaseTtlMs: 60_000 }),
    (e) => isRuntimeError(e, 'lease_held'),
  );
  assert.equal(other.bindCalls.length, 0);
  await session.close({ keepWindow: true });

  const failing = fakeAdapter();
  failing.bind = () => {
    throw new RuntimeError('conflict', 'running elsewhere');
  };
  const fresh = memoryLeases();
  await assert.rejects(createSessionManager({ adapter: failing, leases: fresh, policy }).open({ taskId: 't3', profile, takeOver: false, leaseTtlMs: 60_000 }), (e) => isRuntimeError(e, 'conflict'));
  assert.equal(fresh.leases.size, 0);
  assert.equal(failing.bindCalls[0]?.takeOver, false);
});

test('an account-bound open scopes the lease to that account', async () => {
  const leases = memoryLeases();
  const session = await createSessionManager({ adapter: fakeAdapter(), leases, policy }).open({
    taskId: 't',
    profile,
    takeOver: false,
    account: { platform: 'boss', accountKey: 'acct1', binding: 'explicit' },
    leaseTtlMs: 60_000,
  });
  assert.equal(session.lease.scopeKey, `${BUNDLE}:acct1`);
  await session.close({ keepWindow: true });
});

test('element indexes are honoured only against the latest snapshot; any action makes it stale', async () => {
  const { session, adapter } = await openSession();
  const first = await session.observe();
  assert.equal(first.sessionId, session.id);
  const second = await session.observe();

  const old = await session.act(click({ kind: 'element', index: 0 }, first.snapshotId));
  assert.equal(old.status, 'stale_snapshot');
  assert.equal(old.error?.code, 'snapshot_stale');
  assert.equal(adapter.acts.length, 0);

  const missing = await session.act(click({ kind: 'element', index: 42 }, second.snapshotId));
  assert.equal(missing.status, 'stale_snapshot');

  const ok = await session.act(click({ kind: 'element', index: 0 }, second.snapshotId));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.beforeSnapshotId, second.snapshotId);
  assert.equal(adapter.acts.length, 1);

  const again = await session.act(click({ kind: 'element', index: 0 }, second.snapshotId));
  assert.equal(again.status, 'stale_snapshot', 'the page may have changed after the first click');
  assert.equal(adapter.acts.length, 1);
  await session.close({ keepWindow: true });
});

test('role and label locators are resolved on a fresh read, and must match exactly one element', async () => {
  const { session, adapter } = await openSession();
  const r = await session.act(click({ kind: 'element', role: 'AXButton', label: 'Close' }));
  assert.equal(r.status, 'ok');
  assert.equal(adapter.observes.length, 1, 'reobserved before acting');
  const sent = adapter.acts[0]!.request;
  assert.deepEqual(sent.action.kind === 'click' && sent.action.target, { kind: 'element', index: 1 });
  assert.equal(sent.snapshotId, r.beforeSnapshotId);

  const many = await session.act(click({ kind: 'element', role: 'AXRow' }));
  assert.equal(many.status, 'failed');
  assert.equal(many.error?.code, 'conflict');
  const within = await session.act(click({ kind: 'element', role: 'AXRow', within: { x: 3000, y: 130, width: 400, height: 50 } }));
  assert.equal(within.status, 'ok');
  const none = await session.act(click({ kind: 'element', labelPattern: '^Nobody' }));
  assert.equal(none.error?.code, 'not_found');
  assert.equal(adapter.acts.length, 2);
  await session.close({ keepWindow: true });
});

test('relative points pass through; external-submit is forbidden; bad requests are invalid', async () => {
  const { session, adapter } = await openSession();
  const r = await session.act({ actionId: 'r', action: { kind: 'click', target: { kind: 'relative', point: { x: 0.2, y: 0.3 } }, effect: 'read' } });
  assert.equal(r.status, 'ok');
  assert.deepEqual(adapter.observes, [{ elements: false }], 'a fresh read measures the window first');
  assert.ok(r.beforeSnapshotId);
  await assert.rejects(session.act({ actionId: 's', action: { kind: 'key', key: 'return', effect: 'external-submit' } }), (e) => isRuntimeError(e, 'forbidden_effect'));
  await assert.rejects(session.act({ actionId: 'i', action: { kind: 'click', target: { kind: 'element', index: 1 }, effect: 'read' } }), (e) => isRuntimeError(e, 'invalid_input'));
  assert.equal(adapter.acts.length, 1);
  await session.close({ keepWindow: true });

  const allowing = createSessionManager({ adapter: fakeAdapter(), leases: memoryLeases(), policy: { submitAllowed: true, foregroundAllowed: false } });
  const s2 = await allowing.open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 60_000 });
  assert.equal((await s2.act({ actionId: 's', action: { kind: 'key', key: 'return', effect: 'external-submit' } })).status, 'ok');
  await s2.close({ keepWindow: true });
});

test('ocr and template locators need local vision and convert measured screenshot pixels to window fractions', async () => {
  const bare = await openSession();
  const missing = await bare.session.act(click({ kind: 'ocr', text: '查看全部' }));
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error?.code, 'capability_missing');
  assert.equal(bare.adapter.acts.length, 0);
  await bare.session.close({ keepWindow: true });

  const rois: unknown[] = [];
  const vision: LocalVision = {
    async ocr(_path, options) {
      rois.push(options?.roi);
      return { imageSha256: 'h', widthPx: 2720, heightPx: 1696, lines: [{ text: '查看全部 >', box: { x: 1340, y: 828, width: 40, height: 40 }, confidence: 0.9 }] };
    },
    async compare() {
      return { similarity: 1 };
    },
    async close() {},
  };
  const adapter = fakeAdapter();
  adapter.screenshot = { path: '/tmp/x.png', widthPx: 2720, heightPx: 1696, covers: FRAME, sha256: 'h' };
  const { session } = await openSession({ adapter, vision });
  const r = await session.act(click({ kind: 'ocr', text: '查看全部', region: { x: 3000, y: 25, width: 680, height: 424 } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(adapter.observes[0], { elements: false, screenshot: true });
  // Pixel centre (1360, 848) at 2 px/pt is global (3680, 449), half-way across the window.
  const sent = adapter.acts[0]!.request.action;
  assert.deepEqual(sent.kind === 'click' && sent.target, { kind: 'relative', point: { x: 0.5, y: 0.5 } });
  assert.deepEqual(rois[0], { x: 0, y: 0, width: 1360, height: 848 });
  const template = await session.act(click({ kind: 'template', templateId: 'close-button' }));
  assert.equal(template.error?.code, 'capability_missing', 'vision without findTemplate cannot match templates');
  await session.close({ keepWindow: true });
});

test('while another actor holds the window, the session neither reads nor acts, and its snapshot goes stale', async () => {
  const { session, adapter } = await openSession();
  const before = await session.observe();
  const outer = new AbortController();
  let grantSignal: AbortSignal | undefined;
  const result = await session.withExclusiveActor(
    'bridge',
    async (grant) => {
      grantSignal = grant.signal;
      assert.equal(grant.holder, 'bridge');
      assert.equal(grant.binding.window.windowId, 77);
      await assert.rejects(session.act(click({ kind: 'element', index: 0 }, before.snapshotId)), (e) => isRuntimeError(e, 'actor_busy'));
      await assert.rejects(session.observe(), (e) => isRuntimeError(e, 'actor_busy'));
      await assert.rejects(session.rebind(), (e) => isRuntimeError(e, 'actor_busy'));
      await assert.rejects(session.withExclusiveActor('bridge', async () => 1), (e) => isRuntimeError(e, 'actor_busy'));
      outer.abort();
      assert.equal(grant.signal.aborted, true, 'cancelling the caller reaches the actor');
      return 'explored';
    },
    outer.signal,
  );
  assert.equal(result, 'explored');
  assert.equal(grantSignal?.aborted, true);
  assert.equal(adapter.acts.length, 0);
  const stale = await session.act(click({ kind: 'element', index: 0 }, before.snapshotId));
  assert.equal(stale.status, 'stale_snapshot');
  const fresh = await session.observe();
  assert.equal((await session.act(click({ kind: 'element', index: 0 }, fresh.snapshotId))).status, 'ok');
  await session.close({ keepWindow: true });
});

test('a grant cannot start while an action is in flight', async () => {
  const adapter = fakeAdapter();
  adapter.actDelayMs = 100;
  const { session } = await openSession({ adapter });
  const acting = session.act(click({ kind: 'relative', point: { x: 0.1, y: 0.1 } }));
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(session.withExclusiveActor('bridge', async () => 1), (e) => isRuntimeError(e, 'actor_busy'));
  assert.equal((await acting).status, 'ok');
  assert.equal(await session.withExclusiveActor('bridge', async () => 2), 2);
  await session.close({ keepWindow: true });
});

test('waitFor polls fresh reads until the condition holds, within the bounded timeout', async () => {
  const { session, adapter } = await openSession();
  let reads = 0;
  let loadsAfter = 3;
  const observe = adapter.observe;
  adapter.observe = async (b, o, s) => {
    reads++;
    adapter.text = reads >= loadsAfter ? 'Resume loaded' : 'Loading';
    return observe(b, o, s);
  };
  const r = await session.waitFor({ condition: { kind: 'text', pattern: 'loaded$', present: true }, timeoutMs: 5_000, pollMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(reads, 3);
  assert.ok(r.snapshotId);
  assert.deepEqual(r.evidence, ['text found']);

  loadsAfter = Infinity;
  const started = Date.now();
  const timedOut = await session.waitFor({ condition: { kind: 'text', pattern: 'loaded$', present: true }, timeoutMs: 200, pollMs: 50 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.elapsedMs, 200);
  assert.ok(Date.now() - started < 1_000);
  assert.match(timedOut.evidence.at(-1)!, /timed out/);

  await assert.rejects(session.waitFor({ condition: { kind: 'page', pageClass: 'x' }, timeoutMs: 200_000 }), (e) => isRuntimeError(e, 'invalid_input'));
  await assert.rejects(session.waitFor({ condition: { kind: 'page', pageClass: 'x' }, timeoutMs: 1_000, pollMs: 10 }), (e) => isRuntimeError(e, 'invalid_input'));

  const controller = new AbortController();
  const pending = session.waitFor({ condition: { kind: 'page', pageClass: 'never' }, timeoutMs: 5_000, pollMs: 50 }, controller.signal);
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending, (e) => isRuntimeError(e, 'cancelled'));
  await session.close({ keepWindow: true });
});

test('check evaluates element, text, page, window, file and composite conditions with redacted evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a1-session-'));
  try {
    const { session } = await openSession();
    const o = { ...(await session.observe()), pageClass: 'online_resume', text: '候选人 张三 简历' };
    assert.equal((await session.check({ kind: 'element', locator: { kind: 'element', role: 'AXButton', label: 'Open' }, present: true }, o)).ok, true);
    assert.equal((await session.check({ kind: 'element', locator: { kind: 'element', label: 'Gone' }, present: false }, o)).ok, true);
    const text = await session.check({ kind: 'text', pattern: '张三', present: true }, o);
    assert.equal(text.ok, true);
    assert.ok(!text.evidence.join(' ').includes('张三'), 'page text never appears in evidence');
    assert.equal((await session.check({ kind: 'page', pageClass: 'online_resume' }, o)).ok, true);
    assert.equal((await session.check({ kind: 'window', bundleId: BUNDLE, titlePattern: '^Synth', present: true }, o)).ok, true);
    const file = join(dir, 'resume.pdf');
    assert.equal((await session.check({ kind: 'file', path: file }, o)).ok, false);
    await writeFile(file, Buffer.alloc(2048));
    assert.equal((await session.check({ kind: 'file', path: file, minBytes: 1024, stableMs: 20 }, o)).ok, true);
    assert.equal((await session.check({ kind: 'file', path: file, minBytes: 4096 }, o)).ok, false);
    const any = await session.check({ kind: 'any', conditions: [{ kind: 'page', pageClass: 'list' }, { kind: 'text', pattern: '简历', present: true }] }, o);
    assert.equal(any.ok, true);
    assert.equal(any.snapshotId, o.snapshotId);
    assert.equal((await session.check({ kind: 'all', conditions: [{ kind: 'page', pageClass: 'online_resume' }, { kind: 'page', pageClass: 'list' }] }, o)).ok, false);
    await assert.rejects(session.check({ kind: 'text', pattern: '(', present: true }, o), (e) => isRuntimeError(e, 'invalid_input'));
    // A file-only wait needs no window read.
    const reads = (await session.waitFor({ condition: { kind: 'file', path: file, minBytes: 1 }, timeoutMs: 1_000 })).ok;
    assert.equal(reads, true);
    await session.close({ keepWindow: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rebind never widens takeOver: even the process this session launched, once off screen, ends in conflict, not a move', async () => {
  const adapter = fakeAdapter();
  const { session } = await openSession({ adapter });
  // The screen was rebuilt and our own process is off it; the adapter cannot
  // promise to move only that process, so the session does not ask it to.
  adapter.bind = (takeOver) => {
    if (!takeOver) throw new RuntimeError('conflict', 'running elsewhere', { pid: 4242, processStartedAt: '2026-09-17T21:55:13.000Z', bundleId: BUNDLE });
    return { screenId: profile.id, socket: '/tmp/s.sock', window: windowOf(4242, 90), launchedByRuntime: false };
  };
  await assert.rejects(session.rebind(), (e) => isRuntimeError(e, 'conflict'));
  assert.deepEqual(adapter.bindCalls.slice(1), [{ takeOver: false }]);
  assert.equal(session.binding().window.windowId, 77, 'the old binding is kept, not replaced by a half-done rebind');

  // Back on its screen with a new window: the same process keeps its ownership.
  adapter.bind = () => ({ screenId: profile.id, socket: '/tmp/s.sock', window: windowOf(4242, 90), launchedByRuntime: false });
  const stale = await session.observe();
  const rebound = await session.rebind();
  assert.equal(rebound.window.windowId, 90);
  assert.equal(rebound.launchedByRuntime, true, 'still the process this session launched');
  assert.equal((await session.act(click({ kind: 'element', index: 0 }, stale.snapshotId))).status, 'stale_snapshot');

  // Same pid, different start time: a new process, which this session did not launch.
  adapter.bind = () => ({ screenId: profile.id, socket: '/tmp/s.sock', window: windowOf(4242, 91, '2026-10-04T09:00:00.000Z'), launchedByRuntime: false });
  assert.equal((await session.rebind()).launchedByRuntime, false);
  await session.close({ keepWindow: false });
  assert.equal(adapter.released.length, 0, 'a process it did not launch is not released');
});

test('rebind of an attached app never takes it over unless the task allowed it', async () => {
  const adapter = fakeAdapter();
  adapter.bind = () => ({ screenId: profile.id, socket: '/tmp/s.sock', window: windowOf(), launchedByRuntime: false });
  const { session } = await openSession({ adapter });
  adapter.bind = (takeOver) => {
    if (!takeOver) throw new RuntimeError('conflict', 'running elsewhere', { pid: 4242, processStartedAt: '2026-09-17T21:55:13.000Z' });
    return { screenId: profile.id, socket: '/tmp/s.sock', window: windowOf(), launchedByRuntime: false };
  };
  await assert.rejects(session.rebind(), (e) => isRuntimeError(e, 'conflict'));
  assert.deepEqual(adapter.bindCalls.slice(1), [{ takeOver: false }]);
  await session.close({ keepWindow: true });

  const allowed = fakeAdapter();
  allowed.bind = adapter.bind;
  const s2 = await openSession({ adapter: allowed, takeOver: true });
  const rebound = await s2.session.rebind();
  assert.equal(rebound.launchedByRuntime, false);
  assert.deepEqual(allowed.bindCalls.slice(1), [{ takeOver: true }]);
  await s2.session.close({ keepWindow: true });
});

test('the lease is renewed while the session lives; a failed renewal fences every further action', async () => {
  const { session, leases, adapter } = await openSession({ ttl: 1_200 });
  const firstExpiry = session.lease.expiresAt;
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(leases.calls.some((c) => c.startsWith('renew')));
  assert.ok(session.lease.expiresAt > firstExpiry);
  leases.failRenewals();
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(session.act(click({ kind: 'relative', point: { x: 0.5, y: 0.5 } })), (e) => isRuntimeError(e, 'lease_held'));
  await assert.rejects(session.observe(), (e) => isRuntimeError(e, 'lease_held'));
  assert.equal(adapter.acts.length, 0);
  await session.close({ keepWindow: false });
  assert.equal(adapter.released.length, 0, 'a fenced session no longer owns the window');
});

test('an expired lease fences the session even if no renewal ran', async () => {
  let now = Date.now();
  const leases = memoryLeases(() => now);
  const adapter = fakeAdapter();
  const session = await createSessionManager({ adapter, leases, policy, clock: { now: () => new Date(now) } }).open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 60_000 });
  now += 61_000;
  await assert.rejects(session.observe(), (e) => isRuntimeError(e, 'lease_held'));
  await session.close({ keepWindow: true });
});

test('close releases the window unless kept, gives back the lease once, and ends the session', async () => {
  const { session, leases, adapter } = await openSession();
  await session.close({ keepWindow: false });
  await session.close({ keepWindow: false });
  assert.equal(adapter.released.length, 1);
  assert.equal(adapter.released[0]?.window.windowId, 77);
  assert.equal(leases.leases.size, 0);
  assert.equal(leases.calls.filter((c) => c.startsWith('release')).length, 1);
  await assert.rejects(session.observe(), (e) => isRuntimeError(e, 'conflict'));

  const kept = await openSession();
  await kept.session.close({ keepWindow: true });
  assert.equal(kept.adapter.released.length, 0);
  assert.equal(kept.leases.leases.size, 0);
});

test('close never releases a window the session only attached to or took over', async () => {
  for (const takeOver of [false, true]) {
    const adapter = fakeAdapter();
    adapter.bind = () => ({ screenId: profile.id, socket: '/tmp/s.sock', window: windowOf(), launchedByRuntime: false });
    const { session, leases } = await openSession({ adapter, takeOver });
    await session.close({ keepWindow: false });
    assert.equal(adapter.released.length, 0, `takeOver=${takeOver}`);
    assert.equal(leases.leases.size, 0);
  }
});

test('every read re-measures the window, and the binding follows it', async () => {
  const adapter = fakeAdapter();
  const { session } = await openSession({ adapter });
  const moved = { x: 5000, y: 100, width: 1440, height: 875 };
  const observe = adapter.observe;
  adapter.observe = async (b, o, s) => {
    const r = await observe(b, o, s);
    return { ...r, window: { ...r.window, frame: moved, contentFrame: moved } };
  };
  await session.observe();
  assert.deepEqual(session.binding().window.frame, moved);
  assert.deepEqual(session.binding().window.contentFrame, moved);
  await session.act(click({ kind: 'relative', point: { x: 0.5, y: 0.5 } }));
  assert.deepEqual(adapter.acts.at(-1)!.binding.window.frame, moved, 'input goes out with the measured geometry');
  await session.close({ keepWindow: true });
});

test('close stops an outstanding grant and waits for the actor to finish before letting go', async () => {
  const { session, leases } = await openSession();
  const order: string[] = [];
  const grant = session.withExclusiveActor('bridge', (g) =>
    new Promise<void>((resolve) => {
      g.signal.addEventListener('abort', () =>
        setTimeout(() => {
          order.push('actor stopped');
          resolve();
        }, 30),
      );
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  await session.close({ keepWindow: true });
  order.push('closed');
  await grant;
  assert.deepEqual(order, ['actor stopped', 'closed']);
  assert.equal(leases.leases.size, 0);
});

test('cancellation stops open, act and observe before they touch the desktop', async () => {
  const adapter = fakeAdapter();
  const leases = memoryLeases();
  const manager = createSessionManager({ adapter, leases, policy });
  const aborted = AbortSignal.abort();
  await assert.rejects(manager.open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 60_000 }, aborted), (e) => isRuntimeError(e, 'cancelled'));
  assert.equal(leases.leases.size, 0);
  const session = await manager.open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 60_000 });
  await assert.rejects(session.act(click({ kind: 'relative', point: { x: 0.5, y: 0.5 } }), aborted), (e) => isRuntimeError(e, 'cancelled'));
  await assert.rejects(session.observe({}, aborted), (e) => isRuntimeError(e, 'cancelled'));
  assert.equal(adapter.acts.length + adapter.observes.length, 0);
  await session.close({ keepWindow: true });
});

test('matchElements filters by role, label, pattern and region', () => {
  const elements = fakeAdapter().elements;
  assert.deepEqual(matchElements(elements, { kind: 'element', labelPattern: '^Row' }).map((e) => e.index), [2, 3]);
  assert.deepEqual(matchElements(elements, { kind: 'element', role: 'AXButton', label: 'Open' }).map((e) => e.index), [0]);
  assert.deepEqual(matchElements(elements, { kind: 'element', role: 'AXRow', within: { x: 3000, y: 90, width: 400, height: 40 } }).map((e) => e.index), [2]);
});

// Races the coordinator's review called out: fencing, close and concurrent operations.

/** Resolves when the signal fires, after a short stop delay, like a real child process. */
const untilAborted = (signal: AbortSignal | undefined, stopMs = 20) =>
  new Promise<void>((resolve, reject) => {
    // Bounded: a missing abort fails the test instead of hanging it.
    const guard = setTimeout(() => reject(new Error('never aborted')), 5_000);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(guard);
        setTimeout(resolve, stopMs);
      },
      { once: true },
    );
  });

test('a lost lease aborts an actor holding the window and fences the session', async () => {
  const { session, leases } = await openSession({ ttl: 1_200 });
  let reason: unknown;
  const explored = session.withExclusiveActor('bridge', async (grant) => {
    leases.failRenewals();
    await untilAborted(grant.signal);
    reason = grant.signal.reason;
    return 'stopped';
  });
  assert.equal(await explored, 'stopped');
  assert.ok(isRuntimeError(reason, 'lease_held'));
  await assert.rejects(session.observe(), (e) => isRuntimeError(e, 'lease_held'));
  await session.close({ keepWindow: true });
});

test('a lost lease stops a native action in flight; its outcome is unknown, never retried', async () => {
  const adapter = fakeAdapter();
  let delivered = 0;
  adapter.act = async (_b, request, signal) => {
    delivered++;
    await untilAborted(signal);
    const at = new Date().toISOString();
    return { actionId: request.actionId, status: 'unknown', startedAt: at, finishedAt: at, error: { code: 'cancelled', message: 'cut off' } };
  };
  const { session, leases } = await openSession({ adapter, ttl: 1_200 });
  const pending = session.act(click({ kind: 'relative', point: { x: 0.5, y: 0.5 } }));
  leases.failRenewals();
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.equal(result.error?.code, 'lease_held');
  assert.equal(delivered, 1);
  await assert.rejects(session.act(click({ kind: 'relative', point: { x: 0.5, y: 0.5 } })), (e) => isRuntimeError(e, 'lease_held'));
  assert.equal(delivered, 1);
  await session.close({ keepWindow: false });
});

test('close stops a native action in flight and waits for it before releasing window and lease', async () => {
  const adapter = fakeAdapter();
  const order: string[] = [];
  adapter.act = async (_b, request, signal) => {
    await untilAborted(signal, 40);
    order.push('action stopped');
    const at = new Date().toISOString();
    return { actionId: request.actionId, status: 'unknown', startedAt: at, finishedAt: at };
  };
  const release = adapter.releaseWindow;
  adapter.releaseWindow = async (b, s) => {
    order.push('window released');
    return release(b, s);
  };
  const { session, leases } = await openSession({ adapter });
  const releaseLease = leases.releaseLease;
  leases.releaseLease = async (id) => {
    order.push('lease released');
    return releaseLease(id);
  };
  const pending = session.act(click({ kind: 'relative', point: { x: 0.5, y: 0.5 } }));
  await new Promise((r) => setTimeout(r, 10));
  await session.close({ keepWindow: false });
  assert.equal((await pending).status, 'unknown');
  assert.deepEqual(order, ['action stopped', 'window released', 'lease released']);
});

test('native operations never interleave: a second act, read, rebind or grant is refused while one runs', async () => {
  const adapter = fakeAdapter();
  const observe = adapter.observe;
  let slowReads = true;
  adapter.observe = async (b, o, s) => {
    if (slowReads) await new Promise((r) => setTimeout(r, 80));
    return observe(b, o, s);
  };
  const { session } = await openSession({ adapter });
  // A semantic act is mid-resolution (its fresh read is slow).
  const resolving = session.act(click({ kind: 'element', role: 'AXButton', label: 'Open' }));
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(session.act(click({ kind: 'relative', point: { x: 0.1, y: 0.1 } })), (e) => isRuntimeError(e, 'actor_busy'));
  await assert.rejects(session.observe(), (e) => isRuntimeError(e, 'actor_busy'));
  await assert.rejects(session.rebind(), (e) => isRuntimeError(e, 'actor_busy'));
  await assert.rejects(session.withExclusiveActor('bridge', async () => 1), (e) => isRuntimeError(e, 'actor_busy'));
  const done = await resolving;
  assert.equal(done.status, 'ok');
  assert.equal(adapter.acts.length, 1, 'only the first act was delivered');
  slowReads = false;
  assert.ok(await session.observe());
  await session.close({ keepWindow: true });
});

test('open keeps the lease renewed while a slow app launch outlasts its ttl', async () => {
  const adapter = fakeAdapter();
  const leases = memoryLeases();
  const bind = adapter.bindApp;
  adapter.bindApp = async (...args) => {
    await new Promise((r) => setTimeout(r, 1_500));
    return bind(...args);
  };
  const session = await createSessionManager({ adapter, leases, policy }).open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 1_200 });
  assert.ok(leases.calls.filter((c) => c.startsWith('renew')).length >= 2);
  assert.ok(Date.parse(session.lease.expiresAt) > Date.now());
  assert.ok((await session.observe()).snapshotId);
  await session.close({ keepWindow: true });
});

test('losing the lease during open stops preparation and leaves nothing behind', async () => {
  const adapter = fakeAdapter();
  const leases = memoryLeases();
  let stopped = false;
  adapter.bindApp = async (_s, _p, _o, signal) => {
    leases.failRenewals();
    await untilAborted(signal);
    stopped = true;
    throw new RuntimeError('cancelled', 'cut off');
  };
  await assert.rejects(createSessionManager({ adapter, leases, policy }).open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 1_200 }), (e) => isRuntimeError(e, 'lease_held'));
  assert.equal(stopped, true);
  assert.equal(leases.leases.size, 0);
  assert.equal(adapter.released.length, 0);
});

test('a failed open hands back a window it launched, but never one it only attached to or one of another app', async () => {
  for (const [launchedByRuntime, bundleId, released] of [
    [true, BUNDLE, 1],
    [false, BUNDLE, 0],
    [true, 'com.other.app', 0],
  ] as const) {
    const adapter = fakeAdapter();
    const leases = memoryLeases();
    const controller = new AbortController();
    adapter.bindApp = async (screenId) => {
      // Cancelled just as the app came up.
      if (bundleId === BUNDLE) controller.abort();
      return { screenId, socket: '/tmp/s.sock', window: { ...windowOf(), bundleId }, launchedByRuntime };
    };
    await assert.rejects(
      createSessionManager({ adapter, leases, policy }).open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 60_000 }, controller.signal),
      (e) => isRuntimeError(e, bundleId === BUNDLE ? 'cancelled' : 'conflict'),
    );
    assert.equal(adapter.released.length, released, `launched=${launchedByRuntime} bundle=${bundleId}`);
    assert.equal(leases.leases.size, 0);
  }
});
