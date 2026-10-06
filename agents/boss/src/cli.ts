#!/usr/bin/env -S npx tsx
// Watch BOSS直聘 on a 2ndscreen agent screen. For each conversation with
// unread messages: open it, read it, draft a reply into the message box,
// and ask in this terminal whether to send it. Nothing is sent without a
// yes here.
//
//   ARK_API_KEY=... npx tsx src/cli.ts --auto --brief "先请对方发简历"

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Boss, sleep } from './boss.ts';
import { draftReply } from './draft.ts';
import { AppLease, LeaseBusyError } from './lease.ts';
import type { Conversation } from './parse.ts';
import { BOSS_BUNDLE, defaults, Setup } from './setup.ts';
import { Store } from './store.ts';

const usage = `usage: boss --auto [--take-over] [--brief TEXT] [--interval SECONDS] [--max N]
            [--once] [--name CANDIDATE]
       boss --screen NAME --pid PID [--window-id ID] [same options]

With --auto it looks after its own surroundings before every check: a
2ndscreen side instance on its own socket (started if needed), so other
2ndscreen users restarting theirs leave it be; a screen named boss on it
that never expires; and BOSS直聘 on that screen (launched if not running,
moved back if it strays). A BOSS直聘 it did not launch is left alone, and
the assistant waits, unless --take-over says to move it over. Without
--auto, give the screen and BOSS直聘's pid yourself.

Watches BOSS直聘 on the agent screen for conversations with unread
messages. For each one it opens the conversation (the candidate then sees
it as read), drafts a reply into the message box, and asks here:
  s  send it      e  edit it, then ask again
  k  keep the draft in the box and move on      q  quit
Without a terminal to ask, drafts stay in the box unsent.

  --brief TEXT     how replies should go, e.g. "先请对方发简历，再约电话"
  --interval S     seconds between checks (default 60)
  --max N          conversations to handle per check (default 3)
  --once           check once and exit
  --name NAME      handle only this candidate's conversation, read or not,
                   once, and exit
  --state FILE     what has been handled, kept across restarts
                   (default ~/.config/2ndscreen/boss-state.json)

BOSS直聘 is shared with 2ndscreen task runs (2ndscreen task run
boss.collect-resumes): each check first takes the BOSS直聘 lease in the task
ledger and gives it back when the check ends. While a task holds it the
check is skipped; if the lease is lost midway the check stops before its
next action.

Environment: ARK_API_KEY, and optionally ARK_TEXT_MODEL (default
doubao-seed-2-1-lite-260915), ARK_BASE_URL, SECONDSCREEN_CLI, and for
--auto SECONDSCREEN_SOCKET and SECONDSCREEN_APP (the side instance's
socket, default ~/Library/Caches/2ndscreen/boss.sock, and the app to start
it from, default this repository's build/2ndscreen.app).`;

const { values } = parseArgs({
  options: {
    screen: { type: 'string' },
    pid: { type: 'string' },
    'window-id': { type: 'string' },
    brief: { type: 'string' },
    interval: { type: 'string', default: '60' },
    max: { type: 'string', default: '3' },
    once: { type: 'boolean', default: false },
    name: { type: 'string' },
    auto: { type: 'boolean', default: false },
    'take-over': { type: 'boolean', default: false },
    state: { type: 'string', default: join(homedir(), '.config/2ndscreen/boss-state.json') },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help || (!values.auto && (!values.screen || !values.pid))) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}
if (!process.env.ARK_API_KEY) {
  console.error('set ARK_API_KEY to a Volcengine Ark API key');
  process.exit(2);
}

const log = (line: string) => console.error(`${new Date().toLocaleTimeString()} ${line}`);
const store = new Store(values.state);
/** The BOSS直聘 lease for the check under way; every command checks it first. */
let lease: AppLease | undefined;
const fence = () => {
  if (!lease) throw new Error('acting on BOSS直聘 without its lease');
  lease.check();
};
const setup = values.auto
  ? new Setup({ ...defaults(values.screen ?? 'boss'), takeOver: values['take-over'], log, fence }, store)
  : undefined;
if (setup) {
  // The Boss commands go to the side instance too.
  process.env.SECONDSCREEN_SOCKET = setup.options.socket;
  process.env.SECONDSCREEN_CLI = setup.options.cli;
}
let boss = setup ? undefined : new Boss(values.screen!, Number(values.pid), values['window-id'] ? Number(values['window-id']) : undefined, undefined, fence);
const ask = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
const key = (c: Conversation) => `${c.name}|${c.time}|${c.preview}`;
let quitting = false;

async function handle(boss: Boss, conversation: Conversation): Promise<void> {
  const open = await boss.open(conversation);
  const c = open.candidate;
  console.error(`\n── ${c.name}（${c.summary}）· ${c.position}${c.expects ? ` · 期望 ${c.expects}` : ''}`);
  for (const m of open.messages.slice(-6)) console.error(`  ${m.from === 'me' ? '我' : '他'}：${m.text}`);

  // Text already in the box is someone's: a reply the user started, or a
  // draft not yet sent. Writing a draft would replace it, so leave it.
  const typed = (open.input?.value ?? open.input?.label ?? '').trim();
  if (typed) {
    console.error(`  输入框里已有文字，没有动它：${typed.slice(0, 40)}${typed.length > 40 ? '…' : ''}`);
    return;
  }

  let draft = await draftReply(open, { brief: values.brief });
  for (;;) {
    await boss.draft(draft);
    console.error(`  草稿（已放进输入框，未发送）：${draft}`);
    if (!ask) return;
    const answer = (await ask.question('  [s] 发送  [e] 修改  [k] 保留草稿跳过  [q] 退出 > ')).trim().toLowerCase();
    if (answer === 's') {
      await boss.send(draft);
      console.error('  已发送。');
      return;
    }
    if (answer === 'e') {
      const edited = (await ask.question('  新的回复：')).trim();
      if (edited) draft = edited;
      continue;
    }
    if (answer === 'q') quitting = true;
    console.error('  草稿留在输入框里，没有发送。');
    return;
  }
}

const releaseLease = async () => {
  const held = lease;
  lease = undefined;
  await held?.release();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void releaseLease().finally(() => process.exit(130)));
}

for (;;) {
  try {
    try {
      lease = await AppLease.acquire({ bundleId: BOSS_BUNDLE });
    } catch (error) {
      if (!(error instanceof LeaseBusyError)) throw error;
      log(`BOSS直聘 is in use by a task, skipping this check: ${error.message}`);
    }
    if (lease) {
      if (setup) {
        // Rebuild whatever went missing since the last check.
        const where = await setup.ensure();
        boss = where ? new Boss(setup.options.screen, where.pid, where.windowId, setup.options.cli, fence) : undefined;
      }
    }
    if (!boss || !lease) {
      // Setup or the lease said why; try again next time, leaving BOSS直聘 free meanwhile.
      await releaseLease();
      if (values.once || values.name) break;
      await sleep(Number(values.interval) * 1000);
      continue;
    }
    let listed = await boss.conversations();
    // Just after launch the list is still loading; give a named candidate time to show.
    for (let attempt = 0; values.name && attempt < 10 && !listed.some((c) => c.name === values.name); attempt++) {
      await sleep(1000);
      listed = await boss.conversations();
    }
    const waiting = values.name
      ? listed.filter((c) => c.name === values.name)
      : listed.filter((c) => c.unread > 0 && !store.has(key(c)));
    if (values.name && waiting.length === 0) console.error(`${values.name} is not in the visible list`);
    if (waiting.length === 0) console.error(`${new Date().toLocaleTimeString()} 没有新消息`);
    for (const conversation of waiting.slice(0, Number(values.max))) {
      // Recorded before handling, so a crash midway never opens it twice.
      store.add(key(conversation));
      await handle(boss, conversation);
      if (quitting) break;
    }
  } catch (error) {
    log(`error: ${(error as Error).message}`);
  } finally {
    // Between checks BOSS直聘 is free for tasks.
    await releaseLease();
  }
  if (values.once || values.name || quitting) break;
  await sleep(Number(values.interval) * 1000);
}
ask?.close();
