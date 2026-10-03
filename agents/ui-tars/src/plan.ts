// Turns one parsed UI-TARS action into 2ndscreen commands. Pure, so the
// mapping and the send policy can be tested without a model or a screen.

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlanContext {
  screen: string;
  pid: number;
  windowId?: number;
  /** The agent screen's frame in global points, from `2ndscreen screen list`. */
  frame: Frame;
  platform: NodeJS.Platform;
  /** Let the model submit: press Enter, or type text that ends in a newline. */
  allowSubmit: boolean;
  /** Let actions that need the real pointer run with --foreground. */
  foreground: boolean;
}

export interface ParsedAction {
  action_type: string;
  action_inputs: Record<string, unknown>;
}

export type Step =
  | { kind: 'run'; words: string[]; point?: { x: number; y: number } }
  | { kind: 'wait'; ms: number }
  /** End the run: `done` when the model finished or stopped short of
   * submitting, `user` when it needs a person. */
  | { kind: 'stop'; outcome: 'done' | 'user'; reason: string };

const MODIFIERS = new Set(['ctrl', 'control', 'cmd', 'command', 'meta', 'win', 'super', 'shift', 'alt', 'option']);

const KEY_NAMES: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  pagedown: 'pagedown',
  pageup: 'pageup',
  esc: 'escape',
};

/** Names cua-driver uses on macOS for keys that are named otherwise elsewhere. */
const MAC_KEY_NAMES: Record<string, string> = { enter: 'return', backspace: 'delete' };

const SUBMIT_KEYS = new Set(['return', 'enter']);

/** The center of a parsed box, which the action parser leaves as a JSON
 * array of coordinates normalised to 0..1, as a global point on the screen. */
export function boxPoint(box: unknown, frame: Frame): { x: number; y: number } | undefined {
  if (typeof box !== 'string' || box.length === 0) return undefined;
  let numbers: number[];
  try {
    numbers = JSON.parse(box);
  } catch {
    return undefined;
  }
  if (!Array.isArray(numbers) || numbers.length < 2 || !numbers.every(Number.isFinite)) return undefined;
  const [x1, y1, x2 = x1, y2 = y1] = numbers;
  const nx = Math.min(Math.max((x1 + x2) / 2, 0), 1);
  const ny = Math.min(Math.max((y1 + y2) / 2, 0), 1);
  return {
    x: Math.round((frame.x + nx * frame.width) * 10) / 10,
    y: Math.round((frame.y + ny * frame.height) * 10) / 10,
  };
}

/** A box read again from the model's raw text, for when the action parser
 * could not: models sometimes write "[383 117]" or "<point>383 117</point>",
 * which it splits into one number. Values on the model's 0..1000 scale are
 * normalised to 0..1, as the parser would. */
export function recoverBox(prediction: string, name: 'start_box' | 'end_box'): string | undefined {
  const at = prediction.lastIndexOf(name);
  if (at < 0) return undefined;
  const rest = prediction.slice(at + name.length).split(/end_box|direction|content|\)\s*$/)[0];
  const numbers = (rest.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 4).map(Number);
  if (numbers.length < 2) return undefined;
  const scale = numbers.some((n) => n > 1) ? 1000 : 1;
  const [x1, y1, x2 = x1, y2 = y1] = numbers.map((n) => n / scale);
  return JSON.stringify([x1, y1, x2, y2]);
}

/** "ctrl c", "cmd+shift+n" or "enter" as a key and its modifiers. As in
 * UI-TARS's own desktop operator, ctrl means cmd on macOS. */
export function parseKeys(text: string, platform: NodeJS.Platform): { key: string; modifiers: string[] } | undefined {
  const words = text
    .toLowerCase()
    .replace(/page (up|down)/g, 'page$1')
    .split(/[\s+]+/)
    .filter(Boolean);
  const modifiers: string[] = [];
  let key: string | undefined;
  for (const word of words) {
    if (MODIFIERS.has(word)) {
      let modifier = word;
      if (['control', 'ctrl'].includes(word)) modifier = platform === 'darwin' ? 'cmd' : 'ctrl';
      if (['command', 'meta', 'super'].includes(word)) modifier = platform === 'darwin' ? 'cmd' : 'win';
      if (word === 'win') modifier = platform === 'darwin' ? 'cmd' : 'win';
      if (word === 'option') modifier = 'alt';
      if (platform === 'darwin' && modifier === 'alt') modifier = 'option';
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
    } else {
      key = KEY_NAMES[word] ?? word;
      if (platform === 'darwin') key = MAC_KEY_NAMES[key] ?? key;
    }
  }
  return key ? { key, modifiers } : undefined;
}

function target(ctx: PlanContext): string[] {
  const words = ['--screen', ctx.screen, '--pid', String(ctx.pid)];
  if (ctx.windowId !== undefined) words.push('--window-id', String(ctx.windowId));
  return words;
}

export function plan(action: ParsedAction, ctx: PlanContext): Step[] {
  const inputs = action.action_inputs ?? {};
  const start = boxPoint(inputs.start_box, ctx.frame);
  const end = boxPoint(inputs.end_box, ctx.frame);
  const str = (name: string) => (typeof inputs[name] === 'string' ? (inputs[name] as string) : '');

  switch (action.action_type) {
    case 'click':
    case 'left_click':
    case 'left_single':
    case 'left_double':
    case 'double_click':
    case 'right_single':
    case 'right_click': {
      if (!start) return [{ kind: 'stop', outcome: 'user', reason: `${action.action_type} without a point` }];
      const words = ['click', ...target(ctx), '--x', String(start.x), '--y', String(start.y)];
      if (['left_double', 'double_click'].includes(action.action_type)) words.push('--double');
      if (['right_single', 'right_click'].includes(action.action_type)) words.push('--right');
      return [{ kind: 'run', words, point: start }];
    }

    case 'drag':
    case 'left_click_drag':
    case 'select': {
      if (!start || !end) return [{ kind: 'stop', outcome: 'user', reason: 'drag without both points' }];
      // macOS has no background drag; it would take the user's pointer.
      if (ctx.platform === 'darwin' && !ctx.foreground) {
        return [{ kind: 'stop', outcome: 'user', reason: 'the task needs a drag, which on macOS takes the real pointer; rerun with --foreground to allow it' }];
      }
      const words = ['drag', ...target(ctx), '--from-x', String(start.x), '--from-y', String(start.y), '--to-x', String(end.x), '--to-y', String(end.y)];
      if (ctx.foreground) words.push('--foreground');
      return [{ kind: 'run', words }];
    }

    case 'type': {
      // A trailing newline, literal or escaped, means "and submit".
      const content = str('content');
      const submit = /(\\n|\n)$/.test(content);
      const text = content.replace(/(\\n|\n)$/, '');
      const steps: Step[] = [];
      if (text.length > 0) steps.push({ kind: 'run', words: ['type', ...target(ctx), '--value', text] });
      if (submit) {
        if (!ctx.allowSubmit) {
          steps.push({ kind: 'stop', outcome: 'done', reason: 'stopped before submitting; the text is typed but not sent' });
        } else {
          steps.push({ kind: 'run', words: ['key', ...target(ctx), '--key', ctx.platform === 'darwin' ? 'return' : 'enter'] });
        }
      }
      return steps;
    }

    case 'hotkey':
    case 'press': {
      const keys = parseKeys(str('key') || str('hotkey'), ctx.platform);
      if (!keys) return [];
      if (SUBMIT_KEYS.has(keys.key) && !ctx.allowSubmit) {
        return [{ kind: 'stop', outcome: 'done', reason: 'stopped before pressing Enter, which would submit' }];
      }
      const words = ['key', ...target(ctx), '--key', keys.key];
      if (keys.modifiers.length > 0) words.push('--modifiers', keys.modifiers.join(','));
      return [{ kind: 'run', words }];
    }

    case 'scroll': {
      const direction = str('direction').toLowerCase();
      if (!['up', 'down', 'left', 'right'].includes(direction)) return [];
      const words = ['scroll', ...target(ctx), '--direction', direction, '--amount', '5'];
      // A wheel at a point needs the foreground on Windows; without it, the
      // focused area scrolls with keys instead.
      if (start && (ctx.platform !== 'win32' || ctx.foreground)) {
        words.push('--x', String(start.x), '--y', String(start.y));
        if (ctx.platform === 'win32') words.push('--foreground');
      }
      return [{ kind: 'run', words, point: start }];
    }

    case 'wait':
      return [{ kind: 'wait', ms: 5000 }];

    case 'finished':
      return [{ kind: 'stop', outcome: 'done', reason: str('content') || 'finished' }];

    case 'call_user':
    case 'error_env':
    case 'user_stop':
      return [{ kind: 'stop', outcome: 'user', reason: action.action_type }];

    case 'hover':
    case 'mouse_move':
      // Nothing to do: agents act without moving a pointer.
      return [];

    default:
      return [{ kind: 'stop', outcome: 'user', reason: `unsupported action ${action.action_type}` }];
  }
}
