import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isRuntimeError, leaseScopeKey } from '../src/contracts.ts';
import type {
  AccountScope,
  ArtifactRecord,
  CandidateIdentity,
  CandidateRef,
  Clock,
  CollectResumesInput,
  ProcedureV2,
  RuntimeErrorCode,
  TaskStore,
} from '../src/contracts.ts';
import { TASK_STORE_MIGRATIONS, TASK_STORE_SCHEMA_VERSION, defaultTaskDbPath, openTaskStore } from '../src/store.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT: AccountScope = { platform: 'boss', accountKey: 'acct-1', binding: 'observed' };
const SPEC = { id: 'boss.collect-resumes', version: '1.0.0' };
const SHA = (c: string) => c.repeat(64).slice(0, 64);

function fakeClock(start = '2026-10-04T08:00:00.000Z'): Clock & { advance(ms: number): void } {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms) => void (now += ms) };
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'a2-store-'));
}

function input(over: Partial<CollectResumesInput> = {}): CollectResumesInput {
  return { job: '算法工程师', requestedCount: 3, outputDir: '/tmp/out', source: 'conversations', captureMode: 'available', ...over };
}

function identity(n: number, over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return { candidateId: `cand-${n}`, accountKey: ACCOUNT.accountKey, fingerprint: `fp-${n}`, confidence: 'strong', evidence: ['name+job'], ...over };
}

const ref = (n: number, extra: Partial<CandidateRef> = {}): CandidateRef => ({ sourceRef: `row-${n}`, name: `候选人${n}`, hints: [], ...extra });

function artifact(itemId: string, candidateId: string, over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const sha = over.sha256 ?? SHA('a');
  return {
    id: `art-${itemId}-${over.kind ?? 'captured_image'}-${sha.slice(0, 4)}`,
    itemId,
    kind: 'captured_image',
    relativePath: `candidates/${candidateId}/captured/resume.png`,
    sha256: sha,
    bytes: 1234,
    completeness: 'complete',
    validation: { exists: true, bytes: 1234, sizeStable: true, sniffedType: 'image/png', sha256: sha, problems: [] },
    capture: COMPLETE_CAPTURE,
    procedureIds: ['proc-1'],
    acquiredAt: '2026-10-04T08:00:00.000Z',
    ...over,
  };
}

const COMPLETE_CAPTURE = { pages: 3, topConfirmed: true, bottomSignals: ['scroll_position_end', 'end_marker'], stop: 'bottom_confirmed' } as const satisfies ArtifactRecord['capture'];

async function rejectsCode(promise: Promise<unknown>, code: RuntimeErrorCode): Promise<void> {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(isRuntimeError(e, code), `expected ${code}, got ${(e as Error)?.name}: ${(e as Error)?.message} (${(e as { code?: string }).code})`);
    return true;
  });
}

async function memoryStore(clock = fakeClock()): Promise<TaskStore> {
  return openTaskStore({ path: ':memory:', clock, newId: counter('id-') });
}

/** A running task with a bound account. */
async function runningTask(store: TaskStore, over: Partial<CollectResumesInput> = {}) {
  const task = await store.createTask(SPEC, input(over));
  await store.transitionTask(task.id, 'running', { phase: 'preparing' });
  return store.transitionTask(task.id, 'running', { account: ACCOUNT });
}

/** An item moved to validated, ready for commitItem. */
async function validatedItem(store: TaskStore, taskId: string, n: number) {
  const item = await store.upsertWorkItem(taskId, identity(n), ref(n));
  await store.transitionWorkItem(item.id, 'processing');
  await store.transitionWorkItem(item.id, 'acquired');
  return store.transitionWorkItem(item.id, 'validated');
}

function procedure(over: Partial<ProcedureV2> = {}): ProcedureV2 {
  return {
    schemaVersion: 2,
    id: 'proc-1',
    key: { skill: 'boss.collect-resumes', skillVersion: '1.0.0', unit: 'open_resume', platform: 'macos', appVersion: '5.0', profile: 'p1' },
    version: 1,
    status: 'seeded',
    source: 'seed',
    parameters: ['candidate.name'],
    preconditions: [],
    postconditions: [{ kind: 'page', pageClass: 'online_resume' }],
    steps: [{ id: 's1', action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '{{candidate.name}}' }, effect: 'navigation' } }],
    counters: { successes: 0, failures: 0, successItemIds: [], consecutiveFailures: 0 },
    createdAt: '2026-10-04T08:00:00.000Z',
    updatedAt: '2026-10-04T08:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// schema and migrations

test('default path is under Application Support', () => {
  assert.equal(defaultTaskDbPath('/Users/x'), '/Users/x/Library/Application Support/2ndscreen/tasks/tasks.db');
});

test('a fresh file is created at the current schema and data survives reopening', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'nested', 'tasks.db');
    const store = await openTaskStore({ path, clock: fakeClock(), newId: counter('t') });
    const task = await store.createTask(SPEC, input());
    await store.close();
    await rejectsCode(store.getTask(task.id), 'io');

    const db = new DatabaseSync(path);
    assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), TASK_STORE_SCHEMA_VERSION);
    db.close();
    const again = await openTaskStore({ path });
    assert.equal((await again.getTask(task.id))?.input.job, '算法工程师');
    await again.close();
    assert.ok(!readdirSync(dir + '/nested').some((f) => f.includes('.bak')), 'a fresh file needs no backup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrating an older schema backs the file up first and keeps its rows', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'tasks.db');
    const old = new DatabaseSync(path);
    old.exec(TASK_STORE_MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old.prepare(
      `INSERT INTO tasks (id, skill_id, skill_version, input_json, status, created_at, updated_at) VALUES ('t-old', 's', '1', ?, 'paused', 'x', 'x')`,
    ).run(JSON.stringify(input()));
    old.close();

    const store = await openTaskStore({ path, clock: fakeClock() });
    assert.equal((await store.getTask('t-old'))?.status, 'paused');
    await store.close();

    const backups = readdirSync(dir).filter((f) => f.startsWith('tasks.db.v1-') && f.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(dir, backups[0]!));
    assert.equal(Number((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 1);
    assert.equal(Number((backup.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n), 1);
    backup.close();
    const migrated = new DatabaseSync(path);
    assert.equal(Number((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), TASK_STORE_SCHEMA_VERSION);
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'events_task_item'").get());
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_tasks'").get(), 'agent tasks share the ledger');
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a newer schema or a foreign database is refused, not read', async () => {
  const dir = tempDir();
  try {
    const newer = join(dir, 'newer.db');
    const db = new DatabaseSync(newer);
    db.exec(`PRAGMA user_version = ${TASK_STORE_SCHEMA_VERSION + 1}`);
    db.close();
    await rejectsCode(openTaskStore({ path: newer }), 'conflict');

    const foreign = join(dir, 'foreign.db');
    const f = new DatabaseSync(foreign);
    f.exec('CREATE TABLE stuff (x)');
    f.close();
    await rejectsCode(openTaskStore({ path: foreign }), 'conflict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processes opening a fresh or old file at the same moment migrate it exactly once', async () => {
  const dir = tempDir();
  try {
    for (const start of [0, 1]) {
      const path = join(dir, `race-${start}.db`);
      if (start === 1) {
        const old = new DatabaseSync(path);
        old.exec(TASK_STORE_MIGRATIONS[0]!);
        old.exec('PRAGMA user_version = 1');
        old.close();
      }
      const script = join(dir, 'open.mts');
      writeFileSync(script, `import { openTaskStore } from ${JSON.stringify(join(PKG, 'src/store.ts'))};
        const s = await openTaskStore({ path: process.argv[2] });
        await s.close();`);
      const children = Array.from({ length: 6 }, () =>
        new Promise<number | null>((done) => spawn(join(PKG, 'node_modules/.bin/tsx'), [script, path], { cwd: PKG, stdio: 'ignore' }).on('close', done)),
      );
      assert.deepEqual(await Promise.all(children), [0, 0, 0, 0, 0, 0], `start version ${start}`);
      const db = new DatabaseSync(path);
      assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), TASK_STORE_SCHEMA_VERSION);
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// tasks

test('createTask validates input and starts queued with zero counts', async () => {
  const store = await memoryStore();
  await rejectsCode(store.createTask(SPEC, input({ outputDir: 'relative' })), 'invalid_input');
  await rejectsCode(store.createTask(SPEC, { ...input(), extra: 1 } as unknown as CollectResumesInput), 'invalid_input');
  const task = await store.createTask(SPEC, input());
  assert.equal(task.status, 'queued');
  assert.deepEqual(task.counts, { requested: 3, browsed: 0, committed: 0, unavailable: 0, failed: 0, ambiguous: 0, diagnostic: 0 });
  assert.equal((await store.listTasks({ status: ['queued'] })).length, 1);
  assert.equal((await store.listTasks({ status: ['running'] })).length, 0);
  await store.close();
});

test('task transitions follow the contract table, honour `from`, and allow patch-only updates', async () => {
  const store = await memoryStore();
  const task = await store.createTask(SPEC, input());
  await rejectsCode(store.transitionTask(task.id, 'succeeded'), 'conflict');
  await rejectsCode(store.transitionTask(task.id, 'running', {}, 'paused'), 'conflict');
  let t = await store.transitionTask(task.id, 'running', { phase: 'preparing' }, 'queued');
  t = await store.transitionTask(task.id, 'running', { phase: 'executing' });
  assert.equal(t.phase, 'executing');
  await rejectsCode(store.transitionTask(task.id, 'waiting_user'), 'invalid_input');
  t = await store.transitionTask(task.id, 'waiting_user', { waitReason: 'login_required' });
  assert.equal(t.waitReason, 'login_required');
  t = await store.transitionTask(task.id, 'running');
  assert.equal(t.waitReason, undefined, 'resuming clears the wait reason');
  t = await store.transitionTask(task.id, 'cancelling');
  await rejectsCode(store.transitionTask(task.id, 'running'), 'conflict');
  t = await store.transitionTask(task.id, 'cancelled', { terminationReason: 'cancelled' });
  await rejectsCode(store.transitionTask(task.id, 'cancelled'), 'conflict');
  assert.equal(t.terminationReason, 'cancelled');
  await rejectsCode(store.transitionTask('nope', 'running'), 'not_found');
  const events = await store.listEvents(task.id);
  assert.deepEqual(
    events.filter((e) => e.type === 'task_status').map((e) => e.detail?.to),
    ['running', 'waiting_user', 'running', 'cancelling', 'cancelled'],
  );
  await store.close();
});

test('checkpoints round-trip and reject items of other tasks', async () => {
  const store = await memoryStore();
  const a = await runningTask(store);
  const b = await runningTask(store);
  const itemB = await store.upsertWorkItem(b.id, identity(1), ref(1));
  await rejectsCode(store.saveCheckpoint({ taskId: a.id, itemId: itemB.id, updatedAt: '2026-10-04T08:00:00Z' }), 'invalid_input');
  await store.saveCheckpoint({ taskId: b.id, unit: 'open_candidate', itemId: itemB.id, cursor: 'fp:abc@3', updatedAt: '2026-10-04T08:00:00Z' });
  assert.deepEqual(await store.getCheckpoint(b.id), {
    taskId: b.id, unit: 'open_candidate', itemId: itemB.id, cursor: 'fp:abc@3', updatedAt: '2026-10-04T08:00:00Z',
  });
  assert.equal(await store.getCheckpoint(a.id), undefined);
  await store.close();
});

// ---------------------------------------------------------------------------
// work items, identity and account binding

test('candidates need a bound account and must belong to it', async () => {
  const store = await memoryStore();
  const task = await store.createTask(SPEC, input());
  await rejectsCode(store.upsertWorkItem(task.id, identity(1), ref(1)), 'conflict');
  await store.transitionTask(task.id, 'running', { account: ACCOUNT });
  await rejectsCode(store.upsertWorkItem(task.id, identity(1, { accountKey: 'acct-2' }), ref(1)), 'conflict');
  await store.upsertWorkItem(task.id, identity(1), ref(1));
  // Rebinding to the same key is fine; switching accounts once candidates exist is not.
  await store.transitionTask(task.id, 'running', { account: { ...ACCOUNT, binding: 'explicit' } });
  await rejectsCode(store.transitionTask(task.id, 'running', { account: { ...ACCOUNT, accountKey: 'acct-2' } }), 'conflict');
  await store.close();
});

test('upsertWorkItem is idempotent on the dedupe key and refreshes only the ref', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const first = await store.upsertWorkItem(task.id, identity(1), ref(1, { snapshotId: 'snap-1' }));
  await store.transitionWorkItem(first.id, 'processing');
  const again = await store.upsertWorkItem(task.id, identity(1, { candidateId: 'cand-other', evidence: ['x'] }), ref(1, { snapshotId: 'snap-2' }));
  assert.equal(again.id, first.id);
  assert.equal(again.status, 'processing', 'status is not reset by rediscovery');
  assert.equal(again.identity.candidateId, 'cand-1', 'the first identity stays canonical');
  assert.equal(again.ref.snapshotId, 'snap-2');
  assert.equal((await store.listWorkItems(task.id)).length, 1);

  // Same platform id, different fingerprint: same candidate.
  const p1 = await store.upsertWorkItem(task.id, identity(5, { platformId: 'boss-77', confidence: 'platform_id' }), ref(5));
  const p2 = await store.upsertWorkItem(task.id, identity(6, { platformId: 'boss-77', confidence: 'platform_id' }), ref(6));
  assert.equal(p2.id, p1.id);
  await store.close();
});

test('a candidateId cannot name two candidates, and unsafe ids are refused', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  await store.upsertWorkItem(task.id, identity(1), ref(1));
  await rejectsCode(store.upsertWorkItem(task.id, identity(2, { candidateId: 'cand-1' }), ref(2)), 'conflict');
  for (const bad of ['../x', 'a/b', '.hidden', '', 'x'.repeat(200)])
    await rejectsCode(store.upsertWorkItem(task.id, identity(3, { candidateId: bad }), ref(3)), 'invalid_input');
  await rejectsCode(store.upsertWorkItem(task.id, identity(4, { confidence: 'platform_id' }), ref(4)), 'invalid_input');
  await store.close();
});

test('item transitions follow the table; committed only through commitItem', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const item = await store.upsertWorkItem(task.id, identity(1), ref(1));
  await rejectsCode(store.transitionWorkItem(item.id, 'validated'), 'conflict');
  await rejectsCode(store.transitionWorkItem(item.id, 'committed'), 'conflict');
  let it = await store.transitionWorkItem(item.id, 'processing');
  assert.equal(it.attempt, 1);
  it = await store.transitionWorkItem(item.id, 'failed', { reason: 'download_timeout' });
  assert.equal(it.reason, 'download_timeout');
  it = await store.transitionWorkItem(item.id, 'processing');
  assert.equal(it.attempt, 2);
  assert.equal(it.reason, undefined, 'a retry starts without the old reason');
  it = await store.transitionWorkItem(item.id, 'discovered', { reason: 'crash_unchecked' });
  assert.equal(it.status, 'discovered');
  await store.close();
});

// ---------------------------------------------------------------------------
// commitItem

test('a complete capture commits and counts; checkpoint records the last committed item', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const item = await validatedItem(store, task.id, 1);
  const { item: committed, counted } = await store.commitItem(item.id, [artifact(item.id, 'cand-1')]);
  assert.equal(counted, true);
  assert.equal(committed.status, 'committed');
  assert.equal(committed.lastCompletedUnit, 'persist_candidate');
  assert.equal((await store.getCheckpoint(task.id))?.lastCommittedItemId, item.id);
  assert.equal((await store.counts(task.id)).committed, 1);
  assert.equal((await store.listArtifacts(task.id, item.id)).length, 1);
  await store.close();
});

test('a partial capture is saved as a diagnostic, never counted', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const item = await validatedItem(store, task.id, 1);
  const partial = artifact(item.id, 'cand-1', {
    completeness: 'partial_capture',
    capture: { pages: 12, topConfirmed: true, bottomSignals: ['scroll_position_end'], stop: 'page_limit' },
  });
  const { item: after, counted } = await store.commitItem(item.id, [partial]);
  assert.equal(counted, false);
  assert.equal(after.status, 'failed');
  assert.match(after.reason ?? '', /not_countable/);
  const counts = await store.counts(task.id);
  assert.equal(counts.committed, 0);
  assert.equal(counts.diagnostic, 1);
  assert.equal(counts.failed, 1);
  assert.equal((await store.listArtifacts(task.id))[0]?.completeness, 'partial_capture');
  assert.equal(await store.getCheckpoint(task.id), undefined);
  await store.close();
});

test('original-only does not count a complete captured image', async () => {
  const store = await memoryStore();
  const task = await runningTask(store, { captureMode: 'original-only' });
  const a = await validatedItem(store, task.id, 1);
  assert.equal((await store.commitItem(a.id, [artifact(a.id, 'cand-1')])).counted, false);
  const b = await validatedItem(store, task.id, 2);
  const original = artifact(b.id, 'cand-2', {
    kind: 'original',
    sha256: SHA('b'),
    relativePath: 'candidates/cand-2/original/bbbbbbbbbbbb.pdf',
    capture: undefined,
    validation: { exists: true, bytes: 1234, sizeStable: true, sniffedType: 'application/pdf', pageCount: 2, sha256: SHA('b'), problems: [] },
  });
  assert.equal((await store.commitItem(b.id, [original])).counted, true);
  await store.close();
});

test('commitItem rejects forged or inconsistent "complete" records but keeps genuine diagnostics', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const item = await validatedItem(store, task.id, 1);
  const base = artifact(item.id, 'cand-1');
  const forged: Array<[string, Partial<typeof base>]> = [
    ['no capture evidence', { capture: undefined }],
    ['partial evidence', { capture: { pages: 9, topConfirmed: true, bottomSignals: [], stop: 'page_limit' } }],
    ['unstable file', { validation: { ...base.validation, sizeStable: false } }],
    ['hash of other bytes', { validation: { ...base.validation, sha256: SHA('f') } }],
    ['size of other bytes', { validation: { ...base.validation, bytes: 1 } }],
    ['html as image', { validation: { ...base.validation, sniffedType: 'text/html' } }],
    ['missing type', { validation: { ...base.validation, sniffedType: undefined } }],
    ['problems', { validation: { ...base.validation, problems: ['PNG pixel data is incomplete'] } }],
    ['page as complete', { kind: 'captured_page', relativePath: 'candidates/cand-1/captured/pages/p1.png' }],
  ];
  for (const [why, over] of forged) await rejectsCode(store.commitItem(item.id, [{ ...base, ...over }]), 'invalid_input').catch((e) => assert.fail(`${why}: ${e}`));
  const pdfRecord = artifact(item.id, 'cand-1', {
    kind: 'original', capture: undefined, relativePath: 'candidates/cand-1/original/a.pdf',
    validation: { ...base.validation, sniffedType: 'application/pdf' },
  });
  await rejectsCode(store.commitItem(item.id, [pdfRecord]), 'invalid_input'); // a complete PDF needs a parsed page count
  await rejectsCode(store.commitItem(item.id, [{ ...pdfRecord, validation: { ...pdfRecord.validation, sniffedType: 'application/msword', problems: ['legacy Word .doc cannot be verified here'] } }]), 'invalid_input');
  assert.equal((await store.listArtifacts(task.id)).length, 0);

  // A diagnostic with validation problems is still persistable, and never counts.
  const diagnostic = artifact(item.id, 'cand-1', {
    kind: 'diagnostic', completeness: 'unverified', capture: undefined, relativePath: 'candidates/cand-1/diagnostics/download.bin',
    validation: { ...base.validation, sniffedType: 'text/html', problems: ['original cannot be text/html'] },
  });
  assert.equal((await store.commitItem(item.id, [diagnostic])).counted, false);
  assert.equal((await store.counts(task.id)).diagnostic, 1);
  await store.close();
});

test('commitItem binds artifacts to the item and its candidate folder', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const one = await validatedItem(store, task.id, 1);
  const two = await validatedItem(store, task.id, 2);
  // B's file under A's folder, another item's record, traversal, bad hash: all refused.
  await rejectsCode(store.commitItem(one.id, [artifact(one.id, 'cand-2')]), 'invalid_input');
  await rejectsCode(store.commitItem(one.id, [artifact(two.id, 'cand-1')]), 'invalid_input');
  await rejectsCode(store.commitItem(one.id, [artifact(one.id, 'cand-1', { relativePath: 'candidates/cand-1/../cand-2/x.png' })]), 'invalid_input');
  await rejectsCode(store.commitItem(one.id, [artifact(one.id, 'cand-1', { sha256: 'zz' })]), 'invalid_input');
  await rejectsCode(
    store.commitItem(one.id, [artifact(one.id, 'cand-1', { validation: { exists: true, bytes: 1234, sizeStable: true, sha256: SHA('a'), sniffedType: 'image/png', problems: ['truncated'] } })]),
    'invalid_input',
  );
  await rejectsCode(store.commitItem(one.id, []), 'invalid_input');
  assert.equal((await store.listArtifacts(task.id)).length, 0);
  await store.close();
});

test('commitItem needs a validated item and rolls back entirely on conflict', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const item = await store.upsertWorkItem(task.id, identity(1), ref(1));
  await store.transitionWorkItem(item.id, 'processing');
  await rejectsCode(store.commitItem(item.id, [artifact(item.id, 'cand-1')]), 'conflict');

  const other = await validatedItem(store, task.id, 2);
  const shared = artifact(other.id, 'cand-2', { id: 'art-shared' });
  await store.commitItem(other.id, [shared]);
  await store.transitionWorkItem(item.id, 'acquired');
  await store.transitionWorkItem(item.id, 'validated');
  // The first record is fine, the second reuses another item's artifact id: nothing may stick.
  const good = artifact(item.id, 'cand-1', { id: 'art-good' });
  const clash = artifact(item.id, 'cand-1', { id: 'art-shared', relativePath: 'candidates/cand-1/captured/resume-2.png' });
  await rejectsCode(store.commitItem(item.id, [good, clash]), 'conflict');
  assert.equal((await store.listArtifacts(task.id, item.id)).length, 0);
  assert.equal((await store.listWorkItems(task.id)).find((i) => i.id === item.id)?.status, 'validated');
  await store.close();
});

test('re-committing a committed item is idempotent; a navigation failure afterwards cannot undo it', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const item = await validatedItem(store, task.id, 1);
  const record = artifact(item.id, 'cand-1');
  await store.commitItem(item.id, [record]);
  const again = await store.commitItem(item.id, [record]);
  assert.equal(again.counted, true);
  assert.equal((await store.listArtifacts(task.id)).length, 1, 'no duplicate rows');
  await rejectsCode(store.commitItem(item.id, [artifact(item.id, 'cand-1', { id: 'art-new', sha256: SHA('c') })]), 'conflict');
  // Returning to the list failed after the file was persisted: the item stays committed.
  await rejectsCode(store.transitionWorkItem(item.id, 'failed', { reason: 'back_to_list_failed' }), 'conflict');
  const t = await store.transitionTask(task.id, 'running', { phase: 'repairing' });
  assert.equal(t.counts.committed, 1);
  assert.equal(t.phase, 'repairing');
  await store.close();
});

test('counts are derived from items: browsed, unavailable, ambiguous, failed, diagnostic', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const items = [];
  for (let n = 1; n <= 5; n++) items.push(await store.upsertWorkItem(task.id, identity(n), ref(n)));
  await store.transitionWorkItem(items[0]!.id, 'unavailable', { reason: 'no_attachment' });
  await store.transitionWorkItem(items[1]!.id, 'processing');
  await store.transitionWorkItem(items[1]!.id, 'ambiguous', { reason: 'identity mismatch' });
  await store.transitionWorkItem(items[2]!.id, 'processing');
  await store.transitionWorkItem(items[2]!.id, 'failed', { reason: 'navigation' });
  const counts = await store.counts(task.id);
  assert.deepEqual(counts, { requested: 3, browsed: 3, committed: 0, unavailable: 1, failed: 1, ambiguous: 1, diagnostic: 0 });
  assert.deepEqual((await store.getTask(task.id))?.counts, counts);
  await store.close();
});

// ---------------------------------------------------------------------------
// events

test('events are ordered, filterable and limited to the most recent', async () => {
  const store = await memoryStore();
  const task = await runningTask(store);
  const item = await store.upsertWorkItem(task.id, identity(1), ref(1));
  for (let i = 0; i < 5; i++)
    await store.appendEvent({ taskId: task.id, itemId: item.id, unit: 'open_candidate', stepId: `s${i}`, type: 'step', at: '2026-10-04T08:00:00Z', result: 'ok', evidenceRef: `shots/${i}.png`, detail: { i } });
  const last = await store.listEvents(task.id, { itemId: item.id, limit: 2 });
  assert.deepEqual(last.map((e) => e.stepId), ['s3', 's4']);
  assert.equal(last[1]?.evidenceRef, 'shots/4.png');
  assert.deepEqual(last[1]?.detail, { i: 4 });
  await rejectsCode(store.appendEvent({ taskId: 'missing', type: 'x', at: '2026-10-04T08:00:00Z' }), 'not_found');
  await rejectsCode(store.appendEvent({ taskId: task.id, type: 'x', at: 'yesterday' }), 'invalid_input');
  await store.close();
});

// ---------------------------------------------------------------------------
// leases

test('leases on the same app always conflict, whatever the account part', async () => {
  const clock = fakeClock();
  const store = await memoryStore(clock);
  const anyAccount = leaseScopeKey('com.zhipin.www');
  const lease = await store.acquireLease({ scopeKey: anyAccount, holder: 'runtime', ownerPid: 100, taskId: 't1', ttlMs: 60_000 });
  assert.equal(lease.expiresAt, '2026-10-04T08:01:00.000Z');
  for (const scope of [anyAccount, leaseScopeKey('com.zhipin.www', 'acct-1'), leaseScopeKey('com.zhipin.www', 'acct-2')])
    await rejectsCode(store.acquireLease({ scopeKey: scope, holder: 'legacy-assistant', ownerPid: 200, ttlMs: 1000 }), 'lease_held');
  await store.acquireLease({ scopeKey: leaseScopeKey('com.tencent.xinWeChat'), holder: 'runtime', ownerPid: 100, ttlMs: 1000 });

  clock.advance(30_000);
  const renewed = await store.renewLease(lease.leaseId, 60_000);
  assert.equal(renewed.expiresAt, '2026-10-04T08:01:30.000Z');
  assert.equal(renewed.taskId, 't1');
  clock.advance(61_000);
  await rejectsCode(store.renewLease(lease.leaseId, 1000), 'conflict');
  // Expired: another holder may take the app; the stale row is replaced.
  const taken = await store.acquireLease({ scopeKey: leaseScopeKey('com.zhipin.www', 'acct-1'), holder: 'legacy-assistant', ownerPid: 200, ttlMs: 1000 });
  await rejectsCode(store.renewLease(lease.leaseId, 1000), 'not_found');
  await store.releaseLease(taken.leaseId);
  await store.releaseLease(taken.leaseId);
  await store.acquireLease({ scopeKey: anyAccount, holder: 'runtime', ownerPid: 300, ttlMs: 1000 });
  await rejectsCode(store.acquireLease({ scopeKey: 'no-colon', holder: 'runtime', ownerPid: 1, ttlMs: 1000 }), 'invalid_input');
  await rejectsCode(store.acquireLease({ scopeKey: 'a:b', holder: 'runtime', ownerPid: 1, ttlMs: 0 }), 'invalid_input');
  await store.close();
});

test('two connections to one file see each other’s leases (separate processes share the check)', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'tasks.db');
    const a = await openTaskStore({ path });
    const b = await openTaskStore({ path });
    await a.acquireLease({ scopeKey: leaseScopeKey('com.zhipin.www'), holder: 'runtime', ownerPid: 1, ttlMs: 60_000 });
    await rejectsCode(b.acquireLease({ scopeKey: leaseScopeKey('com.zhipin.www', 'acct-9'), holder: 'runtime', ownerPid: 2, ttlMs: 60_000 }), 'lease_held');
    await a.close();
    await b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// procedures

test('procedure versions are immutable; only status and counters change', async () => {
  const store = await memoryStore();
  const v1 = procedure();
  await store.insertProcedure(v1);
  await rejectsCode(store.insertProcedure(procedure({ id: 'proc-dup' })), 'conflict');
  await rejectsCode(store.insertProcedure(procedure({ version: 2 })), 'conflict');
  await store.insertProcedure(procedure({ id: 'proc-2', version: 2, parentVersion: 1, status: 'trial', source: 'repair' }));
  await store.insertProcedure(procedure({ id: 'proc-other', key: { ...v1.key, branch: 'online' } }));
  assert.deepEqual((await store.listProcedures(v1.key)).map((p) => p.version), [2, 1]);

  const updated = await store.updateProcedureState('proc-1', {
    status: 'trial',
    counters: { successes: 1, failures: 0, successItemIds: ['i1'], consecutiveFailures: 0 },
    updatedAt: '2026-10-04T09:00:00.000Z',
    // An attempt to smuggle a definition change through is ignored.
    steps: [],
  } as unknown as Pick<ProcedureV2, 'status' | 'counters' | 'updatedAt'>);
  assert.equal(updated.status, 'trial');
  assert.deepEqual(updated.counters.successItemIds, ['i1']);
  assert.deepEqual(updated.steps, v1.steps);
  assert.equal(updated.createdAt, v1.createdAt);
  assert.deepEqual((await store.getProcedure('proc-1'))?.steps, v1.steps);
  await rejectsCode(store.updateProcedureState('missing', { status: 'trial', counters: v1.counters, updatedAt: v1.updatedAt }), 'not_found');
  // The merged state must still be a valid procedure: a repaired version cannot turn stable without verified successes.
  await rejectsCode(store.updateProcedureState('proc-2', { status: 'stable', counters: v1.counters, updatedAt: v1.updatedAt }), 'invalid_input');
  await rejectsCode(store.updateProcedureState('proc-1', { status: 'trial', counters: { successes: 2, failures: 0, successItemIds: ['i1', 'i1'], consecutiveFailures: 0 }, updatedAt: v1.updatedAt }), 'invalid_input');
  await rejectsCode(store.updateProcedureState('proc-1', { status: 'trial', counters: { successes: 1, failures: 0, successItemIds: ['i1', 'i2'], consecutiveFailures: 0 }, updatedAt: v1.updatedAt }), 'invalid_input');
  await rejectsCode(store.updateProcedureState('proc-1', { status: 'trial', counters: { successes: 1, failures: 0, successItemIds: [''], consecutiveFailures: 0 }, updatedAt: v1.updatedAt }), 'invalid_input');
  assert.equal((await store.getProcedure('proc-2'))?.status, 'trial');
  await rejectsCode(store.insertProcedure(procedure({ id: 'bad', version: 9, steps: [] })), 'invalid_input');
  await rejectsCode(
    store.insertProcedure(procedure({
      id: 'idx', version: 10,
      steps: [{ id: 's', action: { kind: 'click', target: { kind: 'element', index: 3 }, effect: 'navigation' } }],
    })),
    'invalid_input',
  );
  await store.close();
});

test('a restarted store resumes from the persisted ledger without double counting', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'tasks.db');
    const s1 = await openTaskStore({ path, newId: counter('a') });
    const task = await runningTask(s1);
    const item = await validatedItem(s1, task.id, 1);
    await s1.commitItem(item.id, [artifact(item.id, 'cand-1')]);
    const pending = await s1.upsertWorkItem(task.id, identity(2), ref(2));
    await s1.transitionWorkItem(pending.id, 'processing');
    // No close(): simulate the process dying with WAL content not checkpointed.
    const s2 = await openTaskStore({ path, newId: counter('b') });
    const items = await s2.listWorkItems(task.id);
    assert.deepEqual(items.map((i) => i.status), ['committed', 'processing']);
    // Rediscovering both after restart does not create new items or reopen the committed one.
    assert.equal((await s2.upsertWorkItem(task.id, identity(1), ref(1))).status, 'committed');
    assert.equal((await s2.upsertWorkItem(task.id, identity(2), ref(2))).id, pending.id);
    await s2.transitionWorkItem(pending.id, 'discovered', { reason: 'crash_unchecked' });
    assert.equal((await s2.counts(task.id)).committed, 1);
    assert.equal((await s2.getCheckpoint(task.id))?.lastCommittedItemId, item.id);
    await s2.close();
    await s1.close();
    assert.ok(existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
