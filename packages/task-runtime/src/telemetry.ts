// What a task spent: model calls by purpose, tokens, screenshots, OCR runs,
// units replayed or explored, local recoveries and time. Token counts the
// model service did not report stay 'unknown' and make every total they
// enter unknown; they are never written down as 0. Usage is persisted by the
// runner as `usage` events, so a resumed task keeps counting from where the
// last run stopped.

import {
  RuntimeError,
  addTokens,
  emptyUsage,
  systemClock,
  type Clock,
  type TelemetryEvent,
  type TelemetryRecorder,
  type TokenCount,
  type Usage,
} from './contracts.ts';

/** A recorder that counts events from the moment it is created. */
export function createTelemetry(clock: Clock = systemClock): TelemetryRecorder {
  const startedMs = clock.now().getTime();
  const counted: Usage = emptyUsage();
  return {
    record(event: TelemetryEvent): void {
      applyEvent(counted, event);
    },
    usage(): Usage {
      return { ...counted, elapsedMs: Math.max(0, clock.now().getTime() - startedMs) };
    },
  };
}

function applyEvent(usage: Usage, event: TelemetryEvent): void {
  switch (event.type) {
    case 'model_call':
      if (event.purpose === 'ui') usage.uiModelCalls += 1;
      else if (event.purpose === 'repair') usage.repairModelCalls += 1;
      else usage.analysisModelCalls += 1;
      usage.inputTokens = addTokens(usage.inputTokens, event.inputTokens);
      usage.outputTokens = addTokens(usage.outputTokens, event.outputTokens);
      break;
    case 'screenshot':
      usage.screenshots += 1;
      break;
    case 'ocr':
      usage.ocrCalls += 1;
      break;
    case 'unit':
      if (!event.ok) break;
      if (event.route === 'replay') usage.replayedUnits += 1;
      else if (event.route === 'explore' || event.route === 'repair') usage.exploredUnits += 1;
      break;
    case 'local_recovery':
      usage.localRecoveries += 1;
      break;
  }
}

const COUNT_FIELDS = [
  'uiModelCalls',
  'repairModelCalls',
  'analysisModelCalls',
  'screenshots',
  'ocrCalls',
  'replayedUnits',
  'exploredUnits',
  'localRecoveries',
  'elapsedMs',
] as const;

/** Sum of two usages; an unknown token count on either side stays unknown. */
export function addUsage(a: Usage, b: Usage): Usage {
  const sum = { ...a };
  for (const k of COUNT_FIELDS) sum[k] = a[k] + b[k];
  sum.inputTokens = addTokens(a.inputTokens, b.inputTokens);
  sum.outputTokens = addTokens(a.outputTokens, b.outputTokens);
  return sum;
}

/**
 * What a recorder counted between two of its readings. Tokens that became
 * unknown in between, or were already unknown, give an unknown difference:
 * how much was spent cannot be shown.
 */
export function usageSince(after: Usage, before: Usage): Usage {
  const delta = { ...after };
  for (const k of COUNT_FIELDS) delta[k] = Math.max(0, after[k] - before[k]);
  const tokens = (x: TokenCount, y: TokenCount): TokenCount => {
    if (x !== 'unknown' && y !== 'unknown') return Math.max(0, x - y);
    // Unknown before and after with no call in between: nothing was spent.
    if (x === 'unknown' && y === 'unknown' && sameCalls(after, before)) return 0;
    return 'unknown';
  };
  delta.inputTokens = tokens(after.inputTokens, before.inputTokens);
  delta.outputTokens = tokens(after.outputTokens, before.outputTokens);
  return delta;
}

/** No model call happened between two readings, so no token can have been spent. */
const sameCalls = (a: Usage, b: Usage): boolean =>
  a.uiModelCalls === b.uiModelCalls && a.repairModelCalls === b.repairModelCalls && a.analysisModelCalls === b.analysisModelCalls;

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isTokens = (v: unknown): v is TokenCount => v === 'unknown' || isCount(v);

/**
 * Reads a usage persisted as JSON. Throws `invalid_input` rather than
 * guessing: a missing token count is not 0.
 */
export function parseUsage(raw: unknown): Usage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RuntimeError('invalid_input', 'usage must be an object');
  const r = raw as Record<string, unknown>;
  const usage = emptyUsage();
  const errors: string[] = [];
  for (const k of COUNT_FIELDS) {
    if (isCount(r[k])) usage[k] = r[k];
    else errors.push(`${k} must be a non-negative integer`);
  }
  for (const k of ['inputTokens', 'outputTokens'] as const) {
    if (isTokens(r[k])) usage[k] = r[k];
    else errors.push(`${k} must be a non-negative integer or "unknown"`);
  }
  if (errors.length) throw new RuntimeError('invalid_input', `usage: ${errors.join('; ')}`, { errors });
  return usage;
}

/**
 * Recorders per task plus one shared recorder for modules built once per
 * process (recovery, the workflow, the procedure engine): the shared one
 * forwards each event to the task whose recorder was asked for last. The
 * daemon runs one task per app at a time, so that is the task running now.
 * Pass `forTask` as the runner's `telemetry` and `shared` to the others.
 * Give the engine no recorder when the runner counts replays itself, or
 * replays are counted twice.
 */
export function createTelemetryHub(clock: Clock = systemClock): {
  forTask(taskId: string): TelemetryRecorder;
  shared: TelemetryRecorder;
  activeTaskId(): string | undefined;
} {
  const recorders = new Map<string, TelemetryRecorder>();
  let active: string | undefined;
  const current = (): TelemetryRecorder | undefined => (active === undefined ? undefined : recorders.get(active));
  return {
    forTask(taskId: string): TelemetryRecorder {
      let recorder = recorders.get(taskId);
      if (!recorder) {
        recorder = createTelemetry(clock);
        recorders.set(taskId, recorder);
      }
      active = taskId;
      return recorder;
    },
    shared: {
      record(event: TelemetryEvent): void {
        current()?.record(event);
      },
      usage(): Usage {
        return current()?.usage() ?? emptyUsage();
      },
    },
    activeTaskId: () => active,
  };
}
