// What BOSS直聘 is showing, read from the accessibility tree of one
// observation. Layout facts come from the P0 survey on macOS (BOSS 1.7.4):
// the online resume opens as an overlay whose body is one AXImage inside an
// AXWebArea, with 收藏/转发/举报/继续沟通 beside it and an unlabelled close
// control at its top right; the request-resume confirm reads
// 确定向牛人请求简历… with 取消 and 确认 buttons. Nothing here acts.

import {
  RuntimeError,
  rectContains,
  type BossPageClass,
  type Observation,
  type Rect,
  type UIElement,
} from '../../../../packages/task-runtime/src/contracts.ts';
import { chat } from '../chat.ts';
import { conversations, type Element, type Frame } from '../parse.ts';

export const text = (e: Pick<UIElement, 'label' | 'value'>): string => (e.value ?? e.label ?? '').trim();

/** Both readers report text as value or label; either may carry it. */
const texts = (e: UIElement): string[] => [e.value, e.label].filter((t): t is string => typeof t === 'string').map((t) => t.trim());

export const MARKERS = {
  login: /扫码登录|验证码登录|密码登录|登录\/注册|请先登录/,
  captcha: /安全验证|拖动滑块|请完成验证|人机验证|点击按钮进行验证/,
  /** The confirm BOSS shows before it would send a request for a resume. */
  requestDialog: /确定向牛人(请求|索取)简历|请求简历并回复|向牛人(请求|索取)附件简历/,
  resumeLoading: /正在加载简历/,
  /** 收藏/转发/举报 sit beside an open online resume. */
  resumeActions: /举报/,
  emptyList: /^暂无(牛人|沟通|联系人|消息)/,
  listEnd: /^没有更多(了|牛人|消息)?$/,
} as const;

/** Rows of the message list, as the existing assistant reads them. */
export function listRows(observation: Observation) {
  return conversations((observation.elements ?? []) as Element[], observation.window.frame as Frame);
}

/** Activity notes BOSS shows beside a name: on the conversation header line and in the resume image header. */
export const ACTIVITY_NOTE = /^(刚刚活跃|今日活跃|昨日活跃|本周活跃|本月活跃|半年内活跃|\d+(日|天|周|月)内活跃|在线)$/;

/**
 * The candidate's name in the open conversation's header. BOSS 1.7.4 may
 * report it as one text per character (P0: a 3-character name as three
 * AXStaticText 22x24 at window-relative 531, 553 and 575, y 23), so it is
 * built from the large texts at the top of the chat pane: icons and an
 * activity note are left out, and every remaining one must sit on one line,
 * each starting where the one before it ends. Texts on another line, or
 * with a gap between them, make the header unreadable rather than guessed.
 */
export function chatHeaderName(observation: Observation): { name: string } | { reason: 'no_name' | 'two_lines' | 'gap' } {
  const win = observation.window.frame;
  const parts = (observation.elements ?? [])
    .filter((e) => e.role === 'AXStaticText' && e.frame && e.frame.x - win.x >= 500 && e.frame.y - win.y < 50 && e.frame.height >= 20)
    .filter((e) => text(e) !== '' && !/^[\uE000-\uF8FF\s]+$/.test(text(e)) && !ACTIVITY_NOTE.test(text(e)))
    .sort((a, b) => a.frame!.x - b.frame!.x);
  if (!parts.length) return { reason: 'no_name' };
  const first = parts[0]!.frame!;
  if (parts.some((e) => Math.abs(e.frame!.y - first.y) > 3 || Math.abs(e.frame!.height - first.height) > 3)) return { reason: 'two_lines' };
  for (let i = 1; i < parts.length; i++) {
    const before = parts[i - 1]!.frame!;
    const gap = parts[i]!.frame!.x - (before.x + before.width);
    if (gap < -1 || gap > 2) return { reason: 'gap' };
  }
  return { name: parts.map(text).join('') };
}

/**
 * The open conversation, as the existing assistant reads it, with the
 * candidate's name taken from the whole header (chatHeaderName) rather than
 * its first text; an unreadable header gives no name.
 */
export function openChat(observation: Observation) {
  const open = chat((observation.elements ?? []) as Element[], observation.window.frame as Frame);
  if (!open) return undefined;
  const header = chatHeaderName(observation);
  return { ...open, candidate: { ...open.candidate, name: 'name' in header ? header.name : '' } };
}

const area = (r: Rect) => r.width * r.height;
const inside = (inner: Rect, outer: Rect, slack = 2) =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack
  && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

export interface ResumeOverlay {
  /** The resume body: the AXImage the text is drawn in, in global points. */
  pane: Rect;
  image: UIElement;
  /** The overlay group holding the pane and its action column, if reported. */
  group?: UIElement;
  /** The control that closes the overlay, if one can be told apart. */
  close?: UIElement;
  loading: boolean;
}

/**
 * The online-resume overlay: an AXWebArea smaller than the window holding
 * an AXImage that fills most of it, with the 举报 action beside it.
 */
export function resumeOverlay(observation: Observation): ResumeOverlay | undefined {
  const elements = observation.elements ?? [];
  const win = observation.window.frame;
  const loading = elements.some((e) => MARKERS.resumeLoading.test(text(e)));
  const group = elements.find((e) => e.role === 'AXGroup' && e.frame && MARKERS.resumeActions.test(e.label ?? '') && area(e.frame) < area(win) * 0.95);
  const actions = elements.some((e) => texts(e).some((t) => t === '举报'));
  for (const web of elements) {
    const box = web.frame;
    if (web.role !== 'AXWebArea' || !box || area(box) >= area(win) * 0.9) continue;
    const image = elements.find((e) => e.role === 'AXImage' && e.frame && inside(e.frame, box) && area(e.frame) >= area(box) * 0.6);
    if (!image?.frame || !(group || actions)) continue;
    return { pane: image.frame, image, group, close: closeControl(elements, group?.frame ?? box), loading };
  }
  if (loading) {
    const fallback = group?.frame ?? win;
    return { pane: fallback, image: { index: -1, role: 'AXImage', frame: fallback }, group, close: group?.frame ? closeControl(elements, group.frame) : undefined, loading };
  }
  return undefined;
}

/** The app window's own title-bar buttons; never taken for an overlay's close. */
const WINDOW_CHROME = /AXCloseButton|AXMinimizeButton|AXFullScreenButton|AXZoomButton/;

/**
 * The overlay's close control, only if exactly one candidate sits at the
 * overlay's top right (P0 clicked a ~30 pt square just past its right edge):
 * one control there labelled 关闭/close, or else one unlabelled square.
 * Window chrome is never a candidate; several candidates are ambiguous and
 * give none, so the caller falls back to a bounded Escape instead of guessing.
 */
function closeControl(elements: UIElement[], overlay: Rect): UIElement | undefined {
  const right = overlay.x + overlay.width;
  const zone: Rect = { x: right - 60, y: overlay.y - 4, width: 120, height: 64 };
  const near = elements.filter((e) => e.frame && !WINDOW_CHROME.test(e.role)
    && rectContains(zone, { x: e.frame.x + e.frame.width / 2, y: e.frame.y + e.frame.height / 2 }));
  const named = near.filter((e) => /^(关闭|close)$/i.test(text(e)) && e.role !== 'AXStaticText');
  if (named.length) return named.length === 1 ? named[0] : undefined;
  const squares = near.filter((e) => (e.role === 'AXGroup' || e.role === 'AXButton') && !text(e)
    && e.frame!.width >= 16 && e.frame!.width <= 48 && Math.abs(e.frame!.width - e.frame!.height) <= 8);
  return squares.length === 1 ? squares[0] : undefined;
}

export interface RequestDialog {
  cancel?: UIElement;
  /** Located only so it can be refused; never clicked. */
  confirm?: UIElement;
}

/** The request-resume confirm, if one is showing. */
export function requestDialog(observation: Observation): RequestDialog | undefined {
  const elements = observation.elements ?? [];
  const prompt = elements.find((e) => MARKERS.requestDialog.test(text(e)));
  if (!prompt) return undefined;
  const button = (label: RegExp) => elements.find((e) => (e.role === 'AXButton' || e.role === 'AXStaticText') && label.test(text(e)) && near(e, prompt));
  return { cancel: button(/^取消$/), confirm: button(/^(确认|确定)$/) };
}

const near = (e: UIElement, anchor: UIElement) =>
  !e.frame || !anchor.frame || (Math.abs(e.frame.y - anchor.frame.y) < 200 && Math.abs(e.frame.x - anchor.frame.x) < 300);

/**
 * The attachment preview. Not seen in P0 (the account had no received
 * attachment), so this is the assumed shape: a pane larger than a dialog
 * with a 下载 control, while the message box is covered or absent.
 */
export function attachmentPreview(observation: Observation): { download?: UIElement; pane?: Rect } | undefined {
  const elements = observation.elements ?? [];
  const title = elements.some((e) => /附件简历预览|^预览附件简历$/.test(text(e)));
  const download = elements.find((e) => text(e) === '下载' && e.role !== 'AXImage');
  if (!title && !download) return undefined;
  const win = observation.window.frame;
  const pane = elements.find((e) => (e.role === 'AXWebArea' || e.role === 'AXImage') && e.frame && area(e.frame) < area(win) * 0.9 && area(e.frame) > area(win) * 0.2);
  if (!title && !pane) return undefined;
  return { download, pane: pane?.frame };
}

/** One icon-font glyph (a private-use character), such as the filter's arrow \ue603. */
const ICON_GLYPH = /^[\uE000-\uF8FF]$/;

/**
 * The open job menu: while it shows, the filter label is replaced by a
 * search field across the top of the list column (P0, BOSS 1.7.4: an
 * AXTextField at window-relative 140,20, 303x34). The menu does not close on
 * Escape, nor on pressing its arrow again; choosing an option closes it.
 */
export function jobMenu(observation: Observation): { search: UIElement } | undefined {
  const win = observation.window.frame;
  const search = (observation.elements ?? []).find((e) => e.role === 'AXTextField' && e.frame
    && e.frame.x - win.x >= 120 && e.frame.x - win.x < 200 && e.frame.y - win.y < 50 && e.frame.width >= 150);
  return search ? { search } : undefined;
}

/**
 * The filter above the message list: 全部职位 or the job it is set to. None
 * while the job menu is open: the label is gone then, and the first text
 * left in the bar is the arrow's glyph, which is no job (P0).
 */
export function jobFilter(observation: Observation): UIElement | undefined {
  if (jobMenu(observation)) return undefined;
  const win = observation.window.frame;
  return (observation.elements ?? [])
    .filter((e) => e.role === 'AXStaticText' && e.frame && text(e).length > 1 && !ICON_GLYPH.test(text(e)))
    .filter((e) => e.frame!.x - win.x >= 140 && e.frame!.x - win.x < 420 && e.frame!.y - win.y < 50)
    .sort((a, b) => a.frame!.x - b.frame!.x)[0];
}

/**
 * The arrow that opens the job menu (P0: an AXGroup at window-relative
 * 416,31, 12x12, declaring AXPress; a direct AXPress opens the menu, while
 * event clicks on it, the label or its parent do nothing). Found only inside
 * the smallest group around the filter label: exactly one small square
 * group or button right of the label, with no text but at most its glyph.
 */
export function jobFilterCaret(observation: Observation): { caret: UIElement } | { reason: 'no_filter' | 'no_filter_group' | 'caret_missing' | 'caret_ambiguous' } {
  const label = jobFilter(observation);
  if (!label?.frame) return { reason: 'no_filter' };
  const win = observation.window.frame;
  const elements = observation.elements ?? [];
  const group = elements
    .filter((e) => e.role === 'AXGroup' && e.frame && e.frame.y - win.y < 60 && e.frame.height <= 60 && e.frame.width < 520
      && inside(label.frame!, e.frame, 0))
    .sort((a, b) => area(a.frame!) - area(b.frame!))[0];
  if (!group?.frame) return { reason: 'no_filter_group' };
  const right = label.frame.x + label.frame.width;
  const carets = elements.filter((e) => e !== group && (e.role === 'AXGroup' || e.role === 'AXButton') && e.frame
    && inside(e.frame, group.frame!, 0) && e.frame.x >= right
    && e.frame.width >= 6 && e.frame.width <= 24 && Math.abs(e.frame.width - e.frame.height) <= 4
    && (text(e) === '' || ICON_GLYPH.test(text(e))));
  if (carets.length !== 1) return { reason: carets.length ? 'caret_ambiguous' : 'caret_missing' };
  return { caret: carets[0]! };
}

/**
 * The open menu's options: texts in its column below the search field (P0:
 * x 155 relative, under the field). The list's own rows stay in the tree
 * behind the menu (badges at 166, names at 192, jobs at 240), so the column
 * and width keep them out, and a caller that saw the menu open also drops
 * any text that was already there before (`before`, text@place).
 */
export function jobMenuOptions(observation: Observation, before?: ReadonlySet<string>): UIElement[] {
  const menu = jobMenu(observation);
  if (!menu?.search.frame) return [];
  const win = observation.window.frame;
  const below = menu.search.frame.y + menu.search.frame.height;
  return (observation.elements ?? []).filter((e) => e.role === 'AXStaticText' && e.frame && text(e).length > 1
    && !ICON_GLYPH.test(text(e)) && e.frame.x - win.x >= 145 && e.frame.x - win.x < 175 && e.frame.width >= 16
    && e.frame.y >= below && !before?.has(placed(e)));
}

/** An element's text at its place, to tell a text that appeared from one that was already there. */
export const placed = (e: Pick<UIElement, 'label' | 'value' | 'frame'>): string =>
  `${text(e)}@${Math.round(e.frame?.x ?? -1)},${Math.round(e.frame?.y ?? -1)}`;

export const ALL_JOBS = '全部职位';

export function classifyPage(observation: Observation): BossPageClass {
  const elements = observation.elements ?? [];
  const all = elements.flatMap(texts);
  if (all.some((t) => MARKERS.captcha.test(t))) return 'captcha';
  if (requestDialog(observation)) return 'request_resume_dialog';
  const overlay = resumeOverlay(observation);
  if (overlay?.loading) return 'loading';
  if (overlay) return 'online_resume';
  if (attachmentPreview(observation)) return 'attachment_preview';
  const opened = openChat(observation);
  const rows = listRows(observation);
  const listShown = rows.length > 0 || jobFilter(observation) !== undefined;
  if (!opened && !listShown && all.some((t) => MARKERS.login.test(t))) return 'login';
  if (elements.some((e) => e.role === 'AXSheet' || e.role === 'AXDialog')) return 'popup';
  if (opened) return 'conversation_detail';
  if (listShown) return 'conversation_list';
  if (all.some((t) => /加载中/.test(t))) return 'loading';
  return 'unknown';
}

/**
 * Labels this workflow will never click, whatever page it thinks it is on:
 * anything that sends, requests, greets, reports or changes a candidate's
 * state. Candidate rows are clicked by position in the list, not by label.
 */
export const FORBIDDEN_LABEL = /发送|求简历|请求|索取|换电话|换微信|约面试|不合适|继续沟通|立即沟通|打招呼|确认|确定|举报|转发|收藏|删除|拉黑|标记|加入|邀请/;

export function assertSafeLabel(label: string): void {
  if (FORBIDDEN_LABEL.test(label)) throw new RuntimeError('forbidden_effect', 'the workflow refuses to click a control that sends, requests or changes state');
}
