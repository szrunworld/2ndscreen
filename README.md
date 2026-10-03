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
$CLI window release --screen test-a --pid 1234        # give its windows back to the main display
$CLI screenshot --screen test-a --output shot.png
$CLI screen list
$CLI screen destroy test-a
```

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

Agents then look and act with `state`, `click`, `type`, `key` and
`scroll`, which work in the background and show the agent cursor:

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

The event recipes follow [cua-driver](https://github.com/trycua/cua) (MIT),
which found by experiment what AppKit, Chromium and Catalyst windows accept
from the background.

### Vision agent

`agent` runs an instruction with a [UI-TARS](https://github.com/bytedance/UI-TARS-desktop)
vision model, which reads screenshots of the screen and answers with
actions at coordinates. 2ndscreen carries them out in the background and
only in the app you name. It suits apps whose controls accessibility
cannot read, such as chat apps that draw their own interface.

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

`skills/2ndscreen/SKILL.md` is the agent-facing guide; give it to an
agent, or install it as a Claude Code skill.

### MCP

`2ndscreen mcp` serves the commands above, except `agent`, as MCP tools over stdio:
`screen_create`, `screen_list`, `screen_destroy`, `app_launch`,
`window_move`, `screenshot`, `state`, `click`, `type`, `key`, `scroll` and
`drag`. Each tool
runs the matching CLI command, so the guards and output are identical.
`screenshot`, and `state` with `screenshot: true`, also return the image,
downscaled to 1280 px as JPEG.

```bash
claude mcp add --transport stdio 2ndscreen -- 2ndscreen mcp
```

Any MCP client works: point it at `2ndscreen mcp` (use the absolute path
if `2ndscreen` is not on its PATH).

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
