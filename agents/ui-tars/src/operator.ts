// A UI-TARS operator that sees and acts on one 2ndscreen agent screen, so
// the model works in the background instead of taking the user's pointer,
// as UI-TARS's own desktop operator does.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operator, StatusEnum, type ExecuteParams, type ExecuteOutput, type ScreenshotOutput } from '@ui-tars/sdk/core';
import { Jimp } from 'jimp';
import { boxPoint, plan, recoverBox, type Frame, type PlanContext, type Step } from './plan.ts';
import { SecondScreen } from './screen.ts';

export interface SecondScreenOperatorOptions {
  screen: string;
  pid: number;
  windowId?: number;
  /** Let the model submit (Enter, or typed text ending in a newline). Off by default. */
  allowSubmit?: boolean;
  /** Let actions that take the real pointer run. Off by default. */
  foreground?: boolean;
  /** Labels of controls that submit, such as a Send button; with
   * allowSubmit off, a click on one ends the run instead. */
  submitLabels?: RegExp;
  cli?: SecondScreen;
  /** Called for each command just before it runs, and when the run stops. */
  onStep?: (step: Step) => void;
  /** Called when a command fails; the run carries on. */
  onError?: (error: Error, step?: Step) => void;
}

export interface Stop {
  outcome: 'done' | 'user';
  reason: string;
}

/** Words in a prediction that mean the click would send or submit. */
const SUBMIT_INTENT = /发送|發送|提交|\bsend\b|\bsubmit\b/i;

export class SecondScreenOperator extends Operator {
  static MANUAL = {
    ACTION_SPACES: [
      "click(start_box='[x1, y1, x2, y2]')",
      "left_double(start_box='[x1, y1, x2, y2]')",
      "right_single(start_box='[x1, y1, x2, y2]')",
      "drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')",
      "hotkey(key='')",
      "type(content='') #If you want to submit your input, use \"\\n\" at the end of `content`.",
      "scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')",
      'wait() #Sleep for 5s and take a screenshot to check for any changes.',
      'finished(content=\'\') #Use this when the task is done; put any answer in content.',
      "call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.",
    ],
  };

  private readonly cli: SecondScreen;
  private frame?: Frame;
  /** Where the model last clicked, to find the field it then types into. */
  private lastPoint?: { x: number; y: number };
  /** Why the run ended, once the operator ended it. */
  stop?: Stop;

  constructor(private readonly options: SecondScreenOperatorOptions) {
    super();
    this.cli = options.cli ?? new SecondScreen();
  }

  /** The whole agent screen, scaled to its size in points, so the model's
   * normalised boxes map straight onto the screen's frame. */
  async screenshot(): Promise<ScreenshotOutput> {
    this.frame = await this.cli.frame(this.options.screen);
    const directory = await mkdtemp(join(tmpdir(), '2ndscreen-ui-tars-'));
    try {
      const path = join(directory, 'screen.png');
      await this.cli.run(['screenshot', '--screen', this.options.screen, '--output', path]);
      const image = await Jimp.read(await readFile(path));
      image.resize({ w: Math.round(this.frame.width), h: Math.round(this.frame.height) });
      const png = await image.getBuffer('image/png');
      return { base64: png.toString('base64'), scaleFactor: 1 };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async execute(params: ExecuteParams): Promise<ExecuteOutput> {
    const frame = this.frame ?? (await this.cli.frame(this.options.screen));
    const context: PlanContext = {
      screen: this.options.screen,
      pid: this.options.pid,
      windowId: this.options.windowId,
      frame,
      platform: process.platform,
      allowSubmit: this.options.allowSubmit ?? false,
      foreground: this.options.foreground ?? false,
    };
    const parsed = params.parsedPrediction;
    const inputs = { ...(parsed.action_inputs as Record<string, unknown>) };
    for (const name of ['start_box', 'end_box'] as const) {
      if (inputs[name] !== undefined && !boxPoint(inputs[name], frame)) {
        const recovered = recoverBox(params.prediction, name);
        this.options.onError?.(new Error(`could not read ${name} ${inputs[name]}; ${recovered ? `read ${recovered} from` : 'raw'}: ${params.prediction.trim()}`));
        if (recovered) inputs[name] = recovered;
      }
    }
    for (const step of plan({ action_type: parsed.action_type, action_inputs: inputs }, context)) {
      if (step.kind === 'stop') {
        this.options.onStep?.(step);
        return this.end(step.outcome, step.reason);
      }
      if (step.kind === 'wait') {
        this.options.onStep?.(step);
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        continue;
      }
      // Apps that draw their own controls hide a Send button from
      // accessibility, so also go by what the model says it is doing.
      if (step.words[0] === 'click' && !context.allowSubmit && SUBMIT_INTENT.test(params.prediction)) {
        const reason = 'stopped before a click the model describes as sending';
        this.options.onStep?.({ kind: 'stop', outcome: 'done', reason });
        return this.end('done', reason);
      }
      if (step.words[0] === 'click' && step.point && !context.allowSubmit && (await this.isSubmitControl(step.point))) {
        const reason = 'stopped before clicking a control that submits';
        this.options.onStep?.({ kind: 'stop', outcome: 'done', reason });
        return this.end('done', reason);
      }
      this.options.onStep?.(step);
      if (step.words[0] === 'click') this.lastPoint = step.point;
      // Keystrokes to the focused element miss backgrounded web views, and
      // nothing reports it; typing into a named field goes through
      // accessibility instead.
      const words = step.words[0] === 'type' ? await this.withField(step.words) : step.words;
      try {
        await this.cli.run(words);
      } catch (error) {
        // Carry on: the next screenshot shows the model nothing changed.
        this.options.onError?.(error as Error, step);
      }
    }
    return { status: StatusEnum.RUNNING };
  }

  private end(outcome: Stop['outcome'], reason: string): ExecuteOutput {
    this.stop = { outcome, reason };
    return { status: outcome === 'done' ? StatusEnum.END : StatusEnum.CALL_USER };
  }

  /** The type command aimed at the text field the model last clicked, if
   * there is one there. */
  private async withField(words: string[]): Promise<string[]> {
    if (!this.lastPoint) return words;
    const point = this.lastPoint;
    const editable = /text|edit|combo|search|document/i;
    const elements = await this.elements();
    const field = elements
      .filter((e) => editable.test(e.role ?? '') && contains(e.frame, point))
      .sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0];
    return field ? [...words, '--index', String(field.index)] : words;
  }

  private async elements(): Promise<any[]> {
    const words = ['state', '--screen', this.options.screen, '--pid', String(this.options.pid)];
    if (this.options.windowId !== undefined) words.push('--window-id', String(this.options.windowId));
    try {
      return (await this.cli.run(words)).elements ?? [];
    } catch {
      return [];
    }
  }

  /** Whether the point is on a control labelled like a Send button. Apps
   * that do not expose their controls (some chat apps draw their own) pass
   * this check, so the Enter and newline rules matter as much. */
  private async isSubmitControl(point: { x: number; y: number }): Promise<boolean> {
    const labels = this.options.submitLabels ?? /^(发送|發送|send)(\s*\(s\))?$/i;
    return (await this.elements()).some((e) => labels.test(`${e.label ?? ''}`.trim()) && contains(e.frame, point));
  }
}

function contains(frame: Frame | undefined, point: { x: number; y: number }): boolean {
  return !!frame && point.x >= frame.x && point.x <= frame.x + frame.width && point.y >= frame.y && point.y <= frame.y + frame.height;
}
