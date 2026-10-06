// WeChat on a 2ndscreen agent screen, driven through the 2ndscreen command.
// WeChat 4.x draws its own interface and offers no accessibility tree, so
// this reads pixels: screenshots, Apple's Vision text recognition (the `ocr`
// helper beside this package) and colour samples. Clicks and keys go to the
// app in the background; the user's pointer and frontmost app are left alone.

import { execFile } from 'node:child_process';
import { mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export class WeChatError extends Error {}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in points, relative to the shot's top-left corner. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A piece of recognised text, in points relative to the shot. */
export interface Word extends Region {
  text: string;
  confidence: number;
}

export interface Shot {
  path: string;
  /** Where the shot's top-left corner lies on the global desktop, in points. */
  origin: { x: number; y: number };
  /** Pixels per point. */
  scale: number;
  /** The shot's size in points. */
  width: number;
  height: number;
  /** The whole screen, or just WeChat's window. */
  kind: 'screen' | 'window';
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A PNG's pixel size, from its header. */
export function pngSize(path: string): { width: number; height: number } {
  const header = Buffer.alloc(24);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, header, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

export class WeChat {
  readonly shots: string;

  constructor(
    readonly screen: string,
    readonly pid: number,
    readonly windowId?: number,
    readonly cli = process.env.SECONDSCREEN_CLI || '2ndscreen',
    readonly ocrTool = resolve(import.meta.dirname, '../ocr/ocr'),
  ) {
    this.shots = join(tmpdir(), 'wechat-agent');
    mkdirSync(this.shots, { recursive: true });
  }

  private exec(command: string, words: string[]): Promise<string> {
    return new Promise((done, fail) => {
      execFile(command, words, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout) fail(new WeChatError((stderr || String(error)).trim()));
        else done(stdout);
      });
    });
  }

  /** A 2ndscreen command, with this window as its target. */
  async run(words: string[], target = true): Promise<Record<string, any>> {
    const args = [...words];
    if (target) {
      args.push('--screen', this.screen, '--pid', String(this.pid));
      if (this.windowId !== undefined && !words.includes('--window-id') && words[0] !== 'window') args.push('--window-id', String(this.windowId));
    }
    const stdout = await this.exec(this.cli, args);
    let output: Record<string, any>;
    try {
      output = JSON.parse(stdout);
    } catch {
      throw new WeChatError(stdout.trim() || `2ndscreen ${words[0]} printed nothing`);
    }
    if (output.ok === false) throw new WeChatError(output.error ?? `2ndscreen ${words[0]} failed`);
    return output;
  }

  async windowFrame(): Promise<Frame> {
    const state = await this.run(['state']);
    return state.windowFrame;
  }

  /** A screenshot of WeChat's window alone. */
  async shot(name = 'window'): Promise<Shot> {
    const path = join(this.shots, `${name}.png`);
    const state = await this.run(['state', '--screenshot', path]);
    const frame: Frame = state.windowFrame;
    const px = pngSize(path);
    return { path, origin: { x: frame.x, y: frame.y }, scale: px.width / frame.width, width: frame.width, height: frame.height, kind: 'window' };
  }

  /** A screenshot of the whole agent screen: popups are windows of their own. */
  async screenShot(name = 'screen'): Promise<Shot> {
    const path = join(this.shots, `${name}.png`);
    await this.run(['screenshot', '--screen', this.screen, '--output', path], false);
    const list = await this.run(['screen', 'list'], false);
    const frame: Frame | undefined = (list.screens ?? []).find((s: any) => s.name === this.screen)?.frame;
    if (!frame) throw new WeChatError(`screen ${this.screen} is gone`);
    const px = pngSize(path);
    return { path, origin: { x: frame.x, y: frame.y }, scale: px.width / frame.width, width: frame.width, height: frame.height, kind: 'screen' };
  }

  /** Text in the shot, or in a region of it, in points. */
  async ocr(shot: Shot, region?: Region): Promise<Word[]> {
    const s = shot.scale;
    const args = [shot.path];
    if (region) args.push(...[region.x * s, region.y * s, region.w * s, region.h * s].map((v) => String(Math.round(v))));
    const items: any[] = JSON.parse(await this.exec(this.ocrTool, args));
    return items.map((i) => ({ text: String(i.text).trim(), x: i.x / s, y: i.y / s, w: i.w / s, h: i.h / s, confidence: i.confidence }));
  }

  /** The share of a region's pixels that are WeChat green, red, or white. */
  async color(shot: Shot, region: Region): Promise<{ green: number; red: number; white: number }> {
    const s = shot.scale;
    const args = [shot.path, 'color', ...[region.x * s, region.y * s, region.w * s, region.h * s].map((v) => String(Math.round(v)))];
    return JSON.parse(await this.exec(this.ocrTool, args));
  }

  /** Click at a point of the shot, in points. */
  async click(shot: Shot, x: number, y: number, options: { double?: boolean } = {}): Promise<void> {
    const words = ['click', '--x', String(Math.round(shot.origin.x + x)), '--y', String(Math.round(shot.origin.y + y))];
    if (options.double) words.push('--double');
    await this.run(words);
  }

  /**
   * A real click, with the system pointer, at a point of the shot. WeChat's
   * popups (search results, the add-friend card) let posted clicks fall
   * through to the window beneath, so they take only this. It brings WeChat
   * to the front and moves the user's pointer for a moment, then puts both
   * back; call it only inside withWeChatInFront.
   */
  async realClick(shot: Shot, x: number, y: number): Promise<void> {
    const gx = String(Math.round(shot.origin.x + x)), gy = String(Math.round(shot.origin.y + y));
    await this.run(['drag', '--from-x', gx, '--from-y', gy, '--to-x', gx, '--to-y', gy, '--duration-ms', '0', '--foreground']);
  }

  /** WeChat's windows on the screen, by title. */
  async windows(): Promise<{ title: string; windowID: number; frame: Frame }[]> {
    const placed = await this.run(['window', 'move'], true);
    return placed.windows ?? [];
  }

  /** Close the window with this title, if it is open, through its close button. */
  async closeWindow(title: string): Promise<boolean> {
    const window = (await this.windows()).find((w) => w.title === title);
    if (!window) return false;
    const state = await this.run(['state', '--window-id', String(window.windowID)]);
    const close = (state.elements ?? []).find((e: any) => String(e.role ?? '').includes('CloseButton'));
    if (!close) return false;
    await this.run(['click', '--window-id', String(window.windowID), '--index', String(close.index)]);
    return true;
  }

  async type(text: string): Promise<void> {
    await this.run(['type', '--value', text]);
  }

  async key(key: string, modifiers?: string): Promise<void> {
    const words = ['key', '--key', key];
    if (modifiers) words.push('--modifiers', modifiers);
    await this.run(words);
  }

  async scroll(shot: Shot, x: number, y: number, direction: 'up' | 'down', amount = 5): Promise<void> {
    await this.run(['scroll', '--x', String(Math.round(shot.origin.x + x)), '--y', String(Math.round(shot.origin.y + y)),
      '--direction', direction, '--amount', String(amount)]);
  }
}
