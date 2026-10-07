// Task control and the worker that runs tasks. The ledger is the only
// channel between processes: a CLI that exits right after `run` leaves its
// task queued in the store, and the one daemon that holds the daemon lease
// picks it up, runs it, and notices pause and cancel requests written by any
// other process. Control calls are short transactions and never wait for GUI
// work; the GUI belongs to the runner's session, a separate lock.
//
// Ownership: a daemon runs tasks only while it holds the daemon lease (one
// per machine and ledger), renewed by a heartbeat; a daemon without it only
// serves control calls. The lease decides who may start an actor. It never
// proves that an earlier actor has stopped: an expired lease may belong to a
// daemon that is merely stalled, and the exploration bridge runs in detached
// process groups that outlive their parent. So every worker is recorded with
// an epoch and its process identity, and a task's actor counts as stopped
// only on positive evidence:
//
// - `worker_finished` with actorExited, written by the worker's own daemon
//   after runner.run resolved (the runner resolves only after its session
//   closed, and the session only after the bridge child exited), or
// - `actor_exit_verified`, from an injected verifier (A7) that checked the
//   recorded identities, e.g. that the bridge's process group is gone.
//
// Without evidence a task stays as it is — running or cancelling, its pause
// or cancel kept as intent — and no new actor starts for any task, since all
// tasks of the skill drive the same app. Nothing is killed here.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
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
import { accountProblem } from './runner.ts';
import { parseUsage } from './telemetry.ts';

/** The lease scope that makes one daemon the owner of the ledger's tasks. */
export const DAEMON_LEASE_SCOPE = leaseScopeKey('2ndscreen.task-daemon');

/**
 * Item id of the daemon's control events (publication, worker lifecycle,
 * exit evidence, pause and resume intent). Kept apart from candidate events
 * so they are always read in full, however many other events a task writes.
 */
export const CONTROL_ITEM = '~daemon';

export const DAEMON_DEFAULTS = {
  /** Daemon lease; renewed every third of it. */
  leaseTtlMs: 15_000,
  /** How often the owner looks at the ledger for new tasks and requests from other processes. */
  pollMs: 500,
  /** Least time between two verifier calls for the same worker. */
  verifyRetryMs: 5_000,
} as const;

/** Who ran (or runs) a task's actor. */
export interface WorkerRecord {
  taskId: string;
  /** Unique per worker start. */
  epoch: string;
  /** Unique per daemon instance. */
  daemonId: string;
  ownerPid: number;
  /** Start time of the owner process (ps lstart, ISO), so a reused pid is not taken for it. */
  processStartedAt?: string;
  startedAt: string;
  /** Recorded by a daemon before epochs existed: no exit of it can be on record, only verified. */
  legacy?: true;
}

export type ActorExitVerdict = { stopped: true; evidence: string } | { stopped: false; reason: string };

/**
 * Proves that a recorded worker's actor has stopped — every process that
 * could still send input for it, including detached bridge groups. It may
 * stop such processes itself, but only ones whose identity it has verified.
 * Answer stopped only with evidence; anything else leaves the task waiting.
 */
export type ActorExitVerifier = (worker: WorkerRecord, context: { signal: AbortSignal }) => Promise<ActorExitVerdict>;

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
  /** Checks a worker whose exit no daemon recorded. Without one, such a task stays unresolved. */
  verifyActorExit?: ActorExitVerifier;
  verifyRetryMs?: number;
  /** Longest one verifier call may take before its answer is ignored as unproven; default half the lease TTL. */
  verifyTimeoutMs?: number;
  /** The explicit account for a new task, bound before the task is published to the scheduler. */
  accountFor?: (skillId: string, input: CollectResumesInput) => AccountScope | undefined;
}

/** What the daemon offers beyond the contract's TaskControl. */
export interface TaskDaemon extends TaskControl {
  /**
   * submit, optionally with the explicit account the task is bound to. The
   * account is written before the task is published, so no worker can start
   * it unbound.
   */
  submit(skillId: string, input: CollectResumesInput, options?: { account?: AccountScope }): Promise<{ taskId: string }>;
  /**
   * Bind the account of a paused or waiting task that has none (the runner
   * waits with account_changed when it finds none). A bound key never changes.
   */
  bindAccount(taskId: string, account: AccountScope): Promise<TaskRecord>;
  /**
   * Explicitly publish a queued task that was never published (made before
   * publication existed, or straight through the store). Such tasks are
   * never started on their own; each gets a publication_missing event.
   */
  publish(taskId: string): Promise<TaskRecord>;
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
  record: WorkerRecord;
  controller: AbortController;
  done: Promise<void>;
  /** Why it was told to stop; decides what settle writes once the actor has exited. */
  stop?: 'pause' | 'cancel' | 'shutdown' | 'lease_lost';
}

/** A task's control events, folded. */
interface ControlState {
  published: boolean;
  /** The latest worker started for the task. */
  worker?: WorkerRecord;
  /** That worker's actor is proven stopped. */
  exited: boolean;
  /** The last lifecycle mark: a resume after the worker ended means "start again", not orphan. */
  lifecycle?: 'resume' | 'started' | 'exited';
  pausePending: boolean;
  /** An unproven exit of the latest worker is already on record. */
  unprovenNoted: boolean;
  /** A missing publication is already on record. */
  publicationNoted: boolean;
  /** That this runtime has no package for the task's skill is already on record. */
  skillMissingNoted: boolean;
}

function foldControl(events: TaskEvent[]): ControlState {
  const state: ControlState = { published: false, exited: false, pausePending: false, unprovenNoted: false, publicationNoted: false, skillMissingNoted: false };
  for (const e of events) {
    const d = e.detail ?? {};
    switch (e.type) {
      case 'task_published':
        state.published = true;
        break;
      case 'publication_missing':
        state.publicationNoted = true;
        break;
      case 'skill_missing':
        state.skillMissingNoted = true;
        break;
      case 'worker_started':
        state.worker = d as unknown as WorkerRecord;
        state.exited = false;
        state.unprovenNoted = false;
        state.lifecycle = 'started';
        break;
      case 'worker_finished':
      case 'actor_exit_verified':
        if (state.worker && d.epoch === state.worker.epoch && (e.type === 'actor_exit_verified' || d.actorExited === true)) {
          state.exited = true;
          state.lifecycle = 'exited';
        }
        break;
      case 'actor_exit_unproven':
        if (state.worker && d.epoch === state.worker.epoch) state.unprovenNoted = true;
        break;
      case 'resume_requested':
        state.lifecycle = 'resume';
        state.pausePending = false;
        break;
      case 'pause_requested':
        state.pausePending = true;
        break;
      case 'pause_applied':
        state.pausePending = false;
        break;
    }
  }
  return state;
}

/** No actor can be running for the task: none was ever started, or the latest one is proven stopped. */
const actorProvenStopped = (state: ControlState): boolean => !state.worker || state.exited;

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
  const verifyRetryMs = deps.verifyRetryMs ?? DAEMON_DEFAULTS.verifyRetryMs;
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? Math.max(1, Math.floor(leaseTtlMs / 2));
  /** Terminal tasks whose last actor is proven stopped; that cannot change, so they are not read again. */
  const settledTerminal = new Set<string>();
  const daemonId = randomUUID();
  const processStartedAt = processStartTime(ownerPid);
  const locks = new StateLocks();
  const workers = new Map<string, Worker>();
  const lastVerify = new Map<string, number>();
  const lifetime = new AbortController();
  let lease: SessionLease | undefined;
  let stopped = false;
  let ticking: Promise<void> | undefined;
  let tickAgain = false;

  const now = () => clock.now().toISOString();
  const event = (taskId: string, type: string, detail?: Record<string, unknown>) =>
    store.appendEvent({ taskId, type, at: now(), ...(detail ? { detail } : {}) });
  const control = (taskId: string, type: string, detail?: Record<string, unknown>) =>
    store.appendEvent({ taskId, itemId: CONTROL_ITEM, type, at: now(), ...(detail ? { detail } : {}) });
  /** Tasks known to carry no worker record from before epochs; events are append-only. */
  const noLegacy = new Set<string>();

  /**
   * The task's control events, folded. A task whose only worker record is a
   * pre-upgrade `worker_started` (no control item, no epoch) gets that worker
   * as its latest one, never proven stopped by itself, so an old in-flight
   * task cannot look actor-free.
   */
  async function controlState(taskId: string): Promise<ControlState> {
    const events = await store.listEvents(taskId, { itemId: CONTROL_ITEM });
    const state = foldControl(events);
    if (state.worker || noLegacy.has(taskId)) return state;
    const legacy = (await store.listEvents(taskId)).filter((e) => e.itemId === undefined && e.type === 'worker_started').at(-1);
    if (!legacy) {
      noLegacy.add(taskId);
      return state;
    }
    const worker: WorkerRecord = { taskId, epoch: `legacy-${legacy.at}`, daemonId: 'legacy', ownerPid: Number(legacy.detail?.ownerPid ?? 0), startedAt: legacy.at, legacy: true };
    const synthetic: TaskEvent = { taskId, itemId: CONTROL_ITEM, type: 'worker_started', at: legacy.at, detail: { ...worker } };
    return foldControl([synthetic, ...events]);
  }

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

  /**
   * Renews the lease now. 'held': renewed, the lease runs a full TTL from
   * here; 'unsure': a transient ledger error while the lease still has time
   * left (kept, but nothing should be decided on it); 'lost': expired or
   * taken, which stops this daemon's workers.
   */
  async function renewOwnership(): Promise<'held' | 'unsure' | 'lost'> {
    const current = lease;
    if (!current) return 'lost';
    try {
      const renewed = await store.renewLease(current.leaseId, leaseTtlMs);
      if (lease?.leaseId === current.leaseId) lease = renewed;
      return lease ? 'held' : 'lost';
    } catch (error) {
      const gone = isRuntimeError(error, 'conflict') || isRuntimeError(error, 'not_found') || Date.parse(current.expiresAt) <= clock.now().getTime();
      if (!gone) return 'unsure';
      // Expired or taken: another daemon may own the ledger now.
      if (lease?.leaseId === current.leaseId) {
        lease = undefined;
        await stopWorkers('lease_lost');
      }
      return 'lost';
    }
  }

  /** Right before a state decision or a worker start: the lease is renewed now, or nothing is decided. */
  const confirmOwnership = async (): Promise<boolean> => (await renewOwnership()) === 'held';

  async function holdLease(): Promise<boolean> {
    // The renewer keeps a held lease alive; decisions confirm it again themselves.
    if (lease) return Date.parse(lease.expiresAt) > clock.now().getTime() || (await renewOwnership()) !== 'lost';
    try {
      lease = await store.acquireLease({ scopeKey: DAEMON_LEASE_SCOPE, holder: 'runtime', ownerPid, ttlMs: leaseTtlMs });
      return true;
    } catch (error) {
      if (isRuntimeError(error, 'lease_held')) return false;
      throw error;
    }
  }

  /**
   * Whether the task's latest actor is proven stopped, asking the verifier
   * (at most every verifyRetryMs) when no daemon recorded its exit. Records
   * an unproven exit once per worker.
   */
  async function provenStopped(taskId: string, state: ControlState): Promise<boolean> {
    if (actorProvenStopped(state)) return true;
    const worker = state.worker!;
    if (workers.get(taskId)?.record.epoch === worker.epoch) return false;
    let reason = 'no daemon recorded the exit of this worker and no verifier is configured; lease expiry is not proof';
    const verify = deps.verifyActorExit;
    if (verify) {
      const last = lastVerify.get(worker.epoch);
      if (last === undefined || Date.now() - last >= verifyRetryMs) {
        lastVerify.set(worker.epoch, Date.now());
        const verdict = await boundedVerify(verify, worker);
        // A slow verifier may have outlived this daemon's ownership; only an owner records its finding.
        if (!(await confirmOwnership())) return false;
        if (verdict.stopped && verdict.evidence.trim()) {
          await control(taskId, 'actor_exit_verified', { epoch: worker.epoch, source: 'verifier', evidence: verdict.evidence, by: daemonId });
          // The caller decides on this state: the worker ended, so the task is an orphan, not one to start.
          state.exited = true;
          state.lifecycle = 'exited';
          return true;
        }
        reason = verdict.stopped ? 'the verifier gave no evidence' : verdict.reason;
      } else reason = 'waiting to ask the verifier again';
    }
    if (!state.unprovenNoted) {
      await control(taskId, 'actor_exit_unproven', { epoch: worker.epoch, ownerPid: worker.ownerPid, reason, by: daemonId });
      state.unprovenNoted = true;
    }
    return false;
  }

  /** One verifier call, cut off after verifyTimeoutMs; a late or failed answer is unproven. */
  async function boundedVerify(verify: ActorExitVerifier, worker: WorkerRecord): Promise<ActorExitVerdict> {
    const deadline = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<ActorExitVerdict>((resolve) => {
      timer = setTimeout(() => {
        deadline.abort();
        resolve({ stopped: false, reason: `verifier did not answer within ${verifyTimeoutMs} ms` });
      }, verifyTimeoutMs);
    });
    try {
      return await Promise.race([
        verify(worker, { signal: AbortSignal.any([lifetime.signal, deadline.signal]) }).catch(
          (error: unknown): ActorExitVerdict => ({ stopped: false, reason: `verifier failed: ${error instanceof Error ? error.message : String(error)}` }),
        ),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
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
    // Every task, terminal ones included: a task that ended (or was moved by
    // an older version or by hand) may still have an actor whose exit is unproven.
    const all = await store.listTasks();
    let blocked = false;
    const startable: TaskRecord[] = [];
    for (const task of all) {
      if (TERMINAL_TASK_STATUSES.includes(task.status)) {
        if (settledTerminal.has(task.id) || workers.has(task.id)) continue; // a local worker still finishing blocks below
        if (await provenStopped(task.id, await controlState(task.id))) settledTerminal.add(task.id);
        else blocked = true;
        continue;
      }
      const state = await controlState(task.id);
      const worker = workers.get(task.id);
      if (worker) {
        // Cancelled, paused or moved by someone else: stop the actor; settle records the rest.
        if (task.status === 'cancelling') stopWorker(worker, 'cancel');
        else if (task.status !== 'running' || state.pausePending) stopWorker(worker, 'pause');
        continue;
      }
      if (!(await provenStopped(task.id, state))) {
        // An actor may still drive the app: decide nothing, start nothing.
        blocked = true;
        continue;
      }
      const needsDecision = task.status === 'cancelling' || task.status === 'running';
      if (needsDecision && !(await confirmOwnership())) return;
      await locks.run(task.id, async () => {
        if (task.status === 'cancelling') {
          await store.transitionTask(task.id, 'cancelled', { terminationReason: 'cancelled' }, 'cancelling').catch(ignoreConflict);
        } else if (task.status === 'running' && state.pausePending) {
          if (await store.transitionTask(task.id, 'paused', {}, 'running').catch(ignoreConflict)) await control(task.id, 'pause_applied', { by: daemonId });
        } else if (task.status === 'running' && state.worker && state.lifecycle === 'exited') {
          // Its worker ended without finishing it (crash, lost lease): resumable, never a success.
          const paused = await store
            .transitionTask(task.id, 'paused', { error: { code: 'lease_held', message: 'the worker running this task stopped without finishing it; resume to continue' } }, 'running')
            .catch(ignoreConflict);
          if (paused) await control(task.id, 'orphan_recovered', { epoch: state.worker.epoch, by: daemonId });
        } else if ((task.status === 'running' || (task.status === 'queued' && state.published)) && !specs(task.skillId)) {
          // A task of a business package this runtime does not carry: kept as it is, never claimed
          // or failed, and the reason is on record once. Another worker with the package may run it.
          if (!state.skillMissingNoted)
            await control(task.id, 'skill_missing', { skillId: task.skillId, reason: `no package for skill ${task.skillId} is installed in this runtime`, by: daemonId });
        } else if (task.status === 'running' || (task.status === 'queued' && state.published)) {
          startable.push(task);
        } else if (task.status === 'queued' && !state.publicationNoted) {
          // Not silently ignored: on record until someone publishes or cancels it.
          await control(task.id, 'publication_missing', { reason: 'queued without task_published; call publish() to run it', by: daemonId });
        }
      });
    }
    // One task at a time: tasks of one skill drive the same app.
    if (blocked || workers.size > 0 || stopped) return;
    const next = startable.find((t) => t.status === 'running') ?? startable.find((t) => t.status === 'queued');
    // Ownership checked again right before an actor can start, however long the scan took.
    if (next && (await confirmOwnership())) await start(next);
  }

  async function start(task: TaskRecord): Promise<void> {
    const record: WorkerRecord = {
      taskId: task.id,
      epoch: randomUUID(),
      daemonId,
      ownerPid,
      ...(processStartedAt ? { processStartedAt } : {}),
      startedAt: now(),
    };
    const started = await locks.run(task.id, async () => {
      try {
        if (task.status === 'queued') await store.transitionTask(task.id, 'running', { phase: 'preparing' }, 'queued');
        else if ((await store.getTask(task.id))?.status !== 'running') return false;
        // On record before the runner can act.
        await control(task.id, 'worker_started', { ...record });
        return true;
      } catch (error) {
        if (isRuntimeError(error, 'conflict')) return false;
        throw error;
      }
    });
    if (!started) return;
    const controller = new AbortController();
    const worker: Worker = {
      record,
      controller,
      done: runner
        .run(task.id, controller.signal)
        .then(
          () => ({ exited: true }) as const,
          (error: unknown) => ({ exited: false, error: error instanceof Error ? error.message : String(error) }) as const,
        )
        .then((result) => settle(worker, result))
        .finally(() => {
          workers.delete(task.id);
          kick();
        }),
    };
    workers.set(task.id, worker);
    if (stopped) stopWorker(worker, 'shutdown');
  }

  /**
   * After runner.run has settled. Its exit is recorded first — even by a
   * daemon that lost the lease, since it is evidence, not a decision — and
   * only then is a cancel or pause confirmed. A runner that threw proves
   * nothing about its session, so its exit stays unproven.
   */
  async function settle(worker: Worker, result: { exited: true } | { exited: false; error: string }): Promise<void> {
    const { taskId, epoch } = worker.record;
    await control(taskId, 'worker_finished', { epoch, actorExited: result.exited, ...(!result.exited ? { error: result.error } : {}), by: daemonId }).catch(() => undefined);
    if (worker.stop === 'lease_lost' || !result.exited) return;
    await locks.run(taskId, async () => {
      const task = await store.getTask(taskId).catch(() => undefined);
      if (task?.status === 'cancelling') await store.transitionTask(taskId, 'cancelled', { terminationReason: 'cancelled' }, 'cancelling').catch(ignoreConflict);
      else if (task?.status === 'running' && (worker.stop === 'pause' || worker.stop === 'shutdown')) {
        if (await store.transitionTask(taskId, 'paused', {}, 'running').catch(ignoreConflict))
          await control(taskId, worker.stop === 'pause' ? 'pause_applied' : 'daemon_shutdown', { by: daemonId }).catch(() => undefined);
      }
    });
  }

  async function stopWorkers(why: NonNullable<Worker['stop']>): Promise<void> {
    const running = [...workers.values()];
    for (const w of running) stopWorker(w, why);
    await Promise.all(running.map((w) => w.done));
  }

  function stopWorker(worker: Worker, why: NonNullable<Worker['stop']>): void {
    // A cancel outranks a pause; a lost lease outranks both (this daemon no longer decides).
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

  const timer = claim ? setInterval(kick, pollMs) : undefined;
  timer?.unref?.();
  // The lease is kept alive apart from the scan, so a slow verifier or ledger cannot let it lapse unnoticed.
  const renewer = claim
    ? setInterval(() => {
        if (lease && !stopped) void renewOwnership().catch(() => undefined);
      }, Math.max(10, Math.floor(leaseTtlMs / 3)))
    : undefined;
  renewer?.unref?.();
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

  const daemon: TaskDaemon = {
    async submit(skillId: string, input: CollectResumesInput, options: { account?: AccountScope } = {}): Promise<{ taskId: string }> {
      const spec = specs(skillId);
      if (!spec) throw new RuntimeError('not_found', `no skill ${skillId}`);
      const value = assertValid(validateCollectResumesInput(input, clock.now()), 'task input');
      if ((value.analysis ?? spec.defaults.analysis) === 'on')
        throw new RuntimeError('capability_missing', 'resume analysis is not implemented; submit with analysis "off"');
      const account = options.account ?? deps.accountFor?.(skillId, value);
      const problem = account && accountProblem(account);
      if (problem) throw new RuntimeError('invalid_input', problem);
      const task = await store.createTask(spec, value);
      // Bound first, published second: the scheduler starts only published tasks.
      if (account) {
        await store.transitionTask(task.id, 'queued', { account }, 'queued');
        await control(task.id, 'account_bound', { binding: account.binding, by: daemonId });
      }
      await control(task.id, 'task_published', { account: account !== undefined, by: daemonId });
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
        const worker = workers.get(taskId);
        if (worker) {
          // Paused once the actor has stopped; settle writes it.
          await control(taskId, 'pause_requested', { by: daemonId });
          stopWorker(worker, 'pause');
          return;
        }
        if (actorProvenStopped(await controlState(taskId))) {
          // No actor can be running it: paused now.
          if (await store.transitionTask(taskId, 'paused', {}, task.status).catch(ignoreConflict)) await control(taskId, 'pause_applied', { by: daemonId });
          return;
        }
        // An actor may be live (another daemon's, or unproven): the intent waits for its exit.
        await control(taskId, 'pause_requested', { by: daemonId });
      });
      await briefly(taskId);
      return (await store.getTask(taskId))!;
    },

    async resume(taskId: string): Promise<TaskRecord> {
      const task = await locks.run(taskId, async () => {
        const current = await store.getTask(taskId);
        if (!current) throw new RuntimeError('not_found', `no task ${taskId}`);
        if (current.status === 'running' || current.status === 'queued') return current;
        if (current.status !== 'paused' && current.status !== 'waiting_user')
          throw new RuntimeError('conflict', `task ${taskId} is ${current.status} and cannot be resumed`, { current: current.status });
        // The intent goes first, so an owner never mistakes the resumed task for an orphan.
        await control(taskId, 'resume_requested', { by: daemonId });
        return move(taskId, (t) => (t.status === 'paused' || t.status === 'waiting_user' ? { to: 'running', patch: { phase: 'preparing', error: null } } : t));
      });
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
      else if (task.status === 'cancelling' && actorProvenStopped(await controlState(taskId))) {
        // No actor can be running it, here or in any other process.
        await locks.run(taskId, () => store.transitionTask(taskId, 'cancelled', { terminationReason: 'cancelled' }, 'cancelling').catch(ignoreConflict));
      }
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
        if (task.status !== 'paused' && task.status !== 'waiting_user')
          throw new RuntimeError('conflict', `task ${taskId} is ${task.status}; bind an account at submit, or while the task is paused or waiting`, { current: task.status });
        if (task.account && task.account.accountKey !== account.accountKey)
          throw new RuntimeError('conflict', `task ${taskId} is bound to another account; start a new task`);
        const bound = await store.transitionTask(taskId, task.status, { account }, task.status);
        await control(taskId, 'account_bound', { binding: account.binding, by: daemonId });
        return bound;
      });
    },

    async publish(taskId: string): Promise<TaskRecord> {
      const task = await locks.run(taskId, async () => {
        const current = await store.getTask(taskId);
        if (!current) throw new RuntimeError('not_found', `no task ${taskId}`);
        if (current.status !== 'queued') throw new RuntimeError('conflict', `task ${taskId} is ${current.status}; only a queued task is published`, { current: current.status });
        if (!(await controlState(taskId)).published) await control(taskId, 'task_published', { migrated: true, account: current.account !== undefined, by: daemonId });
        return current;
      });
      kick();
      return task;
    },

    isOwner: () => lease !== undefined,

    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (renewer) clearInterval(renewer);
      await ticking;
      await stopWorkers('shutdown');
      lifetime.abort();
      if (lease) await store.releaseLease(lease.leaseId).catch(() => undefined);
      lease = undefined;
    },
  };

  return daemon;
}

/** Returns the value for a transition that went through, undefined for one another writer pre-empted. */
function ignoreConflict(error: unknown): undefined {
  if (isRuntimeError(error, 'conflict')) return undefined;
  throw error;
}

// ---------------------------------------------------------------------------
// Process identity: building blocks for an ActorExitVerifier. Nothing here kills.

/** A process's start time (ps lstart) as ISO, or undefined when it cannot be read. */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ms = Date.parse(out);
    return out && !Number.isNaN(ms) ? new Date(ms).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process recorded as (pid, startedAt) is still the one running:
 * 'gone' when no such pid exists or the pid now belongs to a process started
 * at another time; 'unknown' when that cannot be told (no start time on
 * record, or ps unreadable).
 */
export function processIdentity(pid: number, startedAt: string | undefined): 'alive' | 'gone' | 'unknown' {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown';
  }
  if (!startedAt) return 'unknown';
  const current = processStartTime(pid);
  if (!current) return 'unknown';
  return current === startedAt ? 'alive' : 'gone';
}

// ---------------------------------------------------------------------------
// The worker process

/** The pid holding the daemon lease now, or undefined when nobody does. Takes and returns the lease at once when free. */
export async function daemonOwnerPid(store: TaskStore, ownerPid: number = process.pid): Promise<number | undefined> {
  try {
    const probe = await store.acquireLease({ scopeKey: DAEMON_LEASE_SCOPE, holder: 'runtime', ownerPid, ttlMs: 1_000 });
    await store.releaseLease(probe.leaseId);
    return undefined;
  } catch (error) {
    if (isRuntimeError(error, 'lease_held')) return Number(error.details?.ownerPid);
    throw error;
  }
}

/** Whether some process holds the daemon lease now. */
export async function daemonRunning(store: TaskStore, ownerPid: number = process.pid): Promise<boolean> {
  return (await daemonOwnerPid(store, ownerPid)) !== undefined;
}

/** The process group of a pid, or undefined when it cannot be read. */
function processGroup(pid: number): number | undefined {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const pgid = Number(out);
    return out && Number.isInteger(pgid) ? pgid : undefined;
  } catch {
    return undefined;
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

interface Launched {
  pid: number;
  exit: Promise<{ code: number | null; signal: string | null }>;
}

function launch(command: DetachedWorkerCommand): Promise<Launched> {
  return new Promise((resolve, reject) => {
    let fd: number | undefined;
    const closeLog = () => {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
    };
    try {
      if (command.logPath) fd = openSync(command.logPath, 'a');
      const child = spawn(command.command, [...command.args], {
        detached: true,
        stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
        env: { ...process.env, ...command.env },
        ...(command.cwd ? { cwd: command.cwd } : {}),
      });
      const exit = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
      child.once('error', (error) => {
        closeLog();
        reject(new RuntimeError('capability_missing', `could not start ${command.command}: ${error.message}`));
      });
      child.once('spawn', () => {
        closeLog();
        // Later errors (e.g. a failed kill) must not crash the caller.
        child.on('error', () => undefined);
        child.unref();
        resolve({ pid: child.pid!, exit });
      });
    } catch (error) {
      closeLog();
      reject(isRuntimeError(error) ? error : new RuntimeError('io', `could not start ${command.command}: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

/**
 * Starts the daemon as its own background process that keeps running after
 * the caller exits: detached into a new process group, no inherited stdio,
 * not waited for. Resolves with its pid once it has started; rejects with
 * capability_missing when it cannot be started.
 */
export async function spawnDetachedWorker(command: DetachedWorkerCommand): Promise<number> {
  return (await launch(command)).pid;
}

/**
 * Makes sure a daemon owns the ledger. When none holds the daemon lease,
 * starts a detached worker and resolves only once an unexpired lease is
 * held, within readyTimeoutMs; `ownedBySpawned` says whether its holder is
 * the spawned process (or one in its process group) rather than another
 * daemon that won a race. Rejects as soon as the worker exits first (io,
 * with its code and signal) or when the time runs out (timeout, the
 * still-running pid in details).
 */
export async function ensureDaemon(
  store: TaskStore,
  command: DetachedWorkerCommand,
  options: { readyTimeoutMs?: number; pollMs?: number } = {},
): Promise<{ started: false; ownerPid: number } | { started: true; pid: number; ownerPid: number; ownedBySpawned: boolean }> {
  const existing = await daemonOwnerPid(store);
  if (existing !== undefined) return { started: false, ownerPid: existing };
  const child = await launch(command);
  let exited: { code: number | null; signal: string | null } | undefined;
  void child.exit.then((e) => (exited = e));
  const deadline = Date.now() + (options.readyTimeoutMs ?? 10_000);
  const pause = options.pollMs ?? 100;
  for (;;) {
    if (exited) throw new RuntimeError('io', `the daemon exited (code ${exited.code}, signal ${exited.signal}) before taking ownership`, { pid: child.pid, ...exited });
    const owner = await daemonOwnerPid(store);
    if (owner !== undefined) {
      const ownedBySpawned = owner === child.pid || processGroup(owner) === child.pid;
      return { started: true, pid: child.pid, ownerPid: owner, ownedBySpawned };
    }
    if (Date.now() >= deadline) throw new RuntimeError('timeout', `the daemon (pid ${child.pid}) did not take ownership in time; it was left running`, { pid: child.pid });
    await new Promise<void>((r) => {
      const t = setTimeout(r, pause);
      void child.exit.then(() => {
        clearTimeout(t);
        r();
      });
    });
  }
}
