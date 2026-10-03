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

  // Resume summary: a list of history lines, dates then place, and the
  // position and expectations beside it.
  const lists = framed.filter((e) => e.role === 'AXList').sort((a, b) => a.frame!.y - b.frame!.y);
  const historyList = lists.find((l) => local(l, window).y < 220);
  const messageList = lists.find((l) => local(l, window).y >= 200);
  const within = (e: Element, box?: Element) => !!box && e.frame!.y >= box.frame!.y - 4
    && e.frame!.y < box.frame!.y + box.frame!.height && e.frame!.x >= box.frame!.x - 4
    && e.frame!.x < box.frame!.x + box.frame!.width;
  const history = lines(texts.filter((e) => within(e, historyList)));
  const after = (label: string) => {
    const at = texts.find((e) => text(e).startsWith(label));
    if (!at) return '';
    return texts
      .filter((e) => Math.abs(e.frame!.y - at.frame!.y) <= 4 && e.frame!.x > at.frame!.x)
      .sort((a, b) => a.frame!.x - b.frame!.x).map(text).join(' ').trim();
  };

  // Messages: each bubble sits beside an avatar; the candidate's avatar is
  // on the left of the pane, the recruiter's on the right.
  const middle = messageList ? messageList.frame!.x + messageList.frame!.width / 2 : window.x + 860;
  const avatars = framed.filter((e) => e.role === 'AXImage' && within(e, messageList));
  const bubbles = texts.filter((e) => within(e, messageList));
  const messages: Message[] = [];
  for (const avatar of avatars.sort((a, b) => a.frame!.y - b.frame!.y)) {
    const left = avatar.frame!.x < middle;
    const said = bubbles.filter((e) => e.frame!.y >= avatar.frame!.y - 15 && e.frame!.y < avatar.frame!.y + avatar.frame!.height + 30
      && (left ? e.frame!.x > avatar.frame!.x : e.frame!.x < avatar.frame!.x));
    const words = said.sort((a, b) => a.frame!.y - b.frame!.y || a.frame!.x - b.frame!.x).map(text).join('');
    if (words) messages.push({ from: left ? 'candidate' : 'me', text: words });
  }

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
