// The generic runtime: no business package installed (roadmap C01a). The
// real control client, worker and agent hosting start, answer and stop with
// no skills directory at all; an explicit but missing or broken skills
// configuration is an error; a task left by a business package this runtime
// does not carry stays as it is, with the reason on record.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHostingState } from '../src/agent-hosting.ts';
import { agentDataPaths, prepareAgentDataDir } from '../src/agent-ledgers.ts';
import { createWorkerAgentHosting, loadSkills, openControlClient, resolveConfig, startWorker, workerCommand } from '../src/bootstrap.ts';
import { CONTROL_ITEM } from '../src/daemon.ts';
import { isRuntimeError } from '../src/contracts.ts';
import { openTaskStore } from '../src/store.ts';
import { NO_WORKFLOWS, createWorkflowRegistry, legacyWorkflows } from '../src/workflows.ts';

const REPO_SKILLS = join(import.meta.dirname, '../../../skills');

/** A private world whose default skills directory does not exist. */
function world(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'generic-runtime-'));
  // resolveConfig takes the default skills directory three levels above the entry: absent here.
  const entryDir = join(root, 'runtime/packages/task-runtime/src');
  mkdirSync(entryDir, { recursive: true });
  const config = resolveConfig(entryDir, {
    SECONDSCREEN_CLI: '/usr/bin/true',
    SECONDSCREEN_SOCKET: join(root, 'no.sock'),
    SECONDSCREEN_TASKS_DIR: join(root, 'tasks'),
    ...env,
  });
  return { root, config, defaultSkills: join(root, 'runtime/skills') };
}

test('with no skills directory the control client opens, answers and closes, and knows no skill', async () => {
  const { config, defaultSkills } = world();
  assert.equal(config.skillsDir, defaultSkills);
  assert.equal(config.skillsDirExplicit, false);
  const client = await openControlClient(config, { workflows: NO_WORKFLOWS });
  try {
    assert.equal(client.builtinTaskType('boss.collect-resumes'), undefined);
    await assert.rejects(
      client.control.submit('boss.collect-resumes', { job: 'x', requestedCount: 1, outputDir: join(config.paths.tasksDir, 'out'), source: 'conversations', captureMode: 'available' }),
      (e: unknown) => isRuntimeError(e, 'not_found'),
    );
    await assert.rejects(client.control.status('nope'), (e: unknown) => isRuntimeError(e, 'not_found'));
    // The worker it would start resolves the same default itself: no explicit directory is handed on.
    assert.equal(workerCommand(config).env.SECONDSCREEN_SKILLS_DIR, undefined);
  } finally {
    await client.close();
  }
});

test('with no skills directory the worker starts, owns the ledger, hosts agents and stops', async () => {
  const { config } = world();
  const worker = await startWorker(config, { workflows: NO_WORKFLOWS, daemon: { pollMs: 50 } });
  const log: string[] = [];
  const hosting = createWorkerAgentHosting(config, worker, (line) => log.push(line));
  try {
    for (let i = 0; i < 50 && !worker.daemon.isOwner(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(worker.daemon.isOwner(), true, 'the worker takes the daemon lease');
    const paths = agentDataPaths(config.paths.tasksDir);
    // No agent config at all: hosting waits and says so, instead of failing the worker.
    await hosting.tick();
    assert.equal(readHostingState(paths)?.state, 'waiting');
    assert.match(String(readHostingState(paths)?.reason), /no agent config/);
    // An agent config that registers nothing hosts nothing, and that is hosting.
    prepareAgentDataDir(paths);
    writeFileSync(paths.config, JSON.stringify({ agents: [], providers: {} }) + '\n');
    for (let i = 0; i < 10 && readHostingState(paths)?.state !== 'hosting'; i++) await hosting.tick();
    assert.equal(readHostingState(paths)?.state, 'hosting', log.join('\n'));
    assert.equal(hosting.host?.agents.length, 0);
    assert.equal(await hosting.busy(), false);
    assert.deepEqual(await worker.store.listTasks(), []);
  } finally {
    await hosting.stop();
    await worker.close();
  }
  assert.equal(readHostingState(agentDataPaths(config.paths.tasksDir))?.state, 'stopped', log.join('\n'));
});

test('an empty skills directory is the same as none', async () => {
  const { config, defaultSkills } = world();
  mkdirSync(defaultSkills, { recursive: true });
  mkdirSync(join(defaultSkills, 'notes'));
  writeFileSync(join(defaultSkills, 'notes', 'README.md'), 'no task.json here\n');
  assert.equal(loadSkills(config.skillsDir).size, 0);
  const worker = await startWorker(config, { workflows: NO_WORKFLOWS });
  await worker.close();
});

test('an explicit skills directory that does not exist is a configuration error, not an empty runtime', () => {
  const { root } = world();
  const missing = join(root, 'elsewhere');
  const { config } = world({ SECONDSCREEN_SKILLS_DIR: missing });
  assert.equal(config.skillsDirExplicit, true);
  assert.throws(() => loadSkills(config.skillsDir, { explicit: true }), (e: unknown) => isRuntimeError(e, 'invalid_input') && /does not exist/.test((e as Error).message));
  assert.equal(workerCommand(config).env.SECONDSCREEN_SKILLS_DIR, missing, 'an explicit choice is handed to the worker');
  assert.rejects(openControlClient(config, { workflows: NO_WORKFLOWS }), (e: unknown) => isRuntimeError(e, 'invalid_input'));
});

test('a directory that cannot be read is an error', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads anything');
  const { root } = world();
  const locked = join(root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    assert.throws(() => loadSkills(locked), (e: unknown) => isRuntimeError(e, 'invalid_input') && /cannot read/.test((e as Error).message));
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('a broken package fails the load; a package naming an unregistered workflow fails by name', () => {
  const { root } = world();
  const dir = join(root, 'skills', 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.json'), '{ not json');
  assert.throws(() => loadSkills(join(root, 'skills')), (e: unknown) => isRuntimeError(e, 'invalid_input'));
  // The real BOSS package loads only where its workflow is registered.
  assert.throws(() => loadSkills(REPO_SKILLS), (e: unknown) => isRuntimeError(e, 'capability_missing') && /not registered/.test((e as Error).message));
  assert.throws(() => loadSkills(REPO_SKILLS, { workflows: createWorkflowRegistry({ other: () => ({}) as any }) }), (e: unknown) => isRuntimeError(e, 'capability_missing'));
});

test('the legacy registry still loads the BOSS package, by explicit opt-in', async () => {
  const skills = loadSkills(REPO_SKILLS, { workflows: await legacyWorkflows() });
  assert.ok(skills.has('boss.collect-resumes'));
});

test('a task of a package this runtime does not carry is kept, not claimed or failed, with the reason on record once', async () => {
  // Submitted where the BOSS package is installed...
  const { root, config: withBoss } = world({ SECONDSCREEN_SKILLS_DIR: REPO_SKILLS });
  const client = await openControlClient(withBoss);
  let taskId: string;
  try {
    ({ taskId } = await client.control.submit('boss.collect-resumes', { job: '前端', requestedCount: 1, outputDir: join(root, 'out'), source: 'conversations', captureMode: 'available' }, {
      account: { platform: 'boss', accountKey: 'k', binding: 'explicit' },
    }));
  } finally {
    await client.close();
  }
  // ...then a generic worker on the same ledger, without it.
  const generic = resolveConfig(join(root, 'runtime/packages/task-runtime/src'), {
    SECONDSCREEN_CLI: '/usr/bin/true',
    SECONDSCREEN_SOCKET: join(root, 'no.sock'),
    SECONDSCREEN_TASKS_DIR: withBoss.paths.tasksDir,
  });
  const worker = await startWorker(generic, { workflows: NO_WORKFLOWS, daemon: { pollMs: 30 } });
  try {
    for (let i = 0; i < 50 && !worker.daemon.isOwner(); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300)); // several ticks
    const task = await worker.store.getTask(taskId);
    assert.equal(task?.status, 'queued', 'neither started nor failed');
    const control = (await worker.store.listEvents(taskId, { itemId: CONTROL_ITEM })).filter((e) => e.type === 'skill_missing');
    assert.equal(control.length, 1, 'the reason is recorded once, not every tick');
    assert.match(String(control[0]!.detail?.reason), /no package for skill boss.collect-resumes/);
  } finally {
    await worker.close();
  }
  rmSync(root, { recursive: true, force: true });
});
