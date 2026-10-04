// The right to drive BOSS直聘, shared with the task runtime: the same SQLite
// lease table (packages/task-runtime, ~/Library/Application Support/2ndscreen/
// tasks/tasks.db) and the same app scope, so the assistant and a resume task
// never act on BOSS直聘 at the same time. Any two leases on one bundle id
// overlap, whatever their account part.
//
// The lease is renewed in the background while held. Every command that
// touches BOSS直聘 first calls check(), which fails once the lease is lost
// or once its local deadline is near: a process that was suspended past its
// lease may already have been replaced by another owner, so it must stop
// rather than act on the strength of a renewal it never made.

import { join } from 'node:path';
import { defaultTaskDbPath, openTaskStore } from '../../../packages/task-runtime/src/store.ts';
import { isRuntimeError, leaseScopeKey } from '../../../packages/task-runtime/src/contracts.ts';
import type { SessionLease, TaskStore } from '../../../packages/task-runtime/src/contracts.ts';

export class LeaseLostError extends Error {}

export interface AppLeaseOptions {
  bundleId: string;
  /** The ledger holding the lease table; default the task runtime's. */
  dbPath?: string;
  ttlMs?: number;
  /** Stop acting this long before the lease would run out. */
  marginMs?: number;
  ownerPid?: number;
  /** Clock for the deadline and the ledger alike; default Date.now. */
  now?: () => number;
}

export const LEASE_DEFAULTS = { ttlMs: 60_000, marginMs: 15_000 } as const;

/** The ledger the task runtime uses: $SECONDSCREEN_TASKS_DIR/tasks.db when set, else its default. */
export function taskDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SECONDSCREEN_TASKS_DIR ? join(env.SECONDSCREEN_TASKS_DIR, 'tasks.db') : defaultTaskDbPath();
}

/** Someone else holds BOSS直聘; says who, for the log. */
export class LeaseBusyError extends Error {}

export class AppLease {
  private lost: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private renewing: Promise<void> | undefined;

  private constructor(
    private readonly store: TaskStore,
    private lease: SessionLease,
    private readonly ttlMs: number,
    private readonly marginMs: number,
    private readonly now: () => number,
  ) {
    this.timer = setInterval(() => void this.renew(), Math.max(1_000, Math.floor(ttlMs / 3)));
    this.timer.unref();
  }

  /** Take the BOSS直聘 lease, or throw LeaseBusyError naming who holds it. */
  static async acquire(options: AppLeaseOptions): Promise<AppLease> {
    const ttlMs = options.ttlMs ?? LEASE_DEFAULTS.ttlMs;
    const marginMs = options.marginMs ?? LEASE_DEFAULTS.marginMs;
    if (marginMs >= ttlMs) throw new Error('the lease margin must be shorter than the lease');
    const now = options.now ?? Date.now;
    const store = await openTaskStore({ path: options.dbPath ?? taskDbPath(), clock: { now: () => new Date(now()) } });
    try {
      const lease = await store.acquireLease({
        scopeKey: leaseScopeKey(options.bundleId),
        holder: 'legacy-assistant',
        ownerPid: options.ownerPid ?? process.pid,
        ttlMs,
      });
      return new AppLease(store, lease, ttlMs, marginMs, now);
    } catch (error) {
      await store.close().catch(() => undefined);
      if (isRuntimeError(error, 'lease_held')) throw new LeaseBusyError(error.message);
      throw error;
    }
  }

  get leaseId(): string {
    return this.lease.leaseId;
  }

  /** Throws LeaseLostError unless this process may still act on BOSS直聘. */
  check(): void {
    if (this.lost) throw new LeaseLostError(this.lost);
    if (this.now() >= Date.parse(this.lease.expiresAt) - this.marginMs) {
      this.fence('the BOSS直聘 lease ran out before it was renewed; stopping before the next action');
      throw new LeaseLostError(this.lost!);
    }
  }

  /** Extend the lease; once it fails the lease stays lost. */
  renew(): Promise<void> {
    if (this.lost || this.renewing) return this.renewing ?? Promise.resolve();
    // A renewal after the local deadline would revive a lease another owner may already hold.
    if (this.now() >= Date.parse(this.lease.expiresAt) - this.marginMs) {
      this.fence('the BOSS直聘 lease ran out before it was renewed');
      return Promise.resolve();
    }
    this.renewing = this.store
      .renewLease(this.lease.leaseId, this.ttlMs)
      .then((lease) => {
        this.lease = lease;
      })
      .catch((error: unknown) => {
        this.fence(`the BOSS直聘 lease could not be renewed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.renewing = undefined;
      });
    return this.renewing;
  }

  /** Give the lease up and close the ledger. Safe to call twice. */
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.renewing;
    this.lost ??= 'released';
    // Removing by id touches only this lease's row: an owner that took over holds a row of its own.
    await this.store.releaseLease(this.lease.leaseId).catch(() => undefined);
    await this.store.close().catch(() => undefined);
  }

  private fence(reason: string): void {
    this.lost ??= reason;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
