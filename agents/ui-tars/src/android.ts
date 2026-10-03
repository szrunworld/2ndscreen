// A UI-TARS operator for an Android phone connected to 2ndscreen over Wi-Fi.
// It sees through `2ndscreen android screenshot` and acts through
// `android tap/swipe/type/key`, which reach the phone over adb and scrcpy's
// control channel: nothing moves the user's pointer or takes their focus,
// and it works on apps such as WeChat that ignore background input on a Mac.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operator, StatusEnum, type ExecuteParams, type ExecuteOutput, type ScreenshotOutput } from '@ui-tars/sdk/core';
import { Jimp } from 'jimp';
import { boxPoint, recoverBox, type ParsedAction, type Step } from './plan.ts';
import { SecondScreen } from './screen.ts';
import type { Stop } from './operator.ts';

export interface AndroidContext {
  /** adb serial; may be left out when one phone is connected. */
  serial?: string;
  /** The screenshot's size in device pixels, which taps are given in. */
  size: { width: number; height: number };
  /** Let the model submit: press Enter, or type text that ends in a newline. */
  allowSubmit: boolean;
}

/** Words in a prediction that mean the tap would send, submit or pay. */
const SUBMIT_INTENT = /发送|發送|提交|付款|支付|转账|\bsend\b|\bsubmit\b|\bpay\b/i;

const KEYS: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  back: 'back',
  escape: 'back',
  esc: 'back',
  home: 'home',
  backspace: 'delete',
  delete: 'delete',
  tab: 'tab',
};

/** Turns one parsed action into `2ndscreen android` commands. Pure, so the
 * mapping and the send policy are tested without a phone. */
export function planAndroid(action: ParsedAction, ctx: AndroidContext): Step[] {
  const inputs = action.action_inputs;
  const frame = { x: 0, y: 0, width: ctx.size.width, height: ctx.size.height };
  const serial = ctx.serial ? ['--serial', ctx.serial] : [];
  const at = (name: string) => boxPoint(inputs[name], frame);
  const point = (p: { x: number; y: number }) => ['--x', String(Math.round(p.x)), '--y', String(Math.round(p.y))];
  const run = (words: string[], p?: { x: number; y: number }): Step => ({ kind: 'run', words: ['android', ...words, ...serial], point: p });
  const unreadable = (what: string): Step[] => [{ kind: 'stop', outcome: 'user', reason: `could not read ${what} in ${JSON.stringify(inputs)}` }];

  switch (action.action_type) {
    case 'click':
    case 'left_single':
    case 'left_double': {
      const p = at('start_box');
      if (!p) return unreadable('the point');
      const tap = run(['tap', ...point(p)], p);
      return action.action_type === 'left_double' ? [tap, { kind: 'wait', ms: 80 }, tap] : [tap];
    }
    case 'long_press':
    case 'right_single': {
      const p = at('start_box');
      if (!p) return unreadable('the point');
      return [run(['swipe', ...point(p), '--to-x', String(Math.round(p.x)), '--to-y', String(Math.round(p.y)), '--duration', '0.8'], p)];
    }
    case 'drag':
    case 'swipe': {
      const from = at('start_box');
      const to = at('end_box');
      if (!from || !to) return unreadable('the start and end');
      return [run(['swipe', ...point(from), '--to-x', String(Math.round(to.x)), '--to-y', String(Math.round(to.y)), '--duration', '0.5'], from)];
    }
    case 'scroll': {
      // Scrolling down shows what is below, so the finger moves up.
      const p = at('start_box') ?? { x: ctx.size.width / 2, y: ctx.size.height / 2 };
      const direction = String(inputs.direction ?? 'down').toLowerCase();
      const dx = direction === 'left' ? 1 : direction === 'right' ? -1 : 0;
      const dy = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
      const reach = Math.min(ctx.size.width, ctx.size.height) * 0.6;
      // Keep off the edges, where a swipe is the system's Back or Home gesture.
      const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, max * 0.15), max * 0.85));
      const start = { x: clamp(p.x - (dx * reach) / 2, ctx.size.width), y: clamp(p.y - (dy * reach) / 2, ctx.size.height) };
      const end = { x: clamp(p.x + (dx * reach) / 2, ctx.size.width), y: clamp(p.y + (dy * reach) / 2, ctx.size.height) };
      return [run(['swipe', ...point(start), '--to-x', String(end.x), '--to-y', String(end.y), '--duration', '0.35'], start)];
    }
    case 'type': {
      // A trailing newline, literal or escaped, means "and submit".
      const content = String(inputs.content ?? '');
      const submits = /(\\n|\n)$/.test(content);
      const text = content.replace(/(\\n|\n)+$/, '');
      const steps: Step[] = text ? [run(['type', '--text', text])] : [];
      if (submits) {
        const enter = run(['key', '--key', 'enter']);
        steps.push(ctx.allowSubmit ? enter : { kind: 'stop', outcome: 'done', reason: 'typed the text but did not send it', pending: enter.kind === 'run' ? enter.words : undefined });
      }
      return steps;
    }
    case 'hotkey':
    case 'press': {
      const name = String(inputs.key ?? '').trim().toLowerCase();
      const key = KEYS[name];
      if (!key) return unreadable('the key');
      const press = run(['key', '--key', key]);
      if (key === 'enter' && !ctx.allowSubmit && press.kind === 'run') {
        return [{ kind: 'stop', outcome: 'done', reason: 'stopped before pressing Enter, which may send', pending: press.words }];
      }
      return [press];
    }
    case 'press_home':
      return [run(['key', '--key', 'home'])];
    case 'press_back':
      return [run(['key', '--key', 'back'])];
    case 'wait':
      return [{ kind: 'wait', ms: 2000 }];
    case 'finished':
      return [{ kind: 'stop', outcome: 'done', reason: String(inputs.content ?? 'finished') }];
    case 'call_user':
      return [{ kind: 'stop', outcome: 'user', reason: 'the model asked for help' }];
    default:
      return [{ kind: 'stop', outcome: 'user', reason: `unsupported action ${action.action_type}` }];
  }
}

export interface AndroidOperatorOptions {
  serial?: string;
  /** Let the model submit (Enter, or typed text ending in a newline). Off by default. */
  allowSubmit?: boolean;
  cli?: SecondScreen;
  /** Called for each command just before it runs, and when the run stops. */
  onStep?: (step: Step) => void;
  /** Called when a command fails; the run carries on. */
  onError?: (error: Error, step?: Step) => void;
}

/** The longest side of the screenshot the model sees. Boxes are normalised,
 * so this only trades detail for upload size and speed. */
const MODEL_LONG_SIDE = 1400;

export class AndroidOperator extends Operator {
  static MANUAL = {
    ACTION_SPACES: [
      "click(start_box='[x1, y1, x2, y2]')",
      "long_press(start_box='[x1, y1, x2, y2]')",
      "type(content='') #Tap the text field first. If you want to submit your input, use \"\\n\" at the end of `content`.",
      "scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')",
      "drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')",
      'press_home()',
      'press_back()',
      'wait() #Sleep for 2s and take a screenshot to check for any changes.',
      "finished(content='') #Use this when the task is done; put any answer in content.",
      "call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.",
    ],
  };

  private readonly cli: SecondScreen;
  private size?: { width: number; height: number };
  /** Why the run ended, once the operator ended it. */
  stop?: Stop;

  constructor(private readonly options: AndroidOperatorOptions = {}) {
    super();
    this.cli = options.cli ?? new SecondScreen();
  }

  async screenshot(): Promise<ScreenshotOutput> {
    const directory = await mkdtemp(join(tmpdir(), '2ndscreen-android-'));
    try {
      const path = join(directory, 'phone.png');
      const serial = this.options.serial ? ['--serial', this.options.serial] : [];
      await this.cli.run(['android', 'screenshot', '--output', path, ...serial]);
      const image = await Jimp.read(await readFile(path));
      this.size = { width: image.width, height: image.height };
      const scale = Math.min(1, MODEL_LONG_SIDE / Math.max(image.width, image.height));
      if (scale < 1) image.resize({ w: Math.round(image.width * scale), h: Math.round(image.height * scale) });
      const png = await image.getBuffer('image/png');
      return { base64: png.toString('base64'), scaleFactor: 1 };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async execute(params: ExecuteParams): Promise<ExecuteOutput> {
    if (!this.size) await this.screenshot();
    const parsed = params.parsedPrediction;
    const inputs = { ...(parsed.action_inputs as Record<string, unknown>) };
    const frame = { x: 0, y: 0, width: this.size!.width, height: this.size!.height };
    for (const name of ['start_box', 'end_box'] as const) {
      if (inputs[name] !== undefined && !boxPoint(inputs[name], frame)) {
        const recovered = recoverBox(params.prediction, name);
        this.options.onError?.(new Error(`could not read ${name} ${inputs[name]}; ${recovered ? `read ${recovered} from` : 'raw'}: ${params.prediction.trim()}`));
        if (recovered) inputs[name] = recovered;
      }
    }
    const context: AndroidContext = { serial: this.options.serial, size: this.size!, allowSubmit: this.options.allowSubmit ?? false };
    for (const step of planAndroid({ action_type: parsed.action_type, action_inputs: inputs }, context)) {
      if (step.kind === 'stop') {
        this.options.onStep?.(step);
        return this.end(step.outcome, step.reason, step.pending);
      }
      if (step.kind === 'wait') {
        this.options.onStep?.(step);
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        continue;
      }
      // Phones show no accessible Send button to check, so go by what the
      // model says the tap is for.
      if (step.words[1] === 'tap' && !context.allowSubmit && SUBMIT_INTENT.test(params.prediction)) {
        const reason = 'stopped before a tap the model describes as sending';
        this.options.onStep?.({ kind: 'stop', outcome: 'done', reason, pending: step.words });
        return this.end('done', reason, step.words);
      }
      this.options.onStep?.(step);
      try {
        await this.cli.run(step.words);
      } catch (error) {
        // Carry on: the next screenshot shows the model nothing changed.
        this.options.onError?.(error as Error, step);
      }
    }
    // Let the phone draw the result before the next screenshot.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { status: StatusEnum.RUNNING };
  }

  private end(outcome: Stop['outcome'], reason: string, pending?: string[]): ExecuteOutput {
    this.stop = { outcome, reason, pending };
    return { status: outcome === 'done' ? StatusEnum.END : StatusEnum.CALL_USER };
  }
}
