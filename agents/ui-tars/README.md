# 2ndscreen + UI-TARS

Runs an instruction with a [UI-TARS](https://github.com/bytedance/UI-TARS-desktop)
vision model on a 2ndscreen agent screen. The model reads screenshots and
answers with actions at coordinates; `SecondScreenOperator` carries them out
through the `2ndscreen` command, so they happen in the background and only
in the app you name, instead of taking over the real pointer and keyboard
as UI-TARS's own desktop operator does.

This suits apps whose controls cannot be read through accessibility, such
as chat apps that draw their own interface: the model finds things by
sight.

## Setup

```bash
cd agents/ui-tars
npm install
```

You need Node 22, the 2ndscreen app running, the `2ndscreen` command (set
`SECONDSCREEN_CLI` if it is not on PATH), and a model behind an
OpenAI-compatible API. By default it uses Doubao Seed 2.1 lite on
Volcengine Ark: activate the model in the Ark console (开通管理; it took
about two minutes to take effect) and set `ARK_API_KEY`. `ARK_MODEL` takes
another model or endpoint ID, and `ARK_BASE_URL` another server, such as a
self-hosted UI-TARS-1.5 under vLLM (then set `UI_TARS_VERSION=1.5`).

Ark's dedicated GUI model, `doubao-1-5-ui-tars-250428`, is shut down. Seed
2.1 lite, a general vision model, answers UI-TARS's prompt in the same
`Thought: … Action: …` format: on a test page it placed a Send button and a
text field within 2 of 1000 of their centers, at about 2 s a step. Now and
then it writes a box without its comma, `[382 117]`, which the SDK's parser
reads as one number; the operator then reads the box from the raw text.

## Use

```bash
2ndscreen screen create --name chat --ttl 30m
2ndscreen app launch --screen chat --bundle com.example.App     # note the pid
npx tsx src/cli.ts --screen chat --pid PID "打开文件传输助手，读出最新一条消息"
```

Each step prints the model's thought and the command it ran; the last line
is JSON: `{"ok": true, "outcome": "done", "reason": ...}`, where `reason`
holds the model's answer when it finishes, or why the run stopped.

### On an Android phone

With `--android`, the model works on the Android phone connected to
2ndscreen (pair it from the menu bar: Android Phones → Connect Phone…). It
sees through `2ndscreen android screenshot` and acts through `android tap`,
`swipe`, `type` and `key`, which reach the phone over Wi-Fi, so nothing on
the Mac is touched, and it works on apps such as WeChat that ignore
background input on a Mac. The phone must be unlocked.

```bash
npx tsx src/cli.ts --android [--serial SERIAL] "打开设置，找到这台手机的 Android 版本号"
```

It offers the model a phone's actions: tap, long press, type, scroll,
drag, Back and Home. Text is pasted, so Chinese works with any keyboard on
the phone. On an Honor ELZ-AN10 (Android 14), Seed 2.1 lite answered that
question correctly in 11 steps. Open the mirror (`2ndscreen android show`,
or the menu) to watch it.

## Guards

- **Nothing is sent unless you pass `--allow-submit`.** The run stops,
  with the text typed but not sent, when the model presses Enter, types
  text ending in a newline, clicks a control labelled 发送 or Send, or
  clicks while its thought or action mentions sending (发送, send, 提交,
  submit). WeChat, for one, hides its Send button from accessibility, so
  there only the model's own words give a click away; a click it does not
  describe as sending is not stopped.
- On Android, a tap the model describes as sending, submitting or paying
  (付款, 支付, 转账 too) stops the run, as do Enter and text ending in a
  newline, unless you pass `--allow-submit`.
- **Nothing takes the user's pointer unless you pass `--foreground`.**
  Without it, a drag on macOS stops the run, and a wheel at a point on
  Windows scrolls the focused area with keys instead.
- 2ndscreen itself refuses any window that is not on the named screen, and
  every click must land inside the app's window.

## How it fits together

- `src/plan.ts` turns one parsed action into `2ndscreen` commands. Boxes
  arrive normalised to 0..1 and map onto the agent screen's frame, so the
  screenshot's size and the display's scale do not matter.
- `src/operator.ts` is the `Operator` for `@ui-tars/sdk`: it takes
  screenshots of the agent screen scaled to points, runs the commands,
  and applies the guards. When the model types after clicking a text
  field, it types into that field by index, because keystrokes to the
  focused element miss backgrounded web views without any error.
- `src/cli.ts` wires it to `GUIAgent` and a model.

```bash
npm test          # the action mapping and guards
npm run typecheck
```

`@ui-tars/sdk` 1.2.3 imports `uuid` without depending on it, so this
package depends on it directly.
