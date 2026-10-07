// What the task runner does for its own skills, offered to any agent as a
// protocol service (RFC 0001, "units"): `run_unit` asks the runtime to bring
// the app to a state the agent describes by postconditions, and the runtime
// gets there the way the runner does — the unit may already be done; else a
// verified procedure learned for this agent, app version and window profile
// is replayed; else recovery: bounded local routes (wait, relocate, another
// local procedure), then the exploration bridge, within the task's model
// budget. Every success is judged by the agent's postconditions, checked by
// the runtime on a fresh observation; a model saying it finished is not
// evidence. What the bridge did is learned as a trial procedure and promoted
// to stable after verified successes on distinct items, so the next agent
// run replays it without a model.
//
// Units may only navigate and read: external-submit never goes through a
// replayed or explored path, only through the agent's own act and the check
// chain.

import {
  DEFAULT_BUDGET,
  RuntimeError,
  emptyUsage,
  validateCondition,
  type Bindings,
  type Budget,
  type CheckResult,
  type Condition,
  type EffectClass,
  type ExplorerProvider,
  type Learner,
  type Observation,
  type ProcedureEngine,
  type ProcedureKey,
  type RecoveryContext,
  type Session,
  type UnitDefinition,
  type Usage,
} from './contracts.ts';
import { bindDeep } from './procedures.ts';
import { createRecovery } from './recovery.ts';
import { createTelemetry, addUsage } from './telemetry.ts';

export type { AgentUnit } from './agent-contracts.ts';
import type { AgentUnit } from './agent-contracts.ts';

export const UNIT_LIMITS = { maxTimeoutMs: 300_000, defaultTimeoutMs: 120_000, maxConditions: 16 } as const;

const UNIT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const UNIT_EFFECTS: readonly EffectClass[] = ['read', 'navigation', 'artifact'];

/** Problems with a unit an agent sent, given the effects its manifest declares; empty when it may run. */
export function unitProblems(raw: unknown, declared: readonly EffectClass[]): { errors: string[]; forbidden: boolean } {
  const errors: string[] = [];
  let forbidden = false;
  const u = raw as Partial<AgentUnit> | null;
  if (typeof u !== 'object' || u === null) return { errors: ['unit must be an object'], forbidden };
  if (typeof u.name !== 'string' || !UNIT_NAME.test(u.name)) errors.push('unit.name must be lowercase letters, digits and "_"');
  if (typeof u.goal !== 'string' || u.goal.trim() === '' || u.goal.length > 500) errors.push('unit.goal must be a sentence of at most 500 characters');
  if (!Array.isArray(u.allowedEffects) || u.allowedEffects.length === 0) errors.push('unit.allowedEffects must list effects');
  else
    for (const e of u.allowedEffects) {
      if (e === 'external-submit') forbidden = true;
      else if (!UNIT_EFFECTS.includes(e)) errors.push(`unit.allowedEffects has ${String(e)}`);
      else if (!declared.includes(e)) errors.push(`unit.allowedEffects has ${e}, which the agent does not declare`);
    }
  const conditions = (list: unknown, name: string, required: boolean) => {
    if (list === undefined && !required) return;
    if (!Array.isArray(list) || (required && list.length === 0) || list.length > UNIT_LIMITS.maxConditions) {
      errors.push(`unit.${name} must be a list of 1 to ${UNIT_LIMITS.maxConditions} conditions`);
      return;
    }
    list.forEach((c, i) => {
      errors.push(...validateCondition(c, `unit.${name}[${i}]`));
      if (mentions(c, 'file')) errors.push(`unit.${name}[${i}] may not check files`);
      if (mentions(c, 'page')) errors.push(`unit.${name}[${i}] may not use page classes, which only builtin skills have`);
    });
  };
  conditions(u.postconditions, 'postconditions', true);
  conditions(u.preconditions, 'preconditions', false);
  if (u.learnable !== undefined && typeof u.learnable !== 'boolean') errors.push('unit.learnable must be boolean');
  if (u.timeoutMs !== undefined && (!Number.isInteger(u.timeoutMs) || u.timeoutMs < 1000 || u.timeoutMs > UNIT_LIMITS.maxTimeoutMs))
    errors.push(`unit.timeoutMs must be 1000..${UNIT_LIMITS.maxTimeoutMs}`);
  return { errors, forbidden };
}

function mentions(c: unknown, kind: string): boolean {
  const x = c as { kind?: unknown; conditions?: unknown } | null;
  if (!x || typeof x !== 'object') return false;
  if (x.kind === kind) return true;
  return Array.isArray(x.conditions) && x.conditions.some((child) => mentions(child, kind));
}

export interface UnitRunRequest {
  agentId: string;
  agentVersion: string;
  taskId: string;
  /** The business item the unit is for; distinct items are what promote a procedure. */
  itemId?: string;
  profile: { id: string; appVersion?: string };
  unit: AgentUnit;
  bindings: Bindings;
  session: Session;
  budget?: Budget;
}

export type UnitRoute = 'verified' | 'replay' | 'recovered' | 'repaired';

export type UnitRunResult =
  | { ok: true; route: UnitRoute; observation: Observation; check: CheckResult; procedure?: { id: string; version: number; status: string }; usage: Usage }
  | { ok: false; reason: 'unrecovered' | 'model_unavailable' | 'budget_exhausted' | 'not_learnable' | 'cancelled'; message: string; observation?: Observation; usage: Usage };

type WithoutUsage<T> = T extends unknown ? Omit<T, 'usage'> : never;

export interface UnitService {
  run(request: UnitRunRequest, signal: AbortSignal): Promise<UnitRunResult>;
  /** What a task has spent on units so far. */
  usage(taskId: string): Usage;
  /** Forget a task that ended. */
  release(taskId: string): void;
}

export interface UnitServiceDeps {
  engine: ProcedureEngine;
  learner: Learner;
  /** The exploration bridge, made only when a unit needs it. */
  explorer: ExplorerProvider;
}

/** The procedure key of an agent's unit: never shared with another agent, app version or window profile. */
export function agentUnitKey(request: Pick<UnitRunRequest, 'agentId' | 'agentVersion' | 'profile'>, unit: string): ProcedureKey {
  return { skill: `agent:${request.agentId}`, skillVersion: request.agentVersion, unit, platform: 'macos', appVersion: request.profile.appVersion ?? 'unknown', profile: request.profile.id };
}

export function createUnitService(deps: UnitServiceDeps): UnitService {
  const spentByTask = new Map<string, Usage>();
  /** Model repairs per item, as the runner bounds them. */
  const repairsByItem = new Map<string, number>();

  async function run(request: UnitRunRequest, signal: AbortSignal): Promise<UnitRunResult> {
    const { session, unit, taskId } = request;
    const started = Date.now();
    const budget = request.budget ?? DEFAULT_BUDGET;
    const definition: UnitDefinition = {
      name: unit.name,
      goal: unit.goal,
      allowedEffects: unit.allowedEffects,
      preconditions: unit.preconditions ?? [],
      postconditions: unit.postconditions,
      learnable: unit.learnable ?? true,
      timeoutMs: unit.timeoutMs ?? UNIT_LIMITS.defaultTimeoutMs,
    };
    // Postconditions may name the bindings as {{slots}}: the stored procedure keeps the slots, the check uses the values.
    const all: Condition = bindDeep({ kind: 'all', conditions: unit.postconditions }, request.bindings);
    const verify = (observation: Observation): Promise<CheckResult> => session.check(all, observation, signal);
    const key = agentUnitKey(request, unit.name);
    const outcomeItem = request.itemId ?? `${taskId}.${unit.name}`;
    const telemetry = createTelemetry();
    const before = spentByTask.get(taskId) ?? emptyUsage();
    const usageNow = (): Usage => {
      const delta = telemetry.usage();
      return { ...addUsage(before, delta), elapsedMs: before.elapsedMs + (Date.now() - started) };
    };
    const done = (result: WithoutUsage<UnitRunResult>): UnitRunResult => {
      const usage = usageNow();
      spentByTask.set(taskId, usage);
      return { ...result, usage } as UnitRunResult;
    };

    // Already done: nothing is sent.
    const fresh = await session.observe({ elements: true }, signal);
    const now = await verify(fresh);
    if (now.ok) return done({ ok: true, route: 'verified', observation: fresh, check: now });

    let failure: RecoveryContext['failure'] = { status: 'no_procedure' };
    let failedProcedureId: string | undefined;
    if (definition.learnable) {
      const procedure = await deps.engine.select(key, signal);
      if (procedure) {
        const replay = await deps.engine.replay(procedure, session, request.bindings, signal);
        if (replay.status === 'cancelled') return done({ ok: false, reason: 'cancelled', message: 'the unit was cancelled' });
        telemetry.record({ type: 'unit', unit: unit.name, route: 'replay', ok: replay.status === 'succeeded', elapsedMs: Date.now() - started });
        let check: CheckResult | undefined;
        let observation: Observation | undefined;
        if (replay.status === 'succeeded') {
          observation = await session.observe({ elements: true }, signal);
          check = await verify(observation);
        }
        if (check?.ok && observation) {
          const updated = await deps.engine.recordOutcome(procedure.id, { itemId: outcomeItem, ok: true });
          return done({ ok: true, route: 'replay', observation, check, procedure: { id: updated.id, version: updated.version, status: updated.status } });
        }
        failure = check ? { status: 'verify_failed', check } : replay;
        failedProcedureId = procedure.id;
      }
    } else {
      return done({ ok: false, reason: 'not_learnable', message: 'the unit is not done and may not be repaired', observation: fresh });
    }

    const itemKey = `${taskId}/${outcomeItem}`;
    const recovery = createRecovery({ engine: deps.engine, learner: deps.learner, explorer: deps.explorer, telemetry });
    const recovered = await recovery.recover(
      {
        unit: definition,
        key,
        session,
        taskId,
        ...(request.itemId !== undefined && { itemId: request.itemId }),
        bindings: request.bindings,
        failure,
        usage: before,
        budget,
        itemRepairs: repairsByItem.get(itemKey) ?? 0,
        verify,
      },
      signal,
    );
    if (failedProcedureId) await deps.engine.recordOutcome(failedProcedureId, { itemId: outcomeItem, ok: false });
    switch (recovered.status) {
      case 'cancelled':
        return done({ ok: false, reason: 'cancelled', message: 'the unit was cancelled' });
      case 'model_unavailable':
        return done({ ok: false, reason: 'model_unavailable', message: `unit ${unit.name} needs exploration and no model is available` });
      case 'exhausted':
        return done({
          ok: false,
          reason: typeof recovered.budget === 'object' ? 'budget_exhausted' : 'unrecovered',
          message: `unit ${unit.name} was not reached: ${typeof recovered.budget === 'object' ? `task budget (${recovered.budget.ok ? '' : recovered.budget.exhausted})` : String(recovered.budget)}${recovered.lastFailure ? `; ${recovered.lastFailure}` : ''}`,
        });
      case 'recovered': {
        const check = await verify(recovered.observation);
        return done({ ok: true, route: 'recovered', observation: recovered.observation, check });
      }
      case 'repaired': {
        repairsByItem.set(itemKey, (repairsByItem.get(itemKey) ?? 0) + 1);
        let procedure: { id: string; version: number; status: string } | undefined;
        if (recovered.proposal) {
          try {
            const learned = await deps.learner.accept(recovered.proposal, recovered.verification, outcomeItem);
            procedure = { id: learned.id, version: learned.version, status: learned.status };
          } catch (error) {
            // A proposal the learner will not keep does not undo what was verified.
            if (!(error instanceof RuntimeError) || (error.code !== 'invalid_input' && error.code !== 'conflict')) throw error;
          }
        }
        const observation = await session.observe({ elements: true }, signal);
        return done({ ok: true, route: 'repaired', observation, check: recovered.verification, ...(procedure && { procedure }) });
      }
    }
  }

  return {
    run,
    usage: (taskId) => spentByTask.get(taskId) ?? emptyUsage(),
    release(taskId) {
      spentByTask.delete(taskId);
      for (const k of [...repairsByItem.keys()]) if (k.startsWith(`${taskId}/`)) repairsByItem.delete(k);
    },
  };
}
