// A task's hold on one app window: the lease that keeps every other actor
// off the app, the window binding, the latest snapshot, and the only path
// from a Locator to input. Element indexes are honoured only against the
// snapshot this session read last; any action, rebind or exclusive grant
// makes that snapshot stale, and semantic locators are resolved against a
// fresh read. Nothing here loads or calls a model.

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  RuntimeError,
  assertValid,
  globalToRelative,
  globalToScreenshotRect,
  isRuntimeError,
  leaseScopeKey,
  rectContains,
  screenshotToGlobal,
  systemClock,
  throwIfAborted,
  validateActionRequest,
  validateCondition,
  validateWaitSpec,
  WAIT_LIMITS,
  type ActionRequest,
  type ActionResult,
  type ActorGrant,
  type CheckResult,
  type Clock,
  type Condition,
  type DesktopAdapter,
  type LeaseStore,
  type LocalVision,
  type Locator,
  type Observation,
  type ObserveOptions,
  type OpenSessionRequest,
  type Point,
  type RuntimeErrorCode,
  type Session,
  type SessionLease,
  type SessionManager,
  type UIElement,
  type WaitSpec,
  type WindowBinding,
} from './contracts.ts';

export interface SessionManagerDeps {
  adapter: DesktopAdapter;
  leases: LeaseStore;
  policy: { submitAllowed: boolean; foregroundAllowed: boolean };
  vision?: LocalVision; // 解析 template/ocr 定位器；缺失时这类定位器返回 capability_missing
  clock?: Clock;
  newId?: () => string;
  ownerPid?: number; // 默认 process.pid，应为长期 worker
  pollMs?: number; // waitFor 默认轮询间隔
}

const DEFAULT_POLL_MS = 250;
/** Shortest lease the session can keep renewed. */
const MIN_LEASE_TTL_MS = 1_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RuntimeError('cancelled', 'the operation was cancelled'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RuntimeError('cancelled', 'the operation was cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const center = (r: { x: number; y: number; width: number; height: number }): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Elements a role/label locator picks out of one snapshot. */
export function matchElements(elements: readonly UIElement[], locator: Extract<Locator, { kind: 'element' }>): UIElement[] {
  const pattern = locator.labelPattern !== undefined ? new RegExp(locator.labelPattern) : undefined;
  return elements.filter((e) => {
    if (locator.index !== undefined && e.index !== locator.index) return false;
    if (locator.role !== undefined && e.role !== locator.role) return false;
    if (locator.label !== undefined && e.label !== locator.label) return false;
    if (pattern && !pattern.test(e.label ?? e.value ?? '')) return false;
    if (locator.within && !(e.frame && rectContains(locator.within, center(e.frame)))) return false;
    return true;
  });
}

const needsScreenshot = (c: Condition): boolean =>
  c.kind === 'element' ? c.locator.kind === 'ocr' || c.locator.kind === 'template' : c.kind === 'all' || c.kind === 'any' ? c.conditions.some(needsScreenshot) : false;

const needsScreen = (c: Condition): boolean => (c.kind === 'all' || c.kind === 'any' ? c.conditions.some(needsScreen) : c.kind !== 'file');

/** Same process: same pid and the same recorded start time. A pid alone proves nothing. */
const sameProcess = (a: { pid?: unknown; processStartedAt?: unknown } | undefined, b: { pid: number; processStartedAt?: string }) =>
  !!a && a.pid === b.pid && b.processStartedAt !== undefined && a.processStartedAt === b.processStartedAt;

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const clock = deps.clock ?? systemClock;
  const newId = deps.newId ?? (() => randomUUID());
  const ownerPid = deps.ownerPid ?? process.pid;
  const defaultPollMs = Math.min(WAIT_LIMITS.maxPollMs, Math.max(WAIT_LIMITS.minPollMs, deps.pollMs ?? DEFAULT_POLL_MS));

  return {
    async open(request: OpenSessionRequest, signal?: AbortSignal): Promise<Session> {
      throwIfAborted(signal);
      const { profile } = request;
      if (!request.taskId) throw new RuntimeError('invalid_input', 'a session needs a taskId');
      if (!(request.leaseTtlMs >= MIN_LEASE_TTL_MS)) throw new RuntimeError('invalid_input', `leaseTtlMs must be at least ${MIN_LEASE_TTL_MS}`);
      if (!(profile.logicalWidth > 0 && profile.logicalHeight > 0)) throw new RuntimeError('invalid_input', `profile ${profile.id} has no size`);
      const lease = await deps.leases.acquireLease({
        scopeKey: leaseScopeKey(profile.bundleId, request.account?.accountKey),
        holder: 'runtime',
        ownerPid,
        taskId: request.taskId,
        ttlMs: request.leaseTtlMs,
      });
      // Renewal starts now: preparing the screen and app can outlast one ttl.
      const keeper = new LeaseKeeper(deps.leases, lease, request.leaseTtlMs, clock);
      const linked = AbortSignal.any([...(signal ? [signal] : []), keeper.signal]);
      let binding: WindowBinding | undefined;
      try {
        keeper.check();
        const screen = await keeper.guard(signal, () => deps.adapter.ensureScreen(profile, linked));
        keeper.check();
        binding = await keeper.guard(signal, () => deps.adapter.bindApp(screen.screenId, profile, { takeOver: request.takeOver }, linked));
        if (binding.window.bundleId !== profile.bundleId) {
          const foreign = binding;
          binding = undefined; // not ours to clean up
          throw new RuntimeError('conflict', `the bound window belongs to ${foreign.window.bundleId}, not ${profile.bundleId}`);
        }
        throwIfAborted(signal);
        keeper.check();
        return new TaskSession(deps, clock, defaultPollMs, newId(), request, keeper, binding);
      } catch (error) {
        keeper.stop();
        // Only a window this open launched is handed back; an attached one stays where it was.
        if (binding?.launchedByRuntime && !keeper.fenced) await deps.adapter.releaseWindow(binding).catch(() => undefined);
        await deps.leases.releaseLease(lease.leaseId).catch(() => undefined);
        throw error;
      }
    },
  };
}

/**
 * Keeps one lease alive by renewing it every ttl/3. When a renewal fails or
 * the lease runs out, it fences: its signal aborts, so every native
 * operation and actor running under the lease is stopped, and nothing new
 * may start.
 */
class LeaseKeeper {
  lease: SessionLease;
  fenced: RuntimeError | undefined;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private renewing: Promise<void> | undefined;
  private readonly leases: LeaseStore;
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(leases: LeaseStore, lease: SessionLease, ttlMs: number, clock: Clock) {
    this.leases = leases;
    this.lease = lease;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.timer = setInterval(() => void this.renew(), Math.max(MIN_LEASE_TTL_MS / 4, Math.floor(ttlMs / 3)));
    this.timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private renew(): Promise<void> {
    if (this.fenced || !this.timer) return Promise.resolve();
    this.renewing ??= this.leases
      .renewLease(this.lease.leaseId, this.ttlMs)
      .then((lease) => {
        if (!this.fenced) this.lease = lease;
      })
      .catch((error: unknown) => this.fence(`the lease could not be renewed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.renewing = undefined;
      });
    return this.renewing;
  }

  fence(message: string): void {
    if (this.fenced) return;
    this.fenced = new RuntimeError('lease_held', message, { leaseId: this.lease.leaseId });
    this.stop();
    this.controller.abort(this.fenced);
  }

  /** Throws the fence if the lease is lost or has run out. */
  check(): void {
    if (!this.fenced && Date.parse(this.lease.expiresAt) <= this.clock.now().getTime()) this.fence('the lease expired');
    if (this.fenced) throw this.fenced;
  }

  /** Runs fn; a cancellation caused by the fence, not by the caller, surfaces as the fence. */
  async guard<T>(callerSignal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (this.fenced && !callerSignal?.aborted && isRuntimeError(error, 'cancelled')) throw this.fenced;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.renewing;
  }
}

type Located = { ok: true; points: Point[] } | { ok: false; code: RuntimeErrorCode; message: string };

class TaskSession implements Session {
  readonly id: string;
  readonly taskId: string;
  readonly profile: OpenSessionRequest['profile'];
  private readonly deps: SessionManagerDeps;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly request: OpenSessionRequest;
  private readonly keeper: LeaseKeeper;
  /** Aborted by close, so in-flight native work stops before the window and lease go. */
  private readonly closing = new AbortController();
  private currentBinding: WindowBinding;
  /** The last read; element indexes are valid only against it. */
  private current: Observation | undefined;
  /** The one native operation (read, action or rebind) running now; others are refused, not queued. */
  private operation: { what: string; done: Promise<unknown> } | undefined;
  private grant: { controller: AbortController; done: Promise<unknown> } | undefined;
  private closed = false;

  constructor(
    deps: SessionManagerDeps,
    clock: Clock,
    pollMs: number,
    id: string,
    request: OpenSessionRequest,
    keeper: LeaseKeeper,
    binding: WindowBinding,
  ) {
    this.deps = deps;
    this.clock = clock;
    this.pollMs = pollMs;
    this.id = id;
    this.request = request;
    this.taskId = request.taskId;
    this.profile = request.profile;
    this.keeper = keeper;
    this.currentBinding = binding;
  }

  get lease(): SessionLease {
    return this.keeper.lease;
  }

  binding(): WindowBinding {
    return this.currentBinding;
  }

  /** Throws unless this session may touch the window now. */
  private usable(signal: AbortSignal | undefined, what: string): void {
    throwIfAborted(signal);
    if (this.closed) throw new RuntimeError('conflict', `the session is closed; cannot ${what}`);
    this.keeper.check();
    if (this.grant) throw new RuntimeError('actor_busy', `another actor holds the window; cannot ${what}`);
  }

  /** The caller's signal joined with the lease fence and close. */
  private linked(signal: AbortSignal | undefined): AbortSignal {
    return AbortSignal.any([...(signal ? [signal] : []), this.keeper.signal, this.closing.signal]);
  }

  /**
   * Runs one native operation with the window to itself. A second one is
   * refused with actor_busy rather than interleaved, so a read cannot land
   * between another action's resolution and its delivery.
   */
  private async exclusive<T>(what: string, signal: AbortSignal | undefined, fn: (linked: AbortSignal) => Promise<T>): Promise<T> {
    this.usable(signal, what);
    if (this.operation) throw new RuntimeError('actor_busy', `cannot ${what} while ${this.operation.what} is running`);
    const done = this.keeper.guard(signal, () => fn(this.linked(signal)));
    this.operation = { what, done };
    try {
      return await done;
    } catch (error) {
      if (this.closed && !signal?.aborted && isRuntimeError(error, 'cancelled')) throw new RuntimeError('conflict', `the session closed during ${what}`);
      throw error;
    } finally {
      this.operation = undefined;
    }
  }

  observe(options: ObserveOptions = {}, signal?: AbortSignal): Promise<Observation> {
    return this.exclusive('observe', signal, (linked) => this.read(options, linked));
  }

  private async read(options: ObserveOptions, signal: AbortSignal): Promise<Observation> {
    const binding = this.currentBinding;
    const observation = await this.deps.adapter.observe(binding, { elements: true, ...options }, signal);
    if (observation.window.pid !== binding.window.pid || observation.window.windowId !== binding.window.windowId)
      throw new RuntimeError('window_lost', 'the observation is of another window');
    throwIfAborted(signal);
    // Every read re-measures the window; later coordinates use this geometry, not the bind-time one.
    if (this.currentBinding === binding)
      this.currentBinding = { ...binding, window: { ...binding.window, frame: observation.window.frame, contentFrame: observation.window.contentFrame } };
    const own: Observation = { ...observation, sessionId: this.id };
    this.current = own;
    return own;
  }

  async act(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    if (request?.action?.effect === 'external-submit' && !this.deps.policy.submitAllowed)
      throw new RuntimeError('forbidden_effect', 'external-submit actions are not allowed in this session');
    assertValid(validateActionRequest(request, this.deps.policy), 'action request');
    return this.exclusive('act', signal, (linked) => this.deliver(request, linked));
  }

  private async deliver(request: ActionRequest, signal: AbortSignal): Promise<ActionResult> {
    const startedAt = this.clock.now().toISOString();
    const action = request.action;
    const target = action.kind === 'key' ? undefined : action.target;
    const refuse = (status: 'failed' | 'stale_snapshot', code: RuntimeErrorCode, message: string, beforeSnapshotId?: string): ActionResult => ({
      actionId: request.actionId,
      status,
      beforeSnapshotId,
      startedAt,
      finishedAt: this.clock.now().toISOString(),
      error: { code, message },
    });

    let resolved: ActionRequest = request;
    let before = this.current;
    if (target?.kind === 'element' && target.index !== undefined) {
      if (!before || request.snapshotId !== before.snapshotId)
        return refuse('stale_snapshot', 'snapshot_stale', 'the element index belongs to an older snapshot; observe again', request.snapshotId);
      if (!before.elements?.some((e) => e.index === target.index))
        return refuse('stale_snapshot', 'snapshot_stale', `element ${target.index} is not in snapshot ${before.snapshotId}`, before.snapshotId);
    } else if (target?.kind === 'relative') {
      // A window fraction becomes a point only against the window as it is now.
      before = await this.read({ elements: false }, signal);
    } else if (target) {
      // Semantic and visual locators are resolved on a fresh read, never on a cached one.
      const visual = target.kind === 'ocr' || target.kind === 'template';
      if (visual && !this.deps.vision) return refuse('failed', 'capability_missing', `${target.kind} locators need local vision`);
      before = await this.read({ elements: !visual, screenshot: visual }, signal);
      if (target.kind === 'element') {
        const found = matchElements(before.elements ?? [], target);
        if (found.length !== 1)
          return refuse('failed', found.length ? 'conflict' : 'not_found', found.length ? `${found.length} elements match the locator` : 'no element matches the locator', before.snapshotId);
        resolved = { ...request, snapshotId: before.snapshotId, action: { ...action, target: { kind: 'element', index: found[0]!.index } } as ActionRequest['action'] };
      } else {
        const located = await this.locateVisual(target, before, signal);
        if (!located.ok) return refuse('failed', located.code, located.message, before.snapshotId);
        if (located.points.length !== 1)
          return refuse('failed', located.points.length ? 'conflict' : 'not_found', located.points.length ? `${located.points.length} places match the locator` : 'nothing matches the locator', before.snapshotId);
        const point = globalToRelative(before.window, located.points[0]!);
        resolved = { actionId: request.actionId, action: { ...action, target: { kind: 'relative', point } } as ActionRequest['action'] };
      }
    }

    throwIfAborted(signal);
    this.keeper.check();
    // The page may change from here on, whatever the result says.
    this.current = undefined;
    const result = await this.deps.adapter.act(this.currentBinding, resolved, signal);
    // An action cut off by the fence may still have landed; it stays unknown, blamed on the lease.
    if (result.status === 'unknown' && this.keeper.fenced) result.error = { code: 'lease_held', message: this.keeper.fenced.message };
    return { ...result, actionId: request.actionId, beforeSnapshotId: before?.snapshotId, locatorIndex: target ? 0 : undefined };
  }

  /** Global points where an ocr or template locator matches in the observation's screenshot. */
  private async locateVisual(locator: Extract<Locator, { kind: 'ocr' | 'template' }>, observation: Observation, signal?: AbortSignal): Promise<Located> {
    const vision = this.deps.vision;
    if (!vision) return { ok: false, code: 'capability_missing', message: `${locator.kind} locators need local vision` };
    const shot = observation.screenshot;
    if (!shot) return { ok: false, code: 'capability_missing', message: 'the observation has no screenshot' };
    const roi = locator.region ? globalToScreenshotRect(shot, locator.region) : undefined;
    if (locator.kind === 'ocr') {
      const result = await vision.ocr(shot.path, roi ? { roi } : undefined, signal);
      const points = result.lines.filter((l) => l.text.includes(locator.text)).map((l) => screenshotToGlobal(shot, center(l.box)));
      return { ok: true, points };
    }
    if (!vision.findTemplate) return { ok: false, code: 'capability_missing', message: 'local vision cannot match templates' };
    const match = await vision.findTemplate(shot.path, locator.templateId, roi ? { roi } : undefined, signal);
    if (!match) return { ok: true, points: [] };
    const at = screenshotToGlobal(shot, center(match.box));
    return { ok: true, points: [{ x: at.x + (locator.offset?.x ?? 0), y: at.y + (locator.offset?.y ?? 0) }] };
  }

  async check(condition: Condition, observation: Observation, signal?: AbortSignal): Promise<CheckResult> {
    const errors = validateCondition(condition);
    if (errors.length) throw new RuntimeError('invalid_input', `condition: ${errors.join('; ')}`, { errors });
    throwIfAborted(signal);
    const verdict = await this.evaluate(condition, observation, signal);
    return { ok: verdict.ok, snapshotId: needsScreen(condition) ? observation.snapshotId : undefined, evidence: verdict.evidence };
  }

  private async evaluate(c: Condition, o: Observation, signal?: AbortSignal): Promise<{ ok: boolean; evidence: string[] }> {
    const verdict = (ok: boolean, evidence: string) => ({ ok, evidence: [evidence] });
    switch (c.kind) {
      case 'element': {
        let found: boolean;
        if (c.locator.kind === 'element') {
          found = matchElements(o.elements ?? [], c.locator).length > 0;
        } else if (c.locator.kind === 'relative') {
          found = rectContains({ x: 0, y: 0, width: 1, height: 1 }, c.locator.point);
        } else {
          const located = await this.locateVisual(c.locator, o, signal);
          if (!located.ok) throw new RuntimeError(located.code, located.message);
          found = located.points.length > 0;
        }
        return verdict(found === c.present, `${c.locator.kind} element ${found ? 'present' : 'absent'}`);
      }
      case 'text': {
        const text = o.text ?? (o.elements ?? []).flatMap((e) => [e.label, e.value]).filter(Boolean).join('\n');
        const found = new RegExp(c.pattern).test(text);
        // The pattern may carry candidate data; the evidence never repeats it.
        return verdict(found === c.present, `text ${found ? 'found' : 'not found'}`);
      }
      case 'page':
        return verdict(o.pageClass === c.pageClass, `page is ${o.pageClass ?? 'unclassified'}, wanted ${c.pageClass}`);
      case 'window': {
        const matches = (c.bundleId === undefined || o.window.bundleId === c.bundleId) && (c.titlePattern === undefined || new RegExp(c.titlePattern).test(o.window.title));
        return verdict(matches === c.present, `window ${matches ? 'matches' : 'does not match'}`);
      }
      case 'file':
        return this.checkFile(c, signal);
      case 'all':
      case 'any': {
        const evidence: string[] = [];
        for (const child of c.conditions) {
          const r = await this.evaluate(child, o, signal);
          evidence.push(...r.evidence);
          if (c.kind === 'all' && !r.ok) return { ok: false, evidence };
          if (c.kind === 'any' && r.ok) return { ok: true, evidence };
        }
        return { ok: c.kind === 'all', evidence };
      }
    }
  }

  private async checkFile(c: Extract<Condition, { kind: 'file' }>, signal?: AbortSignal): Promise<{ ok: boolean; evidence: string[] }> {
    const read = async () => {
      try {
        return await stat(c.path);
      } catch {
        return undefined;
      }
    };
    const first = await read();
    if (!first?.isFile()) return { ok: false, evidence: ['file missing'] };
    if (c.minBytes !== undefined && first.size < c.minBytes) return { ok: false, evidence: [`file has ${first.size} bytes, wanted ${c.minBytes}`] };
    if (c.stableMs) {
      await delay(Math.min(c.stableMs, WAIT_LIMITS.maxTimeoutMs), signal);
      const second = await read();
      if (!second || second.size !== first.size || second.mtimeMs !== first.mtimeMs) return { ok: false, evidence: ['file still changing'] };
    }
    return { ok: true, evidence: [`file present, ${first.size} bytes`] };
  }

  async waitFor(spec: WaitSpec, signal?: AbortSignal): Promise<CheckResult> {
    const errors = validateWaitSpec(spec);
    if (errors.length) throw new RuntimeError('invalid_input', `wait: ${errors.join('; ')}`, { errors });
    const pollMs = spec.pollMs ?? this.pollMs;
    const screen = needsScreen(spec.condition);
    const options: ObserveOptions = { elements: true, screenshot: needsScreenshot(spec.condition) };
    const start = this.clock.now().getTime();
    const deadline = start + spec.timeoutMs;
    // Each read is cut off at the deadline; a cut-off read is a timeout, not a cancellation.
    const timeout = AbortSignal.timeout(spec.timeoutMs);
    const bounded = AbortSignal.any([...(signal ? [signal] : []), timeout]);
    let last: CheckResult = { ok: false, evidence: ['not checked yet'] };
    try {
      for (;;) {
        this.usable(signal, 'wait');
        const observation = screen ? await this.observe(options, bounded) : this.current ?? this.placeholder();
        last = await this.check(spec.condition, observation, bounded);
        const elapsedMs = this.clock.now().getTime() - start;
        if (last.ok) return { ...last, elapsedMs };
        if (this.clock.now().getTime() + pollMs > deadline) break;
        await delay(pollMs, bounded);
      }
    } catch (error) {
      if (signal?.aborted) throw new RuntimeError('cancelled', 'the wait was cancelled');
      if (!(isRuntimeError(error, 'cancelled') && timeout.aborted)) throw error;
    }
    return { ok: false, snapshotId: last.snapshotId, evidence: [...last.evidence, `timed out after ${spec.timeoutMs} ms`], elapsedMs: spec.timeoutMs };
  }

  /** File-only conditions need no read of the window. */
  private placeholder(): Observation {
    return { snapshotId: '', sessionId: this.id, takenAt: this.clock.now().toISOString(), window: this.currentBinding.window };
  }

  rebind(signal?: AbortSignal): Promise<WindowBinding> {
    return this.exclusive('rebind', signal, async (linked) => {
      const old = this.currentBinding;
      this.current = undefined;
      const screen = await this.deps.adapter.ensureScreen(this.profile, linked);
      this.keeper.check();
      // Never widened beyond the task's own takeOver: the adapter cannot
      // promise to move only a given process, so a window that left the
      // screen without that permission ends in conflict, not a move.
      const next = await this.deps.adapter.bindApp(screen.screenId, this.profile, { takeOver: this.request.takeOver }, linked);
      if (next.window.bundleId !== this.profile.bundleId)
        throw new RuntimeError('conflict', `the bound window belongs to ${next.window.bundleId}, not ${this.profile.bundleId}`);
      throwIfAborted(linked);
      this.keeper.check();
      const launchedByRuntime = next.launchedByRuntime || (old.launchedByRuntime && sameProcess(next.window, old.window));
      this.currentBinding = { ...next, launchedByRuntime };
      return this.currentBinding;
    });
  }

  async withExclusiveActor<T>(holder: ActorGrant['holder'], fn: (grant: ActorGrant) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.usable(signal, 'hand over the window');
    if (this.operation) throw new RuntimeError('actor_busy', `cannot hand over the window while ${this.operation.what} is running`);
    const controller = new AbortController();
    this.current = undefined;
    // The actor stops when the caller cancels, the lease is lost, or the session closes.
    const grant: ActorGrant = { holder, binding: this.currentBinding, signal: AbortSignal.any([controller.signal, this.linked(signal)]) };
    // Settles only when fn does: the actor has stopped by then.
    const done = Promise.resolve().then(() => fn(grant));
    this.grant = { controller, done };
    try {
      return await done;
    } finally {
      this.grant = undefined;
      // The other actor read and changed the window; nothing seen before is current.
      this.current = undefined;
    }
  }

  async close(policy: { keepWindow: boolean }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Stop whatever is running and wait until it has really stopped.
    this.closing.abort(new RuntimeError('cancelled', 'the session is closing'));
    await Promise.allSettled([this.operation?.done, this.grant?.done]);
    await this.keeper.stop();
    this.current = undefined;
    let failure: unknown;
    // Only a window this session launched is handed back. One it attached
    // to, or took over, stays where it is; a fenced session owns nothing.
    if (!policy.keepWindow && this.currentBinding.launchedByRuntime && !this.keeper.fenced) {
      try {
        await this.deps.adapter.releaseWindow(this.currentBinding);
      } catch (error) {
        failure = error;
      }
    }
    // Releasing by id only ever drops this session's own lease row.
    try {
      await this.deps.leases.releaseLease(this.keeper.lease.leaseId);
    } catch (error) {
      if (!this.keeper.fenced) failure ??= error;
    }
    if (failure) throw failure;
  }
}
