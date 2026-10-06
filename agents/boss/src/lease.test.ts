import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openTaskStore } from '../../../packages/task-runtime/src/store.ts';
import { isRuntimeError, leaseScopeKey } from '../../../packages/task-runtime/src/contracts.ts';
import { Boss, BossError } from './boss.ts';
import { AppLease, LeaseBusyError, LeaseLostError, taskDbPath } from './lease.ts';
import { BOSS_BUNDLE, Setup, defaults } from './setup.ts';
import { Store } from './store.ts';

const ledger = () => join(mkdtempSync(join(tmpdir(), 'boss-lease-')), 'tasks.db');

test('the ledger is the task runtime one, or the one under SECONDSCREEN_TASKS_DIR', () => {
  assert.match(taskDbPath({}), /Library\/Application Support\/2ndscreen\/tasks\/tasks\.db$/);
  assert.equal(taskDbPath({ SECONDSCREEN_TASKS_DIR: '/tmp/x' }), '/tmp/x/tasks.db');
});

test('the assistant and a task runtime session never hold BOSS直聘 together', async () => {
  const dbPath = ledger();
  const assistant = await AppLease.acquire({ bundleId: BOSS_BUNDLE, dbPath });
  const runtime = await openTaskStore({ path: dbPath });
  try {
    // A task's session asks for its account scope; any scope on the bundle overlaps.
    await assert.rejects(
      runtime.acquireLease({ scopeKey: leaseScopeKey(BOSS_BUNDLE, 'acct1'), holder: 'runtime', ownerPid: 1, ttlMs: 30_000 }),
      (error: unknown) => isRuntimeError(error, 'lease_held'),
    );
    await assert.rejects(AppLease.acquire({ bundleId: BOSS_BUNDLE, dbPath }), LeaseBusyError);
    await assistant.release();
    const task = await runtime.acquireLease({ scopeKey: leaseScopeKey(BOSS_BUNDLE, 'acct1'), holder: 'runtime', ownerPid: 1, ttlMs: 30_000 });
    // While the task holds it, the assistant is told who does.
    await assert.rejects(AppLease.acquire({ bundleId: BOSS_BUNDLE, dbPath }), (error: unknown) =>
      error instanceof LeaseBusyError && /runtime \(pid 1\)/.test(error.message));
    await runtime.releaseLease(task.leaseId);
    const again = await AppLease.acquire({ bundleId: BOSS_BUNDLE, dbPath });
    await again.release();
  } finally {
    await assistant.release();
    await runtime.close();
  }
});

test('a lease past its local deadline fences every later action, even if nobody took it', async () => {
  let now = Date.now();
  const lease = await AppLease.acquire({ bundleId: BOSS_BUNDLE, dbPath: ledger(), ttlMs: 60_000, marginMs: 15_000, now: () => now });
  try {
    lease.check();
    now += 44_000;
    lease.check();
    now += 2_000; // within the margin of expiry: as if the process had been suspended
    assert.throws(() => lease.check(), LeaseLostError);
    // A later renewal does not revive it.
    now -= 40_000;
    await lease.renew();
    assert.throws(() => lease.check(), LeaseLostError);
  } finally {
    await lease.release();
  }
});

test('a renewal that fails fences the lease for good', async () => {
  const dbPath = ledger();
  const lease = await AppLease.acquire({ bundleId: BOSS_BUNDLE, dbPath });
  const other = await openTaskStore({ path: dbPath });
  try {
    // Someone removed the row (e.g. it expired and another owner took the app).
    await other.releaseLease(lease.leaseId);
    await lease.renew();
    assert.throws(() => lease.check(), LeaseLostError);
  } finally {
    await lease.release();
    await other.close();
  }
});

test('renewal keeps a held lease usable past its first term', async () => {
  let now = Date.now();
  const lease = await AppLease.acquire({ bundleId: BOSS_BUNDLE, dbPath: ledger(), ttlMs: 3_000, marginMs: 1_000, now: () => now });
  try {
    now += 1_500;
    await lease.renew();
    now += 1_500; // past the first term, inside the renewed one by the store's clock
    lease.check();
  } finally {
    await lease.release();
  }
});

/** A stand-in 2ndscreen that records that it ran. */
function fakeCli(): { cli: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'boss-cli-'));
  const marker = join(dir, 'ran');
  const cli = join(dir, '2ndscreen');
  writeFileSync(cli, `#!/bin/sh\ntouch '${marker}'\necho '{"ok":true,"elements":[],"windowFrame":{"x":0,"y":0,"width":1,"height":1},"screens":[]}'\n`);
  chmodSync(cli, 0o755);
  return { cli, marker };
}

test('a fenced Boss sends no command to BOSS直聘', async () => {
  const { cli, marker } = fakeCli();
  const fenced = new Boss('boss', 42, undefined, cli, () => {
    throw new LeaseLostError('lost');
  });
  await assert.rejects(fenced.state(), BossError);
  assert.equal(existsSync(marker), false);
  const allowed = new Boss('boss', 42, undefined, cli, () => {});
  await allowed.state();
  assert.equal(existsSync(marker), true);
});

test('a fenced Setup starts, creates and moves nothing', async () => {
  const { cli, marker } = fakeCli();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'boss-state-')), 'state.json'));
  const setup = new Setup({ ...defaults(), cli, takeOver: false, log: () => {}, fence: () => {
    throw new LeaseLostError('lost');
  } }, store);
  await assert.rejects(setup.ensure(), LeaseLostError);
  assert.equal(existsSync(marker), false);
});
