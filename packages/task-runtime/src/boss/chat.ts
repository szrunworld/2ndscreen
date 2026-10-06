// Reads an open BOSS直聘 conversation: who the candidate is, from the
// header and resume summary above the chat, and the messages, telling the
// candidate's from the recruiter's by which side the avatar is on.

import type { Element, Frame } from './parse.ts';

export interface Candidate {
  name: string;
  /** "28岁 7年 本科". */
  summary: string;
  /** Work and education lines, "2022.03-2025.08 某公司 · 前端开发工程师". */
  history: string[];
  /** The position the conversation is about. */
  position: string;
  /** "北京 · 前端开发工程师 19-25K". */
  expects: string;
}

export interface Message {
  from: 'candidate' | 'me';
  text: string;
}

export interface Chat {
  candidate: Candidate;
  messages: Message[];
  /** The message box, to type a draft into, and the Send label. */
  input?: Element;
  send?: Element;
}

const text = (e: Element) => (e.value ?? e.label ?? '').trim();
/** Delivery statuses beside the recruiter's messages. */
const STATUS = /^(送达|已读|未读|已送达)$/;
/** Timestamps between messages: "16:25", "09-14 10:55", "昨天 09:12". */
const STAMP = /^((\d{1,2}-\d{1,2}|昨天|前天|星期[一二三四五六日天])\s+)?\d{1,2}:\d{2}$/;
const local = (e: Element, w: Frame) => ({ x: e.frame!.x - w.x, y: e.frame!.y - w.y });

export function chat(elements: Element[], window: Frame): Chat | undefined {
  const framed = elements.filter((e) => e.frame);
  // The chat starts right of the conversation list.
  const pane = framed.filter((e) => local(e, window).x >= 500);
  const input = pane.find((e) => e.role === 'AXTextArea');
  if (!input) return undefined;
  const send = pane.find((e) => text(e) === '发送');
  // Icons are drawn as private-use characters; they are not text.
  const texts = pane.filter((e) => e.role === 'AXStaticText' && text(e) !== '' && !/^[\ue000-\uf8ff]+$/u.test(text(e)));

  // Header: the name is the large text at the top, the summary the line below.
  const header = texts.filter((e) => local(e, window).y < 50 && e.frame!.height >= 20);
  const name = header.sort((a, b) => a.frame!.x - b.frame!.x)[0];
  const summaryLine = texts.filter((e) => Math.abs(local(e, window).y - 62) <= 10 && local(e, window).x < 900);

  // Resume summary and messages each sit in an AXList when the reader
  // reports lists; otherwise they are found by where they sit: the history
  // in the left half below the header, the messages between the first
  // timestamp and the row of quick actions above the message box.
  const lists = framed.filter((e) => e.role === 'AXList').sort((a, b) => a.frame!.y - b.frame!.y);
  const box = (x: number, y: number, right: number, bottom: number): Frame =>
    ({ x, y, width: right - x, height: bottom - y });
  const historyList = lists.find((l) => local(l, window).y < 220)?.frame
    ?? box(window.x + 520, window.y + 105, window.x + 900, window.y + 215);
  const actions = texts.find((e) => ['求简历', '换电话', '不合适'].includes(text(e)));
  const firstStamp = texts.filter((e) => STAMP.test(text(e)) && local(e, window).y > 150)
    .sort((a, b) => a.frame!.y - b.frame!.y)[0];
  const messageList = lists.find((l) => local(l, window).y >= 200)?.frame
    ?? box(window.x + 500, (firstStamp?.frame!.y ?? window.y + 220) - 4,
      window.x + window.width - 57, (actions ?? input).frame!.y - 4);
  const within = (e: Element, area: Frame) => e.frame!.y >= area.y - 4 && e.frame!.y < area.y + area.height
    && e.frame!.x >= area.x - 4 && e.frame!.x < area.x + area.width;
  const history = lines(texts.filter((e) => within(e, historyList)));
  const after = (label: string) => {
    const at = texts.find((e) => text(e).startsWith(label));
    if (!at) return '';
    return texts
      .filter((e) => Math.abs(e.frame!.y - at.frame!.y) <= 4 && e.frame!.x > at.frame!.x)
      .sort((a, b) => a.frame!.x - b.frame!.x).map(text).join(' ').trim();
  };

  // Messages: the candidate's sit right of their avatar on the left; the
  // recruiter's have no avatar and are pushed against the right edge, with
  // a delivery status (送达, 已读) beside them. Times, statuses and system
  // cards in the middle are neither.
  const avatars = framed.filter((e) => e.role === 'AXImage' && within(e, messageList))
    .filter((e) => e.frame!.x < messageList.x + messageList.width / 2);
  const right = messageList.x + messageList.width;
  const said: { from: Message['from']; y: number; x: number; text: string }[] = [];
  for (const e of texts.filter((e) => within(e, messageList))) {
    const t = text(e);
    if (STATUS.test(t) || STAMP.test(t)) continue;
    const besideAvatar = avatars.some((a) => e.frame!.x > a.frame!.x + a.frame!.width
      && e.frame!.x - (a.frame!.x + a.frame!.width) < 60
      && e.frame!.y >= a.frame!.y - 15 && e.frame!.y < a.frame!.y + a.frame!.height + 30);
    const againstRight = right - (e.frame!.x + e.frame!.width) < 70;
    if (besideAvatar) said.push({ from: 'candidate', y: e.frame!.y, x: e.frame!.x, text: t });
    else if (againstRight) said.push({ from: 'me', y: e.frame!.y, x: e.frame!.x, text: t });
  }
  // A long message wraps into several texts; join lines of the same bubble.
  const messages: Message[] = [];
  for (const line of said.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = messages.at(-1) as (Message & { y?: number }) | undefined;
    if (last && last.from === line.from && last.y !== undefined && line.y - last.y < 24) {
      last.text += line.text;
      last.y = line.y;
    } else {
      messages.push({ from: line.from, text: line.text, y: line.y } as Message);
    }
  }
  for (const m of messages) delete (m as { y?: number }).y;

  return {
    candidate: {
      name: name ? text(name) : '',
      summary: summaryLine.sort((a, b) => a.frame!.x - b.frame!.x).map(text).join(' '),
      history,
      position: after('沟通职位'),
      expects: after('期望'),
    },
    messages,
    input,
    send,
  };
}

/** Texts grouped into lines by height on screen, left to right. */
function lines(texts: Element[]): string[] {
  const rows = new Map<number, Element[]>();
  for (const e of texts) {
    const key = [...rows.keys()].find((y) => Math.abs(y - e.frame!.y) <= 4) ?? e.frame!.y;
    rows.set(key, [...(rows.get(key) ?? []), e]);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((a, b) => a.frame!.x - b.frame!.x).map(text).join(' '));
}
