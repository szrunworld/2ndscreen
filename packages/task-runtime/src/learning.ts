// Turning an executed trace into a procedure, and storing it as a new trial
// version once a local verifier has passed. The learner never acts: the trace
// it reads was already executed, by the bridge or by a scripted unit.

import { randomUUID } from 'node:crypto';
import {
  RuntimeError,
  SLOT_PATTERN,
  WAIT_LIMITS,
  isRuntimeError,
  procedureKeyString,
  systemClock,
  validateProcedure,
  type Action,
  type Bindings,
  type CheckResult,
  type Clock,
  type Condition,
  type ExecutedStep,
  type Learner,
  type Locator,
  type ProcedureProposal,
  type ProcedureRepository,
  type ProcedureStep,
  type ProcedureV2,
  type UnitDefinition,
} from './contracts.ts';

const POLICY = { submitAllowed: false } as const;

/** Values shorter than this are left literal: "1" would match by accident. */
const MIN_SLOT_VALUE = 2;

const PATTERN_FIELDS = new Set(['labelPattern', 'pattern', 'titlePattern']);
/** Only text a page shows or a step types becomes a slot; roles, kinds and effects never do. */
const TEXT_FIELDS = new Set(['label', 'text', 'value', ...PATTERN_FIELDS]);
const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces each bound value in the strings of a step with its {{slot}},
 * longest value first, in one pass so a slot is never rewritten. Inside
 * patterns the value is matched in its escaped form.
 */
function slotter(bindings: Bindings): <T>(value: T) => T {
  const entries = Object.entries(bindings)
    .filter(([, v]) => v.trim().length >= MIN_SLOT_VALUE)
    .sort((a, b) => b[1].length - a[1].length);
  // A short value is a slot only where it is the whole text, as a key labelled "7" for digit 7;
  // inside longer text it would match by accident.
  const whole = new Map(Object.entries(bindings).filter(([, v]) => v.trim().length > 0 && v.trim().length < MIN_SLOT_VALUE).map(([name, v]) => [v, name]));
  const exact = (s: string): string | undefined => (whole.has(s) ? `{{${whole.get(s)}}}` : undefined);
  if (entries.length === 0) {
    if (whole.size === 0) return (v) => v;
    const walkShort = (v: unknown, field?: string): unknown => {
      if (typeof v === 'string') return field && TEXT_FIELDS.has(field) && !PATTERN_FIELDS.has(field) ? (exact(v) ?? v) : v;
      if (Array.isArray(v)) return v.map((x) => walkShort(x));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walkShort(x, k)]));
      return v;
    };
    return <T>(value: T) => walkShort(value) as T;
  }
  const build = (escape: boolean) => {
    const byText = new Map(entries.map(([name, v]) => [escape ? escapePattern(v) : v, name]));
    const regex = new RegExp([...byText.keys()].map(escapePattern).join('|'), 'g');
    return (s: string) => s.replace(regex, (m) => `{{${byText.get(m)}}}`);
  };
  const plain = build(false);
  const pattern = build(true);
  const walk = (v: unknown, field?: string): unknown => {
    if (typeof v === 'string') {
      if (!field || !TEXT_FIELDS.has(field)) return v;
      return PATTERN_FIELDS.has(field) ? pattern(v) : (exact(v) ?? plain(v));
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return <T>(value: T) => walk(value) as T;
}

function slotsIn(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(SLOT_PATTERN)].map((m) => m[1]!);
}

/**
 * Locators that survive a new snapshot: an element index never does. A
 * coordinate the model chose is mapped to the element it resolved to, when
 * that element has a role and a label, and kept as the fallback.
 */
function storableTargets(step: ExecutedStep, target: Locator): Locator[] {
  const resolved = step.resolvedElement;
  const semantic: Locator | undefined =
    resolved && resolved.role && resolved.label?.trim() ? { kind: 'element', role: resolved.role, label: resolved.label.trim() } : undefined;
  if (target.kind === 'element' && target.index !== undefined) {
    const { index: _index, ...rest } = target;
    if (rest.role || rest.label || rest.labelPattern) return [rest];
    if (semantic) return [semantic];
    throw new RuntimeError('invalid_input', `step ${step.stepId} only names a snapshot element index and cannot be stored`);
  }
  if (target.kind === 'element' || !semantic) return [target];
  return [semantic, target];
}

function toStep(step: ExecutedStep, index: number, unit: UnitDefinition): ProcedureStep {
  const action = structuredClone(step.action);
  let fallbacks: Locator[] | undefined;
  if (action.kind !== 'key' && action.target) {
    const [primary, ...rest] = storableTargets(step, action.target);
    (action as Extract<Action, { target?: Locator }>).target = primary!;
    if (rest.length) fallbacks = rest;
  }
  const out: ProcedureStep = { id: `step-${index + 1}`, action };
  if (fallbacks) out.fallbacks = fallbacks;
  // The page the step led to, when it changed, is waited for on replay.
  const after = step.after?.pageClass;
  if (after && after !== step.before?.pageClass) {
    out.expect = {
      condition: { kind: 'page', pageClass: after },
      timeoutMs: Math.min(Math.max(1, unit.timeoutMs), WAIT_LIMITS.maxTimeoutMs),
    };
  }
  return out;
}

/** Throws `forbidden_effect` for any step outside the unit's allowed effects. */
export function assertTraceWithinUnit(unit: Pick<UnitDefinition, 'name' | 'allowedEffects'>, trace: readonly ExecutedStep[]): void {
  for (const step of trace) {
    const effect = step.action.effect;
    if (effect === 'external-submit' || !unit.allowedEffects.includes(effect))
      throw new RuntimeError('forbidden_effect', `step ${step.stepId} has effect ${effect}, outside unit ${unit.name}`, { stepId: step.stepId, effect });
  }
}

function draft(proposal: ProcedureProposal, at: string, extra: Partial<ProcedureV2> = {}): ProcedureV2 {
  return {
    schemaVersion: 2,
    id: 'draft',
    key: proposal.key,
    version: (proposal.parentVersion ?? 0) + 1,
    parentVersion: proposal.parentVersion,
    status: 'trial',
    source: proposal.source,
    parameters: proposal.parameters,
    preconditions: proposal.preconditions,
    postconditions: proposal.postconditions,
    steps: proposal.steps,
    counters: { successes: 0, failures: 0, consecutiveFailures: 0, successItemIds: [] },
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function assertProposal(proposal: ProcedureProposal, at: string): void {
  const result = validateProcedure(draft(proposal, at), POLICY);
  if (!result.ok) throw new RuntimeError('invalid_input', `procedure proposal: ${result.errors.join('; ')}`, { errors: result.errors });
}

function validEvidence(verification: CheckResult): boolean {
  return (
    verification.ok === true &&
    Array.isArray(verification.evidence) &&
    verification.evidence.length > 0 &&
    verification.evidence.every((e) => typeof e === 'string' && e.trim() !== '')
  );
}

export function createLearner(deps: { repository: ProcedureRepository; clock?: Clock; newId?: () => string }): Learner {
  const { repository } = deps;
  const clock = deps.clock ?? systemClock;
  const newId = deps.newId ?? randomUUID;

  return {
    propose(unit, key, trace, bindings) {
      if (key.unit !== unit.name) throw new RuntimeError('invalid_input', `key is for unit ${key.unit}, not ${unit.name}`);
      if (!unit.learnable) throw new RuntimeError('invalid_input', `unit ${unit.name} does not store procedures`);
      assertTraceWithinUnit(unit, trace);
      // Steps that did nothing (refused, stale, no effect) are not part of the
      // path; an unknown outcome may have done something and is kept.
      const kept = trace.filter((s) => s.result.status === 'ok' || s.result.status === 'unknown');
      if (kept.length === 0) throw new RuntimeError('invalid_input', `nothing in the trace of ${unit.name} took effect`);
      const slot = slotter(bindings);
      const steps = kept.map((s, i) => slot(toStep(s, i, unit)));
      const preconditions: Condition[] = structuredClone(unit.preconditions);
      const postconditions: Condition[] = structuredClone(unit.postconditions);
      const used = new Set([...slotsIn(steps), ...slotsIn(preconditions), ...slotsIn(postconditions)]);
      for (const name of used)
        if (bindings[name] === undefined) throw new RuntimeError('invalid_input', `slot ${name} is used but has no binding`);
      const proposal: ProcedureProposal = {
        key: { ...key },
        parameters: [...used].sort(),
        steps,
        preconditions,
        postconditions,
        source: 'learned',
      };
      assertProposal(proposal, clock.now().toISOString());
      return proposal;
    },

    async accept(proposal, verification, itemId) {
      if (!validEvidence(verification)) throw new RuntimeError('invalid_input', 'a proposal is stored only after a local verifier passed with evidence');
      if (!itemId) throw new RuntimeError('invalid_input', 'a proposal needs the work item it was verified on');
      if (proposal.source !== 'learned' && proposal.source !== 'repair') throw new RuntimeError('invalid_input', 'proposal source must be learned or repair');
      const at = clock.now().toISOString();
      assertProposal(proposal, at);
      const definition = structuredClone(proposal);
      for (let attempt = 0; ; attempt++) {
        const existing = (await repository.listProcedures(proposal.key)).filter((p) => procedureKeyString(p.key) === procedureKeyString(proposal.key));
        if (definition.parentVersion !== undefined && !existing.some((p) => p.version === definition.parentVersion))
          throw new RuntimeError('invalid_input', `parent version ${definition.parentVersion} does not exist under ${procedureKeyString(proposal.key)}`);
        const version = existing.reduce((max, p) => Math.max(max, p.version), 0) + 1;
        // The verified run is the first success of the streak: the next
        // distinct items replay it, and promotion follows nextProcedureState.
        const procedure = draft(definition, at, {
          id: newId(),
          version,
          counters: { successes: 1, failures: 0, consecutiveFailures: 0, successItemIds: [itemId] },
        });
        const result = validateProcedure(procedure, POLICY);
        if (!result.ok) throw new RuntimeError('invalid_input', `procedure: ${result.errors.join('; ')}`, { errors: result.errors });
        try {
          await repository.insertProcedure(procedure);
          return procedure;
        } catch (error) {
          // Another writer took this version number; take the next one.
          if (!isRuntimeError(error, 'conflict') || attempt >= 2) throw error;
        }
      }
    },
  };
}

