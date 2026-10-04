// Local vision: on-device OCR, screen comparison and page composing through
// the native macOS helper (`2ndscreen vision`, Apple Vision + ImageIO). Each
// call runs one helper process: one JSON request line on stdin, one JSON
// reply line on stdout. The helper only reads image files the runtime
// already has and writes a compose output; it never takes a screenshot,
// sends input, or calls a model or the network.
//
// Every rect is in pixels of the image passed in, origin top-left. What the
// helper reports are observations: an unchanged screen is "no progress", a
// clean compose is a stitched image, and neither is proof that a resume was
// captured to its end; captureCompleteness decides that from other evidence.
//
// Cancellation and timeouts stop the helper with SIGTERM (it deletes a
// partial compose file and exits), then SIGKILL after a grace period; a call
// settles only after the process has exited.

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  RuntimeError,
  encodeJsonLine,
  throwIfAborted,
  type ComposeOptions,
  type ComposedFrame,
  type ComposedImage,
  type ImageComparison,
  type LineProcess,
  type LineProcessSpawner,
  type LocalVision,
  type OcrLine,
  type OcrResult,
  type Rect,
  type RuntimeErrorCode,
} from '../contracts.ts';

export const LOCAL_VISION_PROTOCOL_VERSION = 1;

export interface LocalVisionOptions {
  helper: string; // 原生 macOS Vision 辅助程序路径（2ndscreen 可执行文件）
  spawn: LineProcessSpawner;
  /** Arguments that select the helper subcommand; default ['vision']. */
  helperArgs?: readonly string[];
  env?: Record<string, string>;
  /** Per call; default by operation (OCR/compare 30 s, compose 120 s, metadata 10 s). */
  timeoutMs?: number;
  /** After SIGTERM, how long to wait before SIGKILL; default 2000. */
  killGraceMs?: number;
}

export interface ImageMetadata {
  widthPx: number;
  heightPx: number;
  bytes: number;
  sha256: string;
  /** Uniform type, e.g. public.png. */
  type: string;
}

/** LocalVision with the optional compose present, plus image metadata. */
export interface LocalVisionClient extends LocalVision {
  compose(framePaths: readonly string[], outputPath: string, options?: ComposeOptions, signal?: AbortSignal): Promise<ComposedImage>;
  metadata(imagePath: string, signal?: AbortSignal): Promise<ImageMetadata>;
}

type Op = 'ocr' | 'compare' | 'compose' | 'metadata';

const DEFAULT_TIMEOUT_MS: Record<Op, number> = { ocr: 30_000, compare: 30_000, compose: 120_000, metadata: 10_000 };
const DEFAULT_KILL_GRACE_MS = 2_000;
/** Mirrors the helper's limits so a bad call fails before a process starts. */
export const LOCAL_VISION_LIMITS = {
  maxFrames: 64,
  maxLanguages: 8,
  maxPathBytes: 4096,
  minOverlapPx: { min: 1, max: 4096 },
  /** Largest reply accepted from the helper; a full resume page of OCR lines fits easily. */
  maxReplyBytes: 16 << 20,
} as const;

const ERROR_CODES: ReadonlySet<RuntimeErrorCode> = new Set<RuntimeErrorCode>([
  'invalid_input',
  'not_found',
  'io',
  'conflict',
  'cancelled',
  'timeout',
  'capability_missing',
  'permission_missing',
  'storage_full',
]);
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function createLocalVision(options: LocalVisionOptions): LocalVisionClient {
  const helperArgs = [...(options.helperArgs ?? ['vision'])];
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const running = new Map<LineProcess, () => void>();
  let closed = false;

  async function call(op: Op, body: Record<string, unknown>, signal: AbortSignal | undefined, onStopped?: () => Promise<void>): Promise<Record<string, unknown>> {
    if (closed) throw new RuntimeError('cancelled', 'local vision is closed');
    throwIfAborted(signal);
    const child = options.spawn(options.helper, helperArgs, options.env);
    let stopped: 'cancelled' | 'timeout' | 'overflow' | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: 'cancelled' | 'timeout' | 'overflow') => {
      if (stopped) return;
      stopped = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    running.set(child, () => stop('cancelled'));
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS[op]);
    const replies: string[] = [];
    let writeError: unknown;
    try {
      try {
        child.write(encodeJsonLine({ v: LOCAL_VISION_PROTOCOL_VERSION, op, ...body }));
        child.closeInput();
      } catch (error) {
        // The helper died before reading; its exit tells the rest.
        writeError = error;
      }
      const reading = (async () => {
        let bytes = 0;
        for await (const line of child.lines()) {
          bytes += Buffer.byteLength(line, 'utf8') + 1;
          if (bytes > LOCAL_VISION_LIMITS.maxReplyBytes) {
            stop('overflow');
            continue;
          }
          if (line.trim() !== '') replies.push(line);
        }
      })();
      const [exit] = await Promise.all([child.exited(), reading.catch(() => undefined)]);
      if (stopped === 'cancelled' || stopped === 'timeout') {
        await onStopped?.().catch(() => undefined);
        if (stopped === 'cancelled') throw new RuntimeError('cancelled', `local vision ${op} was cancelled`);
        throw new RuntimeError('timeout', `local vision ${op} timed out`, { op });
      }
      if (stopped === 'overflow') throw new RuntimeError('io', `local vision ${op} replied with more than ${LOCAL_VISION_LIMITS.maxReplyBytes} bytes`);
      if (replies.length !== 1) {
        throw new RuntimeError('io', `local vision ${op} gave ${replies.length} reply lines and exited with ${exit.code ?? exit.signal}`, {
          exitCode: exit.code,
          signal: exit.signal,
          ...(writeError ? { writeError: String(writeError) } : {}),
        });
      }
      return parseReply(op, replies[0]!, exit.code);
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      running.delete(child);
    }
  }

  return {
    async ocr(imagePath, opts, signal) {
      const body: Record<string, unknown> = { image: checkPath(imagePath, 'imagePath') };
      if (opts?.roi !== undefined) body.roi = checkRect(opts.roi);
      if (opts?.languages !== undefined) body.languages = checkLanguages(opts.languages);
      return toOcrResult(await call('ocr', body, signal));
    },

    async compare(beforePath, afterPath, opts, signal) {
      const body: Record<string, unknown> = { before: checkPath(beforePath, 'beforePath'), after: checkPath(afterPath, 'afterPath') };
      if (opts?.roi !== undefined) body.roi = checkRect(opts.roi);
      return toComparison(await call('compare', body, signal));
    },

    async compose(framePaths, outputPath, opts, signal) {
      if (!Array.isArray(framePaths) || framePaths.length < 1 || framePaths.length > LOCAL_VISION_LIMITS.maxFrames) {
        throw new RuntimeError('invalid_input', `framePaths must list 1 to ${LOCAL_VISION_LIMITS.maxFrames} images`);
      }
      const output = checkPath(outputPath, 'outputPath');
      if (!/\.png$/i.test(output)) throw new RuntimeError('invalid_input', 'outputPath must end in .png');
      // The nonce names this call's partial file, so a cleanup after SIGKILL
      // can only ever remove the file this call's helper created.
      const nonce = randomUUID();
      const body: Record<string, unknown> = { frames: framePaths.map((p, i) => checkPath(p, `framePaths[${i}]`)), output, nonce };
      if (opts?.roi !== undefined) body.roi = checkRect(opts.roi);
      if (opts?.minOverlapPx !== undefined) body.minOverlapPx = checkMinOverlap(opts.minOverlapPx);
      // A helper killed before it could clean up leaves only its own hidden partial file.
      const removePartial = () => rm(partialComposePath(output, nonce), { force: true });
      const result = toComposed(await call('compose', body, signal, removePartial), framePaths.length);
      if (result.path !== output) throw new RuntimeError('io', `local vision wrote ${result.path}, not ${output}`);
      return result;
    },

    async metadata(imagePath, signal) {
      return toMetadata(await call('metadata', { image: checkPath(imagePath, 'imagePath') }, signal));
    },

    async close() {
      closed = true;
      const children = [...running.entries()];
      for (const [, stop] of children) stop();
      await Promise.all(children.map(([child]) => child.exited().catch(() => undefined)));
    },
  };
}

/** Where the helper writes the compose with `nonce` before linking it into place: hidden, next to the output. */
export function partialComposePath(outputPath: string, nonce: string): string {
  return join(dirname(outputPath), `.${basename(outputPath)}.${nonce}.partial`);
}

// ---------------------------------------------------------------------------
// Input checks

function checkPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || !isAbsolute(value) || value.includes('\0')) {
    throw new RuntimeError('invalid_input', `${name} must be an absolute path`);
  }
  if (Buffer.byteLength(value, 'utf8') > LOCAL_VISION_LIMITS.maxPathBytes) throw new RuntimeError('invalid_input', `${name} is too long`);
  return value;
}

/** Image pixels, top-left origin; the helper checks it against the image size. */
function checkRect(value: unknown): Rect {
  const r = value as Partial<Rect> | null;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (typeof r !== 'object' || r === null || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) {
    throw new RuntimeError('invalid_input', 'roi must be {x, y, width, height} in image pixels');
  }
  if (r.width <= 0 || r.height <= 0) throw new RuntimeError('invalid_input', 'roi must have a positive width and height');
  if (r.x < -1 || r.y < -1) throw new RuntimeError('invalid_input', 'roi must start inside the image');
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function checkLanguages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > LOCAL_VISION_LIMITS.maxLanguages || !value.every((l) => typeof l === 'string' && LANGUAGE.test(l))) {
    throw new RuntimeError('invalid_input', `languages must list 1 to ${LOCAL_VISION_LIMITS.maxLanguages} language tags such as zh-Hans`);
  }
  return [...value];
}

function checkMinOverlap(value: unknown): number {
  const { min, max } = LOCAL_VISION_LIMITS.minOverlapPx;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RuntimeError('invalid_input', `minOverlapPx must be a whole number from ${min} to ${max}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Replies: the helper is trusted for pixels, not for shape

function parseReply(op: Op, line: string, exitCode: number | null): Record<string, unknown> {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new RuntimeError('io', `local vision ${op} replied with invalid JSON`);
  }
  if (!isObject(reply) || reply.v !== LOCAL_VISION_PROTOCOL_VERSION) throw new RuntimeError('io', `local vision ${op} replied with an unknown protocol`);
  if (reply.ok === false) {
    const error = isObject(reply.error) ? reply.error : {};
    const code = typeof error.code === 'string' && ERROR_CODES.has(error.code as RuntimeErrorCode) ? (error.code as RuntimeErrorCode) : 'io';
    const message = typeof error.message === 'string' ? error.message : `local vision ${op} failed`;
    throw new RuntimeError(code, message, { op, exitCode });
  }
  if (reply.ok !== true || exitCode !== 0 || !isObject(reply.result)) {
    throw new RuntimeError('io', `local vision ${op} gave a malformed reply (exit ${exitCode})`);
  }
  return reply.result;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isSize = (v: unknown): v is number => isCount(v) && v > 0;
const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
const isBox = (v: unknown): v is Rect =>
  isObject(v) && [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n)) && (v.width as number) >= 0 && (v.height as number) >= 0;

function malformed(op: Op, what: string): never {
  throw new RuntimeError('io', `local vision ${op} reply has a malformed ${what}`);
}

function toOcrResult(r: Record<string, unknown>): OcrResult {
  if (!Array.isArray(r.lines)) malformed('ocr', 'lines');
  const lines: OcrLine[] = r.lines.map((l: unknown) => {
    if (!isObject(l) || typeof l.text !== 'string' || !isBox(l.box) || !isUnit(l.confidence)) malformed('ocr', 'line');
    return { text: l.text, box: { x: l.box.x, y: l.box.y, width: l.box.width, height: l.box.height }, confidence: l.confidence };
  });
  if (typeof r.imageSha256 !== 'string' || !SHA256.test(r.imageSha256)) malformed('ocr', 'imageSha256');
  if (!isSize(r.widthPx) || !isSize(r.heightPx)) malformed('ocr', 'image size');
  return { lines, imageSha256: r.imageSha256, widthPx: r.widthPx, heightPx: r.heightPx };
}

function toComparison(r: Record<string, unknown>): ImageComparison {
  if (!isUnit(r.similarity)) malformed('compare', 'similarity');
  const out: ImageComparison = { similarity: r.similarity };
  if (r.verticalShiftPx !== undefined) {
    if (typeof r.verticalShiftPx !== 'number' || !Number.isInteger(r.verticalShiftPx)) malformed('compare', 'verticalShiftPx');
    out.verticalShiftPx = r.verticalShiftPx;
  }
  return out;
}

const PLACEMENTS = new Set<ComposedFrame['placement']>(['first', 'placed', 'duplicate', 'gap']);

function toComposed(r: Record<string, unknown>, frameCount: number): ComposedImage {
  if (typeof r.path !== 'string') malformed('compose', 'path');
  if (!isSize(r.widthPx) || !isSize(r.heightPx)) malformed('compose', 'image size');
  if (typeof r.sha256 !== 'string' || !SHA256.test(r.sha256)) malformed('compose', 'sha256');
  if (!Array.isArray(r.frames) || r.frames.length !== frameCount) malformed('compose', 'frames');
  const frames: ComposedFrame[] = r.frames.map((f: unknown, i: number) => {
    if (!isObject(f) || f.index !== i || !PLACEMENTS.has(f.placement as ComposedFrame['placement']) || !isCount(f.outputY) || !isCount(f.rows)) {
      malformed('compose', `frame ${i}`);
    }
    const frame: ComposedFrame = { index: i, placement: f.placement as ComposedFrame['placement'], outputY: f.outputY, rows: f.rows };
    if (f.overlapPx !== undefined) {
      if (!isCount(f.overlapPx)) malformed('compose', `frame ${i} overlap`);
      frame.overlapPx = f.overlapPx;
    }
    return frame;
  });
  if (frames.reduce((sum, f) => sum + f.rows, 0) !== r.heightPx) malformed('compose', 'frame rows');
  const hasGap = frames.some((f) => f.placement === 'gap');
  if (r.hasGap !== hasGap) malformed('compose', 'hasGap');
  return { path: r.path, widthPx: r.widthPx, heightPx: r.heightPx, sha256: r.sha256, frames, hasGap };
}

function toMetadata(r: Record<string, unknown>): ImageMetadata {
  if (!isSize(r.widthPx) || !isSize(r.heightPx) || !isCount(r.bytes)) malformed('metadata', 'size');
  if (typeof r.sha256 !== 'string' || !SHA256.test(r.sha256)) malformed('metadata', 'sha256');
  if (typeof r.type !== 'string') malformed('metadata', 'type');
  return { widthPx: r.widthPx, heightPx: r.heightPx, bytes: r.bytes, sha256: r.sha256, type: r.type };
}
