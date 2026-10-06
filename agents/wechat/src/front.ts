// WeChat shows its popups (search results, the + menu, the add-friend card)
// only while it is the active app, so a few steps need the foreground for a
// moment. This waits until the user has left the keyboard and mouse alone,
// brings WeChat forward, and gives the user's app back right after.

import { execFile } from 'node:child_process';
import { sleep } from './screen.ts';

export const WECHAT_BUNDLE = 'com.tencent.xinWeChat';

const run = (command: string, args: string[]) =>
  new Promise<string>((done) => execFile(command, args, (_error, stdout) => done(stdout)));

/** Seconds since the user last touched the keyboard or mouse. */
export async function idleSeconds(): Promise<number> {
  const out = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
  const match = out.match(/"HIDIdleTime" = (\d+)/);
  return match ? Number(match[1]) / 1e9 : 0;
}

export async function frontmostBundle(): Promise<string> {
  const asn = (await run('lsappinfo', ['front'])).trim();
  const info = await run('lsappinfo', ['info', '-only', 'bundleid', asn]);
  return info.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? '';
}

export async function activate(bundle: string): Promise<void> {
  await run('osascript', ['-e', `tell application id "${bundle}" to activate`]);
}

/** Put `bundle` back in front; WeChat sometimes re-activates itself a moment later. */
export async function giveBack(bundle: string): Promise<void> {
  if (!bundle || bundle === WECHAT_BUNDLE) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    await activate(bundle);
    await sleep(400);
    if ((await frontmostBundle()) === bundle) {
      await sleep(800);
      if ((await frontmostBundle()) === bundle) return;
    }
  }
}

export interface FrontOptions {
  /** How long the user must have been idle before WeChat is brought forward. */
  idle?: number;
  /** How long to wait for that, in seconds. */
  maxWait?: number;
  log?: (line: string) => void;
}

/**
 * Run `body` with WeChat in front, then hand the foreground back. Throws
 * without running it if the user keeps using the Mac.
 */
export async function withWeChatInFront<T>(body: () => Promise<T>, options: FrontOptions = {}): Promise<T> {
  const need = options.idle ?? 3;
  const deadline = Date.now() + (options.maxWait ?? 120) * 1000;
  let told = false;
  while ((await idleSeconds()) < need) {
    if (Date.now() > deadline) throw new Error('you kept using the Mac; this step needs WeChat in front for a moment, so try again when you are away from the keyboard');
    if (!told) {
      options.log?.(`waiting until you are ${need} s away from the keyboard and mouse: WeChat must come to the front for a moment`);
      told = true;
    }
    await sleep(500);
  }
  const previous = await frontmostBundle();
  await activate(WECHAT_BUNDLE);
  for (let attempt = 0; attempt < 10 && (await frontmostBundle()) !== WECHAT_BUNDLE; attempt++) await sleep(100);
  if ((await frontmostBundle()) !== WECHAT_BUNDLE) {
    await giveBack(previous);
    throw new Error('WeChat did not come to the front; nothing done');
  }
  try {
    return await body();
  } finally {
    await giveBack(previous);
  }
}
