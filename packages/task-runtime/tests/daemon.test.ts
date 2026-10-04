// Task control and worker ownership over a real ledger file: responsive
// control calls while an actor is busy, pause and cancel confirmed only after
// the actor has stopped, one owner per ledger through the daemon lease,
// orphan recovery, and a real detached worker process that outlives the CLI
// that submitted its task. The runners here are fakes that act on nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  RuntimeError,
  emptyUsage,
  isRuntimeError,
  type Clock,
  type CollectResumesInput,
  type TaskOutcome,
  type TaskRunner,
  type TaskSpec,
  type TaskStore,
} from '../src/contracts.ts';
import { openTaskStore } from '../src/store.ts';
import { DAEMON_LEASE_SCOPE, createTaskDaemon, daemonRunning, type TaskDaemon } from '../src/daemon.ts';

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
  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  async run(taskId: string, signal: AbortSignal): Promise<TaskOutcome> {
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
      if (!signal.aborted) await this.store.transitionTask(taskId, 'succeeded', { terminationReason: 'target_reached' }, 'running').catch(() => undefined);
    } finally {
      this.active -= 1;
      this.log.push({ at: Date.now(), taskId, what: 'exit' });
    }
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
      const d = createTaskDaemon({ store, runner, specs: (id) => (id === SPEC.id ? SPEC : undefined), pollMs: 30, leaseTtlMs: 600, ...(clock ? { clock } : {}), ...options });
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

test('submit answers at once and the owner runs queued tasks one at a time; bad submissions are refused clearly', async () => {
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

    await assert.rejects(daemon.submit('nope', e.input()), (err) => isRuntimeError(err, 'not_found'));
    await assert.rejects(daemon.submit(SPEC.id, e.input({ analysis: 'on' })), (err) => isRuntimeError(err, 'capability_missing'));
    await assert.rejects(daemon.submit(SPEC.id, e.input({ outputDir: 'relative' })), (err) => isRuntimeError(err, 'invalid_input'));
    assert.equal((await e.store.listTasks()).length, 2);
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
    assert.equal(report.outputPath, join(e.dir, 'out', taskId));

    t = Date.now();
    const paused = await daemon.pause(taskId);
    const took = Date.now() - t;
    assert.ok(took < 2_000, `pause answered in ${took} ms`);
    assert.equal(paused.status, 'paused');
    const exit = runner.log.find((l) => l.what === 'exit')!;
    assert.ok(exit.at <= (await statusAt(e.store, taskId, 'paused'))!, 'paused is written after the actor exited');
    const actions = runner.log.filter((l) => l.what === 'action').length;
    await sleep(150);
    assert.equal(runner.log.filter((l) => l.what === 'action').length, actions);

    runner.hangAt = undefined;
    const resumed = await daemon.resume(taskId);
    assert.equal(resumed.status, 'running');
    await until('the resumed task to succeed', async () => (await e.store.getTask(taskId))?.status === 'succeeded');
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
    const record = await until('cancelled', async () => {
      const task = await e.store.getTask(taskId);
      return task?.status === 'cancelled' ? task : undefined;
    });
    assert.equal(record.terminationReason, 'cancelled');
    const cancelledAt = (await statusAt(e.store, taskId, 'cancelled'))!;
    const last = runner.log.at(-1)!;
    assert.equal(last.what, 'exit');
    assert.ok(last.at <= cancelledAt, 'the actor had exited when cancelled was written');
    assert.ok(runner.log.filter((l) => l.what === 'action').every((l) => l.at <= cancelledAt));
    await sleep(150);
    assert.equal(runner.log.at(-1), last);

    // A queued task has no actor and is cancelled at once.
    runner.hangAt = 0;
    runner.exitMs = 10;
    const blocker = await daemon.submit(SPEC.id, e.input());
    await until('the blocker to run', async () => (await e.store.getTask(blocker.taskId))?.status === 'running');
    const queued = await daemon.submit(SPEC.id, e.input());
    assert.equal((await daemon.cancel(queued.taskId)).status, 'cancelled');
    await assert.rejects(daemon.pause(queued.taskId), (err) => isRuntimeError(err, 'conflict'));
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
    await until('the first task to succeed', async () => (await e.store.getTask(first.taskId))?.status === 'succeeded');
    assert.equal(runnerA.runs, 1);
    assert.equal(runnerB.runs, 0);
    assert.equal(b.isOwner(), false);
    assert.equal(await daemonRunning(e.store), true);

    await a.shutdown();
    await until('b to take over', () => b.isOwner());
    const second = await b.submit(SPEC.id, e.input());
    await until('the second task to succeed', async () => (await e.store.getTask(second.taskId))?.status === 'succeeded');
    assert.equal(runnerA.runs, 1);
    assert.equal(runnerB.runs, 1);
  } finally {
    await e.cleanup();
  }
});

test('a task left running by a dead worker is paused as an orphan once its lease expires, never reported done, and resumes on request', async () => {
  const e = await env();
  try {
    const task = await e.store.createTask(SPEC, e.input());
    await e.store.transitionTask(task.id, 'running', { phase: 'executing' }, 'queued');
    await e.store.appendEvent({ taskId: task.id, type: 'worker_started', at: new Date().toISOString(), detail: { ownerPid: 999_999 } });
    // The dead daemon's lease has not run out yet.
    await e.store.acquireLease({ scopeKey: DAEMON_LEASE_SCOPE, holder: 'runtime', ownerPid: 999_999, ttlMs: 400 });

    const runner = new FakeRunner(e.store);
    const daemon = e.daemon(runner);
    await sleep(150);
    assert.equal(daemon.isOwner(), false, 'no second owner while the old lease is live');
    assert.equal((await e.store.getTask(task.id))!.status, 'running');

    await until('ownership', () => daemon.isOwner());
    const recovered = await until('the orphan to be paused', async () => {
      const t = await e.store.getTask(task.id);
      return t?.status === 'paused' ? t : undefined;
    });
    assert.equal(recovered.terminationReason, undefined);
    assert.equal(recovered.error?.code, 'lease_held');
    assert.ok((await e.store.listEvents(task.id)).some((ev) => ev.type === 'orphan_recovered'));
    assert.equal(runner.runs, 0, 'an orphan is not silently re-run');

    await daemon.resume(task.id);
    await until('the resumed orphan to succeed', async () => (await e.store.getTask(task.id))?.status === 'succeeded');
    assert.equal(runner.runs, 1);
  } finally {
    await e.cleanup();
  }
});

test('a control-only daemon never runs tasks; with no owner its pause and cancel apply at once, with an owner the owner applies them after its actor stops', async () => {
  const e = await env();
  try {
    const idle = new FakeRunner(e.store);
    const client = e.daemon(idle, { claim: false });
    const { taskId } = await client.submit(SPEC.id, e.input());
    await sleep(120);
    assert.equal((await e.store.getTask(taskId))!.status, 'queued', 'no owner, so nobody runs it');
    assert.equal(idle.runs, 0);
    assert.equal(client.isOwner(), false);

    // A task left running with no daemon anywhere: no actor exists, so the request applies now.
    await e.store.transitionTask(taskId, 'running', {}, 'queued');
    assert.equal((await client.pause(taskId)).status, 'paused');
    assert.equal((await client.cancel(taskId)).status, 'cancelled');

    // Now an owner runs a task; the client's requests reach it through the ledger.
    const runner = new FakeRunner(e.store);
    runner.hangAt = 1;
    const owner = e.daemon(runner);
    const hanging = new Promise<void>((r) => (runner.hanging = r));
    const next = await client.submit(SPEC.id, e.input());
    await hanging;
    const asked = await client.pause(next.taskId);
    assert.equal(asked.status, 'running', 'the client does not claim paused for an actor it cannot see stop');
    await until('the owner to apply the pause', async () => (await e.store.getTask(next.taskId))?.status === 'paused');
    assert.ok(runner.log.find((l) => l.what === 'exit')!.at <= (await statusAt(e.store, next.taskId, 'paused'))!);

    runner.hangAt = 0;
    await client.resume(next.taskId);
    await until('running again', async () => runner.runs === 2);
    assert.equal((await client.cancel(next.taskId)).status, 'cancelling');
    await until('the owner to confirm the cancel', async () => (await e.store.getTask(next.taskId))?.status === 'cancelled');
    assert.ok(owner.isOwner());

    // Binding an account is a short transaction, refused while the task runs.
    const bindable = await client.submit(SPEC.id, e.input());
    await client.cancel(bindable.taskId);
    await assert.rejects(client.bindAccount(bindable.taskId, { platform: 'boss', accountKey: 'acct-1', binding: 'explicit' }), (err) => isRuntimeError(err, 'conflict'));
    const third = await e.store.createTask(SPEC, e.input());
    await assert.rejects(client.bindAccount(third.id, { platform: 'boss', accountKey: 'a:b', binding: 'explicit' }), (err) => isRuntimeError(err, 'invalid_input'));
  } finally {
    await e.cleanup();
  }
});

test('a daemon that loses its lease stops its actor and writes nothing for the task; the task is then recovered as an orphan', async () => {
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
    const events = (await e.store.listEvents(taskId)).map((ev) => ev.type);
    assert.ok(events.includes('orphan_recovered'));
    assert.ok(!events.includes('worker_finished'), 'a daemon without the lease writes nothing about the task');
  } finally {
    await e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// real processes

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(pkg, 'src');
const tsx = join(pkg, 'node_modules', '.bin', 'tsx');

const WORKER = `
import { openTaskStore } from ${JSON.stringify(join(src, 'store.ts'))};
import { createTaskDaemon } from ${JSON.stringify(join(src, 'daemon.ts'))};
const [dbPath, stepMs] = process.argv.slice(2);
const SPEC = ${JSON.stringify(SPEC)};
const store = await openTaskStore({ path: dbPath });
// A stand-in runner: one ledger event per step, requestedCount steps.
const runner = {
  async run(taskId, signal) {
    const task = await store.getTask(taskId);
    for (let i = 0; i < task.input.requestedCount && !signal.aborted; i++) {
      await store.appendEvent({ taskId, type: 'fake_step', at: new Date().toISOString(), detail: { i, pid: process.pid } });
      await new Promise((r) => setTimeout(r, Number(stepMs)));
    }
    if (!signal.aborted) await store.transitionTask(taskId, 'succeeded', { terminationReason: 'target_reached' }, 'running').catch(() => undefined);
    const now = await store.getTask(taskId);
    return { taskId, status: now.status, counts: now.counts, usage: {}, outputPath: '' };
  },
};
const daemon = createTaskDaemon({ store, runner, specs: () => SPEC, leaseTtlMs: 600, pollMs: 50 });
process.on('SIGTERM', async () => { await daemon.shutdown(); await store.close(); process.exit(0); });
setInterval(() => undefined, 1 << 30);
`;

const CLI = `
import { openTaskStore } from ${JSON.stringify(join(src, 'store.ts'))};
import { createTaskDaemon, ensureDaemon } from ${JSON.stringify(join(src, 'daemon.ts'))};
const [dbPath, workerPath, tsxPath, logPath, count, outputDir] = process.argv.slice(2);
const SPEC = ${JSON.stringify(SPEC)};
const store = await openTaskStore({ path: dbPath });
const control = createTaskDaemon({ store, runner: { run: async () => { throw new Error('the CLI never runs tasks'); } }, specs: () => SPEC, claim: false });
const { taskId } = await control.submit(SPEC.id, { job: '前端工程师', requestedCount: Number(count), outputDir, source: 'conversations', captureMode: 'available' });
const daemon = await ensureDaemon(store, { command: tsxPath, args: [workerPath, dbPath, '100'], logPath });
await control.shutdown();
await store.close();
console.log(JSON.stringify({ taskId, ...daemon }));
process.exit(0);
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a task submitted by a CLI that exits is finished by the detached worker; a killed worker leaves an orphan the next daemon pauses', { timeout: 60_000 }, async () => {
  const e = await env();
  const workerPath = join(e.dir, 'worker.mts');
  const cliPath = join(e.dir, 'cli.mts');
  writeFileSync(workerPath, WORKER);
  writeFileSync(cliPath, CLI);
  const logPath = join(e.dir, 'worker.log');
  const cli = (count: number) =>
    promisify(execFile)(tsx, [cliPath, e.dbPath, workerPath, tsx, logPath, String(count), join(e.dir, 'out')], { timeout: 30_000 }).then(
      (r) => JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { taskId: string; started: boolean; pid?: number },
    );
  let workerGroup: number | undefined;
  try {
    const first = await cli(8);
    assert.equal(first.started, true);
    workerGroup = first.pid!;
    // The CLI has exited; the worker carries on alone.
    const done = await until('the detached worker to finish the task', async () => {
      const t = await e.store.getTask(first.taskId);
      return t?.status === 'succeeded' ? t : undefined;
    }, 30_000);
    assert.equal(done.terminationReason, 'target_reached');
    const steps = (await e.store.listEvents(first.taskId)).filter((ev) => ev.type === 'fake_step');
    assert.equal(steps.length, 8);
    assert.ok(alive(workerGroup), 'the worker keeps running after the CLI exited');

    // A second CLI finds the worker and does not start another.
    const second = await cli(400);
    assert.equal(second.started, false);
    await until('the worker to start the long task', async () => (await e.store.listEvents(second.taskId)).some((ev) => ev.type === 'fake_step'), 15_000);

    // The worker dies mid-task.
    process.kill(-workerGroup, 'SIGKILL');
    await until('the worker to be gone', () => !alive(workerGroup!), 5_000);
    assert.equal((await e.store.getTask(second.taskId))!.status, 'running', 'a dead worker records nothing');

    const runner = new FakeRunner(e.store);
    const daemon = e.daemon(runner);
    const orphan = await until('the orphan to be paused', async () => {
      const t = await e.store.getTask(second.taskId);
      return t?.status === 'paused' ? t : undefined;
    }, 10_000);
    assert.ok(daemon.isOwner());
    assert.equal(orphan.terminationReason, undefined);
    assert.ok((await e.store.listEvents(second.taskId)).some((ev) => ev.type === 'orphan_recovered'));
    assert.equal(runner.runs, 0);
  } finally {
    if (workerGroup !== undefined && alive(workerGroup)) process.kill(-workerGroup, 'SIGKILL');
    await e.cleanup();
  }
});

test('the daemon refuses to bind an account to a running task and accepts it while waiting', async () => {
  const e = await env();
  try {
    const client = e.daemon(new FakeRunner(e.store), { claim: false });
    const task = await e.store.createTask(SPEC, e.input());
    await e.store.transitionTask(task.id, 'running', {}, 'queued');
    await assert.rejects(client.bindAccount(task.id, { platform: 'boss', accountKey: 'acct-1', binding: 'explicit' }), (err) => isRuntimeError(err, 'conflict'));
    await e.store.transitionTask(task.id, 'waiting_user', { waitReason: 'account_changed' }, 'running');
    const bound = await client.bindAccount(task.id, { platform: 'boss', accountKey: 'acct-1', binding: 'explicit' });
    assert.equal(bound.account?.accountKey, 'acct-1');
    assert.equal(bound.status, 'waiting_user');
    await assert.rejects(client.bindAccount('missing', { platform: 'boss', accountKey: 'acct-1', binding: 'explicit' }), (err) => err instanceof RuntimeError);
  } finally {
    await e.cleanup();
  }
});
