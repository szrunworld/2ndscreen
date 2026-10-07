// The generic runtime as scripts/build.mjs --generic ships it (roadmap
// C01b): no business module in the bundles, no skills beside them, and the
// built command line and worker really start, host an empty agent config,
// answer and stop with no business package installed.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const PACKAGE = join(import.meta.dirname, '..');
let runtime: string;
const node = process.execPath;
let build: { variant: string; inputs: string[]; excluded: { from: string; module: string }[]; files: { path: string }[] };

before(() => {
  runtime = join(mkdtempSync(join(tmpdir(), 'generic-built-')), 'task-runtime');
  const built = spawnSync(node, [join(PACKAGE, 'scripts/build.mjs'), runtime, '--generic'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  build = JSON.parse(readFileSync(join(runtime, 'build.json'), 'utf8'));
});

test('the generic bundles reach no business module and ship no skills', () => {
  assert.equal(build.variant, 'generic');
  assert.deepEqual(build.inputs.filter((p) => p.startsWith('src/boss/')), []);
  assert.ok(build.inputs.includes('src/bootstrap.ts') && build.inputs.includes('src/worker.ts'), 'the runtime itself is in');
  assert.deepEqual(build.excluded.map((e) => e.module), ['./boss/workflow.ts']);
  assert.deepEqual(build.files.map((f) => f.path), ['main.mjs', 'worker.mjs']);
  assert.equal(existsSync(join(runtime, 'skills')), false);
});

test('the legacy build still carries the business package', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'legacy-built-')), 'task-runtime');
  const built = spawnSync(node, [join(PACKAGE, 'scripts/build.mjs'), out], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const legacy = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
  assert.equal(legacy.variant, 'legacy');
  assert.ok(legacy.inputs.some((p: string) => p === 'src/boss/workflow.ts'));
  assert.ok(existsSync(join(out, 'skills/boss-resumes/task.json')));
});

const started: number[] = [];
after(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
});

function world() {
  const root = mkdtempSync(join(tmpdir(), 'generic-world-'));
  const env = {
    ...process.env,
    SECONDSCREEN_CLI: '/usr/bin/true',
    SECONDSCREEN_SOCKET: join(root, 's.sock'),
    SECONDSCREEN_APP: join(root, 'no-such.app'),
    SECONDSCREEN_TASKS_DIR: join(root, 'tasks'),
    SECONDSCREEN_WORKER_IDLE_MS: '120000',
  };
  delete (env as Record<string, string | undefined>).SECONDSCREEN_SKILLS_DIR;
  return { root, env, tasks: join(root, 'tasks') };
}

async function cli(env: NodeJS.ProcessEnv, args: string[]): Promise<any> {
  const child = spawn(node, ['--disable-warning=ExperimentalWarning', join(runtime, 'main.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  await new Promise<number | null>((r) => child.once('close', r));
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one line from ${args.join(' ')}: ${stdout} ${stderr}`);
  return JSON.parse(lines[0]!);
}

async function until<T>(what: string, probe: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('the built generic runtime starts its worker, hosts an empty agent config, answers and stops', async () => {
  const w = world();
  const status = await cli(w.env, ['host', 'status']);
  assert.equal(status.ok, true);
  assert.equal(status.result.running, false);

  // No business package: the legacy skill is unknown, by name, not a crash.
  const run = await cli(w.env, ['run', 'boss.collect-resumes', '--job', 'x', '--limit', '1', '--output', join(w.root, 'out')]);
  assert.equal(run.ok, false);
  assert.equal(run.error.code, 'not_found');

  mkdirSync(join(w.tasks, 'agents'), { recursive: true, mode: 0o700 });
  writeFileSync(join(w.tasks, 'agents', 'config.json'), JSON.stringify({ agents: [], providers: {} }) + '\n', { mode: 0o600 });
  const start = await cli(w.env, ['host', 'start']);
  assert.equal(start.ok, true, JSON.stringify(start));
  if (start.result?.pid) started.push(start.result.pid);

  const running = await until('the host to run', async () => {
    const s = await cli(w.env, ['host', 'status']);
    return s.result.running === true ? s : undefined;
  });
  assert.equal(running.result.running, true);
  assert.equal(existsSync(join(w.tasks, 'tasks.db')), true, 'the worker opened the ledger');

  const stop = await cli(w.env, ['host', 'stop']);
  assert.equal(stop.ok, true, JSON.stringify(stop));
  await until('the host to stop', async () => {
    const s = await cli(w.env, ['host', 'status']);
    return s.result.running === false ? s : undefined;
  });
  const log = readFileSync(join(w.tasks, 'worker.log'), 'utf8');
  assert.match(log, /started; ledger/);
  assert.doesNotMatch(log, /uncaught|unhandled/);
});
