import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chat } from './chat.ts';

// An open conversation as `2ndscreen state` read it, with the candidate made up.
const open = JSON.parse(readFileSync(new URL('./fixtures/chat.json', import.meta.url), 'utf8'));

test('reads the candidate from the header and resume summary', () => {
  assert.deepEqual(chat(open.elements, open.windowFrame)!.candidate, {
    name: '陈一',
    summary: '30岁 6年 本科',
    history: ['2024.01-2026.01 示例科技 · 前端工程师', '2020.01-2023.12 样例网络 · 前端工程师', '2014-2018 某某大学 · 软件工程 · 本科'],
    position: '前端工程师',
    expects: '上海 · 前端工程师 20-30K',
  });
});

test('reads both sides of the conversation, not timestamps, statuses or system cards', () => {
  // The recruiter's message has no avatar: it sits against the right edge,
  // with its delivery status (送达) beside it.
  assert.deepEqual(chat(open.elements, open.windowFrame)!.messages, [
    { from: 'candidate', text: '您好，我看了这个职位，觉得比较匹配，想进一步沟通。' },
    { from: 'candidate', text: '请问这个岗位还在招吗？' },
    { from: 'me', text: '方便发一份简历吗？' },
  ]);
});

test('finds the message box and the Send label', () => {
  const c = chat(open.elements, open.windowFrame)!;
  assert.equal(c.input?.role, 'AXTextArea');
  assert.equal(c.send?.value, '发送');
});

test('a list with no conversation open is not a chat', () => {
  const list = JSON.parse(readFileSync(new URL('./fixtures/list.json', import.meta.url), 'utf8'));
  assert.equal(chat(list.elements, list.windowFrame), undefined);
});

// The same kind of read from 2ndscreen's own reader, which reports text as
// labels and no AXList containers; the candidate and messages made up.
const labelled = JSON.parse(readFileSync(new URL('./fixtures/chat-labels.json', import.meta.url), 'utf8'));

test('reads a conversation from a reader that reports labels and no lists', () => {
  const c = chat(labelled.elements, labelled.windowFrame)!;
  assert.deepEqual(c.candidate, {
    name: '周三',
    summary: '27岁 4年 本科',
    history: ['2025.01-至今 示例科技 · 全栈工程师', '2022.01-2024.12 样例网络 · 移动端开发', '2017-2021 某某大学 · 信息管理 · 本科'],
    position: '前端工程师',
    expects: '杭州 · Android 面议',
  });
  assert.deepEqual(c.messages, [
    { from: 'candidate', text: '您好，在吗' },
    { from: 'me', text: '收到' },
  ]);
  assert.equal(c.input?.role, 'AXTextArea');
  assert.equal(c.send?.value ?? c.send?.label, '发送');
});
