// Task control and the worker that runs tasks. The ledger is the only
// channel between processes: a CLI that exits right after `run` leaves its
// task queued in the store, and the one daemon that holds the daemon lease
// picks it up, runs it, and notices pause and cancel requests written by any
// other process. Control calls are short transactions and never wait for GUI
// work; the GUI belongs to the runner's session, a separate lock.
//
// Ownership: a daemon runs tasks only while it holds the daemon lease (one
// per machine and ledger), renewed by a heartbeat. Losing it stops its
// workers. On taking ownership it finds orphans — tasks left running by a
// worker that is gone — and moves them to paused, resumable, never to a
// success. A daemon that cannot get the lease only serves control calls.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import {
  RuntimeError,
  TERMINAL_TASK_STATUSES,
  assertValid,
  emptyUsage,
  isRuntimeError,
  leaseScopeKey,
  systemClock,
  validateCollectResumesInput,
  type AccountScope,
  type ArtifactRecord,
  type Clock,
  type CollectResumesInput,
  type ProcedureV2,
  type SessionLease,
  type TaskControl,
  type TaskEvent,
  type TaskRecord,
  type TaskRunner,
  type TaskSpec,
  type TaskStatus,
  type TaskStatusReport,
  type TaskStore,
  type Usage,
} from './contracts.ts';
import { join } from 'node:path';
import { accountProblem } from './runner.ts';
import { parseUsage } from './telemetry.ts';

/** The lease scope that makes one daemon the owner of the ledger's tasks. */
export const DAEMON_LEASE_SCOPE = leaseScopeKey('2ndscreen.task-daemon');

export const DAEMON_DEFAULTS = {
  /** Daemon lease; renewed every third of it. */
  leaseTtlMs: 15_000,
  /** How often the owner looks at the ledger for new tasks and requests from other processes. */
  pollMs: 500,
} as const;

/** Optional additions to the contract's dependencies; all have defaults. */
export interface TaskDaemonOptions {
  /** The process that holds the daemon lease; default process.pid. */
  ownerPid?: number;
  leaseTtlMs?: number;
  pollMs?: number;
  /** false: only serve control calls (e.g. inside a CLI that exits); never run tasks. Default true. */
  claim?: boolean;
  /**
   * How long pause and cancel wait for this process's actor to stop before
   * answering, so the answer can already say paused or cancelled; default
   * 1000 ms. They never claim stopped before the actor has.
   */
  ackWaitMs?: number;
}

/** What the daemon offers beyond the contract's TaskControl. */
export interface TaskDaemon extends TaskControl {
  /**
   * Bind a BOSS account to a task that is not running (queued, paused or
   * waiting_user) — the explicit binding the runner requires when the window
   * shows no readable account. Refused once the task holds candidates of
   * another account.
   */
  bindAccount(taskId: string, account: AccountScope): Promise<TaskRecord>;
  /** Stop scheduling, stop workers (their tasks become paused) and give up the daemon lease. */
  shutdown(): Promise<void>;
  /** Whether this daemon holds the daemon lease right now. */
  isOwner(): boolean;
}

/** Serializes the state changes this process makes to one task; GUI work never holds it. */
class StateLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(taskId, tail);
    void tail.then(() => {
      if (this.tails.get(taskId) === tail) this.tails.delete(taskId);
    });
    return next;
  }
}

interface Worker {
  taskId: string;
  controller: AbortController;
  done: Promise<void>;
  /** Why it was told to stop; decides what settle writes once the actor has exited. */
  stop?: 'pause' | 'cancel' | 'shutdown' | 'lease_lost';
}

export function createTaskDaemon(
  deps: {
    store: TaskStore;
    runner: TaskRunner;
    specs: (skillId: string) => TaskSpec | undefined;
    clock?: Clock;
  } & TaskDaemonOptions,
): TaskDaemon {
  const { store, runner, specs } = deps;
  const clock = deps.clock ?? systemClock;
  const ownerPid = deps.ownerPid ?? process.pid;
  const leaseTtlMs = deps.leaseTtlMs ?? DAEMON_DEFAULTS.leaseTtlMs;
  const pollMs = deps.pollMs ?? DAEMON_DEFAULTS.pollMs;
  const claim = deps.claim ?? true;
  const ackWaitMs = deps.ackWaitMs ?? 1_000;
  const locks = new StateLocks();
  const workers = new Map<string, Worker>();
  let lease: SessionLease | undefined;
  let stopped = false;
  let ticking: Promise<void> | undefined;
  let tickAgain = false;

  const now = () => clock.now().toISOString();
  const event = (taskId: string, type: string, detail?: Record<string, unknown>) =>
    store.appendEvent({ taskId, type, at: now(), ...(detail ? { detail } : {}) });

  /** Compare-and-set transition; retried against the status it finds when another writer got there first. */
  async function move(taskId: string, decide: (task: TaskRecord) => { to: TaskStatus; patch?: Parameters<TaskStore['transitionTask']>[2] } | TaskRecord): Promise<TaskRecord> {
    for (let attempt = 0; ; attempt++) {
      const task = await store.getTask(taskId);
      if (!task) throw new RuntimeError('not_found', `no task ${taskId}`);
      const decision = decide(task);
      if (!('to' in decision)) return decision;
      try {
        return await store.transitionTask(taskId, decision.to, decision.patch ?? {}, task.status);
      } catch (error) {
        if (!isRuntimeError(error, 'conflict') || attempt >= 4) throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // ownership

  async function holdLease(): Promise<boolean> {
    if (lease) {
      try {
        lease = await store.renewLease(lease.leaseId, leaseTtlMs);
        return true;
      } catch {
        // Expired or taken: this daemon is no longer the owner.
        lease = undefined;
        await stopWorkers('lease_lost');
        return false;
      }
    }
    try {
      lease = await store.acquireLease({ scopeKey: DAEMON_LEASE_SCOPE, holder: 'runtime', ownerPid, ttlMs: leaseTtlMs });
      await recoverOrphans();
      return true;
    } catch (error) {
      if (isRuntimeError(error, 'lease_held')) return false;
      throw error;
    }
  }

  /**
   * Tasks left running whose worker is gone. A task is running before its
   * worker starts (the daemon writes `worker_started` right after moving it
   * to running), so only a running task with a worker start after its last
   * move to running, and no worker here, was orphaned.
   */
  async function recoverOrphans(): Promise<void> {
    for (const task of await store.listTasks({ status: ['running'] })) {
      if (workers.has(task.id) || !(await workerStartedSinceRunning(task.id))) continue;
      await locks.run(task.id, async () => {
        try {
          await store.transitionTask(task.id, 'paused', { error: { code: 'lease_held', message: 'the worker running this task stopped without finishing it; resume to continue' } }, 'running');
          await event(task.id, 'orphan_recovered', { ownerPid });
        } catch (error) {
          if (!isRuntimeError(error, 'conflict')) throw error;
        }
      });
    }
  }

  async function workerStartedSinceRunning(taskId: string): Promise<boolean> {
    const isRunningMove = (e: TaskEvent) => e.type === 'task_status' && e.detail?.to === 'running';
    const scan = (events: TaskEvent[]): boolean | undefined => {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.type === 'worker_started') return true;
        if (isRunningMove(events[i]!)) return false;
      }
      return undefined;
    };
    return scan(await store.listEvents(taskId, { limit: 200 })) ?? scan(await store.listEvents(taskId)) ?? false;
  }

  // -------------------------------------------------------------------------
  // scheduling

  function kick(): void {
    if (stopped || !claim) return;
    if (ticking) {
      tickAgain = true;
      return;
    }
    ticking = (async () => {
      do {
        tickAgain = false;
        try {
          await tick();
        } catch {
          // A busy or failing ledger is retried on the next poll.
        }
      } while (tickAgain && !stopped);
    })().finally(() => {
      ticking = undefined;
    });
  }

  async function tick(): Promise<void> {
    if (stopped || !(await holdLease())) return;
    const active = await store.listTasks({ status: ['queued', 'running', 'cancelling', 'paused', 'waiting_user'] });
    for (const task of active) {
      const worker = workers.get(task.id);
      if (worker) {
        // Cancelled or moved by someone else: stop the actor.
        if (task.status === 'cancelling') stopWorker(worker, 'cancel');
        else if (task.status !== 'running') stopWorker(worker, 'pause');
        else if (await pauseRequested(task.id)) stopWorker(worker, 'pause');
        continue;
      }
      if (task.status === 'running' && (await pauseRequested(task.id))) {
        // Asked to pause with no actor running it: nothing to wait for.
        await locks.run(task.id, () => store.transitionTask(task.id, 'paused', {}, 'running').catch(ignoreConflict));
        continue;
      }
      if (task.status === 'cancelling') {
        // No actor of this daemon runs it, and only the owner runs tasks: confirm.
        await locks.run(task.id, () => store.transitionTask(task.id, 'cancelled', { terminationReason: 'cancelled' }, 'cancelling').catch(ignoreConflict));
      } else if (task.status === 'running' && (await workerStartedSinceRunning(task.id))) {
        await recoverOrphans();
      }
    }
    // One task at a time: tasks of one skill drive the same app.
    if (workers.size > 0 || stopped) return;
    const next = active.find((t) => t.status === 'running' && !workers.has(t.id)) ?? active.find((t) => t.status === 'queued');
    if (next) await start(next);
  }

  async function start(task: TaskRecord): Promise<void> {
    const started = await locks.run(task.id, async () => {
      try {
        if (task.status === 'queued') await store.transitionTask(task.id, 'running', { phase: 'preparing' }, 'queued');
        else if ((await store.getTask(task.id))?.status !== 'running') return false;
        await event(task.id, 'worker_started', { ownerPid });
        return true;
      } catch (error) {
        if (isRuntimeError(error, 'conflict')) return false;
        throw error;
      }
    });
    if (!started || stopped) return;
    const controller = new AbortController();
    const worker: Worker = {
      taskId: task.id,
      controller,
      done: runner
        .run(task.id, controller.signal)
        .then(
          () => undefined,
          async (error: unknown) => {
            // The runner could not finish its own bookkeeping; leave the task resumable.
            const message = error instanceof Error ? error.message : String(error);
            await store
              .transitionTask(task.id, 'paused', { error: { code: isRuntimeError(error) ? error.code : 'io', message } }, 'running')
              .catch(() => undefined);
          },
        )
        .then(() => settle(worker))
        .finally(() => {
          workers.delete(task.id);
          kick();
        }),
    };
    workers.set(task.id, worker);
  }

  /** After the actor has exited: confirm a cancel or a pause, record the end of the worker. */
  async function settle(worker: Worker): Promise<void> {
    const { taskId } = worker;
    if (worker.stop === 'lease_lost') return; // another daemon may own the task now
    await locks.run(taskId, async () => {
      const task = await store.getTask(taskId).catch(() => undefined);
      if (task?.status === 'cancelling') await store.transitionTask(taskId, 'cancelled', { terminationReason: 'cancelled' }, 'cancelling').catch(ignoreConflict);
      else if (task?.status === 'running' && (worker.stop === 'pause' || worker.stop === 'shutdown')) {
        await store.transitionTask(taskId, 'paused', {}, 'running').catch(ignoreConflict);
        if (worker.stop === 'shutdown') await event(taskId, 'daemon_shutdown', { ownerPid }).catch(() => undefined);
      }
      await event(taskId, 'worker_finished', { ownerPid }).catch(() => undefined);
    });
  }

  async function stopWorkers(why: NonNullable<Worker['stop']>): Promise<void> {
    const running = [...workers.values()];
    for (const w of running) stopWorker(w, why);
    await Promise.all(running.map((w) => w.done));
  }

  function stopWorker(worker: Worker, why: NonNullable<Worker['stop']>): void {
    // A cancel outranks a pause; a lost lease outranks both (this daemon may no longer write).
    if (worker.stop !== 'lease_lost' && !(worker.stop === 'cancel' && why === 'pause')) worker.stop = why;
    worker.controller.abort(new RuntimeError('cancelled', why));
  }

  /** Waits a bounded time for this process's worker on a task to finish. */
  async function briefly(taskId: string): Promise<void> {
    const worker = workers.get(taskId);
    if (!worker || ackWaitMs <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([worker.done, new Promise<void>((r) => (timer = setTimeout(r, ackWaitMs)))]);
    clearTimeout(timer);
  }

  /** A pause request written after the task's latest move to running or worker start, not yet applied. */
  async function pauseRequested(taskId: string): Promise<boolean> {
    const events = await store.listEvents(taskId, { limit: 200 });
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'pause_requested') return true;
      if (e.type === 'worker_started' || (e.type === 'task_status' && e.detail?.to === 'running')) return false;
    }
    return false;
  }

  const timer = claim ? setInterval(kick, pollMs) : undefined;
  timer?.unref?.();
  kick();

  // -------------------------------------------------------------------------
  // control

  const usageOf = async (taskId: string): Promise<Usage | undefined> => {
    const latest = (events: TaskEvent[]) => events.filter((e) => e.type === 'usage').at(-1);
    const found = latest(await store.listEvents(taskId, { limit: 200 })) ?? latest(await store.listEvents(taskId));
    if (!found?.detail) return undefined;
    try {
      return parseUsage(found.detail);
    } catch {
      return { ...emptyUsage(), inputTokens: 'unknown', outputTokens: 'unknown' };
    }
  };

  const control: TaskDaemon = {
    async submit(skillId: string, input: CollectResumesInput): Promise<{ taskId: string }> {
      const spec = specs(skillId);
      if (!spec) throw new RuntimeError('not_found', `no skill ${skillId}`);
      const value = assertValid(validateCollectResumesInput(input, clock.now()), 'task input');
      if ((value.analysis ?? spec.defaults.analysis) === 'on')
        throw new RuntimeError('capability_missing', 'resume analysis is not implemented; submit with analysis "off"');
      const task = await store.createTask(spec, value);
      kick();
      return { taskId: task.id };
    },

    async status(taskId: string): Promise<TaskStatusReport> {
      const task = await store.getTask(taskId);
      if (!task) throw new RuntimeError('not_found', `no task ${taskId}`);
      const report: TaskStatusReport = { task, outputPath: join(task.input.outputDir, task.id) };
      const checkpoint = await store.getCheckpoint(taskId);
      if (checkpoint) report.checkpoint = checkpoint;
      const usage = await usageOf(taskId);
      if (usage) report.usage = usage;
      return report;
    },

    async pause(taskId: string): Promise<TaskRecord> {
      await locks.run(taskId, async () => {
        const task = await store.getTask(taskId);
        if (!task) throw new RuntimeError('not_found', `no task ${taskId}`);
        if (task.status === 'paused') return;
        if (task.status !== 'running' && task.status !== 'waiting_user')
          throw new RuntimeError('conflict', `task ${taskId} is ${task.status} and cannot be paused`, { current: task.status });
        if (task.status === 'waiting_user') {
          // The runner ended its run to wait; nothing acts while a task waits.
          await store.transitionTask(taskId, 'paused', {}, 'waiting_user').catch(ignoreConflict);
          return;
        }
        const worker = workers.get(taskId);
        if (worker) {
          // Paused once the actor has stopped; settle writes it.
          await event(taskId, 'pause_requested', { by: ownerPid });
          stopWorker(worker, 'pause');
          return;
        }
        if (!(await otherOwnerAlive())) {
          // No actor runs it anywhere: paused now.
          await store.transitionTask(taskId, 'paused', {}, task.status).catch(ignoreConflict);
          return;
        }
        // The owning daemon stops its actor, then marks it paused.
        await event(taskId, 'pause_requested', { by: ownerPid });
      });
      await briefly(taskId);
      return (await store.getTask(taskId))!;
    },

    async resume(taskId: string): Promise<TaskRecord> {
      const task = await locks.run(taskId, () =>
        move(taskId, (t) => {
          if (t.status === 'running' || t.status === 'queued') return t;
          if (t.status !== 'paused' && t.status !== 'waiting_user') throw new RuntimeError('conflict', `task ${taskId} is ${t.status} and cannot be resumed`, { current: t.status });
          return { to: 'running', patch: { phase: 'preparing', error: null } };
        }),
      );
      kick();
      return task;
    },

    async cancel(taskId: string): Promise<TaskRecord> {
      const task = await locks.run(taskId, () =>
        move(taskId, (t) => {
          if (TERMINAL_TASK_STATUSES.includes(t.status) || t.status === 'cancelling') return t;
          // A queued task has no actor yet.
          if (t.status === 'queued') return { to: 'cancelled', patch: { terminationReason: 'cancelled' } };
          return { to: 'cancelling' };
        }),
      );
      const worker = workers.get(taskId);
      if (worker) stopWorker(worker, 'cancel');
      else if (task.status === 'cancelling') await confirmCancelWithoutActor(taskId);
      kick();
      await briefly(taskId);
      return (await store.getTask(taskId)) ?? task;
    },

    async artifacts(taskId: string): Promise<ArtifactRecord[]> {
      if (!(await store.getTask(taskId))) throw new RuntimeError('not_found', `no task ${taskId}`);
      return store.listArtifacts(taskId);
    },

    inspectProcedure(procedureId: string): Promise<ProcedureV2 | undefined> {
      return store.getProcedure(procedureId);
    },

    async bindAccount(taskId: string, account: AccountScope): Promise<TaskRecord> {
      const problem = accountProblem(account);
      if (problem) throw new RuntimeError('invalid_input', problem);
      return locks.run(taskId, async () => {
        const task = await store.getTask(taskId);
        if (!task) throw new RuntimeError('not_found', `no task ${taskId}`);
        if (task.status !== 'queued' && task.status !== 'paused' && task.status !== 'waiting_user')
          throw new RuntimeError('conflict', `task ${taskId} is ${task.status}; bind its account before it runs or while it waits`, { current: task.status });
        const bound = await store.transitionTask(taskId, task.status, { account }, task.status);
        await event(taskId, 'account_bound', { binding: account.binding });
        return bound;
      });
    },

    isOwner: () => lease !== undefined,

    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      await ticking;
      await stopWorkers('shutdown');
      if (lease) await store.releaseLease(lease.leaseId).catch(() => undefined);
      lease = undefined;
    },
  };

  /** Whether a daemon other than this one holds the daemon lease. */
  async function otherOwnerAlive(): Promise<boolean> {
    if (lease) return false;
    return daemonRunning(store, ownerPid);
  }

  /**
   * A cancel no worker here will confirm. When this daemon owns the ledger,
   * or no daemon does (the lease can be taken), no actor runs the task, so
   * the cancel is confirmed now; otherwise the owning daemon confirms it once
   * its actor has exited.
   */
  async function confirmCancelWithoutActor(taskId: string): Promise<void> {
    let probe: SessionLease | undefined;
    if (!lease) {
      try {
        probe = await store.acquireLease({ scopeKey: DAEMON_LEASE_SCOPE, holder: 'runtime', ownerPid, ttlMs: leaseTtlMs });
      } catch (error) {
        if (isRuntimeError(error, 'lease_held')) return;
        throw error;
      }
    }
    try {
      if (workers.has(taskId)) return;
      await locks.run(taskId, () => store.transitionTask(taskId, 'cancelled', { terminationReason: 'cancelled' }, 'cancelling').catch(ignoreConflict));
    } finally {
      if (probe) await store.releaseLease(probe.leaseId).catch(() => undefined);
    }
  }

  return control;
}

function ignoreConflict(error: unknown): undefined {
  if (isRuntimeError(error, 'conflict')) return undefined;
  throw error;
}

// ---------------------------------------------------------------------------
// The worker process

/** Whether some process holds the daemon lease now. Takes and returns it at once when free. */
export async function daemonRunning(store: TaskStore, ownerPid: number = process.pid): Promise<boolean> {
  try {
    const probe = await store.acquireLease({ scopeKey: DAEMON_LEASE_SCOPE, holder: 'runtime', ownerPid, ttlMs: 1_000 });
    await store.releaseLease(probe.leaseId);
    return false;
  } catch (error) {
    if (isRuntimeError(error, 'lease_held')) return true;
    throw error;
  }
}

export interface DetachedWorkerCommand {
  /** Executable, e.g. process.execPath or the bundled runtime. */
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  /** stdout and stderr go here (appended); default discarded. */
  logPath?: string;
}

/**
 * Starts the daemon as its own session-less background process that keeps
 * running after the caller exits: detached into a new process group, no
 * inherited stdio, not waited for. Returns its pid.
 */
export function spawnDetachedWorker(command: DetachedWorkerCommand): number {
  const fd = command.logPath ? openSync(command.logPath, 'a') : undefined;
  try {
    const child = spawn(command.command, [...command.args], {
      detached: true,
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      env: { ...process.env, ...command.env },
      ...(command.cwd ? { cwd: command.cwd } : {}),
    });
    if (child.pid === undefined) throw new RuntimeError('capability_missing', `could not start ${command.command}`);
    child.unref();
    return child.pid;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Makes sure a daemon owns the ledger: starts a detached worker when none
 * holds the daemon lease. Two callers racing may both start one; only one
 * gets the lease and the other serves nothing and can exit.
 */
export async function ensureDaemon(store: TaskStore, command: DetachedWorkerCommand): Promise<{ started: boolean; pid?: number }> {
  if (await daemonRunning(store)) return { started: false };
  return { started: true, pid: spawnDetachedWorker(command) };
}
