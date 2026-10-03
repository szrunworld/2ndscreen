import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planBoss } from './setup.ts';
import { Store } from './store.ts';

test('launches BOSS直聘 when it is not running', () => {
  assert.deepEqual(planBoss(undefined, false, undefined, false), { do: 'launch' });
});

test('uses BOSS直聘 already on the screen', () => {
  assert.deepEqual(planBoss(42, true, undefined, false), { do: 'ready', pid: 42 });
});

test('moves its own BOSS直聘 back when the screen lost it', () => {
  assert.deepEqual(planBoss(42, false, 42, false), { do: 'move', pid: 42 });
});

test('leaves a BOSS直聘 it did not launch alone, unless told to take over', () => {
  assert.equal(planBoss(42, false, 7, false).do, 'wait');
  assert.equal(planBoss(42, false, undefined, false).do, 'wait');
  assert.deepEqual(planBoss(42, false, 7, true), { do: 'move', pid: 42 });
});

test('the store keeps what was handled across restarts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'boss-store-')), 'nested', 'state.json');
  const first = new Store(path);
  first.add('陈一|16:25|你好');
  first.bossPid = 123;
  const again = new Store(path);
  assert.ok(again.has('陈一|16:25|你好'));
  assert.ok(!again.has('林二|16:25|你好'));
  assert.equal(again.bossPid, 123);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('the store keeps only the newest entries', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'boss-store-')), 'state.json');
  const store = new Store(path, 3);
  for (const k of ['a', 'b', 'c', 'd']) store.add(k);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).handled, ['b', 'c', 'd']);
  assert.ok(!store.has('a'));
});

test('a missing or broken state file starts empty', () => {
  assert.ok(!new Store('/nonexistent/dir/state.json').has('x'));
});
