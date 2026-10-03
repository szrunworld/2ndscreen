// Recovering a unit that failed: bounded local routes first (wait for the
// page to settle, resume the failed step with fresh locators, another
// verified local procedure), and only then the exploration bridge, within
// the item's and the task's model budget. Whatever the bridge executed is
// verified and learned from, never sent again.

import { randomUUID } from 'node:crypto';
import {
  BRIDGE_PROTOCOL_VERSION,
  RuntimeError,
  WAIT_LIMITS,
  addTokens,
  assertValid,
  checkBudget,
  isRuntimeError,
  systemClock,
  throwIfAborted,
  validateExplorationRequest,
  type BridgeEvent,
  type CheckResult,
  type Clock,
  type ExplorationOutcome,
  type ExplorationRequest,
  type ExplorerBridge,
  type ExplorerProvider,
  type Learner,
  type ModelCallReason,
  type ModelPurpose,
  type Observation,
  type ProcedureEngine,
  type ProcedureProposal,
  type ProcedureV2,
  type Session,
  type Recovery,
  type RecoveryContext,
  type RecoveryOutcome,
  type ReplayResult,
  type TelemetryRecorder,
  type TokenCount,
  type Usage,
} from './contracts.ts';
import { bindDeep, needsScreenshot, procedureOutsideUnit } from './procedures.ts';
import { assertTraceWithinUnit } from './learning.ts';

/** Longest a local "wait for the page to settle" may take. */
const LOCAL_WAIT_CAP_MS = 15_000;

type LocalRoute = 'wait' | 'relocate' | 'local_procedure';

const isReplay = (f: RecoveryContext['failure']): f is ReplayResult => 'procedureId' in f;

function modelReason(failure: RecoveryContext['failure']): ModelCallReason {
  if (failure.status === 'no_procedure') return 'missing_procedure';
  if (failure.status === 'postcondition_failed' || failure.status === 'verify_failed') return 'postcondition_failed';
  return 'replay_failed';
}

/** The last action of a failed step, if its outcome cannot be told. */
function failedStepUnknown(failure: ReplayResult): boolean {
  return failure.status === 'step_failed' && failure.actions.at(-1)?.status === 'unknown';
}

/**
 * Whether the failed step may be sent again: only when its last delivery
 * provably did nothing (refused, stale, or no effect on a read/navigation).
 * An unknown outcome, or no effect on an artifact step, is never repeated.
 */
function failedStepRepeatable(failure: ReplayResult, effect: string): boolean {
  const last = failure.actions.at(-1)?.status;
  if (last === 'failed' || last === 'stale_snapshot') return true;
  return last === 'no_effect' && (effect === 'read' || effect === 'navigation');
}

export function createRecovery(deps: {
  engine: ProcedureEngine;
  learner: Learner;
  explorer: ExplorerProvider;
  telemetry: TelemetryRecorder;
  clock?: Clock;
  newId?: () => string;
}): Recovery {
  const { engine, learner, explorer, telemetry } = deps;
  const clock = deps.clock ?? systemClock;
  const newId = deps.newId ?? randomUUID;

  async function recover(context: RecoveryContext, signal?: AbortSignal): Promise<RecoveryOutcome> {
    const { unit, key, session, bindings, failure, budget } = context;
    const started = clock.now().getTime();
    // What this recovery spent, on top of the usage the caller passed in.
    const spent = { calls: 0, ui: 0, repair: 0, input: 0 as TokenCount, output: 0 as TokenCount };
    const usageNow = (): Usage => ({
      ...context.usage,
      uiModelCalls: context.usage.uiModelCalls + spent.ui,
      repairModelCalls: context.usage.repairModelCalls + spent.repair,
      inputTokens: addTokens(context.usage.inputTokens, spent.input),
      outputTokens: addTokens(context.usage.outputTokens, spent.output),
      elapsedMs: context.usage.elapsedMs + (clock.now().getTime() - started),
    });

    /** Wall-clock time left for the task, fencing local work as well as the model. */
    const wallClockLeft = (): number => budget.wallClockMs - usageNow().elapsedMs;
    const wallClockOut = (): RecoveryOutcome => ({ status: 'exhausted', budget: { ok: false, exhausted: 'wall_clock' } });

    // The task's wall-clock deadline as a signal of its own: a timer for time
    // spent inside one long call, and a check of the clock before every
    // observation, check, wait and action. The caller's abort stays
    // `cancelled`; this one becomes `exhausted: wall_clock`.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(Math.max(0, wallClockLeft()), 2 ** 31 - 1));
    timer.unref?.();
    const local = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const fence = (): void => {
      if (!deadline.signal.aborted && wallClockLeft() <= 0) deadline.abort();
      throwIfAborted(local);
    };
    /** The session as local recovery may use it: every call fenced by the deadline, waits cut to the time left. */
    const fenced: Session = {
      get id() {
        return session.id;
      },
      get taskId() {
        return session.taskId;
      },
      get profile() {
        return session.profile;
      },
      get lease() {
        return session.lease;
      },
      binding: () => session.binding(),
      observe: async (options, s) => (fence(), session.observe(options, s ?? local)),
      act: async (request, s) => (fence(), session.act(request, s ?? local)),
      check: async (condition, observation, s) => (fence(), session.check(condition, observation, s ?? local)),
      waitFor: async (spec, s) => {
        fence();
        return session.waitFor({ ...spec, timeoutMs: Math.max(1, Math.min(spec.timeoutMs, wallClockLeft())) }, s ?? local);
      },
      rebind: async (s) => (fence(), session.rebind(s ?? local)),
      withExclusiveActor: (holder, fn, s) => (fence(), session.withExclusiveActor(holder, fn, s ?? local)),
      close: (policy) => session.close(policy),
    };

    async function observeAndVerify(): Promise<{ observation: Observation; check: CheckResult }> {
      const observation = await fenced.observe({ elements: true, screenshot: needsScreenshot(unit.postconditions) }, local);
      fence();
      const check = await context.verify(observation);
      // A verify that ran past the deadline proves nothing in time.
      fence();
      return { observation, check };
    }

    // The failed procedure, when it is still the one the engine would run.
    let failedProcedure: ProcedureV2 | undefined;
    const ended = (error: unknown): RecoveryOutcome | undefined => {
      if (signal?.aborted) return { status: 'cancelled' };
      if (deadline.signal.aborted || (isRuntimeError(error, 'cancelled') && wallClockLeft() <= 0)) return wallClockOut();
      if (isRuntimeError(error, 'cancelled')) return { status: 'cancelled' };
      return undefined;
    };

    async function tryRoute(route: LocalRoute): Promise<Observation | undefined> {
      switch (route) {
        case 'wait': {
          const conditions = bindDeep(unit.postconditions, bindings);
          if (conditions.length > 0) {
            const timeoutMs = Math.max(1, Math.min(unit.timeoutMs, WAIT_LIMITS.maxTimeoutMs, LOCAL_WAIT_CAP_MS, wallClockLeft()));
            const condition = conditions.length === 1 ? conditions[0]! : { kind: 'all' as const, conditions };
            const waited = await fenced.waitFor({ condition, timeoutMs }, local);
            if (!waited.ok) return undefined;
          }
          const { observation, check } = await observeAndVerify();
          return check.ok ? observation : undefined;
        }
        case 'relocate': {
          // Resume at the failed step with locators resolved afresh; the
          // steps before it already ran and are not sent again.
          if (!failedProcedure || !isReplay(failure) || !failure.failedStepId) return undefined;
          const from = failedProcedure.steps.findIndex((s) => s.id === failure.failedStepId);
          if (from < 0 || !failedStepRepeatable(failure, failedProcedure.steps[from]!.action.effect)) return undefined;
          const rest: ProcedureV2 = { ...failedProcedure, preconditions: [], steps: failedProcedure.steps.slice(from) };
          if (procedureOutsideUnit(rest, unit)) return undefined;
          const result = await engine.replay(rest, fenced, bindings, local);
          if (result.status === 'cancelled') throw new RuntimeError('cancelled', 'the operation was cancelled');
          if (result.status !== 'succeeded') return undefined;
          const { observation, check } = await observeAndVerify();
          return check.ok ? observation : undefined;
        }
        case 'local_procedure': {
          const other = await engine.select(key, local);
          if (!other || (isReplay(failure) && other.id === failure.procedureId)) return undefined;
          // Only a version that has verified at least once, and stays in the unit.
          if (other.counters.successes === 0 || procedureOutsideUnit(other, unit)) return undefined;
          const result = await engine.replay(other, fenced, bindings, local);
          if (result.status === 'cancelled') throw new RuntimeError('cancelled', 'the operation was cancelled');
          if (result.status !== 'succeeded') return undefined;
          const { observation, check } = await observeAndVerify();
          return check.ok ? observation : undefined;
        }
      }
    }

    function localRoutes(): LocalRoute[] {
      if (failure.status === 'no_procedure') return [];
      if (failure.status === 'step_failed') return failedStepUnknown(failure) ? ['wait', 'local_procedure'] : ['wait', 'relocate', 'local_procedure'];
      return ['wait', 'local_procedure'];
    }

    try {
      fence();
      if (isReplay(failure)) {
        const current = await engine.select(key, local);
        if (current?.id === failure.procedureId) failedProcedure = current;
      }

      // 1. Local recovery, at most budget.localRecoveriesPerStep attempts.
      let attempts = 0;
      for (const route of localRoutes()) {
        if (attempts >= budget.localRecoveriesPerStep) break;
        if (route === 'relocate' && !failedProcedure) continue;
        if (wallClockLeft() <= 0) return wallClockOut();
        attempts += 1;
        const observation = await tryRoute(route);
        telemetry.record({ type: 'local_recovery', unit: unit.name, ok: observation !== undefined });
        if (wallClockLeft() <= 0) return wallClockOut();
        if (observation) return { status: 'recovered', route, observation };
      }
      if (wallClockLeft() <= 0) return wallClockOut();

      // A step whose effect cannot be told must not be redone blindly by a
      // model either when it wrote an artifact or submitted something.
      if (isReplay(failure) && failedStepUnknown(failure)) {
        const step = failedProcedure?.steps.find((s) => s.id === failure.failedStepId);
        if (!step || step.action.effect === 'artifact' || step.action.effect === 'external-submit') return { status: 'exhausted', budget: 'local' };
      }

      // 2. Model repair through the bridge, bounded per item and per task.
      let repairs = context.itemRepairs;
      let bridge: ExplorerBridge | undefined;
      const reason = modelReason(failure);
      const fallbackPurpose: ModelPurpose = failure.status === 'no_procedure' ? 'ui' : 'repair';
      for (;;) {
        throwIfAborted(signal);
        if (repairs >= budget.modelRepairsPerItem) return { status: 'exhausted', budget: 'item_repairs' };
        const before = checkBudget(budget, usageNow());
        if (!before.ok) return { status: 'exhausted', budget: before };

        if (!bridge) {
          try {
            bridge = await explorer();
          } catch (error) {
            if (isRuntimeError(error, 'model_unavailable')) return { status: 'model_unavailable' };
            throw error;
          }
          // Creating the model client may itself take time.
          throwIfAborted(signal);
          const afterSetup = checkBudget(budget, usageNow());
          if (!afterSetup.ok) return { status: 'exhausted', budget: afterSetup };
        }
        repairs += 1;

        const used = usageNow();
        const callsLeft = budget.taskModelCalls - (used.uiModelCalls + used.repairModelCalls + used.analysisModelCalls);
        const tokensUsed = addTokens(used.inputTokens, used.outputTokens);
        const binding = session.binding();
        const request: ExplorationRequest = assertValid(
          validateExplorationRequest({
            v: BRIDGE_PROTOCOL_VERSION,
            taskId: context.taskId,
            unitAttemptId: newId(),
            session: { socket: binding.socket, screenId: binding.screenId, pid: binding.window.pid, windowId: binding.window.windowId },
            unit: {
              name: unit.name,
              goal: unit.goal,
              allowedEffects: unit.allowedEffects.filter((e) => e !== 'external-submit'),
              expectedPostconditions: bindDeep(unit.postconditions, bindings),
            },
            parameters: { ...bindings },
            budget: {
              maxRounds: Math.max(1, Math.min(budget.modelRoundsPerRepair, callsLeft)),
              ...(budget.taskTokens !== undefined && typeof tokensUsed === 'number' ? { maxTokens: Math.max(1, budget.taskTokens - tokensUsed) } : {}),
              timeoutMs: Math.max(1, Math.min(unit.timeoutMs, budget.wallClockMs - used.elapsedMs)),
            },
            submitAllowed: false,
          }),
          'exploration request',
        );

        const stop = new AbortController();
        let stopped: 'model_calls' | 'tokens' | 'rounds' | 'forbidden' | undefined;
        let violation: string | undefined;
        let seenCalls = 0;
        let seenInput: TokenCount = 0;
        let seenOutput: TokenCount = 0;
        let attemptCalls = 0;
        const attemptStarted = clock.now().getTime();
        // Stop the bridge once it has spent past a limit; reaching a limit
        // exactly lets the call that reached it finish its step.
        const overrun = (): typeof stopped => {
          const u = usageNow();
          if (u.uiModelCalls + u.repairModelCalls + u.analysisModelCalls > budget.taskModelCalls) return 'model_calls';
          const tokens = addTokens(u.inputTokens, u.outputTokens);
          if (budget.taskTokens !== undefined && (tokens === 'unknown' || tokens > budget.taskTokens)) return 'tokens';
          if (attemptCalls > request.budget.maxRounds) return 'rounds';
          return undefined;
        };
        const onEvent = (event: BridgeEvent): void => {
          if (event.type === 'model_usage') {
            seenCalls += 1;
            attemptCalls += 1;
            seenInput = addTokens(seenInput, event.inputTokens);
            seenOutput = addTokens(seenOutput, event.outputTokens);
            spent.calls += 1;
            if (event.purpose === 'ui') spent.ui += 1;
            else spent.repair += 1;
            spent.input = addTokens(spent.input, event.inputTokens);
            spent.output = addTokens(spent.output, event.outputTokens);
            telemetry.record({ type: 'model_call', purpose: event.purpose, reason: event.reason, unit: unit.name, itemId: context.itemId, inputTokens: event.inputTokens, outputTokens: event.outputTokens });
            stopped ??= overrun();
            if (stopped) stop.abort();
          } else if (event.type === 'action_started' || event.type === 'action_finished') {
            const effect = event.action.effect;
            if (effect === 'external-submit' || !unit.allowedEffects.includes(effect)) {
              violation ??= `bridge step ${event.stepId} has effect ${effect}, outside unit ${unit.name}`;
              stopped ??= 'forbidden';
              stop.abort();
            }
          }
        };

        const actorSignal = AbortSignal.any([local, stop.signal]);
        let outcome: ExplorationOutcome;
        try {
          fence();
          outcome = await session.withExclusiveActor('bridge', (grant) => bridge!.explore(request, grant, onEvent), actorSignal);
        } catch (error) {
          if (!(stopped && isRuntimeError(error, 'cancelled'))) throw error;
          outcome = { status: 'failed', failure: 'cancelled', executed: [], modelCalls: seenCalls, inputTokens: 0, outputTokens: 0 };
        }

        // Reconcile with what the bridge says it spent: calls it never
        // reported as events still count, with unknown tokens, and its token
        // totals count where they exceed the events. Then the limits are
        // checked again, so a silent overrun cannot pass as a repair.
        for (let i = seenCalls; i < outcome.modelCalls; i++) {
          spent.calls += 1;
          attemptCalls += 1;
          if (fallbackPurpose === 'ui') spent.ui += 1;
          else spent.repair += 1;
          spent.input = 'unknown';
          spent.output = 'unknown';
          telemetry.record({ type: 'model_call', purpose: fallbackPurpose, reason, unit: unit.name, itemId: context.itemId, inputTokens: 'unknown', outputTokens: 'unknown' });
        }
        const extra = (reported: TokenCount, seen: TokenCount): TokenCount => {
          if (seen === 'unknown') return 0; // already counted as unknown
          if (reported === 'unknown') return 'unknown';
          return Math.max(0, reported - seen);
        };
        spent.input = addTokens(spent.input, extra(outcome.inputTokens, seenInput));
        spent.output = addTokens(spent.output, extra(outcome.outputTokens, seenOutput));
        if (stopped !== 'forbidden') stopped = overrun() ?? stopped;

        try {
          assertTraceWithinUnit(unit, outcome.executed);
        } catch (error) {
          violation ??= (error as Error).message;
        }
        const route = failure.status === 'no_procedure' ? 'explore' : 'repair';
        if (violation) {
          telemetry.record({ type: 'unit', unit: unit.name, route, ok: false, elapsedMs: clock.now().getTime() - attemptStarted });
          throw new RuntimeError('forbidden_effect', violation, { unit: unit.name });
        }
        if (signal?.aborted) return { status: 'cancelled' };
        if (deadline.signal.aborted || wallClockLeft() <= 0) {
          telemetry.record({ type: 'unit', unit: unit.name, route, ok: false, elapsedMs: clock.now().getTime() - attemptStarted });
          return wallClockOut();
        }

        // A bridge that spent past the task budget is not a repair, even if the
        // screen now looks right; one that ran over its rounds is a failed attempt.
        if (stopped === 'model_calls' || stopped === 'tokens') {
          telemetry.record({ type: 'unit', unit: unit.name, route, ok: false, elapsedMs: clock.now().getTime() - attemptStarted });
          return { status: 'exhausted', budget: { ok: false, exhausted: stopped } };
        }
        if (outcome.status === 'finished' && stopped !== 'rounds') {
          // Verify independently; the bridge saying finished is not evidence.
          const { check } = await observeAndVerify();
          telemetry.record({ type: 'unit', unit: unit.name, route, ok: check.ok, elapsedMs: clock.now().getTime() - attemptStarted });
          if (check.ok) {
            let proposal: ProcedureProposal | undefined;
            if (unit.learnable && outcome.executed.length > 0) {
              try {
                const learned = learner.propose(unit, key, outcome.executed, bindings);
                proposal =
                  route === 'repair'
                    ? { ...learned, source: 'repair', ...(failedProcedure ? { parentVersion: failedProcedure.version } : {}) }
                    : learned;
              } catch (error) {
                if (!isRuntimeError(error, 'invalid_input')) throw error;
              }
            }
            fence();
            return { status: 'repaired', outcome, proposal, verification: check };
          }
          continue;
        }

        if (outcome.status !== 'finished' || stopped === 'rounds')
          telemetry.record({ type: 'unit', unit: unit.name, route, ok: false, elapsedMs: clock.now().getTime() - attemptStarted });
        if (outcome.failure === 'model_unavailable') return { status: 'model_unavailable' };
        if (outcome.failure === 'cancelled' && !stopped) return { status: 'cancelled' };
        // Failed for another reason (timeout, error, refused action): the
        // next attempt starts from the screen as it is now.
      }
    } catch (error) {
      const outcome = ended(error);
      if (outcome) return outcome;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { recover };
}
