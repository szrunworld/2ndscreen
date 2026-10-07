// The skills the runtime ships, as agents of the hub (RFC 0001, step 3 of
// taking in the task runtime). A builtin skill keeps its own runner — the
// BOSS workflow with procedures, recovery and validators — but every action
// that runner sends goes through the same check chain as a process agent's
// act: declared application and effect, grants, the limits of every level,
// the work hours of its entry in agents/config.json, counted in the same
// effect ledger. An entry `builtin:<skill id>` in the config gives the skill
// its account, work hours and ceilings; without one it keeps the limits of
// its manifest and runs at any hour, as before.
//
// A refused action stops the run as `permission_missing`: the task waits,
// with the refusal in its error, and goes on when resumed.

import { statSync } from 'node:fs';
import { builtinSkillOf, grantsOf, readHostConfig, workHoursFunction, type AgentEntryConfig } from './agent-config.ts';
import type { AgentSpec, Grant } from './agent-contracts.ts';
import { checkAction, effectiveLimit, LIMIT_WINDOW_MS, type Ceilings, type EffectLedger } from './agent-host.ts';
import { RuntimeError, systemClock, type ActionRequest, type ActionResult, type Clock, type Session, type SessionManager } from './contracts.ts';

export interface BuiltinPolicy {
  /** The skill's entry in the host config, when it has one and it is enabled. */
  entry?: AgentEntryConfig;
  grants: Grant[];
  ceilings: Ceilings;
  inHours(now: Date): boolean;
}

const OPEN: BuiltinPolicy = { grants: [], ceilings: {}, inHours: () => true };

/**
 * The policy of a builtin skill from the host config, read again whenever
 * the file changes. A config that does not read keeps the last good policy,
 * as the agent host keeps its running config.
 */
export function builtinPolicySource(configPath: string, skillId: string): () => BuiltinPolicy {
  let stamp: string | undefined;
  let current: BuiltinPolicy = OPEN;
  return () => {
    let next: string;
    let at: string;
    try {
      const st = statSync(configPath);
      next = `${st.mtimeMs}/${st.size}`;
      at = new Date(st.mtimeMs).toISOString();
    } catch {
      stamp = undefined;
      current = OPEN;
      return current;
    }
    if (next === stamp) return current;
    try {
      const entry = readHostConfig(configPath).agents.find((e) => e.enabled && builtinSkillOf(e) === skillId);
      current = entry
        ? { entry, grants: grantsOf(entry, skillId, at), ceilings: entry.ceilings ?? {}, inHours: entry.workHours ? workHoursFunction(entry.workHours) : () => true }
        : OPEN;
      stamp = next;
    } catch {
      // Not valid now: the last good policy stays.
    }
    return current;
  };
}

export interface CheckedSessionsOptions {
  spec: AgentSpec;
  policy: () => BuiltinPolicy;
  ledger: EffectLedger;
  clock?: Clock;
  /** Every refusal, for the log. */
  onRefusal?: (refusal: { taskId: string; reason: string; message: string }) => void;
}

/** Sessions whose every act passes the check chain first; the rest of the session is the inner one. */
export function checkedSessionManager(inner: SessionManager, options: CheckedSessionsOptions): SessionManager {
  const clock = options.clock ?? systemClock;
  return {
    async open(request, signal) {
      const session = await inner.open(request, signal);
      const accountKey = () => request.account?.accountKey ?? options.policy().entry?.account.accountKey ?? 'default';
      const act = async (q: ActionRequest, actSignal?: AbortSignal): Promise<ActionResult> => {
        const policy = options.policy();
        const now = clock.now();
        const app = session.binding().window.bundleId;
        const effect = q.action.effect;
        const limit = effectiveLimit(effect, options.spec, policy.ceilings);
        const limited = limit.perDay !== undefined || limit.minIntervalMs !== undefined;
        const key = accountKey();
        const uses = limited ? await options.ledger.uses({ application: app, accountKey: key, effect, since: new Date(now.getTime() - LIMIT_WINDOW_MS).toISOString() }) : [];
        const refusal = checkAction({
          spec: options.spec,
          accountKey: key,
          app,
          action: q.action,
          now,
          grants: policy.grants,
          ceilings: policy.ceilings,
          uses,
          inWorkHours: policy.inHours(now),
          unknownTargets: new Set(),
          approvals: new Map(),
        });
        if (refusal) {
          options.onRefusal?.({ taskId: request.taskId, reason: refusal.reason, message: refusal.message });
          throw new RuntimeError('permission_missing', `${refusal.reason}: ${refusal.message}`, { refusal: refusal.reason });
        }
        const result = await session.act(q, actSignal);
        if (limited)
          await options.ledger.record({ agentId: options.spec.id, taskId: request.taskId, application: app, accountKey: key, effect, at: now.toISOString(), status: result.status });
        return result;
      };
      // Everything but act is the session itself, bound to it.
      return new Proxy(session, {
        get(target, prop, receiver) {
          if (prop === 'act') return act;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
