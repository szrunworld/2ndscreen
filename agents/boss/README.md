# BOSS直聘 assistant

Watches the BOSS直聘 Mac app on a 2ndscreen agent screen, drafts replies to
candidates, and sends one only when you say so in the terminal. BOSS直聘
runs in the background the whole time: your pointer, keyboard and
frontmost app are left alone.

## Setup

```bash
cd agents/boss && npm install
2ndscreen screen create --name boss --ttl 8h
2ndscreen app launch --screen boss --bundle com.zhipin.www --fill   # note the pid
```

Log in to BOSS直聘 first if it asks. It needs `ARK_API_KEY` for Volcengine
Ark; replies come from `doubao-seed-2-1-lite-260915` unless
`ARK_TEXT_MODEL` names another model.

## Use

```bash
npx tsx src/cli.ts --screen boss --pid PID --brief "先请对方发简历，看完后约电话"
```

Every 60 seconds it reads the message list. For each conversation with
unread messages it opens it (the candidate then sees it as read), reads
the candidate's details and messages, drafts a reply into the message box,
and asks:

```
── 陈一（30岁 6年 本科）· 前端工程师 · 期望 上海 · 前端工程师 20-30K
  他：请问这个岗位还在招吗？
  草稿（已放进输入框，未发送）：您好，还在招的。方便发一份最新简历吗？
  [s] 发送  [e] 修改  [k] 保留草稿跳过  [q] 退出 >
```

`s` clicks Send, after checking the box still holds the draft you saw.
`k` leaves the draft in the box for you to send or change in BOSS直聘
yourself. Without a terminal to ask, every draft stays unsent.

- `--name 陈一` handles just that conversation, read or not, and exits.
- `--once` checks once; `--max N` handles at most N conversations a check.

## How it works

BOSS直聘 is an Electron app with a full accessibility tree, so the
assistant reads text rather than pixels:

- `src/parse.ts` turns the message list into rows (name, position, time,
  unread count, latest message), grouping text by where each row's time sits.
- `src/chat.ts` reads an open conversation: the candidate's header and
  resume summary, and the messages, telling theirs from yours by which side
  the avatar is on.
- `src/boss.ts` acts through the `2ndscreen` command. Clicks name elements,
  because BOSS直聘 ignores background clicks at a point. Drafts are set
  with `type --replace`, which 2ndscreen applies through accessibility; the
  page takes it as typing and enables Send.
- `src/draft.ts` asks the model for one short reply, without inventing
  details of the job.

Tests use reads of the real app with every name and message replaced:

```bash
npm test
```

## Known limits

- Scrolling the message list in the background works on some launches and
  not others; new messages arrive at the top, so watching does not need it.
- Your own messages are told apart by the avatar being on the right. That
  side has not been seen yet in a test conversation, so check the first
  sent reply shows as `我`.
- BOSS直聘 forbids remote debugging (it quits if started with a debug
  port), and its terms may forbid automated messaging. Keep a person
  approving each reply, and keep the pace human.
