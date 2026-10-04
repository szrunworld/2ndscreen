// Puts the runtime together: where its files live, the skills it can run,
// a control client for the short-lived `2ndscreen task` process, and the
// full worker (session, ledger, procedures, BOSS workflow, vision, bridge,
// runner, daemon) for the background process that owns the tasks.
//
// The command line never runs tasks. It opens the ledger, makes its one
// control call through a daemon that does not claim tasks, makes sure a
// worker is running, and exits. The worker is the only process that drives
// the app; it is started detached so it outlives the command that started it.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createBossResumesWorkflow } from '../../../agents/boss/src/resumes/workflow.ts';
import {
  DEFAULT_PROMOTION,
  RuntimeError,
  assertValid,
  isRuntimeError,
  validateTaskSpec,
  type BossWorkflow,
  type LineProcessSpawner,
  type TaskRunner,
  type TaskSpec,
  type TaskStore,
  type WindowProfile,
} from './contracts.ts';
import { ActorRegistry, VERIFY_KILL_GRACE_MS, liveWorkers, pruneClosedRecords, verifyWorkerStopped } from './actors.ts';
import { createAgentBridge, createLineProcessSpawner } from './adapters/agent-bridge.ts';
import { createLocalVision, type LocalVisionClient } from './adapters/local-vision.ts';
import { createCommandRunner, createSecondScreenAdapter } from './adapters/second-screen.ts';
import { createArtifactStore } from './artifacts.ts';
import { createTaskDaemon, daemonOwnerPid, ensureDaemon, spawnDetachedWorker, type TaskDaemon } from './daemon.ts';
import { createLearner } from './learning.ts';
import { createProcedureEngine } from './procedures.ts';
import { createRecovery } from './recovery.ts';
import { createTaskRunner } from './runner.ts';
import { createSessionManager } from './session.ts';
import { defaultTaskDbPath, openTaskStore } from './store.ts';
import { createTelemetryHub } from './telemetry.ts';

// ---------------------------------------------------------------------------
// Where things are

export interface RuntimePaths {
  /** ~/Library/Application Support/2ndscreen/tasks, or $SECONDSCREEN_TASKS_DIR. Private (0700). */
  tasksDir: string;
  dbPath: string;
  /** Screenshots the session takes; A4 copies what it keeps into the task's staging. */
  screenshotsDir: string;
  /** Records of what each worker started (actors.ts). */
  actorsDir: string;
  /** stdout and stderr of the background worker. */
  workerLog: string;
}

export function runtimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const override = env.SECONDSCREEN_TASKS_DIR;
  if (override !== undefined && override !== '' && !isAbsolute(override))
    throw new RuntimeError('invalid_input', 'SECONDSCREEN_TASKS_DIR must be an absolute directory');
  const tasksDir = override ? resolve(override) : dirname(defaultTaskDbPath(homedir()));
  return {
    tasksDir,
    dbPath: join(tasksDir, 'tasks.db'),
    screenshotsDir: join(tasksDir, 'screenshots'),
    actorsDir: join(tasksDir, 'actors'),
    workerLog: join(tasksDir, 'worker.log'),
  };
}

/** Creates the runtime's directories readable by the user alone, tightening any that exist. */
export function preparePrivateDirs(paths: RuntimePaths): void {
  for (const dir of [paths.tasksDir, paths.screenshotsDir, paths.actorsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
}

/** What the runtime needs from its surroundings; every path absolute. */
export interface RuntimeConfig {
  paths: RuntimePaths;
  /** The 2ndscreen executable: screens, the agent bridge and the vision helper. */
  cli: string;
  /** Control socket of the 2ndscreen side instance tasks use. */
  socket: string;
  /** 2ndscreen.app, to start that side instance when it is not running. */
  app?: string;
  skillsDir: string;
  /** Node running this runtime, and the worker entry it starts. */
  node: string;
  workerEntry: string;
}

/**
 * Reads the configuration from the environment `2ndscreen task` sets
 * (SECONDSCREEN_CLI) and the files next to the entry point. `entryDir` is
 * the directory of main.mjs (installed) or of src/ (development).
 */
export function resolveConfig(entryDir: string, env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const absolute = (name: string): string | undefined => {
    const value = env[name];
    if (value === undefined || value === '') return undefined;
    if (!isAbsolute(value)) throw new RuntimeError('invalid_input', `${name} must be an absolute path`);
    return value;
  };
  const installed = existsSync(join(entryDir, 'worker.mjs'));
  const cli = absolute('SECONDSCREEN_CLI');
  if (!cli) throw new RuntimeError('capability_missing', 'SECONDSCREEN_CLI is not set; run the runtime through `2ndscreen task`');
  // Installed at <app>/Contents/Resources/task-runtime: the app is three levels up.
  const bundled = resolve(entryDir, '../../..');
  const app = absolute('SECONDSCREEN_APP') ?? (installed && bundled.endsWith('.app') ? bundled : undefined);
  const skillsDir = absolute('SECONDSCREEN_SKILLS_DIR') ?? (installed ? join(entryDir, 'skills') : resolve(entryDir, '../../../skills'));
  return {
    paths: runtimePaths(env),
    cli,
    socket: absolute('SECONDSCREEN_SOCKET') ?? join(homedir(), 'Library/Caches/2ndscreen/boss.sock'),
    ...(app ? { app } : {}),
    skillsDir,
    node: process.execPath,
    workerEntry: installed ? join(entryDir, 'worker.mjs') : join(entryDir, 'worker.ts'),
  };
}

// ---------------------------------------------------------------------------
// Skills

export interface SkillPackage {
  dir: string;
  spec: TaskSpec;
  profile: WindowProfile;
}

/** Workflows this build can run, by TaskSpec.workflow. */
const WORKFLOWS: Readonly<Record<string, true>> = { 'boss-resumes-v1': true };

function validateProfile(raw: unknown, where: string): WindowProfile {
  const p = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new RuntimeError('invalid_input', `${where}: not an object`);
  const allowed = new Set(['id', 'version', 'logicalWidth', 'logicalHeight', 'bundleId', 'appVersion', 'locale']);
  for (const key of Object.keys(p)) if (!allowed.has(key)) errors.push(`unknown field ${key}`);
  if (typeof p.id !== 'string' || p.id === '') errors.push('id must be a string');
  for (const key of ['version', 'logicalWidth', 'logicalHeight'] as const)
    if (!Number.isInteger(p[key]) || (p[key] as number) < 1) errors.push(`${key} must be a positive integer`);
  if (typeof p.bundleId !== 'string' || p.bundleId === '' || p.bundleId.includes(':')) errors.push('bundleId must be a bundle id');
  if (errors.length) throw new RuntimeError('invalid_input', `${where}: ${errors.join('; ')}`, { errors });
  return p as unknown as WindowProfile;
}

/** Every skill under `skillsDir` with a task.json, checked in full. A broken skill fails the load. */
export function loadSkills(skillsDir: string): Map<string, SkillPackage> {
  const skills = new Map<string, SkillPackage>();
  let names: string[];
  try {
    names = readdirSync(skillsDir).sort();
  } catch {
    throw new RuntimeError('capability_missing', `no skills at ${skillsDir}`);
  }
  for (const name of names) {
    const dir = join(skillsDir, name);
    const taskJson = join(dir, 'task.json');
    if (!existsSync(taskJson)) continue;
    const spec = assertValid(validateTaskSpec(JSON.parse(readFileSync(taskJson, 'utf8'))), `${taskJson}`);
    if (!WORKFLOWS[spec.workflow]) throw new RuntimeError('capability_missing', `${taskJson}: workflow ${spec.workflow} is not in this build`);
    const profilePath = join(dir, 'profiles', 'macos', `${spec.windowProfile}.json`);
    const profile = validateProfile(JSON.parse(readFileSync(profilePath, 'utf8')), profilePath);
    if (profile.id !== spec.windowProfile) throw new RuntimeError('invalid_input', `${profilePath}: id is not ${spec.windowProfile}`);
    if (profile.bundleId !== spec.application) throw new RuntimeError('invalid_input', `${profilePath}: bundleId is not ${spec.application}`);
    if (skills.has(spec.id)) throw new RuntimeError('invalid_input', `skill ${spec.id} is defined twice`);
    skills.set(spec.id, { dir, spec, profile });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// The command line's side

export interface ControlClient {
  control: TaskDaemon;
  /** Starts the background worker unless one owns the ledger already. */
  ensureWorker(): Promise<{ started: boolean; pid?: number }>;
  close(): Promise<void>;
}

/** The worker command, as the CLI starts it. */
export function workerCommand(config: RuntimeConfig): { command: string; args: string[]; env: Record<string, string>; logPath: string } {
  const env: Record<string, string> = {
    SECONDSCREEN_CLI: config.cli,
    SECONDSCREEN_SOCKET: config.socket,
    SECONDSCREEN_TASKS_DIR: config.paths.tasksDir,
    SECONDSCREEN_SKILLS_DIR: config.skillsDir,
  };
  if (config.app) env.SECONDSCREEN_APP = config.app;
  // Development runs the TypeScript entry through this package's tsx; installs run the built worker.mjs.
  const quiet = '--disable-warning=ExperimentalWarning'; // node:sqlite's, on Node 22
  const args = config.workerEntry.endsWith('.ts') ? [quiet, '--import', import.meta.resolve('tsx'), config.workerEntry] : [quiet, config.workerEntry];
  return { command: config.node, args, env, logPath: config.paths.workerLog };
}

export async function openControlClient(config: RuntimeConfig): Promise<ControlClient> {
  preparePrivateDirs(config.paths);
  const skills = loadSkills(config.skillsDir);
  const store = await openTaskStore({ path: config.paths.dbPath });
  // This process exits right after its call: it never claims or runs a task.
  const control = createTaskDaemon({ store, runner: refusingRunner, specs: (id) => skills.get(id)?.spec, claim: false });
  return {
    control,
    ensureWorker: () => ensureWorker(store, config),
    async close() {
      await control.shutdown();
      await store.close();
    },
  };
}

function processAlive(pid: number): boolean {
  return processExists(pid) !== false;
}

/** true or false when the system says, undefined when it will not. */
function processExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined;
  }
}

/** Held while one command line starts a worker, so concurrent commands start one between them. */
export const SPAWN_LOCK_SCOPE = '2ndscreen.task-spawn:*';

/**
 * Makes sure a worker owns the ledger, starting one when none does. Command
 * lines that race take turns through a short lease, so they start one worker
 * between them: the first starts it and waits until it holds the daemon
 * lease; the next finds it.
 *
 * After a crash the daemon lease names a worker that is gone, and nobody can
 * take it over until it runs out. Then a standby worker is started without
 * waiting: it takes the lease once it expires, and unless some worker is
 * already alive (a live, unclosed actor record), in which case that one will.
 */
async function ensureWorker(store: TaskStore, config: RuntimeConfig): Promise<{ started: boolean; pid?: number }> {
  const readyTimeoutMs = 10_000;
  const deadline = Date.now() + readyTimeoutMs + 5_000;
  for (;;) {
    let lock;
    try {
      lock = await store.acquireLease({ scopeKey: SPAWN_LOCK_SCOPE, holder: 'runtime', ownerPid: process.pid, ttlMs: readyTimeoutMs + 5_000 });
    } catch (error) {
      if (!isRuntimeError(error, 'lease_held') || Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      const live = liveWorkers(config.paths.actorsDir);
      const owner = await daemonOwnerPid(store);
      if (owner !== undefined && live.some((w) => w.pid === owner)) return { started: false };
      if (live.length > 0) return { started: false }; // starting, or waiting to take over: it will own the ledger
      if (owner === undefined) {
        const result = await ensureDaemon(store, workerCommand(config), { readyTimeoutMs });
        return result.started ? { started: true, pid: result.pid } : { started: false };
      }
      // The lease names a process with no worker record. Unless that process is certainly gone, it may
      // still be the owner (an unknown is not a death): start nothing.
      if (processExists(owner) !== false) return { started: false };
      // The owner is gone and its lease has not run out yet: start the worker that takes over then.
      const pid = await spawnDetachedWorker(workerCommand(config));
      // It counts as started only once its own record shows it running.
      for (const until = Date.now() + readyTimeoutMs; Date.now() < until; ) {
        if (liveWorkers(config.paths.actorsDir).some((w) => w.pid === pid)) return { started: true, pid };
        if (processExists(pid) === false) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new RuntimeError('io', `a standby worker (pid ${pid}) did not come up; see ${config.paths.workerLog}`, { pid });
    } finally {
      await store.releaseLease(lock.leaseId).catch(() => undefined);
    }
  }
}

const refusingRunner: TaskRunner = {
  run: () => Promise.reject(new RuntimeError('conflict', 'a control client does not run tasks')),
};

// ---------------------------------------------------------------------------
// The worker

export interface Worker {
  daemon: TaskDaemon;
  store: TaskStore;
  registry: ActorRegistry;
  /** Stop the daemon (tasks become paused), then every helper, then the ledger. */
  close(): Promise<void>;
}

export interface WorkerOptions {
  /** Replaces the A5 spawner (tests); the registry still wraps it. */
  spawn?: LineProcessSpawner;
  /** Replaces the workflow for a skill (tests). */
  workflow?: (spec: TaskSpec) => BossWorkflow;
  /** Daemon timing, for tests. */
  daemon?: { pollMs?: number; leaseTtlMs?: number; ackWaitMs?: number };
}

export async function startWorker(config: RuntimeConfig, options: WorkerOptions = {}): Promise<Worker> {
  preparePrivateDirs(config.paths);
  const skills = loadSkills(config.skillsDir);
  // Screenshots of workers that are gone are not evidence of anything now; A4 keeps its own copies.
  for (const name of readdirSync(config.paths.screenshotsDir)) {
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid === process.pid || !processAlive(pid)) rmSync(join(config.paths.screenshotsDir, name), { recursive: true, force: true });
  }
  // A worker of its own: another worker may be starting at the same time and lose the daemon lease.
  const screenshotDir = join(config.paths.screenshotsDir, String(process.pid));
  mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
  pruneClosedRecords(config.paths.actorsDir, 7 * 24 * 60 * 60 * 1000);
  const store = await openTaskStore({ path: config.paths.dbPath });
  let registry: ActorRegistry | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let vision: LocalVisionClient | undefined;
  /** What was acquired, given back in reverse; also after a failed start. */
  const release = async () => {
    await vision?.close().catch(() => undefined);
    stopHeartbeat?.();
    registry?.close();
    await store.close().catch(() => undefined);
    rmSync(screenshotDir, { recursive: true, force: true });
  };
  let daemon: TaskDaemon;
  try {
    // Recorded before the daemon can start a task: every actor of this worker is on file.
    registry = ActorRegistry.create(config.paths.actorsDir);
    const spawn = registry.wrap(options.spawn ?? createLineProcessSpawner());
    stopHeartbeat = registry.startHeartbeat();

    vision = createLocalVision({ helper: config.cli, spawn });
    const adapter = createSecondScreenAdapter({
      cli: config.cli,
      socket: config.socket,
      ...(config.app ? { app: config.app } : {}),
      // Every 2ndscreen command leads its own group: announced in the actor record while it runs.
      run: registry.wrapRunner(createCommandRunner()),
      screenshotDir,
    });
    const hub = createTelemetryHub();
    // The bridge is made only when a unit needs exploration: stable and scripted runs never start a model.
    const explorer = async () => createAgentBridge({ cli: config.cli, spawn });

    const runners = new Map<string, TaskRunner>();
    for (const { spec, profile } of skills.values()) {
      const sessions = createSessionManager({
        adapter,
        leases: store,
        policy: { submitAllowed: spec.submitAllowed, foregroundAllowed: spec.foregroundAllowed },
        vision,
      });
      // No telemetry on the engine: the runner counts replays itself.
      const engine = createProcedureEngine({ repository: store, rule: { ...DEFAULT_PROMOTION, promoteAfterSuccesses: spec.learning.promoteAfterSuccesses } });
      const learner = createLearner({ repository: store });
      const recovery = createRecovery({ engine, learner, explorer, telemetry: hub.shared });
      const workflow = options.workflow?.(spec) ?? createBossResumesWorkflow({ vision, telemetry: hub.shared });
      runners.set(
        spec.id,
        createTaskRunner({
          store,
          sessions,
          artifacts: (task) => createArtifactStore({ outputDir: task.input.outputDir, taskId: task.id }),
          engine,
          learner,
          recovery,
          workflow,
          spec,
          profile,
          telemetry: hub.forTask,
        }),
      );
    }
    const runner: TaskRunner = {
      async run(taskId, signal) {
        const task = await store.getTask(taskId);
        const chosen = task && runners.get(task.skillId);
        if (!chosen) throw new RuntimeError('not_found', `no runner for task ${taskId}`);
        return chosen.run(taskId, signal);
      },
    };

    daemon = createTaskDaemon({
      store,
      runner,
      specs: (id) => skills.get(id)?.spec,
      // A worker whose exit no daemon recorded: proven stopped only from its actor record.
      verifyActorExit: (worker, { signal }) => verifyWorkerStopped(config.paths.actorsDir, worker, { signal }),
      // Room for a SIGTERM grace and the SIGKILL rounds of each recorded group, and the process scans.
      verifyTimeoutMs: 4 * VERIFY_KILL_GRACE_MS,
      ...options.daemon,
    });
  } catch (error) {
    await release();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    daemon,
    store,
    registry: registry!,
    close() {
      closing ??= (async () => {
        await daemon.shutdown();
        await release();
      })();
      return closing;
    },
  };
}
