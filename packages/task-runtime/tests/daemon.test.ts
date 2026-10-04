// Task control and worker ownership over a real ledger file: responsive
// control calls while an actor is busy, pause and cancel confirmed only after
// the actor has stopped, one owner per ledger through the daemon lease, and
// the rule that a lease running out proves nothing about an earlier actor:
// only a recorded exit or a verifier's evidence does. The process tests run
// real detached workers and detached "actor" children (standing in for the
// bridge's process groups), stall and kill them, and compete with them from
// the test process. The runners here are fakes that touch no GUI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  emptyUsage,
  isRuntimeError,
  type AccountScope,
  type Clock,
  type CollectResumesInput,
  type TaskOutcome,
  type TaskRunner,
  type TaskSpec,
  type TaskStore,
} from '../src/contracts.ts';
import { openTaskStore } from '../src/store.ts';
import {
  CONTROL_ITEM,
  DAEMON_LEASE_SCOPE,
  createTaskDaemon,
  daemonRunning,
  ensureDaemon,
  processIdentity,
  spawnDetachedWorker,
  type ActorExitVerifier,
  type TaskDaemon,
  type WorkerRecord,
} from '../src/daemon.ts';

const SPEC: TaskSpec = {
  schemaVersion: 1,
  id: 'boss.collect-resumes',
  version: '1.0.0',
  platforms: ['macos'],
  application: 'com.zhipin.www',
  windowProfile: 'boss-macos-1440x900',
  workflow: 'boss-resumes-v1',
  inputSchema: 'collect-resumes-input-v1',
  capabilities: ['ui.read'],
  submitAllowed: false,
  foregroundAllowed: false,
  learning: { promoteAfterSuccesses: 3 },
  defaults: { captureMode: 'available', analysis: 'off' },
};

const ACCOUNT: AccountScope = { platform: 'boss', accountKey: 'acct-1', binding: 'explicit' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * Stands in for the task runner: a few "actions", optionally one that
 * blocks until the signal fires and then takes a while to stop, as a GUI
 * action and a child process do.
 */
class FakeRunner implements TaskRunner {
  log: Array<{ at: number; taskId: string; what: 'start' | 'action' | 'exit' }> = [];
  runs = 0;
  active = 0;
  maxActive = 0;
  steps = 4;
  stepMs = 15;
  hangAt?: number;
  exitMs = 250;
  hanging?: () => void;
  /** Rejects after stopping, as a runner whose cleanup failed does. */
  rejectWith?: Error;
  /** The task's account when its run started. */
  accounts = new Map<string, AccountScope | undefined>();
  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  async run(taskId: string, signal: AbortSignal): Promise<TaskOutcome> {
    const at = (await this.store.getTask(taskId))!;
    if (at.status !== 'running') return this.outcome(taskId);
    this.accounts.set(taskId, at.account);
    this.runs += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.log.push({ at: Date.now(), taskId, what: 'start' });
    try {
      for (let i = 0; i < this.steps && !signal.aborted; i++) {
        if (i === this.hangAt) {
          this.hanging?.();
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          await sleep(this.exitMs);
          break;
        }
        this.log.push({ at: Date.now(), taskId, what: 'action' });
        await sleep(this.stepMs);
      }
      if (this.rejectWith) throw this.rejectWith;
      if (!signal.aborted) await this.store.transitionTask(taskId, 'succeeded', { terminationReason: 'target_reached' }, 'running').catch(() => undefined);
    } finally {
      this.active -= 1;
      this.log.push({ at: Date.now(), taskId, what: 'exit' });
    }
    return this.outcome(taskId);
  }

  private async outcome(taskId: string): Promise<TaskOutcome> {
    const task = (await this.store.getTask(taskId))!;
    return { taskId, status: task.status, counts: task.counts, usage: emptyUsage(), outputPath: join(task.input.outputDir, taskId) };
  }
}

interface Env {
  dir: string;
  dbPath: string;
  store: TaskStore;
  daemons: TaskDaemon[];
  daemon(runner: TaskRunner, options?: Partial<Parameters<typeof createTaskDaemon>[0]>): TaskDaemon;
  input(over?: Partial<CollectResumesInput>): CollectResumesInput;
  cleanup(): Promise<void>;
}

async function env(clock?: Clock): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-test-'));
  const dbPath = join(dir, 'tasks.db');
  const store = await openTaskStore({ path: dbPath, ...(clock ? { clock } : {}) });
  const e: Env = {
    dir,
    dbPath,
    store,
    daemons: [],
    daemon(runner, options = {}) {
      const d = createTaskDaemon({ store, runner, specs: (id) => (id === SPEC.id ? SPEC : undefined), pollMs: 30, leaseTtlMs: 600, verifyRetryMs: 50, ...(clock ? { clock } : {}), ...options });
      e.daemons.push(d);
      return d;
    },
    input: (over = {}) => ({ job: '前端工程师', requestedCount: 3, outputDir: join(dir, 'out'), source: 'conversations', captureMode: 'available', ...over }),
    async cleanup() {
      for (const d of e.daemons) await d.shutdown();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return e;
}

const statusAt = async (store: TaskStore, taskId: string, to: string): Promise<number | undefined> => {
  const event = (await store.listEvents(taskId)).find((ev) => ev.type === 'task_status' && ev.detail?.to === to);
  return event ? Date.parse(event.at) : undefined;
};

const controlTypes = async (store: TaskStore, taskId: string) => (await store.listEvents(taskId, { itemId: CONTROL_ITEM })).map((e) => e.type);
const statusOf = async (store: TaskStore, taskId: string) => (await store.getTask(taskId))!.status;

/** A task left running by a worker of another, now silent, daemon. */
async function plantRunning(e: Env, worker: Partial<WorkerRecord> = {}, finished?: { actorExited: boolean }): Promise<{ taskId: string; record: WorkerRecord }> {
  const task = await e.store.createTask(SPEC, e.input());
  await e.store.appendEvent({ taskId: task.id, itemId: CONTROL_ITEM, type: 'task_published', at: new Date().toISOString() });
  await e.store.transitionTask(task.id, 'running', { phase: 'executing' }, 'queued');
  const record: WorkerRecord = { taskId: task.id, epoch: 'epoch-old', daemonId: 'daemon-old', ownerPid: 999_999, processStartedAt: '2026-10-04T00:00:00.000Z', startedAt: new Date().toISOString(), ...worker };
  await e.store.appendEvent({ taskId: task.id, itemId: CONTROL_ITEM, type: 'worker_started', at: new Date().toISOString(), detail: { ...record } });
  if (finished) await e.store.appendEvent({ taskId: task.id, itemId: CONTROL_ITEM, type: 'worker_finished', at: new Date().toISOString(), detail: { epoch: record.epoch, ...finished } });
  return { taskId: task.id, record };
}

// ---------------------------------------------------------------------------
// in-process

test('submit answers at once and the owner runs published tasks one at a time; unpublished or bad submissions are not silently run', async () => {
  const e = await env();
  try {
    const runner = new FakeRunner(e.store);
    const daemon = e.daemon(runner);
    const started = Date.now();
    const a = await daemon.submit(SPEC.id, e.input());
    const b = await daemon.submit(SPEC.id, e.input());
    assert.ok(Date.now() - started < 500);
    await until('both tasks to succeed', async () => (await e.store.listTasks({ status: ['succeeded'] })).length === 2);
    assert.equal(runner.maxActive, 1, 'tasks of one skill drive one app: never two at once');
    const exitA = runner.log.find((l) => l.taskId === a.taskId && l.what === 'exit')!;
    const startB = runner.log.find((l) => l.taskId === b.taskId && l.what === 'start')!;
    assert.ok(exitA.at <= startB.at);
    assert.ok(daemon.isOwner());
    const types = await controlTypes(e.store, a.taskId);
    assert.deepEqual(types.filter((t) => t !== 'pause_applied'), ['task_published', 'worker_started', 'worker_finished']);

    await assert.rejects(daemon.submit('nope', e.input()), (err) => isRuntimeError(err, 'not_found'));
    await assert.rejects(daemon.submit(SPEC.id, e.input({ analysis: 'on' })), (err) => isRuntimeError(err, 'capability_missing'));
    await assert.rejects(daemon.submit(SPEC.id, e.input({ outputDir: 'relative' })), (err) => isRuntimeError(err, 'invalid_input'));
    await assert.rejects(daemon.submit(SPEC.id, e.input(), { account: { ...ACCOUNT, accountKey: 'a:b' } }), (err) => isRuntimeError(err, 'invalid_input'));

    // A queued task made straight through the store (or before publication existed).
    const raw = await e.store.createTask(SPEC, e.input());
    await until('the missing publication on record', async () => (await controlTypes(e.store, raw.id)).includes('publication_missing'));
    await sleep(100);
    assert.equal(await statusOf(e.store, raw.id), 'queued');
    await daemon.publish(raw.id);
    await until('the published task to succeed', async () => (await statusOf(e.store, raw.id)) === 'succeeded');
  } finally {
    await e.cleanup();
  }
});

test('while an actor is busy, status answers at once and pause is reported only once the actor has stopped', async () => {
  const e = await env();
  try {
    const runner = new FakeRunner(e.store);
    runner.hangAt = 1;
    const hanging = new Promise<void>((r) => (runner.hanging = r));
    const daemon = e.daemon(runner);
    const { taskId } = await daemon.submit(SPEC.id, e.input());
    await hanging;

    let t = Date.now();
    const report = await daemon.status(taskId);
    assert.ok(Date.now() - t < 200, 'status does not wait for GUI work');
    assert.equal(report.task.status, 'running');

    t = Date.now();
    const paused = await daemon.pause(taskId);
    const took = Date.now() - t;
    assert.ok(took < 2_000, `pause answered in ${took} ms`);
    assert.equal(paused.status, 'paused');
    const exit = runner.log.find((l) => l.what === 'exit')!;
    assert.ok(exit.at <= (await statusAt(e.store, taskId, 'paused'))!, 'paused is written after the actor exited');

    runner.hangAt = undefined;
    assert.equal((await daemon.resume(taskId)).status, 'running');
    await until('the resumed task to succeed', async () => (await statusOf(e.store, taskId)) === 'succeeded');
    assert.equal(runner.runs, 2);
  } finally {
    await e.cleanup();
  }
});

test('cancel answers at once with cancelling; cancelled is written only after the actor exits, and nothing acts after it', async () => {
  const e = await env();
  try {
    const runner = new FakeRunner(e.store);
    runner.hangAt = 2;
    runner.exitMs = 400;
    const hanging = new Promise<void>((r) => (runner.hanging = r));
    const daemon = e.daemon(runner, { ackWaitMs: 0 });
    const { taskId } = await daemon.submit(SPEC.id, e.input());
    await hanging;
    const t = Date.now();
    const answer = await daemon.cancel(taskId);
    assert.ok(Date.now() - t < 200);
    assert.equal(answer.status, 'cancelling', 'not cancelled while the actor is still live');
    await until('cancelled', async () => (await statusOf(e.store, taskId)) === 'cancelled');
    const cancelledAt = (await statusAt(e.store, taskId, 'cancelled'))!;
    const last = runner.log.at(-1)!;
    assert.equal(last.what, 'exit');
    assert.ok(last.at <= cancelledAt);
    await sleep(150);
    assert.equal(runner.log.at(-1), last);

    const queued = await daemon.submit(SPEC.id, e.input());
    runner.hangAt = 0;
    runner.exitMs = 10;
    assert.ok(['cancelled', 'cancelling'].includes((await daemon.cancel(queued.taskId)).status));
  } finally {
    await e.cleanup();
  }
});

test('two daemons on one ledger: only the lease holder runs tasks; the other serves control and takes over when the owner stops', async () => {
  const e = await env();
  try {
    const runnerA = new FakeRunner(e.store);
    const runnerB = new FakeRunner(e.store);
    const a = e.daemon(runnerA);
    await until('a to own the ledger', () => a.isOwner());
    const b = e.daemon(runnerB);
    const first = await b.submit(SPEC.id, e.input());
    await until('the first task to succeed', async () => (await statusOf(e.store, first.taskId)) === 'succeeded');
    assert.equal(runnerA.runs, 1);
    assert.equal(runnerB.runs, 0);
    assert.equal(b.isOwner(), false);
    assert.equal(await daemonRunning(e.store), true);

    await a.shutdown();
    await until('b to take over', () => b.isOwner());
    const second = await b.submit(SPEC.id, e.input());
    await until('the second task to succeed', async () => (await statusOf(e.store, second.taskId)) === 'succeeded');
    assert.equal(runnerB.runs, 1);
  } finally {
    await e.cleanup();
  }
});

test('an expired lease is not proof: a task whose worker exit is unrecorded stays unresolved and blocks new actors until a verifier proves the exit', async () => {
  const e = await env();
  try {
    const orphan = await plantRunning(e);
    // The silent daemon's lease runs out shortly.
    await e.store.acquireLease({ scopeKey: DAEMON_LEASE_SCOPE, holder: 'runtime', ownerPid: 999_999, ttlMs: 300 });
    let verdict: Awaited<ReturnType<ActorExitVerifier>> = { stopped: false, reason: 'bridge group 4242 still alive' };
    const asked: WorkerRecord[] = [];
    const runner = new FakeRunner(e.store);
    const daemon = e.daemon(runner, {
      verifyActorExit: async (worker) => {
        asked.push(worker);
        return verdict;
      },
    });
    await until('ownership after the old lease expired', () => daemon.isOwner());
    await until('the unproven exit on record', async () => (await controlTypes(e.store, orphan.taskId)).includes('actor_exit_unproven'));
    assert.deepEqual(asked[0], orphan.record, 'the verifier sees the recorded worker identity');

    const next = await daemon.submit(SPEC.id, e.input());
    assert.equal((await daemon.cancel(orphan.taskId)).status, 'cancelling');
    assert.equal((await daemon.pause(next.taskId).catch((err) => err)).code, 'conflict');
    await sleep(300);
    assert.equal(await statusOf(e.store, orphan.taskId), 'cancelling', 'never cancelled without proof');
    assert.equal(await statusOf(e.store, next.taskId), 'queued', 'no new actor may overlap the unproven one');
    assert.equal(runner.runs, 0);
    const unproven = (await e.store.listEvents(orphan.taskId, { itemId: CONTROL_ITEM })).filter((ev) => ev.type === 'actor_exit_unproven');
    assert.equal(unproven.length, 1, 'recorded once, not every poll');
    assert.equal(unproven[0]!.detail?.reason, 'bridge group 4242 still alive');

    verdict = { stopped: true, evidence: 'owner pid 999999 gone; bridge group 4242 verified by start time and stopped' };
    await until('the cancel to be confirmed', async () => (await statusOf(e.store, orphan.taskId)) === 'cancelled');
    const verified = (await e.store.listEvents(orphan.taskId, { itemId: CONTROL_ITEM })).find((ev) => ev.type === 'actor_exit_verified')!;
    assert.equal(verified.detail?.epoch, 'epoch-old');
    assert.match(String(verified.detail?.evidence), /verified by start time/);
    await until('the queued task to run', async () => (await statusOf(e.store, next.taskId)) === 'succeeded');
  } finally {
    await e.cleanup();
  }
});

test('a worker whose exit its daemon recorded is a proven orphan: paused, never reported done or re-run, resumable', async () => {
  const e = await env();
  try {
    const orphan = await plantRunning(e, {}, { actorExited: true });
    const runner = new FakeRunner(e.store);
    const daemon = e.daemon(runner);
    const paused = await until('the orphan to be paused', async () => {
      const t = await e.store.getTask(orphan.taskId);
      return t?.status === 'paused' ? t : undefined;
    });
    assert.equal(paused.terminationReason, undefined);
    assert.ok((await controlTypes(e.store, orphan.taskId)).includes('orphan_recovered'));
    assert.equal(runner.runs, 0);
    await daemon.resume(orphan.taskId);
    await until('the resumed orphan to succeed', async () => (await statusOf(e.store, orphan.taskId)) === 'succeeded');
  } finally {
    await e.cleanup();
  }
});

test('a pre-upgrade worker record without an epoch keeps its task from looking actor-free', async () => {
  const e = await env();
  try {
    const task = await e.store.createTask(SPEC, e.input());
    await e.store.transitionTask(task.id, 'running', {}, 'queued');
    // What the earlier daemon wrote: no control item, no epoch, no start time.
    await e.store.appendEvent({ taskId: task.id, type: 'worker_started', at: new Date().toISOString(), detail: { ownerPid: 999_999 } });
    await e.store.appendEvent({ taskId: task.id, type: 'worker_finished', at: new Date().toISOString(), detail: { ownerPid: 999_999 } });
    const asked: WorkerRecord[] = [];
    const runner = new FakeRunner(e.store);
    const daemon = e.daemon(runner, {
      verifyActorExit: async (worker) => {
        asked.push(worker);
        return { stopped: false, reason: 'no start time on record: identity unknown' };
      },
    });
    const next = await daemon.submit(SPEC.id, e.input());
    await until('the legacy worker to be checked', () => asked.length > 0);
    assert.equal(asked[0]!.legacy, true);
    assert.equal(asked[0]!.ownerPid, 999_999);
    await sleep(200);
    assert.equal(await statusOf(e.store, task.id), 'running');
    assert.equal(await statusOf(e.store, next.taskId), 'queued');
    assert.equal(runner.runs, 0);
  } finally {
    await e.cleanup();
  }
});

test('a runner that rejects proves nothing about its actor: the exit stays unproven and the task is left as it is', async () => {
  const e = await env();
  try {
    const runner = new FakeRunner(e.store);
    runner.rejectWith = new Error('the bridge group did not exit; its state is unknown');
    const daemon = e.daemon(runner);
    const { taskId } = await daemon.submit(SPEC.id, e.input());
    await until('the worker to finish', async () => (await controlTypes(e.store, taskId)).includes('actor_exit_unproven'));
    const finished = (await e.store.listEvents(taskId, { itemId: CONTROL_ITEM })).find((ev) => ev.type === 'worker_finished')!;
    assert.equal(finished.detail?.actorExited, false);
    assert.equal(await statusOf(e.store, taskId), 'running', 'neither paused nor failed on a guess');
    runner.rejectWith = undefined;
    const next = await daemon.submit(SPEC.id, e.input());
    await sleep(200);
    assert.equal(await statusOf(e.store, next.taskId), 'queued');
  } finally {
    await e.cleanup();
  }
});

test('a control-only daemon never runs tasks; pause and cancel apply at once only when no actor can exist, and a pause intent survives many later events', async () => {
  const e = await env();
  try {
    const client = e.daemon(new FakeRunner(e.store), { claim: false });
    const { taskId } = await client.submit(SPEC.id, e.input());
    await sleep(120);
    assert.equal(await statusOf(e.store, taskId), 'queued', 'no owner, so nobody runs it');
    // Running with no worker ever started: no actor exists.
    await e.store.transitionTask(taskId, 'running', {}, 'queued');
    assert.equal((await client.pause(taskId)).status, 'paused');
    assert.equal((await client.cancel(taskId)).status, 'cancelled');

    // An owner runs a task; the client's pause reaches it through the ledger, behind 300 other events.
    const runner = new FakeRunner(e.store);
    runner.hangAt = 1;
    const hanging = new Promise<void>((r) => (runner.hanging = r));
    e.daemon(runner, { pollMs: 400 });
    const next = await client.submit(SPEC.id, e.input());
    await hanging;
    const asked = await client.pause(next.taskId);
    assert.equal(asked.status, 'running', 'the client does not claim paused for an actor it cannot see stop');
    for (let i = 0; i < 300; i++) await e.store.appendEvent({ taskId: next.taskId, type: 'usage', at: new Date().toISOString(), detail: { i } });
    await until('the owner to apply the pause', async () => (await statusOf(e.store, next.taskId)) === 'paused');
    assert.ok(runner.log.find((l) => l.what === 'exit')!.at <= (await statusAt(e.store, next.taskId, 'paused'))!);
    // And a client cancel of a task with an unproven actor is not confirmed by the client.
    const planted = await plantRunning(e, { epoch: 'epoch-x' });
    assert.equal((await client.cancel(planted.taskId)).status, 'cancelling');
  } finally {
    await e.cleanup();
  }
});

test('a daemon that loses its lease stops its actor and records only the exit; the task is then a proven orphan', async () => {
  let skewMs = 0;
  const clock: Clock = { now: () => new Date(Date.now() + skewMs) };
  const e = await env(clock);
  try {
    const runner = new FakeRunner(e.store);
    runner.hangAt = 1;
    runner.exitMs = 50;
    const hanging = new Promise<void>((r) => (runner.hanging = r));
    const daemon = e.daemon(runner);
    const { taskId } = await daemon.submit(SPEC.id, e.input());
    await hanging;
    skewMs = 60 * 60 * 1000; // the lease runs out before the next renewal
    await until('the actor to stop', () => runner.log.some((l) => l.what === 'exit'));
    const recovered = await until('orphan recovery', async () => {
      const t = await e.store.getTask(taskId);
      return t?.status === 'paused' ? t : undefined;
    });
    assert.notEqual(recovered.status, 'succeeded');
    const control = await e.store.listEvents(taskId, { itemId: CONTROL_ITEM });
    const finished = control.find((ev) => ev.type === 'worker_finished')!;
    assert.equal(finished.detail?.actorExited, true, 'the exit is evidence, recorded even without the lease');
    assert.ok(control.some((ev) => ev.type === 'orphan_recovered'));
  } finally {
    await e.cleanup();
  }
});

test('the account is bound before a task is published, so its first run already has it; bindAccount never changes a bound key', async () => {
  const e = await env();
  try {
    const runner = new FakeRunner(e.store);
    const daemon = e.daemon(runner, { accountFor: () => ({ ...ACCOUNT, accountKey: 'acct-config' }) });
    const a = await daemon.submit(SPEC.id, e.input(), { account: ACCOUNT });
    const b = await daemon.submit(SPEC.id, e.input());
    await until('both to run', () => runner.accounts.size === 2);
    assert.deepEqual(runner.accounts.get(a.taskId), ACCOUNT);
    assert.equal(runner.accounts.get(b.taskId)?.accountKey, 'acct-config');
    const types = await controlTypes(e.store, a.taskId);
    assert.ok(types.indexOf('account_bound') < types.indexOf('task_published'));

    const client = e.daemon(new FakeRunner(e.store), { claim: false });
    const c = await client.submit(SPEC.id, e.input());
    await assert.rejects(client.bindAccount(c.taskId, ACCOUNT), (err) => isRuntimeError(err, 'conflict'), 'not while it may be picked up');
    await e.store.transitionTask(c.taskId, 'cancelled', {}, 'queued').catch(() => undefined);
    const d = await e.store.createTask(SPEC, e.input());
    await e.store.transitionTask(d.id, 'running', {}, 'queued');
    await e.store.transitionTask(d.id, 'waiting_user', { waitReason: 'account_changed' }, 'running');
    assert.equal((await client.bindAccount(d.id, ACCOUNT)).account?.accountKey, 'acct-1', 'first binding while waiting');
    await assert.rejects(client.bindAccount(d.id, { ...ACCOUNT, accountKey: 'acct-2' }), (err) => isRuntimeError(err, 'conflict'));
    await assert.rejects(client.bindAccount(d.id, { ...ACCOUNT, accountKey: 'a/b' }), (err) => isRuntimeError(err, 'invalid_input'));
  } finally {
    await e.cleanup();
  }
});

test('starting a worker fails truthfully: a missing program rejects, an early exit rejects at once, no ownership in time rejects', async () => {
  const e = await env();
  try {
    await assert.rejects(spawnDetachedWorker({ command: join(e.dir, 'no-such-program'), args: [] }), (err) => isRuntimeError(err, 'capability_missing'));
    let t = Date.now();
    await assert.rejects(ensureDaemon(e.store, { command: '/usr/bin/false', args: [] }, { readyTimeoutMs: 5_000 }), (err) => isRuntimeError(err, 'io'));
    assert.ok(Date.now() - t < 2_000, 'an exit is seen at once, not after the timeout');
    t = Date.now();
    let pid: number | undefined;
    await assert.rejects(ensureDaemon(e.store, { command: '/bin/sleep', args: ['30'] }, { readyTimeoutMs: 300 }), (err) => {
      pid = isRuntimeError(err, 'timeout') ? Number(err.details?.pid) : undefined;
      return pid !== undefined;
    });
    assert.equal(processIdentity(pid!, undefined), 'unknown', 'left running, reported, not killed');
    process.kill(pid!, 'SIGKILL');
  } finally {
    await e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// real processes

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(pkg, 'src');
const tsx = join(pkg, 'node_modules', '.bin', 'tsx');

/**
 * A detached daemon process. Its stand-in runner writes one ledger event per
 * step; in 'actor' mode it also starts a detached child (its own process
 * group, like the bridge) that writes a heartbeat file, records the child's
 * identity in a registry file, and on stopping terminates that group and
 * waits for it to exit. In 'stubborn' mode the child ignores SIGTERM, the
 * wait fails, and the runner rejects: its actor's exit is then unknown.
 */
const WORKER = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTaskStore } from ${JSON.stringify(join(src, 'store.ts'))};
import { createTaskDaemon, processStartTime } from ${JSON.stringify(join(src, 'daemon.ts'))};
const [dbPath, stepMs, mode, registryDir] = process.argv.slice(2);
const SPEC = ${JSON.stringify(SPEC)};
const store = await openTaskStore({ path: dbPath });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runner = {
  async run(taskId, signal) {
    const out = async () => { const t = await store.getTask(taskId); return { taskId, status: t.status, counts: t.counts, usage: {}, outputPath: '' }; };
    const task = await store.getTask(taskId);
    if (task.status !== 'running') return out();
    let actor, exited;
    const registry = join(registryDir, 'actor-' + taskId + '.json');
    if (mode === 'actor' || mode === 'stubborn') {
      const beat = join(registryDir, 'beat-' + taskId);
      const code = (mode === 'stubborn' ? "process.on('SIGTERM', () => {});" : '') + "const fs = require('fs'); setInterval(() => fs.appendFileSync(" + JSON.stringify(beat) + ", 'x'), 40);";
      actor = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
      exited = new Promise((r) => actor.once('exit', r));
      await new Promise((r, j) => { actor.once('spawn', r); actor.once('error', j); });
      actor.unref();
      writeFileSync(registry, JSON.stringify({ taskId, pid: actor.pid, pgid: actor.pid, processStartedAt: processStartTime(actor.pid), beat }));
    } else writeFileSync(registry, JSON.stringify({ taskId }));
    for (let i = 0; i < task.input.requestedCount && !signal.aborted; i++) {
      await store.appendEvent({ taskId, type: 'fake_step', at: new Date().toISOString(), detail: { i, pid: process.pid } });
      await sleep(Number(stepMs));
    }
    if (actor) {
      try { process.kill(-actor.pid, 'SIGTERM'); } catch {}
      const gone = await Promise.race([exited.then(() => true), sleep(500).then(() => false)]);
      if (!gone) throw new Error('the actor group did not exit; its state is unknown');
    }
    if (!signal.aborted) await store.transitionTask(taskId, 'succeeded', { terminationReason: 'target_reached' }, 'running').catch(() => undefined);
    return out();
  },
};
const daemon = createTaskDaemon({ store, runner, specs: () => SPEC, leaseTtlMs: 600, pollMs: 50, ackWaitMs: 0 });
process.on('SIGTERM', async () => { await daemon.shutdown(); await store.close(); process.exit(0); });
setInterval(() => undefined, 1 << 30);
`;

const CLI = `
import { openTaskStore } from ${JSON.stringify(join(src, 'store.ts'))};
import { createTaskDaemon, ensureDaemon } from ${JSON.stringify(join(src, 'daemon.ts'))};
const [dbPath, workerPath, tsxPath, logPath, count, outputDir, registryDir] = process.argv.slice(2);
const SPEC = ${JSON.stringify(SPEC)};
const store = await openTaskStore({ path: dbPath });
const control = createTaskDaemon({ store, runner: { run: async () => { throw new Error('the CLI never runs tasks'); } }, specs: () => SPEC, claim: false });
const { taskId } = await control.submit(SPEC.id, { job: '前端工程师', requestedCount: Number(count), outputDir, source: 'conversations', captureMode: 'available' });
const daemon = await ensureDaemon(store, { command: tsxPath, args: [workerPath, dbPath, '100', 'plain', registryDir], logPath }, { readyTimeoutMs: 20000 });
await control.shutdown();
await store.close();
console.log(JSON.stringify({ taskId, ...daemon }));
process.exit(0);
`;

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Registry {
  taskId: string;
  pid?: number;
  pgid?: number;
  processStartedAt?: string;
  beat?: string;
}

const readRegistry = (dir: string, taskId: string): Registry | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, `actor-${taskId}.json`), 'utf8')) as Registry;
  } catch {
    return undefined;
  }
};

/**
 * What an A7 verifier does: the worker process must be gone by pid and start
 * time, and every registered actor group must be gone, or alive with the
 * recorded start time — then, and only then, it is terminated and checked again.
 */
function registryVerifier(registryDir: string, stops: string[]): ActorExitVerifier {
  return async (worker) => {
    const owner = processIdentity(worker.ownerPid, worker.processStartedAt);
    if (owner !== 'gone') return { stopped: false, reason: `worker process ${worker.ownerPid} is ${owner}` };
    const reg = readRegistry(registryDir, worker.taskId);
    if (!reg) return { stopped: false, reason: 'no actor registry for this worker' };
    if (reg.pid === undefined) return { stopped: true, evidence: `worker ${worker.ownerPid} gone by start time; no actor groups registered` };
    let identity = processIdentity(reg.pid, reg.processStartedAt);
    if (identity === 'alive') {
      stops.push(`${reg.pgid}`);
      process.kill(-reg.pgid!, 'SIGTERM');
      await until('the actor group to end', () => !groupAlive(reg.pgid!), 400).catch(() => process.kill(-reg.pgid!, 'SIGKILL'));
      await until('the actor group to end', () => !groupAlive(reg.pgid!), 2_000).catch(() => undefined);
      identity = processIdentity(reg.pid, reg.processStartedAt);
    }
    if (identity !== 'gone') return { stopped: false, reason: `actor ${reg.pid} is ${identity}` };
    return { stopped: true, evidence: `worker ${worker.ownerPid} gone by start time; actor group ${reg.pgid} verified by start time and gone` };
  };
}

const beating = async (path: string): Promise<boolean> => {
  const size = () => (existsSync(path) ? statSync(path).size : 0);
  const before = size();
  await sleep(250);
  return size() > before;
};

function killAll(groups: Array<number | undefined>): void {
  for (const g of groups) {
    if (g === undefined || !groupAlive(g)) continue;
    try {
      process.kill(-g, 'SIGCONT');
      process.kill(-g, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

test('a task submitted by a CLI that exits is finished by the detached worker; a killed worker is resolved only once a verifier proves it gone', { timeout: 60_000 }, async () => {
  const e = await env();
  const workerPath = join(e.dir, 'worker.mts');
  const cliPath = join(e.dir, 'cli.mts');
  writeFileSync(workerPath, WORKER);
  writeFileSync(cliPath, CLI);
  const cli = (count: number) =>
    promisify(execFile)(tsx, [cliPath, e.dbPath, workerPath, tsx, join(e.dir, 'worker.log'), String(count), join(e.dir, 'out'), e.dir], { timeout: 40_000 }).then(
      (r) => JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { taskId: string; started: boolean; pid?: number; ownerPid: number; ownedBySpawned?: boolean },
    );
  let workerGroup: number | undefined;
  try {
    const first = await cli(8);
    assert.equal(first.started, true);
    assert.equal(first.ownedBySpawned, true, 'the lease is held by the process the CLI started');
    workerGroup = first.pid!;
    const done = await until('the detached worker to finish the task', async () => {
      const t = await e.store.getTask(first.taskId);
      return t?.status === 'succeeded' ? t : undefined;
    }, 30_000);
    assert.equal(done.terminationReason, 'target_reached');
    assert.ok(groupAlive(workerGroup), 'the worker keeps running after the CLI exited');

    const second = await cli(400);
    assert.equal(second.started, false, 'a second CLI finds the worker and starts no other');
    assert.equal(second.ownerPid, first.ownerPid);
    await until('the worker to start the long task', async () => (await e.store.listEvents(second.taskId)).some((ev) => ev.type === 'fake_step'), 15_000);

    process.kill(-workerGroup, 'SIGKILL');
    await until('the worker to be gone', () => !groupAlive(workerGroup!), 5_000);

    // Without a verifier the new owner leaves the task alone.
    const blind = e.daemon(new FakeRunner(e.store));
    await until('ownership', () => blind.isOwner(), 10_000);
    await until('the unproven exit on record', async () => (await controlTypes(e.store, second.taskId)).includes('actor_exit_unproven'));
    await sleep(200);
    assert.equal(await statusOf(e.store, second.taskId), 'running');
    await blind.shutdown();

    const stops: string[] = [];
    const runner = new FakeRunner(e.store);
    e.daemon(runner, { verifyActorExit: registryVerifier(e.dir, stops) });
    const orphan = await until('the orphan to be paused', async () => {
      const t = await e.store.getTask(second.taskId);
      return t?.status === 'paused' ? t : undefined;
    }, 10_000);
    assert.equal(orphan.terminationReason, undefined);
    const control = await e.store.listEvents(second.taskId, { itemId: CONTROL_ITEM });
    assert.match(String(control.find((ev) => ev.type === 'actor_exit_verified')?.detail?.evidence), /gone by start time/);
    assert.ok(control.some((ev) => ev.type === 'orphan_recovered'));
    assert.equal(runner.runs, 0);
    assert.deepEqual(stops, [], 'nothing needed stopping, so nothing was killed');
  } finally {
    killAll([workerGroup]);
    await e.cleanup();
  }
});

test('a stalled old daemon with a live detached actor: the new owner decides nothing until the old one records the actor gone', { timeout: 60_000 }, async () => {
  const e = await env();
  const workerPath = join(e.dir, 'worker.mts');
  writeFileSync(workerPath, WORKER);
  let workerGroup: number | undefined;
  let reg: Registry | undefined;
  try {
    const client = e.daemon(new FakeRunner(e.store), { claim: false });
    const long = await client.submit(SPEC.id, e.input({ requestedCount: 400 }));
    const started = await ensureDaemon(e.store, { command: tsx, args: [workerPath, e.dbPath, '100', 'actor', e.dir], logPath: join(e.dir, 'worker.log') }, { readyTimeoutMs: 20_000 });
    assert.ok(started.started && started.ownedBySpawned);
    workerGroup = started.started ? started.pid : undefined;
    reg = await until('the actor to be registered', () => readRegistry(e.dir, long.taskId)?.pid !== undefined && readRegistry(e.dir, long.taskId), 15_000);
    assert.ok(await beating(reg.beat!));

    // The old daemon stalls; its actor, in its own group, keeps going.
    process.kill(-workerGroup!, 'SIGSTOP');
    const runner = new FakeRunner(e.store);
    const owner = e.daemon(runner);
    await until('the new daemon to own the ledger after the old lease expired', () => owner.isOwner(), 10_000);
    await until('the unproven exit on record', async () => (await controlTypes(e.store, long.taskId)).includes('actor_exit_unproven'), 5_000);
    const next = await owner.submit(SPEC.id, e.input());
    assert.equal((await owner.cancel(long.taskId)).status, 'cancelling');
    assert.ok(await beating(reg.beat!), 'the actor is really still alive');
    assert.equal(await statusOf(e.store, long.taskId), 'cancelling', 'not cancelled while its actor may act');
    assert.equal(await statusOf(e.store, next.taskId), 'queued', 'no second actor started');
    assert.equal(runner.runs, 0);

    // The old daemon wakes, finds its lease gone, stops its actor and records the exit.
    process.kill(-workerGroup!, 'SIGCONT');
    await until('the cancel to be confirmed', async () => (await statusOf(e.store, long.taskId)) === 'cancelled', 15_000);
    assert.equal(processIdentity(reg.pid!, reg.processStartedAt), 'gone', 'the actor had exited when cancelled was written');
    assert.equal(await beating(reg.beat!), false);
    const finished = (await e.store.listEvents(long.taskId, { itemId: CONTROL_ITEM })).find((ev) => ev.type === 'worker_finished')!;
    assert.equal(finished.detail?.actorExited, true);
    await until('the queued task to run under the new owner', async () => (await statusOf(e.store, next.taskId)) === 'succeeded', 10_000);
    assert.equal(runner.runs, 1);
  } finally {
    killAll([workerGroup, reg?.pgid]);
    await e.cleanup();
  }
});

test('a killed worker whose detached actor survives stays unresolved; a verifier that checks identity stops only that group', { timeout: 60_000 }, async () => {
  const e = await env();
  const workerPath = join(e.dir, 'worker.mts');
  writeFileSync(workerPath, WORKER);
  let workerGroup: number | undefined;
  let reg: Registry | undefined;
  try {
    const client = e.daemon(new FakeRunner(e.store), { claim: false });
    const long = await client.submit(SPEC.id, e.input({ requestedCount: 400 }));
    const started = await ensureDaemon(e.store, { command: tsx, args: [workerPath, e.dbPath, '100', 'actor', e.dir], logPath: join(e.dir, 'worker.log') }, { readyTimeoutMs: 20_000 });
    workerGroup = started.started ? started.pid : undefined;
    reg = await until('the actor to be registered', () => readRegistry(e.dir, long.taskId)?.pid !== undefined && readRegistry(e.dir, long.taskId), 15_000);
    process.kill(-workerGroup!, 'SIGKILL');
    await until('the worker to be gone', () => !groupAlive(workerGroup!), 5_000);
    assert.ok(await beating(reg.beat!), 'the detached actor outlived its parent');

    const blind = e.daemon(new FakeRunner(e.store));
    await until('ownership', () => blind.isOwner(), 10_000);
    await until('the unproven exit on record', async () => (await controlTypes(e.store, long.taskId)).includes('actor_exit_unproven'));
    await sleep(200);
    assert.equal(await statusOf(e.store, long.taskId), 'running');
    assert.ok(await beating(reg.beat!));
    await blind.shutdown();

    const stops: string[] = [];
    e.daemon(new FakeRunner(e.store), { verifyActorExit: registryVerifier(e.dir, stops) });
    await until('the orphan to be paused', async () => (await statusOf(e.store, long.taskId)) === 'paused', 10_000);
    assert.deepEqual(stops, [String(reg.pgid)], 'only the registered, identity-checked group was stopped');
    assert.equal(processIdentity(reg.pid!, reg.processStartedAt), 'gone');
    assert.equal(await beating(reg.beat!), false);
  } finally {
    killAll([workerGroup, reg?.pgid]);
    await e.cleanup();
  }
});

test('a worker whose actor would not exit records that it does not know; the cancel waits for a verifier', { timeout: 60_000 }, async () => {
  const e = await env();
  const workerPath = join(e.dir, 'worker.mts');
  writeFileSync(workerPath, WORKER);
  let workerGroup: number | undefined;
  let reg: Registry | undefined;
  try {
    const client = e.daemon(new FakeRunner(e.store), { claim: false });
    const long = await client.submit(SPEC.id, e.input({ requestedCount: 400 }));
    const started = await ensureDaemon(e.store, { command: tsx, args: [workerPath, e.dbPath, '100', 'stubborn', e.dir], logPath: join(e.dir, 'worker.log') }, { readyTimeoutMs: 20_000 });
    workerGroup = started.started ? started.pid : undefined;
    reg = await until('the actor to be registered', () => readRegistry(e.dir, long.taskId)?.pid !== undefined && readRegistry(e.dir, long.taskId), 15_000);

    assert.equal((await client.cancel(long.taskId)).status, 'cancelling');
    const finished = await until('the worker to give up on its actor', async () =>
      (await e.store.listEvents(long.taskId, { itemId: CONTROL_ITEM })).find((ev) => ev.type === 'worker_finished'), 10_000);
    assert.equal(finished.detail?.actorExited, false);
    await sleep(300);
    assert.equal(await statusOf(e.store, long.taskId), 'cancelling', 'the worker does not confirm what it could not prove');
    assert.ok(await beating(reg.beat!));

    // The worker is shut down; a daemon with a verifier settles it.
    process.kill(workerGroup!, 'SIGTERM');
    await until('the worker to exit', () => !groupAlive(workerGroup!), 10_000);
    const stops: string[] = [];
    e.daemon(new FakeRunner(e.store), { verifyActorExit: registryVerifier(e.dir, stops) });
    await until('the cancel to be confirmed', async () => (await statusOf(e.store, long.taskId)) === 'cancelled', 10_000);
    assert.deepEqual(stops, [String(reg.pgid)]);
    assert.equal(processIdentity(reg.pid!, reg.processStartedAt), 'gone');
  } finally {
    killAll([workerGroup, reg?.pgid]);
    await e.cleanup();
  }
});

test('a running orphan whose exit a verifier proves is paused, not restarted', async () => {
  const e = await env();
  try {
    const orphan = await plantRunning(e);
    const runner = new FakeRunner(e.store);
    e.daemon(runner, { verifyActorExit: async () => ({ stopped: true, evidence: 'owner and actor groups gone by start time' }) });
    await until('the orphan to be paused', async () => (await statusOf(e.store, orphan.taskId)) === 'paused');
    await sleep(150);
    assert.equal(await statusOf(e.store, orphan.taskId), 'paused');
    assert.equal(runner.runs, 0);
    const types = await controlTypes(e.store, orphan.taskId);
    assert.ok(types.indexOf('actor_exit_verified') < types.indexOf('orphan_recovered'));
  } finally {
    await e.cleanup();
  }
});

test('a transient ledger error while renewing is not a lost lease: the worker keeps running and the task is not orphaned', async () => {
  const e = await env();
  try {
    let failures = 3;
    const flaky = new Proxy(e.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'renewLease')
          return (...args: Parameters<TaskStore['renewLease']>) =>
            failures-- > 0 ? Promise.reject(new Error('database is busy')) : target.renewLease(...args);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TaskStore;
    const runner = new FakeRunner(e.store);
    runner.steps = 20;
    runner.stepMs = 20;
    const daemon = createTaskDaemon({ store: flaky, runner, specs: () => SPEC, pollMs: 30, leaseTtlMs: 600 });
    e.daemons.push(daemon);
    const { taskId } = await daemon.submit(SPEC.id, e.input());
    await until('the task to succeed', async () => (await statusOf(e.store, taskId)) === 'succeeded');
    assert.equal(failures < 0, true, 'renewals did fail');
    assert.equal(runner.runs, 1);
    assert.ok(!(await controlTypes(e.store, taskId)).includes('orphan_recovered'));
  } finally {
    await e.cleanup();
  }
});
