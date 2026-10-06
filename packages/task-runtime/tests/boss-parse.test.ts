import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { conversations } from '../src/boss/parse.ts';

// The message list as `2ndscreen state` read it, with names and messages made up.
const list = JSON.parse(readFileSync(new URL('./fixtures/boss/list.json', import.meta.url), 'utf8'));

test('reads each row of the message list', () => {
  const rows = conversations(list.elements, list.windowFrame);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[0], {
    name: '陈一', position: '前端工程师', time: '16:25', unread: 2,
    preview: '示例消息：我对这个岗位感兴趣', index: rows[0]?.index,
  });
  assert.deepEqual(rows.map((r) => r.unread), [2, 2, 2, 2, 2, 1, 2, 1, 1, 1]);
  assert.deepEqual(rows.slice(5, 9).map((r) => r.time), ['13:26', '12:20', '11:17', '10:38']);
});

test('a row cut off at the bottom still has its name', () => {
  const last = conversations(list.elements, list.windowFrame).at(-1)!;
  assert.equal(last.name, '韩十一');
  assert.equal(last.preview, '');
});

test('the tabs above the list are not rows', () => {
  const names = conversations(list.elements, list.windowFrame).map((r) => r.name);
  for (const tab of ['全部', '未读', '新招呼', '沟通中', '批量']) assert.ok(!names.includes(tab));
});
