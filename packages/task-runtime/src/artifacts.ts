// Resume files on disk under <outputDir>/<taskId>/. Each acquisition attempt
// writes into its own staging directory on the output filesystem; a file is
// validated by its bytes (never its extension), hard-linked into
// candidates/<candidateId>/ without overwriting anything, and only then
// committed to the ledger by the caller. Because the file system and SQLite
// cannot share a transaction, archive() first writes a journal record and
// reconcile() repairs whatever a crash left between the two.

import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { crc32, inflateRawSync, inflateSync } from 'node:zlib';
import {
  CONTRACT_VERSION,
  RuntimeError,
  captureCompleteness,
  candidateDedupeKey,
  isCountable,
  safePathSegment,
  systemClock,
  throwIfAborted,
} from './contracts.ts';
import type {
  ArtifactCompleteness,
  ArtifactKind,
  ArtifactRecord,
  ArtifactStore,
  CandidateIdentity,
  CaptureEvidence,
  Clock,
  FileValidation,
  ReconcileReport,
  StagedArtifact,
  StagingArea,
  TaskRecord,
  TaskStore,
  WorkItem,
  WorkItemStatus,
} from './contracts.ts';

/** How long a file's size and mtime must stay unchanged to count as finished. */
export const SIZE_STABLE_MS = 300;
/** Files above this are refused rather than read into memory. */
export const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

const STAGING = '.staging';
const QUARANTINE = '.quarantine';
const JOURNAL = '.journal';
const ATTEMPT_MARKER = '.attempt.json';

/**
 * Staging directories created by any ArtifactStore in this process and not
 * yet finished. Process-wide because the runner may build a new store per
 * task or item; reconcile must never take a live attempt from a sibling.
 */
const ACTIVE_STAGING = new Set<string>();

/** Suffixes browsers and download tools give unfinished files. */
const TEMP_SUFFIXES = ['.crdownload', '.download', '.part', '.partial', '.tmp', '.temp', '.opdownload', '.aria2', '.!ut', '.inprogress', '.downloading'];

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  zip: 'application/zip',
  png: 'image/png',
  jpeg: 'image/jpeg',
  html: 'text/html',
  text: 'text/plain',
  json: 'application/json',
  binary: 'application/octet-stream',
} as const;

const EXTENSION_TYPES: Record<string, string> = {
  '.pdf': MIME.pdf,
  '.docx': MIME.docx,
  '.doc': MIME.doc,
  '.png': MIME.png,
  '.jpg': MIME.jpeg,
  '.jpeg': MIME.jpeg,
  '.txt': MIME.text,
  '.json': MIME.json,
  '.html': MIME.html,
  '.htm': MIME.html,
};

const TYPE_EXTENSIONS: Record<string, string> = {
  [MIME.pdf]: '.pdf',
  [MIME.docx]: '.docx',
  [MIME.doc]: '.doc',
  [MIME.png]: '.png',
  [MIME.jpeg]: '.jpg',
  [MIME.text]: '.txt',
  [MIME.json]: '.json',
  [MIME.html]: '.html',
};

/** Content types each kind accepts. `diagnostic` keeps anything non-empty. */
const KIND_TYPES: Record<ArtifactKind, readonly string[] | undefined> = {
  original: [MIME.pdf, MIME.docx, MIME.doc, MIME.png, MIME.jpeg],
  captured_page: [MIME.png, MIME.jpeg],
  captured_image: [MIME.png, MIME.jpeg],
  resume_text: [MIME.text],
  metadata: [MIME.json],
  diagnostic: undefined,
};

// ---------------------------------------------------------------------------
// Content checks
//
// Each format is checked by actually decoding it, not by spotting markers:
// PNG pixel data is inflated to exactly the size its header declares; a DOCX
// central directory is parsed and its main part inflated and CRC-checked;
// PDF and JPEG are opened by the platform decoders (PDFKit / ImageIO) through
// the MediaInspector. Formats nothing here can decode fail closed.

/** Decompressed bytes allowed for one PNG image or DOCX part (bomb guard). */
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;

interface Sniffed {
  type: string;
  problems: string[];
}

/**
 * Identifies a file by its bytes and decodes what can be decoded in-process
 * (PNG, DOCX, text). PDF and JPEG still need the MediaInspector; legacy .doc
 * is identified but never verified.
 */
export function sniffContent(buf: Buffer): Sniffed {
  if (buf.length >= 5 && buf.subarray(0, 1024).includes('%PDF-')) return checkPdfTrailer(buf);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return checkPng(buf);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return checkJpegMarkers(buf);
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304) return checkZip(buf);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
    return { type: MIME.doc, problems: ['legacy Word .doc cannot be verified here'] };
  return checkText(buf);
}

/** Structural precheck only; the page count comes from a real PDF parser. */
function checkPdfTrailer(buf: Buffer): Sniffed {
  const whole = buf.subarray(Math.max(0, buf.length - 2048)).includes('%%EOF');
  return { type: MIME.pdf, problems: whole ? [] : ['PDF has no %%EOF trailer (truncated download)'] };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DEPTHS: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

/** Walks every chunk (CRC checked) and inflates the image data to its exact declared size. */
function checkPng(buf: Buffer): Sniffed {
  const fail = (problem: string): Sniffed => ({ type: MIME.png, problems: [problem] });
  let offset = 8;
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | undefined;
  let palette = false;
  let ended = false;
  const data: Buffer[] = [];
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > buf.length) return fail(`PNG chunk ${type} is cut off (truncated)`);
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== buf.readUInt32BE(offset + 8 + length)) return fail(`PNG chunk ${type} fails its CRC`);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) return fail('PNG does not start with IHDR');
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8]!, color: body[9]!, interlace: body[12]! };
      if (body[10] !== 0 || body[11] !== 0 || header.interlace > 1) return fail('PNG uses an unknown compression, filter or interlace method');
    } else if (type === 'PLTE') palette = true;
    else if (type === 'IDAT') data.push(body);
    offset = next;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!header) return fail('PNG has no IHDR');
  if (!ended) return fail('PNG has no IEND chunk (truncated)');
  const format = PNG_DEPTHS[header.color];
  if (!format || !format.depths.includes(header.depth)) return fail(`PNG color type ${header.color} with depth ${header.depth} is invalid`);
  if (header.color === 3 && !palette) return fail('PNG palette image has no PLTE');
  if (header.width === 0 || header.height === 0) return fail('PNG has zero size');
  const bitsPerPixel = format.channels * header.depth;
  const passes = header.interlace
    ? ADAM7.map(([x0, y0, dx, dy]) => [Math.ceil((header.width - x0) / dx), Math.ceil((header.height - y0) / dy)] as const)
    : [[header.width, header.height] as const];
  // [scanline bytes incl. filter byte, scanline count] per pass, sized before anything is allocated.
  const runs = passes.filter(([w, h]) => w > 0 && h > 0).map(([w, h]) => [Math.ceil((w * bitsPerPixel) / 8) + 1, h] as const);
  const expected = runs.reduce((sum, [bytes, count]) => sum + bytes * count, 0);
  if (expected > MAX_DECODED_BYTES) return fail('PNG declares more pixel data than allowed');
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
  } catch (error) {
    return fail(error instanceof RangeError ? 'PNG holds more pixel data than its header declares' : 'PNG pixel data does not decompress');
  }
  if (pixels.length !== expected) return fail(`PNG pixel data is incomplete (${pixels.length} of ${expected} bytes)`);
  let at = 0;
  for (const [bytes, count] of runs)
    for (let y = 0; y < count; y++, at += bytes) if (pixels[at]! > 4) return fail('PNG scanline has an invalid filter type');
  return { type: MIME.png, problems: [] };
}

/** Marker check only; the pixels are decoded by the MediaInspector. */
function checkJpegMarkers(buf: Buffer): Sniffed {
  let end = buf.length;
  while (end > 2 && buf[end - 1] === 0) end--;
  const whole = buf[end - 2] === 0xff && buf[end - 1] === 0xd9;
  return { type: MIME.jpeg, problems: whole ? [] : ['JPEG has no end-of-image marker (truncated)'] };
}

/** Parses the central directory; a DOCX must hold a decodable word/document.xml. */
function checkZip(buf: Buffer): Sniffed {
  const zip = (problem: string): Sniffed => ({ type: MIME.zip, problems: [problem] });
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return zip('ZIP has no end of central directory (truncated)');
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const start = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) return zip('ZIP64 archives are not supported');
  if (start + size > eocd) return zip('ZIP central directory lies outside the file (truncated)');
  const entries = new Map<string, { method: number; crc: number; compressed: number; size: number; local: number }>();
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== 0x02014b50) return zip('ZIP central directory is damaged');
    const nameLength = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, {
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      compressed: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      local: buf.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  if (!entries.has('word/document.xml')) return { type: MIME.zip, problems: [] };
  for (const name of ['[Content_Types].xml', 'word/document.xml']) {
    const e = entries.get(name);
    if (!e) return { type: MIME.docx, problems: [`DOCX has no ${name}`] };
    if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) return { type: MIME.docx, problems: [`DOCX entry ${name} has no local header`] };
    const dataStart = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    if (dataStart + e.compressed > buf.length) return { type: MIME.docx, problems: [`DOCX entry ${name} is cut off (truncated)`] };
    if (e.size > MAX_DECODED_BYTES) return { type: MIME.docx, problems: [`DOCX entry ${name} is larger than allowed`] };
    const raw = buf.subarray(dataStart, dataStart + e.compressed);
    let content: Buffer;
    try {
      if (e.method === 0) content = raw;
      else if (e.method === 8) content = inflateRawSync(raw, { maxOutputLength: e.size + 1 });
      else return { type: MIME.docx, problems: [`DOCX entry ${name} uses compression method ${e.method}`] };
    } catch {
      return { type: MIME.docx, problems: [`DOCX entry ${name} does not decompress to its declared size`] };
    }
    if (content.length !== e.size || crc32(content) !== e.crc) return { type: MIME.docx, problems: [`DOCX entry ${name} fails its size or CRC check`] };
    const xml = xmlOutline(content);
    if (typeof xml === 'string') return { type: MIME.docx, problems: [`DOCX entry ${name} is not well-formed XML: ${xml}`] };
    if (name === 'word/document.xml' && (xml.root !== 'document' || !xml.rootChildren.includes('body')))
      return { type: MIME.docx, problems: ['DOCX word/document.xml has no document root with a body'] };
    if (name === '[Content_Types].xml' && xml.root !== 'Types') return { type: MIME.docx, problems: ['DOCX [Content_Types].xml has no Types root'] };
  }
  return { type: MIME.docx, problems: [] };
}

/**
 * Checks that bytes are well-formed XML (balanced, properly nested tags, one
 * root) and returns the root's local name and its direct children's local
 * names; a string is the reason it is not. No DTDs or entities are expanded.
 */
export function xmlOutline(bytes: Buffer): { root: string; rootChildren: string[] } | string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'not UTF-8';
  }
  const stack: string[] = [];
  let root: string | undefined;
  const rootChildren: string[] = [];
  const local = (qname: string) => qname.slice(qname.indexOf(':') + 1);
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt < 0) {
      if (text.slice(at).trim() && stack.length === 0) return 'text outside the root';
      break;
    }
    if (stack.length === 0 && text.slice(at, lt).trim() && !text.slice(at, lt).startsWith('\ufeff')) return 'text outside the root';
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return 'unterminated processing instruction';
      at = end + 2;
    } else if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return 'unterminated comment';
      at = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) return 'CDATA outside the root';
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return 'unterminated CDATA';
      at = end + 3;
    } else if (text.startsWith('<!', lt)) {
      return 'DTDs are not accepted';
    } else {
      const end = text.indexOf('>', lt + 1);
      if (end < 0) return 'unterminated tag';
      const tag = text.slice(lt + 1, end);
      if (tag.startsWith('/')) {
        const name = tag.slice(1).trim();
        if (stack.pop() !== name) return `mismatched closing tag </${name}>`;
      } else {
        const m = /^([A-Za-z_][\w.:-]*)(\s[^]*)?$/.exec(tag.endsWith('/') ? tag.slice(0, -1) : tag);
        if (!m) return `bad tag <${tag.slice(0, 40)}>`;
        const name = m[1]!;
        if (stack.length === 0) {
          if (root !== undefined) return 'more than one root element';
          root = local(name);
        } else if (stack.length === 1) rootChildren.push(local(name));
        if (!tag.endsWith('/')) stack.push(name);
      }
      at = end + 1;
    }
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  if (root === undefined) return 'no root element';
  return { root, rootChildren };
}

function checkText(buf: Buffer): Sniffed {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { type: MIME.binary, problems: [] };
  }
  if (text.includes('\u0000')) return { type: MIME.binary, problems: [] };
  const head = text.slice(0, 512).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return { type: MIME.html, problems: [] };
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return { type: MIME.json, problems: [] };
    } catch {
      // plain text that happens to start with a brace
    }
  }
  return { type: MIME.text, problems: trimmed ? [] : ['text file is blank'] };
}

// ---------------------------------------------------------------------------
// Platform decoders

export type InspectResult = { ok: true; pageCount?: number; width?: number; height?: number } | { ok: false; problem: string };

/**
 * Opens a file with a real decoder: PDF pages, JPEG pixels. Never trusts markers.
 * Limitation of the default (ImageIO): libjpeg conceals corrupt entropy-coded
 * data instead of failing, so a JPEG with a damaged middle can still decode;
 * truncation and broken headers are caught. PNG does not rely on it.
 */
export interface MediaInspector {
  inspect(path: string, type: 'pdf' | 'jpeg', signal?: AbortSignal): Promise<InspectResult>;
}

/** Upper bound for one decoder run. */
export const INSPECT_TIMEOUT_MS = 20_000;

const JXA_INSPECT = `
ObjC.import('Foundation'); ObjC.import('PDFKit'); ObjC.import('ImageIO'); ObjC.import('CoreGraphics');
function run(argv) {
  const [type, path] = argv;
  if (type === 'pdf') {
    const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(path));
    if (doc.isNil()) return JSON.stringify({ ok: false, problem: 'PDFKit cannot open the PDF' });
    if (doc.isLocked) return JSON.stringify({ ok: false, problem: 'PDF is password protected' });
    return JSON.stringify({ ok: true, pageCount: Number(doc.pageCount) });
  }
  const source = $.CGImageSourceCreateWithData($.NSData.dataWithContentsOfFile(path), null);
  const image = source ? $.CGImageSourceCreateImageAtIndex(source, 0, null) : null;
  const width = image ? Number($.CGImageGetWidth(image)) : 0;
  const height = image ? Number($.CGImageGetHeight(image)) : 0;
  if (!width || !height) return JSON.stringify({ ok: false, problem: 'ImageIO cannot decode the JPEG' });
  const context = $.CGBitmapContextCreate(null, width, height, 8, width * 4, $.CGColorSpaceCreateDeviceRGB(), 1);
  $.CGContextDrawImage(context, $.CGRectMake(0, 0, width, height), image);
  return JSON.stringify({ ok: true, width, height });
}`;

/**
 * PDFKit and ImageIO through the built-in osascript, bounded by a timeout and
 * the caller's signal. On other platforms every inspection fails closed.
 */
export function createMacMediaInspector(osascript = '/usr/bin/osascript', timeoutMs = INSPECT_TIMEOUT_MS): MediaInspector {
  return {
    inspect(path, type, signal) {
      throwIfAborted(signal);
      if (process.platform !== 'darwin') return Promise.resolve({ ok: false, problem: `no ${type} decoder on ${process.platform}` });
      return new Promise((resolveInspect, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(osascript, ['-l', 'JavaScript', '-e', JXA_INSPECT, type, path], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (error) {
          return resolveInspect({ ok: false, problem: `${type} decoder unavailable: ${(error as Error).message}` });
        }
        let stdout = '';
        let timedOut = false;
        let spawnError: Error | undefined;
        const kill = () => child.kill('SIGKILL');
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs);
        signal?.addEventListener('abort', kill, { once: true });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
          if (stdout.length > 64 * 1024) kill();
        });
        child.on('error', (error) => {
          spawnError = error;
        });
        // Settle only once the decoder process has exited, so a cancelled
        // validation never leaves it running behind the caller.
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', kill);
          if (signal?.aborted) return reject(new RuntimeError('cancelled', 'the operation was cancelled'));
          if (spawnError) return resolveInspect({ ok: false, problem: `${type} decoder unavailable: ${spawnError.message}` });
          if (timedOut) return resolveInspect({ ok: false, problem: `${type} decoder timed out after ${timeoutMs} ms` });
          if (exitCode !== 0) return resolveInspect({ ok: false, problem: `${type} decoder exited with ${exitCode}` });
          try {
            const result = JSON.parse(stdout.trim()) as InspectResult;
            if (result.ok && type === 'pdf' && !(Number.isInteger(result.pageCount) && result.pageCount! > 0))
              return resolveInspect({ ok: false, problem: 'PDF has no pages' });
            resolveInspect(result.ok || typeof result.problem === 'string' ? result : { ok: false, problem: `${type} decoder gave no verdict` });
          } catch {
            resolveInspect({ ok: false, problem: `${type} decoder gave no verdict` });
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Small file-system helpers

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolveSleep, reject) => {
    if (signal?.aborted) return reject(new RuntimeError('cancelled', 'the operation was cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RuntimeError('cancelled', 'the operation was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw ioError(error, path);
  }
}

function ioError(error: unknown, path: string): RuntimeError {
  if (error instanceof RuntimeError) return error;
  const c = code(error);
  if (c === 'ENOSPC' || c === 'EDQUOT') return new RuntimeError('storage_full', `no space writing ${path}`);
  return new RuntimeError('io', `${c ?? 'error'} at ${path}: ${(error as Error)?.message ?? error}`);
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number } | undefined> {
  const st = await lstatOrUndefined(path);
  if (!st || !st.isFile()) return undefined;
  return { sha256: sha256(await readFile(path)), bytes: st.size };
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Whether the process that wrote an attempt marker may still be running. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === 'EPERM';
  }
}

interface JournalEntry {
  v: 1;
  taskId: string;
  candidateId: string;
  accountKey: string;
  dedupeKey: string;
  record: ArtifactRecord;
}

/**
 * The single finished file in a staging directory, for flows where a save
 * dialog or download writes there. Never picks by "newest": none or several
 * candidate files is `conflict` (ambiguous), and an unfinished download
 * suffix is not counted as finished.
 */
export async function pickStagedFile(staging: StagingArea, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const entries = await readdir(staging.dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name !== ATTEMPT_MARKER && !e.name.startsWith('.'));
  const finished = files.filter((e) => !TEMP_SUFFIXES.some((s) => e.name.toLowerCase().endsWith(s)));
  if (finished.length === 1 && files.length === 1) return join(staging.dir, finished[0]!.name);
  throw new RuntimeError('conflict', `staging holds ${finished.length} finished and ${files.length - finished.length} unfinished files; refusing to guess`, {
    files: files.map((e) => e.name),
  });
}

// ---------------------------------------------------------------------------
// The store

/**
 * The contract factory. `inspector` is an additive, optional injection point
 * (default: macOS PDFKit/ImageIO through osascript) used for PDF and JPEG.
 */
export function createArtifactStore(options: {
  outputDir: string;
  taskId: string;
  clock?: Clock;
  newId?: () => string;
  inspector?: MediaInspector;
}): ArtifactStore {
  if (!isAbsolute(options.outputDir)) throw new RuntimeError('invalid_input', 'outputDir must be absolute');
  if (!safePathSegment(options.taskId)) throw new RuntimeError('invalid_input', `task id ${options.taskId} is not a safe path segment`);
  return new FsArtifactStore(
    resolve(options.outputDir, options.taskId),
    options.taskId,
    options.clock ?? systemClock,
    options.newId ?? (() => randomUUID()),
    options.inspector ?? createMacMediaInspector(),
  );
}

class FsArtifactStore implements ArtifactStore {
  readonly root: string;
  private readonly taskId: string;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private realRootPromise?: Promise<string>;

  private readonly inspector: MediaInspector;

  constructor(root: string, taskId: string, clock: Clock, newId: () => string, inspector: MediaInspector) {
    this.inspector = inspector;
    this.root = root;
    this.taskId = taskId;
    this.clock = clock;
    this.newId = newId;
  }

  /** The resolved task root; the output dir may be a symlink, the task folder may not. */
  private realRoot(): Promise<string> {
    this.realRootPromise ??= (async () => {
      try {
        await mkdir(this.root, { recursive: true });
        const st = await lstat(this.root);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new RuntimeError('invalid_input', `${this.root} must be a real directory`);
        return await realpath(this.root);
      } catch (error) {
        this.realRootPromise = undefined;
        throw ioError(error, this.root);
      }
    })();
    return this.realRootPromise;
  }

  /** Creates (if needed) a directory under the root, refusing symlinked components. */
  private async ensureDir(realRoot: string, segments: string[]): Promise<string> {
    let dir = realRoot;
    for (const segment of segments) {
      dir = join(dir, segment);
      try {
        await mkdir(dir);
      } catch (error) {
        if (code(error) !== 'EEXIST') throw ioError(error, dir);
      }
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new RuntimeError('invalid_input', `${dir} is not a plain directory inside the output root`);
    }
    if ((await realpath(dir)) !== dir) throw new RuntimeError('invalid_input', `${dir} resolves outside the output root`);
    return dir;
  }

  async stage(itemId: string, signal?: AbortSignal): Promise<StagingArea> {
    throwIfAborted(signal);
    if (!safePathSegment(itemId)) throw new RuntimeError('invalid_input', `item id ${itemId} is not a safe path segment`);
    const realRoot = await this.realRoot();
    const stagingRoot = await this.ensureDir(realRoot, [STAGING]);
    const attempt = this.newId().replace(/[^A-Za-z0-9-]/g, '') || randomUUID();
    const dir = join(stagingRoot, `${itemId}.${attempt}`);
    if (!safePathSegment(basename(dir))) throw new RuntimeError('invalid_input', 'staging directory name is too long');
    try {
      await mkdir(dir, { mode: 0o700 }); // fails if the name was ever used: one directory per attempt
      await writeFile(join(dir, ATTEMPT_MARKER), JSON.stringify({ v: 1, taskId: this.taskId, itemId, pid: process.pid, createdAt: this.clock.now().toISOString() }));
    } catch (error) {
      throw ioError(error, dir);
    }
    ACTIVE_STAGING.add(dir);
    return { itemId, dir };
  }

  /**
   * Resolves a staged path and proves it is a regular file inside one of
   * this item's staging directories, with no symlink anywhere on the way.
   * Throws `invalid_input` otherwise: such a path is never a candidate file.
   */
  private async locateStaged(staged: StagedArtifact): Promise<{ path: string; stagingDir: string } | undefined> {
    if (!staged || !safePathSegment(staged.itemId)) throw new RuntimeError('invalid_input', 'staged artifact needs a safe itemId');
    if (!isAbsolute(staged.path)) throw new RuntimeError('invalid_input', 'staged path must be absolute');
    const realRoot = await this.realRoot();
    const stagingRoot = join(realRoot, STAGING);
    let logical = resolve(staged.path);
    if (isInside(this.root, logical)) logical = join(realRoot, relative(this.root, logical));
    if (!isInside(stagingRoot, logical)) throw new RuntimeError('invalid_input', `${staged.path} is not inside the staging area`);
    const [dirName, ...rest] = relative(stagingRoot, logical).split(sep);
    if (!dirName || rest.length === 0) throw new RuntimeError('invalid_input', `${staged.path} is not a file in a staging directory`);
    const dot = dirName.lastIndexOf('.');
    if (dot <= 0 || dirName.slice(0, dot) !== staged.itemId) throw new RuntimeError('invalid_input', `${staged.path} is not in a staging directory of item ${staged.itemId}`);
    if (rest.some((s) => !safePathSegment(s))) throw new RuntimeError('invalid_input', `${staged.path} has an unsafe or hidden path segment`);
    const st = await lstatOrUndefined(logical);
    if (!st) return undefined;
    if (st.isSymbolicLink()) throw new RuntimeError('invalid_input', `${staged.path} is a symlink`);
    if (!st.isFile()) throw new RuntimeError('invalid_input', `${staged.path} is not a regular file`);
    if ((await realpath(logical)) !== logical) throw new RuntimeError('invalid_input', `${staged.path} goes through a symlink`);
    return { path: logical, stagingDir: join(stagingRoot, dirName) };
  }

  async validate(staged: StagedArtifact, signal?: AbortSignal): Promise<FileValidation> {
    throwIfAborted(signal);
    if (!staged || !(staged.kind in KIND_TYPES)) throw new RuntimeError('invalid_input', `bad artifact kind ${staged?.kind}`);
    const located = await this.locateStaged(staged);
    if (!located) return { exists: false, bytes: 0, sizeStable: false, problems: ['file does not exist'] };
    const problems: string[] = [];
    const name = basename(located.path).toLowerCase();
    if (TEMP_SUFFIXES.some((s) => name.endsWith(s))) problems.push(`unfinished download suffix on ${basename(located.path)}`);

    const first = await stat(located.path);
    await sleep(SIZE_STABLE_MS, signal);
    const second = await lstatOrUndefined(located.path);
    if (!second) return { exists: false, bytes: 0, sizeStable: false, problems: ['file disappeared while checking'] };
    const sizeStable = first.size === second.size && first.mtimeMs === second.mtimeMs;
    if (!sizeStable) problems.push('file is still changing');
    if (second.nlink > 1) problems.push('file has other hard links');
    if (second.size === 0) problems.push('file is empty');
    if (second.size > MAX_ARTIFACT_BYTES) {
      problems.push(`file is larger than ${MAX_ARTIFACT_BYTES} bytes`);
      return { exists: true, bytes: second.size, sizeStable, problems };
    }
    throwIfAborted(signal);
    const buf = await readFile(located.path);
    if (buf.length !== second.size) problems.push('file changed while reading');
    const validation: FileValidation = { exists: true, bytes: buf.length, sizeStable, sha256: sha256(buf), problems };
    if (buf.length === 0) return validation;

    const sniffed = sniffContent(buf);
    validation.sniffedType = sniffed.type;
    problems.push(...sniffed.problems);
    if ((sniffed.type === MIME.pdf || sniffed.type === MIME.jpeg) && sniffed.problems.length === 0) {
      const verdict = await this.inspector.inspect(located.path, sniffed.type === MIME.pdf ? 'pdf' : 'jpeg', signal);
      if (!verdict.ok) problems.push(verdict.problem);
      else if (sniffed.type === MIME.pdf) validation.pageCount = verdict.pageCount;
      const after = await lstatOrUndefined(located.path);
      if (!after || after.size !== second.size || after.mtimeMs !== second.mtimeMs) problems.push('file changed while it was being decoded');
    }
    const accepted = KIND_TYPES[staged.kind];
    if (accepted && !accepted.includes(sniffed.type)) problems.push(`${staged.kind} cannot be ${sniffed.type}`);
    if (staged.kind === 'metadata' && sniffed.type === MIME.json) {
      const parsed: unknown = JSON.parse(buf.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) problems.push('metadata must be a JSON object');
    }
    const ext = extname(name.replace(new RegExp(`(${TEMP_SUFFIXES.map((s) => s.replace(/[.!]/g, '\\$&')).join('|')})$`), ''));
    const extType = EXTENSION_TYPES[ext];
    if (ext && extType && extType !== sniffed.type && !(extType === MIME.text && sniffed.type === MIME.json))
      problems.push(`extension ${ext} does not match content ${sniffed.type}`);
    if (staged.capture !== undefined) {
      const c = staged.capture;
      if (!Number.isInteger(c.pages) || !Array.isArray(c.bottomSignals) || typeof c.topConfirmed !== 'boolean') problems.push('capture evidence is malformed');
      else if (captureCompleteness(c) === 'invalid') problems.push('capture evidence has no pages');
    }
    return validation;
  }

  async archive(
    staged: StagedArtifact,
    identity: CandidateIdentity,
    validation: FileValidation,
    procedureIds: string[],
    signal?: AbortSignal,
  ): Promise<ArtifactRecord> {
    throwIfAborted(signal);
    if (!identity || !safePathSegment(identity.candidateId)) throw new RuntimeError('invalid_input', `candidateId ${identity?.candidateId} is not a safe path segment`);
    if (!validation?.exists || !validation.sha256) throw new RuntimeError('invalid_input', 'archive needs a validation of an existing file');
    if (staged.kind !== 'diagnostic' && validation.problems.length)
      throw new RuntimeError('invalid_input', `file failed validation: ${validation.problems.join('; ')}`, { problems: validation.problems });
    const located = await this.locateStaged(staged);
    if (!located) throw new RuntimeError('not_found', `${staged.path} no longer exists`);
    const buf = await readFile(located.path);
    const hash = sha256(buf);
    if (hash !== validation.sha256 || buf.length !== validation.bytes)
      throw new RuntimeError('conflict', 'file changed after validation; validate it again', { expected: validation.sha256, actual: hash });

    const completeness = completenessOf(staged.kind, staged.capture);
    const realRoot = await this.realRoot();
    const ext = TYPE_EXTENSIONS[validation.sniffedType ?? ''] ?? '.bin';
    const stem = sourceStem(located.path) ?? hash.slice(0, 12);
    const short = hash.slice(0, 12);
    const plan = destinationPlan(staged.kind, stem, short, ext);
    const dir = await this.ensureDir(realRoot, ['candidates', identity.candidateId, ...plan.dir]);

    await fsyncPath(located.path);
    for (const name of plan.names) {
      throwIfAborted(signal);
      const dest = join(dir, name);
      const relativePath = relative(realRoot, dest).split(sep).join('/');
      const record: ArtifactRecord = {
        id: artifactId(this.taskId, staged.itemId, staged.kind, relativePath, hash, completeness),
        itemId: staged.itemId,
        kind: staged.kind,
        relativePath,
        sha256: hash,
        bytes: buf.length,
        completeness,
        validation,
        procedureIds: [...procedureIds],
        acquiredAt: this.clock.now().toISOString(),
      };
      if (staged.capture !== undefined) record.capture = staged.capture;

      const existing = await lstatOrUndefined(dest);
      if (existing) {
        const onDisk = existing.isFile() && !existing.isSymbolicLink() ? await hashFile(dest) : undefined;
        if (onDisk?.sha256 !== hash) continue; // never overwrite: try the next, hash-suffixed name
        await this.writeJournal(realRoot, identity, record);
        await this.dropStaged(located.path, located.stagingDir);
        return record;
      }
      // The journal goes first, so a crash after the link can be adopted.
      await this.writeJournal(realRoot, identity, record);
      try {
        await link(located.path, dest); // atomic and never replaces an existing file
      } catch (error) {
        const c = code(error);
        if (c === 'EEXIST') continue;
        if (c === 'EXDEV') throw new RuntimeError('io', 'staging and archive are on different filesystems');
        if (c !== 'EPERM' && c !== 'ENOTSUP' && c !== 'EOPNOTSUPP') throw ioError(error, dest);
        // Filesystems without hard links: rename after a fresh existence check.
        if (await lstatOrUndefined(dest)) continue;
        await rename(located.path, dest).catch((e) => Promise.reject(ioError(e, dest)));
      }
      await fsyncPath(dir).catch(() => undefined);
      await this.dropStaged(located.path, located.stagingDir);
      return record;
    }
    throw new RuntimeError('conflict', `no free archive name for ${staged.kind} in candidates/${identity.candidateId}`);
  }

  /** Removes the archived staged file, and the attempt directory once nothing else is in it. */
  private async dropStaged(path: string, stagingDir: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw ioError(error, path);
    }
    const rest = await readdirOrEmpty(stagingDir);
    if (rest.length === 1 && rest[0] === ATTEMPT_MARKER) {
      await rm(stagingDir, { recursive: true, force: true });
      ACTIVE_STAGING.delete(stagingDir);
    }
  }

  private async writeJournal(realRoot: string, identity: CandidateIdentity, record: ArtifactRecord): Promise<void> {
    const dir = await this.ensureDir(realRoot, [JOURNAL]);
    const entry: JournalEntry = {
      v: 1,
      taskId: this.taskId,
      candidateId: identity.candidateId,
      accountKey: identity.accountKey,
      dedupeKey: candidateDedupeKey(identity),
      record,
    };
    await atomicWrite(join(dir, `${record.id}.json`), JSON.stringify(entry));
  }

  async writeIndex(task: TaskRecord, items: WorkItem[], artifacts: ArtifactRecord[], signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (task.id !== this.taskId) throw new RuntimeError('invalid_input', `task ${task.id} does not own ${this.root}`);
    const itemIds = new Set(items.map((i) => i.id));
    if (items.some((i) => i.taskId !== task.id)) throw new RuntimeError('invalid_input', 'items belong to another task');
    if (artifacts.some((a) => !itemIds.has(a.itemId))) throw new RuntimeError('invalid_input', 'artifacts belong to items outside the task');
    const realRoot = await this.realRoot();

    const disk = new Map<string, 'present' | 'missing' | 'changed'>();
    for (const a of artifacts) {
      throwIfAborted(signal);
      disk.set(a.id, await this.diskState(realRoot, a));
    }
    const sortedItems = [...items].sort((a, b) => cmp(a.identity.candidateId, b.identity.candidateId) || cmp(a.id, b.id));
    const byItem = new Map<string, ArtifactRecord[]>();
    for (const a of [...artifacts].sort((x, y) => cmp(x.relativePath, y.relativePath) || cmp(x.id, y.id)))
      byItem.set(a.itemId, [...(byItem.get(a.itemId) ?? []), a]);

    const candidates = sortedItems.map((item) => {
      const own = byItem.get(item.id) ?? [];
      const presentOwn = own.filter((a) => disk.get(a.id) === 'present');
      const delivered = item.status === 'committed' && isCountable(presentOwn, task.input.captureMode);
      return {
        itemId: item.id,
        candidateId: item.identity.candidateId,
        status: item.status,
        delivered,
        confidence: item.identity.confidence,
        ...(item.identity.platformId ? { platformId: item.identity.platformId } : {}),
        name: item.ref.name,
        ...(item.ref.jobTitle ? { jobTitle: item.ref.jobTitle } : {}),
        sourceRef: item.ref.sourceRef,
        attempt: item.attempt,
        ...(item.reason ? { reason: item.reason } : {}),
        artifacts: own.map((a) => ({
          id: a.id,
          kind: a.kind,
          path: a.relativePath,
          sha256: a.sha256,
          bytes: a.bytes,
          completeness: a.completeness,
          disk: disk.get(a.id),
          ...(a.validation.sniffedType ? { contentType: a.validation.sniffedType } : {}),
          ...(a.validation.pageCount !== undefined ? { pageCount: a.validation.pageCount } : {}),
          ...(a.capture ? { capture: a.capture } : {}),
          procedureIds: a.procedureIds,
          acquiredAt: a.acquiredAt,
        })),
      };
    });

    const failures = candidates.flatMap((c): FailureEntry[] => {
      const missing = c.artifacts.filter((a) => a.disk !== 'present');
      if (c.status === 'committed') {
        if (c.delivered && missing.length === 0) return [];
        return [{
          itemId: c.itemId, candidateId: c.candidateId, status: c.status,
          failure: c.delivered ? 'artifact_damaged' : 'committed_evidence_missing',
          persisted: c.artifacts.length > 0,
          missing: missing.map((a) => ({ path: a.path, disk: a.disk })),
        }];
      }
      if (!['failed', 'unavailable', 'ambiguous'].includes(c.status)) return [];
      return [{
        itemId: c.itemId, candidateId: c.candidateId, status: c.status,
        // An attempt that saved files but did not count differs from one that never got a file.
        failure: c.artifacts.length > 0 ? 'saved_not_counted' : 'no_artifact',
        persisted: c.artifacts.length > 0,
        ...(c.reason ? { reason: c.reason } : {}),
        ...(missing.length ? { missing: missing.map((a) => ({ path: a.path, disk: a.disk })) } : {}),
      }];
    });

    const generatedAt = this.clock.now().toISOString();
    const manifest = {
      schema: '2ndscreen.resume-manifest',
      version: 1,
      contractVersion: CONTRACT_VERSION,
      generatedAt,
      task: {
        id: task.id,
        skillId: task.skillId,
        skillVersion: task.skillVersion,
        status: task.status,
        ...(task.phase ? { phase: task.phase } : {}),
        ...(task.terminationReason ? { terminationReason: task.terminationReason } : {}),
        ...(task.waitReason ? { waitReason: task.waitReason } : {}),
        job: task.input.job,
        source: task.input.source,
        captureMode: task.input.captureMode,
        requestedCount: task.input.requestedCount,
        ...(task.account ? { account: { accountKey: task.account.accountKey, binding: task.account.binding } } : {}),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      // ledgerCounts is the ledger's history; delivered re-checks the files now on disk.
      ledgerCounts: task.counts,
      delivered: candidates.filter((c) => c.delivered).length,
      candidates,
    };

    const header = ['candidate_id', 'item_id', 'name', 'job_title', 'status', 'delivered', 'kind', 'completeness', 'disk', 'path', 'sha256', 'bytes', 'acquired_at'];
    const rows = candidates.flatMap((c) => {
      const base = [c.candidateId, c.itemId, c.name, c.jobTitle ?? '', c.status, String(c.delivered)];
      if (c.artifacts.length === 0) return [[...base, '', '', '', '', '', '', '']];
      return c.artifacts.map((a) => [...base, a.kind, a.completeness, a.disk ?? '', a.path, a.sha256, String(a.bytes), a.acquiredAt]);
    });
    const csv = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

    throwIfAborted(signal);
    await atomicWrite(join(realRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await atomicWrite(join(realRoot, 'index.csv'), csv);
    await atomicWrite(join(realRoot, 'failures.json'), JSON.stringify({ taskId: task.id, generatedAt, failures }, null, 2) + '\n');
  }

  private async diskState(realRoot: string, a: ArtifactRecord): Promise<'present' | 'missing' | 'changed'> {
    const segments = a.relativePath.split('/');
    if (!segments.every(safePathSegment)) return 'missing';
    const path = join(realRoot, ...segments);
    const st = await lstatOrUndefined(path);
    if (!st || !st.isFile()) return 'missing';
    if (st.size !== a.bytes) return 'changed';
    if ((await realpath(path)) !== path) return 'changed';
    return (await hashFile(path))?.sha256 === a.sha256 ? 'present' : 'changed';
  }

  /**
   * Startup repair; run it while holding the app lease and before any new
   * attempt starts. (1) Ledger artifacts missing or changed on disk are
   * reported as invalidated; a non-terminal item goes back to processing,
   * a committed item keeps its terminal status and gets an artifact_missing
   * event (writeIndex then shows it as not delivered). (2) Journaled files
   * that were archived but never committed are re-adopted through legal
   * item transitions and commitItem, after their hash and candidate/account
   * binding are checked. (3) Leftover staging directories of dead attempts
   * are moved to .quarantine for diagnosis (empty ones are removed); live
   * attempts of this process or another, and unowned entries, are left.
   */
  async reconcile(store: TaskStore, taskId: string, signal?: AbortSignal): Promise<ReconcileReport> {
    throwIfAborted(signal);
    if (taskId !== this.taskId) throw new RuntimeError('invalid_input', `task ${taskId} does not own ${this.root}`);
    const task = await store.getTask(taskId);
    if (!task) throw new RuntimeError('not_found', `no task ${taskId}`);
    const realRoot = await this.realRoot();
    const report: ReconcileReport = { adopted: [], invalidated: [], discardedStaging: [] };
    const now = () => this.clock.now().toISOString();
    const event = (type: string, itemId: string | undefined, detail: Record<string, unknown>, evidenceRef?: string) =>
      store.appendEvent({ taskId, ...(itemId ? { itemId } : {}), type, at: now(), result: 'failed', ...(evidenceRef ? { evidenceRef } : {}), detail });

    // (1) ledger -> disk
    const ledger = await store.listArtifacts(taskId);
    const ledgerIds = new Set(ledger.map((a) => a.id));
    let items = new Map((await store.listWorkItems(taskId)).map((i) => [i.id, i]));
    const reopened = new Set<string>();
    for (const a of ledger) {
      throwIfAborted(signal);
      const state = await this.diskState(realRoot, a);
      if (state === 'present') continue;
      report.invalidated.push(a.id);
      const item = items.get(a.itemId);
      await event('artifact_missing', a.itemId, { artifactId: a.id, disk: state, itemStatus: item?.status }, a.relativePath);
      if (item && (item.status === 'acquired' || item.status === 'validated') && !reopened.has(item.id)) {
        items.set(item.id, await store.transitionWorkItem(item.id, 'processing', { reason: `artifact_${state}` }));
        reopened.add(item.id);
      }
    }

    // (2) journal -> ledger
    const journalDir = join(realRoot, JOURNAL);
    const pending = new Map<string, Array<{ entry: JournalEntry; file: string }>>();
    for (const name of await readdirOrEmpty(journalDir)) {
      throwIfAborted(signal);
      const file = join(journalDir, name);
      if (!name.endsWith('.json') || !(await lstatOrUndefined(file))?.isFile()) continue;
      let entry: JournalEntry;
      try {
        entry = JSON.parse(await readFile(file, 'utf8')) as JournalEntry;
      } catch {
        await event('journal_unreadable', undefined, { file: name });
        continue;
      }
      const record = entry.record;
      if (entry.v !== 1 || entry.taskId !== taskId || !record?.id) {
        await event('journal_foreign', undefined, { file: name });
        continue;
      }
      if (ledgerIds.has(record.id)) {
        await rm(file, { force: true }); // committed: the ledger is now the record
        continue;
      }
      const onDisk = await this.diskState(realRoot, record);
      if (onDisk !== 'present') {
        // Crashed before the link, or the file was removed: nothing was archived.
        await event('journal_stale', record.itemId, { artifactId: record.id, disk: onDisk }, record.relativePath);
        await rm(file, { force: true });
        continue;
      }
      pending.set(record.itemId, [...(pending.get(record.itemId) ?? []), { entry, file }]);
    }
    for (const [itemId, entries] of pending) {
      throwIfAborted(signal);
      let item = items.get(itemId);
      const refuse = (why: string) => event('adoption_refused', itemId, { why, artifacts: entries.map((e) => e.entry.record.id) });
      if (!item) {
        await refuse('item_not_in_ledger');
        continue;
      }
      const bound = entries.every(
        ({ entry }) =>
          entry.candidateId === item!.identity.candidateId &&
          entry.accountKey === item!.identity.accountKey &&
          entry.dedupeKey === candidateDedupeKey(item!.identity) &&
          entry.record.relativePath.startsWith(`candidates/${item!.identity.candidateId}/`) &&
          (!task.account || task.account.accountKey === entry.accountKey),
      );
      if (!bound) {
        await refuse('identity_mismatch');
        continue;
      }
      const path = ADOPTION_PATHS[item.status];
      if (!path) {
        await refuse(`item_${item.status}`);
        continue;
      }
      for (const to of path) item = await store.transitionWorkItem(itemId, to, { reason: 'reconcile_adopt' });
      const records = entries.map((e) => e.entry.record);
      await store.commitItem(itemId, records);
      report.adopted.push(...records.map((r) => r.id));
      for (const { file } of entries) await rm(file, { force: true });
      items = new Map((await store.listWorkItems(taskId)).map((i) => [i.id, i]));
    }

    // (3) staging -> quarantine
    const stagingRoot = join(realRoot, STAGING);
    for (const name of await readdirOrEmpty(stagingRoot)) {
      throwIfAborted(signal);
      const dir = join(stagingRoot, name);
      const st = await lstatOrUndefined(dir);
      if (!st) continue;
      if (st.isSymbolicLink() || !st.isDirectory()) {
        await event('staging_skipped', undefined, { entry: name, why: 'not_a_plain_directory' });
        continue;
      }
      if (ACTIVE_STAGING.has(dir)) continue;
      const marker = await readMarker(join(dir, ATTEMPT_MARKER));
      if (!marker || marker.taskId !== taskId) {
        await event('staging_skipped', undefined, { entry: name, why: 'unowned' });
        continue;
      }
      if (marker.pid !== process.pid && processAlive(marker.pid)) {
        await event('staging_skipped', undefined, { entry: name, why: 'owner_alive', pid: marker.pid });
        continue;
      }
      report.discardedStaging.push(dir);
      if ((await readdirOrEmpty(dir)).every((f) => f === ATTEMPT_MARKER)) {
        await rm(dir, { recursive: true, force: true }); // nothing to diagnose
        continue;
      }
      const quarantineRoot = await this.ensureDir(realRoot, [QUARANTINE]);
      const target = join(quarantineRoot, name);
      await rename(dir, (await lstatOrUndefined(target)) ? `${target}-${randomUUID()}` : target).catch((e) => Promise.reject(ioError(e, dir)));
      await event('staging_quarantined', marker.itemId, { entry: name }, relative(realRoot, target));
    }
    return report;
  }
}

interface FailureEntry {
  itemId: string;
  candidateId: string;
  status: WorkItemStatus;
  failure: 'artifact_damaged' | 'committed_evidence_missing' | 'saved_not_counted' | 'no_artifact';
  persisted: boolean;
  reason?: string;
  missing?: Array<{ path: string; disk: string | undefined }>;
}

/** Legal ways from an item's status to `validated` for adopting a journaled file. */
const ADOPTION_PATHS: Partial<Record<WorkItemStatus, WorkItemStatus[]>> = {
  discovered: ['processing', 'acquired', 'validated'],
  processing: ['acquired', 'validated'],
  acquired: ['validated'],
  validated: [],
  failed: ['processing', 'acquired', 'validated'],
};

/**
 * Why an artifact record is not internally consistent: its validation must
 * describe the same bytes, show a finished file of a type the kind accepts,
 * and support the completeness it claims (a complete captured image needs
 * complete capture evidence, a complete PDF a parsed page count). The ledger
 * runs this before commit, so a hand-made "complete" record cannot count.
 * Diagnostics and partial captures stay persistable.
 */
export function artifactRecordProblems(record: ArtifactRecord): string[] {
  const problems: string[] = [];
  const v = record.validation;
  if (!v || v.exists !== true) return ['validation must show the file exists'];
  if (v.bytes !== record.bytes) problems.push('validation size differs from the record');
  if (v.sha256 !== record.sha256) problems.push('validation hash differs from the record');
  if (record.kind !== 'diagnostic') {
    if (v.problems?.length) problems.push(`validation problems: ${v.problems.join(', ')}`);
    if (v.sizeStable !== true) problems.push('file was not shown to be finished');
    const accepted = KIND_TYPES[record.kind];
    if (accepted && !accepted.includes(v.sniffedType ?? '')) problems.push(`${record.kind} cannot be ${v.sniffedType ?? 'an unknown type'}`);
  }
  const capture = record.capture === undefined ? undefined : captureCompleteness(record.capture);
  switch (record.kind) {
    case 'original':
      if (record.completeness === 'complete' && v.sniffedType === MIME.pdf && !(Number.isInteger(v.pageCount) && v.pageCount! > 0))
        problems.push('a complete PDF needs a parsed page count');
      if (record.completeness === 'partial_capture') problems.push('an original cannot be a partial capture');
      break;
    case 'resume_text':
    case 'metadata':
      if (record.completeness === 'partial_capture') problems.push(`${record.kind} cannot be a partial capture`);
      break;
    case 'captured_image':
      if (record.completeness !== (capture ?? 'unverified'))
        problems.push(`completeness ${record.completeness} does not follow from the capture evidence (${capture ?? 'none'})`);
      break;
    case 'captured_page':
    case 'diagnostic':
      if (record.completeness === 'complete' || record.completeness === 'partial_capture')
        problems.push(`a ${record.kind} cannot be ${record.completeness}`);
      break;
  }
  return problems;
}

/** What an archived file proves about the resume, independent of the item. */
function completenessOf(kind: ArtifactKind, capture: CaptureEvidence | undefined): ArtifactCompleteness {
  switch (kind) {
    case 'original':
    case 'resume_text':
    case 'metadata':
      return 'complete';
    case 'captured_image':
      return capture ? captureCompleteness(capture) : 'unverified';
    case 'captured_page':
      // One screen is evidence, never a whole resume.
      return capture && captureCompleteness(capture) === 'invalid' ? 'invalid' : 'unverified';
    case 'diagnostic':
      return 'unverified';
  }
}

/** Candidate names never reach paths; only the staged file's own safe stem may. */
function sourceStem(path: string): string | undefined {
  const stem = basename(path, extname(path));
  return /^[A-Za-z0-9_-]{1,64}$/.test(stem) ? stem : undefined;
}

function destinationPlan(kind: ArtifactKind, stem: string, short: string, ext: string): { dir: string[]; names: string[] } {
  const named = (base: string) => [`${base}${ext}`, `${base}-${short}${ext}`];
  switch (kind) {
    case 'original':
      return { dir: ['original'], names: [`${short}${ext}`] }; // content-addressed: a new resume version gets its own name
    case 'captured_image':
      return { dir: ['captured'], names: named('resume') };
    case 'captured_page':
      return { dir: ['captured', 'pages'], names: named(stem) };
    case 'resume_text':
      return { dir: [], names: [`resume.txt`, `resume-${short}.txt`] };
    case 'metadata':
      return { dir: [], names: [`metadata.json`, `metadata-${short}.json`] };
    case 'diagnostic':
      return { dir: ['diagnostics'], names: named(stem) };
  }
}

/** Same file, same item, same verdict: same id, so a retried archive commits idempotently. */
function artifactId(taskId: string, itemId: string, kind: string, relativePath: string, hash: string, completeness: string): string {
  return 'art-' + createHash('sha256').update([taskId, itemId, kind, relativePath, hash, completeness].join('\n')).digest('hex').slice(0, 32);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, 'wx', 0o644);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw ioError(error, path);
  }
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (code(error) === 'ENOENT') return [];
    throw ioError(error, dir);
  }
}

async function readMarker(path: string): Promise<{ taskId: string; itemId: string; pid: number } | undefined> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return undefined;
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (typeof raw.taskId !== 'string' || typeof raw.itemId !== 'string' || !Number.isInteger(raw.pid)) return undefined;
    return { taskId: raw.taskId, itemId: raw.itemId, pid: raw.pid as number };
  } catch {
    return undefined;
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Quotes a CSV cell and defuses spreadsheet formulas in page-derived text. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
