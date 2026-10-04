// Getting a resume into the item's staging directory.
//
// Online resume: BOSS draws the body as one image, so the text comes from
// local OCR of screenshots of that pane. The capture goes to the top,
// expands folded sections (查看全部), and scrolls down keeping each new
// screen, measuring the overlap with the previous one. It is complete only
// with a confirmed top and two independent bottom signals: the platform's
// footer disclosure under the content, and a controlled probe showing the
// pane is at its scroll end (it scrolls up, comes back to the same image,
// and goes no further). Identical screens alone never end a capture.
//
// The top has no platform mark: the real image (BOSS 1.7.4) starts with the
// candidate's avatar, name and activity, then the summary. The top counts
// as confirmed only when upward scrolls stopped changing the pane, the
// mirror probe shows the scroll start (down changes it, up comes back to
// the same image, a further up changes nothing), and that image's first
// text row near its top is the listed name.
//
// Original attachment: not verified on macOS (P0 had no received
// attachment), so the route is off unless explicitly enabled. When enabled,
// the file must appear as exactly one new, finished file whose name names
// the candidate; anything else is reported, never guessed.

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RuntimeError,
  captureCompleteness,
  isRuntimeError,
  rectContains,
  screenshotToGlobal,
  throwIfAborted,
  type AcquisitionResult,
  type CaptureEvidence,
  type ComposedImage,
  type ImageComparison,
  type LocalVision,
  type Observation,
  type OcrLine,
  type OcrResult,
  type Rect,
  type ScreenshotRef,
  type Session,
  type StagedArtifact,
  type StagingArea,
} from '../../../../packages/task-runtime/src/contracts.ts';
import { centerOf, clickElement, clickPoint, delivered, look, pollFor, scrollOver, sleep, type Env, type Trace } from './actions.ts';
import { normalize } from './candidates.ts';
import { attachmentPreview, openChat, requestDialog, resumeOverlay, text, type ResumeOverlay } from './pages.ts';

export interface CaptureLimits {
  /** Screens kept before stopping with page_limit. */
  maxPages: number;
  /** Lines per downward scroll; small enough that screens overlap. */
  scrollLines: number;
  /** Wait after a scroll or click before reading the pane again. */
  settleMs: number;
  /** How long the resume may show 正在加载简历. */
  loadTimeoutMs: number;
  /** Upward scrolls allowed while looking for the top. */
  maxTopScrolls: number;
  /** Similarity at or above which two screens count as the same. */
  sameSimilarity: number;
  /** Overlap a new screen must share with the last one to be placed after it. */
  minOverlapPx: number;
  /** Clicks on 查看全部 allowed in one capture. */
  maxExpansions: number;
  /**
   * Points below the content's top within which the candidate's name must
   * sit on the top screen, as its first text row. The header row (avatar,
   * name, activity) is the first thing in the image; 120 pt leaves room for
   * a tall avatar without reaching into the body.
   */
  headerMaxPt: number;
  /**
   * Points at the pane's right edge left out of comparing and stitching: the
   * scrollbar moves there on every scroll while the content does not. P0
   * (BOSS 1.7.4, macOS) measured 4 pt; 8 pt keeps a margin.
   */
  gutterPt: number;
  /**
   * Points at the pane's top edge left out of comparing and stitching: the
   * viewport clips the first row of content there, so it differs between
   * overlapping screens (P0: all non-scrollbar differences in the first 1 pt).
   */
  topBorderPt: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxPages: 40,
  scrollLines: 8,
  settleMs: 400,
  loadTimeoutMs: 20_000,
  maxTopScrolls: 30,
  sameSimilarity: 0.995,
  minOverlapPx: 48,
  maxExpansions: 12,
  headerMaxPt: 120,
  gutterPt: 8,
  topBorderPt: 1,
};

/**
 * The content part of a pane screenshot, in its own pixels: everything but
 * the scrollbar gutter on the right and the clipped border row at the top.
 * Pixels per point come from the measured covers, never from an assumed
 * scale (P0 at 2x: x 0, y 2, 1452 x 1694 of a 1468 x 1696 screen).
 */
export function contentRoi(shot: Pick<ScreenshotRef, 'widthPx' | 'heightPx' | 'covers'>, insets: { gutterPt: number; topBorderPt: number }): Rect {
  const gutterPx = Math.ceil((insets.gutterPt * shot.widthPx) / shot.covers.width);
  const topPx = Math.ceil((insets.topBorderPt * shot.heightPx) / shot.covers.height);
  return { x: 0, y: topPx, width: Math.max(1, shot.widthPx - gutterPx), height: Math.max(1, shot.heightPx - topPx) };
}

/**
 * The platform's disclosure printed under every online resume (P0, BOSS
 * 1.7.4): UI text, not candidate data. Matched as substrings of the OCR of
 * the pane's lower part, with spaces removed.
 */
export const FOOTER_MARKERS = ['为妥善保护牛人在boss直聘平台提交', '在线浏览牛人简历'];
/** Lines the footer may wrap into on a narrow pane. */
const FOOTER_LINES = 4;
/**
 * The activity note BOSS prints after the name in the header row, in case
 * OCR reads the two as one line. Matched against what follows the name.
 */
export const HEADER_ACTIVITY = /^(刚刚活跃|今日活跃|昨日活跃|本周活跃|本月活跃|半年内活跃|\d+(日|天|周|月)内活跃|在线)$/;

interface Frame {
  observation: Observation;
  shot: ScreenshotRef;
  overlay: ResumeOverlay;
}

interface Kept {
  path: string;
  shot: ScreenshotRef;
  ocr: OcrResult;
  /** Pixels the content moved up from the previous kept screen. */
  shiftPx?: number;
}

export interface CaptureInput {
  session: Session;
  env: Env;
  staging: StagingArea;
  itemId: string;
  /** The listed name of the candidate whose resume this must be. */
  candidateName: string;
  trace: Trace;
  signal: AbortSignal;
  limits?: Partial<CaptureLimits>;
}

const ocrText = (lines: readonly OcrLine[]) => normalize(lines.map((l) => l.text).join(''));

/**
 * The footer disclosure as the last thing on the screen: found among the
 * bottom-most lines, with no resume content below it. A short resume shows
 * it under its last line, above the pane's bottom edge.
 */
export function footerVisible(ocr: OcrResult): boolean {
  const last = [...ocr.lines].sort((a, b) => a.box.y - b.box.y).slice(-FOOTER_LINES);
  const joined = ocrText(last);
  return FOOTER_MARKERS.some((m) => joined.includes(normalize(m)));
}

/** Where on a top screen the header name may sit, in the screenshot's pixels. */
export interface HeaderBand {
  /** Content top: lines ending above it are the clipped border row. */
  topPx: number;
  /** The name's line must start above this. */
  maxYPx: number;
  /** The name's line must start left of this (it follows the avatar). */
  maxXPx: number;
}

/** The band for a screenshot, converted by its measured pixels per point. */
export function headerBand(shot: Pick<ScreenshotRef, 'widthPx' | 'heightPx' | 'covers'>, limits: { headerMaxPt: number; topBorderPt: number }): HeaderBand {
  const pxPerPt = shot.heightPx / shot.covers.height;
  const topPx = Math.ceil(limits.topBorderPt * pxPerPt);
  return { topPx, maxYPx: topPx + Math.floor(limits.headerMaxPt * pxPerPt), maxXPx: Math.floor(shot.widthPx * 0.6) };
}

const isHeaderName = (line: string, want: string) => {
  const t = normalize(line);
  return t === want || (t.startsWith(want) && HEADER_ACTIVITY.test(t.slice(want.length)));
};

/**
 * Whether `name` is the resume's header on this screen: one OCR line that
 * reads exactly the name (or the name and its activity note), starting in
 * the band near the top and left, with no other text above it. The name
 * anywhere else, inside a longer line, or under other text is not a header.
 */
export function headerShowsName(ocr: OcrResult, name: string, band: HeaderBand): boolean {
  const want = normalize(name);
  if (!want) return false;
  const lines = ocr.lines.filter((l) => normalize(l.text) && l.box.y + l.box.height > band.topPx);
  return lines.some((l) => isHeaderName(l.text, want)
    && l.box.y < band.maxYPx && l.box.x < band.maxXPx
    && !lines.some((o) => o !== l && o.box.y + o.box.height / 2 < l.box.y));
}

const isFold = (l: OcrLine) => normalize(l.text) === '查看全部';
const isUnfold = (l: OcrLine) => normalize(l.text) === '收起';

/**
 * The listed name shown as a text beside the resume, in the overlay's side
 * column: right of the pane and inside the overlay group. Without a reported
 * group nothing scopes the text to the overlay, so it does not count. Text
 * over the pane never counts either: the conversation behind the overlay
 * keeps its header name there, occluded but still in the tree (P0).
 * BOSS 1.7.4 shows no name in that column; the resume header is read instead.
 */
export function overlayShowsName(observation: Observation, overlay: ResumeOverlay, name: string): boolean {
  const want = normalize(name);
  const right = overlay.pane.x + overlay.pane.width;
  const box = overlay.group?.frame;
  if (!want || !box) return false;
  return (observation.elements ?? []).some(
    (e) => e.role === 'AXStaticText' && e.frame && e.frame.x >= right
      && rectContains(box, e.frame) && normalize(text(e)) === want,
  );
}

/** What one pane screenshot says about whose resume is open. */
export type HeaderReading = 'match' | 'other' | 'no_pane' | 'no_screenshot' | 'not_this_image' | 'ocr_failed';

/**
 * Read the resume header of `observation` itself: its overlay must be open
 * and loaded, its screenshot must cover exactly that overlay's pane, and the
 * OCR must report reading those very bytes (same sha256 and size), so a file
 * replaced since, another region or another read cannot stand in for it.
 * Nothing is cached; each call OCRs the screenshot it is given.
 */
export async function readResumeHeader(
  vision: LocalVision,
  observation: Observation,
  name: string,
  limits: { headerMaxPt: number; topBorderPt: number },
  signal: AbortSignal,
  env?: Pick<Env, 'telemetry'>,
): Promise<HeaderReading> {
  const overlay = resumeOverlay(observation);
  if (!overlay || overlay.loading) return 'no_pane';
  const shot = observation.screenshot;
  if (!shot) return 'no_screenshot';
  if (!samePane(shot.covers, overlay.pane)) return 'not_this_image';
  throwIfAborted(signal);
  env?.telemetry?.record({ type: 'ocr' });
  let ocr: OcrResult;
  try {
    ocr = await vision.ocr(shot.path, { languages: ['zh-Hans', 'en-US'] }, signal);
  } catch (error) {
    if (isRuntimeError(error, 'cancelled') || signal.aborted) throw error;
    return 'ocr_failed';
  }
  if (ocr.imageSha256 !== shot.sha256 || ocr.widthPx !== shot.widthPx || ocr.heightPx !== shot.heightPx) return 'not_this_image';
  return headerShowsName(ocr, name, headerBand(shot, limits)) ? 'match' : 'other';
}

export type ResumeIdentity =
  | { ok: true; observation: Observation; by: 'overlay_text' | 'resume_header' }
  | { ok: false; observation: Observation; reason: string };

/**
 * Whether the open, loaded resume is `name`'s: the overlay's side column
 * names them, or else the resume image's own header does, read by local OCR
 * from a screenshot of this pane. `observation` is used first when it
 * carries a fitting screenshot; otherwise, or while the header is not there
 * yet, fresh pane screenshots are read until `timeoutMs` passes (a resume
 * may draw its image a moment after the overlay reports loaded). A header
 * showing someone else, or no header, fails; without local OCR the header
 * cannot be read and the result says so.
 */
export async function confirmResumeIdentity(
  session: Session,
  env: Env,
  signal: AbortSignal,
  observation: Observation,
  name: string,
  options: { timeoutMs: number; limits?: Partial<CaptureLimits> },
): Promise<ResumeIdentity> {
  const limits = { ...DEFAULT_CAPTURE_LIMITS, ...options.limits };
  const first = resumeOverlay(observation);
  if (!first || first.loading) return { ok: false, observation, reason: 'resume_not_open' };
  if (overlayShowsName(observation, first, name)) return { ok: true, observation, by: 'overlay_text' };
  const vision = env.vision;
  if (!vision) return { ok: false, observation, reason: 'resume_identity_unconfirmed: local_vision_missing: the overlay does not name the candidate and the resume header needs local OCR' };
  let last: HeaderReading = 'no_screenshot';
  if (observation.screenshot) {
    last = await readResumeHeader(vision, observation, name, limits, signal, env);
    if (last === 'match') return { ok: true, observation, by: 'resume_header' };
    if (last === 'other') return { ok: false, observation, reason: 'resume_identity_unconfirmed: the resume header does not show the listed name' };
  }
  let pane = first.pane;
  let latest = observation;
  const start = env.clock.now().getTime();
  const reads = Math.max(1, Math.ceil(options.timeoutMs / Math.max(1, env.pollMs)) + 1);
  for (let i = 0; i < reads; i++) {
    if (i > 0) {
      if (env.clock.now().getTime() - start >= options.timeoutMs) break;
      await sleep(env.pollMs, signal);
    }
    latest = await look(session, env, signal, { screenshot: true, region: pane });
    const overlay = resumeOverlay(latest);
    if (!overlay) return { ok: false, observation: latest, reason: 'resume_not_open' };
    if (overlay.loading) continue;
    // A pane that moved between reads is read again where it is now.
    if (!samePane(overlay.pane, pane)) {
      pane = overlay.pane;
      continue;
    }
    if (overlayShowsName(latest, overlay, name)) return { ok: true, observation: latest, by: 'overlay_text' };
    last = await readResumeHeader(vision, latest, name, limits, signal, env);
    if (last === 'match') return { ok: true, observation: latest, by: 'resume_header' };
  }
  const why = last === 'other' ? 'the resume header does not show the listed name' : `no readable resume header (${last})`;
  return { ok: false, observation: latest, reason: `resume_identity_unconfirmed: ${why}` };
}

/**
 * Capture the open online resume into `staging`. Returns `acquired` with
 * pages, text and metadata (and the stitched image when local vision can
 * compose); whether that counts is decided by the evidence, not here.
 */
export async function captureOnlineResume(input: CaptureInput): Promise<AcquisitionResult> {
  const { session, env, staging, signal, trace } = input;
  const limits = { ...DEFAULT_CAPTURE_LIMITS, ...input.limits };
  const vision = env.vision;
  if (!vision) return { status: 'failed', reason: 'local_vision_missing: the online resume is an image and needs local OCR' };

  const ready = await pollFor(session, env, signal, limits.loadTimeoutMs, (o) => {
    const overlay = resumeOverlay(o);
    return overlay && !overlay.loading ? overlay : undefined;
  });
  if (!ready.value) return { status: 'failed', reason: ready.observation.pageClass === 'loading' ? 'resume_load_timeout' : 'resume_not_open' };
  const pane = ready.value.pane;
  const axName = overlayShowsName(ready.observation, ready.value, input.candidateName);

  const pagesDir = join(staging.dir, 'pages');
  await mkdir(pagesDir, { recursive: true });
  const problems: string[] = [];

  let size: { widthPx: number; heightPx: number } | undefined;
  let roi: Rect | undefined;
  let band: HeaderBand | undefined;
  const shoot = async (): Promise<Frame> => {
    const observation = await look(session, env, signal, { screenshot: true, region: pane });
    const overlay = resumeOverlay(observation);
    if (!overlay || overlay.loading) throw new CaptureStop('resume_overlay_lost');
    const shot = observation.screenshot;
    if (!shot) throw new CaptureStop('no_screenshot');
    if (!samePane(overlay.pane, pane)) throw new CaptureStop('resume_pane_moved');
    // Comparing and stitching need screens of one size.
    size ??= { widthPx: shot.widthPx, heightPx: shot.heightPx };
    if (shot.widthPx !== size.widthPx || shot.heightPx !== size.heightPx) throw new CaptureStop('resume_pane_resized');
    roi ??= contentRoi(shot, limits);
    band ??= headerBand(shot, limits);
    return { observation, shot, overlay };
  };
  const ocr = async (path: string): Promise<OcrResult> => {
    throwIfAborted(signal);
    env.telemetry?.record({ type: 'ocr' });
    return vision.ocr(path, { languages: ['zh-Hans', 'en-US'] }, signal);
  };
  // Only the content is compared: a moving scrollbar is not a change of content.
  const compare = (a: string, b: string): Promise<ImageComparison> => vision.compare(a, b, roi ? { roi } : undefined, signal);
  const same = (c: ImageComparison) => c.similarity >= limits.sameSimilarity && !(c.verticalShiftPx && c.verticalShiftPx > 0);
  const scroll = async (from: Frame, direction: 'up' | 'down', lines: number) => {
    const result = await scrollOver(session, from.observation, pane, direction, lines, trace, signal);
    if (result.status === 'failed' || result.status === 'stale_snapshot' || result.status === 'unknown')
      throw new CaptureStop(`scroll_${result.status}`);
    await sleep(limits.settleMs, signal);
    return shoot();
  };

  const kept: Kept[] = [];
  const keep = async (frame: Frame, shiftPx?: number): Promise<Kept> => {
    const path = join(pagesDir, `page-${String(kept.length + 1).padStart(3, '0')}.png`);
    await copyFile(frame.shot.path, path);
    const page: Kept = { path, shot: frame.shot, ocr: await ocr(path), shiftPx };
    kept.push(page);
    return page;
  };

  let stop: CaptureEvidence['stop'] | undefined;
  let topConfirmed = false;
  let upNoChange = false;
  let topProbeOk = false;
  let headerName = false;
  let unexpanded = false;
  let expansions = 0;
  let footer = false;
  let probeOk = false;

  try {
    // Top: scroll up until a scroll changes nothing, then probe the start and require the header.
    let frame = await shoot();
    for (let i = 0; i < limits.maxTopScrolls; i++) {
      const next = await scroll(frame, 'up', Math.min(50, limits.scrollLines * 3));
      const c = await compare(frame.shot.path, next.shot.path);
      frame = next;
      if (same(c)) {
        upNoChange = true;
        break;
      }
    }
    if (upNoChange) ({ ok: topProbeOk, frame } = await probeStart(frame));

    /** Expand folded sections visible in `page`, replacing it with the expanded screen. */
    const expand = async (page: Kept, current: Frame): Promise<{ page: Kept; frame: Frame }> => {
      for (;;) {
        const fold = page.ocr.lines.find(isFold);
        if (!fold) return { page, frame: current };
        if (expansions >= limits.maxExpansions) {
          unexpanded = true;
          return { page, frame: current };
        }
        expansions++;
        const point = screenshotToGlobal(page.shot, centerOf(fold.box));
        if (!rectContains(pane, point)) {
          unexpanded = true;
          return { page, frame: current };
        }
        const folds = page.ocr.lines.filter(isFold).length;
        const unfolds = page.ocr.lines.filter(isUnfold).length;
        const result = await clickPoint(session, current.observation, point, trace, signal);
        if (!delivered(result)) {
          unexpanded = true;
          return { page, frame: current };
        }
        await sleep(limits.settleMs, signal);
        const after = await shoot();
        const afterOcr = await ocr(after.shot.path);
        const opened = afterOcr.lines.filter(isFold).length < folds || afterOcr.lines.filter(isUnfold).length > unfolds;
        if (!opened) {
          unexpanded = true;
          return { page, frame: current };
        }
        // The section opened in place: the expanded screen replaces this page.
        await copyFile(after.shot.path, page.path);
        const previous = kept.at(-2);
        const shiftPx = previous && page !== kept[0] ? (await compare(previous.path, page.path)).verticalShiftPx : page.shiftPx;
        const replaced: Kept = { path: page.path, shot: after.shot, ocr: afterOcr, shiftPx };
        kept[kept.length - 1] = replaced;
        page = replaced;
        current = after;
      }
    };

    let page = await keep(frame);
    headerName = headerShowsName(page.ocr, input.candidateName, band!);
    ({ page, frame } = await expand(page, frame));
    topConfirmed = upNoChange && topProbeOk && headerName;
    if (!axName && !headerName)
      return { status: 'failed', reason: 'resume_identity_unconfirmed: neither the overlay nor the resume header shows the listed name' };

    let progressed = false;
    let downNoChange = 0;
    let step = limits.scrollLines;
    while (!stop) {
      if (kept.length >= limits.maxPages) {
        stop = 'page_limit';
        break;
      }
      const next = await scroll(frame, 'down', step);
      const c = await compare(page.path, next.shot.path);
      if (same(c)) {
        frame = next;
        if (++downNoChange < 2) continue;
        // Stopped moving: look for the footer and probe the scroll end.
        footer = footerVisible(page.ocr);
        if (progressed) probeOk = await probeEnd(page, frame);
        stop = footer && probeOk ? 'bottom_confirmed' : 'scroll_ineffective';
        break;
      }
      downNoChange = 0;
      const overlap = c.verticalShiftPx !== undefined && c.verticalShiftPx > 0 ? next.shot.heightPx - c.verticalShiftPx : undefined;
      if (overlap === undefined || overlap < limits.minOverlapPx) {
        // Too far to place after the last screen: go back and take a smaller step once.
        if (step > 1) {
          const back = await scroll(next, 'up', step);
          if (same(await compare(page.path, back.shot.path))) {
            frame = back;
            step = Math.max(1, Math.floor(step / 2));
            continue;
          }
        }
        await keep(next, c.verticalShiftPx);
        stop = 'stitch_gap';
        break;
      }
      progressed = true;
      page = await keep(next, c.verticalShiftPx);
      frame = next;
      ({ page, frame } = await expand(page, frame));
    }

    /**
     * The scroll start, shown by control: from the top screen a scroll down
     * changes it, a scroll up returns to it, and a further scroll up leaves
     * it unchanged. Returns the last screen, which is the top image again
     * when the probe holds. Probe screens are not kept.
     */
    async function probeStart(top: Frame): Promise<{ ok: boolean; frame: Frame }> {
      const step = limits.scrollLines;
      const down = await scroll(top, 'down', step);
      if (same(await compare(top.shot.path, down.shot.path))) return { ok: false, frame: down };
      const up = await scroll(down, 'up', Math.min(50, step * 2));
      if (!same(await compare(top.shot.path, up.shot.path))) return { ok: false, frame: up };
      const further = await scroll(up, 'up', step);
      return { ok: same(await compare(top.shot.path, further.shot.path)), frame: further };
    }

    /**
     * The scroll end, shown by control rather than by sameness: from the
     * end screen a scroll up changes it, a scroll down returns to it, and a
     * further scroll down leaves it unchanged. Probe screens are not kept.
     */
    async function probeEnd(end: Kept, at: Frame): Promise<boolean> {
      const up = await scroll(at, 'up', step);
      if (same(await compare(end.path, up.shot.path))) return false;
      const down = await scroll(up, 'down', Math.min(50, step * 2));
      if (!same(await compare(end.path, down.shot.path))) return false;
      const further = await scroll(down, 'down', step);
      return same(await compare(end.path, further.shot.path));
    }
  } catch (error) {
    if (!(error instanceof CaptureStop)) throw error;
    problems.push(error.message);
    if (!kept.length) return { status: 'failed', reason: error.message };
    stop = 'scroll_ineffective';
  }

  if (unexpanded) problems.push('folded_section_not_expanded');
  if (kept.length && !topConfirmed)
    problems.push(`top_unconfirmed: ${[!upNoChange && 'up_scroll_kept_moving', upNoChange && !topProbeOk && 'start_probe_failed', !headerName && 'header_name_not_first_row'].filter(Boolean).join(',')}`);
  const evidence: CaptureEvidence = {
    pages: kept.length,
    topConfirmed,
    bottomSignals: [...(footer ? (['end_marker'] as const) : []), ...(probeOk ? (['scroll_position_end'] as const) : [])],
    // Folded text missing from the image is a gap in the content.
    stop: unexpanded && stop === 'bottom_confirmed' ? 'stitch_gap' : stop ?? 'scroll_ineffective',
  };

  const artifacts: StagedArtifact[] = kept.map((k) => ({ itemId: input.itemId, kind: 'captured_page', path: k.path, capture: evidence }));

  let composed: { sha256: string; hasGap: boolean } | undefined;
  if (vision.compose) {
    try {
      const out = join(staging.dir, `resume-${randomUUID().slice(0, 8)}.png`);
      const image: ComposedImage = await vision.compose(kept.map((k) => k.path), out, { roi, minOverlapPx: limits.minOverlapPx }, signal);
      if (image.hasGap || image.frames.some((f) => f.placement === 'gap')) evidence.stop = 'stitch_gap';
      composed = { sha256: image.sha256, hasGap: image.hasGap };
      artifacts.push({ itemId: input.itemId, kind: 'captured_image', path: image.path, capture: evidence });
    } catch (error) {
      if (signal.aborted) throw new RuntimeError('cancelled', 'the capture was cancelled');
      problems.push(`compose_failed: ${error instanceof RuntimeError ? error.code : 'error'}`);
    }
  } else {
    problems.push('compose_unavailable: local vision cannot stitch, so no countable resume image');
  }

  const body = resumeText(kept);
  if (body.trim()) {
    const path = join(staging.dir, 'resume.txt');
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' });
    artifacts.push({ itemId: input.itemId, kind: 'resume_text', path });
  }

  const metadataPath = join(staging.dir, 'metadata.json');
  const metadata = {
    schema: 'boss-resume-capture-v1',
    branch: 'online',
    capturedAt: env.clock.now().toISOString(),
    completeness: captureCompleteness(evidence),
    capture: evidence,
    pages: kept.map((k, i) => ({ index: i + 1, sha256: k.shot.sha256, widthPx: k.shot.widthPx, heightPx: k.shot.heightPx, shiftPx: k.shiftPx ?? null })),
    expansions: { clicked: expansions, allExpanded: !unexpanded },
    // Pages are kept whole; comparison and the stitched image leave out the scrollbar gutter and top border.
    contentRoi: roi ?? null,
    gutterPt: limits.gutterPt,
    topBorderPt: limits.topBorderPt,
    identity: { overlayName: axName, resumeHeaderName: headerName },
    top: { upScrollStable: upNoChange, startProbe: topProbeOk, headerName, headerMaxPt: limits.headerMaxPt },
    composed: composed ?? null,
    problems,
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', flag: 'wx' });
  artifacts.push({ itemId: input.itemId, kind: 'metadata', path: metadataPath });
  return { status: 'acquired', artifacts, branch: 'online' };
}

class CaptureStop extends Error {}

const samePane = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

/**
 * The resume's text, top to bottom: every line of the first screen, then of
 * each later screen only the lines below what the screen before it read.
 * The boundary is the bottom of the last line OCR read on the previous
 * screen, moved up by the measured shift, so a line cut off at one screen's
 * edge is taken from the next. Without a measured shift a screen contributes
 * all its lines.
 */
export function resumeText(pages: ReadonlyArray<Pick<Kept, 'ocr' | 'shiftPx'>>): string {
  const out: string[] = [];
  pages.forEach((p, i) => {
    const lines = [...p.ocr.lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const before = pages[i - 1];
    if (!before || p.shiftPx === undefined) {
      out.push(...lines.map((l) => l.text));
      return;
    }
    const read = Math.max(0, ...before.ocr.lines.map((l) => l.box.y + l.box.height)) - p.shiftPx;
    out.push(...lines.filter((l) => l.box.y + l.box.height / 2 > read).map((l) => l.text));
  });
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Original attachment

export interface AttachmentRoute {
  /** Off until a download route is verified on the real app. */
  enabled: boolean;
  /** Where the app saves a download; watched for exactly one new file. */
  downloadsDir?: string;
  timeoutMs: number;
  stableMs: number;
  /** How long to wait for the preview or the request confirm after clicking 附件简历. */
  openTimeoutMs: number;
}

export const ATTACHMENT_ROUTE_OFF: AttachmentRoute = { enabled: false, timeoutMs: 60_000, stableMs: 1_000, openTimeoutMs: 10_000 };

const TEMP_SUFFIX = /\.(crdownload|download|part|partial|tmp)$|^\.|\.~/i;

/** Content type by header bytes; undefined for anything not a resume document. */
async function sniff(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    const b = head.subarray(0, bytesRead);
    if (b.subarray(0, 5).toString('latin1') === '%PDF-') return '.pdf';
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return '.docx';
    if (b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return '.doc';
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
    return undefined;
  } finally {
    await handle.close();
  }
}

interface DirEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

async function listDir(dir: string): Promise<Map<string, DirEntry>> {
  const out = new Map<string, DirEntry>();
  for (const name of await readdir(dir)) {
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) out.set(name, { name, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // Gone between listing and stat: a download in flux.
    }
  }
  return out;
}

export interface AttachmentInput {
  session: Session;
  env: Env;
  staging: StagingArea;
  itemId: string;
  candidateName: string;
  route: AttachmentRoute;
  trace: Trace;
  signal: AbortSignal;
}

/** Dismiss a request-resume confirm with 取消 and check it is gone. Never touches 确认. */
export async function dismissRequestDialog(session: Session, env: Env, observation: Observation, trace: Trace, signal: AbortSignal): Promise<boolean> {
  const dialog = requestDialog(observation);
  if (!dialog) return true;
  if (!dialog.cancel) return false;
  const result = await clickElement(session, observation, dialog.cancel, trace, signal);
  if (result.status === 'failed' || result.status === 'stale_snapshot') return false;
  const gone = await pollFor(session, env, signal, 5_000, (o) => (requestDialog(o) ? undefined : true));
  return gone.value === true;
}

/**
 * Open the attachment from the open conversation and save the original.
 * A request confirm means there is no attachment to view: it is dismissed
 * and reported, never confirmed.
 */
export async function fetchAttachment(input: AttachmentInput): Promise<AcquisitionResult> {
  const { session, env, route, trace, signal } = input;
  if (!route.enabled || !route.downloadsDir)
    throw new RuntimeError('capability_missing', 'saving the original attachment is not a verified route on macOS');
  const start = await look(session, env, signal);
  if (start.pageClass !== 'conversation_detail' || !openChat(start)) return { status: 'failed', reason: 'conversation_not_open' };
  const win = start.window.frame;
  const button = (start.elements ?? []).find((e) => text(e) === '附件简历' && e.frame && e.frame.y - win.y < 100);
  if (!button) return { status: 'unavailable', reason: 'no_attachment' };
  const opened = await clickElement(session, start, button, trace, signal);
  if (!delivered(opened)) return { status: 'failed', reason: `attachment_click_${opened.status}` };

  const shown = await pollFor(session, env, signal, route.openTimeoutMs, (o) =>
    o.pageClass === 'request_resume_dialog' || o.pageClass === 'attachment_preview' ? o.pageClass : undefined);
  if (shown.value === 'request_resume_dialog') {
    const dismissed = await dismissRequestDialog(session, env, shown.observation, trace, signal);
    return dismissed ? { status: 'unavailable', reason: 'request_dialog' } : { status: 'failed', reason: 'request_dialog_not_dismissed' };
  }
  if (shown.value !== 'attachment_preview') return { status: 'failed', reason: 'attachment_not_opened' };
  const preview = attachmentPreview(shown.observation);
  if (!preview?.download) return { status: 'unavailable', reason: 'download_unavailable' };

  const dir = route.downloadsDir;
  const before = await listDir(dir);
  const clickedAt = env.clock.now().getTime();
  const clicked = await clickElement(session, shown.observation, preview.download, trace, signal);
  if (!delivered(clicked)) return { status: 'failed', reason: `download_click_${clicked.status}` };

  // Exactly one new finished file, unchanged for stableMs, written after the click.
  const deadline = clickedAt + route.timeoutMs;
  const reads = Math.ceil(route.timeoutMs / Math.max(1, env.pollMs)) + 1;
  let last: DirEntry | undefined;
  let stableSince = 0;
  let found: DirEntry | undefined;
  for (let i = 0; i < reads && env.clock.now().getTime() <= deadline; i++) {
    throwIfAborted(signal);
    const now = await listDir(dir);
    const fresh = [...now.values()].filter((e) => {
      const old = before.get(e.name);
      return !old || old.mtimeMs !== e.mtimeMs || old.size !== e.size;
    });
    const finished = fresh.filter((e) => !TEMP_SUFFIX.test(e.name) && e.size > 0);
    const pending = fresh.some((e) => TEMP_SUFFIX.test(e.name));
    if (finished.length > 1) return { status: 'failed', reason: 'download_ambiguous: more than one new file appeared' };
    const one = finished[0];
    if (one && !pending) {
      if (last && last.name === one.name && last.size === one.size && last.mtimeMs === one.mtimeMs) {
        if (env.clock.now().getTime() - stableSince >= route.stableMs) {
          found = one;
          break;
        }
      } else {
        last = one;
        stableSince = env.clock.now().getTime();
      }
    }
    await sleep(env.pollMs, signal);
  }
  if (!found) return { status: 'failed', reason: 'download_timeout' };
  if (!normalize(found.name).includes(normalize(input.candidateName)))
    return { status: 'failed', reason: 'download_identity_unconfirmed: the new file does not name the candidate' };
  const source = join(dir, found.name);
  const ext = await sniff(source);
  if (!ext || ext === '.png' || ext === '.jpg') return { status: 'failed', reason: 'download_unrecognized: not a resume document' };
  const originalDir = join(input.staging.dir, 'original');
  await mkdir(originalDir, { recursive: true });
  const target = join(originalDir, `attachment${ext}`);
  await copyFile(source, target);
  const metadataPath = join(input.staging.dir, 'metadata.json');
  const digest = createHash('sha256').update(found.name).digest('hex').slice(0, 16);
  await writeFile(metadataPath, JSON.stringify({
    schema: 'boss-resume-capture-v1',
    branch: 'attachment',
    capturedAt: env.clock.now().toISOString(),
    download: { sourceNameHash: digest, bytes: found.size, type: ext },
  }, null, 2), { encoding: 'utf8', flag: 'wx' });
  return {
    status: 'acquired',
    branch: 'attachment',
    artifacts: [
      { itemId: input.itemId, kind: 'original', path: target },
      { itemId: input.itemId, kind: 'metadata', path: metadataPath },
    ],
  };
}
