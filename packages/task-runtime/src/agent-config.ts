// What the agent host runs, from <tasksDir>/agents/config.json, and the
// agent packages it names. Everything is checked before anything starts,
// and every problem is named at once, like the other validators.
//
//   {
//     "agents": [{
//       "package": "/absolute/path/to/package",       // holds agent.json
//       "enabled": true,
//       "account": { "platform": "boss", "accountKey": "hr-zhang" },
//       "takeOver": false,
//       "grants": [{ "application": "com.zhipin.www", "effect": "external-submit",
//                    "mode": "human_in_the_loop", "expiresAt": "2026-10-14T00:00:00+08:00" }],
//       "ceilings": { "user": { "external-submit": { "perDay": 10 } } },
//       "workHours": { "timezone": "Asia/Shanghai", "days": [1,2,3,4,5],
//                      "windows": ["09:00-12:00", "13:30-18:30"] }
//     }],
//     "providers": {
//       "ark-text": { "kind": "openai-chat", "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
//                     "model": "doubao-seed-2-1-lite-260915", "apiKeyEnv": "ARK_API_KEY" }
//     }
//   }
//
// A grant must say when it ends (`expiresAt`) or that it does not
// (`durable: true`); there is no silent default.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  APPROVAL_MODES,
  satisfiesRange,
  validateAgentSpec,
  type AgentAccount,
  type AgentSpec,
  type ApprovalMode,
  type EffectLimit,
  type Grant,
} from './agent-contracts.ts';
import type { Ceilings } from './agent-host.ts';
import { EFFECT_CLASSES, RuntimeError, type Validated, type WindowProfile } from './contracts.ts';

export interface WorkHoursConfig {
  timezone: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday; absent means every day. */
  days?: number[];
  /** "HH:MM-HH:MM", end exclusive; a window may run past midnight ("22:00-02:00"). */
  windows: string[];
}

export interface ProviderConfig {
  kind: 'openai-chat';
  /** The only origin the key is ever sent to. */
  baseUrl: string;
  model: string;
  /** Name of the host's environment variable holding the key. */
  apiKeyEnv: string;
  timeoutMs?: number;
}

export interface AgentEntryConfig {
  package: string;
  enabled: boolean;
  account: AgentAccount;
  takeOver?: boolean;
  grants?: Array<Omit<Grant, 'agentId' | 'accountKey' | 'grantedAt' | 'grantedBy'> & { grantedAt?: string }>;
  ceilings?: Ceilings;
  workHours?: WorkHoursConfig;
}

export interface HostConfig {
  agents: AgentEntryConfig[];
  providers: Record<string, ProviderConfig>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isIsoTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]|24):([0-5]\d)$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateLimits(raw: unknown, path: string, errors: string[]): void {
  if (raw === undefined) return;
  if (!isObject(raw)) return void errors.push(`${path} must be an object`);
  for (const [effect, limit] of Object.entries(raw)) {
    if (!(EFFECT_CLASSES as readonly string[]).includes(effect)) errors.push(`${path}.${effect} is not an effect class`);
    const l = limit as Partial<EffectLimit> | null;
    if (!isObject(l) || (l.perDay === undefined && l.minIntervalMs === undefined)) errors.push(`${path}.${effect} must set perDay or minIntervalMs`);
    else {
      if (l.perDay !== undefined && !(Number.isInteger(l.perDay) && l.perDay >= 0)) errors.push(`${path}.${effect}.perDay must be a whole number`);
      if (l.minIntervalMs !== undefined && !(Number.isInteger(l.minIntervalMs) && l.minIntervalMs >= 0)) errors.push(`${path}.${effect}.minIntervalMs must be a whole number`);
    }
  }
}

export function validateHostConfig(raw: unknown): Validated<HostConfig> {
  if (!isObject(raw)) return { ok: false, errors: ['config must be an object'] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (k !== 'agents' && k !== 'providers') errors.push(`${k} is not a config field`);
  if (!Array.isArray(raw.agents)) errors.push('agents must be an array');
  else
    raw.agents.forEach((a, i) => {
      const p = `agents[${i}]`;
      if (!isObject(a)) return void errors.push(`${p} must be an object`);
      for (const k of Object.keys(a))
        if (!['package', 'enabled', 'account', 'takeOver', 'grants', 'ceilings', 'workHours'].includes(k)) errors.push(`${p}.${k} is not a field of an agent entry`);
      if (!isNonEmpty(a.package) || !isAbsolute(a.package)) errors.push(`${p}.package must be an absolute directory`);
      if (typeof a.enabled !== 'boolean') errors.push(`${p}.enabled must be boolean`);
      if (!isObject(a.account) || !isNonEmpty(a.account.platform) || typeof a.account.accountKey !== 'string' || !KEY.test(a.account.accountKey))
        errors.push(`${p}.account must name a platform and an accountKey of letters, digits, '.', '_' or '-'`);
      if (a.takeOver !== undefined && typeof a.takeOver !== 'boolean') errors.push(`${p}.takeOver must be boolean`);
      if (a.grants !== undefined) {
        if (!Array.isArray(a.grants)) errors.push(`${p}.grants must be an array`);
        else
          a.grants.forEach((g, j) => {
            const gp = `${p}.grants[${j}]`;
            if (!isObject(g)) return void errors.push(`${gp} must be an object`);
            if (!isNonEmpty(g.application)) errors.push(`${gp}.application must be a bundle id`);
            if (!(EFFECT_CLASSES as readonly string[]).includes(g.effect as string)) errors.push(`${gp}.effect must be an effect class`);
            if (!(APPROVAL_MODES as readonly string[]).includes(g.mode as string)) errors.push(`${gp}.mode must be one of ${APPROVAL_MODES.join(', ')}`);
            const durable = g.durable === true;
            if (g.durable !== undefined && typeof g.durable !== 'boolean') errors.push(`${gp}.durable must be boolean`);
            if (!durable && !isIsoTime(g.expiresAt)) errors.push(`${gp} must say when it ends (expiresAt) or be durable: true`);
            if (durable && g.expiresAt !== undefined) errors.push(`${gp} is durable and cannot also expire`);
            if (g.grantedAt !== undefined && !isIsoTime(g.grantedAt)) errors.push(`${gp}.grantedAt must be an ISO time`);
          });
      }
      if (a.ceilings !== undefined) {
        if (!isObject(a.ceilings)) errors.push(`${p}.ceilings must be an object`);
        else {
          for (const k of Object.keys(a.ceilings)) if (!['org', 'user', 'approvalFloor'].includes(k)) errors.push(`${p}.ceilings.${k} is not a ceiling`);
          validateLimits(a.ceilings.org, `${p}.ceilings.org`, errors);
          validateLimits(a.ceilings.user, `${p}.ceilings.user`, errors);
          if (a.ceilings.approvalFloor !== undefined) {
            if (!isObject(a.ceilings.approvalFloor)) errors.push(`${p}.ceilings.approvalFloor must be an object`);
            else
              for (const [effect, mode] of Object.entries(a.ceilings.approvalFloor))
                if (!(EFFECT_CLASSES as readonly string[]).includes(effect) || !(APPROVAL_MODES as readonly string[]).includes(mode as string))
                  errors.push(`${p}.ceilings.approvalFloor.${effect} must map an effect class to an approval mode`);
          }
        }
      }
      if (a.workHours !== undefined) {
        const w = a.workHours as Partial<WorkHoursConfig> | null;
        if (!isObject(w)) errors.push(`${p}.workHours must be an object`);
        else {
          if (!isNonEmpty(w.timezone) || !validTimezone(w.timezone)) errors.push(`${p}.workHours.timezone must be an IANA timezone such as Asia/Shanghai`);
          if (!Array.isArray(w.windows) || w.windows.length === 0 || !w.windows.every((x) => typeof x === 'string' && WINDOW.test(x)))
            errors.push(`${p}.workHours.windows must be "HH:MM-HH:MM" strings`);
          if (w.days !== undefined && !(Array.isArray(w.days) && w.days.length > 0 && w.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)))
            errors.push(`${p}.workHours.days must list ISO weekdays 1-7`);
        }
      }
    });
  const providers = raw.providers ?? {};
  if (!isObject(providers)) errors.push('providers must be an object');
  else
    for (const [id, cfg] of Object.entries(providers)) {
      const p = `providers.${id}`;
      if (!KEY.test(id)) errors.push(`${p}: provider ids are letters, digits, '.', '_' or '-'`);
      if (!isObject(cfg)) {
        errors.push(`${p} must be an object`);
        continue;
      }
      if (cfg.kind !== 'openai-chat') errors.push(`${p}.kind must be openai-chat`);
      let url: URL | undefined;
      try {
        url = new URL(String(cfg.baseUrl));
      } catch {
        // reported below
      }
      const local = url !== undefined && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
      if (!url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password)
        errors.push(`${p}.baseUrl must be an https URL without credentials (http only for localhost)`);
      if (!isNonEmpty(cfg.model)) errors.push(`${p}.model must name a model`);
      if (typeof cfg.apiKeyEnv !== 'string' || !ENV_NAME.test(cfg.apiKeyEnv)) errors.push(`${p}.apiKeyEnv must name an environment variable, e.g. ARK_API_KEY`);
      if (cfg.timeoutMs !== undefined && !(Number.isInteger(cfg.timeoutMs) && (cfg.timeoutMs as number) > 0)) errors.push(`${p}.timeoutMs must be a positive whole number`);
    }
  return errors.length ? { ok: false, errors } : { ok: true, value: { agents: raw.agents as AgentEntryConfig[], providers: providers as Record<string, ProviderConfig> } };
}

export function readHostConfig(path: string): HostConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RuntimeError('not_found', `no agent host config at ${path}`);
    throw new RuntimeError('io', `cannot read ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RuntimeError('invalid_input', `${path} is not JSON`);
  }
  const result = validateHostConfig(raw);
  if (!result.ok) throw new RuntimeError('invalid_input', `${path}: ${result.errors.join('; ')}`, { errors: result.errors });
  return result.value;
}

/** The grants of one entry, made whole: the agent, the account and when they were given. */
export function grantsOf(entry: AgentEntryConfig, agentId: string, grantedAt: string): Grant[] {
  return (entry.grants ?? []).map((g) => ({
    agentId,
    application: g.application,
    accountKey: entry.account.accountKey,
    effect: g.effect,
    mode: g.mode as ApprovalMode,
    grantedAt: g.grantedAt ?? grantedAt,
    ...(g.durable ? { durable: true } : { durable: false, expiresAt: new Date(g.expiresAt!).toISOString() }),
    grantedBy: 'user',
  }));
}

// ---------------------------------------------------------------------------
// Packages

export interface AgentPackage {
  dir: string;
  spec: AgentSpec;
  /** Window profile per application, by bundle id. */
  profiles: Map<string, WindowProfile>;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * The package at `dir`: agent.json valid and meant for this runtime, a
 * readable profile inside the package for every application, and the
 * executor's program present inside it.
 */
export function loadAgentPackage(dir: string): AgentPackage {
  if (!isAbsolute(dir)) throw new RuntimeError('invalid_input', `${dir} is not absolute`);
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw new RuntimeError('not_found', `no agent package at ${dir}`);
  }
  const specPath = join(root, 'agent.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch {
    throw new RuntimeError('invalid_input', `${specPath} is missing or not JSON`);
  }
  const checked = validateAgentSpec(raw);
  if (!checked.ok) throw new RuntimeError('invalid_input', `${specPath}: ${checked.errors.join('; ')}`, { errors: checked.errors });
  const spec = checked.value;
  if (!satisfiesRange(AGENT_RUNTIME_CONTRACT_VERSION, spec.runtimeContract))
    throw new RuntimeError('capability_missing', `${spec.id} needs runtime contract ${spec.runtimeContract}; this runtime is ${AGENT_RUNTIME_CONTRACT_VERSION}`);
  const profiles = new Map<string, WindowProfile>();
  for (const app of spec.applications) {
    const path = resolve(root, 'profiles', 'macos', `${app.windowProfile}.json`);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new RuntimeError('invalid_input', `${spec.id}: no profile ${app.windowProfile} for ${app.bundleId}`);
    }
    if (!inside(root, real)) throw new RuntimeError('invalid_input', `${spec.id}: profile ${app.windowProfile} leaves the package`);
    const profile = JSON.parse(readFileSync(real, 'utf8')) as WindowProfile;
    if (profile.id !== app.windowProfile || profile.bundleId !== app.bundleId || !(profile.logicalWidth > 0) || !(profile.logicalHeight > 0))
      throw new RuntimeError('invalid_input', `${spec.id}: profile ${app.windowProfile} must have id ${app.windowProfile}, bundleId ${app.bundleId} and a size`);
    profiles.set(app.bundleId, profile);
  }
  if (spec.executor.kind === 'process' || spec.executor.kind === 'mcp') {
    const program = resolve(root, spec.executor.command[0]!);
    if (!inside(root, program) || !existsSync(program)) throw new RuntimeError('invalid_input', `${spec.id}: the executor program ${spec.executor.command[0]} is not in the package`);
    if (existsSync(program) && !inside(root, realpathSync(program))) throw new RuntimeError('invalid_input', `${spec.id}: the executor program links out of the package`);
  }
  return { dir: root, spec, profiles };
}

// ---------------------------------------------------------------------------
// Work hours

const weekday: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Weekday and minute of the day at `now` in `timezone`. */
export function localTime(now: Date, timezone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: weekday[get('weekday')] ?? 0, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/**
 * Whether `now` is in the work hours. A window that ends past midnight
 * belongs to the day it starts on.
 */
export function workHoursFunction(config: WorkHoursConfig): (now: Date) => boolean {
  const windows = config.windows.map((w) => {
    const m = WINDOW.exec(w)!;
    return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
  });
  const days = config.days ? new Set(config.days) : undefined;
  return (now) => {
    const { day, minute } = localTime(now, config.timezone);
    const yesterday = day === 1 ? 7 : day - 1;
    for (const { start, end } of windows) {
      if (start < end) {
        if ((!days || days.has(day)) && minute >= start && minute < end) return true;
      } else {
        // Over midnight: the evening part on its own day, the morning part on the next.
        if ((!days || days.has(day)) && minute >= start) return true;
        if ((!days || days.has(yesterday)) && minute < end) return true;
      }
    }
    return false;
  };
}

