// Selecting, replaying and versioning procedures (V2). The engine takes no
// model and no explorer: a stable procedure replays through the session
// alone, so it runs with no model configured and no network.
//
// Versions are immutable once inserted. Promotion and degradation go through
// nextProcedureState and only change status and counters; a rollback inserts
// an older definition again as the newest version.

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PROMOTION,
  RuntimeError,
  bindSlots,
  isRuntimeError,
  nextProcedureState,
  procedureKeyString,
  systemClock,
  throwIfAborted,
  validateProcedure,
  type Action,
  type ActionResult,
  type Bindings,
  type CheckResult,
  type Clock,
  type Condition,
  type EffectClass,
  type Locator,
  type Observation,
  type ProcedureEngine,
  type ProcedureKey,
  type ProcedureRepository,
  type ProcedureStatus,
  type ProcedureStep,
  type ProcedureV2,
  type PromotionRule,
  type ReplayResult,
  type Session,
  type TelemetryRecorder,
  type UnitDefinition,
  type WaitSpec,
} from './contracts.ts';

/** First version only: no runtime may store external-submit procedures. */
const POLICY = { submitAllowed: false } as const;

const SELECT_RANK: Partial<Record<ProcedureStatus, number>> = { stable: 0, trial: 1, seeded: 2 };

/** Fields whose strings are regular expressions: bound values go in escaped. */
const PATTERN_FIELDS = new Set(['labelPattern', 'pattern', 'titlePattern']);

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace every {{slot}} in a step, locator or condition. Values put into a
 * pattern are escaped, so a name like "李(前端)" matches itself and nothing
 * else. Throws `invalid_input` for an unbound slot.
 */
export function bindDeep<T>(value: T, bindings: Bindings): T {
  const escaped = Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, escapePattern(v)]));
  const walk = (v: unknown, field?: string): unknown => {
    if (typeof v === 'string') return bindSlots(v, field && PATTERN_FIELDS.has(field) ? escaped : bindings);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

/** The effects a procedure's steps declare, in order. */
export const procedureEffects = (procedure: Pick<ProcedureV2, 'steps'>): EffectClass[] => procedure.steps.map((s) => s.action.effect);

/**
 * Why a procedure may not run for a unit, or undefined when it may: it must
 * belong to that unit and every step must be an effect the unit allows.
 * external-submit is never allowed in the first version.
 */
export function procedureOutsideUnit(procedure: Pick<ProcedureV2, 'key' | 'steps'>, unit: Pick<UnitDefinition, 'name' | 'allowedEffects'>): string | undefined {
  if (procedure.key.unit !== unit.name) return `procedure is for unit ${procedure.key.unit}, not ${unit.name}`;
  for (const step of procedure.steps) {
    const effect = step.action.effect;
    if (effect === 'external-submit') return `step ${step.id} is external-submit`;
    if (!unit.allowedEffects.includes(effect)) return `step ${step.id} has effect ${effect} outside the unit`;
  }
  return undefined;
}

/** Whether a condition, at any depth, needs a screenshot: OCR and template locators read pixels. */
export function needsScreenshot(conditions: readonly Condition[]): boolean {
  return conditions.some((c) =>
    c.kind === 'all' || c.kind === 'any'
      ? needsScreenshot(c.conditions)
      : c.kind === 'element' && (c.locator.kind === 'ocr' || c.locator.kind === 'template'),
  );
}

const sameKey = (a: ProcedureKey, b: ProcedureKey): boolean => procedureKeyString(a) === procedureKeyString(b);

/** A failed delivery may try the next locator; an unknown outcome never is resent. */
function mayTryNextLocator(result: ActionResult, effect: EffectClass): boolean {
  if (result.status === 'failed' || result.status === 'stale_snapshot') return true;
  return result.status === 'no_effect' && (effect === 'read' || effect === 'navigation');
}

function withTarget(action: Action, target: Locator): Action {
  return action.kind === 'key' ? action : ({ ...action, target } as Action);
}

export function createProcedureEngine(deps: {
  repository: ProcedureRepository;
  rule?: PromotionRule;
  telemetry?: TelemetryRecorder;
  clock?: Clock;
  newId?: () => string;
}): ProcedureEngine {
  const { repository, telemetry } = deps;
  const rule = deps.rule ?? DEFAULT_PROMOTION;
  const clock = deps.clock ?? systemClock;
  const newId = deps.newId ?? randomUUID;

  async function checkAll(session: Session, conditions: Condition[], observation: Observation, signal?: AbortSignal): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    for (const condition of conditions) {
      throwIfAborted(signal);
      checks.push(await session.check(condition, observation, signal));
    }
    return checks;
  }

  async function replay(procedure: ProcedureV2, session: Session, bindings: Bindings, signal?: AbortSignal): Promise<ReplayResult> {
    const started = clock.now().getTime();
    const actions: ActionResult[] = [];
    const checks: CheckResult[] = [];
    let stepsRun = 0;
    let lastObservation: Observation | undefined;
    const done = (status: ReplayResult['status'], failedStepId?: string): ReplayResult => {
      telemetry?.record({ type: 'unit', unit: procedure.key.unit, route: 'replay', ok: status === 'succeeded', elapsedMs: clock.now().getTime() - started });
      return { status, procedureId: procedure.id, stepsRun, failedStepId, actions, checks, lastObservation };
    };

    // Refuse before any action: malformed or unauthorized definitions, and
    // versions that are not runnable.
    const validated = validateProcedure(procedure, POLICY);
    if (!validated.ok) throw new RuntimeError('invalid_input', `procedure ${procedure.id}: ${validated.errors.join('; ')}`, { errors: validated.errors });
    if (procedure.status === 'degraded' || procedure.status === 'retired')
      throw new RuntimeError('conflict', `procedure ${procedure.id} is ${procedure.status} and does not run`);
    for (const name of procedure.parameters)
      if (bindings[name] === undefined) throw new RuntimeError('invalid_input', `parameter ${name} has no binding`);
    const pre = bindDeep(procedure.preconditions, bindings);
    const post = bindDeep(procedure.postconditions, bindings);
    const steps: ProcedureStep[] = bindDeep(procedure.steps, bindings);

    try {
      if (pre.length > 0) {
        throwIfAborted(signal);
        lastObservation = await session.observe({ elements: true, screenshot: needsScreenshot(pre) }, signal);
        const preChecks = await checkAll(session, pre, lastObservation, signal);
        checks.push(...preChecks);
        if (preChecks.some((c) => !c.ok)) return done('precondition_failed');
      }

      for (const step of steps) {
        const action = step.action;
        const targets: Array<Locator | undefined> = 'target' in action && action.target ? [action.target, ...(step.fallbacks ?? [])] : [undefined];
        let result: ActionResult | undefined;
        for (const target of targets) {
          throwIfAborted(signal);
          result = await session.act({ actionId: newId(), action: target ? withTarget(action, target) : action }, signal);
          actions.push(result);
          if (result.status === 'ok' || !mayTryNextLocator(result, action.effect)) break;
        }
        stepsRun += 1;
        if (result?.status !== 'ok') return done('step_failed', step.id);
        if (step.expect) {
          throwIfAborted(signal);
          const check = await session.waitFor(step.expect as WaitSpec, signal);
          checks.push(check);
          if (!check.ok) return done('step_failed', step.id);
        }
      }

      throwIfAborted(signal);
      lastObservation = await session.observe({ elements: true, screenshot: needsScreenshot(post) }, signal);
      const postChecks = await checkAll(session, post, lastObservation, signal);
      checks.push(...postChecks);
      return done(postChecks.some((c) => !c.ok) ? 'postcondition_failed' : 'succeeded');
    } catch (error) {
      if (isRuntimeError(error, 'cancelled') || signal?.aborted) return done('cancelled');
      throw error;
    }
  }

  return {
    async select(key, signal) {
      throwIfAborted(signal);
      const versions = await repository.listProcedures(key);
      const runnable = versions.filter(
        (p) => sameKey(p.key, key) && SELECT_RANK[p.status] !== undefined && validateProcedure(p, POLICY).ok,
      );
      runnable.sort((a, b) => SELECT_RANK[a.status]! - SELECT_RANK[b.status]! || b.version - a.version);
      return runnable[0];
    },

    replay,

    async recordOutcome(procedureId, outcome) {
      if (!outcome.itemId) throw new RuntimeError('invalid_input', 'an outcome needs the work item it ran on');
      const procedure = await repository.getProcedure(procedureId);
      if (!procedure) throw new RuntimeError('not_found', `procedure ${procedureId} not found`);
      const next = nextProcedureState(procedure, outcome, rule);
      return repository.updateProcedureState(procedureId, { ...next, updatedAt: clock.now().toISOString() });
    },

    async rollback(key, toVersion) {
      const versions = await repository.listProcedures(key);
      const target = versions.find((p) => p.version === toVersion && sameKey(p.key, key));
      if (!target) throw new RuntimeError('not_found', `no version ${toVersion} under ${procedureKeyString(key)}`);
      // A version still marked stable earned it. A degraded one may never
      // have: its cumulative successes need not have been consecutive or
      // distinct, so it comes back as trial and must earn stable again.
      if (target.status !== 'stable' && target.status !== 'degraded')
        throw new RuntimeError('conflict', `version ${toVersion} is ${target.status} and was never proven stable`);
      if (target.counters.successes === 0) throw new RuntimeError('conflict', `version ${toVersion} has no verified success`);
      const now = clock.now().toISOString();
      const restored: ProcedureV2 = {
        ...structuredClone(target),
        id: newId(),
        version: Math.max(...versions.map((p) => p.version)) + 1,
        parentVersion: toVersion,
        status: target.status === 'stable' ? 'stable' : 'trial',
        counters: { successes: target.counters.successes, failures: 0, consecutiveFailures: 0, successItemIds: [] },
        createdAt: now,
        updatedAt: now,
      };
      const validated = validateProcedure(restored, POLICY);
      if (!validated.ok) throw new RuntimeError('invalid_input', `rollback of version ${toVersion}: ${validated.errors.join('; ')}`);
      await repository.insertProcedure(restored);
      return restored;
    },
  };
}

// ---------------------------------------------------------------------------
// Procedure V1 import

const V1_SLOT = /⟦(\d+)⟧/g;
const v1Slots = (text: string): string => text.replace(V1_SLOT, (_, n: string) => `{{slot${n}}}`);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A V1 ElementRef as a semantic locator; undefined for an unnamed control. */
function v1Locator(target: unknown): Locator | undefined {
  if (!isObj(target)) return undefined;
  const role = str(target.role)?.trim();
  const label = str(target.label)?.trim();
  if (!role || !label) return undefined;
  // "⟦0⟧…" means the label starts with what the slot holds.
  if (label.endsWith('…')) {
    const head = label.slice(0, -1);
    if (!head) return undefined;
    const pattern = head.split(V1_SLOT).map((part, i) => (i % 2 === 1 ? `{{slot${part}}}` : escapePattern(part))).join('');
    return { kind: 'element', role, labelPattern: `^${pattern}` };
  }
  return { kind: 'element', role, label: v1Slots(label) };
}

function v1Step(raw: unknown, index: number): ProcedureStep | 'skip' | undefined {
  if (!isObj(raw)) return undefined;
  const kind = str(raw.kind);
  if (kind === 'wait') return 'skip';
  // Every imported step acts on a named control: a key press or a typed or
  // scrolled text with no control, or a point aimed by sight inside one, is not.
  if (raw.offsetX !== undefined || raw.offsetY !== undefined) return undefined;
  const target = v1Locator(raw.target);
  if (!target) return undefined;
  const id = `v1-${index + 1}`;
  switch (kind) {
    case 'click': {
      const count = raw.count === 2 ? 2 : undefined;
      const button = raw.button === 'right' ? 'right' : undefined;
      return { id, action: { kind: 'click', target, ...(count ? { count } : {}), ...(button ? { button } : {}), effect: 'navigation' } };
    }
    case 'type': {
      const value = str(raw.value);
      if (value === undefined) return undefined;
      return { id, action: { kind: 'type', target, value: v1Slots(value), effect: 'navigation' } };
    }
    case 'scroll': {
      const direction = str(raw.direction);
      return {
        id,
        action: {
          kind: 'scroll',
          target,
          direction: direction as 'down',
          ...(typeof raw.amount === 'number' ? { amount: raw.amount } : {}),
          ...(raw.by === 'line' || raw.by === 'page' ? { by: raw.by } : {}),
          effect: 'read',
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * Turn a TarsAgent V1 procedure (one entry of ~/.config/2ndscreen/procedures/<app>.json)
 * into a seeded V2 version. Only procedures whose every step (waits aside)
 * clicks, types into or scrolls a control named by role and label are
 * imported; a key press, a step with no control, a point aimed by sight, or a
 * procedure learned with sending allowed returns undefined. V1 has no pre/postconditions, so the result is
 * always seeded and must earn trial and stable here. V1 slots ⟦n⟧ become
 * {{slotN}} parameters. The result is version 1; a caller inserting it under
 * a key that already has versions renumbers it. Nothing is written back.
 */
export function importV1Procedure(v1: unknown, key: ProcedureKey, now: Date): ProcedureV2 | undefined {
  if (!isObj(v1) || v1.allowSubmit !== false || !Array.isArray(v1.steps)) return undefined;
  const steps: ProcedureStep[] = [];
  for (const [i, raw] of v1.steps.entries()) {
    const step = v1Step(raw, i);
    if (step === undefined) return undefined;
    if (step !== 'skip') steps.push(step);
  }
  if (steps.length === 0) return undefined;
  const parameters = [...new Set(steps.flatMap((s) => [...JSON.stringify(s.action).matchAll(/\{\{(slot\d+)\}\}/g)].map((m) => m[1]!)))].sort();
  const at = now.toISOString();
  const procedure: ProcedureV2 = {
    schemaVersion: 2,
    id: randomUUID(),
    key: { ...key },
    version: 1,
    status: 'seeded',
    source: 'v1-import',
    parameters,
    preconditions: [],
    postconditions: [],
    steps,
    counters: { successes: 0, failures: 0, consecutiveFailures: 0, successItemIds: [] },
    createdAt: at,
    updatedAt: at,
  };
  return validateProcedure(procedure, POLICY).ok ? procedure : undefined;
}
