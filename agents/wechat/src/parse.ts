// Reads WeChat's screen from recognised text. Everything here is pure, so it
// can be tested on text read from real screenshots.
//
// Positions are points relative to WeChat's window, which the assistant
// keeps filling a 1280x900 screen (so the window is 1280x875). Measured on
// WeChat 4.1 for Mac.

import type { Region, Word } from './screen.ts';

/** Where things sit in WeChat's window, in points. */
export const layout = {
  /** The icons down the left edge. */
  rail: { chats: { x: 29, y: 122 }, contacts: { x: 29, y: 170 } },
  /** The search box above the list, and its clear button. */
  search: { x: 179, y: 27 },
  searchClear: { x: 273, y: 27 },
  /** The sidebar list: chats, or the contacts tree. */
  sidebar: { x: 61, y: 50, w: 240, h: 825 } as Region,
  /** The 新的朋友 header in the contacts tree. */
  newFriends: { x: 113, y: 122 },
  /** The pane to the right of the sidebar. */
  pane: { x: 300, y: 0, w: 980, h: 875 } as Region,
  /** A request row: where its name, note and status sit, and its height. */
  request: { nameX: 133, statusX: 250, rowHeight: 69, noteOffset: 24 },
  /** A chat row: name and preview start here; the time sits to the right. */
  chat: { nameX: 118, timeX: 230, rowHeight: 68 },
};

/** What a 新的朋友 row says on its right: 已添加, 已过期, 等待验证, or 接受 (a button). */
export const STATUSES = ['已添加', '已过期', '等待验证', '已拒绝', '已忽略', '接受', '已发送'];

export interface Request {
  name: string;
  /** The verification message, as far as the row shows it. */
  note: string;
  status: string;
  /** Looks like a request waiting for an answer. */
  pending: boolean;
  /** The row's vertical centre, in points. */
  y: number;
}

export interface ChatRow {
  name: string;
  time: string;
  preview: string;
  y: number;
}

export const norm = (text: string) => text.replace(/\s+/g, '').replace(/[（]/g, '(').replace(/[）]/g, ')');

/** Same row when their vertical centres are close. */
const sameLine = (a: Word, b: Word, tolerance = 9) => Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < tolerance;

/**
 * The 新的朋友 rows, from the sidebar's text. Rows start below the 新的朋友
 * header and end at the next section header (群聊, 公众号…), which sits
 * further left than the names.
 */
export function requests(words: Word[]): Request[] {
  const { nameX, statusX, noteOffset } = layout.request;
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const header = sorted.find((w) => norm(w.text).includes('新的朋友'));
  if (!header) return [];
  const below = sorted.filter((w) => w.y > header.y + header.h);
  // The section after 新的朋友 starts with a header at the header's column.
  const next = below.find((w) => w.x < nameX - 20 && w.x > header.x - 15 && !STATUSES.includes(norm(w.text)));
  const rows = next ? below.filter((w) => w.y < next.y) : below;
  const names = rows.filter((w) => Math.abs(w.x - nameX) < 12 && w.h >= 11);
  const out: Request[] = [];
  let lastNameY = -Infinity;
  for (const word of names) {
    // A note sits under its name, in the same column but smaller and dimmer.
    if (word.y - lastNameY < noteOffset + 4 && word.y - lastNameY > 0) continue;
    let name = word.text.trim();
    let status = rows.find((w) => w !== word && w.x >= statusX && sameLine(w, word))?.text.trim();
    // A long name runs into its status, so Vision reads them as one line.
    if (!status) {
      const tail = STATUSES.find((s) => norm(name).endsWith(s));
      if (tail) {
        status = tail;
        name = name.slice(0, name.lastIndexOf(tail.slice(0, 1))).replace(/[\s•·.…]+$/, '').trim();
      }
    }
    const note = rows.find((w) => Math.abs(w.x - nameX) < 12 && w.y > word.y + 8 && w.y < word.y + noteOffset + 12)?.text.trim() ?? '';
    const normalised = status ? norm(status).replace(/[.…·]+$/, '') : '';
    out.push({
      name,
      note,
      status: normalised,
      pending: normalised === '接受' || normalised === '',
      y: word.y + word.h / 2,
    });
    lastNameY = word.y;
  }
  return out;
}

/** The chat list rows, from the sidebar's text, newest first as WeChat shows them. */
export function chats(words: Word[]): ChatRow[] {
  const { nameX, timeX } = layout.chat;
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const stamp = /^[\d:/\s年月日昨天前星期一二三四五六]+$/;
  const out: ChatRow[] = [];
  for (const name of sorted.filter((w) => Math.abs(w.x - nameX) < 12 && w.h >= 13)) {
    let text = name.text.trim();
    let time = sorted.find((w) => w !== name && w.x > timeX && sameLine(w, name) && stamp.test(norm(w.text)))?.text.trim();
    if (!time) {
      // A long name runs into its time, so Vision reads them as one line.
      const tail = text.match(/\s((?:昨天|星期[一二三四五六日]|\d{1,4}[/年]\d{1,2}[/月]?\d{0,2}日?)?\s?(?:\d{1,2}:\d{2})?)$/);
      if (!tail || !tail[1].trim()) continue;
      time = tail[1].trim();
      text = text.slice(0, tail.index).replace(/[\s•·.…]+$/, '').trim();
    }
    if (out.some((row) => Math.abs(row.y - (name.y + name.h / 2)) < 10)) continue;
    const preview = sorted.find((w) => Math.abs(w.x - nameX) < 12 && w.y > name.y + 8 && w.y < name.y + 36);
    out.push({ name: text, time, preview: preview?.text.trim() ?? '', y: name.y + name.h / 2 });
  }
  return out;
}

export interface Detail {
  name: string;
  wechatId?: string;
  region?: string;
  /** The request's own words, when the pane shows them. */
  message?: string;
  /** Buttons the pane offers, by their text, with their centres. */
  buttons: { text: string; x: number; y: number }[];
}

const BUTTONS = ['接受', '通过验证', '添加到通讯录', '发消息', '完成', '确定', '发送', '取消', '前往验证'];

/** The contact or request shown in the pane to the right of the sidebar. */
export function detail(words: Word[]): Detail | undefined {
  const inPane = words.filter((w) => w.x > layout.pane.x).sort((a, b) => a.y - b.y || a.x - b.x);
  if (inPane.length === 0) return undefined;
  const title = inPane.find((w) => w.h >= 14 && w.y < 120);
  if (!title) return undefined;
  const value = (label: string) => {
    const word = inPane.find((w) => norm(w.text).startsWith(label));
    if (!word) return undefined;
    const rest = norm(word.text).slice(label.length).replace(/^[:：]/, '');
    if (rest) return rest;
    // The value may be its own word, to the right.
    return inPane.find((w) => w !== word && sameLine(w, word) && w.x > word.x)?.text.trim();
  };
  const buttons = inPane
    .filter((w) => BUTTONS.includes(norm(w.text)))
    .map((w) => ({ text: norm(w.text), x: w.x + w.w / 2, y: w.y + w.h / 2 }));
  const message = inPane.find((w) => /^(验证消息|验证信息|留言|对方消息)[:：]?/.test(norm(w.text)));
  return {
    name: title.text.replace(/[\s\u2022]+$/, '').trim(),
    wechatId: value('微信号'),
    region: value('地区'),
    message: message ? norm(message.text).replace(/^(验证消息|验证信息|留言|对方消息)[:：]?/, '') : undefined,
    buttons,
  };
}

/** Whether a row's name, as the list shows it (it may be cut short with …), is this name. */
export function sameName(shown: string, full: string): boolean {
  const a = norm(shown).replace(/[.…]+$/, '');
  const b = norm(full);
  return a.length > 0 && (a === b || (a.length >= 2 && b.startsWith(a)) || (b.length >= 2 && a.startsWith(b)));
}
