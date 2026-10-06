# 2ndscreen

A software second screen for macOS. 2ndscreen creates a virtual display
with no hardware behind it, so an agent can work in apps placed there
while you keep using your own screen. Swipe to its full-screen preview to
watch, and move windows on and off it from the menu bar.

## Requirements

- macOS 14 or later (developed on macOS 15, Apple silicon)
- Xcode Command Line Tools, for `swift build`

## Build and run

```bash
./scripts/bundle-app.sh        # builds build/2ndscreen.app
open build/2ndscreen.app
```

The script signs the app with a self-signed certificate it creates in a
dedicated keychain (`~/Library/Keychains/2ndscreen-signing.keychain-db`).
macOS ties permission grants to that certificate, so they survive rebuilds.

To try a change while another 2ndscreen keeps running, start the new
build as a side instance on its own socket, and point the CLI at it:

```bash
export SECONDSCREEN_SOCKET=~/Library/Caches/2ndscreen/test.sock
open -n --env SECONDSCREEN_SOCKET=$SECONDSCREEN_SOCKET build/2ndscreen.app
```

A side instance has agent screens only: no primary screen and no hot key.
It keeps off the menu bar, so the user sees one 2ndscreen however many
agents test theirs; the usual app lists side instances under **Test
Copies**, where each can be quit. A side instance quits by itself after 30
minutes without requests, unless it has an agent screen or a phone's
mirror open. The usual app starts whether or not side instances run.
While two instances ran, the first screen a fresh side instance created
showed another display's picture; screens it created after that did not.
Check a side instance's first screenshot.

## Permissions

| Permission | Needed for | Asked when |
| --- | --- | --- |
| Screen Recording | The live preview | You choose **Show Preview** |
| Accessibility | Moving other apps' windows, including `app launch` | You choose **Grant Accessibility to Move Windows…** |

macOS applies a new Screen Recording grant after the app relaunches.

## Using it

Everything lives in the menu bar icon:

- **Virtual Display**: turn the display on or off. Turning it off moves
  its windows back to your other displays.
- **Resolution**: pick **Match … Full Screen** to size the display to
  the area a full-screen window gets on that real display, so the
  full-screen preview shows it pixel for pixel. Fixed presets are below.
- **HiDPI (Retina)**: render at 2x.
- **Show Preview / Keep Preview on Top / Preview in Full Screen**: a live
  view of the display. In full screen it gets its own Space, reachable with
  a trackpad swipe. Capture pauses while the preview cannot be seen.
- **Move Front Window to Other Screen** (⌃⌥⌘M, works anywhere): send the
  focused window to 2ndscreen, or bring it back if it is already there.
- **Windows on 2ndscreen**: bring one window, or all of them, back.

The preview is view-only: clicks in it do not reach the apps on 2ndscreen.

## Agent screens

Agents create their own screens through the `2ndscreen` command, which
talks to the running app. Each screen is a separate virtual display, sized
as the agent asks, so an agent can launch the app it is testing there and
work in the background while you keep your own screen.

```bash
CLI=.build/release/2ndscreen

$CLI screen create --name test-a --size 1280x800      # HiDPI follows the main display;
                                                      # add --hidpi or --no-hidpi to choose;
                                                      # under 800x525 (either way up) it is 1x
$CLI app launch --screen test-a --path build/MyApp.app --fill
$CLI app launch --screen test-a --bundle com.apple.Chess
$CLI window move --screen test-a --pid 1234 [--window-id 5678] [--fill]
$CLI window move --screen phone --pid 1234 --fit-screen  # the screen follows the window's size
$CLI screen resize test-a --size 1024x768              # change a screen's size in place
$CLI window release --screen test-a --pid 1234        # give its windows back to the main display
$CLI screenshot --screen test-a --output shot.png
$CLI screen list
$CLI screen destroy test-a
```

`--fit-screen` (on `app launch` and `window move`) keeps the screen sized
to the app's largest window plus the menu bar, so nothing else shows around
it and its preview has the window's shape. When iPhone Mirroring turns
landscape for a video, or is made larger or smaller, the screen follows
about a second after the window settles, and the window is put back at the
top, centered. A screen that prefers HiDPI is grown to the smallest size
macOS runs at 2x (800 points on the long side, 525 on the short), so a
phone screen stays sharp: 525x1001 upright, 944x525 turned. Windows that
macOS keeps inside the screen can make it smaller but not larger; use
`screen resize` for that. A screen can be resized up to 2560x1440, or its
own size when it was created larger.

The same is in the menu: each agent screen has **Fit to Window** and a
**Size** submenu (choosing a size turns Fit to Window off; sizes too small
for the app's window are disabled, since an app such as iPhone Mirroring
decides its own orientation and size), and its preview
has title bar buttons to make the app's window smaller or larger (⌘- and
⌘=), to turn the picture a quarter (the view only: the app, and a phone,
keep their own orientation), and to set the Mac's output volume, plus
Home Screen and App Switcher when the window is iPhone Mirroring's.

Every command prints one JSON object and exits non-zero on failure.
Frames are global, top-left-origin points, the same space accessibility
reports element frames in.

Things to know:

- **Frames move.** macOS rearranges displays whenever one is added or
  removed. Run `screen list` before using a screen's frame.
- **Launching** opens the app without activating it, waits up to 15
  seconds for its first window, and moves that window to the screen. If
  the app grabs the foreground anyway, 2ndscreen hands it straight back.
  An app that is already running is refused, so your own windows are never
  rearranged; pass `--new-instance` for a separate copy, or use
  `window move`.
- **`--fill`** sizes the window to the screen's visible area where the
  app allows it.
- **Windows stay wholly on their screen.** A window that reaches past its
  screen is clipped in every screenshot, so the points an agent works out
  from one miss. `app launch` and `window move` place a window inside, and
  if the app moves or grows it back out they place it again, twice, then
  report failure. `state` says `windowOnScreen`, and `state --screenshot`
  refuses a clipped window rather than write a misleading picture; `window
  move --fill` brings it back.
- **Destroying** a screen moves its windows to your other displays.
- **Screens expire** so a forgetful agent cannot leave them behind:
  `--ttl 30m` destroys a screen 30 minutes after creation,
  `--idle-timeout 20m` after 20 minutes in which no command named it
  (default 60m; `0` turns it off), and `--owner-pid PID` when that
  process exits.
- At most 8 agent screens exist at once. On an M4 MacBook Pro with 16 GB,
  eight empty 1280x800 screens added about 180 MB to WindowServer (about
  300 MB at HiDPI) and a few percent CPU, and took 0.7 s (1.2 s at HiDPI)
  each to create. The apps you run on them cost what they always do.
- The menu lists agent screens, each with its own preview, its windows,
  and **Destroy**.

Agents then look and act with `state`, `click`, `type`, `key`, `scroll`,
`hover` and `ax-press`, which work in the background and show the agent cursor:

```bash
$CLI state --screen test-a --pid 1234 [--screenshot before.png]   # elements + accessibility tree
$CLI click --screen test-a --pid 1234 --text "Sign In"            # or --index N, or --x/--y
$CLI type  --screen test-a --pid 1234 --index 7 --value "hello"
$CLI key   --screen test-a --pid 1234 --key n --modifiers cmd
$CLI click --screen test-a --pid 1234 --text "Message" --right     # or --double
$CLI scroll --screen test-a --pid 1234 --index 5 --direction down [--amount N] [--by page]
```

The app runs them itself, with its Accessibility permission, and refuses
any window that is not on the named screen, so an agent cannot act on the
user's own windows. Each result names the `route` it took:

- **`ax.press`, `ax.insert`**: accessibility, for native controls and
  text fields. No input event is involved, and an insert counts only if
  the field's value shows the text afterwards.
- **`event.click`, `event.right`, `event.double`, `event.wheel`**: mouse
  events posted to the app's process and stamped with the window's
  number, so they reach a window that is not in front. Before a left
  click the window is made its app's key window without being raised;
  the user's app keeps the foreground and gets its focus back after.
- **`event.unicode`, `event.key`, `event.key.menu`**: keystrokes posted to
  the process. Text goes as Unicode, so any script works whatever the
  input method. A shortcut with cmd makes the app front for the instant
  its event is queued, since menu key equivalents such as cmd+a and cmd+v
  only reach the menu that way. They act on the window's app only once the
  window has been clicked: a window just launched ignores them.

Web content (Chrome, Electron, web views) always takes events: Chromium
answers accessibility presses and writes there with success while a
background page never sees them. Typing into a web field by `--index` or
`--text` clicks into it first unless it already has focus.

`scroll` turns the wheel over an element or point (`--x/--y`), so it
reaches a list nested inside a larger window; with neither, over the
middle of the window. A right click reaches the app by two routes, so
some apps see it twice; check a context menu before acting on it.

`hover` rests the pointer on an element or point without clicking, for
menus, panels and tooltips a page opens on hover; the page keeps the hover
until the next mouse event, so its options can then be clicked as usual.
Chromium ignores mouse moves posted to a background window but takes
hover from a button event, so this is a middle-button press and release at
the point: the page sees `auxclick` and no `click`. Not for links, which
Chromium opens on a middle click. Many panels that look hover-only open on
a click too: BOSS直聘's 筛选 panel opens with `click --x --y`, and its
options take clicks, in the background.

`ax-press --index N` presses one element of the last `state` through
accessibility alone, with no pointer event: for a control that answers an
accessibility press but not a click at its point, such as one under an
overlay. It takes only `--index`.

While an action runs, and for a second after, a guard puts the user's app
back if the target or anything else takes the foreground. An activation
that follows the user's own mouse or modifier input is the user switching
apps, and stands. Apps placed with `app launch` or `window move` stay bound
to their screen: windows they open later are moved onto it as they appear,
instead of popping up in front of you.
`window release` ends that and moves the windows to the main display, for
when you need to use one yourself, such as to type a password.

Electron and Chromium apps route a posted wheel by the window-local point
stamped on it, so wheels carry that point, after a mouse move there. That
scrolled lists in Electron 22 and 33 test apps, including inside a
`<webview>`, and in BOSS直聘 (Electron 22), without moving the pointer or
changing the frontmost app. Typing into their web fields goes as keys,
clicking into the field first; if the field's text has not changed after
that, 2ndscreen sets it through accessibility to its text plus the new
text, which the page receives as an `input` event (`route` `ax.insert`).
In BOSS直聘 a reply drafted that way showed in the message box and enabled
its Send button.

`drag` is the exception to working in the background. macOS has no
background drag, so `drag` brings the app to the front, moves the real
pointer through the gesture, then puts both back. It runs only with
`--foreground`; verify each drag.

```bash
$CLI drag --screen test-a --pid 1234 --from-x 2200 --from-y 500 --to-x 2500 --to-y 600 --foreground
```

### Vision agent

`agent` runs an instruction with a [UI-TARS](https://github.com/bytedance/UI-TARS-desktop)
vision model, which reads screenshots of the screen and answers with
actions. 2ndscreen carries them out in the background and only in the app
you name.

Each step also lists the app's controls read through accessibility, with
their labels, values and boxes, and the model acts on a listed control by
its number: a native button is pressed, a field typed into, exactly where
the app put them. Anything not listed it finds by sight and clicks at
coordinates. Apps that draw their own interface list nothing and run on
sight alone: WeChat 4.x takes background clicks, typing (Chinese included)
and wheel scrolls of its chat history this way. `--no-elements` turns the
list off.

```bash
$CLI agent --screen test-a --pid 1234 "打开文件传输助手，读出最新一条消息"
```

Each step prints the model's thought and the action taken on stderr; the
last line on stdout is JSON: `{"ok": true, "outcome": "done", "reason": ...}`,
where `reason` holds the model's answer, or why the run stopped.

The model sits behind an OpenAI-compatible API. By default that is Doubao
Seed 2.1 lite on Volcengine Ark: activate it in the Ark console and set
`ARK_API_KEY`, or put `ARK_API_KEY=...` in `~/.config/2ndscreen/ark.env`.
`ARK_MODEL` takes another model or endpoint ID, and `ARK_BASE_URL` another
server, such as a self-hosted UI-TARS-1.5 under vLLM. In tests it filled
in a web order form (scroll to an item, pick it, set a select, tick a box,
write a note) in 16 steps and 86 s, and worked Calculator in 12 steps.

Guards:

- **Nothing is sent unless you pass `--allow-submit`.** The run stops, with
  the text typed but not sent, when the model presses Enter, types text
  ending in a newline, clicks a control labelled 发送 or Send, or clicks
  while its reply mentions sending (发送, send, 提交, submit).
- **Nothing takes the user's pointer unless you pass `--foreground`**.
  Without it, a drag becomes a double click where it starts and ends in one
  spot, else a click and a shift-click, which select text as a drag would.
- Shortcuts that act beyond the window, such as cmd+q, cmd+tab and
  cmd+option+esc, stop the run: models reach for them when stuck.
- The run stops when the app no longer has a window on the screen.

#### Learning from runs

A run that worked is kept as a procedure for its app, in
`~/.config/2ndscreen/procedures/<bundle id>.json`, and the next run of the
same instruction repeats its steps without the model: each step names the
control it acted on, by role and label, so a replay finds it again wherever
it now sits, and a run's answer is read off the control that showed it.
The model comes back only where a replay breaks off: a step's control is
missing, typed text did not land, or the screen ends up unlike the learned
end. It is told which steps already ran and carries on from there, and
what it then does replaces the procedure. One that breaks three replays
in a row is dropped.

Text the instruction gave and the steps used, such as a name it clicked or
a reply it typed, becomes a slot: a procedure learned from "给陈一写：你好"
also serves "给李四写：在的". A run with a step that only had a point on the
screenshot to go by (apps that draw their own controls) is not kept, nor
one with a drag. Procedures learned without `--allow-submit` only serve runs
without it, and a replay keeps the same guards. `--no-learn` neither uses
nor keeps procedures; the result's `modelCalls` and `replayedSteps` say
how a run went.

In Calculator, 37 × 48 − 125 took 11 model calls and 51 s the first time,
then no calls and 4.8 s. In scientific mode, with every button moved, the
buttons were found again; the display had moved too, so the model read
the answer (2 calls, 18 s), and the next run made no calls.

Chrome's own address bar takes no typing from the background; open pages
with `open` and `window move` instead.

`skills/2ndscreen/SKILL.md` is the agent-facing guide; give it to an
agent, or install it as a Claude Code skill.

### MCP

`2ndscreen mcp` serves the commands above, except `agent`, as MCP tools over stdio:
`screen_create`, `screen_list`, `screen_destroy`, `app_launch`,
`window_move`, `screenshot`, `state`, `click`, `type`, `key`, `scroll`,
`drag` and `hover`. Each tool
runs the matching CLI command, so the guards and output are identical.
`screenshot`, and `state` with `screenshot: true`, also return the image,
downscaled to 1280 px as JPEG.

```bash
claude mcp add --transport stdio 2ndscreen -- 2ndscreen mcp
```

Any MCP client works: point it at `2ndscreen mcp` (use the absolute path
if `2ndscreen` is not on its PATH).

## iPhone

2ndscreen runs iPhone Mirroring on an agent screen and lets the vision
agent use it from the command line, like an Android phone.

```bash
$CLI iphone show                 # a "phone" screen with iPhone Mirroring on it, kept sized to its window
$CLI iphone screenshot --output /tmp/phone.png
$CLI iphone tap --x 344 --y 900  # the screenshot's pixels, two to a window point
$CLI iphone type --text "设置"
$CLI iphone key --key home       # also switcher, spotlight, return, delete
$CLI iphone hide                 # quit iPhone Mirroring, handing the phone back
$CLI agent --iphone "打开微信，告诉我第一个聊天的名字"
```

None of these moves your pointer or brings iPhone Mirroring to the front.

What iPhone Mirroring allows from a Mac shapes what the agent can do:

- Taps work in the background, and Home (⌘1).
- Nothing swipes or scrolls: wheel events, trackpad phases and drags are
  ignored, in the background and in front, so the agent is offered none,
  and a drag the model asks for anyway is refused, never turned into taps.
  It uses search instead.
- Typed text reaches the phone's keyboard as key codes, which a Chinese
  keyboard turns into pinyin. Text is pasted instead, in the background:
  ⌘V with ⌘ pressed as a key of its own (a ⌘V through the menus types
  "v", even with Mirroring in front). When the phone asks to Allow Paste,
  that is pressed, and your clipboard is put back once the phone has it.

## Android phones

2ndscreen mirrors and controls Android phones over Wi-Fi, with nothing
installed on the phone. It uses scrcpy's server: adb copies it to the
phone and runs it with debugging rights, which let it capture the screen
with the phone's hardware encoder and inject touches. 2ndscreen decodes
the video with VideoToolbox and draws it itself, so of scrcpy only the
0.7 MB server ships, beside adb (`scripts/fetch-android-tools.sh`
downloads both, pinned and checksummed, when the app is built). The app
grows from under 1 MB to about 11 MB, 5 MB zipped.

To connect a phone (Android 11 or later), choose **Android Phones →
Connect Phone…** in the menu bar, then on the phone open **Settings →
Developer options → Wireless debugging → Pair device with QR code** and
scan the code. The phone and the Mac must be on the same Wi-Fi. Pairing is
needed once; afterwards adb finds the phone by itself whenever Wireless
debugging is on, and it is listed under **Android Phones**.

Choosing a phone under **Android Phones** shows it full screen on a Space
of its own, as iPhone Mirroring would be: swipe between it and your work
with four fingers. Leave full screen to keep it in a window instead.
Agents never move your pointer or take focus: they act on the phone
through adb, and `android show` opens the mirror behind your windows.

In the mirror window, click and drag to touch, scroll to scroll, and type
to type; text an Android keyboard cannot inject, such as Chinese, is
pasted through the phone's clipboard. Right-click or Escape is Back. The
title bar has Back, Home and Recents, and ⌘V pastes the Mac's clipboard.

The phone's sound plays on the Mac while its mirror is open (Android 11
and later), and the phone itself goes quiet, as with iPhone Mirroring:
scrcpy's default source, the only one that captures every app. It comes as
AAC at about 130 kbit/s, beside video at 3 Mbit/s. Over Wi-Fi the phone
sends it in bursts after hold-ups of up to two seconds, so the buffer
adapts: running dry grows it by as long as the hold-up was, up to 2 s,
and the burst that follows refills it without dropping any; 20 s without
running dry shrinks it by half its spare, down to 200 ms, playing the
excess 5% faster, pitch kept. The log category `android-audio` records
each change. Voice and video calls cannot be captured.

The sound is held back a further second by default. A phone's video
player delays its picture by its speaker's latency, which the captured
sound skips, so without it the sound runs ahead of the picture.
**Android Phones → Sound Delay** in the menu bar sets another delay, as
does `defaults write io.github.szrunworld.2ndscreen androidAudioDelay
-float 0.5`, taking effect at once; the log category `android-av`
reports how far the sound plays behind the picture as it arrives.

Agents use the same phone from the command line:

```bash
$CLI android devices
$CLI android pair 192.168.1.20:37000 123456     # or scan the QR code from the menu
$CLI android connect 192.168.1.20:41000
$CLI android show [--serial S] [--screen test-a] [--max-size 1920]
$CLI android screenshot --output phone.png
$CLI android tap   --x 540 --y 1200             # device pixels, as in the screenshot
$CLI android swipe --x 540 --y 1600 --to-x 540 --to-y 600
$CLI android type  --text "你好"
$CLI android key   --key back
$CLI android adb -s S shell uiautomator dump    # the bundled adb, arguments unchanged
$CLI android hide [--serial S]
```

With the mirror open, taps, swipes and keys go through it, in about a
tenth of a second; without it, through adb, in about half a second. Text
is always pasted through the phone's clipboard, over a control-only
connection when the mirror is closed: typed keys would be turned into
pinyin by a Chinese keyboard on the phone, and adb types only ASCII.

`android show` opens the mirror behind the user's windows without taking
focus; with `--screen`, it fills that agent screen instead, for the user to
watch in its preview.

The vision agent works on a phone too, by its screenshots and through
these commands, with taps, swipes, long presses, Back and Home:

```bash
$CLI agent --android [--serial S] "打开微信，给文件传输助手写一句早安"
```

The guards are the desktop's: it stops before Enter, text ending in a
newline, or a tap the model describes as sending, and the result's
`pending` holds the `2ndscreen` arguments that would do it.

Things to know:

- macOS asks whether 2ndscreen may find devices on your local network;
  allow it. It asks again after the app is updated, and until then
  connecting fails with "No route to host". The adb server makes the connections to phones and
  answers to the permission of the app that started it, so 2ndscreen
  starts it, including before `2ndscreen android` commands run adb. If
  pairing or connecting fails with "No route to host", an adb server
  started from a terminal may be running; 2ndscreen restarts it and tries
  again by itself. It also restarts one left by an earlier build when it
  launches, and reconnects to the addresses phones last had, since adb's
  own reconnection relies on mDNS, which many Wi-Fi networks block.
- Agents need the phone unlocked. Developer options → Stay awake keeps it
  from locking while it charges.
- adb keeps a server running in the background after 2ndscreen quits, as
  it always does. Another adb of a different version, such as one from
  Homebrew, restarts that server whenever it is used, which drops the
  mirror; use `2ndscreen android adb` or one adb throughout.
- Video is capped at 1920 pixels on its long side, which Wi-Fi carries
  smoothly; `--max-size 0` sends the phone's full resolution.
- Android 10 and earlier have no Wireless debugging: connect once by USB
  and run `2ndscreen android adb tcpip 5555`, then
  `2ndscreen android connect PHONE-IP:5555`.

## Agent cursor

Agents act through accessibility and per-process events, so the real
pointer never moves. To show where an agent acts, 2ndscreen draws its own
cursor on the virtual display, visible in the preview:

```bash
.build/release/vdisplay cursor click 2400 500   # global point, top-left origin
.build/release/vdisplay cursor hide
```

`click`, `type` and `scroll` move it for you.

## Command-line display

`vdisplay` creates a display without the app, for scripting:

```bash
swift run -c release vdisplay --width 1512 --height 950 --hidpi --preview
```

It uses its own serial number, so it can run beside the app.

## Caveats

- The display is built on CoreGraphics' private `CGVirtualDisplay` API,
  as DeskPad and BetterDisplay are. It cannot ship on the Mac App Store,
  and a macOS update could change it.
- It is not isolation. The virtual display shares your login session, so
  there is still one frontmost app, one keyboard focus and one pointer.
  Agents must use background input that leaves those alone.
