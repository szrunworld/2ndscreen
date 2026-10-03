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
`SECONDSCREEN_CLI` if it is not on PATH), and a model. By default it uses
Doubao UI-TARS on Volcengine Ark: enable the model in the Ark console and
set `ARK_API_KEY`. `ARK_MODEL` takes a model or endpoint ID, and
`ARK_BASE_URL` any OpenAI-compatible server, such as a self-hosted
UI-TARS-1.5 under vLLM (then set `UI_TARS_VERSION=1.5`).

The default, `doubao-1-5-ui-tars-250428`, takes no new activations since
2026-09-24 and stops serving on 2026-11-24 (Ark's model deprecation
notice). Set `ARK_MODEL` to its successor, or self-host the open
UI-TARS-1.5 weights, which do not expire.

## Use

```bash
2ndscreen screen create --name chat --ttl 30m
2ndscreen app launch --screen chat --bundle com.example.App     # note the pid
npx tsx src/cli.ts --screen chat --pid PID "打开文件传输助手，读出最新一条消息"
```

Each step prints the model's thought and the command it ran; the last line
is JSON: `{"ok": true, "outcome": "done", "reason": ...}`, where `reason`
holds the model's answer when it finishes, or why the run stopped.

## Guards

- **Nothing is sent unless you pass `--allow-submit`.** The run stops,
  with the text typed but not sent, when the model presses Enter, types
  text ending in a newline, or clicks a control labelled 发送 or Send.
  Apps that hide their controls from accessibility pass that last check,
  so keep the first two in mind: an app that sends on a click of an
  unlabelled button is not stopped.
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
