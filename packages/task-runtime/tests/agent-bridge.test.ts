import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentBridge, createLineProcessSpawner } from '../src/adapters/agent-bridge.ts';
import {
  isRuntimeError,
  validateExplorationRequest,
  type ActorGrant,
  type BridgeEvent,
  type ExplorationRequest,
  type LineProcess,
  type LineProcessSpawner,
  type WindowGeometry,
} from '../src/contracts.ts';

// A synthetic child speaking the bridge protocol, and a few real node
// children for the process plumbing: no 2ndscreen, no app, no model.

const FRAME = { x: 3000, y: 25, width: 1360, height: 848 };
const WINDOW: WindowGeometry = { pid: 4242, windowId: 77, bundleId: 'com.example.synthetic', title: 'Synthetic', frame: FRAME, contentFrame: FRAME, scale: 2, displayId: 7 };
const SOCKET = '/tmp/synthetic-2ndscreen.sock';

function request(overrides: Partial<ExplorationRequest> = {}): ExplorationRequest {
  return {
    v: 1,
    taskId: 't1',
    unitAttemptId: 'u1',
    session: { socket: SOCKET, screenId: 'boss', pid: 4242, windowId: 77 },
    unit: { name: 'open_resume', goal: '打开 {{candidate.name}} 的在线简历', allowedEffects: ['read', 'navigation'], expectedPostconditions: [{ kind: 'page', pageClass: 'online_resume' }] },
    parameters: { 'candidate.name': '张三' },
    budget: { maxRounds: 6, timeoutMs: 5000 },
    submitAllowed: false,
    ...overrides,
  };
}

function grant(signal = new AbortController().signal, overrides: Partial<ActorGrant> = {}): ActorGrant {
  return { holder: 'bridge', binding: { screenId: 'boss', socket: SOCKET, window: WINDOW, launchedByRuntime: false }, signal, ...overrides };
}

let clock = 0;
function line(type: BridgeEvent['type'], fields: Record<string, unknown> = {}, ids = { taskId: 't1', unitAttemptId: 'u1' }): string {
  clock += 1;
  return JSON.stringify({ v: 1, ...ids, at: new Date(Date.UTC(2026, 9, 4, 8, 0, clock)).toISOString(), type, ...fields });
}
const click = { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '在线简历' }, effect: 'navigation' };
const observed = (id: string) => line('observed', { snapshotId: id, window: WINDOW, pageClass: 'conversation' });
const started = (stepId: string, action: unknown = click) => line('action_started', { stepId, action });
const finished = (stepId: string, action: unknown = click, status = 'ok') =>
  line('action_finished', {
    stepId,
    action,
    result: { actionId: stepId, status, route: 'element', startedAt: '2026-10-04T08:00:01.000Z', finishedAt: '2026-10-04T08:00:02.000Z' },
    resolvedElement: { role: 'AXButton', label: '在线简历', frame: { x: 3100, y: 100, width: 80, height: 30 } },
  });
const usage = (input: number | 'unknown' = 1200, output: number | 'unknown' = 'unknown') =>
  line('model_usage', { purpose: 'ui', reason: 'missing_procedure', inputTokens: input, outputTokens: output });
const unitFinished = (steps: number, proposal?: unknown) => line('unit_finished', { steps, ...(proposal !== undefined && { proposal }) });
const unitFailed = (reason: string) => line('unit_failed', { reason, message: reason });

/**
 * A child under the test's control. `script` runs once the request is in;
 * `onSignal` decides what a signal does (by default: SIGTERM is honoured with
 * a cancelled line and exit 1, SIGKILL ends it).
 */
class FakeChild implements LineProcess {
  readonly pid = 99_999;
  readonly written: string[] = [];
  readonly signals: string[] = [];
  inputClosed = false;
  hasExited = false;
  private readonly queue: string[] = [];
  private wake?: () => void;
  private closed = false;
  private resolveExit!: (exit: { code: number | null; signal: string | null }) => void;
  private readonly exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => (this.resolveExit = resolve));
  onSignal: (child: FakeChild, signal: 'SIGTERM' | 'SIGKILL') => void = (child, signal) => {
    if (signal === 'SIGTERM') {
      child.emit(unitFailed('cancelled'));
      child.exit(1);
    } else child.exit(null, 'SIGKILL');
  };

  private readonly script: (child: FakeChild) => void | Promise<void>;

  constructor(script: (child: FakeChild) => void | Promise<void>) {
    this.script = script;
  }

  write(text: string): void {
    this.written.push(text);
  }
  closeInput(): void {
    this.inputClosed = true;
    void Promise.resolve().then(() => this.script(this));
  }
  emit(...lines: string[]): void {
    if (this.closed) return;
    this.queue.push(...lines);
    this.wake?.();
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.hasExited) return;
    this.closed = true;
    this.wake?.();
    this.hasExited = true;
    this.resolveExit({ code, signal });
  }
  async *lines(): AsyncGenerator<string> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
  exited() {
    return this.exitPromise;
  }
  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.signals.push(signal);
    if (!this.hasExited) this.onSignal(this, signal);
  }
}

function fakeSpawner(child: FakeChild) {
  const calls: Array<{ file: string; args: readonly string[]; env?: Record<string, string> }> = [];
  const spawn: LineProcessSpawner = (file, args, env) => {
    calls.push({ file, args, ...(env && { env }) });
    return child;
  };
  return { spawn, calls };
}

const bridgeWith = (child: FakeChild, killGraceMs = 30) => {
  const { spawn, calls } = fakeSpawner(child);
  return { bridge: createAgentBridge({ cli: '/opt/2ndscreen', spawn, env: { AGENT_MODEL: 'synthetic' }, killGraceMs }), calls };
};

test('a finished unit returns every reported action as executed by the bridge', async () => {
  const proposal = { parameters: [], steps: [{ id: 'st1', action: click }], preconditions: [], postconditions: [{ kind: 'page', pageClass: 'online_resume' }] };
  const child = new FakeChild((c) => {
    c.emit(observed('s1'), usage(), started('st1'), finished('st1'), observed('s2'), usage(800, 30), unitFinished(1, proposal));
    c.exit(0);
  });
  const { bridge, calls } = bridgeWith(child);
  const seen: string[] = [];
  const outcome = await bridge.explore(request(), grant(), (event) => seen.push(event.type));

  assert.equal(child.hasExited, true);
  assert.deepEqual(calls[0]?.args, ['agent-bridge']);
  assert.equal(calls[0]?.file, '/opt/2ndscreen');
  assert.equal(calls[0]?.env?.SECONDSCREEN_SOCKET, SOCKET);
  assert.equal(calls[0]?.env?.AGENT_MODEL, 'synthetic');
  assert.deepEqual(JSON.parse(child.written.join('')), request());
  assert.equal(child.written.join('').split('\n').length, 2, 'exactly one request line');
  assert.equal(child.inputClosed, true);
  assert.deepEqual(child.signals, [], 'a clean finish needs no signal');

  assert.equal(outcome.status, 'finished');
  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.executed.length, 1);
  const step = outcome.executed[0]!;
  assert.equal(step.executedBy, 'bridge');
  assert.equal(step.result.status, 'ok');
  assert.deepEqual(step.before, { snapshotId: 's1', pageClass: 'conversation' });
  assert.deepEqual(step.after, { snapshotId: 's2', pageClass: 'conversation' });
  assert.equal(step.resolvedElement?.label, '在线简历');
  assert.equal(outcome.modelCalls, 2);
  assert.equal(outcome.inputTokens, 2000);
  assert.equal(outcome.outputTokens, 'unknown', 'one unknown makes the sum unknown');
  assert.deepEqual(outcome.proposal, proposal);
  assert.equal(outcome.lastSnapshotId, 's2');
  assert.deepEqual(seen, ['observed', 'model_usage', 'action_started', 'action_finished', 'observed', 'model_usage', 'unit_finished']);
});

test('known token counts add up', async () => {
  const child = new FakeChild((c) => {
    c.emit(usage(100, 10), usage(200, 20), unitFinished(0));
    c.exit(0);
  });
  const outcome = await bridgeWith(child).bridge.explore(request(), grant());
  assert.equal(outcome.status, 'finished');
  assert.equal(outcome.inputTokens, 300);
  assert.equal(outcome.outputTokens, 30);
});

test('a malformed line fails the exploration, stops the child and keeps what it already did', async () => {
  const child = new FakeChild((c) => c.emit(started('st1'), finished('st1'), '{"v":1,"type":"observed"'));
  const outcome = await bridgeWith(child).bridge.explore(request(), grant());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'error');
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.hasExited, true);
  assert.equal(outcome.executed.length, 1, 'the sent click is reported, never to be resent');
});

test('lines for another attempt, out of order, or after the last line are refused', async () => {
  for (const bad of [
    [line('observed', { snapshotId: 's1', window: WINDOW }, { taskId: 't1', unitAttemptId: 'other' })],
    [finished('st1')],
    [started('st1'), started('st1')],
    [unitFinished(0), usage()],
    [started('st1'), finished('st1'), unitFinished(2)],
    ['not json'],
    [line('unit_failed', { reason: 'sorry', message: 'x' })],
  ]) {
    const child = new FakeChild((c) => c.emit(...bad));
    const outcome = await bridgeWith(child).bridge.explore(request(), grant());
    assert.equal(outcome.status, 'failed', bad.join(' | '));
    assert.equal(outcome.failure, 'error', bad.join(' | '));
    assert.equal(child.hasExited, true);
  }
});

test('an end that describes another action keeps the started one as sent, unknown, and fails', async () => {
  const other = { kind: 'click', target: { kind: 'relative', point: { x: 0.1, y: 0.1 } }, effect: 'navigation' };
  for (const end of [finished('st1', other), finished('st1').replace('"actionId":"st1"', '"actionId":"st9"')]) {
    const child = new FakeChild((c) => c.emit(started('st1'), end, unitFinished(1)));
    const outcome = await bridgeWith(child).bridge.explore(request(), grant());
    assert.equal(outcome.failure, 'error');
    assert.deepEqual(outcome.executed.map((s) => [s.stepId, s.result.status]), [['st1', 'unknown']]);
    assert.deepEqual(outcome.executed[0]?.action, click, 'the action as it started, not the untrusted end');
  }
});

test('a last line cut off before its newline is not trusted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-'));
  try {
    const cli = await script(dir, 'cut.mjs', `${PRELUDE}\nprocess.stdin.on('end', () => process.stdout.write(JSON.stringify({ v: 1, taskId: 't1', unitAttemptId: 'u1', at: new Date().toISOString(), type: 'unit_finished', steps: 0 }), () => process.exit(0)));`);
    const outcome = await createAgentBridge({ cli, spawn: createLineProcessSpawner() }).explore(request(), grant());
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.failure, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an observation of another window is refused', async () => {
  const child = new FakeChild((c) => c.emit(line('observed', { snapshotId: 's1', window: { ...WINDOW, windowId: 78 } })));
  const outcome = await bridgeWith(child).bridge.explore(request(), grant());
  assert.equal(outcome.failure, 'error');
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a step that started and never finished counts as executed with an unknown result', async () => {
  const child = new FakeChild((c) => {
    c.emit(observed('s1'), started('st1'), started('st2', { kind: 'type', value: '张三', effect: 'navigation' }), finished('st1'));
    c.exit(null, 'SIGKILL');
  });
  const outcome = await bridgeWith(child).bridge.explore(request(), grant());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'error', 'no last line');
  assert.deepEqual(outcome.executed.map((s) => [s.stepId, s.result.status, s.executedBy]), [
    ['st1', 'ok', 'bridge'],
    ['st2', 'unknown', 'bridge'],
  ]);
  assert.deepEqual(outcome.executed[1]?.before, { snapshotId: 's1', pageClass: 'conversation' });
});

test('an action outside the unit effects fails the unit but stays executed', async () => {
  const artifact = { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.5 } }, effect: 'artifact' };
  const child = new FakeChild((c) => c.emit(started('st1', artifact), finished('st1', artifact)));
  const outcome = await bridgeWith(child).bridge.explore(request(), grant());
  assert.equal(outcome.failure, 'forbidden_effect');
  assert.equal(outcome.executed.length, 1);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('an external-submit action is never accepted as a well-formed event', async () => {
  const submit = { kind: 'key', key: 'return', effect: 'external-submit' };
  const child = new FakeChild((c) => c.emit(started('st1', submit)));
  const outcome = await bridgeWith(child).bridge.explore(request(), grant());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'error');
});

test('the failure the bridge reports comes back as is', async () => {
  const child = new FakeChild((c) => {
    c.emit(unitFailed('model_unavailable'));
    c.exit(1);
  });
  const outcome = await bridgeWith(child).bridge.explore(request(), grant());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure, 'model_unavailable');
  assert.equal(outcome.modelCalls, 0);
});

test('a finish with a failing exit code, or an exit without a last line, is an error', async () => {
  for (const script of [
    (c: FakeChild) => (c.emit(unitFinished(0)), c.exit(1)),
    (c: FakeChild) => c.exit(0),
  ]) {
    const child = new FakeChild(script);
    const outcome = await bridgeWith(child).bridge.explore(request(), grant());
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.failure, 'error');
  }
});

test('abort sends SIGTERM and resolves cancelled only after the child exits', async () => {
  const controller = new AbortController();
  const child = new FakeChild((c) => {
    c.emit(started('st1'));
    // Mid-action: the bridge finishes the action, then reports and exits.
    c.onSignal = (me, signal) => {
      if (signal !== 'SIGTERM') return;
      setTimeout(() => {
        me.emit(finished('st1'), unitFailed('cancelled'));
        me.exit(1);
      }, 10);
    };
    controller.abort();
  });
  const outcome = await bridgeWith(child).bridge.explore(request(), grant(controller.signal));
  assert.equal(child.hasExited, true);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(outcome.failure, 'cancelled');
  assert.deepEqual(outcome.executed.map((s) => s.result.status), ['ok']);
});

test('a child that ignores SIGTERM is killed after the grace period, and only then does explore resolve', async () => {
  const controller = new AbortController();
  const child = new FakeChild(() => controller.abort());
  child.onSignal = (me, signal) => {
    if (signal === 'SIGKILL') me.exit(null, 'SIGKILL');
  };
  const t0 = Date.now();
  const outcome = await bridgeWith(child, 40).bridge.explore(request(), grant(controller.signal));
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - t0 >= 35, 'waited out the grace period');
  assert.equal(child.hasExited, true);
  assert.equal(outcome.failure, 'cancelled');
});

test('running past budget.timeoutMs stops the child as a timeout', async () => {
  const child = new FakeChild((c) => c.emit(observed('s1')));
  const outcome = await bridgeWith(child).bridge.explore(request({ budget: { maxRounds: 6, timeoutMs: 30 } }), grant());
  assert.equal(outcome.failure, 'timeout');
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.hasExited, true);
});

test('an abort before the start spawns nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const child = new FakeChild(() => assert.fail('must not run'));
  const { bridge, calls } = bridgeWith(child);
  const outcome = await bridge.explore(request(), grant(controller.signal));
  assert.equal(calls.length, 0);
  assert.equal(outcome.failure, 'cancelled');
  assert.deepEqual(outcome.executed, []);
});

test('a request that is invalid or does not match the grant is refused before spawning', async () => {
  const child = new FakeChild(() => assert.fail('must not run'));
  const { bridge, calls } = bridgeWith(child);
  const refusals: Array<[ExplorationRequest, ActorGrant]> = [
    [request({ unit: { ...request().unit, allowedEffects: ['read', 'external-submit'] } }), grant()],
    [request({ submitAllowed: true as unknown as false }), grant()],
    [request({ session: { socket: SOCKET, screenId: 'boss', pid: 4242, windowId: 78 } }), grant()],
    [request({ session: { socket: '/tmp/other.sock', screenId: 'boss', pid: 4242, windowId: 77 } }), grant()],
    [request(), grant(undefined, { holder: 'legacy-assistant' })],
  ];
  for (const [req, g] of refusals) {
    await assert.rejects(bridge.explore(req, g), (error) => isRuntimeError(error, 'invalid_input'));
  }
  assert.equal(calls.length, 0);
});

test('an observer that throws does not break the run', async () => {
  const child = new FakeChild((c) => {
    c.emit(started('st1'), finished('st1'), unitFinished(1));
    c.exit(0);
  });
  const outcome = await bridgeWith(child).bridge.explore(request(), grant(), () => {
    throw new Error('observer broke');
  });
  assert.equal(outcome.status, 'finished');
  assert.equal(outcome.executed.length, 1);
});

test('usageContext is optional and checked when present', () => {
  assert.equal(validateExplorationRequest(request()).ok, true);
  assert.equal(validateExplorationRequest({ ...request(), usageContext: { purpose: 'repair', reason: 'replay_failed' } }).ok, true);
  for (const usageContext of [{ purpose: 'ui' }, { purpose: 'fun', reason: 'missing_procedure' }, { purpose: 'repair', reason: 'whim' }, 'repair']) {
    const result = validateExplorationRequest({ ...request(), usageContext });
    assert.equal(result.ok, false, JSON.stringify(usageContext));
    if (!result.ok) assert.ok(result.errors.some((e) => e.includes('usageContext')));
  }
});

// Real child processes, through createLineProcessSpawner.

async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const PRELUDE = `
const ev = (type, f = {}) => process.stdout.write(JSON.stringify({ v: 1, taskId: 't1', unitAttemptId: 'u1', at: new Date().toISOString(), type, ...f }) + '\\n');
let input = '';
process.stdin.on('data', (d) => (input += d));
`;

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('real children: the request arrives on stdin, the socket in the environment, events on stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-'));
  try {
    const cli = await script(
      dir,
      'bridge.mjs',
      `${PRELUDE}
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  if (process.argv[2] !== 'agent-bridge' || process.env.SECONDSCREEN_SOCKET !== req.session.socket) { ev('unit_failed', { reason: 'error', message: 'bad call' }); process.exit(2); }
  console.error('log lines go to stderr');
  ev('model_usage', { purpose: 'ui', reason: 'missing_procedure', inputTokens: 'unknown', outputTokens: 'unknown' });
  ev('unit_finished', { steps: 0 });
  process.exit(0);
});`,
    );
    const bridge = createAgentBridge({ cli, spawn: createLineProcessSpawner() });
    const outcome = await bridge.explore(request(), grant());
    assert.equal(outcome.status, 'finished', JSON.stringify(outcome));
    assert.equal(outcome.modelCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real children: one that ignores SIGTERM is SIGKILLed and gone before explore resolves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-'));
  try {
    const cli = await script(
      dir,
      'stubborn.mjs',
      `${PRELUDE}
process.on('SIGTERM', () => {});
process.stdin.on('end', () => ev('action_started', { stepId: 'st1', action: { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.5 } }, effect: 'navigation' } }));
setInterval(() => {}, 1000);`,
    );
    let pid: number | undefined;
    const real = createLineProcessSpawner();
    const spawn: LineProcessSpawner = (file, args, env) => {
      const child = real(file, args, env);
      pid = child.pid;
      return child;
    };
    const controller = new AbortController();
    const bridge = createAgentBridge({ cli, spawn, killGraceMs: 200 });
    const pending = bridge.explore(request(), grant(controller.signal), (event) => {
      if (event.type === 'action_started') controller.abort();
    });
    const outcome = await pending;
    assert.equal(alive(pid), false, 'the child is gone when explore resolves');
    assert.equal(outcome.failure, 'cancelled');
    assert.deepEqual(outcome.executed.map((s) => s.result.status), ['unknown']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real children: a missing program or an endless line fail without hanging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-'));
  try {
    const missing = createAgentBridge({ cli: join(dir, 'nope'), spawn: createLineProcessSpawner() });
    const none = await missing.explore(request(), grant());
    assert.equal(none.status, 'failed');
    assert.equal(none.failure, 'error');

    const cli = await script(dir, 'flood.mjs', `${PRELUDE}\nprocess.stdout.write('x'.repeat(5 * 1024 * 1024), () => process.exit(0));`);
    const flood = await createAgentBridge({ cli, spawn: createLineProcessSpawner() }).explore(request(), grant());
    assert.equal(flood.failure, 'error');

    // A complete, newline-terminated line over the cap, even one that would parse, is refused.
    const padded = await script(
      dir,
      'padded.mjs',
      `${PRELUDE}
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ v: 1, taskId: 't1', unitAttemptId: 'u1', at: new Date().toISOString(), type: 'model_usage', purpose: 'ui', reason: 'missing_procedure', inputTokens: 1, outputTokens: 1 }) + ' '.repeat(5 * 1024 * 1024) + '\\n');
  ev('unit_finished', { steps: 0 });
  process.stdout.write('', () => process.exit(0));
});`,
    );
    const big = await createAgentBridge({ cli: padded, spawn: createLineProcessSpawner() }).explore(request(), grant());
    assert.equal(big.failure, 'error');
    assert.equal(big.modelCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real children: a descendant holding stdout open is killed, and explore still resolves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-'));
  try {
    const pidFile = join(dir, 'grandchild.pid');
    const cli = await script(
      dir,
      'parent.mjs',
      `${PRELUDE}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.stdin.on('end', () => {
  // Inherits stdout, so the pipe stays open after this process exits.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
  writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
  ev('unit_finished', { steps: 0 });
  process.exit(0);
});`,
    );
    const t0 = Date.now();
    const outcome = await createAgentBridge({ cli, spawn: createLineProcessSpawner() }).explore(request(), grant());
    const { readFile } = await import('node:fs/promises');
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    assert.equal(outcome.status, 'finished', JSON.stringify(outcome));
    assert.ok(Date.now() - t0 < 4000, 'bounded');
    assert.equal(alive(grandchild), false, 'the descendant is gone when explore resolves');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
