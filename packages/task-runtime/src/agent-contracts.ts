// Agent packages and the agent JSON lines protocol (RFC 0001, phase P1).
//
// An agent is the unit the runtime installs, grants and audits: a manifest
// (agent.json, schemaVersion 2), one window profile per application it
// drives, and an executor. This file holds the manifest's type and
// validator, the version-range rule the loader applies, the adapter that
// reads a schemaVersion 1 task.json as an agent, and the messages an agent
// process and the runtime exchange over stdin/stdout (`agent-jsonl/1`, a
// superset of the bridge protocol in contracts.ts).
//
// Types, validators and pure rules only. It imports nothing but
// ./contracts.ts. Nothing here starts an agent; the runtime side that does
// comes in later P1 changes and must accept only what these validators pass.

import {
  EFFECT_CLASSES,
  validateAction,
  validateWaitSpec,
  type Action,
  type ActionResult,
  type ArtifactCompleteness,
  type ArtifactKind,
  type Budget,
  type Condition,
  type EffectClass,
  type Observation,
  type Rect,
  type TaskSpec,
  type TerminationReason,
  type Validated,
  type WaitReason,
  type WaitSpec,
  type WorkItemStatus,
} from './contracts.ts';

export const AGENT_SPEC_SCHEMA_VERSION = 2;

/**
 * The account an agent works in, on whatever platform its app belongs to:
 * a key the user chose (letters, digits, '.', '_', '-'), never read from a
 * window. The BOSS task runtime's AccountScope is one of these.
 */
export interface AgentAccount {
  platform: string;
  accountKey: string;
  binding?: 'observed' | 'explicit';
  displayHint?: string;
}
export const AGENT_PROTOCOL = 'agent-jsonl/1';
export const AGENT_PROTOCOL_VERSION = 1;
/** What `runtimeContract` ranges are matched against. Bumped with breaking changes to this file. */
export const AGENT_RUNTIME_CONTRACT_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// Manifest

export type AgentMode = 'task' | 'resident';
export const AGENT_MODES: readonly AgentMode[] = ['task', 'resident'];

/**
 * How an effect class is approved, from the loosest the agent may ask for
 * to the strictest. The user's and the organization's settings only ever
 * tighten what the manifest declares.
 */
export type ApprovalMode = 'trusted_within_ceiling' | 'human_in_the_loop' | 'locked_down';
export const APPROVAL_MODES: readonly ApprovalMode[] = ['trusted_within_ceiling', 'human_in_the_loop', 'locked_down'];

/** The stricter of two approval modes. */
export function stricterApproval(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return APPROVAL_MODES.indexOf(a) >= APPROVAL_MODES.indexOf(b) ? a : b;
}

export type WorkHoursSource = 'org' | 'user' | 'always';

export type ProviderPurpose = 'ui' | 'repair' | 'analysis' | 'draft' | 'submit';
export const PROVIDER_PURPOSES: readonly ProviderPurpose[] = ['ui', 'repair', 'analysis', 'draft', 'submit'];

export interface AgentApplication {
  bundleId: string;
  /** Version range the agent was verified against; absent means any. */
  versions?: string;
  windowProfile: string;
}

export type AgentExecutor =
  | { kind: 'builtin'; workflow: string }
  | {
      kind: 'process';
      /** Relative to the package root; the first word is the program. */
      command: string[];
      protocol: typeof AGENT_PROTOCOL;
      runtime?: { kind: string; version?: string; bundled: boolean };
    }
  | { kind: 'mcp'; command: string[]; protocol: 'agent-mcp/1' };

export interface AgentProviderNeed {
  id: string;
  purposes: ProviderPurpose[];
}

export interface EffectLimit {
  perDay?: number;
  minIntervalMs?: number;
}

/** agent.json, schemaVersion 2. Every field is checked by validateAgentSpec. */
export interface AgentSpec {
  schemaVersion: 2;
  id: string;
  version: string;
  /** Range over AGENT_RUNTIME_CONTRACT_VERSION, e.g. ">=2 <3". */
  runtimeContract: string;
  platforms: Array<'macos'>;
  applications: AgentApplication[];
  mode: AgentMode;
  executor: AgentExecutor;
  /** Task types the agent accepts, by name, each with its input schema id. */
  tasks: Record<string, { inputSchema: string }>;
  /** Effect classes the agent declares it will use. Anything else is refused. */
  effects: EffectClass[];
  capabilities: string[];
  providers: AgentProviderNeed[];
  identity?: { required: boolean; audience?: string };
  /** The agent's own ceilings; the runtime's are stricter or equal. */
  limits: Partial<Record<EffectClass, EffectLimit>>;
  approval: Partial<Record<EffectClass, ApprovalMode>>;
  /** Required for resident agents. */
  schedule?: { workHours: WorkHoursSource; idlePollSeconds: number };
  foregroundAllowed: boolean;
  learning: { promoteAfterSuccesses: number };
  /** SKILL.md files in the package, for people and LLMs; at least one. */
  skills: string[];
}

const SPEC_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'id',
  'version',
  'runtimeContract',
  'platforms',
  'applications',
  'mode',
  'executor',
  'tasks',
  'effects',
  'capabilities',
  'providers',
  'identity',
  'limits',
  'approval',
  'schedule',
  'foregroundAllowed',
  'learning',
  'skills',
]);

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_TYPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const SCHEDULE_POLL = { min: 5, max: 3600 } as const;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;
const isIsoTime = (v: unknown): v is string => isString(v) && !Number.isNaN(Date.parse(v));
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => isString(v) && (values as readonly string[]).includes(v);
const ok = <T>(value: T, errors: string[]): Validated<T> => (errors.length ? { ok: false, errors } : { ok: true, value });
const isRect = (v: unknown): v is Rect =>
  isObject(v) && [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n));
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmpty);
const isEffect = (v: unknown): v is EffectClass => oneOf(v, EFFECT_CLASSES);

/** A path inside a package: relative, no `..`, no empty segment. */
export function isPackagePath(path: unknown): path is string {
  if (!isNonEmpty(path) || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function validateCommand(raw: unknown, errors: string[], path: string): void {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isNonEmpty)) {
    errors.push(`${path} must be a non-empty array of strings`);
    return;
  }
  if (!isPackagePath(raw[0])) errors.push(`${path}[0] must be a path inside the package`);
}

function validateExecutor(raw: unknown, mode: unknown, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push('executor must be an object');
    return;
  }
  switch (raw.kind) {
    case 'builtin':
      if (!isNonEmpty(raw.workflow)) errors.push('executor.workflow must name a built-in workflow');
      if (mode === 'resident') errors.push('executor.kind builtin runs tasks only; resident agents need a process or mcp executor');
      for (const k of Object.keys(raw)) if (!['kind', 'workflow'].includes(k)) errors.push(`executor.${k} is not a field of a builtin executor`);
      break;
    case 'process':
      validateCommand(raw.command, errors, 'executor.command');
      if (raw.protocol !== AGENT_PROTOCOL) errors.push(`executor.protocol must be ${AGENT_PROTOCOL}`);
      if (raw.runtime !== undefined) {
        if (!isObject(raw.runtime) || !isNonEmpty(raw.runtime.kind) || typeof raw.runtime.bundled !== 'boolean')
          errors.push('executor.runtime must carry kind and bundled');
        else if (raw.runtime.version !== undefined && !isNonEmpty(raw.runtime.version)) errors.push('executor.runtime.version must be a string');
      }
      for (const k of Object.keys(raw)) if (!['kind', 'command', 'protocol', 'runtime'].includes(k)) errors.push(`executor.${k} is not a field of a process executor`);
      break;
    case 'mcp':
      validateCommand(raw.command, errors, 'executor.command');
      if (raw.protocol !== 'agent-mcp/1') errors.push('executor.protocol must be agent-mcp/1');
      for (const k of Object.keys(raw)) if (!['kind', 'command', 'protocol'].includes(k)) errors.push(`executor.${k} is not a field of an mcp executor`);
      break;
    default:
      errors.push('executor.kind must be builtin, process or mcp');
  }
}

/** Every problem in an agent.json at once. The value is only usable when `ok`. */
export function validateAgentSpec(raw: unknown): Validated<AgentSpec> {
  if (!isObject(raw)) return { ok: false, errors: ['agent spec must be an object'] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (!SPEC_FIELDS.has(k)) errors.push(`${k} is not a field of an agent spec`);
  if (raw.schemaVersion !== AGENT_SPEC_SCHEMA_VERSION) errors.push(`schemaVersion must be ${AGENT_SPEC_SCHEMA_VERSION}`);
  if (!isString(raw.id) || !AGENT_ID.test(raw.id)) errors.push("id must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit");
  if (!isString(raw.version) || !SEMVER.test(raw.version)) errors.push('version must be a semantic version');
  if (!isString(raw.runtimeContract) || !parseVersionRange(raw.runtimeContract).ok) errors.push('runtimeContract must be a version range such as ">=2 <3"');
  if (!Array.isArray(raw.platforms) || raw.platforms.length === 0 || !raw.platforms.every((p) => p === 'macos')) errors.push('platforms must be ["macos"]');

  if (!Array.isArray(raw.applications) || raw.applications.length === 0) errors.push('applications must list at least one application');
  else {
    const seen = new Set<string>();
    raw.applications.forEach((app, i) => {
      const path = `applications[${i}]`;
      if (!isObject(app)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!isNonEmpty(app.bundleId) || app.bundleId.includes(':')) errors.push(`${path}.bundleId must be a bundle id`);
      else if (seen.has(app.bundleId)) errors.push(`${path}.bundleId repeats ${app.bundleId}`);
      else seen.add(app.bundleId);
      if (!isNonEmpty(app.windowProfile)) errors.push(`${path}.windowProfile must name a profile`);
      if (app.versions !== undefined && (!isString(app.versions) || !parseVersionRange(app.versions).ok)) errors.push(`${path}.versions must be a version range`);
      for (const k of Object.keys(app)) if (!['bundleId', 'versions', 'windowProfile'].includes(k)) errors.push(`${path}.${k} is not a field of an application`);
    });
  }

  if (!oneOf(raw.mode, AGENT_MODES)) errors.push('mode must be task or resident');
  validateExecutor(raw.executor, raw.mode, errors);

  if (!isObject(raw.tasks) || Object.keys(raw.tasks).length === 0) errors.push('tasks must name at least one task type');
  else
    for (const [name, def] of Object.entries(raw.tasks)) {
      if (!TASK_TYPE.test(name)) errors.push(`tasks.${name}: task types are 1-64 lowercase letters, digits or '-'`);
      if (!isObject(def) || !isNonEmpty(def.inputSchema)) errors.push(`tasks.${name}.inputSchema must name a schema`);
    }

  const effects = new Set<EffectClass>();
  if (!Array.isArray(raw.effects) || raw.effects.length === 0) errors.push('effects must list at least one effect class');
  else
    for (const e of raw.effects) {
      if (!isEffect(e)) errors.push(`effects: ${String(e)} is not an effect class`);
      else if (effects.has(e)) errors.push(`effects repeats ${e}`);
      else effects.add(e);
    }
  if (!Array.isArray(raw.capabilities) || !raw.capabilities.every(isNonEmpty)) errors.push('capabilities must be strings');

  if (!Array.isArray(raw.providers)) errors.push('providers must be an array');
  else {
    const ids = new Set<string>();
    raw.providers.forEach((p, i) => {
      const path = `providers[${i}]`;
      if (!isObject(p) || !isNonEmpty(p.id)) errors.push(`${path}.id must be a provider id`);
      else if (ids.has(p.id)) errors.push(`${path}.id repeats ${p.id}`);
      else ids.add(p.id);
      if (!isObject(p) || !Array.isArray(p.purposes) || p.purposes.length === 0 || !p.purposes.every((u) => oneOf(u, PROVIDER_PURPOSES)))
        errors.push(`${path}.purposes must be a non-empty list of ${PROVIDER_PURPOSES.join(', ')}`);
    });
  }

  if (raw.identity !== undefined) {
    if (!isObject(raw.identity) || typeof raw.identity.required !== 'boolean') errors.push('identity.required must be boolean');
    else if (raw.identity.required && !isNonEmpty(raw.identity.audience)) errors.push('identity.audience is required when identity is required');
  }

  if (!isObject(raw.limits)) errors.push('limits must be an object');
  else
    for (const [k, v] of Object.entries(raw.limits)) {
      if (!isEffect(k) || !effects.has(k)) errors.push(`limits.${k} names an effect the agent does not declare`);
      if (!isObject(v) || (v.perDay === undefined && v.minIntervalMs === undefined)) errors.push(`limits.${k} must set perDay or minIntervalMs`);
      else {
        if (v.perDay !== undefined && !isInt(v.perDay, 1)) errors.push(`limits.${k}.perDay must be an integer >= 1`);
        if (v.minIntervalMs !== undefined && !isInt(v.minIntervalMs)) errors.push(`limits.${k}.minIntervalMs must be a non-negative integer`);
      }
    }

  if (!isObject(raw.approval)) errors.push('approval must be an object');
  else {
    for (const [k, v] of Object.entries(raw.approval)) {
      if (!isEffect(k) || !effects.has(k)) errors.push(`approval.${k} names an effect the agent does not declare`);
      if (!oneOf(v, APPROVAL_MODES)) errors.push(`approval.${k} must be one of ${APPROVAL_MODES.join(', ')}`);
    }
    if (effects.has('external-submit') && raw.approval['external-submit'] === undefined) errors.push('approval.external-submit is required when external-submit is declared');
  }

  if (raw.schedule !== undefined) {
    if (!isObject(raw.schedule) || !oneOf(raw.schedule.workHours, ['org', 'user', 'always'])) errors.push('schedule.workHours must be org, user or always');
    if (!isObject(raw.schedule) || !isInt(raw.schedule.idlePollSeconds, SCHEDULE_POLL.min) || raw.schedule.idlePollSeconds > SCHEDULE_POLL.max)
      errors.push(`schedule.idlePollSeconds must be an integer between ${SCHEDULE_POLL.min} and ${SCHEDULE_POLL.max}`);
  } else if (raw.mode === 'resident') errors.push('schedule is required for a resident agent');

  if (typeof raw.foregroundAllowed !== 'boolean') errors.push('foregroundAllowed must be boolean');
  if (!isObject(raw.learning) || !isInt(raw.learning.promoteAfterSuccesses, 1)) errors.push('learning.promoteAfterSuccesses must be an integer >= 1');
  if (!isStringArray(raw.skills) || raw.skills.length === 0 || !raw.skills.every((s) => isPackagePath(s) && s.endsWith('.md')))
    errors.push('skills must list at least one .md file inside the package');

  return ok(raw as unknown as AgentSpec, errors);
}

/**
 * A schemaVersion 1 task.json read as an agent: one application, task mode,
 * a built-in executor, and never external-submit. The runtime keeps loading
 * the existing packages through this.
 */
export function agentSpecFromTaskSpec(spec: TaskSpec): AgentSpec {
  const taskType = spec.id.includes('.') ? spec.id.slice(spec.id.lastIndexOf('.') + 1) : spec.id;
  return {
    schemaVersion: 2,
    id: spec.id,
    version: spec.version,
    runtimeContract: '>=2 <3',
    platforms: spec.platforms,
    applications: [{ bundleId: spec.application, windowProfile: spec.windowProfile }],
    mode: 'task',
    executor: { kind: 'builtin', workflow: spec.workflow },
    tasks: { [taskType]: { inputSchema: spec.inputSchema } },
    effects: ['read', 'navigation', 'artifact'],
    capabilities: spec.capabilities,
    providers: spec.defaults.analysis === 'on' ? [{ id: 'model', purposes: ['ui', 'repair', 'analysis'] }] : [{ id: 'model', purposes: ['ui', 'repair'] }],
    limits: {},
    approval: {},
    foregroundAllowed: spec.foregroundAllowed,
    learning: spec.learning,
    skills: ['SKILL.md'],
  };
}

// ---------------------------------------------------------------------------
// Version ranges

export type VersionComparator = { op: '>=' | '>' | '<=' | '<' | '='; version: number[] };

const COMPARATOR = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})(?:-[0-9A-Za-z.-]+)?$/;

/**
 * A range is space-separated comparators that must all hold, such as
 * ">=2 <3" or "=1.7.4". A bare version means "=". Versions compare by up to
 * three numeric parts; missing parts are 0 and prerelease tags are ignored.
 */
export function parseVersionRange(range: string): Validated<VersionComparator[]> {
  const words = range.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return { ok: false, errors: ['range is empty'] };
  const comparators: VersionComparator[] = [];
  const errors: string[] = [];
  for (const word of words) {
    const m = COMPARATOR.exec(word);
    if (!m) {
      errors.push(`${word} is not a comparator`);
      continue;
    }
    comparators.push({ op: (m[1] as VersionComparator['op'] | undefined) ?? '=', version: m[2]!.split('.').map(Number) });
  }
  return ok(comparators, errors);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether a version is inside a range. An invalid version or range never satisfies. */
export function satisfiesRange(version: string, range: string): boolean {
  const v = COMPARATOR.exec(version.trim());
  if (!v || v[1]) return false;
  const parsed = parseVersionRange(range);
  if (!parsed.ok) return false;
  const parts = v[2]!.split('.').map(Number);
  return parsed.value.every(({ op, version: bound }) => {
    const c = compareVersions(parts, bound);
    switch (op) {
      case '>=':
        return c >= 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      case '<':
        return c < 0;
      case '=':
        return c === 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Grants and refusals

/** One approval the user or an organization gave. Leases by default; `durable` is explicit. */
export interface Grant {
  agentId: string;
  application: string;
  accountKey: string;
  effect: EffectClass;
  mode: ApprovalMode;
  grantedAt: string;
  /** Absent only when durable. */
  expiresAt?: string;
  durable: boolean;
  grantedBy: 'user' | 'org';
}

/** Why the runtime's pre-action check chain refused an action. */
export type ActionRefusalReason =
  | 'app_undeclared'
  | 'effect_undeclared'
  | 'not_granted'
  | 'grant_expired'
  | 'quota_exhausted'
  | 'too_fast'
  | 'outside_work_hours'
  | 'snapshot_stale'
  | 'target_unknown_result'
  | 'lease_held'
  | 'checker_denied'
  | 'approval_required'
  | 'approval_denied';

export const ACTION_REFUSAL_REASONS: readonly ActionRefusalReason[] = [
  'app_undeclared',
  'effect_undeclared',
  'not_granted',
  'grant_expired',
  'quota_exhausted',
  'too_fast',
  'outside_work_hours',
  'snapshot_stale',
  'target_unknown_result',
  'lease_held',
  'checker_denied',
  'approval_required',
  'approval_denied',
];

/** Machine-readable advice sent with a refusal or a denial. */
export type NextStep =
  | { kind: 'wait'; ms: number }
  | { kind: 'request_approval'; effect: EffectClass }
  | { kind: 'use_read_only' }
  | { kind: 'observe_again' }
  | { kind: 'skip_target' }
  | { kind: 'stop' };

export interface ActionRefusal {
  reason: ActionRefusalReason;
  message: string;
  nextSteps: NextStep[];
}

export type ApprovalHint = 'too_fast' | 'wrong_target' | 'outside_quota' | 'needs_time_limit' | 'not_now';
export const APPROVAL_HINTS: readonly ApprovalHint[] = ['too_fast', 'wrong_target', 'outside_quota', 'needs_time_limit', 'not_now'];

// ---------------------------------------------------------------------------
// Protocol: runtime → agent

interface MessageBase {
  v: typeof AGENT_PROTOCOL_VERSION;
  /** One run of one agent process. Every message of both directions carries it. */
  agentRunId: string;
  /** Strictly increasing per direction within a run. */
  seq: number;
  at: string;
}

export interface SessionApp {
  bundleId: string;
  pid: number;
  windowId: number;
}

export interface ScheduleInfo {
  workHours: WorkHoursSource;
  /** Resolved windows as "HH:MM-HH:MM" in `timezone`; absent means always. */
  windows?: string[];
  timezone: string;
  idlePollSeconds: number;
}

export type RuntimeMessage = MessageBase &
  (
    | {
        type: 'agent_start';
        agent: { id: string; version: string; mode: AgentMode };
        account?: AgentAccount;
        grants: Grant[];
        schedule?: ScheduleInfo;
        /** A summary the agent may show; never usable to authenticate. */
        identity?: { displayName: string; organization?: string; role?: string };
        resume?: { tasks: Array<{ taskId: string; taskType: string; checkpoint?: unknown }> };
      }
    | { type: 'task_start'; taskId: string; taskType: string; input: unknown; budget: Budget; session: { screenId: string; apps: SessionApp[] } }
    | {
        type: 'observation';
        taskId?: string;
        requestId: string;
        app: string;
        observation: Observation;
        /** Present when this answers a `wait`: whether the condition held before the timeout. */
        check?: { ok: boolean; elapsedMs?: number; evidence: string[] };
      }
    | { type: 'action_result'; taskId: string; requestId: string; result: ActionResult }
    | { type: 'action_result'; taskId: string; requestId: string; refusal: ActionRefusal }
    | { type: 'provider_result'; taskId?: string; requestId: string; ok: true; output: unknown; usage?: { inputTokens: number | 'unknown'; outputTokens: number | 'unknown' } }
    | { type: 'provider_result'; taskId?: string; requestId: string; ok: false; reason: 'provider_unavailable' | 'provider_undeclared' | 'purpose_not_allowed' | 'quota_exhausted' | 'error'; message: string }
    | { type: 'grant'; taskId: string; approvalId: string }
    | { type: 'deny'; taskId: string; approvalId: string; guidance?: { text?: string; hints: ApprovalHint[] } }
    | { type: 'task_created'; requestId: string; taskId: string }
    | {
        type: 'unit_result';
        taskId: string;
        requestId: string;
        ok: true;
        route: 'verified' | 'replay' | 'recovered' | 'repaired';
        observation: Observation;
        check: { ok: boolean; evidence: string[] };
        /** The procedure replayed or learned, and how far it is from stable. */
        procedure?: { id: string; version: number; status: string };
      }
    | { type: 'unit_result'; taskId: string; requestId: string; ok: false; reason: UnitRefusalReason; message: string; observation?: Observation }
    /** The person's answer to an `ask_user` that carried a questionId; the task goes on where it stopped. */
    | { type: 'user_answer'; taskId: string; questionId: string; answer: string }
    | { type: 'pause'; taskId: string }
    | { type: 'resume'; taskId: string }
    | { type: 'cancel'; taskId: string }
    | { type: 'stop' }
  );

export type RuntimeMessageType = RuntimeMessage['type'];

// ---------------------------------------------------------------------------
// Protocol: agent → runtime

/**
 * What an agent says it is doing, in herdr's vocabulary: `working` (a turn
 * in progress), `idle` (nothing to do), `blocked` (waiting on something the
 * runtime cannot see, with a message), `paused`. The runtime derives
 * blocked-on-approval and blocked-on-input itself from pending requests.
 */
export type HeartbeatState = 'idle' | 'working' | 'blocked' | 'paused';

/** A unit as an agent describes it in `run_unit` (checked by unitProblems in agent-units.ts). */
export interface AgentUnit {
  name: string;
  goal: string;
  /** read, navigation or artifact; never external-submit. */
  allowedEffects: EffectClass[];
  /** What must hold when the unit is done; the runtime checks them, nothing else counts. */
  postconditions: Condition[];
  preconditions?: Condition[];
  /** Whether a path the model found may be stored for replay; default true. */
  learnable?: boolean;
  timeoutMs?: number;
}

export type UnitRefusalReason = 'not_offered' | 'invalid_unit' | 'forbidden_effect' | 'unrecovered' | 'model_unavailable' | 'budget_exhausted' | 'not_learnable' | 'cancelled' | 'error';
export const UNIT_REFUSAL_REASONS: readonly UnitRefusalReason[] = ['not_offered', 'invalid_unit', 'forbidden_effect', 'unrecovered', 'model_unavailable', 'budget_exhausted', 'not_learnable', 'cancelled', 'error'];
export const HEARTBEAT_STATES: readonly HeartbeatState[] = ['idle', 'working', 'blocked', 'paused'];

export type AgentMessage = MessageBase &
  (
    | { type: 'observe'; taskId: string; requestId: string; app: string; elements?: boolean; screenshot?: boolean | { region: Rect }; text?: boolean }
    | {
        type: 'act';
        taskId: string;
        requestId: string;
        app: string;
        action: Action;
        snapshotId?: string;
        /**
         * The agent's stable key for the business target, e.g. a salted
         * candidate hash. An external-submit with an unknown result blocks
         * further external-submits on the same target; without a target it
         * blocks every external-submit of the task.
         */
        target?: string;
        /** The granted `ask_approval` this act carries out; used once. */
        approvalId?: string;
      }
    | { type: 'wait'; taskId: string; requestId: string; app: string; wait: WaitSpec }
    | { type: 'provider'; taskId?: string; requestId: string; providerId: string; purpose: ProviderPurpose; input: unknown; screenshotRef?: string }
    | { type: 'ask_approval'; taskId: string; approvalId: string; effect: EffectClass; summary: string; app?: string; action?: Action; target?: string }
    /**
     * The task needs a person. Two kinds of pause are kept apart: this is
     * missing input (login, captcha, a choice); approvals go through
     * `ask_approval`. With a questionId the runtime answers with
     * `user_answer`; without one it only shows the message.
     */
    | { type: 'ask_user'; taskId: string; reason: WaitReason; message: string; questionId?: string; choices?: string[] }
    | { type: 'create_task'; requestId: string; taskType: string; input: unknown }
    | { type: 'item'; taskId: string; itemId: string; status: WorkItemStatus; data?: Record<string, unknown> }
    | { type: 'artifact'; taskId: string; path: string; kind: ArtifactKind; completeness: ArtifactCompleteness; sha256?: string }
    /**
     * Ask the runtime to reach the unit's postconditions: already done, a
     * learned procedure replayed, or recovered (locally, then by the model),
     * each judged by the postconditions on a fresh observation.
     */
    | { type: 'run_unit'; taskId: string; requestId: string; app: string; unit: AgentUnit; bindings?: Record<string, string>; itemId?: string }
    | { type: 'unit_started'; taskId: string; unitAttemptId: string; unit: string }
    | { type: 'unit_finished'; taskId: string; unitAttemptId: string; unit: string; ok: boolean }
    | { type: 'heartbeat'; state: HeartbeatState; summary?: string }
    | { type: 'task_finished'; taskId: string; status: 'succeeded' | 'partial'; terminationReason?: TerminationReason }
    | { type: 'task_failed'; taskId: string; reason: 'budget_exhausted' | 'provider_unavailable' | 'cancelled' | 'timeout' | 'forbidden_effect' | 'error'; message: string }
    | { type: 'agent_stopped'; reason: 'stop' | 'work_hours' | 'error'; message?: string }
  );

export type AgentMessageType = AgentMessage['type'];

const AGENT_MESSAGE_TYPES: readonly AgentMessageType[] = [
  'observe',
  'act',
  'wait',
  'run_unit',
  'provider',
  'ask_approval',
  'ask_user',
  'create_task',
  'item',
  'artifact',
  'unit_started',
  'unit_finished',
  'heartbeat',
  'task_finished',
  'task_failed',
  'agent_stopped',
];

/** Agent messages that belong to a task and must say which. */
const TASK_SCOPED: ReadonlySet<string> = new Set([
  'observe',
  'act',
  'wait',
  'run_unit',
  'ask_approval',
  'ask_user',
  'item',
  'artifact',
  'unit_started',
  'unit_finished',
  'task_finished',
  'task_failed',
]);

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['discovered', 'processing', 'acquired', 'validated', 'committed', 'unavailable', 'failed', 'ambiguous'];
const ARTIFACT_KINDS: readonly ArtifactKind[] = ['original', 'captured_page', 'captured_image', 'resume_text', 'metadata', 'diagnostic'];
const ARTIFACT_COMPLETENESS: readonly ArtifactCompleteness[] = ['complete', 'partial_capture', 'unverified', 'invalid'];
const WAIT_REASONS: readonly WaitReason[] = [
  'login_required',
  'captcha',
  'job_ambiguous',
  'account_changed',
  'model_unavailable',
  'budget_exhausted',
  'capability_missing',
  'permission_missing',
  'window_moved',
  'storage_full',
];
const TERMINATION_REASONS: readonly TerminationReason[] = ['target_reached', 'source_exhausted', 'browse_limit', 'deadline', 'budget_exhausted', 'cancelled', 'fatal_error'];

export interface ExpectedMessage {
  agentRunId: string;
  /** The last seq accepted in this direction; the next must be greater. */
  lastSeq?: number;
}

function validateBase(raw: Json, expected: ExpectedMessage | undefined, errors: string[]): void {
  if (raw.v !== AGENT_PROTOCOL_VERSION) errors.push(`v must be ${AGENT_PROTOCOL_VERSION}`);
  if (!isNonEmpty(raw.agentRunId)) errors.push('agentRunId is required');
  else if (expected && raw.agentRunId !== expected.agentRunId) errors.push('message belongs to another agent run');
  if (!isInt(raw.seq, 1)) errors.push('seq must be an integer >= 1');
  else if (expected?.lastSeq !== undefined && raw.seq <= expected.lastSeq) errors.push(`seq must be greater than ${expected.lastSeq}`);
  if (!isIsoTime(raw.at)) errors.push('at must be an ISO time');
}

/**
 * One line from an agent process. Every line is untrusted: anything that
 * fails here ends the task, and for a resident agent counts toward its
 * failure limit. Actions are checked for shape only; whether an effect is
 * declared, granted or within limits is the runtime's check chain, not the
 * parser's.
 */
export function parseAgentMessage(line: string, expected?: ExpectedMessage): Validated<AgentMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, errors: ['line is not JSON'] };
  }
  if (!isObject(raw)) return { ok: false, errors: ['message must be an object'] };
  const errors: string[] = [];
  validateBase(raw, expected, errors);
  if (!oneOf(raw.type, AGENT_MESSAGE_TYPES)) {
    errors.push('type is not an agent message type');
    return { ok: false, errors };
  }
  if (TASK_SCOPED.has(raw.type) && !isNonEmpty(raw.taskId)) errors.push(`${raw.type} must carry taskId`);
  else if (raw.taskId !== undefined && !isNonEmpty(raw.taskId)) errors.push('taskId must be a non-empty string when present');
  const needRequest = () => {
    if (!isNonEmpty(raw.requestId)) errors.push('requestId is required');
  };
  const needApp = () => {
    if (!isNonEmpty(raw.app) || raw.app.includes(':')) errors.push('app must be a bundle id');
  };
  switch (raw.type) {
    case 'observe':
      needRequest();
      needApp();
      if (raw.elements !== undefined && typeof raw.elements !== 'boolean') errors.push('elements must be boolean');
      if (raw.screenshot !== undefined && typeof raw.screenshot !== 'boolean' && !(isObject(raw.screenshot) && isRect(raw.screenshot.region)))
        errors.push('screenshot must be boolean or { region }');
      if (raw.text !== undefined && typeof raw.text !== 'boolean') errors.push('text must be boolean');
      break;
    case 'act':
      needRequest();
      needApp();
      errors.push(...validateAction(raw.action, { submitAllowed: true }));
      if (raw.snapshotId !== undefined && !isNonEmpty(raw.snapshotId)) errors.push('snapshotId must be a non-empty string when present');
      if (raw.target !== undefined && !isNonEmpty(raw.target)) errors.push('target must be a non-empty string when present');
      if (raw.approvalId !== undefined && !isNonEmpty(raw.approvalId)) errors.push('approvalId must be a non-empty string when present');
      break;
    case 'wait':
      needRequest();
      needApp();
      errors.push(...validateWaitSpec(raw.wait, 'wait'));
      break;
    case 'run_unit':
      needRequest();
      needApp();
      // The unit's content is checked by the host against the agent's manifest; here only its shape.
      if (!isObject(raw.unit)) errors.push('unit must be an object');
      if (raw.bindings !== undefined && !(isObject(raw.bindings) && Object.values(raw.bindings).every(isString))) errors.push('bindings must map names to strings');
      if (raw.itemId !== undefined && !isNonEmpty(raw.itemId)) errors.push('itemId must be a non-empty string when present');
      break;
    case 'provider':
      needRequest();
      if (!isNonEmpty(raw.providerId)) errors.push('providerId is required');
      if (!oneOf(raw.purpose, PROVIDER_PURPOSES)) errors.push(`purpose must be one of ${PROVIDER_PURPOSES.join(', ')}`);
      if (!('input' in raw)) errors.push('input is required');
      if (raw.screenshotRef !== undefined && !isNonEmpty(raw.screenshotRef)) errors.push('screenshotRef must be a non-empty string when present');
      break;
    case 'ask_approval':
      if (!isNonEmpty(raw.approvalId)) errors.push('approvalId is required');
      if (!isEffect(raw.effect)) errors.push('effect must be an effect class');
      if (!isNonEmpty(raw.summary)) errors.push('summary is required');
      if (raw.action !== undefined) errors.push(...validateAction(raw.action, { submitAllowed: true }));
      if (raw.target !== undefined && !isNonEmpty(raw.target)) errors.push('target must be a non-empty string when present');
      if (raw.app !== undefined && (!isNonEmpty(raw.app) || raw.app.includes(':'))) errors.push('app must be a bundle id when present');
      break;
    case 'ask_user':
      if (!oneOf(raw.reason, WAIT_REASONS)) errors.push('reason is not a wait reason');
      if (!isString(raw.message)) errors.push('message must be a string');
      if (raw.questionId !== undefined && !isNonEmpty(raw.questionId)) errors.push('questionId must be a non-empty string when present');
      if (raw.choices !== undefined) {
        if (raw.questionId === undefined) errors.push('choices need a questionId');
        if (!Array.isArray(raw.choices) || raw.choices.length === 0 || !raw.choices.every(isNonEmpty)) errors.push('choices must be a non-empty list of strings');
      }
      break;
    case 'create_task':
      needRequest();
      if (!isString(raw.taskType) || !TASK_TYPE.test(raw.taskType)) errors.push('taskType must be a task type name');
      if (!('input' in raw)) errors.push('input is required');
      break;
    case 'item':
      if (!isNonEmpty(raw.itemId)) errors.push('itemId is required');
      if (!oneOf(raw.status, WORK_ITEM_STATUSES)) errors.push('status is not a work item status');
      if (raw.data !== undefined && !isObject(raw.data)) errors.push('data must be an object when present');
      break;
    case 'artifact':
      if (!isNonEmpty(raw.path)) errors.push('path is required');
      if (!oneOf(raw.kind, ARTIFACT_KINDS)) errors.push('kind is not an artifact kind');
      if (!oneOf(raw.completeness, ARTIFACT_COMPLETENESS)) errors.push('completeness is not an artifact completeness');
      if (raw.sha256 !== undefined && !(isString(raw.sha256) && /^[0-9a-f]{64}$/.test(raw.sha256))) errors.push('sha256 must be 64 hex digits when present');
      break;
    case 'unit_started':
      if (!isNonEmpty(raw.unitAttemptId) || !isNonEmpty(raw.unit)) errors.push('unitAttemptId and unit are required');
      break;
    case 'unit_finished':
      if (!isNonEmpty(raw.unitAttemptId) || !isNonEmpty(raw.unit)) errors.push('unitAttemptId and unit are required');
      if (typeof raw.ok !== 'boolean') errors.push('ok must be boolean');
      break;
    case 'heartbeat':
      if (!oneOf(raw.state, HEARTBEAT_STATES)) errors.push(`state must be one of ${HEARTBEAT_STATES.join(', ')}`);
      if (raw.summary !== undefined && !isString(raw.summary)) errors.push('summary must be a string when present');
      break;
    case 'task_finished':
      if (!oneOf(raw.status, ['succeeded', 'partial'])) errors.push('status must be succeeded or partial');
      if (raw.terminationReason !== undefined && !oneOf(raw.terminationReason, TERMINATION_REASONS)) errors.push('terminationReason is not a termination reason');
      break;
    case 'task_failed':
      if (!oneOf(raw.reason, ['budget_exhausted', 'provider_unavailable', 'cancelled', 'timeout', 'forbidden_effect', 'error'])) errors.push('reason is not a failure reason');
      if (!isString(raw.message)) errors.push('message must be a string');
      break;
    case 'agent_stopped':
      if (!oneOf(raw.reason, ['stop', 'work_hours', 'error'])) errors.push('reason must be stop, work_hours or error');
      if (raw.message !== undefined && !isString(raw.message)) errors.push('message must be a string when present');
      break;
  }
  return ok(raw as unknown as AgentMessage, errors);
}

const RUNTIME_MESSAGE_TYPES: readonly RuntimeMessageType[] = [
  'agent_start',
  'task_start',
  'observation',
  'unit_result',
  'action_result',
  'provider_result',
  'grant',
  'deny',
  'task_created',
  'user_answer',
  'pause',
  'resume',
  'cancel',
  'stop',
];

function validateGrant(raw: unknown, path: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmpty(raw.agentId) || !isNonEmpty(raw.application) || !isNonEmpty(raw.accountKey)) errors.push(`${path} must name agentId, application and accountKey`);
  if (!isEffect(raw.effect)) errors.push(`${path}.effect must be an effect class`);
  if (!oneOf(raw.mode, APPROVAL_MODES)) errors.push(`${path}.mode must be an approval mode`);
  if (!isIsoTime(raw.grantedAt)) errors.push(`${path}.grantedAt must be an ISO time`);
  if (typeof raw.durable !== 'boolean') errors.push(`${path}.durable must be boolean`);
  else if (!raw.durable && !isIsoTime(raw.expiresAt)) errors.push(`${path}.expiresAt is required unless durable`);
  if (!oneOf(raw.grantedBy, ['user', 'org'])) errors.push(`${path}.grantedBy must be user or org`);
}

function validateNextSteps(raw: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(raw)) {
    errors.push(`${path} must be an array`);
    return;
  }
  raw.forEach((s, i) => {
    if (!isObject(s)) {
      errors.push(`${path}[${i}] must be an object`);
      return;
    }
    switch (s.kind) {
      case 'wait':
        if (!isInt(s.ms, 1)) errors.push(`${path}[${i}].ms must be an integer >= 1`);
        break;
      case 'request_approval':
        if (!isEffect(s.effect)) errors.push(`${path}[${i}].effect must be an effect class`);
        break;
      case 'use_read_only':
      case 'observe_again':
      case 'skip_target':
      case 'stop':
        break;
      default:
        errors.push(`${path}[${i}].kind is not a next step`);
    }
  });
}

/**
 * One line the runtime writes to an agent. Agents in other languages check
 * their input with the same rules; the runtime's own tests use it to prove
 * what it sends is well-formed.
 */
export function parseRuntimeMessage(line: string, expected?: ExpectedMessage): Validated<RuntimeMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, errors: ['line is not JSON'] };
  }
  if (!isObject(raw)) return { ok: false, errors: ['message must be an object'] };
  const errors: string[] = [];
  validateBase(raw, expected, errors);
  if (!oneOf(raw.type, RUNTIME_MESSAGE_TYPES)) {
    errors.push('type is not a runtime message type');
    return { ok: false, errors };
  }
  const needTask = () => {
    if (!isNonEmpty(raw.taskId)) errors.push(`${raw.type} must carry taskId`);
  };
  const needRequest = () => {
    if (!isNonEmpty(raw.requestId)) errors.push('requestId is required');
  };
  switch (raw.type) {
    case 'agent_start':
      if (!isObject(raw.agent) || !isNonEmpty(raw.agent.id) || !isNonEmpty(raw.agent.version) || !oneOf(raw.agent.mode, AGENT_MODES))
        errors.push('agent must carry id, version and mode');
      if (!Array.isArray(raw.grants)) errors.push('grants must be an array');
      else raw.grants.forEach((g, i) => validateGrant(g, `grants[${i}]`, errors));
      if (raw.schedule !== undefined) {
        const s = raw.schedule;
        if (!isObject(s) || !oneOf(s.workHours, ['org', 'user', 'always']) || !isNonEmpty(s.timezone) || !isInt(s.idlePollSeconds, SCHEDULE_POLL.min))
          errors.push('schedule must carry workHours, timezone and idlePollSeconds');
        else if (s.windows !== undefined && !(Array.isArray(s.windows) && s.windows.every((w) => isString(w) && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(w))))
          errors.push('schedule.windows must be "HH:MM-HH:MM" strings');
      }
      if (raw.identity !== undefined && (!isObject(raw.identity) || !isNonEmpty(raw.identity.displayName))) errors.push('identity.displayName is required when identity is present');
      if (raw.resume !== undefined) {
        if (!isObject(raw.resume) || !Array.isArray(raw.resume.tasks)) errors.push('resume.tasks must be an array');
        else raw.resume.tasks.forEach((t, i) => {
          if (!isObject(t) || !isNonEmpty(t.taskId) || !isString(t.taskType) || !TASK_TYPE.test(t.taskType)) errors.push(`resume.tasks[${i}] must carry taskId and taskType`);
        });
      }
      break;
    case 'task_start':
      needTask();
      if (!isString(raw.taskType) || !TASK_TYPE.test(raw.taskType)) errors.push('taskType must be a task type name');
      if (!('input' in raw)) errors.push('input is required');
      if (!isObject(raw.budget)) errors.push('budget must be an object');
      if (!isObject(raw.session) || !isNonEmpty(raw.session.screenId) || !Array.isArray(raw.session.apps)) errors.push('session must carry screenId and apps');
      else raw.session.apps.forEach((a, i) => {
        if (!isObject(a) || !isNonEmpty(a.bundleId) || !isInt(a.pid, 1) || !isInt(a.windowId, 1)) errors.push(`session.apps[${i}] must carry bundleId, pid and windowId`);
      });
      break;
    case 'observation':
      needRequest();
      if (!isNonEmpty(raw.app)) errors.push('app is required');
      if (!isObject(raw.observation) || !isNonEmpty(raw.observation.snapshotId) || !isObject(raw.observation.window)) errors.push('observation must carry snapshotId and window');
      if (raw.check !== undefined && (!isObject(raw.check) || typeof raw.check.ok !== 'boolean' || !Array.isArray(raw.check.evidence))) errors.push('check must carry ok and evidence');
      break;
    case 'action_result': {
      needTask();
      needRequest();
      const hasResult = raw.result !== undefined;
      const hasRefusal = raw.refusal !== undefined;
      if (hasResult === hasRefusal) errors.push('action_result carries exactly one of result or refusal');
      if (hasResult && (!isObject(raw.result) || !isNonEmpty(raw.result.actionId) || !oneOf(raw.result.status, ['ok', 'no_effect', 'failed', 'stale_snapshot', 'unknown'])))
        errors.push('result must carry actionId and status');
      if (hasRefusal) {
        if (!isObject(raw.refusal) || !oneOf(raw.refusal.reason, ACTION_REFUSAL_REASONS) || !isString(raw.refusal.message)) errors.push('refusal must carry reason and message');
        else validateNextSteps(raw.refusal.nextSteps, 'refusal.nextSteps', errors);
      }
      break;
    }
    case 'unit_result':
      needTask();
      needRequest();
      if (raw.ok === true) {
        if (!oneOf(raw.route, ['verified', 'replay', 'recovered', 'repaired'])) errors.push('route must be verified, replay, recovered or repaired');
        if (!isObject(raw.observation) || !isNonEmpty(raw.observation.snapshotId)) errors.push('observation must carry snapshotId');
        if (!isObject(raw.check) || typeof raw.check.ok !== 'boolean' || !Array.isArray(raw.check.evidence)) errors.push('check must carry ok and evidence');
      } else if (raw.ok === false) {
        if (!oneOf(raw.reason, UNIT_REFUSAL_REASONS)) errors.push('reason is not a unit failure reason');
        if (!isString(raw.message)) errors.push('message must be a string');
      } else errors.push('ok must be boolean');
      break;
    case 'provider_result':
      needRequest();
      if (raw.ok === true) {
        if (!('output' in raw)) errors.push('output is required');
        if (raw.usage !== undefined) {
          const u = raw.usage;
          const tokens = (t: unknown) => t === 'unknown' || isInt(t);
          if (!isObject(u) || !tokens(u.inputTokens) || !tokens(u.outputTokens)) errors.push('usage token counts must be integers or "unknown"');
        }
      } else if (raw.ok === false) {
        if (!oneOf(raw.reason, ['provider_unavailable', 'provider_undeclared', 'purpose_not_allowed', 'quota_exhausted', 'error'])) errors.push('reason is not a provider failure reason');
        if (!isString(raw.message)) errors.push('message must be a string');
      } else errors.push('ok must be boolean');
      break;
    case 'grant':
      needTask();
      if (!isNonEmpty(raw.approvalId)) errors.push('approvalId is required');
      break;
    case 'deny':
      needTask();
      if (!isNonEmpty(raw.approvalId)) errors.push('approvalId is required');
      if (raw.guidance !== undefined) {
        const g = raw.guidance;
        if (!isObject(g) || !Array.isArray(g.hints) || !g.hints.every((h) => oneOf(h, APPROVAL_HINTS))) errors.push('guidance.hints must be approval hints');
        else if (g.text !== undefined && !isString(g.text)) errors.push('guidance.text must be a string when present');
      }
      break;
    case 'task_created':
      needRequest();
      needTask();
      break;
    case 'user_answer':
      needTask();
      if (!isNonEmpty(raw.questionId)) errors.push('questionId is required');
      if (!isString(raw.answer)) errors.push('answer must be a string');
      break;
    case 'pause':
    case 'resume':
    case 'cancel':
      needTask();
      break;
    case 'stop':
      break;
  }
  return ok(raw as unknown as RuntimeMessage, errors);
}
