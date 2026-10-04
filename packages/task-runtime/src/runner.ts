// The task loop: open a session, bind the account, reconcile what a crash
// left on disk, then walk the candidate list one candidate at a time until
// the target is reached, the source ends, a limit stops it, the user is
// needed, or the task is paused or cancelled. Every unit runs the same way:
// a verified procedure, else the workflow's scripted path, each checked by
// the workflow's verifier; only a failure of that one unit goes to
// recovery, and only recovery may reach a model. A checkpoint is written
// before each candidate, the count of successes is the committed items whose
// files are still on disk, and usage is persisted as the task goes.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_BUDGET,
  RuntimeError,
  TERMINAL_TASK_STATUSES,
  checkBudget,
  emptyUsage,
  canTransitionWorkItem,
  isCountable,
  isRuntimeError,
  safePathSegment,
  systemClock,
  throwIfAborted,
  type AccountScope,
  type ArtifactRecord,
  type ArtifactStore,
  type BossUnitName,
  type BossWorkflow,
  type Budget,
  type CandidateListing,
  type CandidateRef,
  type CheckResult,
  type Clock,
  type FileValidation,
  type Learner,
  type Observation,
  type ProcedureEngine,
  type ProcedureKey,
  type Recovery,
  type RecoveryContext,
  type RuntimeErrorCode,
  type Session,
  type SessionManager,
  type StagedArtifact,
  type TaskCheckpoint,
  type TaskOutcome,
  type TaskPatch,
  type TaskPhase,
  type TaskRecord,
  type TaskRunner,
  type TaskSpec,
  type TaskStatus,
  type TaskStore,
  type TelemetryRecorder,
  type TerminationReason,
  type UnitContext,
  type Usage,
  type WaitReason,
  type WindowProfile,
  type WorkItem,
  type WorkItemStatus,
} from './contracts.ts';
import { addUsage, parseUsage, usageSince } from './telemetry.ts';

export interface TaskRunnerDeps {
  store: TaskStore;
  sessions: SessionManager;
  artifacts: (task: TaskRecord) => ArtifactStore;
  engine: ProcedureEngine;
  learner: Learner;
  recovery: Recovery;
  workflow: BossWorkflow;
  spec: TaskSpec;
  profile: WindowProfile;
  telemetry: (taskId: string) => TelemetryRecorder;
  clock?: Clock;
  newId?: () => string;
}

/** Optional additions to the contract's dependencies. */
export interface TaskRunnerOptions {
  /**
   * The explicit BOSS account for a task that has none bound, e.g. from the
   * user's local configuration. Asked only when the task record has no
   * account and the window shows none; without an answer the task waits for
   * the user instead of guessing.
   */
  resolveAccount?: (task: TaskRecord) => AccountScope | undefined | Promise<AccountScope | undefined>;
}

/** Why an account scope cannot key a task's candidates, or undefined when it can. */
export function accountProblem(account: AccountScope | undefined): string | undefined {
  if (!account || account.platform !== 'boss') return 'account must be a boss account scope';
  if (account.binding !== 'explicit' && account.binding !== 'observed') return 'account binding must be explicit or observed';
  // The key goes into lease scopes ("<bundle>:<key>") and candidate keys: no separators.
  if (!account.accountKey || account.accountKey.includes(':') || !safePathSegment(account.accountKey)) return 'accountKey must be a plain identifier without ":" or "/"';
  return undefined;
}

/** Bounds that keep one run finite whatever the page does. */
export const RUNNER_LIMITS = {
  /** App lease the session keeps renewed while the task runs. */
  leaseTtlMs: 30_000,
  /** Attempts on one candidate that end failed before it is left alone. */
  maxFailedAttempts: 2,
  /** Attempts of any kind (including crash re-checks) before a candidate is given up as unavailable. */
  maxAttempts: 4,
  /** advance_list failures in a row before the task pauses instead of looping. */
  maxStalledAdvances: 3,
  /** Unexpected errors on candidates in a row before the task pauses. */
  maxItemErrorsInRow: 3,
  /** Floor of advance_list calls in one run; the bound grows with the task's size. */
  minAdvances: 100,
} as const;

/** A unit failure the workflow reports as a fact about the page, not a broken step: never sent to a model. */
const WAIT_FOR_REASON: Readonly<Record<string, WaitReason>> = {
  login_required: 'login_required',
  captcha: 'captcha',
  job_ambiguous: 'job_ambiguous',
};
const NOT_REPAIRABLE = new Set([
  ...Object.keys(WAIT_FOR_REASON),
  'job_not_found',
  'candidate_row_ambiguous',
  'candidate_not_in_list',
  'identity_ambiguous',
  'identity_mismatch',
  'request_dialog',
  'resume_identity_unconfirmed',
  'duplicate_row',
]);

const WAIT_FOR_ERROR: Partial<Record<RuntimeErrorCode, WaitReason>> = {
  login_required: 'login_required',
  capability_missing: 'capability_missing',
  permission_missing: 'permission_missing',
  storage_full: 'storage_full',
  model_unavailable: 'model_unavailable',
};

const FINAL_ITEM: readonly WorkItemStatus[] = ['committed', 'unavailable', 'ambiguous'];

/** Why a run stops. */
type Stop =
  | { kind: 'end'; status: 'succeeded' | 'partial' | 'failed'; reason: TerminationReason; error?: { code: RuntimeErrorCode; message: string } }
  | { kind: 'wait'; reason: WaitReason; error?: { code: RuntimeErrorCode; message: string } }
  | { kind: 'pause'; error: { code: RuntimeErrorCode; message: string } }
  /** The signal fired or someone else moved the task (pause, cancel): no more actions. */
  | { kind: 'interrupted' };

class StopRun extends Error {
  readonly stop: Stop;
  constructor(stop: Stop) {
    super(`run stopped: ${stop.kind}`);
    this.stop = stop;
  }
}

/** Errors that end one candidate's attempt but not the run. */
const CANDIDATE_LOCAL: ReadonlySet<RuntimeErrorCode> = new Set(['io', 'not_found', 'conflict', 'timeout', 'snapshot_stale', 'window_lost']);
const candidateLocal = (error: unknown): boolean => !isRuntimeError(error) || CANDIDATE_LOCAL.has(error.code);

const errorOf = (error: unknown): { code: RuntimeErrorCode; message: string } =>
  isRuntimeError(error) ? { code: error.code, message: error.message } : { code: 'io', message: error instanceof Error ? error.message : String(error) };

/** How an error that escaped a unit or candidate ends the run. */
function stopFor(error: unknown): Stop {
  if (error instanceof StopRun) return error.stop;
  if (isRuntimeError(error, 'cancelled')) return { kind: 'interrupted' };
  if (isRuntimeError(error)) {
    const wait = WAIT_FOR_ERROR[error.code];
    if (wait) return { kind: 'wait', reason: wait, error: errorOf(error) };
    if (error.code === 'forbidden_effect' || error.code === 'invalid_input') return { kind: 'end', status: 'failed', reason: 'fatal_error', error: errorOf(error) };
    if (error.code === 'budget_exhausted') return { kind: 'end', status: 'partial', reason: 'budget_exhausted', error: errorOf(error) };
  }
  // Lease lost, window gone, IO: stop where a resume can pick up.
  return { kind: 'pause', error: errorOf(error) };
}

type UnitResult =
  | { ok: true; observation: Observation; reason?: string }
  | { ok: false; reason: string; observation?: Observation; taskBudget?: boolean };

/** Per-candidate state that units share. */
interface ItemState {
  /** Model repairs already spent on this candidate. */
  repairs: number;
}

export function createTaskRunner(deps: TaskRunnerDeps & TaskRunnerOptions): TaskRunner {
  const clock = deps.clock ?? systemClock;
  return {
    run: (taskId: string, signal: AbortSignal) => new TaskRun(deps, clock, taskId, signal).execute(),
  };
}

class TaskRun {
  private readonly deps: TaskRunnerDeps & TaskRunnerOptions;
  private readonly clock: Clock;
  private readonly taskId: string;
  private readonly signal: AbortSignal;
  private readonly store: TaskStore;

  private task!: TaskRecord;
  private account!: AccountScope;
  private session: Session | undefined;
  private artifactStore: ArtifactStore | undefined;
  private recorder!: TelemetryRecorder;
  private budget!: Budget;
  /** Usage persisted by earlier runs, the recorder's reading at start, and when this run started. */
  private prior: Usage = emptyUsage();
  private recorderAtStart: Usage = emptyUsage();
  private startedMs = 0;
  private phase: TaskPhase = 'preparing';
  private lastCommittedItemId: string | undefined;
  private cursor: string | undefined;
  /** Items by the list row they were last seen as, to skip finished candidates without opening them. */
  private readonly bySourceRef = new Map<string, WorkItem>();
  private itemErrorsInRow = 0;

  constructor(deps: TaskRunnerDeps & TaskRunnerOptions, clock: Clock, taskId: string, signal: AbortSignal) {
    this.deps = deps;
    this.clock = clock;
    this.taskId = taskId;
    this.signal = signal;
    this.store = deps.store;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  // -------------------------------------------------------------------------
  // the run

  async execute(): Promise<TaskOutcome> {
    const found = await this.store.getTask(this.taskId);
    if (!found) throw new RuntimeError('not_found', `no task ${this.taskId}`);
    this.task = found;
    // Ended, or held by a control decision (paused, waiting for the user):
    // only TaskControl.resume moves a held task back to running.
    if (TERMINAL_TASK_STATUSES.includes(found.status) || found.status === 'paused' || found.status === 'waiting_user') return this.outcome();
    if (found.status === 'cancelling') {
      // Nothing of this run ever acted, so the cancel can be confirmed here.
      await this.transition('cancelled', { terminationReason: 'cancelled' }, 'cancelling').catch(() => undefined);
      return this.outcome();
    }
    this.recorder = this.deps.telemetry(this.taskId);
    this.recorderAtStart = this.recorder.usage();
    this.startedMs = this.clock.now().getTime();
    this.prior = await this.loadUsage();
    this.budget = { ...DEFAULT_BUDGET, ...this.task.input.budget };

    let stop: Stop;
    try {
      throwIfAborted(this.signal);
      if (found.status === 'queued') {
        this.task = await this.transition('running', { phase: 'preparing', error: null }, 'queued');
      } else {
        this.task = await this.transition('running', { phase: 'preparing' }, 'running');
      }
      await this.store.appendEvent({ taskId: this.taskId, type: 'run_started', at: this.now(), detail: { pid: process.pid } });
      stop = await this.loop();
    } catch (error) {
      stop = stopFor(error);
    }
    return this.finish(stop);
  }

  private async loop(): Promise<Stop> {
    try {
      if ((this.task.input.analysis ?? this.deps.spec.defaults.analysis) === 'on')
        throw new StopRun({ kind: 'end', status: 'failed', reason: 'fatal_error', error: { code: 'capability_missing', message: 'resume analysis is not implemented; run with analysis "off"' } });
      const boundProblem = this.task.account && accountProblem(this.task.account);
      if (boundProblem) throw new StopRun({ kind: 'wait', reason: 'account_changed', error: { code: 'invalid_input', message: boundProblem } });
      await this.prepare();
      await this.setPhase('executing');
      await this.selectSource();
      await this.walkList();
      // walkList only returns by throwing a stop.
      return { kind: 'pause', error: { code: 'io', message: 'the list walk ended without a reason' } };
    } catch (error) {
      return stopFor(error);
    }
  }

  /** Lease and window, the bound account, then disk against ledger before any new attempt. */
  private async prepare(): Promise<void> {
    const { sessions, profile, workflow } = this.deps;
    this.session = await sessions.open(
      { taskId: this.taskId, profile, takeOver: this.task.input.takeOver ?? false, account: this.task.account, leaseTtlMs: RUNNER_LIMITS.leaseTtlMs },
      this.signal,
    );
    await this.checkStillRunning();

    const observation = await this.session.observe({ elements: true }, this.signal);
    const page = workflow.classifyPage(observation);
    if (page === 'login') throw new StopRun({ kind: 'wait', reason: 'login_required' });
    if (page === 'captcha') throw new StopRun({ kind: 'wait', reason: 'captcha' });
    const seen = workflow.readAccount({ ...observation, pageClass: page });
    const bound = this.task.account;
    if (seen && accountProblem(seen))
      throw new StopRun({ kind: 'wait', reason: 'account_changed', error: { code: 'invalid_input', message: `the visible account cannot key candidates: ${accountProblem(seen)}` } });
    if (seen && bound && seen.accountKey !== bound.accountKey)
      throw new StopRun({ kind: 'wait', reason: 'account_changed', error: { code: 'conflict', message: 'the window shows another account than the task is bound to' } });
    if (!bound) {
      // No account is readable in the window on macOS (P0): only an explicit binding may stand in.
      const account = seen ?? (await this.deps.resolveAccount?.(this.task));
      const problem = accountProblem(account);
      if (!account || problem)
        throw new StopRun({
          kind: 'wait',
          reason: 'account_changed',
          error: { code: 'invalid_input', message: account ? `the configured account cannot be used: ${problem}` : 'no BOSS account is bound to this task; bind one explicitly, then resume' },
        });
      this.task = await this.transition('running', { account }, 'running');
      await this.event('account_bound', { detail: { binding: account.binding, source: seen ? 'window' : 'resolver' } });
    }
    this.account = this.task.account!;

    this.artifactStore = this.deps.artifacts(this.task);
    const report = await this.artifactStore.reconcile(this.store, this.taskId, this.signal);
    if (report.adopted.length || report.invalidated.length || report.discardedStaging.length)
      await this.event('reconciled', { detail: { adopted: report.adopted.length, invalidated: report.invalidated.length, discardedStaging: report.discardedStaging.length } });
    // What a crash left half-done goes back to be checked again from the page.
    for (const item of await this.store.listWorkItems(this.taskId, { status: ['processing', 'acquired', 'validated'] })) await this.reopen(item, 'resume_recheck');
    for (const item of await this.store.listWorkItems(this.taskId)) this.bySourceRef.set(item.ref.sourceRef, item);
    this.lastCommittedItemId = (await this.store.getCheckpoint(this.taskId))?.lastCommittedItemId;
    await this.writeIndex();
    await this.persistUsage();
  }

  private async selectSource(): Promise<void> {
    const result = await this.runUnit('select_source', this.context());
    if (result.ok) return;
    if (result.reason === 'job_not_found')
      throw new StopRun({ kind: 'end', status: 'failed', reason: 'fatal_error', error: { code: 'not_found', message: 'no job matches the task' } });
    throw new StopRun(this.unitStop(result, 'select_source'));
  }

  /** Candidates screen by screen until a stop is thrown. */
  private async walkList(): Promise<never> {
    const known = this.bySourceRef.size;
    const maxAdvances = Math.max(RUNNER_LIMITS.minAdvances, 4 * (this.task.input.browseLimit ?? this.task.input.requestedCount * 5) + known);
    let advances = 0;
    let stalled = 0;
    for (;;) {
      await this.checkStillRunning();
      await this.checkLimits();
      const listed = await this.runUnit('enumerate_candidates', this.context());
      if (!listed.ok) throw new StopRun(this.unitStop(listed, 'enumerate_candidates'));
      const listing = this.deps.workflow.listCandidates(listed.observation, this.account);
      this.cursor = JSON.stringify({ fingerprint: listing.fingerprint, advances });
      const seen = new Set<string>();
      for (const ref of listing.candidates) {
        if (seen.has(ref.sourceRef)) continue;
        seen.add(ref.sourceRef);
        await this.candidate(ref, listing);
      }
      await this.checkLimits();
      if (listing.endReached) throw new StopRun({ kind: 'end', status: 'partial', reason: 'source_exhausted' });

      if (++advances > maxAdvances)
        throw new StopRun({ kind: 'pause', error: { code: 'timeout', message: `the list was advanced ${maxAdvances} times without the task ending` } });
      const advanced = await this.runUnit('advance_list', this.context({ 'list.fingerprint': listing.fingerprint }));
      if (advanced.ok && advanced.reason === 'end_reached') {
        await this.checkLimits();
        throw new StopRun({ kind: 'end', status: 'partial', reason: 'source_exhausted' });
      }
      if (advanced.ok) {
        stalled = 0;
        continue;
      }
      if (WAIT_FOR_REASON[advanced.reason]) throw new StopRun(this.unitStop(advanced, 'advance_list'));
      if (++stalled >= RUNNER_LIMITS.maxStalledAdvances)
        throw new StopRun({ kind: 'pause', error: { code: 'timeout', message: `the list did not advance ${stalled} times in a row (${advanced.reason}); its end is not confirmed` } });
      await this.event('advance_failed', { unit: 'advance_list', result: 'failed', detail: { reason: advanced.reason, stalled } });
    }
  }

  // -------------------------------------------------------------------------
  // one candidate

  private async candidate(ref: CandidateRef, listing: CandidateListing): Promise<void> {
    await this.checkStillRunning();
    await this.checkLimits();
    const before = this.bySourceRef.get(ref.sourceRef);
    if (before && this.finishedWith(before)) return;
    if (ref.hints.includes('duplicate_row')) {
      await this.event('candidate_skipped', { detail: { why: 'duplicate_row' } });
      return;
    }

    const state: ItemState = { repairs: 0 };
    let item: WorkItem | undefined;
    try {
      await this.checkpoint('open_candidate', before?.id);
      const context = this.context({ 'candidate.name': ref.name }, { candidate: ref, ...(before ? { item: before } : {}) });
      const opened = await this.runUnit('open_candidate', context, state);
      if (!opened.ok) {
        if (WAIT_FOR_REASON[opened.reason] || opened.taskBudget) throw new StopRun(this.unitStop(opened, 'open_candidate'));
        await this.event('candidate_skipped', { unit: 'open_candidate', result: 'failed', detail: { why: opened.reason } });
        return;
      }

      // Identity is checked every time, before anything is attributed.
      const match = this.deps.workflow.identify(opened.observation, ref, this.account);
      if (match.kind !== 'match' || match.identity.accountKey !== this.account.accountKey) {
        const why = match.kind === 'match' ? 'identity_other_account' : match.kind === 'mismatch' ? 'identity_mismatch' : 'identity_ambiguous';
        if (before && !FINAL_ITEM.includes(before.status)) item = await this.moveItem(before, 'ambiguous', why);
        else await this.event('candidate_skipped', { unit: 'open_candidate', result: 'failed', detail: { why } });
        return;
      }
      item = await this.store.upsertWorkItem(this.taskId, match.identity, ref);
      this.bySourceRef.set(ref.sourceRef, item);
      if (this.finishedWith(item)) return;
      if (match.identity.confidence === 'weak') {
        // Too little evidence to attribute a file to this person.
        item = await this.moveItem(item, 'ambiguous', 'identity_weak');
        return;
      }
      if (item.attempt >= RUNNER_LIMITS.maxAttempts) {
        item = await this.moveItem(item, 'unavailable', 'too_many_attempts');
        return;
      }
      item = await this.moveItem(item, 'processing');
      await this.checkpoint('open_resume', item.id);
      const itemContext: UnitContext = { ...context, item };

      const resume = await this.runUnit('open_resume', itemContext, state);
      if (!resume.ok) {
        if (WAIT_FOR_REASON[resume.reason] || resume.taskBudget) throw new StopRun(this.unitStop(resume, 'open_resume'));
        item = await this.moveItem(item, resume.reason === 'request_dialog' ? 'unavailable' : 'failed', resume.reason);
        await this.backToList(itemContext, state);
        return;
      }

      item = await this.acquireAndCommit(item, itemContext);
      this.itemErrorsInRow = 0;
      await this.backToList({ ...itemContext, item }, state);
    } catch (error) {
      const stop = stopFor(error);
      if (error instanceof StopRun || stop.kind !== 'pause' || !candidateLocal(error)) {
        if (item) await this.reopen(item, stop.kind === 'interrupted' ? 'interrupted' : 'stopped').catch(() => undefined);
        throw error instanceof StopRun ? error : new StopRun(stop);
      }
      // An unexpected error on this candidate: record it and go on, but not forever.
      const { code, message } = errorOf(error);
      if (item) await this.failItem(item, `error_${code}`).catch(() => undefined);
      await this.event('candidate_error', { ...(item ? { itemId: item.id } : {}), result: 'failed', detail: { code, message } });
      if (++this.itemErrorsInRow >= RUNNER_LIMITS.maxItemErrorsInRow) throw new StopRun(stop);
      if (code === 'window_lost' && this.session) await this.session.rebind(this.signal);
    } finally {
      await this.persistUsage().catch(() => undefined);
    }
  }

  /** stage → acquire → validate → archive → commit → index; counts only when the commit says so. */
  private async acquireAndCommit(item: WorkItem, context: UnitContext): Promise<WorkItem> {
    const artifacts = this.artifactStore!;
    await this.checkStillRunning();
    await this.checkpoint('acquire_resume', item.id);
    const staging = await artifacts.stage(item.id, this.signal);
    const withStaging: UnitContext = { ...context, item, staging };
    const started = this.clock.now().getTime();
    const acquisition = await this.deps.workflow.acquireResume(withStaging, this.task.input.captureMode);
    throwIfAborted(this.signal);
    if (acquisition.status === 'unavailable') return this.moveItem(item, 'unavailable', acquisition.reason);
    if (acquisition.status === 'failed') {
      this.recorder.record({ type: 'unit', unit: 'acquire_resume', route: 'scripted', ok: false, elapsedMs: this.clock.now().getTime() - started });
      return this.moveItem(item, 'failed', acquisition.reason);
    }
    // Judged on the screen and staging as they are after the acquisition, not before it.
    const acquired = await this.deps.workflow.verifyUnit('acquire_resume', withStaging, await this.session!.observe({ elements: true }, this.signal));
    this.recorder.record({ type: 'unit', unit: 'acquire_resume', route: 'scripted', ok: acquired.ok, elapsedMs: this.clock.now().getTime() - started });
    if (!acquired.ok || acquisition.artifacts.length === 0) return this.moveItem(item, 'failed', `acquire_unverified: ${acquired.evidence.join('; ') || 'no files'}`);
    item = await this.moveItem(item, 'acquired', undefined, 'acquire_resume');

    const checked: Array<{ staged: StagedArtifact; validation: FileValidation }> = [];
    for (const staged of acquisition.artifacts) {
      if (staged.itemId !== item.id) throw new RuntimeError('invalid_input', `the workflow staged a file for item ${staged.itemId}, not ${item.id}`);
      checked.push({ staged, validation: await artifacts.validate(staged, this.signal) });
    }
    item = await this.moveItem(item, 'validated');

    await this.checkpoint('persist_candidate', item.id);
    const records: ArtifactRecord[] = [];
    for (const { staged, validation } of checked) {
      throwIfAborted(this.signal);
      if (!validation.exists || !validation.sha256) continue;
      // A file that failed validation is kept as a diagnostic; it never counts.
      const asFiled: StagedArtifact = validation.problems.length ? { ...staged, kind: 'diagnostic' } : staged;
      records.push(await artifacts.archive(asFiled, item.identity, validation, [], this.signal));
    }
    if (records.length === 0) return this.moveItem(item, 'failed', 'no_valid_artifact');
    const committed = await this.store.commitItem(item.id, records);
    item = committed.item;
    this.bySourceRef.set(item.ref.sourceRef, item);
    if (committed.counted) {
      const persisted = await this.deps.workflow.verifyUnit('persist_candidate', { ...withStaging, item }, await this.session!.observe({ elements: true }, this.signal));
      if (!persisted.ok) await this.event('persist_unverified', { itemId: item.id, unit: 'persist_candidate', result: 'failed', detail: { evidence: persisted.evidence } });
      this.lastCommittedItemId = item.id;
    }
    await this.writeIndex();
    return item;
  }

  /**
   * return_to_list after a candidate. A committed file stays committed if
   * this fails; the task moves to repairing and tries the unit once more.
   */
  private async backToList(context: UnitContext, state: ItemState): Promise<void> {
    await this.checkpoint('return_to_list', context.item?.id);
    const first = await this.runUnit('return_to_list', context, state);
    if (first.ok) return;
    if (WAIT_FOR_REASON[first.reason] || first.taskBudget) throw new StopRun(this.unitStop(first, 'return_to_list'));
    await this.setPhase('repairing');
    const second = await this.runUnit('return_to_list', context, state);
    if (!second.ok) throw new StopRun(this.unitStop(second, 'return_to_list'));
    await this.setPhase('executing');
  }

  // -------------------------------------------------------------------------
  // one unit

  private procedureKey(unit: BossUnitName): ProcedureKey {
    const { spec, profile } = this.deps;
    return { skill: spec.id, skillVersion: spec.version, unit, platform: 'macos', appVersion: profile.appVersion ?? 'unknown', profile: profile.id };
  }

  /**
   * One unit: replay a verified procedure, else the scripted path, each
   * confirmed by verifyUnit; on failure, recovery of this unit only.
   */
  private async runUnit(name: BossUnitName, context: UnitContext, state: ItemState = { repairs: 0 }): Promise<UnitResult> {
    await this.checkStillRunning();
    const { workflow, engine } = this.deps;
    const session = this.session!;
    const unit = workflow.units[name];
    const key = this.procedureKey(name);
    const outcomeItem = context.item?.id ?? `${this.taskId}.${name}`;
    const verify = (observation: Observation): Promise<CheckResult> => workflow.verifyUnit(name, context, observation);
    let failure: RecoveryContext['failure'] | undefined;
    let failedProcedureId: string | undefined;
    let scriptedReason: string | undefined;

    const procedure = unit.learnable ? await engine.select(key, this.signal) : undefined;
    if (procedure) {
      const started = this.clock.now().getTime();
      const replay = await engine.replay(procedure, session, context.bindings, this.signal);
      if (replay.status === 'cancelled') throw new RuntimeError('cancelled', 'the operation was cancelled');
      let check: CheckResult | undefined;
      let observation: Observation | undefined;
      if (replay.status === 'succeeded') {
        observation = replay.lastObservation ?? (await session.observe({ elements: true }, this.signal));
        check = await verify(observation);
      }
      const ok = check?.ok === true;
      this.recorder.record({ type: 'unit', unit: name, route: 'replay', ok, elapsedMs: this.clock.now().getTime() - started });
      if (ok && observation) {
        await engine.recordOutcome(procedure.id, { itemId: outcomeItem, ok: true });
        return { ok: true, observation };
      }
      // A page that explains the failure (login, captcha, request confirm) is not the procedure's fault.
      const fact = await this.pageFact(observation ?? replay.lastObservation);
      if (fact) return { ok: false, reason: fact };
      failure = check ? { status: 'verify_failed', check } : replay;
      failedProcedureId = procedure.id;
      // The deterministic path stays available before any model: the unit may
      // already be done (then nothing is sent again), else the scripted path runs.
      const fallback = await this.scriptedFallback(name, context, verify);
      if (fallback.ok) {
        await engine.recordOutcome(procedure.id, { itemId: outcomeItem, ok: false });
        await this.event('replay_fallback', { unit: name, ...(context.item ? { itemId: context.item.id } : {}), result: 'ok', detail: { procedureId: procedure.id, route: fallback.route } });
        return { ok: true, observation: fallback.observation, ...(fallback.reason ? { reason: fallback.reason } : {}) };
      }
      if (fallback.reason && NOT_REPAIRABLE.has(fallback.reason)) return { ok: false, reason: fallback.reason, ...(fallback.observation ? { observation: fallback.observation } : {}) };
      const later = fallback.observation && (await this.pageFact(fallback.observation));
      if (later) return { ok: false, reason: later, observation: fallback.observation };
      scriptedReason = fallback.reason;
    } else {
      const scripted = workflow.runScripted(name, context);
      if (scripted) {
        const started = this.clock.now().getTime();
        const result = await scripted;
        throwIfAborted(this.signal);
        const check = result.ok ? await verify(result.observation) : undefined;
        const ok = check?.ok === true;
        this.recorder.record({ type: 'unit', unit: name, route: 'scripted', ok, elapsedMs: this.clock.now().getTime() - started });
        if (ok) return { ok: true, observation: result.observation, ...(result.reason ? { reason: result.reason } : {}) };
        scriptedReason = result.ok ? `unverified: ${check!.evidence.join('; ')}` : (result.reason ?? 'scripted_failed');
        if (!result.ok && NOT_REPAIRABLE.has(scriptedReason)) return { ok: false, reason: scriptedReason, observation: result.observation };
        const fact = await this.pageFact(result.observation);
        if (fact) return { ok: false, reason: fact, observation: result.observation };
        failure = { status: 'verify_failed', check: check ?? { ok: false, evidence: [scriptedReason] } };
      } else {
        failure = { status: 'no_procedure' };
      }
    }

    // Only learnable units are repaired by recovery; the rest report their failure.
    if (!unit.learnable) return { ok: false, reason: scriptedReason ?? 'unit_failed' };
    const previousPhase = this.phase;
    await this.setPhase(failure.status === 'no_procedure' ? 'learning' : 'repairing');
    const recovered = await this.deps.recovery.recover(
      {
        unit,
        key,
        session,
        taskId: this.taskId,
        ...(context.item ? { itemId: context.item.id } : {}),
        bindings: context.bindings,
        failure,
        usage: this.usage(),
        budget: this.budget,
        itemRepairs: state.repairs,
        verify,
      },
      this.signal,
    );
    if (failedProcedureId) await engine.recordOutcome(failedProcedureId, { itemId: outcomeItem, ok: false });
    switch (recovered.status) {
      case 'cancelled':
        throw new RuntimeError('cancelled', 'the operation was cancelled');
      case 'model_unavailable':
        throw new StopRun({ kind: 'wait', reason: 'model_unavailable', error: { code: 'model_unavailable', message: `unit ${name} needs exploration and no model is available` } });
      case 'exhausted': {
        await this.setPhase(previousPhase);
        const taskBudget = typeof recovered.budget === 'object';
        if (recovered.budget === 'item_repairs') state.repairs = this.budget.modelRepairsPerItem;
        await this.event('unit_unrecovered', { unit: name, ...(context.item ? { itemId: context.item.id } : {}), result: 'failed', detail: { budget: recovered.budget } });
        return { ok: false, reason: taskBudget ? 'task_budget_exhausted' : `recovery_exhausted_${String(recovered.budget)}`, taskBudget };
      }
      case 'recovered':
        await this.setPhase(previousPhase);
        return { ok: true, observation: recovered.observation };
      case 'repaired': {
        state.repairs += 1;
        // The bridge already did everything in outcome.executed; learn from it, never send it again.
        if (recovered.proposal) {
          try {
            const learned = await this.deps.learner.accept(recovered.proposal, recovered.verification, outcomeItem);
            await this.event('procedure_learned', { unit: name, detail: { procedureId: learned.id, version: learned.version, status: learned.status } });
          } catch (error) {
            if (!isRuntimeError(error, 'invalid_input') && !isRuntimeError(error, 'conflict')) throw error;
            await this.event('proposal_rejected', { unit: name, result: 'failed', detail: { code: error.code, message: error.message } });
          }
        }
        await this.setPhase(previousPhase);
        return { ok: true, observation: await session.observe({ elements: true }, this.signal) };
      }
    }
  }

  /**
   * After a failed replay: a fresh check whether the unit is in fact done,
   * then the workflow's scripted path, each confirmed by the verifier.
   */
  private async scriptedFallback(
    name: BossUnitName,
    context: UnitContext,
    verify: (observation: Observation) => Promise<CheckResult>,
  ): Promise<{ ok: true; observation: Observation; route: 'verified' | 'scripted'; reason?: string } | { ok: false; reason?: string; observation?: Observation }> {
    const fresh = await this.session!.observe({ elements: true }, this.signal);
    if ((await verify(fresh)).ok) return { ok: true, observation: fresh, route: 'verified' };
    const scripted = this.deps.workflow.runScripted(name, context);
    if (!scripted) return { ok: false, observation: fresh };
    const started = this.clock.now().getTime();
    const result = await scripted;
    throwIfAborted(this.signal);
    const check = result.ok ? await verify(result.observation) : undefined;
    const ok = check?.ok === true;
    this.recorder.record({ type: 'unit', unit: name, route: 'scripted', ok, elapsedMs: this.clock.now().getTime() - started });
    if (ok) return { ok: true, observation: result.observation, route: 'scripted', ...(result.reason ? { reason: result.reason } : {}) };
    return { ok: false, reason: result.ok ? `unverified: ${check!.evidence.join('; ')}` : (result.reason ?? 'scripted_failed'), observation: result.observation };
  }

  /**
   * The business state a failed unit ended on, when the page shows one: the
   * user must log in or solve a captcha, or the resume is only available by
   * request. None of these is repaired by a model.
   */
  private async pageFact(observation: Observation | undefined): Promise<string | undefined> {
    const seen = observation ?? (await this.session!.observe({ elements: true }, this.signal));
    switch (this.deps.workflow.classifyPage(seen)) {
      case 'login':
        return 'login_required';
      case 'captcha':
        return 'captcha';
      case 'request_resume_dialog':
        return 'request_dialog';
      default:
        return undefined;
    }
  }

  /** The stop for a unit that failed where the run cannot simply go on. */
  private unitStop(result: Extract<UnitResult, { ok: false }>, unit: BossUnitName): Stop {
    const wait = WAIT_FOR_REASON[result.reason];
    if (wait) return { kind: 'wait', reason: wait };
    if (result.taskBudget) return { kind: 'end', status: 'partial', reason: 'budget_exhausted' };
    return { kind: 'pause', error: { code: 'io', message: `${unit} failed: ${result.reason}` } };
  }

  // -------------------------------------------------------------------------
  // limits, state and bookkeeping

  /** Throws the stop the task has reached: target, deadline, browse limit or budget. */
  private async checkLimits(): Promise<void> {
    const input = this.task.input;
    const counts = await this.store.counts(this.taskId);
    if (counts.committed >= input.requestedCount && (await this.deliveredCount()) >= input.requestedCount)
      throw new StopRun({ kind: 'end', status: 'succeeded', reason: 'target_reached' });
    if (input.deadline && this.clock.now().getTime() >= Date.parse(input.deadline)) throw new StopRun({ kind: 'end', status: 'partial', reason: 'deadline' });
    if (input.browseLimit !== undefined && counts.browsed >= input.browseLimit) throw new StopRun({ kind: 'end', status: 'partial', reason: 'browse_limit' });
    const budget = checkBudget(this.budget, this.usage());
    if (!budget.ok)
      throw new StopRun({ kind: 'end', status: 'partial', reason: 'budget_exhausted', error: { code: 'budget_exhausted', message: `task budget exhausted: ${budget.exhausted}` } });
  }

  /** Committed items whose countable files are on disk with the recorded bytes. */
  private async deliveredCount(): Promise<number> {
    const committed = await this.store.listWorkItems(this.taskId, { status: ['committed'] });
    const artifacts = await this.store.listArtifacts(this.taskId);
    const root = this.artifactStore?.root;
    let count = 0;
    for (const item of committed) {
      // Checked on disk every time: a file removed after its commit does not count.
      const present: ArtifactRecord[] = [];
      for (const a of artifacts) if (a.itemId === item.id && root && (await fileMatches(root, a))) present.push(a);
      if (isCountable(present, this.task.input.captureMode)) count += 1;
    }
    return count;
  }

  /** Stops the run if the signal fired or the task is no longer running (paused or cancelled elsewhere). */
  private async checkStillRunning(): Promise<void> {
    if (this.signal.aborted) throw new StopRun({ kind: 'interrupted' });
    const current = await this.store.getTask(this.taskId);
    if (!current || current.status !== 'running') throw new StopRun({ kind: 'interrupted' });
    this.task = { ...this.task, ...current };
  }

  private context(bindings: Record<string, string> = {}, extra: Partial<UnitContext> = {}): UnitContext {
    return { session: this.session!, task: this.task, bindings: { job: this.task.input.job, ...bindings }, signal: this.signal, ...extra };
  }

  private finishedWith(item: WorkItem): boolean {
    if (FINAL_ITEM.includes(item.status)) return true;
    return item.status === 'failed' && item.attempt >= RUNNER_LIMITS.maxFailedAttempts;
  }

  /** Moves an item, going through processing where the table needs it. */
  private async moveItem(item: WorkItem, to: WorkItemStatus, reason?: string, lastCompletedUnit?: string): Promise<WorkItem> {
    let current = item;
    if (!canTransitionWorkItem(current.status, to)) {
      if (!canTransitionWorkItem(current.status, 'processing') || !canTransitionWorkItem('processing', to))
        throw new RuntimeError('conflict', `item ${item.id} cannot move from ${current.status} to ${to}`);
      current = await this.store.transitionWorkItem(current.id, 'processing');
    }
    current = await this.store.transitionWorkItem(current.id, to, { ...(reason ? { reason } : {}), ...(lastCompletedUnit ? { lastCompletedUnit } : {}) });
    this.bySourceRef.set(current.ref.sourceRef, current);
    return current;
  }

  private async failItem(item: WorkItem, reason: string): Promise<void> {
    const current = (await this.store.listWorkItems(this.taskId)).find((i) => i.id === item.id);
    if (!current || ['committed', 'unavailable', 'ambiguous', 'failed', 'discovered'].includes(current.status)) return;
    await this.moveItem(current, 'failed', reason);
  }

  /** Puts a half-done item back to discovered so a later attempt checks it from the page again. */
  private async reopen(item: WorkItem, reason: string): Promise<void> {
    let current = (await this.store.listWorkItems(this.taskId)).find((i) => i.id === item.id);
    if (!current) return;
    if (current.status === 'acquired' || current.status === 'validated') current = await this.store.transitionWorkItem(current.id, 'processing', { reason });
    if (current.status === 'processing') current = await this.store.transitionWorkItem(current.id, 'discovered', { reason });
    this.bySourceRef.set(current.ref.sourceRef, current);
  }

  private async checkpoint(unit: BossUnitName, itemId?: string): Promise<void> {
    const checkpoint: TaskCheckpoint = { taskId: this.taskId, unit, updatedAt: this.now() };
    if (itemId) checkpoint.itemId = itemId;
    if (this.cursor) checkpoint.cursor = this.cursor;
    if (this.lastCommittedItemId) checkpoint.lastCommittedItemId = this.lastCommittedItemId;
    await this.store.saveCheckpoint(checkpoint);
  }

  private async setPhase(phase: TaskPhase): Promise<void> {
    if (phase === this.phase) return;
    try {
      this.task = await this.transition('running', { phase }, 'running');
      this.phase = phase;
    } catch (error) {
      if (isRuntimeError(error, 'conflict')) throw new StopRun({ kind: 'interrupted' });
      throw error;
    }
  }

  private transition(to: TaskStatus, patch: TaskPatch, from: TaskStatus): Promise<TaskRecord> {
    return this.store.transitionTask(this.taskId, to, patch, from);
  }

  private event(type: string, extra: { itemId?: string; unit?: string; result?: 'ok' | 'failed' | 'skipped'; detail?: Record<string, unknown> } = {}): Promise<void> {
    return this.store.appendEvent({ taskId: this.taskId, type, at: this.now(), ...extra });
  }

  private async writeIndex(): Promise<void> {
    const task = await this.store.getTask(this.taskId);
    if (!task || !this.artifactStore) return;
    await this.artifactStore.writeIndex(task, await this.store.listWorkItems(this.taskId), await this.store.listArtifacts(this.taskId));
  }

  /** Usage of every run of this task so far, this one included. */
  private usage(): Usage {
    if (!this.recorder) return this.prior;
    const delta = usageSince(this.recorder.usage(), this.recorderAtStart);
    return addUsage(this.prior, { ...delta, elapsedMs: Math.max(0, this.clock.now().getTime() - this.startedMs) });
  }

  private async persistUsage(): Promise<void> {
    await this.event('usage', { detail: { ...this.usage() } });
  }

  /** The usage the last run persisted; tokens it could not count stay unknown. */
  private async loadUsage(): Promise<Usage> {
    const latest = (events: Awaited<ReturnType<TaskStore['listEvents']>>) => events.filter((e) => e.type === 'usage').at(-1);
    let found = latest(await this.store.listEvents(this.taskId, { limit: 500 }));
    found ??= latest(await this.store.listEvents(this.taskId));
    if (!found?.detail) return emptyUsage();
    try {
      return parseUsage(found.detail);
    } catch {
      // A damaged record cannot prove what was spent.
      return { ...emptyUsage(), inputTokens: 'unknown', outputTokens: 'unknown' };
    }
  }

  // -------------------------------------------------------------------------
  // ending a run

  private async finish(stop: Stop): Promise<TaskOutcome> {
    let failure: unknown;
    const keep = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failure ??= error;
      }
    };
    const transitionFromRunning = async (to: TaskStatus, patch: TaskPatch) => {
      try {
        this.task = await this.transition(to, patch, 'running');
      } catch (error) {
        // Paused or cancelled meanwhile: that decision stands.
        if (!isRuntimeError(error, 'conflict')) throw error;
      }
    };

    // The actor stops first: once close resolves, nothing of this run acts again.
    const keepWindow = stop.kind === 'end' ? (this.task.input.keepWindow ?? false) : true;
    if (this.session) await keep(() => this.session!.close({ keepWindow }));

    switch (stop.kind) {
      case 'end':
        await keep(() =>
          transitionFromRunning(stop.status, { phase: 'finalizing', terminationReason: stop.reason, ...(stop.error ? { error: stop.error } : {}) }),
        );
        break;
      case 'wait':
        await keep(() => transitionFromRunning('waiting_user', { waitReason: stop.reason, ...(stop.error ? { error: stop.error } : {}) }));
        break;
      case 'pause':
        await keep(() => transitionFromRunning('paused', { error: stop.error }));
        break;
      case 'interrupted':
        // Paused, cancelled or shut down by whoever fired the signal; that
        // side owns the status. A task left running by a worker that stopped
        // is found as an orphan and paused by the next daemon.
        break;
    }
    await keep(() => this.event('run_finished', { detail: { stop: stop.kind, ...(stop.kind === 'end' ? { reason: stop.reason } : {}), ...(stop.kind === 'wait' ? { reason: stop.reason } : {}), ...(stop.kind === 'pause' ? { error: stop.error } : {}) } }));
    await keep(() => this.persistUsage());
    if (this.artifactStore) await keep(() => this.writeIndex());
    if (failure) throw failure;
    return this.outcome();
  }

  private async outcome(): Promise<TaskOutcome> {
    const task = (await this.store.getTask(this.taskId)) ?? this.task;
    const outcome: TaskOutcome = {
      taskId: this.taskId,
      status: task.status,
      counts: task.counts,
      usage: this.recorder ? this.usage() : await this.loadUsage(),
      outputPath: this.artifactStore?.root ?? join(task.input.outputDir, this.taskId),
    };
    if (task.terminationReason) outcome.terminationReason = task.terminationReason;
    if (task.waitReason) outcome.waitReason = task.waitReason;
    return outcome;
  }
}

/** Whether an archived file is on disk with the bytes the ledger recorded. */
async function fileMatches(root: string, artifact: ArtifactRecord): Promise<boolean> {
  const segments = artifact.relativePath.split('/');
  if (!segments.every(safePathSegment)) return false;
  const path = join(root, ...segments);
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size !== artifact.bytes) return false;
    return createHash('sha256').update(await readFile(path)).digest('hex') === artifact.sha256;
  } catch {
    return false;
  }
}
