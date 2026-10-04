// The built runtime as `2ndscreen task` runs it: main.mjs and worker.mjs from
// scripts/build.mjs, real processes, a private ledger in a temporary folder
// and a stand-in 2ndscreen that never touches a screen. It checks what the
// unit tests cannot: the command line exits while the detached worker goes
// on, control calls answer while the worker is busy, concurrent command
// lines start one worker, and a worker that dies mid-task leaves its task
// alone until its processes are proven gone.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { liveWorkers } from '../src/actors.ts';
import { openTaskStore } from '../src/store.ts';
import { CONTROL_ITEM } from '../src/daemon.ts';

const PACKAGE = join(import.meta.dirname, '..');
let runtime: string;
/** The Node that runs the command line (and so the worker it starts). */
let node: string;
const started: number[] = [];

before(() => {
  // TASK_RUNTIME_UNDER_TEST: an installed runtime (scripts/install-task-runtime.sh), run on its own bin/node.
  const installed = process.env.TASK_RUNTIME_UNDER_TEST;
  if (installed) {
    runtime = installed;
    node = join(installed, 'bin/node');
    return;
  }
  runtime = join(mkdtempSync(join(tmpdir(), 'a7-built-')), 'task-runtime');
  node = process.execPath;
  const built = spawnSync(process.execPath, [join(PACKAGE, 'scripts/build.mjs'), runtime], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
});

after(() => {
  // No worker or stand-in command may outlive the tests.
  for (const pid of started) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
});

/**
 * A stand-in 2ndscreen, compiled so that it runs as itself (a script would
 * run as /bin/sh). Its behaviour is read from $FAKE_MODE_FILE on every call:
 * 'hang' never returns, like a GUI command that is stuck; anything else
 * answers that no app runs.
 */
let fakeCli: string;
before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'a7-fake-cli-'));
  writeFileSync(join(dir, 'fake.c'), `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  char mode[16] = {0};
  const char *path = getenv("FAKE_MODE_FILE");
  FILE *f = path ? fopen(path, "r") : NULL;
  if (f) { fread(mode, 1, sizeof mode - 1, f); fclose(f); }
  if (strncmp(mode, "hang", 4) == 0) { sleep(120); return 0; }
  puts("{\\"ok\\":false,\\"error\\":\\"2ndscreen is not running; open 2ndscreen.app first\\"}");
  return 1;
}
`);
  fakeCli = join(dir, '2ndscreen');
  const cc = spawnSync('/usr/bin/cc', ['-O0', '-o', fakeCli, join(dir, 'fake.c')], { encoding: 'utf8' });
  assert.equal(cc.status, 0, cc.stderr);
});

/** A private ledger, and the stand-in 2ndscreen in the given mode. */
function world(mode: 'hang' | 'down') {
  const root = mkdtempSync(join(tmpdir(), 'a7-life-'));
  const modeFile = join(root, 'mode');
  writeFileSync(modeFile, mode);
  const env = {
    ...process.env,
    FAKE_MODE_FILE: modeFile,
    SECONDSCREEN_CLI: fakeCli,
    SECONDSCREEN_SOCKET: join(root, 's.sock'),
    // Never the real app, even when the runtime under test sits inside one: no side instance may start.
    SECONDSCREEN_APP: join(root, 'no-such.app'),
    SECONDSCREEN_TASKS_DIR: join(root, 'tasks'),
    SECONDSCREEN_WORKER_IDLE_MS: '120000',
  };
  return { root, env, tasks: join(root, 'tasks'), out: join(root, 'out'), setMode: (m: string) => writeFileSync(modeFile, m) };
}

type World = ReturnType<typeof world>;

async function cli(w: World, args: string[]): Promise<{ code: number | null; json: any; ms: number; stderr: string }> {
  const t0 = Date.now();
  const child = spawn(node, ['--disable-warning=ExperimentalWarning', join(runtime, 'main.mjs'), ...args], { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise<number | null>((r) => child.once('close', r));
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one line from ${args.join(' ')}: ${stdout}`);
  return { code, json: JSON.parse(lines[0]!), ms: Date.now() - t0, stderr };
}

const run = (w: World, ...more: string[]) =>
  cli(w, ['run', 'boss.collect-resumes', '--job', '前端工程师', '--limit', '2', '--output', w.out, ...more]);

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const status = async (w: World, id: string) => (await cli(w, ['status', id])).json.result.task;
const workers = (w: World) => liveWorkers(join(w.tasks, 'actors'));

async function controlEvents(w: World, id: string): Promise<string[]> {
  const store = await openTaskStore({ path: join(w.tasks, 'tasks.db') });
  try {
    return (await store.listEvents(id, { itemId: CONTROL_ITEM })).map((e) => e.type);
  } finally {
    await store.close();
  }
}

test('run returns at once; the detached worker runs on, answers control calls while busy, pauses, resumes and cancels', async () => {
  const w = world('hang');
  const submitted = await run(w, '--account', 'hr-zhang');
  assert.equal(submitted.code, 0, JSON.stringify(submitted.json));
  assert.equal(submitted.stderr, '', 'the command line writes nothing to stderr');
  const id: string = submitted.json.result.taskId;
  const [worker] = await until('a worker', () => (workers(w).length ? workers(w) : undefined));
  started.push(worker!.pid);
  assert.equal(worker!.pgid, worker!.pid, 'the worker leads its own process group');
  assert.ok(statSync(w.tasks).mode % 0o1000 === 0o700, 'the ledger folder is private');
  assert.ok(statSync(join(w.tasks, 'screenshots')).mode % 0o1000 === 0o700, 'the screenshot folder is private');

  // The command line has exited; the worker holds the task, stuck in a GUI command.
  const running = await until('running', async () => ((await status(w, id)).status === 'running' ? true : undefined));
  assert.ok(running);
  const task = await status(w, id);
  assert.deepEqual(task.account, { platform: 'boss', accountKey: 'hr-zhang', binding: 'explicit' });
  const timed = await cli(w, ['status', id]);
  assert.ok(timed.ms < 2_000, `status answered in ${timed.ms} ms while the worker is busy`);

  const paused = await cli(w, ['pause', id]);
  assert.equal(paused.code, 0);
  assert.ok(paused.ms < 3_000, `pause answered in ${paused.ms} ms`);
  await until('paused', async () => ((await status(w, id)).status === 'paused' ? true : undefined), 5_000);
  const events = await controlEvents(w, id);
  assert.ok(events.indexOf('worker_finished') >= 0 && events.indexOf('worker_finished') < events.lastIndexOf('pause_applied'), events.join(','));

  const resumed = await cli(w, ['resume', id]);
  assert.equal(resumed.code, 0, JSON.stringify(resumed.json));
  await until('running again', async () => ((await status(w, id)).status === 'running' ? true : undefined), 5_000);
  assert.deepEqual(workers(w).map((r) => r.pid), [worker!.pid], 'the same worker took it up again');

  const cancelled = await cli(w, ['cancel', id]);
  assert.equal(cancelled.code, 0);
  assert.ok(['cancelling', 'cancelled'].includes(cancelled.json.result.status));
  await until('cancelled', async () => ((await status(w, id)).status === 'cancelled' ? true : undefined), 5_000);

  // Leaves on SIGTERM and closes its record: nothing of it acts any more.
  process.kill(worker!.pid, 'SIGTERM');
  await until('worker gone', () => (workers(w).length === 0 ? true : undefined), 10_000);
  const record = JSON.parse(readFileSync(join(w.tasks, 'actors', `${worker!.pid}-${Date.parse(worker!.startedAt)}.json`), 'utf8'));
  assert.ok(record.closedAt);
  assert.deepEqual(record.groups, []);
});

test('concurrent command lines start one worker between them', async () => {
  const w = world('down');
  const results = await Promise.all(Array.from({ length: 6 }, () => run(w, '--account', 'hr-zhang')));
  for (const r of results) assert.equal(r.code, 0, JSON.stringify(r.json));
  const live = await until('a worker', () => (workers(w).length ? workers(w) : undefined));
  started.push(...live.map((r) => r.pid));
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(workers(w).length, 1, `one worker, not ${workers(w).length}`);
  const records = spawnSync('/bin/ls', [join(w.tasks, 'actors')], { encoding: 'utf8' }).stdout.trim().split('\n').filter((n) => n.endsWith('.json'));
  assert.equal(records.length, 1, `one worker was ever started: ${records.join(' ')}`);
  for (const pid of live.map((r) => r.pid)) process.kill(pid, 'SIGTERM');
  await until('workers gone', () => (workers(w).length === 0 ? true : undefined), 10_000);
});

test('a worker killed during a GUI command: the takeover stops that exact command, then pauses the task without rerunning it', async () => {
  const w = world('hang');
  const id: string = (await run(w, '--account', 'hr-zhang')).json.result.taskId;
  const [first] = await until('a worker', () => (workers(w).length ? workers(w) : undefined));
  started.push(first!.pid);
  await until('running', async () => ((await status(w, id)).status === 'running' ? true : undefined));
  const record = () => JSON.parse(readFileSync(join(w.tasks, 'actors', `${first!.pid}-${Date.parse(first!.startedAt)}.json`), 'utf8'));
  // The stand-in GUI command hangs in a group of its own (A1 runs commands detached); the
  // runner's spawn report put that exact group in the worker's record.
  const hung = () => spawnSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).stdout.split('\n')
    .map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === fakeCli).map((p) => Number(p[0]));
  const before = await until('the hung command', () => (hung().length ? hung() : undefined));
  started.push(...before);
  const recorded = await until('its group on record', () => (record().groups.some((g: { pgid: number }) => before.includes(g.pgid)) ? true : undefined));
  assert.ok(recorded);
  assert.deepEqual(record().commands, [], 'the announcement ended with the report');
  process.kill(first!.pid, 'SIGKILL');
  await until('worker dead', () => (workers(w).length === 0 ? true : undefined));
  assert.deepEqual(hung(), before, 'its command outlives it');

  // A later command line starts a standby. Once the dead owner's lease runs out it takes
  // over, proves the worker gone, stops the recorded command and only then pauses the task.
  w.setMode('down');
  assert.equal((await status(w, id)).status, 'running');
  const resumed = await cli(w, ['resume', id]);
  assert.equal(resumed.code, 0, JSON.stringify(resumed.json));
  const [standby] = await until('a standby worker', () => (workers(w).length ? workers(w) : undefined));
  started.push(standby!.pid);
  await until('paused as an orphan', async () => ((await status(w, id)).status === 'paused' ? true : undefined), 45_000);
  assert.deepEqual(hung(), [], 'the recorded command was stopped');
  const events = await controlEvents(w, id);
  assert.ok(events.includes('actor_exit_verified'), events.join(','));
  assert.ok(events.indexOf('actor_exit_verified') < events.indexOf('orphan_recovered'), events.join(','));
  assert.equal(events.filter((e) => e === 'worker_started').length, 1, 'it was not rerun');
  process.kill(standby!.pid, 'SIGTERM');
  await until('workers gone', () => (workers(w).length === 0 ? true : undefined), 10_000);
});
