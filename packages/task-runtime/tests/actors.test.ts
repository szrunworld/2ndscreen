import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActorRegistry, findRecord, pruneClosedRecords, verifyWorkerStopped, type ActorRecord, type ProcessProbe } from '../src/actors.ts';
import { createLineProcessSpawner } from '../src/adapters/agent-bridge.ts';
import type { LineProcess } from '../src/contracts.ts';
import { processStartTime } from '../src/daemon.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'actors-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const iso = (ms: number) => new Date(ms).toISOString();
const WORKER_START = iso(Date.parse('2026-10-04T10:00:00Z'));

/** A probe over a made-up process table: pid -> start, and groups with members. */
function fakeProbe(starts: Map<number, string>, groups: Map<number, 'alive' | 'gone' | 'unknown'>, killed: number[] = []): ProcessProbe {
  return {
    startedAt: (pid) => starts.get(pid),
    group: (pgid) => groups.get(pgid) ?? 'gone',
    groupOf: (pid) => pid,
    killGroup: (pgid) => {
      killed.push(pgid);
      groups.set(pgid, 'gone');
      starts.delete(pgid);
    },
    sleep: async () => {},
  };
}

function writeRecord(d: string, record: ActorRecord): void {
  writeFileSync(join(d, `${record.pid}-${Date.parse(record.startedAt)}.json`), JSON.stringify(record));
}
const base = (over: Partial<ActorRecord> = {}): ActorRecord => ({ v: 1, pid: 500, pgid: 500, startedAt: WORKER_START, pendingSpawns: 0, groups: [], ...over });
const worker = { ownerPid: 500, processStartedAt: WORKER_START };
const helper = (pgid: number, at: number) => ({ pgid, spawnedAfterMs: at, spawnedBeforeMs: at + 30, file: '2ndscreen' });
const reason = (v: { stopped: boolean }) => (v as unknown as { reason: string }).reason;

test('the registry announces a spawn before it, records the group with the end of the announcement, and drops it once gone', async () => {
  const d = dir();
  const registry = ActorRegistry.create(d);
  assert.equal(registry.current.pid, process.pid);
  assert.equal(registry.current.startedAt, processStartTime(process.pid));
  const seen: number[] = [];
  const inner = createLineProcessSpawner();
  const wrapped = registry.wrap((file, args, env) => {
    seen.push((JSON.parse(readFileSync(registry.path, 'utf8')) as ActorRecord).pendingSpawns);
    return inner(file, args, env);
  });
  const child = wrapped('/bin/sleep', ['30']);
  const onDisk = JSON.parse(readFileSync(registry.path, 'utf8')) as ActorRecord;
  assert.deepEqual(seen, [1]);
  assert.equal(onDisk.pendingSpawns, 0);
  assert.deepEqual(onDisk.groups.map((g) => g.pgid), [child.pid]);
  child.kill('SIGKILL');
  await child.exited();
  await sleep(20);
  assert.deepEqual((JSON.parse(readFileSync(registry.path, 'utf8')) as ActorRecord).groups, []);
  registry.close();
  assert.ok((JSON.parse(readFileSync(registry.path, 'utf8')) as ActorRecord).closedAt);
});

test('an unconfirmed spawn or exit stays on record, and a record that cannot be written stops further spawns', async () => {
  const d = dir();
  const registry = ActorRegistry.create(d);
  const never = (pid: number | undefined, exited: Promise<never>): LineProcess =>
    ({ pid, exited: () => exited, write() {}, closeInput() {}, lines: async function* () {}, kill() {} }) as LineProcess;
  // pid undefined and exited() never confirmed: the announcement stays.
  registry.wrap(() => never(undefined, new Promise(() => {})))('x', []);
  // a child whose exit is reported as a failure: its group stays.
  registry.wrap(() => never(4242, Promise.reject(new Error('lost'))))('y', []);
  await sleep(10);
  assert.equal(registry.current.pendingSpawns, 1);
  assert.deepEqual(registry.current.groups.map((g) => g.pgid), [4242]);
  registry.close();
  assert.equal(registry.current.closedAt, undefined, 'never closed while something is unaccounted for');
  // The record's directory disappears: the next spawn is refused before it happens.
  chmodSync(d, 0o500);
  try {
    let spawned = false;
    assert.throws(() => registry.wrap(() => ((spawned = true), never(1, new Promise(() => {}))))('z', []));
    assert.equal(spawned, false);
  } finally {
    chmodSync(d, 0o700);
  }
});

test('a worker without a recorded start, or without a matching record, is never declared stopped', async () => {
  const probe = fakeProbe(new Map(), new Map());
  const d = dir();
  writeRecord(d, base());
  assert.match(reason(await verifyWorkerStopped(d, { ownerPid: 500, legacy: true }, { probe })), /no recorded start time/);
  assert.match(reason(await verifyWorkerStopped(d, { ownerPid: 500 }, { probe })), /no recorded start time/);
  assert.match(reason(await verifyWorkerStopped(d, { ownerPid: 500, processStartedAt: iso(Date.parse(WORKER_START) + 1000) }, { probe })), /no actor record/);
  // Contents that do not match the file name, or are malformed, prove nothing.
  const lying = dir();
  writeFileSync(join(lying, `500-${Date.parse(WORKER_START)}.json`), JSON.stringify(base({ pid: 501 })));
  assert.equal((await verifyWorkerStopped(lying, worker, { probe })).stopped, false);
  for (const bad of [base({ pgid: 1 }), base({ pendingSpawns: -1 }), { ...base(), groups: [{ pgid: 0 }] }, '{"v":1']) {
    const d2 = dir();
    writeFileSync(join(d2, `500-${Date.parse(WORKER_START)}.json`), typeof bad === 'string' ? bad : JSON.stringify(bad));
    assert.match(reason(await verifyWorkerStopped(d2, worker, { probe })), /malformed|JSON|Unexpected|Expected/);
  }
});

test('a live, shared-group, mid-spawn or unreadable worker blocks', async () => {
  const d = dir();
  writeRecord(d, base());
  assert.match(reason(await verifyWorkerStopped(d, worker, { probe: fakeProbe(new Map([[500, WORKER_START]]), new Map()) })), /still running/);
  const throwing: ProcessProbe = { ...fakeProbe(new Map(), new Map()), startedAt: () => { throw new Error('ps failed'); } };
  assert.match(reason(await verifyWorkerStopped(d, worker, { probe: throwing })), /cannot identify worker/);
  const shared = dir();
  writeRecord(shared, base({ pgid: 77 }));
  assert.match(reason(await verifyWorkerStopped(shared, worker, { probe: fakeProbe(new Map(), new Map()) })), /shared process group/);
  const pending = dir();
  writeRecord(pending, base({ pendingSpawns: 1 }));
  assert.match(reason(await verifyWorkerStopped(pending, worker, { probe: fakeProbe(new Map(), new Map()) })), /while starting a child/);
});

test("the worker's own group is waited out, never killed — even in a cleanly closed record", async () => {
  const d = dir();
  writeRecord(d, base({ closedAt: '2026-10-04T11:00:00.000Z' }));
  const killed: number[] = [];
  assert.match(reason(await verifyWorkerStopped(d, worker, { probe: fakeProbe(new Map(), new Map([[500, 'alive']]), killed) })), /not empty/);
  assert.match(reason(await verifyWorkerStopped(d, worker, { probe: fakeProbe(new Map(), new Map([[500, 'unknown']]), killed) })), /unreadable/);
  assert.deepEqual(killed, []);
  const ok = await verifyWorkerStopped(d, worker, { probe: fakeProbe(new Map(), new Map()) });
  assert.equal(ok.stopped, true);
  assert.match((ok as { evidence: string }).evidence, /worker 500 exited; worker group 500 empty; record closed/);
});

test('a dead worker with its recorded helper alive: only that helper group is stopped, then it is proven', async () => {
  const d = dir();
  const at = Date.parse('2026-10-04T10:05:00.400Z');
  writeRecord(d, base({ groups: [helper(700, at)] }));
  const killed: number[] = [];
  // ps shows 10:05:00 (truncated) for a start inside the window.
  const verdict = await verifyWorkerStopped(d, worker, { probe: fakeProbe(new Map([[700, '2026-10-04T10:05:00.000Z']]), new Map([[700, 'alive']]), killed) });
  assert.equal(verdict.stopped, true, reason(verdict));
  assert.deepEqual(killed, [700]);
  assert.match((verdict as { evidence: string }).evidence, /worker 500 exited; worker group 500 empty; 2ndscreen group 700 stopped by this daemon/);
});

test('a group that cannot be tied to the record is left alone', async () => {
  const at = Date.parse('2026-10-04T10:05:00.400Z');
  const cases: Array<[Map<number, string>, Map<number, 'alive' | 'gone' | 'unknown'>, boolean, RegExp]> = [
    // members but no leader: the id may have been reused while nobody looked
    [new Map(), new Map([[700, 'alive']]), false, /no leader/],
    // the leader started before the recorded spawn
    [new Map([[700, '2026-10-04T10:04:58.000Z']]), new Map([[700, 'alive']]), false, /before the recorded spawn/],
    // unreadable group
    [new Map(), new Map([[700, 'unknown']]), false, /unreadable/],
    // a later process leads the id now: the recorded group ended
    [new Map([[700, '2026-10-04T10:09:00.000Z']]), new Map([[700, 'alive']]), true, /now leads a later process/],
  ];
  for (const [starts, groups, stopped, text] of cases) {
    const d = dir();
    writeRecord(d, base({ groups: [helper(700, at)] }));
    const killed: number[] = [];
    const verdict = await verifyWorkerStopped(d, worker, { probe: fakeProbe(starts, groups, killed) });
    assert.equal(verdict.stopped, stopped);
    assert.match(stopped ? (verdict as { evidence: string }).evidence : reason(verdict), text);
    assert.deepEqual(killed, [], 'nothing unidentified is signalled');
  }
});

test('closed records are pruned after a while; findRecord matches pid and exact start', () => {
  const d = dir();
  writeRecord(d, base({ closedAt: '2026-10-04T00:00:00.000Z' }));
  assert.ok(findRecord(d, 500, WORKER_START));
  assert.equal(findRecord(d, 500, iso(Date.parse(WORKER_START) + 1000)), undefined);
  pruneClosedRecords(d, 60_000);
  assert.ok(findRecord(d, 500, WORKER_START), 'recent: kept');
  pruneClosedRecords(d, 1, Date.now() + 10_000);
  assert.equal(findRecord(d, 500, WORKER_START), undefined);
});

/** Starts tests/fixtures/actor-worker.ts detached, as a worker is, and reads what it started. */
async function startFixtureWorker(d: string): Promise<{ pid: number; child: number }> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures/actor-worker.ts'), d], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: join(import.meta.dirname, '..'),
  });
  const line = await new Promise<string>((resolve, reject) => {
    let text = '';
    child.stdout!.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.split('\n')[0]!);
    });
    child.once('exit', () => reject(new Error('the fixture worker exited')));
  });
  child.stdout!.destroy();
  child.unref();
  return JSON.parse(line);
}

test('real processes: a suspended worker blocks; once it is killed, its surviving helper group is stopped and proven gone', async () => {
  const d = dir();
  const fixture = await startFixtureWorker(d);
  try {
    const record = { ownerPid: fixture.pid, processStartedAt: processStartTime(fixture.pid)! };
    assert.ok(alive(fixture.child), 'helper running in its own group');
    // Suspended, as a worker past its lease can be: still the owner of its actors.
    process.kill(fixture.pid, 'SIGSTOP');
    assert.match(reason(await verifyWorkerStopped(d, record, { killGraceMs: 500 })), /still running/);
    assert.ok(alive(fixture.child), 'nothing was killed while the worker lives');
    process.kill(fixture.pid, 'SIGKILL');
    for (let i = 0; i < 100 && alive(fixture.pid); i++) await sleep(20);
    assert.ok(alive(fixture.child), 'the helper outlives its worker');
    const verdict = await verifyWorkerStopped(d, record, { killGraceMs: 500 });
    assert.equal(verdict.stopped, true, JSON.stringify(verdict));
    // Its exit is reaped by launchd, the new parent, shortly after.
    for (let i = 0; i < 100 && alive(fixture.child); i++) await sleep(20);
    assert.ok(!alive(fixture.child), JSON.stringify(verdict));
  } finally {
    for (const pid of [fixture.pid, fixture.child]) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  }
});
