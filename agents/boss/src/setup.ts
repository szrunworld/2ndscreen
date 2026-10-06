// Keeps the assistant's surroundings in place: a 2ndscreen side instance on
// its own socket, so other users of 2ndscreen restarting theirs do not take
// its screen away; an agent screen on it; and BOSS直聘 on that screen.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { sleep } from './boss.ts';
import type { Store } from './store.ts';

export const BOSS_BUNDLE = 'com.zhipin.www';
const repo = resolve(import.meta.dirname, '../../..');

export interface SetupOptions {
  screen: string;
  /** The side instance's control socket. */
  socket: string;
  /** The 2ndscreen app to start the side instance from. */
  app: string;
  /** The 2ndscreen command. */
  cli: string;
  /** Move a BOSS直聘 this assistant did not launch onto its screen. */
  takeOver: boolean;
  log: (line: string) => void;
  /** Throws when this process may no longer act on BOSS直聘 (its lease is gone). */
  fence?: () => void;
}

export function defaults(screen = 'boss'): Omit<SetupOptions, 'takeOver' | 'log'> {
  const built = join(repo, '.build/release/2ndscreen');
  return {
    screen,
    socket: process.env.SECONDSCREEN_SOCKET || join(homedir(), 'Library/Caches/2ndscreen/boss.sock'),
    app: process.env.SECONDSCREEN_APP || join(repo, 'build/2ndscreen.app'),
    cli: process.env.SECONDSCREEN_CLI || (existsSync(built) ? built : '2ndscreen'),
  };
}

/** Where BOSS直聘 stands, and what to do about it. Pure, for testing. */
export type BossPlan =
  | { do: 'launch' }
  | { do: 'ready'; pid: number }
  | { do: 'move'; pid: number }
  | { do: 'wait'; reason: string };

export function planBoss(running: number | undefined, onScreen: boolean, ours: number | undefined, takeOver: boolean): BossPlan {
  if (running === undefined) return { do: 'launch' };
  if (onScreen) return { do: 'ready', pid: running };
  // Off the screen: the screen was rebuilt, or this is someone else's BOSS直聘.
  if (running === ours || takeOver) return { do: 'move', pid: running };
  return { do: 'wait', reason: `BOSS直聘 (pid ${running}) is running elsewhere and is not this assistant's; pass --take-over to use it` };
}

export class Setup {
  constructor(readonly options: SetupOptions, readonly store: Store) {}

  private run(words: string[]): Promise<Record<string, any>> {
    try {
      this.options.fence?.();
    } catch (error) {
      return Promise.reject(error);
    }
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
    const created = await this.run(['screen', 'create', '--name', this.options.screen, '--size', '1440x900', '--idle-timeout', '0']);
    if (!created.ok) throw new Error(`cannot create screen: ${created.error}`);
  }

  private bossRunning(): Promise<number | undefined> {
    return new Promise((done) => {
      execFile('ps', ['-axo', 'pid=,command='], (_error, stdout) => {
        const line = stdout.split('\n').find((l) => /BOSS直聘\.app\/Contents\/MacOS\/BOSS直聘\s*$/.test(l.trim()));
        done(line ? Number(line.trim().split(/\s+/)[0]) : undefined);
      });
    });
  }

  private async onScreen(pid: number): Promise<{ ok: boolean; windowId?: number }> {
    const state = await this.run(['state', '--screen', this.options.screen, '--pid', String(pid)]);
    return { ok: !!state.ok, windowId: state.windowID };
  }

  /**
   * Everything in place: returns BOSS直聘's pid and window on the screen,
   * or undefined while BOSS直聘 belongs to someone else.
   */
  async ensure(): Promise<{ pid: number; windowId?: number } | undefined> {
    this.options.fence?.();
    await this.instance();
    await this.screen();
    for (let attempt = 0; attempt < 3; attempt++) {
      const running = await this.bossRunning();
      const where = running === undefined ? { ok: false } : await this.onScreen(running);
      const plan = planBoss(running, where.ok, this.store.bossPid, this.options.takeOver);
      if (plan.do === 'ready') return { pid: plan.pid, windowId: (where as { windowId?: number }).windowId };
      if (plan.do === 'wait') {
        this.options.log(plan.reason);
        return undefined;
      }
      if (plan.do === 'launch') {
        this.options.log('launching BOSS直聘');
        const launched = await this.run(['app', 'launch', '--screen', this.options.screen, '--bundle', BOSS_BUNDLE, '--fill']);
        if (!launched.ok) throw new Error(`cannot launch BOSS直聘: ${launched.error}`);
        this.store.bossPid = launched.pid;
        // BOSS直聘 shows a loading window first, then its main window.
        await sleep(8000);
      } else {
        this.options.log('moving BOSS直聘 back onto its screen');
        await this.run(['window', 'move', '--screen', this.options.screen, '--pid', String(plan.pid), '--fill']);
        if (plan.pid !== this.store.bossPid) this.store.bossPid = plan.pid;
        await sleep(1000);
      }
    }
    throw new Error('BOSS直聘 would not stay on its screen');
  }
}
