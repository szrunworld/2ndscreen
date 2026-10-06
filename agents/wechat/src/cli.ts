#!/usr/bin/env -S npx tsx
// Watch WeChat on a 2ndscreen agent screen, read it from pixels, and add
// friends: accept the requests in 新的朋友 that you approve here, or send one
// to a WeChat ID. Nothing is accepted or sent without a yes in this terminal.
//
//   npx tsx src/cli.ts --auto --take-over
//   npx tsx src/cli.ts --auto --list
//   npx tsx src/cli.ts --auto --add wxid_xxx --note "我是 Kevin，RampingUp 招聘"

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Friends } from './friends.ts';
import type { Request } from './parse.ts';
import { sleep, WeChat } from './screen.ts';
import { modelConfig, Vision } from './see.ts';
import { defaults, Setup } from './setup.ts';
import { Store } from './store.ts';

const usage = `usage: wechat --auto [--take-over] [--interval SECONDS] [--max N] [--once] [--foreground]
       wechat --auto --list
       wechat --auto --ask "问题"
       wechat --auto --add ID [--note TEXT]
       wechat --auto --release
       wechat --screen NAME --pid PID [--window-id ID] [same options]

With --auto it looks after its own surroundings before every check: a
2ndscreen side instance on its own socket (started if needed), a screen
named wechat on it that never expires, and WeChat's main window on that
screen. A WeChat it did not launch stays on your display and the assistant
waits, unless --take-over says to move its window over; --release gives the
window back.

By default it watches 新的朋友 for requests waiting for an answer. For each
one it opens the request, shows who it is and what they wrote, and asks:
  a  accept      k  skip for now      q  quit
Without a terminal to ask, requests are only listed.

  --list           print the chat list and 新的朋友, then exit
  --ask TEXT       answer a question about WeChat's screen with the vision model
  --add ID         send a friend request to a WeChat ID or phone number; this
                   brings WeChat to the front for a few seconds once you are
                   idle, and asks before sending
  --note TEXT      the verification message for --add
  --foreground     also bring WeChat forward to accept (if its dialogs need it)
  --interval S     seconds between checks (default 60)
  --max N          requests to handle per check (default 3)
  --once           check once and exit
  --state FILE     what has been handled, kept across restarts
                   (default ~/.config/2ndscreen/wechat-state.json)

Environment: ARK_API_KEY (or ~/.config/2ndscreen/ark.env) for the vision
model, used only where text recognition is not enough; SECONDSCREEN_CLI; and
for --auto SECONDSCREEN_SOCKET and SECONDSCREEN_APP (the side instance's
socket, default ~/Library/Caches/2ndscreen/wechat.sock, and the app to start
it from, default this repository's build/2ndscreen.app).`;

const { values } = parseArgs({
  options: {
    screen: { type: 'string' },
    pid: { type: 'string' },
    'window-id': { type: 'string' },
    auto: { type: 'boolean', default: false },
    'take-over': { type: 'boolean', default: false },
    release: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    ask: { type: 'string' },
    add: { type: 'string' },
    note: { type: 'string' },
    foreground: { type: 'boolean', default: false },
    interval: { type: 'string', default: '60' },
    max: { type: 'string', default: '3' },
    once: { type: 'boolean', default: false },
    state: { type: 'string', default: join(homedir(), '.config/2ndscreen/wechat-state.json') },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help || (!values.auto && (!values.screen || !values.pid))) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}

const log = (line: string) => console.error(`${new Date().toLocaleTimeString()} ${line}`);
const store = new Store(values.state);
const setup = values.auto
  ? new Setup({ ...defaults(values.screen ?? 'wechat'), takeOver: values['take-over'], log }, store)
  : undefined;
if (setup) {
  process.env.SECONDSCREEN_SOCKET = setup.options.socket;
  process.env.SECONDSCREEN_CLI = setup.options.cli;
}
const model = modelConfig();
const vision = model ? new Vision(model) : undefined;
if (!vision) log('no ARK_API_KEY: reading by text recognition only');
const ask = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
const key = (r: Request) => `${r.name}|${r.note}`;
let quitting = false;

async function connect(): Promise<WeChat | undefined> {
  if (!setup) return new WeChat(values.screen!, Number(values.pid), values['window-id'] ? Number(values['window-id']) : undefined);
  const where = await setup.ensure();
  return where ? new WeChat(setup.options.screen, where.pid, where.windowId, setup.options.cli) : undefined;
}

async function handle(friends: Friends, row: Request, shotRows: Awaited<ReturnType<Friends['newFriends']>>): Promise<void> {
  const { shot, detail } = await friends.open(row, shotRows.shot);
  console.error(`\n── ${detail.name}${detail.wechatId ? ` · 微信号 ${detail.wechatId}` : ''}${detail.region ? ` · ${detail.region}` : ''}`);
  console.error(`  申请留言：${detail.message ?? row.note ?? '（无）'}`);
  if (!ask) {
    console.error('  （没有终端可以确认，未处理）');
    return;
  }
  const answer = (await ask.question('  [a] 接受  [k] 先跳过  [q] 退出 > ')).trim().toLowerCase();
  if (answer === 'a') {
    const status = await friends.accept(row, shot, detail);
    console.error(status === '已添加' ? '  已接受，对方已加入通讯录。' : `  已点击接受；列表现在显示「${status}」，请在微信里确认。`);
    return;
  }
  if (answer === 'q') quitting = true;
  console.error('  没有动它。');
}

if (values.release) {
  if (!setup) {
    console.error('--release needs --auto');
    process.exit(2);
  }
  await setup.release();
  console.error("WeChat's window is back on your display.");
  process.exit(0);
}

for (;;) {
  try {
    const wx = await connect();
    if (!wx) {
      if (values.once || values.list || values.add || values.ask) break;
      await sleep(Number(values.interval) * 1000);
      continue;
    }
    const friends = new Friends(wx, { vision, foreground: values.foreground, log });

    if (values.ask) {
      if (!vision) throw new Error('--ask needs a vision model (ARK_API_KEY)');
      console.log(await vision.ask(await wx.shot('ask'), values.ask));
      break;
    }
    if (values.list) {
      const list = await friends.chatList();
      console.log('聊天：');
      for (const c of list) console.log(`  ${c.name.padEnd(16)} ${c.time.padEnd(10)} ${c.preview}`);
      const { rows } = await friends.newFriends();
      console.log('新的朋友：');
      for (const r of rows) console.log(`  ${r.pending ? '●' : ' '} ${r.name.padEnd(16)} ${(r.status || '待处理').padEnd(6)} ${r.note}`);
      break;
    }
    if (values.add) {
      const result = await friends.add(values.add, values.note, async (lines) => {
        console.error(`\n── 好友申请对话框：\n  ${lines.join('\n  ')}`);
        if (!ask) return false;
        return (await ask.question('  [s] 发送申请  [其他] 取消 > ')).trim().toLowerCase() === 's';
      });
      console.error(result === 'sent' ? '  申请已发送。' : '  已取消，没有发送。');
      break;
    }

    const found = await friends.newFriends();
    const waiting = found.rows.filter((r) => r.pending && !store.has(key(r)));
    if (waiting.length === 0) console.error(`${new Date().toLocaleTimeString()} 没有待处理的好友申请（列表 ${found.rows.length} 条）`);
    for (const row of waiting.slice(0, Number(values.max))) {
      // Recorded before handling, so a crash midway never asks twice.
      store.add(key(row));
      await handle(friends, row, found);
      if (quitting) break;
    }
  } catch (error) {
    log(`error: ${(error as Error).message}`);
    if (values.list || values.add || values.ask) process.exitCode = 1;
  }
  if (values.once || values.list || values.add || values.ask || quitting) break;
  await sleep(Number(values.interval) * 1000);
}
ask?.close();
