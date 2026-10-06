// Keeps the assistant's surroundings in place: a 2ndscreen side instance on
// its own socket, so other users of 2ndscreen restarting theirs do not take
// its screen away; an agent screen on it; and WeChat's main window on that
// screen.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WECHAT_BUNDLE } from './front.ts';
import { sleep } from './screen.ts';
import type { Store } from './store.ts';

const repo = resolve(import.meta.dirname, '../../..');

export interface SetupOptions {
  screen: string;
  /** The side instance's control socket. */
  socket: string;
  /** The 2ndscreen app to start the side instance from. */
  app: string;
  /** The 2ndscreen command. */
  cli: string;
  /** Move a WeChat this assistant did not launch onto its screen. */
  takeOver: boolean;
  log: (line: string) => void;
}

export function defaults(screen = 'wechat'): Omit<SetupOptions, 'takeOver' | 'log'> {
  const built = join(repo, '.build/release/2ndscreen');
  return {
    screen,
    socket: process.env.SECONDSCREEN_SOCKET || join(homedir(), 'Library/Caches/2ndscreen/wechat.sock'),
    app: process.env.SECONDSCREEN_APP || join(repo, 'build/2ndscreen.app'),
    cli: process.env.SECONDSCREEN_CLI || (existsSync(built) ? built : '2ndscreen'),
  };
}

/** Where WeChat stands, and what to do about it. Pure, for testing. */
export type Plan =
  | { do: 'launch' }
  | { do: 'ready'; pid: number }
  | { do: 'move'; pid: number }
  | { do: 'wait'; reason: string };

export function planWeChat(running: number | undefined, onScreen: boolean, ours: number | undefined, takeOver: boolean): Plan {
  if (running === undefined) return { do: 'launch' };
  if (onScreen) return { do: 'ready', pid: running };
  // Off the screen: the screen was rebuilt, or this is the user's own WeChat.
  if (running === ours || takeOver) return { do: 'move', pid: running };
  return { do: 'wait', reason: `WeChat (pid ${running}) is running on your own display; pass --take-over to move its window onto the agent screen (it goes back with --release)` };
}

export class Setup {
  constructor(readonly options: SetupOptions, readonly store: Store) {}

  run(words: string[]): Promise<Record<string, any>> {
    return new Promise((resolveRun) => {
      execFile(this.options.cli, words, { env: { ...process.env, SECONDSCREEN_SOCKET: this.options.socket } },
        (error, stdout, stderr) => {
          try {
            resolveRun(JSON.parse(stdout));
          } catch {
            resolveRun({ ok: false, error: (stderr || stdout || String(error)).trim() });
          }
        });
    });
  }

  /** The side instance answers, starting it if it does not. */
  private async instance(): Promise<void> {
    if ((await this.run(['screen', 'list'])).ok) return;
    if (!existsSync(this.options.app)) throw new Error(`no 2ndscreen app at ${this.options.app}; build it or set SECONDSCREEN_APP`);
    this.options.log('starting a 2ndscreen side instance');
    await new Promise<void>((done, fail) => execFile('open',
      ['-g', '-n', '--env', `SECONDSCREEN_SOCKET=${this.options.socket}`, this.options.app],
      (error) => (error ? fail(error) : done())));
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(500);
      if ((await this.run(['screen', 'list'])).ok) return;
    }
    throw new Error('the 2ndscreen side instance did not start');
  }

  /** The agent screen exists, creating it if not. It does not expire. */
  private async screen(): Promise<void> {
    const list = await this.run(['screen', 'list']);
    if ((list.screens ?? []).some((s: any) => s.name === this.options.screen)) return;
    this.options.log(`creating screen ${this.options.screen}`);
    const created = await this.run(['screen', 'create', '--name', this.options.screen, '--size', '1280x900', '--idle-timeout', '0']);
    if (!created.ok) throw new Error(`cannot create screen: ${created.error}`);
  }

  wechatRunning(): Promise<number | undefined> {
    return new Promise((done) => {
      execFile('ps', ['-axo', 'pid=,command='], (_error, stdout) => {
        const line = stdout.split('\n').find((l) => /WeChat\.app\/Contents\/MacOS\/WeChat\s*$/.test(l.trim()));
        done(line ? Number(line.trim().split(/\s+/)[0]) : undefined);
      });
    });
  }

  /**
   * Whether WeChat has a window on the screen, and its main window's id:
   * `state` alone answers for whichever window is in front, which may be a
   * popup such as 通讯录管理, so the main window is picked by its title.
   */
  private async onScreen(pid: number): Promise<{ ok: boolean; windowId?: number }> {
    const state = await this.run(['state', '--screen', this.options.screen, '--pid', String(pid)]);
    if (!state.ok) return { ok: false };
    const placed = await this.run(['window', 'move', '--screen', this.options.screen, '--pid', String(pid)]);
    const windows: any[] = placed.windows ?? [];
    const main = windows.find((w) => w.title === '微信') ?? windows.sort((a, b) => b.frame.width * b.frame.height - a.frame.width * a.frame.height)[0];
    return { ok: true, windowId: main?.windowID ?? state.windowID };
  }

  /**
   * Everything in place: returns WeChat's pid and window on the screen, or
   * undefined while WeChat's window is the user's to keep.
   */
  async ensure(): Promise<{ pid: number; windowId?: number } | undefined> {
    await this.instance();
    await this.screen();
    for (let attempt = 0; attempt < 3; attempt++) {
      const running = await this.wechatRunning();
      const where = running === undefined ? { ok: false } : await this.onScreen(running);
      const plan = planWeChat(running, where.ok, this.store.wechatPid, this.options.takeOver);
      if (plan.do === 'ready') return { pid: plan.pid, windowId: (where as { windowId?: number }).windowId };
      if (plan.do === 'wait') {
        this.options.log(plan.reason);
        return undefined;
      }
      if (plan.do === 'launch') {
        this.options.log('launching WeChat');
        const launched = await this.run(['app', 'launch', '--screen', this.options.screen, '--bundle', WECHAT_BUNDLE, '--fill']);
        if (!launched.ok) throw new Error(`cannot launch WeChat: ${launched.error}`);
        this.store.wechatPid = launched.pid;
        await sleep(6000);
      } else {
        this.options.log("moving WeChat's window onto the agent screen");
        // A closed main window reopens on `open -g`; WeChat may come forward for a moment.
        await new Promise<void>((done) => execFile('open', ['-g', '-b', WECHAT_BUNDLE], () => done()));
        await sleep(1500);
        const moved = await this.run(['window', 'move', '--screen', this.options.screen, '--pid', String(plan.pid), '--fill']);
        if (!moved.ok) throw new Error(`cannot move WeChat's window: ${moved.error}`);
        if (plan.pid !== this.store.wechatPid) this.store.wechatPid = plan.pid;
        await sleep(1000);
      }
    }
    throw new Error('WeChat would not stay on its screen');
  }

  /** Give WeChat's window back to the user's display. */
  async release(): Promise<void> {
    const pid = await this.wechatRunning();
    if (pid === undefined) return;
    const released = await this.run(['window', 'release', '--screen', this.options.screen, '--pid', String(pid)]);
    if (!released.ok) throw new Error(`cannot release WeChat's window: ${released.error}`);
  }
}
