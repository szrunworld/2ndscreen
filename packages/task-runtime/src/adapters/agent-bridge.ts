// The exploration bridge, runtime side: starts `<cli> agent-bridge` while the
// session's actor grant is held, hands it one ExplorationRequest, and reads
// back the JSON lines of docs/task-runtime-contracts.md ("Bridge JSONL
// protocol"). The Swift agent has already sent every action it reports, so
// the outcome lists them as executed by the bridge, never to be sent again,
// including a step that started and never reported its end.
//
// Every line is untrusted: anything malformed, out of order or belonging to
// another attempt fails the exploration and stops the child. Whatever the
// ending (finished, failed, aborted, timed out, a broken child), `explore`
// resolves only after the child has exited, so the session gets the window
// back from a process that can no longer act on it.

import { spawn as spawnChild } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  RuntimeError,
  addTokens,
  assertValid,
  encodeJsonLine,
  parseBridgeEvent,
  systemClock,
  validateExplorationRequest,
  type ActionResult,
  type ActorGrant,
  type BridgeEvent,
  type Clock,
  type ExecutedStep,
  type ExplorationOutcome,
  type ExplorationRequest,
  type ExplorerBridge,
  type LineProcess,
  type LineProcessSpawner,
  type Observation,
} from '../contracts.ts';

const DEFAULT_KILL_GRACE_MS = 3000;
/** A line longer than this is cut and fails to parse, so a runaway child cannot fill memory. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Stand in for an oversized or cut-off line; never valid JSON. */
const OVERSIZED_LINE = '\u0000oversized bridge line';
const TRUNCATED_LINE = '\u0000bridge line without its newline';
/** How long lines may keep arriving after the child exited. */
const DRAIN_MS = 1000;
/** How long the spawner waits for stdout to close, then for the process group to die. */
const STDOUT_CLOSE_MS = 500;
/** The longest pause between kills while confirming a process group is gone. */
const GROUP_POLL_MAX_MS = 1000;

type FailureReason = NonNullable<ExplorationOutcome['failure']>;

export function createAgentBridge(options: {
  cli: string;
  spawn: LineProcessSpawner;
  env?: Record<string, string>;
  killGraceMs?: number;
  clock?: Clock;
}): ExplorerBridge {
  const clock = options.clock ?? systemClock;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  async function explore(request: ExplorationRequest, grant: ActorGrant, onEvent?: (event: BridgeEvent) => void): Promise<ExplorationOutcome> {
    assertValid(validateExplorationRequest(request), 'exploration request');
    checkGrant(request, grant);
    const run = new Run(request, clock);
    // Nothing started yet: no child to stop, nothing executed.
    if (grant.signal.aborted) return run.outcome('cancelled');

    const child = options.spawn(options.cli, ['agent-bridge'], { ...options.env, SECONDSCREEN_SOCKET: request.session.socket });
    // Set the moment the exit is confirmed: from then on nothing signals the
    // pid, which may belong to someone else. Lines already written are still
    // taken until `accepting` ends after a bounded drain.
    let processGone = false;
    let accepting = true;
    let stopping: FailureReason | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: FailureReason): void => {
      if (stopping) return;
      stopping = reason;
      run.stoppedBy(reason);
      if (processGone) return;
      signal(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!processGone) signal(child, 'SIGKILL');
      }, killGraceMs);
    };
    const onAbort = (): void => stop('cancelled');
    grant.signal.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => stop('timeout'), request.budget.timeoutMs);

    try {
      // An abort that fired while spawning never reached the listener: the
      // child gets no request, so it has nothing to act on, and is stopped.
      const abortedDuringSpawn = grant.signal.aborted;
      try {
        if (!abortedDuringSpawn) child.write(encodeJsonLine(request));
        child.closeInput();
      } catch {
        // The child died at once; its exit and its missing events tell the rest.
      }
      if (abortedDuringSpawn) onAbort();

      const reading = (async () => {
        try {
          for await (const line of child.lines()) {
            // Keep reading after a failure, so the child never blocks on a full pipe.
            if (!accepting || run.broken) continue;
            const event = run.take(line);
            if (!event) {
              stop('error');
              continue;
            }
            if (run.forbidden) stop('forbidden_effect');
            if (onEvent) {
              try {
                onEvent(event);
              } catch {
                // An observer's failure must not cost the session its confirmed exit.
              }
            }
          }
        } catch {
          run.fail('error');
          stop('error');
        }
      })();

      // The exit, not the end of stdout, releases the window: a descendant
      // holding stdout open must not keep the session waiting forever.
      const exit = await child.exited();
      processGone = true;
      clearTimeout(killTimer);
      clearTimeout(deadline);
      // Lines already written still count; give them a bounded moment to arrive.
      await Promise.race([reading, new Promise<void>((resolve) => (drainTimer = setTimeout(resolve, DRAIN_MS)))]);
      accepting = false;
      run.exited(exit.code);
      return run.outcome();
    } finally {
      // Also when exited() or the reader threw: no timer or listener outlives the call.
      accepting = false;
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      clearTimeout(deadline);
      grant.signal.removeEventListener('abort', onAbort);
    }
  }

  return { explore };
}

/** The grant must be the bridge's, for the very window the request names. */
function checkGrant(request: ExplorationRequest, grant: ActorGrant): void {
  const { binding } = grant;
  const s = request.session;
  if (grant.holder !== 'bridge')
    throw new RuntimeError('invalid_input', `the actor grant is held by ${grant.holder}, not the bridge`);
  if (binding.socket !== s.socket || binding.screenId !== s.screenId || binding.window.pid !== s.pid || binding.window.windowId !== s.windowId)
    throw new RuntimeError('invalid_input', 'the request names another window than the actor grant', {
      request: s,
      grant: { socket: binding.socket, screenId: binding.screenId, pid: binding.window.pid, windowId: binding.window.windowId },
    });
}

function signal(child: LineProcess, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    child.kill(name);
  } catch {
    // Already gone.
  }
}

/** What one exploration has reported so far, and the rules its lines must keep. */
class Run {
  private readonly started = new Map<string, { action: ExecutedStep['action']; at: string; before?: Snapshot }>();
  private readonly steps: ExecutedStep[] = [];
  private readonly seen = new Set<string>();
  /** Steps that finished since the last observation, which it describes the outcome of. */
  private awaitingAfter: ExecutedStep[] = [];
  private lastObserved?: Snapshot;
  private modelCalls = 0;
  private inputTokens: ExplorationOutcome['inputTokens'] = 0;
  private outputTokens: ExplorationOutcome['outputTokens'] = 0;
  private terminal?: Extract<BridgeEvent, { type: 'unit_finished' | 'unit_failed' }>;
  private failure?: FailureReason;
  private exitCode: number | null = null;
  forbidden = false;
  broken = false;

  private readonly request: ExplorationRequest;
  private readonly clock: Clock;

  constructor(request: ExplorationRequest, clock: Clock) {
    this.request = request;
    this.clock = clock;
  }

  /** Accept one line; undefined when it breaks the protocol. */
  take(line: string): BridgeEvent | undefined {
    const parsed = parseBridgeEvent(line, { taskId: this.request.taskId, unitAttemptId: this.request.unitAttemptId });
    if (!parsed.ok) {
      // An action line that is malformed may still describe a sent action; its step stays unknown.
      return this.fail('error');
    }
    const event = parsed.value;
    if (this.terminal) return this.fail('error');
    switch (event.type) {
      case 'observed': {
        // Only the bound window may be described; anything else is not this session's.
        if (event.window.pid !== undefined && event.window.pid !== this.request.session.pid) return this.fail('error');
        if (event.window.windowId !== undefined && event.window.windowId !== this.request.session.windowId) return this.fail('error');
        this.lastObserved = { snapshotId: event.snapshotId, ...(event.pageClass !== undefined && { pageClass: event.pageClass }) };
        for (const step of this.awaitingAfter) step.after = this.lastObserved;
        this.awaitingAfter = [];
        break;
      }
      case 'action_started': {
        if (this.started.has(event.stepId) || this.seen.has(event.stepId)) return this.fail('error');
        this.started.set(event.stepId, { action: event.action, at: event.at, ...(this.lastObserved && { before: this.lastObserved }) });
        if (!this.allowed(event.action.effect)) this.forbid();
        break;
      }
      case 'action_finished': {
        const start = this.started.get(event.stepId);
        if (!start) return this.fail('error');
        // The end must describe the same action it began with; otherwise the
        // started action stays as sent with an unknown result.
        if (!isDeepStrictEqual(start.action, event.action) || event.result.actionId !== event.stepId) return this.fail('error');
        this.started.delete(event.stepId);
        this.seen.add(event.stepId);
        const step: ExecutedStep = {
          stepId: event.stepId,
          action: event.action,
          result: event.result,
          ...(start.before && { before: start.before }),
          ...(event.resolvedElement && { resolvedElement: event.resolvedElement }),
          executedBy: 'bridge',
        };
        this.steps.push(step);
        this.awaitingAfter.push(step);
        if (!this.allowed(event.action.effect)) this.forbid();
        break;
      }
      case 'model_usage':
        this.modelCalls += 1;
        this.inputTokens = addTokens(this.inputTokens, event.inputTokens);
        this.outputTokens = addTokens(this.outputTokens, event.outputTokens);
        break;
      case 'unit_finished':
        // The count must match what was reported, or the trace is not the whole story.
        if (event.steps !== this.seen.size || this.started.size > 0) {
          this.terminal = event;
          return this.fail('error');
        }
        this.terminal = event;
        break;
      case 'unit_failed':
        this.terminal = event;
        break;
    }
    return event;
  }

  private allowed(effect: string): boolean {
    return (this.request.unit.allowedEffects as string[]).includes(effect);
  }

  private forbid(): void {
    this.forbidden = true;
    this.failure ??= 'forbidden_effect';
  }

  fail(reason: FailureReason): undefined {
    this.broken = true;
    this.failure ??= reason;
    return undefined;
  }

  /** The runtime stopped the child: abort, deadline, or a protocol failure. */
  stoppedBy(reason: FailureReason): void {
    // A stop after the child already ended on its own changes nothing.
    if (!this.terminal) this.failure ??= reason;
  }

  exited(code: number | null): void {
    this.exitCode = code;
  }

  outcome(cancelled?: 'cancelled'): ExplorationOutcome {
    // Started and never reported done: it may have reached the app, so it counts as sent.
    const now = this.clock.now().toISOString();
    const unfinished: ExecutedStep[] = [...this.started].map(([stepId, start]) => ({
      stepId,
      action: start.action,
      result: { actionId: stepId, status: 'unknown', startedAt: start.at, finishedAt: now } satisfies ActionResult,
      ...(start.before && { before: start.before }),
      executedBy: 'bridge',
    }));
    const executed = [...this.steps, ...unfinished];
    const failure = cancelled ?? this.reason();
    const base = {
      executed,
      modelCalls: this.modelCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.lastObserved && { lastSnapshotId: this.lastObserved.snapshotId }),
    };
    if (failure) return { status: 'failed', failure, ...base };
    const finished = this.terminal as Extract<BridgeEvent, { type: 'unit_finished' }>;
    return { status: 'finished', ...base, ...(finished.proposal && { proposal: finished.proposal }) };
  }

  /** Why the exploration failed, or undefined when it finished cleanly. */
  private reason(): FailureReason | undefined {
    if (this.failure) return this.failure;
    if (!this.terminal) return 'error';
    if (this.terminal.type === 'unit_failed') return this.terminal.reason;
    // unit_finished must come with exit code 0, and nothing may be left half done.
    if (this.exitCode !== 0 || this.started.size > 0) return 'error';
    return undefined;
  }
}

type Snapshot = Pick<Observation, 'snapshotId' | 'pageClass'>;

/**
 * Children through node:child_process, each leading its own process group,
 * so a signal reaches anything it started. stderr is drained and dropped.
 * `exited()` resolves only once the child has exited and its whole group is
 * confirmed gone: descendants left holding stdout are killed, and stdout is
 * closed. Once the child has exited, `kill` sends nothing: the cleanup owns
 * the group, and a pid that is gone may be reused.
 */
export function createLineProcessSpawner(): LineProcessSpawner {
  return (file, args, env) => {
    const child = spawnChild(file, [...args], {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const pid = child.pid;
    /** The child has exited (or never started); only the cleanup may signal its group now. */
    let leaderExited = pid === undefined;
    const group = (name: NodeJS.Signals | 0): boolean => {
      if (pid === undefined) return false;
      try {
        process.kill(-pid, name);
        return true;
      } catch {
        return false;
      }
    };
    const stdoutClosed = new Promise<void>((resolve) => child.stdout.once('close', () => resolve()));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => {
        leaderExited = true;
        void (async () => {
          await Promise.race([stdoutClosed, sleep(STDOUT_CLOSE_MS)]);
          // Whatever of the group is left must not keep acting or holding the pipe.
          await confirmGroupGone(() => group(0), () => void group('SIGKILL'));
          child.stdout.destroy();
          child.stderr.destroy();
          resolve({ code, signal });
        })();
      });
      // Never started (missing file, no permission): there is nothing to wait for.
      child.on('error', () => {
        if (child.pid === undefined) {
          leaderExited = true;
          child.stdout.destroy();
          resolve({ code: null, signal: null });
        }
      });
    });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    return {
      pid,
      write: (line) => void child.stdin.write(line),
      closeInput: () => void child.stdin.end(),
      lines: () => readLines(child.stdout),
      exited: () => exited,
      kill: (name = 'SIGTERM') => {
        if (leaderExited) return;
        if (!group(name)) child.kill(name);
      },
    };
  };
}

/**
 * Kill until `alive` says the group is gone, backing off to a pause of
 * `GROUP_POLL_MAX_MS`. It never gives up: a group that cannot be shown dead
 * must not have its window handed to another actor. Resolves with the
 * number of kills it took.
 */
export async function confirmGroupGone(alive: () => boolean, kill: () => void, wait: (ms: number) => Promise<void> = sleep): Promise<number> {
  let kills = 0;
  let pause = 20;
  while (alive()) {
    kill();
    kills += 1;
    await wait(pause);
    pause = Math.min(pause * 2, GROUP_POLL_MAX_MS);
  }
  return kills;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function* readLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  let oversized = false;
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        // A line over the cap is replaced whole, never cut into something that might parse.
        yield oversized || newline > MAX_LINE_BYTES ? OVERSIZED_LINE : pending.subarray(0, newline).toString('utf8');
        oversized = false;
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > MAX_LINE_BYTES) {
        oversized = true;
        pending = Buffer.alloc(0);
      }
    }
  } catch {
    // stdout destroyed after the exit: whatever arrived has been read.
  }
  // Every event ends with a newline; trailing bytes without one were cut off.
  if (oversized || pending.length > 0) yield TRUNCATED_LINE;
}
