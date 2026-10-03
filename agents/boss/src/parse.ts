// Reads BOSS直聘's message list out of the accessibility elements that
// `2ndscreen state` returns. The list is flat text, one row per contact:
// an unread count, the name, the position and the time on one line, and the
// latest message on the next. Rows are told apart by where the time sits.

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Element {
  index: number;
  role: string;
  label?: string;
  value?: string;
  frame?: Frame;
}

export interface Conversation {
  name: string;
  position: string;
  time: string;
  unread: number;
  preview: string;
  /** The element to click to open the conversation. */
  index: number;
}

/** "16:25", "昨天", "星期三", "09月03日", "2025年09月03日". */
const TIME = /^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月\d{1,2}日)$/;

const text = (e: Element) => (e.value ?? e.label ?? '').trim();

/**
 * The conversations in the list, top to bottom. `window` is the BOSS直聘
 * window's frame; the list is the column between `left` and `right` of it,
 * in points from the window's left edge.
 */
export function conversations(elements: Element[], window: Frame, left = 140, right = 520): Conversation[] {
  const inList = elements.filter(
    (e) => e.role === 'AXStaticText' && e.frame && text(e) !== ''
      && e.frame.x >= window.x + left && e.frame.x < window.x + right,
  );
  const times = inList.filter((e) => TIME.test(text(e)) && e.frame!.x > window.x + right - 140);
  return times.map((time) => {
    const top = time.frame!.y;
    const row = inList.filter((e) => e !== time && e.frame!.y >= top - 12 && e.frame!.y < top + 45);
    const firstLine = row.filter((e) => Math.abs(e.frame!.y - top) <= 8).sort((a, b) => a.frame!.x - b.frame!.x);
    const secondLine = row.filter((e) => e.frame!.y - top > 8).sort((a, b) => a.frame!.x - b.frame!.x);
    // The unread badge sits a little above the line, left of the name.
    const badge = row.find((e) => /^\d{1,3}$/.test(text(e)) && e.frame!.y < top);
    const words = firstLine.filter((e) => e !== badge);
    const name = words[0];
    return {
      name: name ? text(name) : '',
      position: words.slice(1).map(text).join(' '),
      time: text(time),
      unread: badge ? Number(text(badge)) : 0,
      preview: secondLine.map(text).join(' '),
      index: name ? name.index : time.index,
    };
  }).filter((c) => c.name !== '');
}
