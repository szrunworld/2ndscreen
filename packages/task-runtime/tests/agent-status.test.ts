import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStatusPersister, createStatusBoard, formatAgentList, readStatusFile, sortRuns, type AgentRunEntry } from '../src/agent-status.ts';
import {
  agentDataPaths,
  prepareAgentDataDir,
  costOf,
  createFileEffectLedger,
  createFileUsageLedger,
  formatUsage,
  readPriceTable,
  summarizeUsage,
  type ProviderUsageRecord,
} from '../src/agent-ledgers.ts';
import { parseUsage, runCli, type AgentViewControl } from '../src/cli.ts';
import { isRuntimeError, type Clock, type TaskControl } from '../src/contracts.ts';

const tick = (start = Date.parse('2026-10-07T08:00:00Z')): Clock => {
  let t = start;
  return { now: () => new Date((t += 1000)) };
};

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-status-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Board

test('a late agent report never overwrites a newer one', () => {
  const board = createStatusBoard({ clock: tick() });
  board.start({ runId: 'r1', agentId: 'a', mode: 'resident' });
  assert.equal(board.reportAgent('r1', 5, 'working', 'turn 5'), true);
  assert.equal(board.reportAgent('r1', 3, 'idle', 'turn 3'), false);
  assert.equal(board.reportAgent('r1', 5, 'idle'), false);
  assert.equal(board.get('r1')!.state, 'working');
  assert.equal(board.get('r1')!.summary, 'turn 5');
  assert.equal(board.reportAgent('r1', 6, 'idle'), true);
  assert.equal(board.get('r1')!.state, 'idle');
});

test('a person-blocked run shows the oldest open request, and the agent cannot report its way out of it', () => {
  const board = createStatusBoard({ clock: tick() });
  board.start({ runId: 'r1', agentId: 'a', mode: 'task', taskId: 't' });
  board.block('r1', { kind: 'approval', id: 'a1', message: '向陈一求简历' });
  board.block('r1', { kind: 'input', id: 'q1', message: '选岗位' });
  assert.deepEqual(
    (({ kind, id, message }) => ({ kind, id, message }))(board.get('r1')!.blockedOn!),
    { kind: 'approval', id: 'a1', message: '向陈一求简历' },
  );
  board.reportAgent('r1', 1, 'working');
  assert.equal(board.get('r1')!.state, 'blocked');
  board.unblock('r1', 'a1');
  assert.equal(board.get('r1')!.blockedOn!.kind, 'input');
  board.unblock('r1', 'nope');
  board.unblock('r1', 'q1');
  assert.equal(board.get('r1')!.state, 'working');
  assert.equal(board.get('r1')!.blockedOn, undefined);
});

test('finished runs keep their end; nothing changes them afterwards', () => {
  const board = createStatusBoard({ clock: tick() });
  board.start({ runId: 'r1', agentId: 'a', mode: 'task' });
  board.finish('r1', { ok: false, failure: 'timeout' });
  board.reportAgent('r1', 9, 'working');
  board.block('r1', { kind: 'input', id: 'q', message: 'm' });
  board.finish('r1', { ok: true });
  const r = board.get('r1')!;
  assert.equal(r.state, 'failed');
  assert.equal(r.failure, 'timeout');
  assert.ok(r.endedAt);
  assert.equal(board.list().length, 0);
  assert.equal(board.list({ includeFinished: true }).length, 1);
  assert.throws(() => board.start({ runId: 'r1', agentId: 'a', mode: 'task' }), (e) => isRuntimeError(e, 'conflict'));
  assert.throws(() => board.reportAgent('missing', 1, 'idle'), (e) => isRuntimeError(e, 'not_found'));
});

test('waitFor is pinned to one run, resolves at once when already there, and rejects on abort or a different end', async () => {
  const board = createStatusBoard({ clock: tick() });
  board.start({ runId: 'r1', agentId: 'a', mode: 'task' });
  board.start({ runId: 'r2', agentId: 'b', mode: 'task' });
  assert.equal((await board.waitFor('r1', ['starting'])).state, 'starting');

  const blocked = board.waitFor('r1', ['blocked']);
  board.block('r2', { kind: 'input', id: 'q', message: 'other run' });
  board.block('r1', { kind: 'approval', id: 'a', message: 'this run' });
  assert.equal((await blocked).blockedOn!.message, 'this run');

  const controller = new AbortController();
  const aborted = board.waitFor('r1', ['done'], controller.signal);
  controller.abort();
  await assert.rejects(aborted, (e) => isRuntimeError(e, 'cancelled'));

  const never = board.waitFor('r2', ['idle']);
  board.finish('r2', { ok: true });
  await assert.rejects(never, /ended as done/);
});

test('the list puts blocked runs first, then working, idle, paused, starting, failed and done', () => {
  const entry = (runId: string, state: AgentRunEntry['state'], updatedAt: string): AgentRunEntry => ({
    runId, agentId: runId, mode: 'task', state, startedAt: updatedAt, updatedAt, agentSeq: 0, version: 0,
  });
  const order = sortRuns([
    entry('done', 'done', '2026-10-07T09:00:00Z'),
    entry('idle', 'idle', '2026-10-07T09:00:00Z'),
    entry('blocked-old', 'blocked', '2026-10-07T07:00:00Z'),
    entry('working', 'working', '2026-10-07T09:00:00Z'),
    entry('blocked-new', 'blocked', '2026-10-07T08:00:00Z'),
    entry('failed', 'failed', '2026-10-07T09:00:00Z'),
  ]).map((r) => r.runId);
  assert.deepEqual(order, ['blocked-new', 'blocked-old', 'working', 'idle', 'failed', 'done']);
});

test('the formatted list says what a blocked run waits for and for how long', () => {
  const board = createStatusBoard({ clock: tick(Date.parse('2026-10-07T08:00:00Z')) });
  board.start({ runId: 'r1', agentId: 'remotedesk.boss-recruiter', mode: 'resident', taskId: 't-12' });
  board.block('r1', { kind: 'approval', id: 'a1', message: '向陈一求简历' });
  board.start({ runId: 'r2', agentId: 'wechat.add-friends', mode: 'task', taskId: 't-3' });
  board.reportAgent('r2', 1, 'working', '读取新的朋友');
  const lines = formatAgentList(board.list(), new Date('2026-10-07T08:02:30Z'));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^! +blocked +remotedesk\.boss-recruiter +t-12 +等待审批：向陈一求简历 +2m$/);
  assert.match(lines[1]!, /^\* +working +wechat\.add-friends +t-3 +读取新的朋友 +\d+m$/);
  assert.deepEqual(formatAgentList([]), ['no agent runs']);
});

test('the status file is written atomically after every change and readable only by the user', () =>
  withDir(async (dir) => {
    const path = join(agentDataPaths(dir).status);
    const board = createStatusBoard({ clock: tick(), persist: createFileStatusPersister(path) });
    board.start({ runId: 'r1', agentId: 'a', mode: 'task' });
    board.block('r1', { kind: 'input', id: 'q', message: '扫码' });
    const snapshot = readStatusFile(path);
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0]!.state, 'blocked');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(agentDataPaths(dir).dir)).mode & 0o777, 0o700);
    assert.deepEqual(readStatusFile(join(dir, 'missing.json')).runs, []);
    // A persister that throws does not stop the board.
    const broken = createStatusBoard({ persist: () => { throw new Error('disk full'); } });
    broken.start({ runId: 'x', agentId: 'a', mode: 'task' });
    assert.equal(broken.get('x')!.state, 'starting');
    assert.equal(board.prune('2100-01-01T00:00:00Z'), 0);
    board.finish('r1', { ok: true });
    assert.equal(board.prune('2100-01-01T00:00:00Z'), 1);
    assert.deepEqual(readStatusFile(path).runs, []);
  }));

// ---------------------------------------------------------------------------
// Ledgers

const use = (at: string, extra: Record<string, unknown> = {}) => ({
  agentId: 'a', taskId: 't', application: 'com.zhipin.www', accountKey: 'hr-zhang', effect: 'external-submit' as const, at, status: 'ok' as const, ...extra,
});

test('the effect ledger survives a crash mid-write and keeps counting from the next line', () =>
  withDir(async (dir) => {
    const path = join(dir, 'effects.jsonl');
    const ledger = createFileEffectLedger(path);
    await ledger.record(use('2026-10-07T08:00:00Z'));
    await writeFile(path, '{"agentId":"a","taskId', { flag: 'a' }); // cut short by a crash
    const q = { application: 'com.zhipin.www', accountKey: 'hr-zhang', effect: 'external-submit' as const, since: '2026-10-07T00:00:00Z' };
    assert.equal((await ledger.uses(q)).length, 1, 'an unfinished last line is not a record');
    await ledger.record(use('2026-10-07T09:00:00Z'));
    assert.equal((await createFileEffectLedger(path).uses(q)).length, 2, 'the fragment is cut off and the next record stands on its own line');
    assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 2);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await ledger.uses({ ...q, accountKey: 'hr-li' })).length, 0);
    assert.equal((await ledger.uses({ ...q, since: '2026-10-07T08:30:00Z' })).length, 1);
  }));

test('the effect ledger refuses to count with an unreadable record, and compaction keeps what still counts', () =>
  withDir(async (dir) => {
    const path = join(dir, 'effects.jsonl');
    const ledger = createFileEffectLedger(path);
    await ledger.record(use('2026-10-05T08:00:00Z'));
    await ledger.record(use('2026-10-07T08:00:00Z'));
    assert.equal(await ledger.compact('2026-10-06T00:00:00Z'), 1);
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 1);
    await writeFile(path, '{"not":"a use"}\n', { flag: 'a' });
    await assert.rejects(ledger.uses({ application: 'com.zhipin.www', accountKey: 'hr-zhang', effect: 'external-submit', since: '2026-10-01T00:00:00Z' }), (e) => isRuntimeError(e, 'io'));
  }));

const call = (extra: Partial<ProviderUsageRecord>): ProviderUsageRecord => ({
  at: '2026-10-07T08:00:00Z', agentId: 'a', runId: 'r', taskId: 't', providerId: 'ark', purpose: 'draft', ok: true, inputTokens: 100, outputTokens: 10, latencyMs: 5, ...extra,
});

test('usage is summed per agent, provider, model or task; unknown tokens stay unknown and unpriced calls are counted apart', () => {
  const records = [
    call({ agentId: 'boss', model: 'm1', inputTokens: 1000, outputTokens: 100 }),
    call({ agentId: 'boss', model: 'm2', inputTokens: 2000, outputTokens: 'unknown' }),
    call({ agentId: 'wechat', providerId: 'qwen', model: 'flash', inputTokens: 300, outputTokens: 30, taskId: 'w1' }),
    call({ agentId: 'wechat', providerId: 'qwen', ok: false, inputTokens: 'unknown', outputTokens: 'unknown', taskId: undefined, runId: 'r9' }),
  ];
  const prices = { 'ark/m1': { currency: 'CNY', inputPerMTok: 1, outputPerMTok: 2 }, qwen: { currency: 'USD', inputPerMTok: 0.1, outputPerMTok: 0.4 } };
  const byAgent = summarizeUsage(records, 'agent', prices);
  assert.deepEqual(byAgent.map((r) => [r.key, r.calls, r.failed, r.inputTokens, r.outputTokens, r.uncosted]), [
    ['boss', 2, 0, 3000, 'unknown', 1],
    ['wechat', 2, 1, 'unknown', 'unknown', 1],
  ]);
  assert.deepEqual(byAgent[0]!.costs, { CNY: (1000 * 1 + 100 * 2) / 1e6 });
  assert.deepEqual(byAgent[1]!.costs, { USD: (300 * 0.1 + 30 * 0.4) / 1e6 });
  assert.deepEqual(summarizeUsage(records, 'model').map((r) => r.key).sort(), ['ark/m1', 'ark/m2', 'qwen/?', 'qwen/flash']);
  assert.deepEqual(summarizeUsage(records, 'task').map((r) => r.key).sort(), ['run:r9', 't', 'w1']);
  assert.equal(costOf(prices, call({ model: 'm2' })), undefined, 'no price for ark/m2 and no ark-wide price');
  assert.ok(formatUsage(byAgent)[0]!.includes('1 call(s) without a cost'));
  assert.deepEqual(formatUsage([]), ['no provider usage']);
});

test('the usage file skips and counts lines it cannot read', () =>
  withDir(async (dir) => {
    const path = join(dir, 'usage.jsonl');
    const ledger = createFileUsageLedger(path);
    await ledger.record(call({ at: '2026-10-07T08:00:00Z' }));
    await writeFile(path, 'garbage\n', { flag: 'a' });
    await ledger.record(call({ at: '2026-10-07T09:00:00Z', agentId: 'b' }));
    assert.equal((await ledger.list()).length, 2);
    assert.equal(ledger.skipped(), 1);
    assert.equal((await ledger.list({ since: '2026-10-07T08:30:00Z' })).length, 1);
    assert.equal((await ledger.list({ agentId: 'b' })).length, 1);
  }));

test('the price table is optional, and checked when present', () =>
  withDir(async (dir) => {
    assert.deepEqual(readPriceTable(join(dir, 'none.json')), {});
    const good = join(dir, 'prices.json');
    await writeFile(good, JSON.stringify({ 'ark/doubao': { currency: 'CNY', inputPerMTok: 0.3, outputPerMTok: 0.6 } }));
    assert.equal(readPriceTable(good)['ark/doubao']!.currency, 'CNY');
    await writeFile(good, JSON.stringify({ ark: { currency: 'CNY', inputPerMTok: -1, outputPerMTok: 0 } }));
    assert.throws(() => readPriceTable(good), (e) => isRuntimeError(e, 'invalid_input'));
  }));

// ---------------------------------------------------------------------------
// Command line

function control(extra: Partial<AgentViewControl> = {}): TaskControl & AgentViewControl & { calls: unknown[] } {
  const calls: unknown[] = [];
  const unused = async () => {
    throw new Error('not used');
  };
  return {
    calls,
    submit: unused, status: unused, pause: unused, resume: unused, cancel: unused, artifacts: unused, inspectProcedure: unused,
    agents: async (o) => (calls.push(['agents', o]), { runs: [], lines: ['no agent runs'] }),
    usage: async (o) => (calls.push(['usage', o]), { rows: [] }),
    inbox: unused, approve: unused, deny: unused, answer: unused, host: unused,
    ...extra,
  } as TaskControl & AgentViewControl & { calls: unknown[] };
}

async function cli(words: string[], c: TaskControl) {
  const out: string[] = [];
  const code = await runCli(words, { stdout: (l) => out.push(l), stderr: () => {} }, c);
  return { code, json: JSON.parse(out[0]!) as { ok: boolean; command: string; result?: unknown; error?: { code: string; message: string } } };
}

test('task agents and task usage reach the agent views with checked words', async () => {
  const c = control();
  assert.deepEqual((await cli(['agents'], c)).json, { ok: true, command: 'agents', result: { runs: [], lines: ['no agent runs'] } });
  await cli(['agents', '--all'], c);
  await cli(['usage'], c);
  await cli(['usage', '--by', 'model', '--since', '2026-10-07T00:00:00+08:00'], c);
  assert.deepEqual(c.calls, [
    ['agents', { includeFinished: false }],
    ['agents', { includeFinished: true }],
    ['usage', { by: 'agent' }],
    ['usage', { by: 'model', since: '2026-10-06T16:00:00.000Z' }],
  ]);
  const bad = await cli(['agents', '--json'], c);
  assert.equal(bad.code, 2);
  assert.equal(bad.json.error!.code, 'invalid_input');
  assert.throws(() => parseUsage(['--by', 'team', '--since', 'yesterday', '--x']), (e) => {
    assert.ok(isRuntimeError(e, 'invalid_input'));
    const errors = (e.details as { errors: string[] }).errors;
    assert.equal(errors.length, 3);
    return true;
  });
  const without = { ...control(), agents: undefined, usage: undefined } as unknown as TaskControl;
  const missing = await cli(['agents'], without);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error!.code, 'capability_missing');
});

test('a fragment longer than one read chunk, or a file that is only a fragment, is cut off whole', () =>
  withDir(async (dir) => {
    const q = { application: 'com.zhipin.www', accountKey: 'hr-zhang', effect: 'external-submit' as const, since: '2026-10-01T00:00:00Z' };
    const only = join(dir, 'only.jsonl');
    await writeFile(only, 'x'.repeat(10_000));
    await createFileEffectLedger(only).record(use('2026-10-07T08:00:00Z'));
    assert.equal((await createFileEffectLedger(only).uses(q)).length, 1);
    const long = join(dir, 'long.jsonl');
    const ledger = createFileEffectLedger(long);
    await ledger.record(use('2026-10-07T07:00:00Z'));
    await writeFile(long, 'y'.repeat(9000), { flag: 'a' });
    await ledger.record(use('2026-10-07T08:00:00Z'));
    assert.equal((await ledger.uses(q)).length, 2);
  }));

test('a summary without failures has no failed column', () => {
  const [line] = formatUsage(summarizeUsage([call({})], 'agent'));
  assert.equal(line, 'a  1 calls  in 100  out 10  1 call(s) without a cost');
  const lines = formatUsage(summarizeUsage([call({}), call({ agentId: 'b', ok: false })], 'agent'));
  assert.ok(lines.every((l) => / \d+ failed /.test(l)), lines.join(' | '));
});

test('the agent data directory is tightened to the user alone even when it already exists', () =>
  withDir(async (dir) => {
    const paths = agentDataPaths(dir);
    await import('node:fs/promises').then((fs) => fs.mkdir(paths.dir, { mode: 0o755 }));
    prepareAgentDataDir(paths);
    assert.equal((await stat(paths.dir)).mode & 0o777, 0o700);
  }));
