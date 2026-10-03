---
name: 2ndscreen
description: Test or operate a macOS app on a private virtual screen without touching the user's screen, pointer, or focus. Use when asked to run, test, click through, or screenshot a GUI app (including one you just built) on the user's Mac while they keep working.
---

# 2ndscreen: run GUI apps on your own screen

`2ndscreen` gives you virtual displays of your own. Launch the app you are
testing on one, drive it in the background, and verify it with
screenshots, while the user keeps their screen, pointer and frontmost app.

It needs the 2ndscreen menu bar app running (`open build/2ndscreen.app` in
the repository) and cua-driver installed for `state`, `click`, `type`,
`key`, `scroll` and `drag`. Every command prints one JSON object; `ok` is false, and the exit
status non-zero, on failure.

```bash
CLI=2ndscreen   # or <repo>/.build/release/2ndscreen
```

## Workflow

1. **Create a screen.** Name it after your task so parallel agents do not collide.

   ```bash
   $CLI screen create --name login-test --size 1280x800
   ```

   Without `--size`, the screen matches the main display's full-screen
   area. HiDPI follows the main display; pass `--hidpi` or `--no-hidpi`.
   macOS runs a screen at HiDPI only from 800 points on the long side and
   525 on the short side, so smaller screens are 1x.
   Add `--ttl 30m` as a safety net. A screen no command names for an hour
   is destroyed anyway (`--idle-timeout` changes that).

2. **Launch the app there.** Use `--path` for a fresh build, `--bundle`
   for an installed app.

   ```bash
   $CLI app launch --screen login-test --path ./build/MyApp.app --fill
   ```

   Note `pid` from the output. An app that is already running is refused,
   so you never rearrange the user's windows: add `--new-instance` for a
   copy of your own. New windows the app opens later are moved onto your
   screen automatically.

3. **Look before you act.**

   ```bash
   $CLI state --screen login-test --pid PID --screenshot /tmp/before.png
   ```

   `elements` lists indexed controls with labels, values and frames;
   `tree` is the full accessibility tree. Read the screenshot with your
   image tool when the tree is not enough.

4. **Act.** Prefer `--text` or `--index` over coordinates.

   ```bash
   $CLI click --screen login-test --pid PID --text "Sign In"
   $CLI type  --screen login-test --pid PID --index 7 --value "user@example.com"
   $CLI key   --screen login-test --pid PID --key return
   $CLI key   --screen login-test --pid PID --key n --modifiers cmd
   $CLI click --screen login-test --pid PID --x 2400 --y 310   # global point, last resort
   $CLI click --screen login-test --pid PID --text "Message" --right    # context menu
   $CLI click --screen login-test --pid PID --index 12 --double          # open a row or file
   ```

   Scroll with the wheel over the area that should move, such as a list
   or chat history inside a larger window; give its element or a point.
   With neither, arrow or page keys scroll the focused area. Electron and
   Chromium apps take a wheel posted by 2ndscreen instead, mid-window when
   you give no point. Name the field when you `type` into them (`--index`
   or `--text`): they only take text set on a named field.

   ```bash
   $CLI scroll --screen login-test --pid PID --index 5 --direction down --amount 5
   $CLI scroll --screen login-test --pid PID --x 2400 --y 500 --direction up --by page
   ```

   `drag` presses at one global point and releases at another. macOS has no
   background drag, so it brings the app to the front and moves the
   user's real pointer for about a second (2ndscreen puts the pointer back
   afterwards). It runs only with `--foreground`: ask the user first, and
   look for another way, such as a menu command or keys, before you do.
   Drags can be lost, so verify each one.

   ```bash
   $CLI drag --screen login-test --pid PID --from-x 2200 --from-y 500 --to-x 2500 --to-y 600 --foreground
   ```

5. **Verify.** `effect` is often `unverifiable` (normal for clicks and web
   content), so success means the UI changed. Run `state` again, or take a
   screenshot, and check for what you expected.

   ```bash
   $CLI screenshot --screen login-test --output /tmp/after.png
   ```

6. **Clean up.** Quit the app you launched, then destroy the screen.

   ```bash
   kill PID
   $CLI screen destroy login-test
   ```

## Android phones

2ndscreen can also drive an Android phone the user has connected over
Wi-Fi (they pair it once from the menu bar: **Android Phones → Connect
Phone…**, or with `2ndscreen android pair HOST:PORT CODE`). Nothing is
installed on the phone.

```bash
$CLI android devices                                    # serial, state, model
$CLI android screenshot --output /tmp/phone.png         # look (full resolution)
$CLI android tap   --x 540 --y 1200                     # act, in screenshot pixels
$CLI android swipe --x 540 --y 1600 --to-x 540 --to-y 600 [--duration 0.3]
$CLI android type  --text "你好 hello"                  # pasted: any text, any keyboard
$CLI android key   --key back                           # home, recents, enter, delete, ...
$CLI android adb shell uiautomator dump /sdcard/ui.xml && $CLI android adb exec-out cat /sdcard/ui.xml
$CLI android adb shell monkey -p com.example.app 1      # launch an app
$CLI android show [--screen login-test]                 # optional: a mirror for the user to watch
```

Add `--serial SERIAL` when more than one phone is connected. Points are
the screenshot's pixels; take them from the screenshot or from
`uiautomator` bounds. Tap a text field before `type`; the text is pasted
through the phone's clipboard, which it replaces. `android adb` runs the
bundled adb with your arguments unchanged.

None of this moves the user's pointer or takes focus. The phone is the
user's: if it is locked, ask them to unlock it (and to turn on Developer
options → Stay awake while you work); never unlock, pay, send or delete
anything they did not ask for.

## Rules

- Act only on windows of apps you launched. `state`, `click`, `type`,
  `key`, `scroll` and `drag` refuse windows that are not on the named screen; do not move the
  user's windows onto your screen to get around that.
- Indexes come from the latest `state`, and `click`/`type` re-read the
  window. Run `state` again after the UI changes before reusing an index.
- Frames are global, top-left-origin points. macOS rearranges displays
  whenever a screen is added or removed; call `screen list` before using
  a screen's frame.
- When an app has several windows, keyboard input without a target is
  refused (`same_pid_keyboard_ambiguity`): pass `--window-id`, and name
  the field with `--index` or `--text`.
- Do not send messages, submit forms, buy, or delete data in a real
  account unless the user asked for exactly that.
- At most 8 agent screens exist at once. Destroy yours when finished.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `2ndscreen is not running` | Ask the user to open 2ndscreen.app |
| `needs the Accessibility permission` | Ask the user to grant it from the 2ndscreen menu |
| `needs the Screen Recording permission` | Same, for screenshots |
| `no window on screen` | `app launch` or `window move` the app there first |
| `cua-driver not found` | Install cua-driver, or set `CUA_DRIVER` to its path |
| `... already running` | Add `--new-instance`, or `window move` a window you own |
| The user must type into a window (a password) | `window release` it to their main display, then `window move` it back |
| `no Android device is connected` | Ask the user to connect the phone from the 2ndscreen menu |
| Android device `unauthorized` or `offline` | Ask the user to turn Wireless debugging off and on, then reconnect |
