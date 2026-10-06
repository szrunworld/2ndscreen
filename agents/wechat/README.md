# 微信助手

Watches WeChat for Mac on a 2ndscreen agent screen, reads it from pixels,
and adds friends only when you say so in the terminal. WeChat runs in the
background the whole time: your pointer, keyboard and frontmost app are
left alone, except for the one step that needs WeChat in front (see below).

## Setup

```bash
cd agents/wechat && npm install && npm run build:ocr
swift build -c release && ./scripts/bundle-app.sh    # from the repository root, once
```

`build:ocr` compiles the small Swift helper that reads text and colours
from screenshots with Apple's Vision framework. Optionally, `ARK_API_KEY`
(or `~/.config/2ndscreen/ark.env`) names a Volcengine Ark vision model;
it is asked only where text recognition is not enough, and for `--ask`.

## Use

```bash
npx tsx src/cli.ts --auto --take-over          # watch 新的朋友, ask before accepting
npx tsx src/cli.ts --auto --list               # print the chat list and 新的朋友
npx tsx src/cli.ts --auto --ask "chy 最后说了什么？"
npx tsx src/cli.ts --auto --add wxid_xxx --note "我是 Kevin，RampingUp 招聘"
npx tsx src/cli.ts --auto --release            # give WeChat's window back
```

`--auto` looks after its surroundings before every check, so it can run
for hours:

- a 2ndscreen **side instance** on its own socket
  (`~/Library/Caches/2ndscreen/wechat.sock`), started if it is not running,
  so other 2ndscreen users restarting theirs do not take its screen away;
- a screen named `wechat` (1280×900) on it that never expires, created
  again if lost;
- WeChat's main window on that screen: launched if WeChat is not running,
  moved back if it strays. A WeChat you opened yourself is left on your
  display and the assistant waits; `--take-over` moves its window over,
  and `--release` hands it back.

What it has handled is kept in `~/.config/2ndscreen/wechat-state.json`, so
a restart does not ask about the same request twice.

Every 60 seconds it opens 通讯录 → 新的朋友 and looks for requests waiting
for an answer (a green 接受 button). For each one it opens the request,
reads the name, WeChat ID, region and verification message, and asks:

```
── 陈一 · 微信号 wxid_abc123 · 中国大陆
  申请留言：我是陈一，BOSS直聘看到的
  [a] 接受  [k] 先跳过  [q] 退出 >
```

`a` clicks accept and any 完成/确定 that follows, then reads the list
again and reports what it says. Without a terminal to ask, requests are
only listed.

## Sending a request (`--add`)

WeChat shows its search results and the add-friend card only while it is
the active app, so `--add` waits until you have left the keyboard and
mouse alone for 3 seconds, brings WeChat to the front, searches the ID,
opens the profile, clicks 添加到通讯录 and fills the verification message,
then shows you the dialog and asks before clicking 发送. Your previous app
is put back in front right after. If you keep using the Mac for two
minutes, it gives up without doing anything.

WeChat looks an ID up over the network only for a WeChat ID the person set
themselves or a phone number; an internal `wxid_…` ID comes back as
找不到相关账号或内容, and the assistant stops there.

## How it works

WeChat 4.x draws its own interface and offers no accessibility tree, so
the assistant works from screenshots of its own screen:

- `ocr/ocr.swift` reads text (Simplified Chinese and English) with
  positions, and samples how green, red or white a rectangle is: the green
  of a 接受 button or a selected row, the red of an unread dot.
- `src/parse.ts` turns that text into rows: 新的朋友 requests with their
  status (已添加, 已过期, 接受…), chat rows with time and preview, and the
  pane's details and buttons. Positions are measured on WeChat 4.1 filling
  a 1280×900 screen; `layout` holds them.
- `src/screen.ts` acts through the `2ndscreen` command: clicks at points,
  typed text (Chinese included) and keys, all in the background.
- `src/see.ts` asks the vision model where a control is when the text
  does not say, and answers `--ask`.
- `src/front.ts` brings WeChat forward for the few seconds `--add` needs.

Tests use made-up names at the measured positions:

```bash
npm test
```

## Known limits

- Only the visible part of 新的朋友 is read; new requests arrive at the
  top, so watching does not need to scroll.
- The accept flow was written from WeChat's documented behaviour and has
  not yet been run against a live pending request; if a dialog it does not
  expect appears, pass `--foreground` so the dialog can show, and tell the
  assistant what it said.
- Text recognition can misread a character (OCR read 小小小 Sue as
  小wJSue once); names are matched loosely, and nothing is sent on a
  mismatch.
- WeChat's terms forbid automated operation, and its risk control is
  strict: keep a person approving each action and keep the pace human.
