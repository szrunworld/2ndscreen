import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  classifyCliError,
  createCommandRunner,
  createSecondScreenAdapter,
  parseProcessStart,
  pngSize,
} from '../src/adapters/second-screen.ts';
import { RuntimeError, isRuntimeError, type CommandResult, type CommandRunner, type WindowBinding, type WindowProfile } from '../src/contracts.ts';

// A synthetic 2ndscreen: every program the adapter runs goes to a handler
// here, so no real screen, app or BOSS account is touched.

const BUNDLE = 'com.example.synthetic';
const SOCKET = '/tmp/synthetic-2ndscreen.sock';
const profile: WindowProfile = { id: 'synthetic-1440x900', version: 1, logicalWidth: 1440, logicalHeight: 900, bundleId: BUNDLE };
const SCREEN = { name: profile.id, kind: 'agent', displayID: 7, width: 1440, height: 900, hiDPI: true, frame: { x: 3000, y: 0, width: 1440, height: 900 } };
const MAIN = { x: 3000, y: 25, width: 1360, height: 848 };

interface Call {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

type Handler = (args: string[], call: Call) => Partial<CommandResult> | object | Promise<Partial<CommandResult> | object>;

/** A runner that answers 2ndscreen with JSON objects and other tools with raw results. */
function fakeRunner(handlers: { cli?: Handler; tools?: Record<string, Handler> }) {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, options) => {
    const call = { file, args: [...args], env: options.env };
    calls.push(call);
    if (options.signal?.aborted) throw new RuntimeError('cancelled', 'cancelled');
    if (file === 'cli') {
      const reply = (await handlers.cli?.(call.args, call)) ?? { ok: false, error: 'unhandled' };
      if ('code' in reply || 'stdout' in reply) return { code: 0, stdout: '', stderr: '', ...(reply as Partial<CommandResult>) };
      const ok = (reply as { ok?: boolean }).ok === true;
      return { code: ok ? 0 : 1, stdout: JSON.stringify(reply), stderr: '' };
    }
    const tool = handlers.tools?.[file];
    const out = tool ? ((await tool(call.args, call)) as Partial<CommandResult>) : { code: 1, stderr: `no ${file}` };
    return { code: 0, stdout: '', stderr: '', ...out };
  };
  return { run, calls };
}

const verb = (args: string[]) => args.slice(0, args[0] === 'screen' || args[0] === 'app' || args[0] === 'window' ? 2 : 1).join(' ');
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const identityTools: Record<string, Handler> = {
  lsappinfo: (args) =>
    args.includes('bundleID') ? { stdout: `"CFBundleIdentifier"="${BUNDLE}"\n` } : { stdout: '' },
  ps: () => ({ stdout: 'Thu Sep 17 21:55:13 2026\n' }),
};

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'a1-adapter-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const binding: WindowBinding = {
  screenId: profile.id,
  socket: SOCKET,
  window: { pid: 4242, windowId: 77, processStartedAt: '2026-09-17T21:55:13.000Z', bundleId: BUNDLE, title: 'Synthetic', frame: MAIN, contentFrame: MAIN, scale: 2, displayId: 7 },
  launchedByRuntime: true,
};

test('ensureScreen starts the side instance on its own socket and creates an owned, expiring screen', async () => {
  let started = false;
  let created = false;
  const { run, calls } = fakeRunner({
    cli: (args) => {
      if (verb(args) === 'screen list') return started ? { ok: true, screens: created ? [SCREEN] : [] } : { ok: false, error: '2ndscreen is not running; open 2ndscreen.app first' };
      if (verb(args) === 'screen create') {
        created = true;
        return { ok: true, screen: SCREEN };
      }
      return { ok: false, error: 'unexpected' };
    },
    tools: {
      open: () => {
        started = true;
        return { code: 0 };
      },
    },
  });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, app: '/Apps/2ndscreen.app', run, screenshotDir: '/nonexistent' });
  assert.deepEqual(await adapter.ensureScreen(profile), { screenId: profile.id, socket: SOCKET });
  const open = calls.find((c) => c.file === 'open')!;
  assert.deepEqual(open.args, ['-g', '-n', '--env', `SECONDSCREEN_SOCKET=${SOCKET}`, '/Apps/2ndscreen.app']);
  for (const c of calls.filter((c) => c.file === 'cli')) assert.equal(c.env?.SECONDSCREEN_SOCKET, SOCKET);
  const create = calls.find((c) => verb(c.args) === 'screen create')!;
  assert.equal(flag(create.args, '--name'), profile.id);
  assert.equal(flag(create.args, '--size'), '1440x900');
  assert.equal(flag(create.args, '--owner-pid'), String(process.pid));
  assert.equal(flag(create.args, '--idle-timeout'), '30m');
});

test('ensureScreen reuses a matching screen, resizes a different one, and never destroys screens', async () => {
  const sized = { ...SCREEN, width: 1280, height: 800 };
  let current = sized;
  const { run, calls } = fakeRunner({
    cli: (args) => {
      if (verb(args) === 'screen list') return { ok: true, screens: [current] };
      if (verb(args) === 'screen resize') {
        current = SCREEN;
        return { ok: true };
      }
      return { ok: false, error: 'unexpected' };
    },
  });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  await adapter.ensureScreen(profile);
  assert.deepEqual(calls.find((c) => verb(c.args) === 'screen resize')!.args, ['screen', 'resize', profile.id, '--size', '1440x900']);
  await adapter.ensureScreen(profile);
  assert.equal(calls.filter((c) => verb(c.args) === 'screen resize').length, 1);
  assert.ok(!calls.some((c) => c.args.includes('destroy') || verb(c.args) === 'screen create'));
});

test('ensureScreen without an app to start reports capability_missing; a bad profile id is invalid', async () => {
  const { run } = fakeRunner({ cli: () => ({ ok: false, error: '2ndscreen is not running; open 2ndscreen.app first' }) });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  await assert.rejects(adapter.ensureScreen(profile), (e) => isRuntimeError(e, 'capability_missing'));
  await assert.rejects(adapter.ensureScreen({ ...profile, id: 'bad/name' }), (e) => isRuntimeError(e, 'invalid_input'));
});

test('bindApp launches a missing app and waits past its loading window to a settled main window', async () => {
  let reads = 0;
  const { run, calls } = fakeRunner({
    cli: (args) => {
      switch (verb(args)) {
        case 'screen list':
          return { ok: true, screens: [SCREEN] };
        case 'app launch':
          return { ok: true, pid: 4242 };
        case 'state': {
          reads++;
          // Loading window first (P0: 340x500, its own window id), then the main one.
          if (reads <= 2) return { ok: true, pid: 4242, windowID: 70, app: 'Synthetic', windowFrame: { x: 3500, y: 200, width: 340, height: 500 } };
          return { ok: true, pid: 4242, windowID: 77, app: 'Synthetic', windowFrame: MAIN };
        }
      }
      return { ok: false, error: 'unexpected' };
    },
    tools: identityTools,
  });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  const bound = await adapter.bindApp(profile.id, profile, { takeOver: false });
  assert.equal(bound.launchedByRuntime, true);
  assert.equal(bound.window.windowId, 77);
  assert.equal(bound.window.pid, 4242);
  assert.equal(bound.window.scale, 2);
  assert.equal(bound.window.displayId, 7);
  assert.deepEqual(bound.window.frame, MAIN);
  assert.equal(bound.window.processStartedAt, new Date('Thu Sep 17 21:55:13 2026').toISOString());
  const launch = calls.find((c) => verb(c.args) === 'app launch')!;
  assert.deepEqual(launch.args, ['app', 'launch', '--screen', profile.id, '--bundle', BUNDLE, '--fill']);
  assert.ok(reads >= 4, 'the main window is read twice before it counts as settled');
});

test('bindApp leaves an app running elsewhere alone without takeOver, and moves it with takeOver', async () => {
  const handlers = {
    cli: (args: string[]) => {
      switch (verb(args)) {
        case 'screen list':
          return { ok: true, screens: [SCREEN] };
        case 'state':
          return moved
            ? { ok: true, pid: 999, windowID: 5, app: 'Synthetic', windowFrame: MAIN }
            : { ok: false, error: `pid 999 has no window on screen "${profile.id}"; launch or move it there first` };
        case 'window move':
          moved = true;
          return { ok: true };
      }
      return { ok: false, error: 'unexpected' };
    },
    tools: { ...identityTools, lsappinfo: (args: string[]) => (args.includes('bundleID') ? { stdout: `"CFBundleIdentifier"="${BUNDLE}"` } : { stdout: '"pid"=999\n' }) },
  };
  let moved = false;
  const first = fakeRunner(handlers);
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run: first.run, screenshotDir: '/x' });
  await assert.rejects(adapter.bindApp(profile.id, profile, { takeOver: false }), (e) => {
    assert.ok(isRuntimeError(e, 'conflict'));
    assert.equal(e.details?.pid, 999);
    assert.equal(e.details?.processStartedAt, new Date('Thu Sep 17 21:55:13 2026').toISOString());
    return true;
  });
  assert.ok(!first.calls.some((c) => verb(c.args) === 'window move' || verb(c.args) === 'app launch'));

  const second = fakeRunner(handlers);
  const taking = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run: second.run, screenshotDir: '/x' });
  const bound = await taking.bindApp(profile.id, profile, { takeOver: true });
  assert.equal(bound.launchedByRuntime, false);
  assert.deepEqual(second.calls.find((c) => verb(c.args) === 'window move')!.args, ['window', 'move', '--screen', profile.id, '--pid', '999', '--fill']);
});

test('bindApp attaches to an app already on its screen without launching or moving it, and checks the bundle', async () => {
  const make = (bundle: string) =>
    fakeRunner({
      cli: (args) =>
        verb(args) === 'screen list'
          ? { ok: true, screens: [SCREEN] }
          : verb(args) === 'state'
            ? { ok: true, pid: 4242, windowID: 77, app: 'Synthetic', windowFrame: MAIN }
            : { ok: false, error: 'unexpected' },
      tools: { ...identityTools, lsappinfo: (args) => (args.includes('bundleID') ? { stdout: `"CFBundleIdentifier"="${bundle}"` } : { stdout: '"pid"=4242' }) },
    });
  const good = make(BUNDLE);
  const bound = await createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run: good.run, screenshotDir: '/x' }).bindApp(profile.id, profile, { takeOver: false });
  assert.equal(bound.launchedByRuntime, false);
  assert.ok(!good.calls.some((c) => ['app launch', 'window move'].includes(verb(c.args))));
  const wrong = make('com.other.app');
  await assert.rejects(
    createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run: wrong.run, screenshotDir: '/x' }).bindApp(profile.id, profile, { takeOver: false }),
    (e) => isRuntimeError(e, 'conflict'),
  );
});

test('observe returns typed elements, text and a measured screenshot, and a cropped region with true covers', async () => {
  await withDir(async (dir) => {
    const { run, calls } = fakeRunner({
      cli: async (args) => {
        const shot = flag(args, '--screenshot');
        // The window is 1360x848 pt; its shot is 2720x1696 px.
        if (shot) await writeFile(shot, png(2720, 1696));
        return {
          ok: true,
          pid: 4242,
          windowID: 77,
          app: 'Synthetic',
          windowFrame: MAIN,
          screenshot: shot,
          elements: [
            { index: -1, role: 'AXGroup', label: 'context' },
            { index: 0, role: 'AXButton', label: 'Open', frame: { x: 3010, y: 40, width: 50, height: 20 } },
            { index: 1, role: 'AXStaticText', value: 'Synthetic row' },
          ],
        };
      },
      tools: {
        sips: async (args) => {
          const [h, w] = [Number(args[1]), Number(args[2])];
          await writeFile(args[args.length - 1]!, png(w, h));
          return { code: 0 };
        },
      },
    });
    const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: dir, clock: { now: () => new Date('2026-10-04T08:00:00Z') } });
    const o = await adapter.observe(binding, { elements: true, screenshot: true });
    assert.equal(o.takenAt, '2026-10-04T08:00:00.000Z');
    assert.deepEqual(o.elements?.map((e) => e.index), [0, 1]);
    assert.deepEqual(o.elements?.[0]?.frame, { x: 3010, y: 40, width: 50, height: 20 });
    assert.equal(o.text, 'context\nOpen\nSynthetic row');
    assert.equal(o.screenshot?.widthPx, 2720);
    assert.deepEqual(o.screenshot?.covers, MAIN);
    assert.equal(o.screenshot?.sha256, createHash('sha256').update(await readFile(o.screenshot!.path)).digest('hex'));
    assert.deepEqual(flag(calls[0]!.args, '--window-id'), '77');

    const second = await adapter.observe(binding, { screenshot: true, region: { x: 3100, y: 125, width: 400, height: 10_000 } });
    assert.notEqual(second.snapshotId, o.snapshotId);
    const sips = calls.find((c) => c.file === 'sips')!;
    // 2 px per point, clipped to the window bottom (25 + 848).
    assert.deepEqual(sips.args.slice(0, 6), ['-c', String((873 - 125) * 2), '800', '--cropOffset', '200', '200']);
    assert.deepEqual(second.screenshot?.covers, { x: 3100, y: 125, width: 400, height: 748 });
    assert.equal(second.screenshot?.widthPx, 800);
  });
});

test('observe follows a geometry change but reports a replaced window as window_lost', async () => {
  let frame = MAIN;
  let windowID = 77;
  const { run } = fakeRunner({ cli: () => ({ ok: true, pid: 4242, windowID, app: 'S', windowFrame: frame, elements: [] }) });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  frame = { x: 3000, y: 25, width: 1440, height: 875 };
  const o = await adapter.observe(binding, { elements: false });
  assert.deepEqual(o.window.frame, frame);
  assert.deepEqual(o.window.contentFrame, frame);
  assert.equal(o.elements, undefined);
  windowID = 78;
  await assert.rejects(adapter.observe(binding, {}), (e) => isRuntimeError(e, 'window_lost'));
  const gone = fakeRunner({ cli: () => ({ ok: false, error: 'pid 4242 has no on-screen window 77' }) });
  await assert.rejects(
    createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run: gone.run, screenshotDir: '/x' }).observe(binding, {}),
    (e) => isRuntimeError(e, 'window_lost'),
  );
});

test('act maps each action to its CLI words and route, in the bound window only', async () => {
  const { run, calls } = fakeRunner({ cli: () => ({ ok: true, route: 'event.pid' }) });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  const base = ['--screen', profile.id, '--pid', '4242', '--window-id', '77'];

  let r = await adapter.act(binding, { actionId: 'a1', snapshotId: 's1', action: { kind: 'click', target: { kind: 'element', index: 3 }, count: 2, effect: 'navigation' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.route, 'element');
  assert.deepEqual(calls.at(-1)!.args, ['click', ...base, '--double', '--index', '3']);

  r = await adapter.act(binding, { actionId: 'a2', action: { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.25 } }, button: 'right', effect: 'read' } });
  assert.equal(r.route, 'coordinate');
  assert.deepEqual(r.point, { x: 3000 + 680, y: 25 + 212 });
  assert.deepEqual(calls.at(-1)!.args, ['click', ...base, '--right', '--x', '3680', '--y', '237']);

  await adapter.act(binding, { actionId: 'a3', action: { kind: 'scroll', direction: 'down', amount: 5, by: 'line', effect: 'read' } });
  assert.deepEqual(calls.at(-1)!.args, ['scroll', ...base, '--direction', 'down', '--amount', '5', '--by', 'line']);

  r = await adapter.act(binding, { actionId: 'a4', action: { kind: 'key', key: 'f', modifiers: ['cmd', 'shift'], effect: 'navigation' } });
  assert.equal(r.route, 'keyboard');
  assert.deepEqual(calls.at(-1)!.args, ['key', ...base, '--key', 'f', '--modifiers', 'cmd,shift']);

  await adapter.act(binding, { actionId: 'a5', snapshotId: 's', action: { kind: 'type', value: 'x', replace: true, target: { kind: 'element', index: 2 }, effect: 'navigation' } });
  assert.deepEqual(calls.at(-1)!.args, ['type', ...base, '--value', 'x', '--replace', '--index', '2']);

  const count = calls.length;
  r = await adapter.act(binding, { actionId: 'a6', action: { kind: 'click', target: { kind: 'element', label: 'Open' }, effect: 'read' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'invalid_input');
  assert.equal(calls.length, count, 'the adapter never resolves semantic locators itself');
});

test('act reports stale indexes, classified failures, and unknown when a command is cut off', async () => {
  let reply: object | (() => never) = { ok: false, error: 'no element 9 in the window; run state again' };
  const { run } = fakeRunner({
    cli: () => {
      if (typeof reply === 'function') reply();
      return reply as object;
    },
  });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  const click = { actionId: 'a', snapshotId: 's', action: { kind: 'click' as const, target: { kind: 'element' as const, index: 9 }, effect: 'read' as const } };
  assert.equal((await adapter.act(binding, click)).status, 'stale_snapshot');
  reply = { ok: false, error: '2ndscreen needs the Accessibility permission to move windows' };
  const denied = await adapter.act(binding, click);
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error?.code, 'permission_missing');
  reply = () => {
    throw new RuntimeError('timeout', 'cli took longer than 15000 ms');
  };
  const cut = await adapter.act(binding, click);
  assert.equal(cut.status, 'unknown');
  assert.equal(cut.error?.code, 'timeout');
  const outside = await adapter.act(binding, { actionId: 'b', action: { kind: 'click', target: { kind: 'relative', point: { x: 1, y: 1 } }, effect: 'read' } });
  assert.equal(outside.status, 'failed');
});

test('an aborted signal stops every operation before it runs a command', async () => {
  const { run, calls } = fakeRunner({ cli: () => ({ ok: true }) });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  const signal = AbortSignal.abort();
  await assert.rejects(adapter.ensureScreen(profile, signal), (e) => isRuntimeError(e, 'cancelled'));
  await assert.rejects(adapter.observe(binding, {}, signal), (e) => isRuntimeError(e, 'cancelled'));
  await assert.rejects(adapter.act(binding, { actionId: 'a', action: { kind: 'key', key: 'a', effect: 'read' } }, signal), (e) => isRuntimeError(e, 'cancelled'));
  assert.equal(calls.length, 0);
});

test('releaseWindow releases only the bound window and tolerates one already gone', async () => {
  let gone = false;
  const { run, calls } = fakeRunner({ cli: () => (gone ? { ok: false, error: 'pid 4242 has no matching window on screen "x"' } : { ok: true }) });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  await adapter.releaseWindow(binding);
  assert.deepEqual(calls[0]!.args, ['window', 'release', '--screen', profile.id, '--pid', '4242', '--window-id', '77']);
  gone = true;
  await adapter.releaseWindow(binding);
});

test('capabilities probe permissions against an agent screen and report P0 input gaps', async () => {
  await withDir(async (dir) => {
    const { run } = fakeRunner({
      cli: async (args) => {
        if (verb(args) === 'screen list') return { ok: true, screens: [SCREEN] };
        if (verb(args) === 'window release') return { ok: false, error: 'pid 0 has no matching window on screen "x"' };
        if (args[0] === 'screenshot') {
          await writeFile(flag(args, '--output')!, png(2, 2));
          return { ok: true };
        }
        return { ok: false, error: 'unexpected' };
      },
      tools: { plutil: () => ({ stdout: '1.4.0\n' }) },
    });
    const caps = await createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, app: '/A.app', run, screenshotDir: dir }).capabilities();
    assert.deepEqual(caps, {
      version: '1.4.0',
      backgroundClick: true,
      backgroundScroll: true,
      backgroundType: false,
      screenshot: true,
      accessibility: true,
      screenRecordingPermission: true,
      accessibilityPermission: true,
    });
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(dir), [], 'the probe screenshot is removed');
  });
});

test('helpers: error classification, process start and PNG size', () => {
  assert.equal(classifyCliError('2ndscreen is not running; open 2ndscreen.app first'), 'capability_missing');
  assert.equal(classifyCliError('window 77 is not on screen "boss"; move it there first'), 'window_lost');
  assert.equal(classifyCliError('2ndscreen needs the Screen Recording permission to take screenshots'), 'permission_missing');
  assert.equal(classifyCliError('no element matches "x"; run state to see what is there'), 'not_found');
  assert.equal(parseProcessStart('  '), undefined);
  assert.equal(parseProcessStart('Thu Sep 17 21:55:13 2026'), new Date('Thu Sep 17 21:55:13 2026').toISOString());
  assert.deepEqual(pngSize(png(5, 3)), { width: 5, height: 3 });
  assert.throws(() => pngSize(Buffer.from('nope')), (e) => isRuntimeError(e, 'io'));
});

test('createCommandRunner resolves exit codes and turns timeouts, aborts and missing programs into runtime errors', async () => {
  const run = createCommandRunner();
  assert.deepEqual(await run('/bin/sh', ['-c', 'printf "$X"; exit 3'], { env: { X: 'hi' }, timeoutMs: 5000 }), { code: 3, stdout: 'hi', stderr: '' });
  await assert.rejects(run('/bin/sleep', ['5'], { timeoutMs: 100 }), (e) => isRuntimeError(e, 'timeout'));
  const controller = new AbortController();
  const pending = run('/bin/sleep', ['5'], { timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (e) => isRuntimeError(e, 'cancelled'));
  await assert.rejects(run('/nonexistent/program', [], { timeoutMs: 1000 }), (e) => isRuntimeError(e, 'capability_missing'));
});
