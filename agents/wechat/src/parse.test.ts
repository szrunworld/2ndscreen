// Geometry measured on WeChat 4.1 filling a 1280x900 screen; names and
// messages are made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chats, detail, requests, sameName } from './parse.ts';
import type { Word } from './screen.ts';

const word = (text: string, x: number, y: number, w = text.length * 12, h = 15): Word => ({ text, x, y, w, h, confidence: 1 });

function sidebarWithRequests(): Word[] {
  return [
    word('搜索', 97, 23, 24, 13),
    word('通讯录管理', 159, 62, 70, 15),
    word('新的朋友', 75, 114, 76, 17),
    // A request waiting for an answer: a green 接受 button on the right.
    word('陈一', 133, 160, 42, 16), word('接受', 258, 164, 30, 10), word('我是陈一，BOSS直聘看到的', 133, 184, 140, 13),
    // Already added.
    word('Lin Er', 133, 230, 43, 13), word('已添加.', 258, 232, 30, 11), word('我是 Lin Er', 133, 253, 62, 13),
    // A long name runs into its status.
    word('York•张三 at dy..• 已添加', 133, 506, 155, 16), word('我：我是"Chinese founder..', 132, 529, 154, 13),
    // Expired.
    word('HH', 133, 575, 23, 14), word('已过期', 258, 577, 29, 10), word('我：我是"Chinese founder..', 133, 598, 152, 14),
    // The next section.
    word('群聊', 75, 660, 30, 16), word('23', 270, 662, 16, 12),
    word('某个群', 133, 700, 42, 15),
  ];
}

test('reads 新的朋友 rows, their notes and statuses', () => {
  const rows = requests(sidebarWithRequests());
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.pending, r.note]), [
    ['陈一', '接受', true, '我是陈一，BOSS直聘看到的'],
    ['Lin Er', '已添加', false, '我是 Lin Er'],
    ['York•张三 at dy', '已添加', false, '我：我是"Chinese founder..'],
    ['HH', '已过期', false, '我：我是"Chinese founder..'],
  ]);
  assert.ok(Math.abs(rows[0].y - 168) < 2);
});

test('rows stop at the next section, and a collapsed list reads as empty', () => {
  assert.equal(requests(sidebarWithRequests()).some((r) => r.name === '某个群'), false);
  assert.deepEqual(requests([word('新的朋友', 75, 114), word('群聊', 75, 170), word('联系人', 75, 226)]), []);
  assert.deepEqual(requests([word('聊天', 118, 100)]), []);
});

test('a row with no status is a candidate until its colour says otherwise', () => {
  const rows = requests([word('新的朋友', 75, 114), word('王五', 133, 160), word('你好', 133, 184)]);
  assert.equal(rows[0].pending, true);
  assert.equal(rows[0].status, '');
});

test('reads the chat list', () => {
  const rows = chats([
    word('搜索', 150, 23),
    word('陈一', 118, 70, 40, 16), word('20:19', 255, 72, 36, 12), word('"陈一" 拍了拍我', 118, 95, 150, 13),
    word('Some Group', 118, 138, 120, 16), word('昨天 14:07', 240, 140, 60, 12), word('李四: 好的', 118, 163, 100, 13),
    word('文件传输助手', 118, 206, 90, 16), word('星期日', 262, 208, 30, 12),
    word('HopInnovations~Al... 19:47', 118, 274, 170, 16), word('能不能约个电话', 118, 299, 100, 13),
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.time, r.preview]), [
    ['陈一', '20:19', '"陈一" 拍了拍我'],
    ['Some Group', '昨天 14:07', '李四: 好的'],
    ['文件传输助手', '星期日', ''],
    ['HopInnovations~Al', '19:47', '能不能约个电话'],
  ]);
});

test('reads the pane: name, WeChat ID, region and buttons', () => {
  const seen = detail([
    word('陈一 2', 708, 72, 66, 17), word('•••', 924, 75, 15, 5),
    word('微信号：wxid_abc123', 707, 102, 179, 13), word('地区：中国大陆', 707, 120, 83, 13),
    word('验证消息：我是陈一，BOSS直聘看到的', 707, 150, 200, 13),
    word('备注', 631, 199, 28, 15), word('添加备注名', 705, 198, 72, 15),
    word('通过验证', 760, 530, 48, 16),
  ]);
  assert.ok(seen);
  assert.equal(seen.name, '陈一 2');
  assert.equal(seen.wechatId, 'wxid_abc123');
  assert.equal(seen.region, '中国大陆');
  assert.equal(seen.message, '我是陈一，BOSS直聘看到的');
  assert.deepEqual(seen.buttons, [{ text: '通过验证', x: 784, y: 538 }]);
  assert.equal(detail([word('新的朋友', 75, 114)]), undefined);
});

test('a value may be its own word to the right of its label', () => {
  const seen = detail([word('陈一', 708, 72, 40, 17), word('微信号', 707, 102, 40, 13), word('abc_123', 760, 102, 60, 13)]);
  assert.equal(seen?.wechatId, 'abc_123');
});

test('matches a name the list cut short', () => {
  assert.ok(sameName('York•张三 at dy…', 'York•张三 at dynamics'));
  assert.ok(sameName('陈一', '陈一'));
  assert.ok(sameName('陈一 2', '陈一'));
  assert.ok(!sameName('陈一', '李四'));
  assert.ok(!sameName('', '李四'));
});
