import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planAndroid, type AndroidContext } from './android.ts';

const phone: AndroidContext = { serial: 'p1', size: { width: 1000, height: 2000 }, allowSubmit: false };
const box = (x: number, y: number) => JSON.stringify([x, y, x, y]);
const words = (steps: ReturnType<typeof planAndroid>) => steps.map((s) => (s.kind === 'run' ? s.words.join(' ') : s.kind));

test('taps land in device pixels', () => {
  assert.deepEqual(words(planAndroid({ action_type: 'click', action_inputs: { start_box: box(0.5, 0.25) } }, phone)), [
    'android tap --x 500 --y 500 --serial p1',
  ]);
  const unnamed = { ...phone, serial: undefined };
  assert.deepEqual(words(planAndroid({ action_type: 'click', action_inputs: { start_box: box(0, 1) } }, unnamed)), ['android tap --x 0 --y 2000']);
});

test('a long press holds in place', () => {
  assert.deepEqual(words(planAndroid({ action_type: 'long_press', action_inputs: { start_box: box(0.1, 0.1) } }, phone)), [
    'android swipe --x 100 --y 200 --to-x 100 --to-y 200 --duration 0.8 --serial p1',
  ]);
});

test('scrolling down moves the finger up', () => {
  const [down] = planAndroid({ action_type: 'scroll', action_inputs: { start_box: box(0.5, 0.5), direction: 'down' } }, phone);
  assert.ok(down.kind === 'run');
  const at = (flag: string) => Number(down.words[down.words.indexOf(flag) + 1]);
  assert.ok(at('--y') > at('--to-y'));
  assert.equal(at('--x'), at('--to-x'));
  const [left] = planAndroid({ action_type: 'scroll', action_inputs: { direction: 'left' } }, phone);
  assert.ok(left.kind === 'run');
  const x = (flag: string) => Number(left.words[left.words.indexOf(flag) + 1]);
  assert.ok(x('--x') < x('--to-x'));
});

test('typing that would submit stops instead, unless allowed', () => {
  for (const content of ['好的，明天见\\n', '好的，明天见\n']) {
    const steps = planAndroid({ action_type: 'type', action_inputs: { content } }, phone);
    assert.deepEqual(words(steps), ['android type --text 好的，明天见 --serial p1', 'stop']);
    const allowed = planAndroid({ action_type: 'type', action_inputs: { content } }, { ...phone, allowSubmit: true });
    assert.deepEqual(words(allowed), ['android type --text 好的，明天见 --serial p1', 'android key --key enter --serial p1']);
  }
  assert.deepEqual(words(planAndroid({ action_type: 'hotkey', action_inputs: { key: 'enter' } }, phone)), ['stop']);
});

test('navigation keys', () => {
  assert.deepEqual(words(planAndroid({ action_type: 'press_back', action_inputs: {} }, phone)), ['android key --key back --serial p1']);
  assert.deepEqual(words(planAndroid({ action_type: 'press_home', action_inputs: {} }, phone)), ['android key --key home --serial p1']);
  assert.deepEqual(words(planAndroid({ action_type: 'hotkey', action_inputs: { key: 'esc' } }, phone)), ['android key --key back --serial p1']);
});

test('the run ends with the model', () => {
  const [done] = planAndroid({ action_type: 'finished', action_inputs: { content: '最新消息是：你好' } }, phone);
  assert.deepEqual(done, { kind: 'stop', outcome: 'done', reason: '最新消息是：你好' });
  const [help] = planAndroid({ action_type: 'call_user', action_inputs: {} }, phone);
  assert.ok(help.kind === 'stop' && help.outcome === 'user');
  const [bad] = planAndroid({ action_type: 'click', action_inputs: { start_box: 'nonsense' } }, phone);
  assert.ok(bad.kind === 'stop' && bad.outcome === 'user');
});
