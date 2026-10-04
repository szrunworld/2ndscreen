// The few ways this workflow touches the window, all through the Session:
// read, click a named control, scroll, press a key, and poll with a bound.
// Every action is recorded as an ExecutedStep so a scripted run can be
// learned from, and every click passes the label check first.

import { randomUUID } from 'node:crypto';
import {
  RuntimeError,
  globalToRelative,
  throwIfAborted,
  type Action,
  type ActionResult,
  type Clock,
  type ExecutedStep,
  type LocalVision,
  type Observation,
  type ObserveOptions,
  type Point,
  type Rect,
  type Session,
  type TelemetryRecorder,
  type UIElement,
} from '../../../../packages/task-runtime/src/contracts.ts';
import { assertSafeLabel, classifyPage, text } from './pages.ts';

export interface Env {
  clock: Clock;
  telemetry?: TelemetryRecorder;
  vision?: LocalVision;
  /** Poll interval for page changes. */
  pollMs: number;
}

/** A fresh read with the page class filled in. */
export async function look(session: Session, env: Env, signal: AbortSignal, options: ObserveOptions = {}): Promise<Observation> {
  throwIfAborted(signal);
  const observation = await session.observe({ elements: true, ...options }, signal);
  if (observation.screenshot) env.telemetry?.record({ type: 'screenshot' });
  return { ...observation, pageClass: classifyPage(observation) };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve(throwIfAborted(signal));
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      done();
      reject(new RuntimeError('cancelled', 'the operation was cancelled'));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Read until `test` returns a value or the bound passes. Bounded by both the
 * clock and a number of reads, so a stopped test clock cannot spin forever.
 */
export async function pollFor<T>(
  session: Session,
  env: Env,
  signal: AbortSignal,
  timeoutMs: number,
  test: (observation: Observation) => T | undefined,
  options: ObserveOptions = {},
): Promise<{ value?: T; observation: Observation }> {
  const start = env.clock.now().getTime();
  const reads = Math.max(1, Math.ceil(timeoutMs / Math.max(1, env.pollMs)) + 1);
  let observation = await look(session, env, signal, options);
  for (let i = 1; ; i++) {
    const value = test(observation);
    if (value !== undefined) return { value, observation };
    if (i >= reads || env.clock.now().getTime() - start >= timeoutMs) return { observation };
    await sleep(env.pollMs, signal);
    observation = await look(session, env, signal, options);
  }
}

/** Steps a scripted unit performed, in order, for the learner and the audit. */
export class Trace {
  readonly steps: ExecutedStep[] = [];

  record(action: Action, result: ActionResult, before?: Observation, element?: UIElement): void {
    this.steps.push({
      stepId: result.actionId,
      action,
      result,
      before: before ? { snapshotId: before.snapshotId, pageClass: before.pageClass } : undefined,
      resolvedElement: element ? { role: element.role, label: text(element) || undefined, frame: element.frame } : undefined,
      executedBy: 'runtime',
    });
  }
}

export const delivered = (r: ActionResult): boolean => r.status === 'ok';

/**
 * Click one element of `observation` by its index. `row` clicks a candidate
 * row, whose label is a person's name and so is not label-checked; any other
 * click must pass the forbidden-label check.
 */
export async function clickElement(
  session: Session,
  observation: Observation,
  element: UIElement,
  trace: Trace,
  signal: AbortSignal,
  kind: 'row' | 'control' = 'control',
): Promise<ActionResult> {
  if (kind === 'control') assertSafeLabel(text(element));
  throwIfAborted(signal);
  const action: Action = { kind: 'click', target: { kind: 'element', index: element.index }, effect: 'navigation' };
  const result = await session.act({ actionId: randomUUID(), action, snapshotId: observation.snapshotId }, signal);
  trace.record(action, result, observation, element);
  return result;
}

/** Click a point given in global points, as a fraction of the window now. */
export async function clickPoint(session: Session, observation: Observation, point: Point, trace: Trace, signal: AbortSignal): Promise<ActionResult> {
  throwIfAborted(signal);
  const action: Action = { kind: 'click', target: { kind: 'relative', point: globalToRelative(observation.window, point) }, effect: 'navigation' };
  const result = await session.act({ actionId: randomUUID(), action }, signal);
  trace.record(action, result, observation);
  return result;
}

export const centerOf = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Scroll with the pointer over `over` (global rect), by lines. Scrolling only reads. */
export async function scrollOver(
  session: Session,
  observation: Observation,
  over: Rect,
  direction: 'up' | 'down',
  amount: number,
  trace: Trace,
  signal: AbortSignal,
): Promise<ActionResult> {
  throwIfAborted(signal);
  const lines = Math.min(50, Math.max(1, Math.round(amount)));
  const action: Action = {
    kind: 'scroll',
    target: { kind: 'relative', point: globalToRelative(observation.window, centerOf(over)) },
    direction,
    amount: lines,
    by: 'line',
    effect: 'read',
  };
  const result = await session.act({ actionId: randomUUID(), action }, signal);
  trace.record(action, result, observation);
  return result;
}

export async function pressKey(session: Session, observation: Observation, key: string, trace: Trace, signal: AbortSignal): Promise<ActionResult> {
  throwIfAborted(signal);
  const action: Action = { kind: 'key', key, effect: 'navigation' };
  const result = await session.act({ actionId: randomUUID(), action }, signal);
  trace.record(action, result, observation);
  return result;
}

