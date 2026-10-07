// The desktop adapter: a thin, stateless wrapper around the 2ndscreen CLI,
// speaking to one side instance through its own control socket. It starts
// that side instance when it does not answer, keeps one agent screen at the
// profile's size, launches the app onto it or attaches to it, and reads and
// drives one window. It never resolves semantic locators (the Session does)
// and never retries an action.
//
// Ownership: an app already running off the
// screen is only moved there when the caller passes takeOver; the screen is
// created with the worker as its owner process and an idle timeout, so a
// crashed worker does not leave a screen behind forever.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RuntimeError,
  isRuntimeError,
  rectContains,
  relativeToGlobal,
  systemClock,
  throwIfAborted,
  type ActionRequest,
  type ActionResult,
  type AdapterCapabilities,
  type Clock,
  type CommandRunner,
  type DesktopAdapter,
  type InputRoute,
  type Locator,
  type Observation,
  type ObserveOptions,
  type Point,
  type Rect,
  type RuntimeErrorCode,
  type ScreenshotRef,
  type UIElement,
  type WindowBinding,
  type WindowGeometry,
  type WindowProfile,
} from '../contracts.ts';

export interface SecondScreenAdapterOptions {
  cli: string; // 2ndscreen 可执行文件
  socket: string; // side instance 的控制 socket（SECONDSCREEN_SOCKET）
  app?: string; // 用于启动 side instance 的 2ndscreen.app
  run: CommandRunner;
  screenshotDir: string; // 截图存放目录，由调用方清理
  clock?: Clock;
  commandTimeoutMs?: number; // 单条 CLI 命令上限，默认 15000
  /** Signals a process; default process.kill. Used only to end an app this adapter launched for a binding that failed. */
  signalProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
}

/** How long a new side instance may take to answer, and the app its main window. */
const INSTANCE_POLLS = 20;
const INSTANCE_POLL_MS = 500;
const MAIN_WINDOW_TIMEOUT_MS = 30_000;
/** One `app launch` may take this long before it counts as failed. */
const APP_LAUNCH_TIMEOUT_MS = 45_000;
const MAIN_WINDOW_POLL_MS = 500;
/** Screens outlive a quiet worker by this much; the owner pid ends them sooner on exit. */
const SCREEN_IDLE_TIMEOUT = '30m';
/**
 * A window narrower than this share of the screen is a splash or loading
 * window (P0: BOSS直聘 shows a 340x500 loading window, then replaces it).
 */
const MAIN_WINDOW_MIN_SHARE = 0.5;

const SCREEN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

interface CliReply {
  ok: boolean;
  json: Record<string, any>;
  error?: string;
}

interface ScreenRecord {
  name: string;
  kind?: string;
  displayID: number;
  width: number;
  height: number;
  hiDPI: boolean;
  frame: Rect;
  /** The process whose exit destroys the screen, if any. */
  ownerPID?: number;
}

/** Sorts a 2ndscreen error message into a runtime error code. */
export function classifyCliError(message: string): RuntimeErrorCode {
  if (/is not running|open 2ndscreen\.app/i.test(message)) return 'capability_missing';
  if (/Accessibility permission|Screen Recording permission/i.test(message)) return 'permission_missing';
  if (/no on-screen window|is not on screen|has no window on screen|has no matching|the window is on no screen/i.test(message))
    return 'window_lost';
  if (/no element \d+ in the window/i.test(message)) return 'snapshot_stale';
  if (/no element matches|no agent screen named|no app at/i.test(message)) return 'not_found';
  if (/outside the window|needs --|takes a|give /i.test(message)) return 'invalid_input';
  if (/already exists|already running/i.test(message)) return 'conflict';
  return 'io';
}

/** The route the CLI reports for `ax-press`; anything else is not an explicit press. */
export const EXPLICIT_PRESS_ROUTE = 'ax.press.explicit';

/**
 * An `ax-press` refusal. A CLI or side instance that predates it stops with
 * an unknown command or a request it cannot decode, before any input; an
 * element without AXPress is the host's limit too. Both are capability_missing.
 */
export function classifyPressError(message: string): RuntimeErrorCode {
  if (/^unknown command|bad request:|does not advertise AXPress/i.test(message.trim())) return 'capability_missing';
  return classifyCliError(message);
}

const cliError = (what: string, reply: CliReply, details?: Record<string, unknown>) => {
  const message = reply.error ?? 'failed';
  return new RuntimeError(classifyCliError(message), `${what}: ${message}`, details);
};

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

const toRect = (raw: any): Rect | undefined =>
  raw && [raw.x, raw.y, raw.width, raw.height].every((v) => typeof v === 'number' && Number.isFinite(v))
    ? { x: raw.x, y: raw.y, width: raw.width, height: raw.height }
    : undefined;

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Points a window may overhang its screen by rounding alone. */
const CONTAIN_SLACK = 1;

/** Whether `inner` lies within `outer`, up to rounding. A window below the menu bar is within its screen. */
export function rectWithin(inner: Rect, outer: Rect, slack = CONTAIN_SLACK): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack
    && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
}

/**
 * Whether a screenshot of `frame` at `scale` pixels per point shows all of
 * it. The CLI crops a screen capture to the window and clips the crop to the
 * screen, so a window reaching past its screen gives a smaller image (P0:
 * 913x1102 pane rasters where 1468x1750 were expected); stretched over the
 * whole frame it would map every point wrong. The crop rounds outwards to
 * whole pixels, so one pixel either way is allowed.
 */
export function rasterCoversFrame(size: { width: number; height: number }, frame: Rect, scale: number): boolean {
  return Math.abs(size.width - frame.width * scale) <= 1 && Math.abs(size.height - frame.height * scale) <= 1;
}

const describeRect = (r: Rect) => `${r.x},${r.y} ${r.width}x${r.height}`;

/** Refits a protruding window at most this many times before binding fails. */
const REFIT_ATTEMPTS = 2;

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = '89504e470d0a1a0a';
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature || bytes.subarray(12, 16).toString('latin1') !== 'IHDR')
    throw new RuntimeError('io', 'the screenshot is not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** `ps -o lstart=` output ("Thu Sep 17 21:55:13 2026") as ISO 8601, or the raw text if it does not parse. */
export function parseProcessStart(text: string): string | undefined {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}

export function createSecondScreenAdapter(options: SecondScreenAdapterOptions): DesktopAdapter {
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.commandTimeoutMs ?? 15_000;
  const env = { SECONDSCREEN_SOCKET: options.socket };

  /** One 2ndscreen command on this adapter's socket. Cancellation and timeouts reject. */
  async function cli(words: string[], signal?: AbortSignal, limitMs: number = timeoutMs): Promise<CliReply> {
    throwIfAborted(signal);
    const result = await options.run(options.cli, words, { env, timeoutMs: limitMs, signal });
    let json: Record<string, any> | undefined;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, any>;
    } catch {
      // Usage text and plain errors arrive on stderr; reported below.
    }
    if (!json) return { ok: false, json: {}, error: (result.stderr || result.stdout || `exit ${result.code}`).trim() };
    const ok = json.ok === true && result.code === 0;
    return { ok, json, error: ok ? undefined : String(json.error ?? (result.stderr.trim() || `exit ${result.code}`)) };
  }

  async function tool(file: string, args: string[], signal?: AbortSignal) {
    throwIfAborted(signal);
    return options.run(file, args, { env: { LC_ALL: 'C' }, timeoutMs, signal });
  }

  async function screens(signal?: AbortSignal): Promise<ScreenRecord[]> {
    const reply = await cli(['screen', 'list'], signal);
    if (!reply.ok) throw cliError('screen list', reply);
    return (Array.isArray(reply.json.screens) ? reply.json.screens : []).flatMap((s: any): ScreenRecord[] => {
      const frame = toRect(s?.frame);
      return frame && typeof s.name === 'string'
        ? [{ name: s.name, kind: s.kind, displayID: Number(s.displayID), width: Number(s.width), height: Number(s.height), hiDPI: !!s.hiDPI, frame, ownerPID: Number.isInteger(s.ownerPID) ? s.ownerPID : undefined }]
        : [];
    });
  }

  async function screen(name: string, signal?: AbortSignal): Promise<ScreenRecord> {
    const found = (await screens(signal)).find((s) => s.name === name);
    if (!found) throw new RuntimeError('window_lost', `no agent screen named ${name}`, { screenId: name });
    return found;
  }

  /** The side instance answers, starting it from options.app if it does not. */
  async function instance(signal?: AbortSignal): Promise<void> {
    const first = await cli(['screen', 'list'], signal);
    if (first.ok) return;
    if (classifyCliError(first.error ?? '') !== 'capability_missing') throw cliError('screen list', first);
    if (!options.app) throw new RuntimeError('capability_missing', `no 2ndscreen side instance answers on ${options.socket}, and no app to start one`);
    const opened = await tool('open', ['-g', '-n', '--env', `SECONDSCREEN_SOCKET=${options.socket}`, options.app], signal);
    if (opened.code !== 0) throw new RuntimeError('capability_missing', `cannot start 2ndscreen: ${(opened.stderr || opened.stdout).trim()}`);
    for (let attempt = 0; attempt < INSTANCE_POLLS; attempt++) {
      await delay(INSTANCE_POLL_MS, signal);
      if ((await cli(['screen', 'list'], signal)).ok) return;
    }
    throw new RuntimeError('timeout', 'the 2ndscreen side instance did not start');
  }

  async function runningPid(bundleId: string, signal?: AbortSignal): Promise<number | undefined> {
    const out = await tool('lsappinfo', ['info', '-only', 'pid', '-app', bundleId], signal);
    const match = /"pid"\s*=\s*(\d+)/.exec(out.stdout);
    return match ? Number(match[1]) : undefined;
  }

  /** Bundle id and start time of a pid, read fresh: a pid alone is never an identity. */
  async function identity(pid: number, signal?: AbortSignal): Promise<{ bundleId?: string; startedAt?: string }> {
    const info = await tool('lsappinfo', ['info', '-only', 'bundleID', String(pid)], signal);
    const bundleId = /"CFBundleIdentifier"\s*=\s*"([^"]+)"/.exec(info.stdout)?.[1];
    const ps = await tool('ps', ['-o', 'lstart=', '-p', String(pid)], signal);
    return { bundleId, startedAt: ps.code === 0 ? parseProcessStart(ps.stdout) : undefined };
  }

  /**
   * Refuses unless the bound pid is still the same app process: same bundle
   * and the same start time. A binding without a start time proves nothing,
   * and a recycled pid shows a different one.
   */
  async function sameProcess(binding: WindowBinding, signal?: AbortSignal): Promise<RuntimeError | undefined> {
    const { pid, bundleId, processStartedAt } = binding.window;
    if (!processStartedAt) return new RuntimeError('window_lost', `pid ${pid} has no recorded start time, so it cannot be told from a recycled pid`, { pid });
    const now = await identity(pid, signal);
    if (now.bundleId !== bundleId || now.startedAt !== processStartedAt)
      return new RuntimeError('window_lost', `pid ${pid} is no longer the bound ${bundleId} process`, { pid, bundleId: now.bundleId, processStartedAt: now.startedAt });
    return undefined;
  }

  function windowOf(reply: CliReply): { pid: number; windowId: number; frame: Rect } | undefined {
    const frame = toRect(reply.json.windowFrame);
    const pid = Number(reply.json.pid);
    const windowId = Number(reply.json.windowID);
    return frame && Number.isInteger(pid) && Number.isInteger(windowId) ? { pid, windowId, frame } : undefined;
  }

  /** Waits until the app shows one wide-enough window that holds still for two reads. */
  async function mainWindow(screenId: string, pid: number, profile: WindowProfile, signal?: AbortSignal) {
    const deadline = Date.now() + MAIN_WINDOW_TIMEOUT_MS;
    let last: { windowId: number; frame: Rect } | undefined;
    let lastError = 'no window yet';
    while (Date.now() < deadline) {
      const reply = await cli(['state', '--screen', screenId, '--pid', String(pid)], signal);
      const window = reply.ok ? windowOf(reply) : undefined;
      if (window && window.frame.width >= (profile.mainWindowMinWidth ?? profile.logicalWidth * MAIN_WINDOW_MIN_SHARE)) {
        if (last && last.windowId === window.windowId && sameRect(last.frame, window.frame)) return { ...window, title: String(reply.json.app ?? '') };
        last = window;
      } else {
        last = undefined;
        lastError = reply.ok ? 'only a loading window' : (reply.error ?? 'state failed');
      }
      await delay(MAIN_WINDOW_POLL_MS, signal);
    }
    throw new RuntimeError('timeout', `the app's main window did not settle on ${screenId}: ${lastError}`, { pid });
  }

  function geometry(
    window: { pid: number; windowId: number; frame: Rect; title: string },
    bundleId: string,
    startedAt: string | undefined,
    where: ScreenRecord,
  ): WindowGeometry {
    return {
      pid: window.pid,
      windowId: window.windowId,
      processStartedAt: startedAt,
      bundleId,
      title: window.title,
      frame: window.frame,
      // The CLI reports no content area; the whole frame stands in for it.
      contentFrame: window.frame,
      scale: where.hiDPI ? 2 : 1,
      displayId: where.displayID,
    };
  }

  async function screenshotRef(path: string, covers: Rect): Promise<ScreenshotRef> {
    const bytes = await readFile(path);
    const size = pngSize(bytes);
    return { path, widthPx: size.width, heightPx: size.height, covers, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  /** Crops a window shot to a global rect, in the image's own measured scale. */
  async function crop(shot: ScreenshotRef, region: Rect, signal?: AbortSignal): Promise<ScreenshotRef> {
    const c = shot.covers;
    const x0 = Math.max(region.x, c.x);
    const y0 = Math.max(region.y, c.y);
    const x1 = Math.min(region.x + region.width, c.x + c.width);
    const y1 = Math.min(region.y + region.height, c.y + c.height);
    if (x1 <= x0 || y1 <= y0) throw new RuntimeError('invalid_input', 'the screenshot region lies outside the window');
    const sx = shot.widthPx / c.width;
    const sy = shot.heightPx / c.height;
    const px = Math.round((x0 - c.x) * sx);
    const py = Math.round((y0 - c.y) * sy);
    const pw = Math.max(1, Math.min(shot.widthPx - px, Math.round((x1 - x0) * sx)));
    const ph = Math.max(1, Math.min(shot.heightPx - py, Math.round((y1 - y0) * sy)));
    const out = shot.path.replace(/\.png$/, '-region.png');
    const result = await tool('sips', ['-c', String(ph), String(pw), '--cropOffset', String(py), String(px), shot.path, '--out', out], signal);
    if (result.code !== 0) throw new RuntimeError('io', `cannot crop the screenshot: ${(result.stderr || result.stdout).trim()}`);
    await rm(shot.path, { force: true });
    // Covers what the pixels really show after rounding.
    return screenshotRef(out, { x: c.x + px / sx, y: c.y + py / sy, width: pw / sx, height: ph / sy });
  }

  function targetArgs(binding: WindowBinding, target: Locator | undefined): { args: string[]; route?: InputRoute; point?: Point; error?: string } {
    if (!target) return { args: [] };
    if (target.kind === 'element' && target.index !== undefined) return { args: ['--index', String(target.index)], route: 'element' };
    if (target.kind === 'relative') {
      const point = relativeToGlobal(binding.window, target.point);
      if (!rectContains(binding.window.frame, point)) return { args: [], error: 'the point is outside the window' };
      return { args: ['--x', String(point.x), '--y', String(point.y)], route: 'coordinate', point };
    }
    return { args: [], error: `the adapter takes element indexes and relative points; the session resolves ${target.kind} locators` };
  }

  /**
   * Binds the app's main window on the screen. `launchedApp` is filled in
   * the moment this call launches the app, so a failure after that can end it.
   */
  async function bindAppOnce(
    screenId: string,
    profile: WindowProfile,
    bindOptions: { takeOver: boolean },
    signal: AbortSignal | undefined,
    launchedApp: { pid?: number; who?: { bundleId?: string; startedAt?: string } },
  ): Promise<WindowBinding> {
    // The screen must exist before anything is launched or moved; its frame is read again below.
    await screen(screenId, signal);
    const running = await runningPid(profile.bundleId, signal);
    let pid: number;
    let launched = false;
    if (running === undefined) {
      const launchBegan = Date.now();
      let reply: CliReply | undefined;
      let launchError: unknown;
      try {
        // Launching is slow (a fresh side instance, an app's own loading): more room than other commands.
        reply = await cli(['app', 'launch', '--screen', screenId, '--bundle', profile.bundleId, '--fill'], signal, Math.max(timeoutMs, APP_LAUNCH_TIMEOUT_MS));
      } catch (error) {
        launchError = error;
      }
      if (launchError !== undefined || !reply!.ok) {
        // A launch can start the app and then fail to place its window. An app that was not running
        // before and started since this launch began is this launch's, and is ended with the binding.
        // Looked up without the signal: a cancelled launch must still be cleaned up.
        const started = await runningPid(profile.bundleId).catch(() => undefined);
        if (started !== undefined) {
          const who = await identity(started).catch(() => undefined);
          if (who?.startedAt !== undefined && Date.parse(who.startedAt) >= launchBegan - 2000) {
            launchedApp.pid = started;
            launchedApp.who = who;
          }
        }
        throw launchError ?? cliError(`cannot launch ${profile.bundleId}`, reply!);
      }
      pid = Number(reply!.json.pid);
      if (!Number.isInteger(pid)) throw new RuntimeError('io', 'app launch reported no pid');
      launched = true;
      launchedApp.pid = pid;
      launchedApp.who = await identity(pid, signal).catch(() => undefined);
    } else {
      pid = running;
      const onScreen = await cli(['state', '--screen', screenId, '--pid', String(pid)], signal);
      if (!onScreen.ok) {
        if (classifyCliError(onScreen.error ?? '') !== 'window_lost') throw cliError('cannot read the app window', onScreen);
        if (!bindOptions.takeOver) {
          const who = await identity(pid, signal);
          throw new RuntimeError('conflict', `${profile.bundleId} (pid ${pid}) is running off screen ${screenId} and was not handed over; pass takeOver to use it`, {
            pid,
            processStartedAt: who.startedAt,
            bundleId: who.bundleId,
          });
        }
        const moved = await cli(['window', 'move', '--screen', screenId, '--pid', String(pid), '--fill'], signal);
        if (!moved.ok) throw cliError(`cannot move ${profile.bundleId} onto ${screenId}`, moved);
      }
    }
    let window = await mainWindow(screenId, pid, profile, signal);
    // The window counts as on its screen when its center is; it must lie wholly within it, or
    // screenshots are clipped and coordinates drift. Read the screen again: displays move.
    let current = await screen(screenId, signal);
    for (let refits = 0; !rectWithin(window.frame, current.frame); refits++) {
      const details = { pid, windowId: window.windowId, frame: window.frame, screenFrame: current.frame };
      // Resizing a window the runtime neither launched nor was handed would rearrange the user's app.
      if (!launched && !bindOptions.takeOver)
        throw new RuntimeError('conflict', `${profile.bundleId} (pid ${pid}) reaches past screen ${screenId} (window ${describeRect(window.frame)}, screen ${describeRect(current.frame)}) and was not handed over; pass takeOver to refit it`, details);
      if (refits >= REFIT_ATTEMPTS)
        throw new RuntimeError('conflict', `${profile.bundleId} (pid ${pid}) still reaches past screen ${screenId} after ${REFIT_ATTEMPTS} refits (window ${describeRect(window.frame)}, screen ${describeRect(current.frame)})`, details);
      const refit = await cli(['window', 'move', '--screen', screenId, '--pid', String(pid), '--window-id', String(window.windowId), '--fill'], signal);
      if (!refit.ok) throw cliError(`cannot fit ${profile.bundleId} onto ${screenId}`, refit, details);
      window = await mainWindow(screenId, pid, profile, signal);
      current = await screen(screenId, signal);
    }
    const who = await identity(pid, signal);
    if (who.bundleId !== profile.bundleId)
      throw new RuntimeError('conflict', `pid ${pid} is ${who.bundleId ?? 'not an app'}, not ${profile.bundleId}`, { pid });
    return { screenId, socket: options.socket, window: geometry(window, profile.bundleId, who.startedAt, current), launchedByRuntime: launched };
  }

  /**
   * Ends an app this adapter launched for a binding that then failed. Left
   * running, its window would be moved onto the user's displays when the
   * agent screen goes away. It is asked to quit first (`app quit`); only one
   * that stays is signalled. Only the very process launched is touched:
   * same bundle, same start time.
   */
  async function endLaunched(launchedApp: { pid?: number; who?: { bundleId?: string; startedAt?: string } }, bundleId: string): Promise<void> {
    const { pid, who } = launchedApp;
    if (pid === undefined || !who?.startedAt || who.bundleId !== bundleId) return;
    const same = async () => {
      const now = await identity(pid).catch(() => undefined);
      return now?.bundleId === bundleId && now.startedAt === who.startedAt;
    };
    // Asked first, as ⌘Q would: some apps (BOSS直聘) take SIGTERM for a crash and relaunch themselves
    // onto the user's display. Signals only for an app that will not quit.
    if (!(await same())) return;
    await cli(['app', 'quit', '--pid', String(pid), '--bundle', bundleId, '--wait', '10'], undefined, 20_000).catch(() => undefined);
    for (const name of ['SIGTERM', 'SIGKILL'] as const) {
      if (!(await same())) return;
      try {
        (options.signalProcess ?? ((p: number, n: 'SIGTERM' | 'SIGKILL') => void process.kill(p, n)))(pid, name);
      } catch {
        return;
      }
      for (let i = 0; i < 20 && (await same()); i++) await delay(150);
    }
  }

  return {
    async capabilities(signal) {
      const list = await screens(signal);
      let version = 'unknown';
      if (options.app) {
        const read = await tool('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(options.app, 'Contents/Info.plist')], signal);
        if (read.code === 0 && read.stdout.trim()) version = read.stdout.trim();
      }
      // Only read-only probes. Screen Recording is shown by capturing an
      // existing agent screen into a scratch file. The CLI has no read-only
      // check for Accessibility, so it is reported false: unverified, not
      // refused. Without an agent screen both are unverified.
      const agent = list.find((s) => s.kind === 'agent');
      const accessibilityPermission = false;
      let screenRecordingPermission = false;
      if (agent) {
        const path = join(options.screenshotDir, `probe-${randomUUID()}.png`);
        try {
          screenRecordingPermission = (await cli(['screenshot', '--screen', agent.name, '--output', path], signal)).ok;
        } finally {
          await rm(path, { force: true });
        }
      }
      const result: AdapterCapabilities = {
        version,
        // P0 (docs/boss-macos-capabilities.md): background element/coordinate
        // clicks and wheel scrolls were verified on BOSS直聘; typing was not.
        backgroundClick: true,
        backgroundScroll: true,
        backgroundType: false,
        screenshot: screenRecordingPermission,
        accessibility: accessibilityPermission,
        screenRecordingPermission,
        accessibilityPermission,
      };
      return result;
    },

    async ensureScreen(profile, signal) {
      if (!SCREEN_NAME.test(profile.id)) throw new RuntimeError('invalid_input', `profile id ${profile.id} cannot name a screen`);
      await instance(signal);
      const existing = (await screens(signal)).find((s) => s.name === profile.id);
      const size = `${profile.logicalWidth}x${profile.logicalHeight}`;
      if (!existing) {
        const created = await cli(
          ['screen', 'create', '--name', profile.id, '--size', size, '--idle-timeout', SCREEN_IDLE_TIMEOUT, '--owner-pid', String(process.pid)],
          signal,
        );
        if (!created.ok) throw cliError('cannot create the agent screen', created);
      } else if (existing.width !== profile.logicalWidth || existing.height !== profile.logicalHeight) {
        // Only a screen this worker owns may be resized; anyone else's is left as it is.
        if (existing.ownerPID !== process.pid)
          throw new RuntimeError('conflict', `screen ${profile.id} is ${existing.width}x${existing.height}, not ${size}, and belongs to ${existing.ownerPID === undefined ? 'no owner process' : `pid ${existing.ownerPID}`}`, {
            screenId: profile.id,
            ownerPid: existing.ownerPID,
          });
        const resized = await cli(['screen', 'resize', profile.id, '--size', size], signal);
        if (!resized.ok) {
          const error = cliError(`screen ${profile.id} is ${existing.width}x${existing.height}, not ${size}`, resized);
          throw new RuntimeError('conflict', error.message);
        }
      }
      return { screenId: profile.id, socket: options.socket };
    },

    async bindApp(screenId, profile, bindOptions, signal) {
      const launchedApp: { pid?: number; who?: { bundleId?: string; startedAt?: string } } = {};
      try {
        return await bindAppOnce(screenId, profile, bindOptions, signal, launchedApp);
      } catch (error) {
        await endLaunched(launchedApp, profile.bundleId).catch(() => undefined);
        throw error;
      }
    },

    async observe(binding, observeOptions: ObserveOptions, signal) {
      const snapshotId = randomUUID();
      const takenAt = clock.now().toISOString();
      const shotPath = observeOptions.screenshot ? join(options.screenshotDir, `${snapshotId}.png`) : undefined;
      const words = ['state', '--screen', binding.screenId, '--pid', String(binding.window.pid), '--window-id', String(binding.window.windowId)];
      if (shotPath) words.push('--screenshot', shotPath);
      const reply = await cli(words, signal);
      if (!reply.ok) throw cliError('cannot read the window', reply, { windowId: binding.window.windowId });
      const read = windowOf(reply);
      if (!read || read.pid !== binding.window.pid || read.windowId !== binding.window.windowId)
        throw new RuntimeError('window_lost', 'the window read back is not the bound window', { windowId: binding.window.windowId });
      const window: WindowGeometry = { ...binding.window, frame: read.frame, contentFrame: read.frame };
      const raw: any[] = Array.isArray(reply.json.elements) ? reply.json.elements : [];
      const text = raw
        .flatMap((e) => [e?.label, e?.value])
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .join('\n');
      const observation: Observation = { snapshotId, sessionId: '', takenAt, window, text };
      if (observeOptions.elements !== false) {
        observation.elements = raw
          .filter((e) => Number.isInteger(e?.index) && e.index >= 0 && typeof e.role === 'string')
          .map((e): UIElement => {
            const element: UIElement = { index: e.index, role: e.role };
            if (typeof e.label === 'string') element.label = e.label;
            if (typeof e.value === 'string') element.value = e.value;
            const frame = toRect(e.frame);
            if (frame) element.frame = frame;
            return element;
          });
      }
      if (shotPath) {
        const shot = await screenshotRef(typeof reply.json.screenshot === 'string' ? reply.json.screenshot : shotPath, read.frame);
        // A screenshot stands for the whole window only if the window lies wholly within its screen
        // as the screen is now (displays move), and the image is the frame at the bound scale.
        // Otherwise it is clipped: say where the window went instead of stretching it over the frame.
        const where = (await screens(signal)).find((s) => s.name === binding.screenId);
        const inside = where !== undefined && rectWithin(read.frame, where.frame);
        if (!inside || !rasterCoversFrame({ width: shot.widthPx, height: shot.heightPx }, read.frame, binding.window.scale)) {
          await rm(shot.path, { force: true });
          const why = !where ? `screen ${binding.screenId} is gone`
            : !inside ? `the window ${describeRect(read.frame)} reaches past screen ${binding.screenId} (${describeRect(where.frame)})`
            : `the screenshot is ${shot.widthPx}x${shot.heightPx} px, not the whole window ${describeRect(read.frame)} at ${binding.window.scale}x`;
          throw new RuntimeError('window_lost', `${why}; no screenshot is reported for it`, {
            windowId: binding.window.windowId,
            frame: read.frame,
            screenFrame: where?.frame,
          });
        }
        observation.screenshot = observeOptions.region ? await crop(shot, observeOptions.region, signal) : shot;
      }
      return observation;
    },

    async act(binding, request, signal) {
      throwIfAborted(signal);
      const startedAt = clock.now().toISOString();
      const action = request.action;
      const failed = (code: RuntimeErrorCode, message: string): ActionResult => ({
        actionId: request.actionId,
        status: code === 'snapshot_stale' ? 'stale_snapshot' : 'failed',
        startedAt,
        finishedAt: clock.now().toISOString(),
        error: { code, message },
      });
      const target = targetArgs(binding, action.kind === 'key' ? undefined : action.target);
      if (target.error) return failed('invalid_input', target.error);
      // An explicit accessibility press takes one element of the current snapshot, nothing else.
      const explicit = action.kind === 'click' && action.method !== undefined;
      if (explicit) {
        if (action.method !== 'accessibility') return failed('invalid_input', `click method ${String(action.method)} is not supported`);
        if (target.route !== 'element') return failed('invalid_input', 'an accessibility press needs an element index; points are not pressed');
        if ((action.button ?? 'left') !== 'left' || (action.count ?? 1) !== 1) return failed('invalid_input', 'an accessibility press is one plain press');
      }
      const replaced = await sameProcess(binding, signal);
      if (replaced) return failed(replaced.code, replaced.message);
      const verb = explicit ? 'ax-press' : action.kind;
      const words = [verb, '--screen', binding.screenId, '--pid', String(binding.window.pid), '--window-id', String(binding.window.windowId)];
      let route = explicit ? ('accessibility' as const) : target.route;
      switch (action.kind) {
        case 'click':
          if (explicit) break;
          if (action.button === 'right') words.push('--right');
          if (action.count === 2) words.push('--double');
          break;
        case 'type':
          words.push('--value', action.value);
          if (action.replace) words.push('--replace');
          route ??= 'keyboard';
          break;
        case 'key':
          words.push('--key', action.key);
          if (action.modifiers?.length) words.push('--modifiers', action.modifiers.join(','));
          route = 'keyboard';
          break;
        case 'scroll':
          words.push('--direction', action.direction);
          if (action.amount !== undefined) words.push('--amount', String(action.amount));
          if (action.by) words.push('--by', action.by);
          route ??= 'coordinate';
          break;
      }
      words.push(...target.args);
      let reply: CliReply;
      try {
        reply = await cli(words, signal);
      } catch (error) {
        // The command may have delivered the event before it was stopped.
        if (isRuntimeError(error, 'cancelled') || isRuntimeError(error, 'timeout'))
          return { actionId: request.actionId, status: 'unknown', route, point: target.point, startedAt, finishedAt: clock.now().toISOString(), error: { code: error.code, message: error.message } };
        throw error;
      }
      if (!reply.ok) {
        const code = (explicit ? classifyPressError : classifyCliError)(reply.error ?? '');
        return { ...failed(code, reply.error ?? 'failed'), route, point: target.point };
      }
      if (explicit && reply.json.route !== EXPLICIT_PRESS_ROUTE)
        // Something answered ok without saying it pressed through accessibility: what it did cannot be told.
        return { actionId: request.actionId, status: 'unknown', route, startedAt, finishedAt: clock.now().toISOString(), error: { code: 'capability_missing', message: `ax-press answered with route ${String(reply.json.route ?? 'none')}, not ${EXPLICIT_PRESS_ROUTE}` } };
      return { actionId: request.actionId, status: 'ok', route, point: target.point, startedAt, finishedAt: clock.now().toISOString() };
    },

    async quitApp(binding) {
      if (!binding.launchedByRuntime) throw new RuntimeError('conflict', 'only an app the runtime launched is quit');
      await endLaunched({ pid: binding.window.pid, who: { bundleId: binding.window.bundleId, ...(binding.window.processStartedAt && { startedAt: binding.window.processStartedAt }) } }, binding.window.bundleId);
    },

    async releaseWindow(binding, signal) {
      // Never move a window of a process that merely reuses the pid.
      const replaced = await sameProcess(binding, signal);
      if (replaced) throw replaced;
      const reply = await cli(['window', 'release', '--screen', binding.screenId, '--pid', String(binding.window.pid), '--window-id', String(binding.window.windowId)], signal);
      // A window that is already gone needs no release.
      if (!reply.ok && classifyCliError(reply.error ?? '') !== 'window_lost') throw cliError('cannot release the window', reply);
    },
  };
}

/** How long a stopped child gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * One child the runner started. It leads its own process group, so the
 * group id is `pid`. Times are from `now` (default Date.now), taken right
 * around the spawn: the child started after `spawnedAfterMs` and before
 * `spawnedBeforeMs`.
 */
export interface CommandSpawn {
  pid: number;
  file: string;
  spawnedAfterMs: number;
  spawnedBeforeMs: number;
}

/**
 * Optional hooks for a caller that accounts for every process group it
 * starts (A7's registry announces before calling the runner). Both run
 * synchronously; a hook that returns a promise counts as having failed.
 *
 * - `onSpawn`: as soon as the child has a pid, before the run's promise is
 *   returned. If it fails, the whole group is killed (SIGKILL), the child
 *   is reaped, and the run rejects with io; the caller's announcement
 *   stays unresolved. Not called when the program never started.
 * - `onSettled`: once, after the child has closed and before the run
 *   settles. The child's exit says nothing about descendants left in its
 *   group. If it fails, the run rejects with io (an earlier failure wins).
 *
 * Without hooks the runner behaves exactly as before.
 */
export interface CommandRunnerOptions {
  onSpawn?: (spawn: CommandSpawn) => void;
  onSettled?: (spawn: CommandSpawn) => void;
  now?: () => number;
}

/** Call a hook; returns its failure, if any. A promise returned is a failure: hooks are synchronous. */
function callHook(hook: ((spawn: CommandSpawn) => void) | undefined, spawn: CommandSpawn): Error | undefined {
  if (!hook) return undefined;
  try {
    const returned: unknown = hook(spawn);
    if (returned && typeof (returned as { then?: unknown }).then === 'function') {
      (returned as Promise<unknown>).then(undefined, () => undefined);
      return new Error('the hook returned a promise; spawn hooks must be synchronous');
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Runs a program to completion. Non-zero exits resolve with their code. On
 * abort or timeout it sends SIGTERM to the child's whole process group, then
 * SIGKILL after a bounded grace, and settles only once the child has exited.
 * See CommandRunnerOptions for the spawn hooks.
 */
export function createCommandRunner(runnerOptions: CommandRunnerOptions = {}): CommandRunner {
  const { onSpawn, onSettled } = runnerOptions;
  const now = runnerOptions.now ?? Date.now;
  return (file, args, options) =>
    new Promise((resolve, reject) => {
      throwIfAborted(options.signal);
      const hookError = (which: string, error: Error, spawned: CommandSpawn) =>
        new RuntimeError('io', `${file}: the ${which} hook failed: ${error.message}`, { pid: spawned.pid, pgid: spawned.pid });
      const spawnedAfterMs = now();
      // Its own process group, so a stop also reaches anything it started.
      const child = spawn(file, [...args], { env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const spawnedBeforeMs = now();
      const spawned: CommandSpawn | undefined = child.pid !== undefined ? { pid: child.pid, file, spawnedAfterMs, spawnedBeforeMs } : undefined;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      let stopped: RuntimeError | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let killing: ReturnType<typeof setInterval> | undefined;
      const signalGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      };
      const stop = (reason: RuntimeError) => {
        if (stopped) return;
        stopped = reason;
        signalGroup('SIGTERM');
        escalation = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => stop(new RuntimeError('timeout', `${file} took longer than ${options.timeoutMs} ms`)), options.timeoutMs);
      const onAbort = () => stop(new RuntimeError('cancelled', `${file} was cancelled`));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const settle = () => {
        clearTimeout(timer);
        clearTimeout(escalation);
        clearInterval(killing);
        options.signal?.removeEventListener('abort', onAbort);
      };
      if (spawned) {
        const failed = callHook(onSpawn, spawned);
        if (failed) {
          // Not accounted for: kill the whole group at once; the close below reaps it and rejects.
          // The child may not lead its group yet this early (it calls setsid after the fork), so
          // the kill is repeated until it has closed.
          stopped = hookError('onSpawn', failed, spawned);
          signalGroup('SIGKILL');
          killing = setInterval(() => signalGroup('SIGKILL'), 20);
        }
      }
      child.once('error', (error: NodeJS.ErrnoException) => {
        // Only a child that never started settles here; a running one settles on close.
        if (child.pid !== undefined) return;
        settle();
        reject(error.code === 'ENOENT' ? new RuntimeError('capability_missing', `${file} is not installed`) : new RuntimeError('io', `${file}: ${error.message}`));
      });
      child.once('close', (code) => {
        settle();
        if (spawned) {
          const failed = callHook(onSettled, spawned);
          if (failed && !stopped) stopped = hookError('onSettled', failed, spawned);
        }
        if (stopped) return reject(stopped);
        resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
    });
}
