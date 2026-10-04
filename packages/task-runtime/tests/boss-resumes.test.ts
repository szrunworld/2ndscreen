// boss-resumes-v1 against a synthetic BOSS直聘: a fake app behind the
// contract Session that draws the message list, a conversation, the online
// resume overlay (an image read by a fake local OCR), the request-resume
// confirm and an attachment preview. Every candidate, message and resume
// line here is made up. Nothing touches a real desktop, BOSS直聘 or a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  BOSS_UNITS,
  RuntimeError,
  captureCompleteness,
  emptyUsage,
  isCountable,
  isRuntimeError,
  safePathSegment,
  throwIfAborted,
  validateCondition,
  type AccountScope,
  type ActionRequest,
  type ActionResult,
  type ArtifactRecord,
  type BossWorkflow,
  type CaptureMode,
  type ComposedImage,
  type CandidateRef,
  type ImageComparison,
  type LocalVision,
  type Observation,
  type ObserveOptions,
  type OcrLine,
  type OcrResult,
  type Rect,
  type Session,
  type StagedArtifact,
  type TaskRecord,
  type TelemetryEvent,
  type UIElement,
  type UnitContext,
  type WindowBinding,
  type WorkItem,
} from '../src/contracts.ts';
import { createArtifactStore } from '../src/artifacts.ts';
import { createBossResumesWorkflow, createBossResumesWorkflowWith } from '../../../agents/boss/src/resumes/workflow.ts';
import { classifyPage } from '../../../agents/boss/src/resumes/pages.ts';
import { identify, listCandidates, matchJob } from '../../../agents/boss/src/resumes/candidates.ts';
import { footerVisible, resumeText, topMarkerVisible } from '../../../agents/boss/src/resumes/capture.ts';
import type { AttachmentRoute } from '../../../agents/boss/src/resumes/capture.ts';

// ---------------------------------------------------------------------------
// Synthetic PNGs, so the real artifact store can validate what is staged

function png(seed: string, width = 6, height = 4): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const colour = createHash('sha256').update(seed).digest();
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) colour.copy(rows, y * (width * 3 + 1) + 1 + x * 3, (x + y) % 29, ((x + y) % 29) + 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The synthetic app

const WIN: Rect = { x: 3000, y: 25, width: 1440, height: 875 };
const PANE: Rect = { x: WIN.x + 138, y: WIN.y, width: 734, height: 848 };
/** P0: the resume pane's scrollbar is 4 pt wide and moves on every scroll. */
const SCROLLBAR_PT = 4;
const LINE_STEP_PX = 40; // pixels one scroll line moves the resume
const ROW_H = 78;

interface Person {
  name: string;
  position: string;
  time: string;
  unread: number;
  preview: string;
  summary: [string, string, string] | [];
  history: string[];
  bodyLines: number;
  fold?: boolean;
  attachment?: { fileName: string; bytes: Buffer } | 'none';
}

const people = (): Person[] => [
  { name: '陈一', position: '前端工程师', time: '16:25', unread: 2, preview: '示例：想了解岗位', summary: ['30岁', '6年', '本科'], history: ['2024.01-2026.01 示例科技 · 前端工程师', '2020.01-2023.12 样例网络 · 前端工程师'], bodyLines: 50, fold: true },
  { name: '林二', position: '前端工程师', time: '15:10', unread: 1, preview: '示例：简历已更新', summary: ['27岁', '4年', '硕士'], history: ['2022.07-至今 虚构数据 · Web 开发'], bodyLines: 30 },
  { name: '周三', position: '前端工程师', time: '14:00', unread: 0, preview: '示例：您好', summary: ['25岁', '2年', '本科'], history: ['2023.07-至今 某某软件 · 前端开发'], bodyLines: 20 },
  { name: '吴四', position: '后端工程师', time: '13:00', unread: 0, preview: '示例：你好', summary: ['33岁', '9年', '本科'], history: ['2016.07-至今 样例云 · Java 开发'], bodyLines: 20 },
];

type Overlay = 'none' | 'loading' | 'resume' | 'dialog' | 'attachment';

interface Shot {
  person: string;
  offset: number;
  expanded: boolean;
  widthPx: number;
  heightPx: number;
  /** Pixels per point, as the covers measure it. */
  scale: number;
  /** Changes when the resume's text changes under the capture. */
  version: number;
  /** Lines of the document as drawn at this offset. */
  lines: Array<{ text: string; y: number }>;
}

interface DocLine {
  text: string;
  y: number;
  kind?: 'fold' | 'unfold';
}

function documentOf(p: Person, expanded: boolean, footer: boolean): DocLine[] {
  const lines: DocLine[] = [
    { text: 'BOSS直聘', y: 20 },
    { text: p.name, y: 100 },
    { text: (p.summary as string[]).join('|') || '示例', y: 160 },
  ];
  let y = 220;
  for (let j = 1; j <= p.bodyLines; j++) {
    lines.push({ text: `第${j}行 示例经历与项目描述 ${p.name.length}${j}`, y });
    y += 60;
    if (p.fold && j === 5) {
      if (expanded) {
        for (let k = 1; k <= 6; k++) {
          lines.push({ text: `折叠内容${k} 示例补充说明`, y });
          y += 60;
        }
        lines.push({ text: '收起', y, kind: 'unfold' });
      } else {
        lines.push({ text: '查看全部', y, kind: 'fold' });
      }
      y += 60;
    }
  }
  if (footer) {
    lines.push({ text: '为妥善保护牛人在BOSS直聘平台提交、发布、展示的简历中的个人信息', y: y + 40 });
    lines.push({ text: '该简历仅供您在线浏览牛人简历使用', y: y + 100 });
    y += 160;
  }
  return lines.map((l) => ({ ...l, y: l.y }));
}

const docHeight = (lines: DocLine[]) => Math.max(...lines.map((l) => l.y)) + 80;

interface AppOptions {
  people?: Person[];
  jobs?: string[];
  filter?: string;
  dir: string;
  loadingReads?: number;
  resumeScrollStuck?: boolean;
  listScrollStuck?: boolean;
  footer?: boolean;
  foldBroken?: boolean;
  /** Clicking a row opens the person below it instead. */
  wrongOpen?: boolean;
  visibleRows?: number;
  downloads?: string;
  /** Another file that lands in Downloads with the attachment. */
  extraDownload?: string;
  /** Pixels per point of screenshots; P0 measured 2, never assumed. */
  scale?: number;
}

class FakeBoss implements Session {
  readonly id = 'session-1';
  readonly taskId = 'task-1';
  readonly profile = { id: 'boss-macos-1440x900', version: 1, logicalWidth: 1440, logicalHeight: 900, bundleId: 'com.zhipin.www' };
  readonly lease = { leaseId: 'lease-1', scopeKey: 'com.zhipin.www:acct', holder: 'runtime' as const, ownerPid: 1, expiresAt: '2099-01-01T00:00:00Z' };
  persons: Person[];
  jobs: string[];
  filter: string;
  dropdown = false;
  listOffset = 0;
  open?: number;
  overlay: Overlay = 'none';
  loadingLeft = 0;
  offset = 0;
  expanded = false;
  /** Bumped by a test to change the resume's text mid-capture. */
  version = 0;
  readonly clicks: string[] = [];
  readonly actions: ActionRequest[] = [];
  readonly shots = new Map<string, Shot>();
  private snap = 0;
  private current?: { id: string; tags: Map<number, string> };
  beforeObserve?: (app: FakeBoss) => void;

  readonly opts: AppOptions;

  constructor(opts: AppOptions) {
    this.opts = opts;
    this.persons = opts.people ?? people();
    this.jobs = opts.jobs ?? ['前端工程师', '后端工程师'];
    this.filter = opts.filter ?? '全部职位';
  }

  binding(): WindowBinding {
    return { screenId: 's', socket: '/tmp/x.sock', window: this.geometry(), launchedByRuntime: false };
  }

  get scale(): number {
    return this.opts.scale ?? 2;
  }

  get viewPx(): number {
    return PANE.height * this.scale;
  }

  private geometry() {
    return { pid: 42, windowId: 7, bundleId: 'com.zhipin.www', title: 'BOSS直聘', frame: WIN, contentFrame: WIN, scale: this.scale, displayId: 1 };
  }

  visible(): Person[] {
    const listed = this.filter === '全部职位' ? this.persons : this.persons.filter((p) => p.position === this.filter);
    return listed.slice(this.listOffset);
  }

  doc(): DocLine[] {
    const p = this.persons[this.open!]!;
    return documentOf(p, this.expanded, this.opts.footer !== false);
  }

  maxOffset(): number {
    return Math.max(0, docHeight(this.doc()) - this.viewPx);
  }

  async observe(options: ObserveOptions = {}, signal?: AbortSignal): Promise<Observation> {
    throwIfAborted(signal);
    this.beforeObserve?.(this);
    if (this.overlay === 'loading' && this.loadingLeft-- <= 0) this.overlay = 'resume';
    const elements: UIElement[] = [];
    const tags = new Map<number, string>();
    let index = 10 + (this.snap % 3) * 100; // indexes renumber between reads
    const add = (role: string, label: string | undefined, local: Rect, tag = '', value?: string) => {
      const e: UIElement = { index: index++, role, frame: { x: WIN.x + local.x, y: WIN.y + local.y, width: local.width, height: local.height } };
      if (label !== undefined) e.label = label;
      if (value !== undefined) e.value = value;
      elements.push(e);
      if (tag) tags.set(e.index, tag);
    };
    // Message list.
    add('AXStaticText', undefined, { x: 155, y: 29, width: 52, height: 16 }, 'filter', this.filter);
    for (const tab of ['全部', '新招呼', '沟通中']) add('AXStaticText', undefined, { x: 140 + 50 * ['全部', '新招呼', '沟通中'].indexOf(tab), y: 70, width: 40, height: 16 }, '', tab);
    if (this.dropdown) this.jobs.forEach((j, k) => add('AXStaticText', undefined, { x: 170, y: 140 + 34 * k, width: 120, height: 16 }, `option:${j}`, j));
    const rows = this.visible();
    const limit = this.opts.visibleRows ?? 99;
    rows.slice(0, limit).forEach((p, k) => {
      const top = 160 + ROW_H * k;
      if (top >= WIN.height) return;
      const cut = top + 45 > WIN.height;
      const h = cut ? Math.max(4, WIN.height - top - 2) : 15;
      if (p.unread) add('AXStaticText', undefined, { x: 166, y: top - 4, width: 7, height: 14 }, '', String(p.unread));
      add('AXStaticText', undefined, { x: 463, y: top + 1, width: 31, height: Math.min(14, h) }, '', p.time);
      add('AXStaticText', undefined, { x: 192, y: top, width: 42, height: h }, `row|${p.name}|${p.position}|${p.time}`, p.name);
      add('AXStaticText', undefined, { x: 240, y: top + 1, width: 112, height: Math.min(13, h) }, '', p.position);
      if (!cut) add('AXStaticText', undefined, { x: 192, y: top + 25, width: 211, height: 14 }, '', p.preview);
    });
    // Open conversation.
    if (this.open !== undefined) {
      const p = this.persons[this.open]!;
      add('AXStaticText', p.name, { x: 531, y: 23, width: 66, height: 24 }, '', p.name);
      (p.summary as string[]).forEach((s, k) => add('AXStaticText', s, { x: 531 + 50 * k, y: 62, width: 30, height: 16 }, '', s));
      add('AXLink', '在线简历', { x: 1164, y: 36, width: 96, height: 38 }, 'link:online');
      add('AXStaticText', '在线简历', { x: 1196, y: 48, width: 53, height: 15 }, 'link:online', '在线简历');
      add('AXStaticText', '附件简历', { x: 1306, y: 48, width: 52, height: 15 }, 'attach', '附件简历');
      p.history.forEach((h, k) => {
        const [dates, ...rest] = h.split(' ');
        add('AXStaticText', dates, { x: 548, y: 118 + 28 * k, width: 99, height: 15 }, '', dates);
        add('AXStaticText', rest.join(' '), { x: 663, y: 118 + 28 * k, width: 207, height: 15 }, '', rest.join(' '));
      });
      add('AXStaticText', '沟通职位：', { x: 987, y: 118, width: 65, height: 15 }, '', '沟通职位：');
      add('AXStaticText', p.position, { x: 1055, y: 118, width: 122, height: 15 }, '', p.position);
      for (const [k, q] of ['求简历', '换电话', '换微信', '约面试'].entries()) add('AXStaticText', q, { x: 733 + 67 * k, y: 761, width: 39, height: 15 }, `quick:${q}`, q);
      add('AXTextArea', undefined, { x: 511, y: 788, width: 878, height: 61 }, 'input');
      add('AXStaticText', '发送', { x: 1323, y: 845, width: 26, height: 15 }, 'send', '发送');
    }
    if (this.overlay === 'loading') {
      add('AXGroup', '收藏 转发 举报 继续沟通', { x: 138, y: 0, width: 1084, height: 848 });
      add('AXStaticText', undefined, { x: 649, y: 62, width: 96, height: 16 }, '', '正在加载简历...');
    }
    if (this.overlay === 'resume') {
      const p = this.persons[this.open!]!;
      add('AXGroup', `收藏 转发 举报 继续沟通 ，沟通职位 ${p.position}`, { x: 138, y: 0, width: 1084, height: 848 });
      add('AXWebArea', 'BOSS直聘', { x: 138, y: 0, width: 734, height: 848 });
      add('AXImage', '', { x: 138, y: 0, width: 734, height: 848 });
      for (const [k, a] of ['收藏', '转发', '举报'].entries()) add('AXStaticText', undefined, { x: 938 + 96 * k, y: 62, width: 26, height: 15 }, `action:${a}`, a);
      add('AXButton', '继续沟通', { x: 903, y: 106, width: 289, height: 40 }, 'continue');
      add('AXStaticText', undefined, { x: 903, y: 174, width: 41, height: 15 }, '', p.name);
      add('AXStaticText', undefined, { x: 994, y: 174, width: 159, height: 15 }, '', '向您发起沟通，沟通职位');
      add('AXGroup', '', { x: 1234, y: 12, width: 30, height: 30 }, 'close');
    }
    if (this.overlay === 'dialog') {
      add('AXStaticText', undefined, { x: 1105, y: 100, width: 168, height: 60 }, '', '确定向牛人请求简历，并回复内容：“方便发一份你的简历过来吗？”');
      add('AXButton', '取消', { x: 1175, y: 173, width: 44, height: 24 }, 'dialog:cancel');
      add('AXButton', '确认', { x: 1229, y: 173, width: 44, height: 24 }, 'dialog:confirm');
    }
    if (this.overlay === 'attachment') {
      add('AXWebArea', '附件', { x: 300, y: 40, width: 800, height: 780 });
      add('AXStaticText', undefined, { x: 320, y: 10, width: 100, height: 16 }, '', '附件简历预览');
      add('AXButton', '下载', { x: 1110, y: 10, width: 40, height: 20 }, 'download');
      add('AXButton', '关闭', { x: 1160, y: 10, width: 40, height: 20 }, 'close-attachment');
    }
    const snapshotId = `snap-${++this.snap}`;
    this.current = { id: snapshotId, tags };
    const observation: Observation = { snapshotId, sessionId: this.id, takenAt: new Date().toISOString(), window: this.geometry(), elements };
    if (options.screenshot) {
      const covers = options.region ?? WIN;
      const path = join(this.opts.dir, `shot-${this.snap}.png`);
      const shot: Shot = {
        person: this.open !== undefined ? this.persons[this.open]!.name : '',
        offset: this.offset,
        expanded: this.expanded,
        widthPx: covers.width * this.scale,
        heightPx: covers.height * this.scale,
        scale: this.scale,
        version: this.version,
        lines: [],
      };
      if (this.overlay === 'resume')
        shot.lines = this.doc()
          .filter((l) => l.y >= this.offset && l.y + 40 <= this.offset + this.viewPx)
          .map((l) => ({ text: this.version && l.y > this.offset + this.viewPx / 2 ? `${l.text}（已更新）` : l.text, y: l.y - this.offset }));
      const seed = `${shot.person}|${shot.offset}|${shot.expanded}|${shot.version}`;
      await writeFile(path, png(seed));
      this.shots.set(path, shot);
      observation.screenshot = { path, widthPx: shot.widthPx, heightPx: shot.heightPx, covers, sha256: createHash('sha256').update(seed).digest('hex') };
    }
    return observation;
  }

  async act(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    throwIfAborted(signal);
    if (request.action.effect === 'external-submit') throw new RuntimeError('forbidden_effect', 'not allowed');
    this.actions.push(request);
    const at = new Date().toISOString();
    const done = (status: ActionResult['status'] = 'ok'): ActionResult => ({ actionId: request.actionId, status, startedAt: at, finishedAt: at, route: 'element' });
    const action = request.action;
    const current = this.current;
    this.current = undefined;
    if (action.kind === 'click' && action.target.kind === 'element') {
      if (!current || request.snapshotId !== current.id) return done('stale_snapshot');
      const tag = current.tags.get(action.target.index!) ?? 'unknown';
      this.clicks.push(tag);
      this.click(tag);
      return done();
    }
    if (action.kind === 'click' && action.target.kind === 'relative') {
      const g = { x: WIN.x + action.target.point.x * WIN.width, y: WIN.y + action.target.point.y * WIN.height };
      this.clicks.push('point');
      if (this.overlay === 'resume' && g.x >= PANE.x && g.x < PANE.x + PANE.width) {
        const y = this.offset + (g.y - PANE.y) * this.scale;
        const hit = this.doc().find((l) => y >= l.y && y < l.y + 40);
        if (hit?.kind === 'fold' && !this.opts.foldBroken) this.expanded = true;
      }
      return done();
    }
    if (action.kind === 'scroll') {
      const point = action.target?.kind === 'relative' ? action.target.point : { x: 0.5, y: 0.5 };
      const gx = WIN.x + point.x * WIN.width;
      const lines = action.amount ?? 1;
      if (this.overlay === 'resume' && gx >= PANE.x && gx < PANE.x + PANE.width) {
        if (this.opts.resumeScrollStuck) return done();
        const delta = (action.direction === 'down' ? 1 : -1) * lines * LINE_STEP_PX;
        this.offset = Math.min(this.maxOffset(), Math.max(0, this.offset + delta));
      } else if (this.overlay === 'none' && gx < WIN.x + 520) {
        if (this.opts.listScrollStuck) return done();
        const listed = this.filter === '全部职位' ? this.persons.length : this.persons.filter((p) => p.position === this.filter).length;
        const fit = this.opts.visibleRows ?? 9;
        const delta = (action.direction === 'down' ? 1 : -1) * Math.ceil(lines / 5) * 2;
        this.listOffset = Math.min(Math.max(0, listed - fit), Math.max(0, this.listOffset + delta));
      }
      return done();
    }
    if (action.kind === 'key' && action.key === 'escape') {
      this.dropdown = false;
      if (this.overlay === 'attachment') this.overlay = 'none';
      return done();
    }
    return done('failed');
  }

  private click(tag: string): void {
    if (tag === 'filter') this.dropdown = !this.dropdown;
    else if (tag.startsWith('option:')) {
      this.filter = tag.slice('option:'.length);
      this.dropdown = false;
      this.listOffset = 0;
    } else if (tag.startsWith('row|')) {
      const [, name, position, time] = tag.split('|');
      let i = this.persons.findIndex((p) => p.name === name && p.position === position && p.time === time);
      if (this.opts.wrongOpen) i = (i + 1) % this.persons.length;
      this.open = i;
      this.overlay = 'none';
    } else if (tag === 'link:online') {
      this.overlay = this.opts.loadingReads ? 'loading' : 'resume';
      this.loadingLeft = this.opts.loadingReads ?? 0;
      this.offset = 0;
      this.expanded = false;
    } else if (tag === 'attach') {
      const a = this.persons[this.open!]!.attachment;
      this.overlay = a && a !== 'none' ? 'attachment' : 'dialog';
    } else if (tag === 'dialog:cancel') this.overlay = 'none';
    else if (tag === 'close' || tag === 'close-attachment') this.overlay = 'none';
    else if (tag === 'download') {
      const a = this.persons[this.open!]!.attachment;
      if (a && a !== 'none' && this.opts.downloads) {
        writeFileSync(join(this.opts.downloads, a.fileName), a.bytes);
        if (this.opts.extraDownload) writeFileSync(join(this.opts.downloads, this.opts.extraDownload), a.bytes);
      }
    }
    // Anything else (send, request, continue, confirm) changes nothing here; tests assert it was never clicked.
  }

  async check(): Promise<never> {
    throw new Error('not used');
  }
  async waitFor(): Promise<never> {
    throw new Error('not used');
  }
  async rebind(): Promise<WindowBinding> {
    return this.binding();
  }
  async withExclusiveActor<T>(): Promise<T> {
    throw new Error('not used');
  }
  async close(): Promise<void> {}
}

/** Whether a region of interest still takes in the scrollbar columns at the pane's right edge. */
const includesScrollbar = (s: Shot, roi: Rect | undefined) => !roi || roi.x + roi.width > s.widthPx - SCROLLBAR_PT * s.scale;

/** OCR and image comparison over the fake app's screenshots. */
function fakeVision(app: FakeBoss, options: { compose?: boolean; composeGap?: boolean } = {}) {
  const calls = { ocr: 0, compare: 0, compose: 0, rois: [] as Array<Rect | undefined>, composeRoi: undefined as Rect | undefined };
  const shotOf = async (path: string): Promise<Shot> => {
    const direct = app.shots.get(path);
    if (direct) return direct;
    // A staged copy: find the original by content.
    const bytes = await readFile(path);
    for (const [p, s] of app.shots) if ((await readFile(p)).equals(bytes)) return s;
    throw new Error(`unknown image ${path}`);
  };
  const vision: LocalVision = {
    async ocr(path, _o, signal): Promise<OcrResult> {
      throwIfAborted(signal);
      calls.ocr++;
      const s = await shotOf(path);
      const lines: OcrLine[] = s.lines.map((l) => ({ text: l.text, box: { x: 100, y: l.y, width: 600, height: 40 }, confidence: 0.98 }));
      return { lines, imageSha256: 'x', widthPx: s.widthPx, heightPx: s.heightPx };
    },
    async compare(a, b, o, signal): Promise<ImageComparison> {
      throwIfAborted(signal);
      calls.compare++;
      calls.rois.push(o?.roi);
      const sa = await shotOf(a);
      const sb = await shotOf(b);
      if (sa.person !== sb.person || sa.version !== sb.version) return { similarity: 0.05 };
      const shift = sb.offset - sa.offset;
      if (shift === 0 && sa.expanded === sb.expanded) return { similarity: 1, verticalShiftPx: 0 };
      if (shift === 0) return { similarity: 0.8 };
      if (shift < 0) return { similarity: 0.4 };
      // The scrollbar moved: inside its columns nothing lines up, so a strict match needs them left out.
      if (includesScrollbar(sa, o?.roi)) return { similarity: 0.97 };
      return shift < sa.heightPx ? { similarity: 0.4, verticalShiftPx: shift } : { similarity: 0.1 };
    },
    async close() {},
  };
  if (options.compose)
    vision.compose = async (paths, out, opts): Promise<ComposedImage> => {
      calls.compose++;
      calls.composeRoi = opts?.roi;
      const shots = await Promise.all(paths.map(shotOf));
      const frames = shots.map((s, i) => {
        if (i === 0) return { index: 0, placement: 'first' as const, outputY: 0, rows: s.heightPx };
        const before = shots[i - 1]!;
        const shift = s.offset - before.offset;
        const continuous = before.version === s.version && !includesScrollbar(s, opts?.roi) && s.heightPx - shift >= (opts?.minOverlapPx ?? 48);
        const placement = shift === 0 && before.version === s.version ? ('duplicate' as const) : continuous && !options.composeGap ? ('placed' as const) : ('gap' as const);
        return { index: i, placement, outputY: s.offset, rows: shift, overlapPx: s.heightPx - shift };
      });
      const bytes = png(`composed|${paths.length}`, 8, 8);
      await writeFile(out, bytes, { flag: 'wx' });
      return { path: out, widthPx: 8, heightPx: 8, sha256: createHash('sha256').update(bytes).digest('hex'), frames, hasGap: frames.some((f) => f.placement === 'gap') };
    };
  return { vision, calls };
}

function telemetry() {
  const events: TelemetryEvent[] = [];
  return { events, recorder: { record: (e: TelemetryEvent) => void events.push(e), usage: () => emptyUsage() } };
}

const ACCOUNT: AccountScope = { platform: 'boss', accountKey: 'acct-synthetic', binding: 'explicit' };

function taskRecord(overrides: Partial<TaskRecord['input']> = {}, account: AccountScope | undefined = ACCOUNT): TaskRecord {
  return {
    id: 'task-1',
    skillId: 'boss.collect-resumes',
    skillVersion: '1.0.0',
    input: { job: '前端工程师', requestedCount: 2, outputDir: '/tmp/out', source: 'conversations', captureMode: 'available', ...overrides },
    status: 'running',
    account,
    counts: { requested: 2, browsed: 0, committed: 0, unavailable: 0, failed: 0, ambiguous: 0, diagnostic: 0 },
    createdAt: '2026-10-04T08:00:00Z',
    updatedAt: '2026-10-04T08:00:00Z',
  };
}

interface Rig {
  dir: string;
  app: FakeBoss;
  workflow: BossWorkflow;
  vision: ReturnType<typeof fakeVision>;
  tele: ReturnType<typeof telemetry>;
  context(extra?: Partial<UnitContext>): UnitContext;
  cleanup(): Promise<void>;
}

const FAST = { pollMs: 1, openTimeoutMs: 200, listSettleMs: 30, capture: { settleMs: 0, loadTimeoutMs: 200 } };

async function rig(opts: Partial<AppOptions> = {}, wf: { compose?: boolean; composeGap?: boolean; vision?: boolean; attachment?: AttachmentRoute; capture?: object; input?: Partial<TaskRecord['input']> } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'boss-resumes-'));
  const app = new FakeBoss({ dir, ...opts });
  const vision = fakeVision(app, wf);
  const tele = telemetry();
  const workflow = createBossResumesWorkflowWith({
    ...FAST,
    capture: { ...FAST.capture, ...wf.capture },
    vision: wf.vision === false ? undefined : vision.vision,
    telemetry: tele.recorder,
    attachment: wf.attachment,
  });
  const controller = new AbortController();
  return {
    dir,
    app,
    workflow,
    vision,
    tele,
    context: (extra = {}) => ({ session: app, task: taskRecord(wf.input), bindings: {}, signal: controller.signal, ...extra }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const FORBIDDEN_TAGS = /^(send|quick:|continue|dialog:confirm|action:)/;
const assertNothingSent = (app: FakeBoss) => {
  assert.deepEqual(app.clicks.filter((t) => FORBIDDEN_TAGS.test(t)), [], 'no send, request, greet, confirm or report control was clicked');
  assert.ok(app.actions.every((a) => a.action.effect !== 'external-submit'));
};

async function stagingFor(r: Rig, itemId = 'item-1') {
  const dir = join(r.dir, 'staging', itemId);
  await mkdir(dir, { recursive: true });
  return { itemId, dir };
}

/** Open a person's conversation through the workflow. */
async function openPerson(r: Rig, name: string): Promise<{ ref: CandidateRef; ctx: UnitContext }> {
  const listing = r.workflow.listCandidates(await r.app.observe(), ACCOUNT);
  const ref = listing.candidates.find((c) => c.name === name)!;
  const ctx = r.context({ candidate: ref });
  const opened = await r.workflow.runScripted('open_candidate', ctx)!;
  assert.equal(opened.ok, true, opened.reason);
  return { ref, ctx };
}

// ---------------------------------------------------------------------------
// Units

test('defines all eight units; persist only touches artifacts; nothing may submit', () => {
  const wf = createBossResumesWorkflow({});
  assert.equal(wf.id, 'boss-resumes-v1');
  assert.deepEqual(Object.keys(wf.units).sort(), [...BOSS_UNITS].sort());
  assert.deepEqual(wf.units.persist_candidate.allowedEffects, ['artifact']);
  for (const unit of BOSS_UNITS) {
    const def = wf.units[unit];
    assert.equal(def.name, unit);
    assert.ok(!def.allowedEffects.includes('external-submit'), unit);
    for (const c of [...def.preconditions, ...def.postconditions]) assert.deepEqual(validateCondition(c), [], unit);
  }
  assert.equal(wf.runScripted('persist_candidate', {} as UnitContext), undefined);
  assert.equal(wf.runScripted('acquire_resume', {} as UnitContext), undefined);
});

// ---------------------------------------------------------------------------
// Pages

test('classifies the existing redacted list and chat fixtures with the old parsers', () => {
  const fixture = (name: string): Observation => {
    const raw = JSON.parse(readFileSync(new URL(`../../../agents/boss/src/fixtures/${name}.json`, import.meta.url), 'utf8'));
    const f = raw.windowFrame;
    return { snapshotId: name, sessionId: 's', takenAt: '', window: { pid: 1, windowId: 1, bundleId: 'com.zhipin.www', title: '', frame: f, contentFrame: f, scale: 2, displayId: 1 }, elements: raw.elements };
  };
  assert.equal(classifyPage(fixture('list')), 'conversation_list');
  assert.equal(classifyPage(fixture('chat')), 'conversation_detail');
  assert.equal(classifyPage(fixture('chat-labels')), 'conversation_detail');
  const listing = listCandidates(fixture('list'), ACCOUNT);
  assert.equal(listing.candidates.length, 10);
  assert.equal(listing.endReached, false, 'the last row is cut off at the bottom');
});

test('classifies the synthetic pages: list, conversation, loading, resume, request confirm, attachment, login, captcha', async () => {
  const r = await rig({ people: people().map((p, i) => (i === 1 ? { ...p, attachment: { fileName: '林二_简历.pdf', bytes: Buffer.from('%PDF-1.4\n') } } : p)) });
  try {
    assert.equal(classifyPage(await r.app.observe()), 'conversation_list');
    r.app.open = 0;
    assert.equal(classifyPage(await r.app.observe()), 'conversation_detail');
    r.app.overlay = 'loading';
    r.app.loadingLeft = 5;
    assert.equal(classifyPage(await r.app.observe()), 'loading');
    r.app.overlay = 'resume';
    assert.equal(classifyPage(await r.app.observe()), 'online_resume');
    r.app.overlay = 'dialog';
    assert.equal(classifyPage(await r.app.observe()), 'request_resume_dialog');
    r.app.overlay = 'attachment';
    assert.equal(classifyPage(await r.app.observe()), 'attachment_preview');
    const bare = (texts: string[]): Observation => ({
      snapshotId: 'x', sessionId: 's', takenAt: '', window: { pid: 1, windowId: 1, bundleId: 'b', title: '', frame: WIN, contentFrame: WIN, scale: 2, displayId: 1 },
      elements: texts.map((t, i) => ({ index: i, role: 'AXStaticText', value: t, frame: { x: WIN.x + 600, y: WIN.y + 300 + 20 * i, width: 100, height: 16 } })),
    });
    assert.equal(classifyPage(bare(['扫码登录', '使用BOSS直聘APP扫码'])), 'login');
    assert.equal(classifyPage(bare(['安全验证', '请拖动滑块完成拼图'])), 'captcha');
    assert.equal(classifyPage(bare(['什么也不是'])), 'unknown');
  } finally {
    await r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Candidates and identity

test('matches a job exactly, by a unique containing title, or reports ambiguity and absence', () => {
  assert.deepEqual(matchJob(['前端工程师', '高级前端工程师'], '前端工程师'), { kind: 'unique', option: '前端工程师' });
  assert.deepEqual(matchJob(['前端工程师', '后端工程师'], '前端'), { kind: 'unique', option: '前端工程师' });
  assert.deepEqual(matchJob(['前端工程师（上海）', '前端工程师（北京）'], '前端'), { kind: 'ambiguous', options: ['前端工程师（上海）', '前端工程师（北京）'] });
  assert.deepEqual(matchJob(['后端工程师'], '设计师'), { kind: 'none' });
  assert.deepEqual(matchJob(['全部职位'], '全部职位'), { kind: 'none' });
});

test('lists rows with refs bound to the snapshot; identical rows are marked and same names stay separate', async () => {
  const list = people();
  list.push({ ...list[2]! }); // an exact duplicate row of 周三
  list.push({ ...list[0]!, position: '后端工程师', time: '09:00', history: ['2019.01-至今 另一家 · 后端'] }); // same name, other job
  const r = await rig({ people: list });
  try {
    const o = await r.app.observe();
    const listing = listCandidates(o, ACCOUNT);
    assert.equal(listing.snapshotId, o.snapshotId);
    assert.ok(listing.candidates.every((c) => c.snapshotId === o.snapshotId && c.locator?.kind === 'element'));
    const zhou = listing.candidates.filter((c) => c.name === '周三');
    assert.equal(zhou.length, 2);
    assert.ok(zhou.every((c) => c.hints.includes('duplicate_row')));
    const chen = listing.candidates.filter((c) => c.name === '陈一');
    assert.equal(chen.length, 2);
    assert.notEqual(chen[0]!.sourceRef, chen[1]!.sourceRef);
    assert.ok(chen.every((c) => !c.hints.includes('duplicate_row')));
    // Opening a duplicate row is refused: the two cannot be told apart.
    const refused = await r.workflow.runScripted('open_candidate', r.context({ candidate: zhou[0]! }))!;
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'candidate_row_ambiguous');
    assert.equal(r.app.clicks.length, 0);
  } finally {
    await r.cleanup();
  }
});

test('the job filter keeps other jobs out of the listing; the fingerprint changes when rows reorder', async () => {
  const r = await rig({ filter: '前端工程师', people: people().map((p) => p) });
  try {
    r.app.filter = '全部职位';
    const all = listCandidates(await r.app.observe(), ACCOUNT);
    assert.equal(all.candidates.length, 4);
    r.app.filter = '前端工程师';
    const front = listCandidates(await r.app.observe(), ACCOUNT);
    assert.deepEqual(front.candidates.map((c) => c.name), ['陈一', '林二', '周三']);
    assert.equal(front.endReached, false, 'room under the last row is not an end notice');
    r.app.persons.unshift(r.app.persons.splice(2, 1)[0]!);
    assert.notEqual(listCandidates(await r.app.observe(), ACCOUNT).fingerprint, front.fingerprint);
  } finally {
    await r.cleanup();
  }
});

test('identity comes from header and history, not the name; mismatches and name-only pages are refused', async () => {
  const list = people();
  list.push({ ...list[0]!, position: '前端工程师', time: '08:00', preview: '另一个人', history: ['2018.01-至今 完全不同 · 测试'], summary: ['41岁', '15年', '大专'] });
  const r = await rig({ people: list });
  try {
    const listing = listCandidates(await r.app.observe(), ACCOUNT);
    const [first, , , , twin] = listing.candidates;
    assert.ok(first!.hints.includes('name_job_collision'));
    r.app.open = 0;
    const o = await r.app.observe();
    // Same name and job twice in the list: cannot be told apart from the list ref.
    const twinCheck = identify(o, first!, ACCOUNT);
    assert.equal(twinCheck.kind, 'ambiguous');
    r.app.persons.pop();
    // Once only one 陈一 is listed, a fresh ref can be identified.
    const single = listCandidates(await r.app.observe(), ACCOUNT).candidates[0]!;
    assert.ok(!single.hints.includes('name_job_collision'));
    assert.equal(identify(await r.app.observe(), first!, ACCOUNT).kind, 'ambiguous', 'the old ref keeps its collision hint');
    const m = identify(await r.app.observe(), single, ACCOUNT);
    assert.equal(m.kind, 'match');
    if (m.kind !== 'match') return;
    assert.ok(safePathSegment(m.identity.candidateId));
    assert.equal(m.identity.confidence, 'strong');
    assert.equal(m.identity.accountKey, ACCOUNT.accountKey);
    assert.ok(!JSON.stringify(m.identity.evidence).includes('陈一'), 'evidence never repeats the name');
    // Another person with the same name has another identity.
    r.app.persons.push({ ...twin!, name: '陈一', position: '前端工程师', time: '08:00', preview: 'x', unread: 0, summary: ['41岁', '15年', '大专'], history: ['2018.01-至今 完全不同 · 测试'], bodyLines: 5 });
    r.app.open = 4;
    const other = identify(await r.app.observe(), { ...single, sourceRef: 'x' }, { ...ACCOUNT });
    r.app.persons.pop();
    if (other.kind === 'match') assert.notEqual(other.identity.candidateId, m.identity.candidateId);
    // Wrong person open.
    r.app.open = 1;
    const wrong = identify(await r.app.observe(), single, ACCOUNT);
    assert.equal(wrong.kind, 'mismatch');
    assert.ok(!JSON.stringify(wrong).includes('林二'));
    // A header with no summary and no history is only a name.
    r.app.persons[1] = { ...r.app.persons[1]!, summary: [], history: [] };
    const thin = identify(await r.app.observe(), listing.candidates[1]!, ACCOUNT);
    assert.equal(thin.kind, 'ambiguous');
  } finally {
    await r.cleanup();
  }
});

test('a look-alike seen once keeps every later ref ambiguous, even after it scrolls away or rows reorder', async () => {
  const list = crowd(14);
  list[1] = { ...list[1]!, name: '同名', position: '前端工程师' };
  list[8] = { ...list[8]!, name: '同名', position: '前端工程师', history: ['2015.01-至今 另一位 · 前端'] };
  const r = await rig({ people: list });
  try {
    // Both look-alikes on screen once: the workflow remembers the pair.
    const both = r.workflow.listCandidates(await r.app.observe(), ACCOUNT);
    assert.equal(both.candidates.filter((c) => c.hints.includes('name_job_collision')).length, 2);
    // Now only one is visible (the other scrolled away) and the rows reordered.
    r.app.persons.push(r.app.persons.splice(8, 1)[0]!);
    r.app.persons.unshift(r.app.persons.splice(1, 1)[0]!);
    const later = r.workflow.listCandidates(await r.app.observe(), ACCOUNT).candidates.find((c) => c.name === '同名')!;
    assert.ok(later.hints.includes('name_job_collision'));
    const opened = await r.workflow.runScripted('open_candidate', r.context({ candidate: { ...later, hints: [] } }))!;
    assert.equal(opened.ok, false);
    assert.equal(r.workflow.identify(opened.observation, { ...later, hints: [] }, ACCOUNT).kind, 'ambiguous');
    // Another account does not inherit the pair.
    const other = r.workflow.listCandidates(await r.app.observe(), { ...ACCOUNT, accountKey: 'acct-other' }).candidates.find((c) => c.name === '同名')!;
    assert.ok(!other.hints.includes('name_job_collision'));
  } finally {
    await r.cleanup();
  }
});

test('a job missing on either side is not accepted as a match; weak evidence is reported as weak', async () => {
  const r = await rig();
  try {
    const ref = listCandidates(await r.app.observe(), ACCOUNT).candidates[0]!;
    r.app.open = 0;
    assert.equal(identify(await r.app.observe(), { ...ref, jobTitle: undefined }, ACCOUNT).kind, 'ambiguous');
    r.app.persons[0] = { ...r.app.persons[0]!, position: '' };
    const noJob = identify(await r.app.observe(), ref, ACCOUNT);
    assert.equal(noJob.kind, 'ambiguous');
    r.app.persons[0] = { ...people()[0]!, summary: [] };
    const weak = identify(await r.app.observe(), ref, ACCOUNT);
    assert.equal(weak.kind, 'match');
    if (weak.kind === 'match') {
      assert.equal(weak.identity.confidence, 'weak');
      assert.ok(weak.identity.evidence.includes('confidence weak'));
    }
  } finally {
    await r.cleanup();
  }
});

test('open_candidate re-finds a row that moved, and never takes the wrong person', async () => {
  const r = await rig();
  try {
    const stale = listCandidates(await r.app.observe(), ACCOUNT).candidates.find((c) => c.name === '林二')!;
    // A new message moves 林二 to the top with a new time between listing and opening.
    const lin = r.app.persons.splice(1, 1)[0]!;
    r.app.persons.unshift({ ...lin, time: '16:40', preview: '新消息' });
    const opened = await r.workflow.runScripted('open_candidate', r.context({ candidate: stale }))!;
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(r.app.persons[r.app.open!]!.name, '林二');
    assert.equal((await r.workflow.verifyUnit('open_candidate', r.context({ candidate: stale }), opened.observation)).ok, true);
    // The old element index was not reused: the click came from a fresh read.
    assert.equal(opened.executed.length, 1);
    assert.equal(opened.executed[0]!.result.status, 'ok');

    const gone = { ...stale, sourceRef: 'nobody|x|x|x', name: '不存在', jobTitle: '前端工程师' };
    const missing = await r.workflow.runScripted('open_candidate', r.context({ candidate: gone }))!;
    assert.equal(missing.reason, 'candidate_not_in_list');
  } finally {
    await r.cleanup();
  }

  const wrong = await rig({ wrongOpen: true });
  try {
    const ref = listCandidates(await wrong.app.observe(), ACCOUNT).candidates[0]!;
    const result = await wrong.workflow.runScripted('open_candidate', wrong.context({ candidate: ref }))!;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'conversation_not_opened');
    assert.equal((await wrong.workflow.verifyUnit('open_candidate', wrong.context({ candidate: ref }), result.observation)).ok, false);
  } finally {
    await wrong.cleanup();
  }
});

test('verifying open_candidate rejects a different person than the work item already bound', async () => {
  const r = await rig();
  try {
    const { ref, ctx } = await openPerson(r, '陈一');
    const o = await r.app.observe();
    const m = identify(o, ref, ACCOUNT);
    assert.equal(m.kind, 'match');
    if (m.kind !== 'match') return;
    const item: WorkItem = { id: 'item-1', taskId: 'task-1', identity: { ...m.identity, fingerprint: 'f'.repeat(64) }, ref, status: 'processing', attempt: 1, updatedAt: '' };
    const check = await r.workflow.verifyUnit('open_candidate', { ...ctx, item }, o);
    assert.equal(check.ok, false);
    assert.equal((await r.workflow.verifyUnit('open_candidate', { ...ctx, item: { ...item, identity: m.identity } }, o)).ok, true);
  } finally {
    await r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Source selection

test('select_source applies a unique job, and stops on an ambiguous one without choosing', async () => {
  const r = await rig();
  try {
    const ok = await r.workflow.runScripted('select_source', r.context())!;
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(r.app.filter, '前端工程师');
    assert.equal((await r.workflow.verifyUnit('select_source', r.context(), ok.observation)).ok, true);
  } finally {
    await r.cleanup();
  }
  const amb = await rig({ jobs: ['前端工程师（上海）', '前端工程师（北京）'] }, { input: { job: '前端' } });
  try {
    const result = await amb.workflow.runScripted('select_source', amb.context())!;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'job_ambiguous');
    assert.equal(amb.app.filter, '全部职位');
    assert.ok(!amb.app.clicks.some((t) => t.startsWith('option:')), 'no option was picked');
    assert.equal(amb.app.dropdown, false);
  } finally {
    await amb.cleanup();
  }
  const none = await rig({}, { input: { job: '设计师' } });
  try {
    assert.equal((await none.workflow.runScripted('select_source', none.context())!).reason, 'job_not_found');
  } finally {
    await none.cleanup();
  }
});

test('unsupported routes fail with capability_missing before anything is opened', async () => {
  const rec = await rig({}, { input: { source: 'recommend' } });
  try {
    await assert.rejects(rec.workflow.runScripted('select_source', rec.context())!, (e) => isRuntimeError(e, 'capability_missing'));
    assert.equal(rec.app.clicks.length, 0);
  } finally {
    await rec.cleanup();
  }
  const orig = await rig({}, { input: { captureMode: 'original-only' } });
  try {
    await assert.rejects(orig.workflow.runScripted('select_source', orig.context())!, (e) => isRuntimeError(e, 'capability_missing'));
    const { ctx } = await openPerson(orig, '陈一');
    await assert.rejects(orig.workflow.acquireResume({ ...ctx, staging: await stagingFor(orig) }, 'original-only'), (e) => isRuntimeError(e, 'capability_missing'));
    assert.ok(!orig.app.clicks.includes('attach'), 'the attachment control is not even probed');
  } finally {
    await orig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Online capture

async function captured(r: Rig, name = '陈一', mode: CaptureMode = 'available') {
  const { ctx } = await openPerson(r, name);
  const staging = await stagingFor(r);
  const result = await r.workflow.acquireResume({ ...ctx, staging }, mode);
  return { result, staging, ctx };
}

const evidenceOf = (artifacts: StagedArtifact[]) => artifacts.find((a) => a.capture)!.capture!;

test('captures a long resume completely: top, folded section, overlapping pages, footer and probed end', async () => {
  const r = await rig({}, { compose: true });
  try {
    const { result, staging, ctx } = await captured(r);
    assert.equal(result.status, 'acquired');
    if (result.status !== 'acquired') return;
    assert.equal(result.branch, 'online');
    const evidence = evidenceOf(result.artifacts);
    assert.equal(evidence.topConfirmed, true);
    assert.deepEqual([...evidence.bottomSignals].sort(), ['end_marker', 'scroll_position_end']);
    assert.equal(evidence.stop, 'bottom_confirmed');
    assert.equal(captureCompleteness(evidence), 'complete');
    assert.ok(evidence.pages > 3);
    const kinds = result.artifacts.map((a) => a.kind);
    assert.equal(kinds.filter((k) => k === 'captured_page').length, evidence.pages);
    assert.ok(kinds.includes('captured_image') && kinds.includes('resume_text') && kinds.includes('metadata'));
    assert.ok(result.artifacts.every((a) => a.path.startsWith(staging.dir)));
    assert.ok(isCountable(result.artifacts.map((a) => ({ kind: a.kind, completeness: a.kind === 'captured_image' ? captureCompleteness(a.capture!) : 'unverified' })), 'available'));
    // The folded section was opened once by clicking 查看全部 inside the pane.
    assert.equal(r.app.expanded, true);
    assert.equal(r.app.clicks.filter((c) => c === 'point').length, 1);
    // Text: every document line exactly once, in order, folded content included.
    const text = await readFile(join(staging.dir, 'resume.txt'), 'utf8');
    const expected = documentOf(r.app.persons[0]!, true, true).map((l) => l.text);
    assert.deepEqual(text.trim().split('\n'), expected);
    // Metadata records evidence, not the person.
    const metadata = await readFile(join(staging.dir, 'metadata.json'), 'utf8');
    assert.ok(!metadata.includes('陈一'));
    assert.equal(JSON.parse(metadata).completeness, 'complete');
    assert.equal((await r.workflow.verifyUnit('acquire_resume', { ...ctx, staging }, await r.app.observe())).ok, true);
    assertNothingSent(r.app);
    assert.ok(r.tele.events.some((e) => e.type === 'ocr') && r.tele.events.some((e) => e.type === 'screenshot'));
  } finally {
    await r.cleanup();
  }
});

test('the moving scrollbar is left out of comparing and stitching, by measured pixels per point', async () => {
  for (const scale of [2, 3]) {
    const r = await rig({ scale }, { compose: true });
    try {
      const { result, staging } = await captured(r);
      assert.equal(result.status, 'acquired');
      if (result.status !== 'acquired') continue;
      assert.equal(captureCompleteness(evidenceOf(result.artifacts)), 'complete', `scale ${scale}`);
      const widthPx = PANE.width * scale;
      const roi = { x: 0, y: 0, width: widthPx - 8 * scale, height: PANE.height * scale };
      assert.deepEqual(r.vision.calls.composeRoi, roi);
      assert.ok(r.vision.calls.rois.every((x) => JSON.stringify(x) === JSON.stringify(roi)));
      // Every line of the resume made it in, and the pages themselves were kept whole.
      const text = await readFile(join(staging.dir, 'resume.txt'), 'utf8');
      assert.deepEqual(text.trim().split('\n'), documentOf(r.app.persons[0]!, true, true).map((l) => l.text));
      const metadata = JSON.parse(await readFile(join(staging.dir, 'metadata.json'), 'utf8'));
      assert.deepEqual(metadata.contentRoi, roi);
      assert.ok(metadata.pages.every((p: { widthPx: number }) => p.widthPx === widthPx));
    } finally {
      await r.cleanup();
    }
  }
  // With the gutter compared, a strict comparison finds no overlap and the capture says so.
  const strict = await rig({}, { compose: true, capture: { gutterPt: 0 } });
  try {
    const { result } = await captured(strict);
    assert.equal(result.status, 'acquired');
    if (result.status === 'acquired') {
      assert.equal(evidenceOf(result.artifacts).stop, 'stitch_gap');
      assert.equal(captureCompleteness(evidenceOf(result.artifacts)), 'partial_capture');
    }
  } finally {
    await strict.cleanup();
  }
});

test('text that changes under the capture is still caught as a gap', async () => {
  const r = await rig({}, { compose: true });
  try {
    const { ctx } = await openPerson(r, '陈一');
    let shots = 0;
    r.app.beforeObserve = (app) => {
      if (app.overlay === 'resume' && ++shots === 9) app.version = 1;
    };
    const result = await r.workflow.acquireResume({ ...ctx, staging: await stagingFor(r) }, 'available');
    assert.equal(result.status, 'acquired');
    if (result.status !== 'acquired') return;
    const evidence = evidenceOf(result.artifacts);
    assert.equal(evidence.stop, 'stitch_gap');
    assert.equal(captureCompleteness(evidence), 'partial_capture');
  } finally {
    await r.cleanup();
  }
});

test('without a local stitcher the pages and text are saved but nothing countable is claimed', async () => {
  const r = await rig({}, { compose: false });
  try {
    const { result, staging } = await captured(r);
    assert.equal(result.status, 'acquired');
    if (result.status !== 'acquired') return;
    assert.ok(!result.artifacts.some((a) => a.kind === 'captured_image'));
    assert.equal(isCountable([], 'available'), false);
    const metadata = JSON.parse(await readFile(join(staging.dir, 'metadata.json'), 'utf8'));
    assert.ok(metadata.problems.some((p: string) => p.startsWith('compose_unavailable')));
  } finally {
    await r.cleanup();
  }
});

test('a stuck scroll is partial, never complete', async () => {
  const r = await rig({ resumeScrollStuck: true }, { compose: true });
  try {
    const { result } = await captured(r);
    assert.equal(result.status, 'acquired');
    if (result.status !== 'acquired') return;
    const evidence = evidenceOf(result.artifacts);
    assert.equal(evidence.pages, 1);
    assert.equal(evidence.stop, 'scroll_ineffective');
    assert.ok(!evidence.bottomSignals.includes('scroll_position_end'));
    assert.equal(captureCompleteness(evidence), 'partial_capture');
  } finally {
    await r.cleanup();
  }
});

test('a resume that fits one screen is not claimed complete from its first screenshot', async () => {
  const short = people().map((p, i) => (i === 0 ? { ...p, bodyLines: 3, fold: false } : p));
  const r = await rig({ people: short }, { compose: true });
  try {
    const { result } = await captured(r);
    assert.equal(result.status, 'acquired');
    if (result.status !== 'acquired') return;
    const evidence = evidenceOf(result.artifacts);
    assert.equal(evidence.pages, 1);
    assert.deepEqual(evidence.bottomSignals, ['end_marker']);
    assert.equal(captureCompleteness(evidence), 'partial_capture');
  } finally {
    await r.cleanup();
  }
});

test('the page limit, a missing footer, an unopened fold and a stitch gap each end partial', async () => {
  const cases: Array<[string, Partial<AppOptions>, { compose?: boolean; composeGap?: boolean; capture?: object }, string]> = [
    ['page limit', {}, { compose: true, capture: { maxPages: 3 } }, 'page_limit'],
    ['no footer', { footer: false }, { compose: true }, 'scroll_ineffective'],
    ['fold stays shut', { foldBroken: true }, { compose: true }, 'stitch_gap'],
    ['stitcher finds a gap', {}, { compose: true, composeGap: true }, 'stitch_gap'],
  ];
  for (const [label, app, wf, stop] of cases) {
    const r = await rig(app, wf);
    try {
      const { result } = await captured(r);
      assert.equal(result.status, 'acquired', label);
      if (result.status !== 'acquired') continue;
      const evidence = evidenceOf(result.artifacts);
      assert.equal(evidence.stop, stop, label);
      assert.equal(captureCompleteness(evidence), 'partial_capture', label);
      if (label === 'no footer') assert.deepEqual(evidence.bottomSignals, ['scroll_position_end']);
    } finally {
      await r.cleanup();
    }
  }
});

test('without local vision, or while the resume never loads, capture fails with a reason', async () => {
  const blind = await rig({}, { vision: false });
  try {
    const { result } = await captured(blind);
    assert.deepEqual(result, { status: 'failed', reason: 'local_vision_missing: the online resume is an image and needs local OCR' });
  } finally {
    await blind.cleanup();
  }
  const slow = await rig({ loadingReads: 10_000 });
  try {
    const { result } = await captured(slow);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.reason, 'resume_load_timeout');
  } finally {
    await slow.cleanup();
  }
});

test('the resume shown must belong to the candidate being processed', async () => {
  const r = await rig({}, { compose: true });
  try {
    const { ctx } = await openPerson(r, '陈一');
    // The runtime thinks it is processing 林二, but 陈一's conversation is open.
    const lin = listCandidates(await r.app.observe(), ACCOUNT).candidates.find((c) => c.name === '林二')!;
    const result = await r.workflow.acquireResume({ ...ctx, candidate: lin, staging: await stagingFor(r) }, 'available');
    assert.equal(result.status, 'failed');
    assert.equal(r.app.overlay === 'resume' ? r.app.persons[r.app.open!]!.name : '陈一', '陈一');
    const opened = await r.workflow.runScripted('open_resume', { ...ctx, candidate: lin })!;
    assert.equal(opened.ok, false);
    assert.equal((await r.workflow.verifyUnit('open_resume', { ...ctx, candidate: lin }, await r.app.observe())).ok, false);
  } finally {
    await r.cleanup();
  }
});

test('cancelling mid-capture stops with cancelled', async () => {
  const r = await rig({}, { compose: true });
  try {
    const { ctx } = await openPerson(r, '陈一');
    const controller = new AbortController();
    let reads = 0;
    r.app.beforeObserve = () => {
      if (++reads === 8) controller.abort();
    };
    await assert.rejects(
      r.workflow.acquireResume({ ...ctx, signal: controller.signal, staging: await stagingFor(r) }, 'available'),
      (e) => isRuntimeError(e, 'cancelled'),
    );
  } finally {
    await r.cleanup();
  }
});

test('resume text drops the lines a page shares with the one before', () => {
  const ocr = (lines: Array<[string, number]>): OcrResult => ({ lines: lines.map(([text, y]) => ({ text, box: { x: 0, y, width: 10, height: 40 }, confidence: 1 })), imageSha256: '', widthPx: 10, heightPx: 400 });
  const text = resumeText([
    { ocr: ocr([['a', 0], ['b', 100], ['c', 200], ['d', 300]]) },
    { ocr: ocr([['c', 0], ['d', 100], ['e', 200], ['f', 300]]), shiftPx: 200 },
  ]);
  assert.equal(text, 'a\nb\nc\nd\ne\nf\n');
});

test('the footer counts only as the last thing on the screen, and the logo only at the top', () => {
  const ocr = (lines: string[], top = 0): OcrResult => ({
    lines: lines.map((text, i) => ({ text, box: { x: 0, y: top + i * 60, width: 10, height: 40 }, confidence: 1 })),
    imageSha256: '', widthPx: 10, heightPx: 1696,
  });
  const footer = ['为妥善保护牛人在BOSS直聘平台提交、发布、展示的简历中的个人信息', '该简历仅供您在线浏览牛人简历使用'];
  assert.equal(footerVisible(ocr(['经历', '项目', ...footer])), true);
  assert.equal(footerVisible(ocr([...footer, '项目一', '项目二', '项目三', '项目四', '项目五'])), false, 'content below it: not the end');
  assert.equal(footerVisible(ocr(['经历', '项目'])), false);
  assert.equal(topMarkerVisible(ocr(['BOSS', '直聘', '陈一'])), true);
  assert.equal(topMarkerVisible(ocr(['经历', 'BOSS直聘'], 800)), false);
});

// ---------------------------------------------------------------------------
// Attachments

const route = (downloads: string): AttachmentRoute => ({ enabled: true, downloadsDir: downloads, timeoutMs: 300, stableMs: 5, openTimeoutMs: 200 });

test('no attachment: the request confirm is cancelled, never confirmed, and available mode falls back to the online resume', async () => {
  const downloads = await mkdtemp(join(tmpdir(), 'boss-dl-'));
  const strict = await rig({}, { compose: true, attachment: route(downloads), input: { captureMode: 'original-only' } });
  try {
    const { result } = await captured(strict, '陈一', 'original-only');
    assert.deepEqual(result, { status: 'unavailable', reason: 'request_dialog' });
    assert.ok(strict.app.clicks.includes('dialog:cancel'));
    assert.equal(strict.app.overlay, 'none');
    assertNothingSent(strict.app);
  } finally {
    await strict.cleanup();
  }
  const lenient = await rig({}, { compose: true, attachment: route(downloads) });
  try {
    const { result } = await captured(lenient, '陈一', 'available');
    assert.equal(result.status, 'acquired');
    if (result.status === 'acquired') assert.equal(result.branch, 'online');
    assert.ok(lenient.app.clicks.includes('dialog:cancel'));
    assertNothingSent(lenient.app);
  } finally {
    await lenient.cleanup();
    await rm(downloads, { recursive: true, force: true });
  }
});

test('an attachment is saved only as exactly one new finished file that names the candidate', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const withFile = (fileName: string) => people().map((p, i) => (i === 0 ? { ...p, attachment: { fileName, bytes: pdf } } : p));
  type Result = Awaited<ReturnType<typeof captured>>['result'];
  const reason = (res: Result) => (res.status === 'failed' ? res.reason.split(':')[0] : res.status);
  const scenarios: Array<[string, string, string | undefined, (res: Result) => void]> = [
    ['named file', '陈一_前端工程师.pdf', undefined, (res) => {
      assert.equal(res.status, 'acquired');
      if (res.status === 'acquired') {
        assert.equal(res.branch, 'attachment');
        assert.deepEqual(res.artifacts.map((a) => a.kind), ['original', 'metadata']);
      }
    }],
    ['unnamed file', 'resume.pdf', undefined, (res) => assert.equal(reason(res), 'download_identity_unconfirmed')],
    ['two new files', '陈一.pdf', 'other.pdf', (res) => assert.equal(reason(res), 'download_ambiguous')],
    ['never finishes', '陈一.pdf.crdownload', undefined, (res) => assert.equal(reason(res), 'download_timeout')],
  ];
  for (const [label, fileName, extraDownload, expect] of scenarios) {
    const downloads = await mkdtemp(join(tmpdir(), 'boss-dl-'));
    const r = await rig({ people: withFile(fileName), downloads, extraDownload }, { attachment: route(downloads), input: { captureMode: 'original-only' } });
    try {
      const { result, staging } = await captured(r, '陈一', 'original-only');
      expect(result);
      if (label === 'named file') assert.ok((await readFile(join(staging.dir, 'original', 'attachment.pdf'))).equals(pdf));
      assertNothingSent(r.app);
    } finally {
      await r.cleanup();
      await rm(downloads, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Return and list progress

test('return_to_list closes the resume by its close control', async () => {
  const r = await rig();
  try {
    const { ctx } = await openPerson(r, '陈一');
    assert.equal((await r.workflow.runScripted('open_resume', ctx)!).ok, true);
    const back = await r.workflow.runScripted('return_to_list', ctx)!;
    assert.equal(back.ok, true, back.reason);
    assert.ok(r.app.clicks.includes('close'));
    assert.equal((await r.workflow.verifyUnit('return_to_list', ctx, back.observation)).ok, true);
    assertNothingSent(r.app);
  } finally {
    await r.cleanup();
  }
});

const crowd = (n: number): Person[] =>
  Array.from({ length: n }, (_, i) => ({ name: `候选${i}`, position: '前端工程师', time: `${10 + (i % 9)}:0${i % 10}`, unread: 0, preview: `示例${i}`, summary: ['30岁', '5年', '本科'] as [string, string, string], history: [`2020.01-至今 公司${i} · 前端`], bodyLines: 5 }));

test('advance_list moves to new rows, and confirms the end only with evidence', async () => {
  const r = await rig({ people: crowd(20) });
  try {
    const ctx = r.context();
    const first = listCandidates(await r.app.observe(), ACCOUNT);
    assert.equal(first.endReached, false);
    const moved = await r.workflow.runScripted('advance_list', ctx)!;
    assert.equal(moved.ok, true, moved.reason);
    assert.notEqual(listCandidates(moved.observation, ACCOUNT).fingerprint, first.fingerprint);
    assert.equal((await r.workflow.verifyUnit('advance_list', { ...ctx, bindings: { 'list.fingerprint': first.fingerprint } }, moved.observation)).ok, true);
    // Keep going until the end: the last screen fills the column, so the end is proved by a scroll probe.
    let last = moved;
    for (let i = 0; i < 10 && last.reason !== 'end_reached'; i++) last = await r.workflow.runScripted('advance_list', ctx)!;
    assert.equal(last.ok, true);
    assert.equal(last.reason, 'end_reached');
    assert.equal((await r.workflow.verifyUnit('advance_list', ctx, last.observation)).ok, true);
    // Every candidate was seen at some point: none skipped between screens.
  } finally {
    await r.cleanup();
  }
  const stuck = await rig({ people: crowd(20), listScrollStuck: true });
  try {
    const result = await stuck.workflow.runScripted('advance_list', stuck.context())!;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'scroll_ineffective');
  } finally {
    await stuck.cleanup();
  }
  const short = await rig({ people: crowd(3) });
  try {
    const result = await short.workflow.runScripted('advance_list', short.context())!;
    assert.deepEqual([result.ok, result.reason], [true, 'end_reached']);
    assert.ok(short.app.actions.length >= 3, 'a short list is proved unscrollable before it counts as ended');
    assert.equal((await short.workflow.verifyUnit('advance_list', short.context(), result.observation)).ok, true);
  } finally {
    await short.cleanup();
  }
});

test('only an end notice inside the list column, outside the rows, ends the list', async () => {
  const list = crowd(3);
  list[0] = { ...list[0]!, preview: '没有更多' };
  const r = await rig({ people: list });
  try {
    r.app.open = 1;
    const o = await r.app.observe();
    // A chat line in the conversation pane with the same words.
    o.elements!.push({ index: 9999, role: 'AXStaticText', value: '暂无牛人', frame: { x: WIN.x + 700, y: WIN.y + 500, width: 60, height: 15 } });
    assert.equal(listCandidates(o, ACCOUNT).endReached, false);
    // The real notice: in the list column, below the rows.
    o.elements!.push({ index: 9998, role: 'AXStaticText', value: '没有更多了', frame: { x: WIN.x + 260, y: WIN.y + 520, width: 70, height: 15 } });
    assert.equal(listCandidates(o, ACCOUNT).endReached, true);
  } finally {
    await r.cleanup();
  }
});

test('a short list that is still loading or still changing is not ended', async () => {
  const r = await rig({ people: crowd(3) });
  try {
    let reads = 0;
    r.app.beforeObserve = (app) => {
      // A fourth row arrives a moment after the scrolls.
      if (++reads === 6) app.persons.push({ ...crowd(4)[3]! });
    };
    const changing = await r.workflow.runScripted('advance_list', r.context())!;
    assert.equal(changing.ok, true);
    assert.notEqual(changing.reason, 'end_reached');
  } finally {
    await r.cleanup();
  }
  const loading = await rig({ people: crowd(3) });
  try {
    const base = loading.app.observe.bind(loading.app);
    loading.app.observe = async (options, signal) => {
      const o = await base(options, signal);
      o.elements!.push({ index: 9997, role: 'AXStaticText', value: '加载中...', frame: { x: WIN.x + 280, y: WIN.y + 600, width: 60, height: 15 } });
      return o;
    };
    const result = await loading.workflow.runScripted('advance_list', loading.context())!;
    assert.deepEqual([result.ok, result.reason], [false, 'list_still_loading']);
  } finally {
    await loading.cleanup();
  }
});

test('walking the list with advance_list sees every candidate once', async () => {
  const r = await rig({ people: crowd(23) });
  try {
    const ctx = r.context();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const c of listCandidates(await r.app.observe(), ACCOUNT).candidates) seen.add(c.name);
      const step = await r.workflow.runScripted('advance_list', ctx)!;
      assert.equal(step.ok, true, step.reason);
      if (step.reason === 'end_reached') break;
    }
    for (const c of listCandidates(await r.app.observe(), ACCOUNT).candidates) seen.add(c.name);
    assert.equal(seen.size, 23);
  } finally {
    await r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// With the real artifact store: the captured files land under the right person

test('staged capture validates and archives under the identified candidate with the real artifact store', async () => {
  const r = await rig({}, { compose: true });
  const out = await mkdtemp(join(tmpdir(), 'boss-out-'));
  try {
    const store = createArtifactStore({ outputDir: out, taskId: 'task-1' });
    const { ref, ctx } = await openPerson(r, '陈一');
    const match = identify(await r.app.observe(), ref, ACCOUNT);
    assert.equal(match.kind, 'match');
    if (match.kind !== 'match') return;
    const staging = await store.stage('item-1');
    const result = await r.workflow.acquireResume({ ...ctx, staging }, 'available');
    assert.equal(result.status, 'acquired');
    if (result.status !== 'acquired') return;
    const records: ArtifactRecord[] = [];
    for (const staged of result.artifacts) {
      const validation = await store.validate(staged);
      assert.deepEqual(validation.problems, [], `${staged.kind} ${staged.path}`);
      records.push(await store.archive(staged, match.identity, validation, []));
    }
    assert.ok(isCountable(records, 'available'));
    assert.ok(!isCountable(records, 'original-only'), 'a page capture never counts as an original');
    assert.ok(records.every((a) => a.relativePath.startsWith(`candidates/${match.identity.candidateId}/`)));
    const image = records.find((a) => a.kind === 'captured_image')!;
    assert.equal(image.completeness, 'complete');
    const files = await readdir(join(store.root, 'candidates', match.identity.candidateId, 'captured', 'pages'));
    assert.equal(files.length, records.filter((a) => a.kind === 'captured_page').length);
  } finally {
    await r.cleanup();
    await rm(out, { recursive: true, force: true });
  }
});
