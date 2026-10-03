import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxPoint, parseKeys, plan, recoverBox, type PlanContext } from './plan.ts';

const frame = { x: 1920, y: 0, width: 1280, height: 800 };
const mac: PlanContext = { screen: 's', pid: 7, frame, platform: 'darwin', allowSubmit: false, foreground: false };
const win: PlanContext = { ...mac, platform: 'win32' };
const box = (x: number, y: number) => JSON.stringify([x, y, x, y]);

test('boxes map onto the screen frame', () => {
  assert.deepEqual(boxPoint(box(0.5, 0.25), frame), { x: 2560, y: 200 });
  assert.deepEqual(boxPoint(JSON.stringify([0.1, 0.1, 0.3, 0.5]), frame), { x: 2176, y: 240 });
  assert.equal(boxPoint('', frame), undefined);
  assert.equal(boxPoint('not json', frame), undefined);
});

test('clicks carry the point and the button', () => {
  const [step] = plan({ action_type: 'right_single', action_inputs: { start_box: box(0.5, 0.5) } }, mac);
  assert.deepEqual(step, {
    kind: 'run',
    words: ['click', '--screen', 's', '--pid', '7', '--x', '2560', '--y', '400', '--right'],
    point: { x: 2560, y: 400 },
  });
  const [double] = plan({ action_type: 'left_double', action_inputs: { start_box: box(0, 0) } }, mac);
  assert.ok(double.kind === 'run' && double.words.includes('--double'));
});

test('typing that would submit stops instead, unless allowed', () => {
  const steps = plan({ action_type: 'type', action_inputs: { content: '好的，明天见\\n' } }, mac);
  assert.deepEqual(steps[0], { kind: 'run', words: ['type', '--screen', 's', '--pid', '7', '--value', '好的，明天见'] });
  assert.equal(steps[1].kind, 'stop');
  const allowed = plan({ action_type: 'type', action_inputs: { content: 'hi\n' } }, { ...mac, allowSubmit: true });
  assert.deepEqual(allowed[1], { kind: 'run', words: ['key', '--screen', 's', '--pid', '7', '--key', 'return'] });
});

test('Enter stops unless submitting is allowed', () => {
  assert.equal(plan({ action_type: 'hotkey', action_inputs: { key: 'enter' } }, mac)[0].kind, 'stop');
  assert.equal(plan({ action_type: 'hotkey', action_inputs: { key: 'cmd enter' } }, mac)[0].kind, 'stop');
  assert.equal(plan({ action_type: 'hotkey', action_inputs: { key: 'Enter' } }, win)[0].kind, 'stop');
  const [step] = plan({ action_type: 'hotkey', action_inputs: { key: 'enter' } }, { ...win, allowSubmit: true });
  assert.ok(step.kind === 'run' && step.words.includes('enter'));
});

test('key names follow the platform', () => {
  assert.deepEqual(parseKeys('ctrl c', 'darwin'), { key: 'c', modifiers: ['cmd'] });
  assert.deepEqual(parseKeys('ctrl+c', 'win32'), { key: 'c', modifiers: ['ctrl'] });
  assert.deepEqual(parseKeys('page down', 'darwin'), { key: 'pagedown', modifiers: [] });
  assert.deepEqual(parseKeys('backspace', 'darwin'), { key: 'delete', modifiers: [] });
  assert.deepEqual(parseKeys('backspace', 'win32'), { key: 'backspace', modifiers: [] });
  assert.deepEqual(parseKeys('alt tab', 'darwin'), { key: 'tab', modifiers: ['option'] });
});

test('drag on macOS needs --foreground', () => {
  const action = { action_type: 'drag', action_inputs: { start_box: box(0.1, 0.1), end_box: box(0.2, 0.2) } };
  assert.equal(plan(action, mac)[0].kind, 'stop');
  const [step] = plan(action, { ...mac, foreground: true });
  assert.ok(step.kind === 'run' && step.words.includes('--foreground'));
  assert.equal(plan(action, win)[0].kind, 'run');
});

test('a wheel at a point needs --foreground on Windows, else keys scroll', () => {
  const action = { action_type: 'scroll', action_inputs: { start_box: box(0.5, 0.5), direction: 'down' } };
  const [onMac] = plan(action, mac);
  assert.ok(onMac.kind === 'run' && onMac.words.includes('--x') && !onMac.words.includes('--foreground'));
  const [onWindows] = plan(action, win);
  assert.ok(onWindows.kind === 'run' && !onWindows.words.includes('--x'));
  const [allowed] = plan(action, { ...win, foreground: true });
  assert.ok(allowed.kind === 'run' && allowed.words.includes('--x') && allowed.words.includes('--foreground'));
});

test('finished and call_user end the run', () => {
  assert.deepEqual(plan({ action_type: 'finished', action_inputs: { content: '最新消息是：你好' } }, mac), [
    { kind: 'stop', outcome: 'done', reason: '最新消息是：你好' },
  ]);
  assert.equal((plan({ action_type: 'call_user', action_inputs: {} }, mac)[0] as any).outcome, 'user');
});

test('boxes the parser misread are recovered from the raw text', () => {
  assert.equal(recoverBox("Action: click(start_box='[383 117]')", 'start_box'), JSON.stringify([0.383, 0.117, 0.383, 0.117]));
  assert.equal(recoverBox("click(start_box='<point>383 117</point>')", 'start_box'), JSON.stringify([0.383, 0.117, 0.383, 0.117]));
  assert.equal(
    recoverBox("drag(start_box='(100,200)', end_box='(300,400)')", 'end_box'),
    JSON.stringify([0.3, 0.4, 0.3, 0.4]),
  );
  assert.equal(recoverBox("drag(start_box='(100,200)', end_box='(300,400)')", 'start_box'), JSON.stringify([0.1, 0.2, 0.1, 0.2]));
  assert.equal(recoverBox("scroll(start_box='[500, 500]', direction='down')", 'start_box'), JSON.stringify([0.5, 0.5, 0.5, 0.5]));
  assert.equal(recoverBox("click(start_box='[383]')", 'start_box'), undefined);
  assert.equal(recoverBox('finished()', 'start_box'), undefined);
});
