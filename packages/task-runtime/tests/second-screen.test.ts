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
  type CommandSpawn,
  pngSize,
  rasterCoversFrame,
  rectWithin,
} from '../src/adapters/second-screen.ts';
import { RuntimeError, isRuntimeError, type CommandResult, type CommandRunner, type Rect, type WindowBinding, type WindowProfile } from '../src/contracts.ts';

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
  window: { pid: 4242, windowId: 77, processStartedAt: parseProcessStart('Thu Sep 17 21:55:13 2026'), bundleId: BUNDLE, title: 'Synthetic', frame: MAIN, contentFrame: MAIN, scale: 2, displayId: 7 },
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

test('ensureScreen reuses a matching screen, resizes a different one it owns, and never destroys screens', async () => {
  const sized = { ...SCREEN, width: 1280, height: 800, ownerPID: process.pid };
  let current: object = sized;
  const { run, calls } = fakeRunner({
    cli: (args) => {
      if (verb(args) === 'screen list') return { ok: true, screens: [current] };
      if (verb(args) === 'screen resize') {
        current = { ...SCREEN, ownerPID: process.pid };
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

// Geometry: a bound window must lie wholly within its screen (P0: an accepted window reached past
// its 1440x900 screen, and pane screenshots came back 913x1102 instead of 1468x1750).

/** An app already running on the screen whose window reads as `frames()`; `move` records refits. */
function placedApp(frames: () => Rect, screens: () => Rect[] = () => [SCREEN.frame], onMove: () => void = () => {}) {
  let listed = 0;
  return fakeRunner({
    cli: (args) => {
      switch (verb(args)) {
        case 'screen list': {
          const all = screens();
          return { ok: true, screens: [{ ...SCREEN, frame: all[Math.min(listed++, all.length - 1)] }] };
        }
        case 'state':
          return { ok: true, pid: 4242, windowID: 77, app: 'Synthetic', windowFrame: frames() };
        case 'window move':
          onMove();
          return { ok: true };
      }
      return { ok: false, error: 'unexpected' };
    },
    tools: { ...identityTools, lsappinfo: (args) => (args.includes('bundleID') ? { stdout: `"CFBundleIdentifier"="${BUNDLE}"` } : { stdout: '"pid"=4242' }) },
  });
}

test('geometry helpers: containment up to rounding, and a raster that covers its frame at its scale', () => {
  const screen = SCREEN.frame;
  assert.equal(rectWithin(MAIN, screen), true, 'below the menu bar, narrower than the screen');
  assert.equal(rectWithin({ x: 3000, y: 25, width: 1440, height: 875 }, screen), true, 'the full visible area');
  assert.equal(rectWithin({ x: 3000.5, y: 25, width: 1440, height: 875 }, screen), true, 'half a point of rounding');
  assert.equal(rectWithin({ x: 3200, y: 25, width: 1360, height: 848 }, screen), false, 'past the right edge');
  assert.equal(rectWithin({ x: 2960, y: -10, width: 1520, height: 950 }, screen), false, 'oversized, centred');
  assert.equal(rasterCoversFrame({ width: 2880, height: 1750 }, { x: 3000, y: 25, width: 1440, height: 875 }, 2), true);
  assert.equal(rasterCoversFrame({ width: 2721, height: 1696 }, MAIN, 2), true, 'outward rounding by one pixel');
  assert.equal(rasterCoversFrame({ width: 2480, height: 1696 }, { x: 3200, y: 25, width: 1360, height: 848 }, 2), false, 'clipped at the screen edge');
  assert.equal(rasterCoversFrame({ width: 1360, height: 848 }, MAIN, 2), false, 'a 1x image of a 2x window');
});

test('bindApp refuses a window reaching past its screen without takeOver, and does not touch it', async () => {
  for (const frame of [{ x: 3200, y: 25, width: 1360, height: 848 }, { x: 2960, y: -10, width: 1520, height: 950 }]) {
    let moves = 0;
    const { run, calls } = placedApp(() => frame, undefined, () => moves++);
    const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
    await assert.rejects(adapter.bindApp(profile.id, profile, { takeOver: false }), (e) => {
      assert.ok(isRuntimeError(e, 'conflict'));
      assert.match(e.message, /reaches past screen .* pass takeOver to refit it/);
      assert.deepEqual(e.details?.frame, frame);
      assert.deepEqual(e.details?.screenFrame, SCREEN.frame);
      return true;
    });
    assert.equal(moves, 0);
    assert.ok(!calls.some((c) => ['window move', 'app launch'].includes(verb(c.args))), 'nothing was moved or launched');
  }
});

test('bindApp with takeOver refits an oversized window once and binds it where it settled', async () => {
  let frame: Rect = { x: 2960, y: -10, width: 1520, height: 950 };
  const { run, calls } = placedApp(() => frame, undefined, () => (frame = { x: 3000, y: 25, width: 1440, height: 875 }));
  const bound = await createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' }).bindApp(profile.id, profile, { takeOver: true });
  assert.deepEqual(bound.window.frame, { x: 3000, y: 25, width: 1440, height: 875 });
  const moves = calls.filter((c) => verb(c.args) === 'window move');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0]!.args, ['window', 'move', '--screen', profile.id, '--pid', '4242', '--window-id', '77', '--fill']);
});

test('bindApp refits a window it launched itself without needing takeOver', async () => {
  let frame: Rect = { x: 3200, y: 25, width: 1360, height: 848 };
  const { run, calls } = fakeRunner({
    cli: (args) => {
      switch (verb(args)) {
        case 'screen list':
          return { ok: true, screens: [SCREEN] };
        case 'app launch':
          return { ok: true, pid: 4242 };
        case 'state':
          return { ok: true, pid: 4242, windowID: 77, app: 'Synthetic', windowFrame: frame };
        case 'window move':
          frame = MAIN;
          return { ok: true };
      }
      return { ok: false, error: 'unexpected' };
    },
    tools: identityTools,
  });
  const bound = await createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' }).bindApp(profile.id, profile, { takeOver: false });
  assert.equal(bound.launchedByRuntime, true);
  assert.deepEqual(bound.window.frame, MAIN);
  assert.equal(calls.filter((c) => verb(c.args) === 'window move').length, 1);
});

test('bindApp gives up honestly when refitting does not bring the window inside', async () => {
  const frame = { x: 2960, y: -10, width: 1520, height: 950 };
  let moves = 0;
  const { run } = placedApp(() => frame, undefined, () => moves++);
  await assert.rejects(
    createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' }).bindApp(profile.id, profile, { takeOver: true }),
    (e) => isRuntimeError(e, 'conflict') && /still reaches past screen .* after 2 refits/.test(e.message),
  );
  assert.equal(moves, 2, 'bounded');
});

test('bindApp checks the window against the screen as it is now, not where it was', async () => {
  // The display moved between the first read and the bind: the window sits wholly in the new place.
  const moved = { x: 5000, y: 0, width: 1440, height: 900 };
  const frame = { x: 5000, y: 25, width: 1360, height: 848 };
  const { run, calls } = placedApp(() => frame, () => [SCREEN.frame, moved]);
  const bound = await createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' }).bindApp(profile.id, profile, { takeOver: false });
  assert.deepEqual(bound.window.frame, frame);
  assert.ok(!calls.some((c) => verb(c.args) === 'window move'));
});

test('observe refuses a screenshot clipped by the screen edge instead of stretching it over the window', async () => {
  await withDir(async (dir) => {
    // The window drifted past the right edge after binding; the CLI's crop stops at the screen.
    const drifted = { x: 3200, y: 25, width: 1360, height: 848 };
    const { run } = fakeRunner({
      cli: async (args) => {
        if (verb(args) === 'screen list') return { ok: true, screens: [SCREEN] };
        const shot = flag(args, '--screenshot');
        if (shot) await writeFile(shot, png((4440 - 3200) * 2, 848 * 2));
        return { ok: true, pid: 4242, windowID: 77, app: 'Synthetic', windowFrame: drifted, screenshot: shot, elements: [] };
      },
    });
    const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: dir });
    await assert.rejects(adapter.observe(binding, { screenshot: true, region: { x: 3300, y: 100, width: 734, height: 700 } }), (e) => {
      assert.ok(isRuntimeError(e, 'window_lost'));
      assert.match(e.message, /2480x1696 px, not the whole window .* reaches past screen/);
      return true;
    });
    // Without a screenshot nothing is clipped, and the drifted frame is reported as it is.
    const plain = await adapter.observe(binding, { screenshot: false });
    assert.deepEqual(plain.window.frame, drifted);
  });
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
  const { run, calls } = fakeRunner({ cli: () => ({ ok: true, route: 'event.pid' }), tools: identityTools });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  const base = ['--screen', profile.id, '--pid', '4242', '--window-id', '77'];

  let r = await adapter.act(binding, { actionId: 'a1', snapshotId: 's1', action: { kind: 'click', target: { kind: 'element', index: 3 }, count: 2, effect: 'navigation' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.route, 'element');
  assert.deepEqual(calls.at(-1)!.args, ['click', ...base, '--double', '--index', '3']);
  // Each input is preceded by a fresh identity read of the bound pid.
  assert.deepEqual(calls.slice(-3, -1).map((c) => c.file), ['lsappinfo', 'ps']);

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

  const count = calls.filter((c) => c.file === 'cli').length;
  r = await adapter.act(binding, { actionId: 'a6', action: { kind: 'click', target: { kind: 'element', label: 'Open' }, effect: 'read' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'invalid_input');
  assert.equal(calls.filter((c) => c.file === 'cli').length, count, 'the adapter never resolves semantic locators itself');
});

test('act reports stale indexes, classified failures, and unknown when a command is cut off', async () => {
  let reply: object | (() => never) = { ok: false, error: 'no element 9 in the window; run state again' };
  const { run } = fakeRunner({
    cli: () => {
      if (typeof reply === 'function') reply();
      return reply as object;
    },
    tools: identityTools,
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

test('an explicit accessibility press goes out as ax-press on one index and reports its own route', async () => {
  let reply: object = { ok: true, route: 'ax.press.explicit' };
  const { run, calls } = fakeRunner({ cli: () => reply, tools: identityTools });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  const base = ['--screen', profile.id, '--pid', '4242', '--window-id', '77'];
  const press = (extra: object = {}, target: object = { kind: 'element', index: 5 }) =>
    adapter.act(binding, { actionId: 'p', snapshotId: 's', action: { kind: 'click', target, method: 'accessibility', effect: 'navigation', ...extra } as never });
  const cli = () => calls.filter((c) => c.file === 'cli');

  let r = await press();
  assert.equal(r.status, 'ok');
  assert.equal(r.route, 'accessibility');
  assert.equal(r.point, undefined);
  assert.deepEqual(cli().at(-1)!.args, ['ax-press', ...base, '--index', '5']);

  // The default click is unchanged: same verb and words, element route, even when the CLI pressed a native control.
  reply = { ok: true, route: 'ax.press' };
  r = await adapter.act(binding, { actionId: 'c', snapshotId: 's', action: { kind: 'click', target: { kind: 'element', index: 5 }, effect: 'navigation' } });
  assert.equal(r.route, 'element');
  assert.deepEqual(cli().at(-1)!.args, ['click', ...base, '--index', '5']);

  // Refused before any command: points, other buttons, double clicks, unknown methods.
  const sent = cli().length;
  for (const [what, result] of [
    ['point', await press({}, { kind: 'relative', point: { x: 0.3, y: 0.04 } })],
    ['right', await press({ button: 'right' })],
    ['double', await press({ count: 2 })],
    ['method', await press({ method: 'event' })],
  ] as const) {
    assert.equal(result.status, 'failed', what);
    assert.equal(result.error?.code, 'invalid_input', what);
  }
  assert.equal(cli().length, sent, 'nothing was sent for a malformed press');

  // A CLI or side instance that predates ax-press refuses it before any input: capability_missing.
  for (const error of ['unknown command\n\nusage: 2ndscreen …', 'bad request: The data couldn’t be read because it isn’t in the correct format.']) {
    reply = { ok: false, error };
    r = await press();
    assert.equal(r.status, 'failed');
    assert.equal(r.error?.code, 'capability_missing', error);
  }
  reply = { ok: false, error: 'element 5 does not advertise AXPress; nothing was pressed' };
  assert.equal((await press()).error?.code, 'capability_missing');
  reply = { ok: false, error: 'no element 5 in the window; run state again' };
  assert.equal((await press()).status, 'stale_snapshot');
  // Answered ok without the explicit route: whatever happened, it was not a verified press.
  reply = { ok: true, route: 'event.click' };
  r = await press();
  assert.equal(r.status, 'unknown');
  assert.equal(r.error?.code, 'capability_missing');
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
  const { run, calls } = fakeRunner({ cli: () => (gone ? { ok: false, error: 'pid 4242 has no matching window on screen "x"' } : { ok: true }), tools: identityTools });
  const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
  await adapter.releaseWindow(binding);
  assert.deepEqual(calls.find((c) => c.file === 'cli')!.args, ['window', 'release', '--screen', profile.id, '--pid', '4242', '--window-id', '77']);
  gone = true;
  await adapter.releaseWindow(binding);
});

test('capabilities probe only by reading, and report what they cannot verify as false', async () => {
  await withDir(async (dir) => {
    const { run, calls } = fakeRunner({
      cli: async (args) => {
        if (verb(args) === 'screen list') return { ok: true, screens: [SCREEN] };
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
      accessibility: false,
      screenRecordingPermission: true,
      accessibilityPermission: false,
    });
    const verbs = calls.filter((c) => c.file === 'cli').map((c) => c.args[0]);
    assert.deepEqual(verbs, ['screen', 'screenshot'], 'no window, input or screen mutation is used as a probe');
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

// Review regressions: ownership, process identity, child termination and geometry.

test('ensureScreen will not resize a screen it does not own', async () => {
  for (const ownerPID of [undefined, process.pid + 1]) {
    const { run, calls } = fakeRunner({ cli: (args) => (verb(args) === 'screen list' ? { ok: true, screens: [{ ...SCREEN, width: 1280, height: 800, ownerPID }] } : { ok: true }) });
    const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
    await assert.rejects(adapter.ensureScreen(profile), (e) => isRuntimeError(e, 'conflict'));
    assert.deepEqual(calls.map((c) => verb(c.args)), ['screen list', 'screen list'], 'listed only; nothing resized, created or destroyed');
  }
  // A right-sized screen of someone else's is used as it is, without change.
  const { run, calls } = fakeRunner({ cli: () => ({ ok: true, screens: [{ ...SCREEN, ownerPID: 1 }] }) });
  await createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' }).ensureScreen(profile);
  assert.ok(calls.every((c) => verb(c.args) === 'screen list'));
});

test('input and release are refused for a recycled pid, another app, or a binding without a start time', async () => {
  const cases: Array<[string, WindowBinding, Record<string, Handler>]> = [
    ['recycled pid', binding, { ...identityTools, ps: () => ({ stdout: 'Sun Oct  4 09:00:00 2026\n' }) }],
    ['other app', binding, { ...identityTools, lsappinfo: () => ({ stdout: '"CFBundleIdentifier"="com.other.app"' }) }],
    ['process gone', binding, { lsappinfo: () => ({ stdout: '' }), ps: () => ({ code: 1, stdout: '' }) }],
    ['no start time', { ...binding, window: { ...binding.window, processStartedAt: undefined } }, identityTools],
  ];
  for (const [name, bound, tools] of cases) {
    const { run, calls } = fakeRunner({ cli: () => ({ ok: true }), tools });
    const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: '/x' });
    const r = await adapter.act(bound, { actionId: 'a', action: { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.5 } }, effect: 'read' } });
    assert.equal(r.status, 'failed', name);
    assert.equal(r.error?.code, 'window_lost', name);
    await assert.rejects(adapter.releaseWindow(bound), (e) => isRuntimeError(e, 'window_lost'), name);
    assert.equal(calls.filter((c) => c.file === 'cli').length, 0, `${name}: no input and no window move was sent`);
  }
});

test('session and adapter together map window fractions against the window as it is now, after a move or resize', async () => {
  const { createSessionManager } = await import('../src/session.ts');
  await withDir(async (dir) => {
    let frame = MAIN;
    const { run, calls } = fakeRunner({
      cli: async (args) => {
        switch (verb(args)) {
          case 'screen list':
            return { ok: true, screens: [{ ...SCREEN, ownerPID: process.pid }] };
          case 'state': {
            const shot = flag(args, '--screenshot');
            if (shot) await writeFile(shot, png(frame.width * 2, frame.height * 2));
            return { ok: true, pid: 4242, windowID: 77, app: 'Synthetic', windowFrame: frame, screenshot: shot, elements: [] };
          }
          default:
            return { ok: true };
        }
      },
      tools: { ...identityTools, lsappinfo: (args) => (args.includes('bundleID') ? { stdout: `"CFBundleIdentifier"="${BUNDLE}"` } : { stdout: '"pid"=4242' }) },
    });
    const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: dir });
    const vision = {
      // The text sits at the centre of whatever image it is given.
      async ocr(_p: string, _o?: unknown) {
        return { imageSha256: 'h', widthPx: frame.width * 2, heightPx: frame.height * 2, lines: [{ text: 'Open', box: { x: frame.width - 10, y: frame.height - 10, width: 20, height: 20 }, confidence: 1 }] };
      },
      async compare() {
        return { similarity: 1 };
      },
      async close() {},
    };
    const leases = {
      async acquireLease(r: { scopeKey: string; holder: 'runtime'; ownerPid: number; taskId?: string; ttlMs: number }) {
        return { scopeKey: r.scopeKey, holder: r.holder, ownerPid: r.ownerPid, taskId: r.taskId, leaseId: 'l', expiresAt: new Date(Date.now() + r.ttlMs).toISOString() };
      },
      async renewLease(id: string, ttl: number) {
        return { leaseId: id, scopeKey: `${BUNDLE}:*`, holder: 'runtime' as const, ownerPid: 1, expiresAt: new Date(Date.now() + ttl).toISOString() };
      },
      async releaseLease() {},
    };
    const session = await createSessionManager({ adapter, leases, policy: { submitAllowed: false, foregroundAllowed: false }, vision }).open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 60_000 });
    assert.deepEqual(session.binding().window.frame, MAIN);

    // The window moves to another place and size after binding.
    frame = { x: 5000, y: 100, width: 1440, height: 875 };
    const clicks = () => calls.filter((c) => c.file === 'cli' && c.args[0] === 'click');
    await session.act({ actionId: 'r', action: { kind: 'click', target: { kind: 'relative', point: { x: 0.5, y: 0.5 } }, effect: 'read' } });
    assert.deepEqual([flag(clicks().at(-1)!.args, '--x'), flag(clicks().at(-1)!.args, '--y')], [String(5000 + 720), String(100 + 437.5)]);
    assert.deepEqual(session.binding().window.frame, frame, 'the binding carries the measured geometry');

    frame = { x: 6000, y: 50, width: 1200, height: 800 };
    await session.act({ actionId: 'o', action: { kind: 'click', target: { kind: 'ocr', text: 'Open' }, effect: 'read' } });
    assert.deepEqual([flag(clicks().at(-1)!.args, '--x'), flag(clicks().at(-1)!.args, '--y')], [String(6000 + 600), String(50 + 400)]);
    await session.close({ keepWindow: true });
  });
});

test('the session resolves a semantic target to one index and keeps the accessibility method to the CLI', async () => {
  const { createSessionManager } = await import('../src/session.ts');
  await withDir(async (dir) => {
    const elements = [
      { index: 1, role: 'AXStaticText', label: '全部职位', frame: { x: 3155, y: 54, width: 52, height: 16 } },
      { index: 2, role: 'AXGroup', label: '', frame: { x: 3416, y: 56, width: 12, height: 12 } },
    ];
    const { run, calls } = fakeRunner({
      cli: async (args) => {
        switch (verb(args)) {
          case 'screen list':
            return { ok: true, screens: [{ ...SCREEN, ownerPID: process.pid }] };
          case 'state':
            return { ok: true, pid: 4242, windowID: 77, app: 'Synthetic', windowFrame: MAIN, elements };
          case 'ax-press':
            return { ok: true, route: 'ax.press.explicit' };
          default:
            return { ok: true };
        }
      },
      tools: { ...identityTools, lsappinfo: (args) => (args.includes('bundleID') ? { stdout: `"CFBundleIdentifier"="${BUNDLE}"` } : { stdout: '"pid"=4242' }) },
    });
    const adapter = createSecondScreenAdapter({ cli: 'cli', socket: SOCKET, run, screenshotDir: dir });
    const leases = {
      async acquireLease(r: { scopeKey: string; holder: 'runtime'; ownerPid: number; taskId?: string; ttlMs: number }) {
        return { scopeKey: r.scopeKey, holder: r.holder, ownerPid: r.ownerPid, taskId: r.taskId, leaseId: 'l', expiresAt: new Date(Date.now() + r.ttlMs).toISOString() };
      },
      async renewLease(id: string, ttl: number) {
        return { leaseId: id, scopeKey: `${BUNDLE}:*`, holder: 'runtime' as const, ownerPid: 1, expiresAt: new Date(Date.now() + ttl).toISOString() };
      },
      async releaseLease() {},
    };
    const session = await createSessionManager({ adapter, leases, policy: { submitAllowed: false, foregroundAllowed: false } }).open({ taskId: 't', profile, takeOver: false, leaseTtlMs: 60_000 });
    const r = await session.act({ actionId: 'x', action: { kind: 'click', target: { kind: 'element', role: 'AXGroup' }, method: 'accessibility', effect: 'navigation' } });
    assert.equal(r.status, 'ok');
    assert.equal(r.route, 'accessibility');
    const sent = calls.filter((c) => c.file === 'cli' && verb(c.args) !== 'state' && verb(c.args) !== 'screen list');
    assert.deepEqual(sent.map((c) => c.args[0]), ['ax-press']);
    assert.equal(flag(sent[0]!.args, '--index'), '2');
    // The session validates before anything is resolved: a point-only press never reaches the adapter.
    await assert.rejects(
      session.act({ actionId: 'y', action: { kind: 'click', target: { kind: 'relative', point: { x: 0.3, y: 0.04 } }, method: 'accessibility', effect: 'navigation' } }),
      (e) => isRuntimeError(e, 'invalid_input'),
    );
    assert.equal(calls.filter((c) => c.file === 'cli' && c.args[0] === 'ax-press').length, 1);
    await session.close({ keepWindow: true });
  });
});

test('createCommandRunner settles a stopped child only after it has exited, killing one that ignores SIGTERM', async () => {
  await withDir(async (dir) => {
    const pids = join(dir, 'pids');
    const run = createCommandRunner();
    const started = Date.now();
    // The shell and its background child both ignore SIGTERM.
    const pending = run('/bin/sh', ['-c', `trap "" TERM; sleep 30 & echo "$$ $!" > ${pids}; wait`], { timeoutMs: 200 });
    await assert.rejects(pending, (e) => isRuntimeError(e, 'timeout'));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_000, `settled after the SIGKILL grace, not at the abort (${elapsed} ms)`);
    assert.ok(elapsed < 5_000, `bounded (${elapsed} ms)`);
    const [shell, sleeper] = (await readFile(pids, 'utf8')).trim().split(' ').map(Number);
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of [shell!, sleeper!]) assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} is gone`);

    // A child that honours SIGTERM settles as soon as it has exited.
    const controller = new AbortController();
    const quick = run('/bin/sleep', ['30'], { timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const t = Date.now();
    await assert.rejects(quick, (e) => isRuntimeError(e, 'cancelled'));
    assert.ok(Date.now() - t < 1_500);
  });
});

// ---------------------------------------------------------------------------
// Spawn hooks: real child processes, nothing outside the scratch directory.

/** Whether any process is left in group `pgid`. */
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const waitGone = async (pgid: number) => {
  for (let i = 0; i < 50 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 50));
  return !groupAlive(pgid);
};

test('onSpawn reports the child pid as its group with times around the spawn, before the run settles, and onSettled once after close', async () => {
  const events: Array<[string, CommandSpawn]> = [];
  let clock = 1_000;
  const run = createCommandRunner({
    now: () => ++clock,
    onSpawn: (s) => void events.push(['spawn', { ...s }]),
    onSettled: (s) => void events.push(['settled', { ...s }]),
  });
  const pending = run('/bin/sh', ['-c', 'echo $$'], { timeoutMs: 5_000 });
  assert.deepEqual(events.map((e) => e[0]), ['spawn'], 'onSpawn ran before the runner returned its promise');
  const result = await pending;
  assert.equal(result.code, 0);
  assert.deepEqual(events.map((e) => e[0]), ['spawn', 'settled']);
  const spawn = events[0]![1];
  assert.deepEqual(spawn, { pid: Number(result.stdout.trim()), file: '/bin/sh', spawnedAfterMs: 1_001, spawnedBeforeMs: 1_002 });
  assert.deepEqual(events[1]![1], spawn);
  // Without hooks nothing changes.
  assert.equal((await createCommandRunner()('/bin/sh', ['-c', 'exit 3'], { timeoutMs: 5_000 })).code, 3);
});

test('a normal exit settles while a descendant is still in the group: settling says nothing about the group', async () => {
  let spawned: CommandSpawn | undefined;
  let aliveAtSettle: boolean | undefined;
  const run = createCommandRunner({ onSpawn: (s) => void (spawned = s), onSettled: (s) => void (aliveAtSettle = groupAlive(s.pid)) });
  const result = await run('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & exit 0'], { timeoutMs: 5_000 });
  assert.equal(result.code, 0);
  try {
    assert.equal(aliveAtSettle, true, 'the background sleep was still in the group when the run settled');
    assert.equal(groupAlive(spawned!.pid), true);
  } finally {
    process.kill(-spawned!.pid, 'SIGKILL');
  }
  assert.equal(await waitGone(spawned!.pid), true);
});

test('a failing onSpawn kills and reaps the whole group before rejecting', async () => {
  await withDir(async (dir) => {
    const pids = join(dir, 'pids');
    for (const fail of [() => { throw new Error('registry write failed'); }, () => Promise.resolve()] as Array<(s: CommandSpawn) => void>) {
      let spawned: CommandSpawn | undefined;
      const settled: CommandSpawn[] = [];
      const run = createCommandRunner({ onSpawn: (s) => { spawned = s; return fail(s); }, onSettled: (s) => void settled.push(s) });
      // A background descendant in the same group, and a leader that would run for 30 s.
      const started = Date.now();
      const pending = run('/bin/sh', ['-c', `sleep 30 >/dev/null 2>&1 & echo "$!" > ${pids}; sleep 30`], { timeoutMs: 20_000 });
      await assert.rejects(pending, (e) => isRuntimeError(e, 'io') && /onSpawn hook failed/.test(e.message) && e.details?.pgid === spawned!.pid);
      assert.ok(Date.now() - started < 2_000, 'killed at once, not after a grace');
      assert.equal(settled.length, 1, 'the reaped child is still reported settled');
      assert.equal(await waitGone(spawned!.pid), true, 'leader and descendant are both gone');
      await rm(pids, { force: true });
    }
  });
});

test('a program that never starts calls no hook, and a failing onSettled rejects instead of throwing unhandled', async () => {
  const calls: string[] = [];
  const hooks = { onSpawn: () => void calls.push('spawn'), onSettled: () => void calls.push('settled') };
  await assert.rejects(createCommandRunner(hooks)('/nonexistent/program', [], { timeoutMs: 1_000 }), (e) => isRuntimeError(e, 'capability_missing'));
  assert.deepEqual(calls, []);

  for (const fail of [() => { throw new Error('registry gone'); }, () => Promise.reject(new Error('async'))] as Array<() => void>) {
    const run = createCommandRunner({ onSettled: fail });
    await assert.rejects(run('/bin/sh', ['-c', 'exit 0'], { timeoutMs: 5_000 }), (e) => isRuntimeError(e, 'io') && /onSettled hook failed/.test(e.message));
  }
  // A timeout still stops the group and wins over a failing onSettled.
  const timed = createCommandRunner({ onSettled: () => { throw new Error('late'); } });
  await assert.rejects(timed('/bin/sleep', ['30'], { timeoutMs: 100 }), (e) => isRuntimeError(e, 'timeout'));
});
