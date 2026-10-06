import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planWeChat } from './setup.ts';
import { Store } from './store.ts';

test('launches WeChat when it is not running', () => {
  assert.deepEqual(planWeChat(undefined, false, undefined, false), { do: 'launch' });
});

test('uses WeChat already on the screen', () => {
  assert.deepEqual(planWeChat(42, true, undefined, false), { do: 'ready', pid: 42 });
});

test('moves its own WeChat back when the screen lost it', () => {
  assert.deepEqual(planWeChat(42, false, 42, false), { do: 'move', pid: 42 });
});

test("leaves the user's WeChat alone, unless told to take over", () => {
  assert.equal(planWeChat(42, false, 7, false).do, 'wait');
  assert.equal(planWeChat(42, false, undefined, false).do, 'wait');
  assert.deepEqual(planWeChat(42, false, 7, true), { do: 'move', pid: 42 });
});

test('the store keeps handled requests and the WeChat pid across restarts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wechat-store-')), 'nested', 'state.json');
  const first = new Store(path);
  first.add('陈一|我是陈一');
  first.wechatPid = 123;
  const again = new Store(path);
  assert.ok(again.has('陈一|我是陈一'));
  assert.ok(!again.has('李四|你好'));
  assert.equal(again.wechatPid, 123);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
