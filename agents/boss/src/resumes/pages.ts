// What BOSS直聘 is showing, read from the accessibility tree of one
// observation. Layout facts come from the P0 survey on macOS (BOSS 1.7.4):
// the online resume opens as an overlay whose body is one AXImage inside an
// AXWebArea, with 收藏/转发/举报/继续沟通 beside it and an unlabelled close
// control at its top right; the request-resume confirm reads
// 确定向牛人请求简历… with 取消 and 确认 buttons. Nothing here acts.

import {
  RuntimeError,
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

/** The open conversation, as the existing assistant reads it. */
export function openChat(observation: Observation) {
  return chat((observation.elements ?? []) as Element[], observation.window.frame as Frame);
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
    return { pane: image.frame, image, group, close: closeControl(elements, group?.frame ?? box, win), loading };
  }
  if (loading) {
    const fallback = group?.frame ?? win;
    return { pane: fallback, image: { index: -1, role: 'AXImage', frame: fallback }, group, close: closeControl(elements, fallback, win), loading };
  }
  return undefined;
}

/**
 * The overlay's close control: a small square without text just right of
 * the overlay's top edge (P0 clicked it there), or anything labelled 关闭.
 */
function closeControl(elements: UIElement[], overlay: Rect, win: Rect): UIElement | undefined {
  const named = elements.find((e) => e.frame && /^(关闭|close)$/i.test(text(e)) && e.role !== 'AXStaticText');
  if (named) return named;
  const right = overlay.x + overlay.width;
  return elements
    .filter((e) => e.frame && (e.role === 'AXGroup' || e.role === 'AXButton') && !text(e))
    .filter((e) => {
      const f = e.frame!;
      return f.width >= 16 && f.width <= 48 && Math.abs(f.width - f.height) <= 8
        && f.y - win.y < 60 && f.x >= right - 8 && f.x <= right + 60;
    })
    .sort((a, b) => a.frame!.y - b.frame!.y || a.frame!.x - b.frame!.x)[0];
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

/** The filter above the message list: 全部职位 or the job it is set to. */
export function jobFilter(observation: Observation): UIElement | undefined {
  const win = observation.window.frame;
  return (observation.elements ?? [])
    .filter((e) => e.role === 'AXStaticText' && e.frame && text(e) !== '')
    .filter((e) => e.frame!.x - win.x >= 140 && e.frame!.x - win.x < 420 && e.frame!.y - win.y < 50)
    .sort((a, b) => a.frame!.x - b.frame!.x)[0];
}

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
