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
Frames are global, top-left-origin points, the same space cua-driver
reports element frames in, so they can be passed straight to it.

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
`scroll`, which run through [cua-driver](https://github.com/trycua/cua)'s
background routes and show the agent cursor:

```bash
$CLI state --screen test-a --pid 1234 [--screenshot before.png]   # elements + accessibility tree
$CLI click --screen test-a --pid 1234 --text "Sign In"            # or --index N, or --x/--y
$CLI type  --screen test-a --pid 1234 --index 7 --value "hello"
$CLI key   --screen test-a --pid 1234 --key n --modifiers cmd
$CLI click --screen test-a --pid 1234 --text "Message" --right     # or --double
$CLI scroll --screen test-a --pid 1234 --index 5 --direction down [--amount N] [--by page]
```

`scroll` turns the wheel over an element or point (`--x/--y`), so it
reaches a list nested inside a larger window. Without either it sends
arrow or page keys to the focused area. cua-driver 0.32's background wheel
scrolls the opposite way to the direction it is given, in AppKit and
WebKit and whatever the natural scrolling setting; 2ndscreen sends the
opposite direction to correct this.

cua-driver will not scroll Electron or Chromium windows in the background
at all. For those, 2ndscreen posts the wheel to the app itself, through the
same per-process route cua-driver uses for clicks, with the window-local
point Chromium routes it by and a mouse move there first. It scrolled lists
in Electron 22 and 33 test apps, including inside a `<webview>`, and the
recommendations list in BOSS直聘 (Electron 22), without moving the pointer
or changing the frontmost app. The result's `route` is then
`2ndscreen_wheel`.

Typing into those apps is refused the same way. Their text fields take a
value set through accessibility, which the page receives as an `input`
event, so `type` with `--index` or `--text` sets the field to its text plus
the new text (`route` `accessibility_value`). It needs the field named. In
BOSS直聘 a reply drafted this way showed in the message box and enabled its
Send button, so the page took it as typed.

A right-click at a point reaches the app twice (a web page saw two
`contextmenu` events), because cua-driver posts each event through two
routes so that it reaches backgrounded apps. A context menu usually just
opens again; check the result before acting on it.

`drag` is the exception to working in the background. cua-driver has no
background drag on macOS: its foreground drag brings the app to the front
and moves the real pointer for about a second. So `drag` runs only with
`--foreground`, and 2ndscreen puts the pointer back afterwards. In testing,
3 of 5 drags in a row reached a web view, so verify each one.

```bash
$CLI drag --screen test-a --pid 1234 --from-x 2200 --from-y 500 --to-x 2500 --to-y 600 --foreground
```

These refuse any window that is not on the named screen, so an agent
cannot act on the user's own windows. They use `$CUA_DRIVER` if set, else
`cua-driver-local` (below) if installed, else `cua-driver`.

Upstream cua-driver, while it acts in the background, pulls the foreground
back to the app you were using if any other app activates, including when
you switch apps yourself. `scripts/build-patched-cua-driver.sh` builds and
installs it as `cua-driver-local` with
`patches/cua-driver-respect-user-app-switch.patch`, which lets an activation
that follows your own keyboard or mouse input stand. On an M4 MacBook Pro,
switching apps during background clicks was undone 4 times in 8 with
upstream and 0 times in 10 with the patch. Apps placed with `app launch` or
`window move` stay bound to their screen: windows they open later are
moved onto it as they appear, instead of popping up in front of you.
`window release` ends that and moves the windows to the main display, for
when you need to use one yourself, such as to type a password.

`skills/2ndscreen/SKILL.md` is the agent-facing guide; give it to an
agent, or install it as a Claude Code skill.

### MCP

`2ndscreen mcp` serves the same commands as MCP tools over stdio:
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

`scripts/agent-click.py` combines this with a background click through
[cua-driver](https://github.com/trycua/cua):

```bash
scripts/agent-click.py --pid 1234 --window-id 5678 --text "Send"
```

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
