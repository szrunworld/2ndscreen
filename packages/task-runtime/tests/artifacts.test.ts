import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { isRuntimeError } from '../src/contracts.ts';
import type {
  AccountScope,
  ArtifactStore,
  CandidateIdentity,
  CaptureEvidence,
  Clock,
  RuntimeErrorCode,
  StagedArtifact,
  TaskRecord,
  TaskStore,
  WorkItem,
} from '../src/contracts.ts';
import { JPEG_LIMITS, createArtifactStore, createMacMediaInspector, pickStagedFile, sniffContent } from '../src/artifacts.ts';
import type { MediaInspector } from '../src/artifacts.ts';
import { openTaskStore } from '../src/store.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT: AccountScope = { platform: 'boss', accountKey: 'acct-1', binding: 'observed' };
const COMPLETE: CaptureEvidence = { pages: 4, topConfirmed: true, bottomSignals: ['scroll_position_end', 'end_marker'], stop: 'bottom_confirmed' };
const PARTIAL: CaptureEvidence = { pages: 12, topConfirmed: true, bottomSignals: ['scroll_position_end'], stop: 'page_limit' };

// ---------------------------------------------------------------------------
// synthetic fixtures

function pdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const objs = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj`,
    ...Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj`),
  ];
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`, 'latin1');
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number, color = 2, interlace = 0): Buffer {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width, 0);
  h.writeUInt32BE(height, 4);
  h[8] = 8;
  h[9] = color;
  h[12] = interlace;
  return h;
}

/** Raw scanlines (filter byte 0) for an RGB image, optionally Adam7-interlaced. */
function scanlines(width: number, height: number, seed: number, interlace = 0, rowsOverride?: number): Buffer {
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]].map(([x0, y0, dx, dy]) => [Math.ceil((width - x0!) / dx!), Math.ceil((height - y0!) / dy!)])
    : [[width, height]];
  const parts: Buffer[] = [];
  for (const [w, h] of passes)
    if (w! > 0 && h! > 0)
      for (let y = 0; y < (rowsOverride ?? h!); y++) parts.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(w! * 3, seed)]));
  return Buffer.concat(parts);
}

function png(width = 4, height = 3, seed = 0, opts: { interlace?: number; idat?: Buffer; color?: number } = {}): Buffer {
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr(width, height, opts.color ?? 2, opts.interlace ?? 0)),
    chunk('IDAT', opts.idat ?? deflateSync(scanlines(width, height, seed, opts.interlace ?? 0))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A JPEG header (APP0 + baseline SOF0) declaring width x height, then an end marker; enough for the header checks. */
function jpeg(width = 1, height = 1): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

type ZipEntry = { name: string; data: Buffer; deflate?: boolean; declaredSize?: number; crc?: number };

function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const crc = e.crc ?? crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const CONTENT_TYPES = Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
const DOCUMENT = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>教育经历 &amp; 项目</w:t></w:r></w:p></w:body></w:document>');

function docx(document = DOCUMENT, over: Partial<ZipEntry> = {}): Buffer {
  return zip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }, { name: 'word/document.xml', data: document, deflate: true, ...over }]);
}

const W_MAIN = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * Test double for the platform decoders, for tests about storage rather than
 * decoding: counts page objects in our own synthetic PDFs, echoes the JPEG
 * header size, and names the root of our own synthetic XML. It certifies
 * nothing; the real decoders are tested separately on macOS.
 */
const fakeInspector: MediaInspector = {
  async inspect(path, type) {
    if (type === 'jpeg') {
      const d = sniffContent(readFileSync(path)).dimensions;
      return d ? { ok: true, ...d } : { ok: false, problem: 'fake JPEG decoder: no size' };
    }
    const pages = (readFileSync(path, 'latin1').match(/\/Type \/Page(?![a-z])/g) ?? []).length;
    return pages > 0 ? { ok: true, pageCount: pages } : { ok: false, problem: 'fake PDF parser: no pages' };
  },
  async parseXml(xml) {
    const text = xml.toString('utf8');
    if (text.includes('<Types')) return { ok: true, root: { name: 'Types', namespace: 'http://schemas.openxmlformats.org/package/2006/content-types' }, children: [] };
    return { ok: true, root: { name: 'document', namespace: W_MAIN }, children: [{ name: 'body', namespace: W_MAIN }] };
  },
};

const failingInspector = (problem: string): MediaInspector => ({
  inspect: async () => ({ ok: false, problem }),
  parseXml: async () => ({ ok: false, problem }),
});

// ---------------------------------------------------------------------------
// harness

function fixedClock(at = '2026-10-04T08:00:00.000Z'): Clock {
  return { now: () => new Date(at) };
}

async function rejectsCode(promise: Promise<unknown>, code: RuntimeErrorCode): Promise<void> {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(isRuntimeError(e, code), `expected ${code}, got ${(e as { code?: string }).code}: ${(e as Error)?.message}`);
    return true;
  });
}

interface Env {
  dir: string;
  outputDir: string;
  dbPath: string;
  store: TaskStore;
  artifacts: ArtifactStore;
  task: TaskRecord;
  cleanup(): Promise<void>;
}

async function setup(captureMode: 'available' | 'original-only' = 'available', inspector: MediaInspector = fakeInspector): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'a2-art-'));
  const outputDir = join(dir, 'out');
  mkdirSync(outputDir);
  const dbPath = join(dir, 'tasks.db');
  const store = await openTaskStore({ path: dbPath, clock: fixedClock() });
  let task = await store.createTask({ id: 'boss.collect-resumes', version: '1.0.0' }, {
    job: '算法工程师', requestedCount: 2, outputDir, source: 'conversations', captureMode,
  });
  task = await store.transitionTask(task.id, 'running', { account: ACCOUNT, phase: 'executing' });
  const artifacts = createArtifactStore({ outputDir, taskId: task.id, clock: fixedClock(), inspector });
  return {
    dir, outputDir, dbPath, store, artifacts, task,
    cleanup: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function identity(n: number, over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return { candidateId: `cand-${n}`, accountKey: ACCOUNT.accountKey, fingerprint: `fp-${n}`, confidence: 'strong', evidence: ['name+job'], ...over };
}

async function itemAt(env: Env, n: number, status: 'processing' | 'validated' = 'validated', name = `候选人${n}`): Promise<WorkItem> {
  let item = await env.store.upsertWorkItem(env.task.id, identity(n), { sourceRef: `row-${n}`, name, hints: [] });
  item = await env.store.transitionWorkItem(item.id, 'processing');
  if (status === 'processing') return item;
  await env.store.transitionWorkItem(item.id, 'acquired');
  return env.store.transitionWorkItem(item.id, 'validated');
}

/** stage -> write -> validate, as the runner's archive order does. */
async function stageFile(env: Env, item: WorkItem, kind: StagedArtifact['kind'], name: string, bytes: Buffer, capture?: CaptureEvidence) {
  const area = await env.artifacts.stage(item.id);
  const path = join(area.dir, name);
  writeFileSync(path, bytes);
  const staged: StagedArtifact = { itemId: item.id, kind, path, ...(capture ? { capture } : {}) };
  return { area, staged, validation: await env.artifacts.validate(staged) };
}

/**
 * Runs `body` in a separate process that SIGKILLs itself at the end, after
 * staging a PDF for the item: a real crash, with no in-process state left.
 * `body` sees store, area, staged and identity.
 */
function crashChild(env: Env, item: WorkItem, body: string): void {
  const script = join(env.dir, `crash-${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(
    script,
    `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createArtifactStore } from ${JSON.stringify(join(PKG, 'src/artifacts.ts'))};
    const [outputDir, taskId, itemId, identityJson, pdfB64] = process.argv.slice(2);
    const identity = JSON.parse(identityJson);
    // The decoder is not under test here; a fixed verdict keeps the crash test platform independent.
    const store = createArtifactStore({ outputDir, taskId, inspector: { inspect: async () => ({ ok: true, pageCount: 2 }), parseXml: async () => ({ ok: false, problem: 'unused' }) } });
    const area = await store.stage(itemId);
    const path = join(area.dir, 'resume.pdf');
    writeFileSync(path, Buffer.from(pdfB64, 'base64'));
    const staged = { itemId, kind: 'original', path };
    ${body}
    process.kill(process.pid, 'SIGKILL');
    `,
  );
  const child = spawnSync(join(PKG, 'node_modules/.bin/tsx'), [script, env.outputDir, env.task.id, item.id, JSON.stringify(item.identity), pdf(2).toString('base64')], {
    cwd: PKG,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.signal ?? (child.status === 137 ? 'SIGKILL' : child.status), 'SIGKILL', child.stderr);
}

const files = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [];

// ---------------------------------------------------------------------------
// content sniffing

test('content is identified from bytes; PNG, DOCX and text are decoded in-process', () => {
  assert.deepEqual(sniffContent(pdf(3)), { type: 'application/pdf', problems: [] }, 'PDF pages are left to the parser');
  assert.ok(sniffContent(pdf(2).subarray(0, 120)).problems.some((p) => /%%EOF/.test(p)));
  assert.deepEqual(sniffContent(jpeg(640, 480)), { type: 'image/jpeg', problems: [], dimensions: { width: 640, height: 480 } });
  assert.ok(sniffContent(jpeg().subarray(0, 10)).problems.length > 0, 'truncated JPEG');
  assert.deepEqual(sniffContent(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), {
    type: 'application/msword', problems: ['legacy Word .doc cannot be verified here'],
  });
  assert.equal(sniffContent(Buffer.from('<!DOCTYPE html><title>登录</title>')).type, 'text/html');
  assert.equal(sniffContent(Buffer.from('{"job":"x"}')).type, 'application/json');
  assert.equal(sniffContent(Buffer.from('张三 简历')).type, 'text/plain');
  assert.equal(sniffContent(Buffer.from([0, 1, 2, 3, 0xff])).type, 'application/octet-stream');
});

test('PNG is decoded to its declared size: truncation, garbage, short or extra data all fail', () => {
  const problems = (b: Buffer) => sniffContent(b).problems;
  assert.deepEqual(problems(png(64, 48)), []);
  assert.deepEqual(problems(png(5, 7, 3, { interlace: 1 })), [], 'Adam7 interlaced');
  assert.match(problems(png().subarray(0, 40))[0] ?? '', /truncated|cut off/);
  const corrupt = Buffer.from(png());
  corrupt[40] = corrupt[40]! ^ 0xff;
  assert.match(problems(corrupt)[0] ?? '', /CRC/);
  assert.match(problems(png(64, 64, 0, { idat: Buffer.from('not zlib data at all') }))[0] ?? '', /does not decompress/);
  assert.match(problems(png(64, 64, 0, { idat: deflateSync(scanlines(64, 64, 0, 0, 5)) }))[0] ?? '', /incomplete/);
  assert.match(problems(png(4, 3, 0, { idat: deflateSync(scanlines(4, 30, 0)) }))[0] ?? '', /more pixel data/);
  const badFilter = scanlines(4, 3, 0);
  badFilter[0] = 9;
  assert.match(problems(png(4, 3, 0, { idat: deflateSync(badFilter) }))[0] ?? '', /filter/);
  assert.match(problems(png(4, 3, 0, { color: 3 }))[0] ?? '', /PLTE/);
  // A header claiming gigapixels is refused before anything is inflated or allocated.
  assert.match(problems(png(100_000, 100_000, 0, { idat: deflateSync(Buffer.alloc(10)) }))[0] ?? '', /more pixel data than allowed/);
});

test('DOCX container is parsed in-process; its XML is left to the parser', () => {
  const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const ok = sniffContent(docx());
  assert.equal(ok.type, docxType);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.xmlParts?.map((p) => p.name), ['[Content_Types].xml', 'word/document.xml'], 'both parts still need the XML parser');
  // Malformed XML passes the container check: in-process decoding certifies nothing about the XML.
  assert.deepEqual(sniffContent(docx(Buffer.from('<document invalid=><body>&undefined;</body></document>'))).problems, []);
  assert.match(sniffContent(docx(DOCUMENT, { crc: 1234 })).problems[0] ?? '', /CRC/);
  assert.match(sniffContent(docx(DOCUMENT, { declaredSize: 10 })).problems[0] ?? '', /declared size/, 'output beyond the declared size is cut off (bomb guard)');
  assert.match(sniffContent(docx(DOCUMENT, { declaredSize: 64 * 1024 * 1024 })).problems[0] ?? '', /larger than the XML parser accepts/);
  assert.match(sniffContent(docx().subarray(0, 60)).problems[0] ?? '', /truncated/);
  assert.deepEqual(sniffContent(zip([{ name: 'a.txt', data: Buffer.from('x') }])), { type: 'application/zip', problems: [] });
  assert.match(sniffContent(zip([{ name: 'word/document.xml', data: DOCUMENT }])).problems[0] ?? '', /Content_Types/);
});

test('JPEG frame size is bounded from the header before any decoder runs', async () => {
  const problems = (b: Buffer) => sniffContent(b).problems;
  assert.match(problems(jpeg(60_000, 60_000))[0] ?? '', /exceeds the decode limit/);
  assert.match(problems(jpeg(JPEG_LIMITS.maxSide + 1, 1))[0] ?? '', /exceeds the decode limit/);
  assert.match(problems(jpeg(10_000, 10_000))[0] ?? '', /exceeds the decode limit/, 'each side fits but the pixel count does not');
  assert.match(problems(jpeg(0, 100))[0] ?? '', /zero or deferred/);
  assert.match(problems(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))[0] ?? '', /no frame header/);

  let calls = 0;
  const counting: MediaInspector = { inspect: async () => (calls++, { ok: true, width: 1, height: 1 }), parseXml: fakeInspector.parseXml };
  const env = await setup('available', counting);
  try {
    const item = await itemAt(env, 1);
    const huge = await stageFile(env, item, 'captured_image', 'resume.jpg', jpeg(60_000, 60_000), COMPLETE);
    assert.ok(huge.validation.problems.some((p) => /exceeds the decode limit/.test(p)));
    assert.equal(calls, 0, 'an oversized frame never reaches the decoder');
    const mismatch = await stageFile(env, item, 'captured_image', 'resume.jpg', jpeg(40, 30), COMPLETE);
    assert.equal(calls, 1);
    assert.ok(mismatch.validation.problems.includes('JPEG decodes to a different size than its header'));
  } finally {
    await env.cleanup();
  }
});

test('the macOS decoders parse real structure: reachable pages only, fakes and truncation refused', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-inspect-'));
  try {
    const inspector = createMacMediaInspector();
    const write = (name: string, bytes: Buffer) => {
      writeFileSync(join(dir, name), bytes);
      return join(dir, name);
    };
    assert.deepEqual(await inspector.inspect(write('good.pdf', pdf(3)), 'pdf'), { ok: true, pageCount: 3 });
    const markers = await inspector.inspect(write('fake.pdf', Buffer.from('%PDF-1.4\n/Type /Page /Type /Page\n%%EOF\n')), 'pdf');
    assert.equal(markers.ok, false, 'page markers alone are not a PDF');
    const orphan = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R >> endobj\n' +
        '5 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
      'latin1',
    );
    assert.deepEqual(await inspector.inspect(write('orphan.pdf', orphan), 'pdf'), { ok: true, pageCount: 1 }, 'unreachable page objects are not pages');
    assert.equal((await inspector.inspect(write('trunc.pdf', pdf(3).subarray(0, 90)), 'pdf')).ok, false);

    const sourcePng = write('src.png', png(32, 24, 5));
    const converted = spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', sourcePng, '--out', join(dir, 'real.jpg')]);
    assert.equal(converted.status, 0);
    const realJpeg = readFileSync(join(dir, 'real.jpg'));
    assert.deepEqual(await inspector.inspect(join(dir, 'real.jpg'), 'jpeg'), { ok: true, width: 32, height: 24 });
    const cut = write('cut.jpg', Buffer.concat([realJpeg.subarray(0, realJpeg.length >> 1), Buffer.from([0xff, 0xd9])]));
    assert.equal((await inspector.inspect(cut, 'jpeg')).ok, false, 'a truncated JPEG with a forged end marker does not decode');
    // Bounded from metadata before the raster is allocated.
    const tight = createMacMediaInspector(undefined, undefined, { maxSide: 30_000, maxPixels: 100 });
    assert.deepEqual(await tight.inspect(join(dir, 'real.jpg'), 'jpeg'), { ok: false, problem: 'JPEG 32x24 exceeds the decode limit' });
    const forged = Buffer.from(realJpeg);
    const sof = forged.indexOf(Buffer.from([0xff, 0xc0]));
    forged.writeUInt16BE(60_000, sof + 5);
    forged.writeUInt16BE(60_000, sof + 7);
    assert.equal((await inspector.inspect(write('forged.jpg', forged), 'jpeg')).ok, false, 'a forged 60000x60000 frame is never rasterized');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DOCX XML is judged by NSXMLDocument: malformed attrs, undeclared entities and namespace errors fail', { skip: process.platform !== 'darwin' }, async () => {
  const W = `xmlns:w="${W_MAIN}"`;
  const env = await setup('available', createMacMediaInspector());
  try {
    const item = await itemAt(env, 1);
    const verdict = async (document: string) => (await stageFile(env, item, 'original', 'cv.docx', docx(Buffer.from(document)))).validation.problems;
    assert.deepEqual(await verdict(DOCUMENT.toString()), []);
    const bad: Array<[string, string, RegExp]> = [
      ['malformed attribute', '<document invalid=><body>&undefined;</body></document>', /not well-formed/],
      ['undeclared entity', `<w:document ${W}><w:body><w:t>&undefined;</w:t></w:body></w:document>`, /not well-formed/],
      ['duplicate attribute', `<w:document ${W}><w:body><w:p w:a="1" w:a="2"/></w:body></w:document>`, /not well-formed/],
      ['undeclared prefix', '<w:document><w:body/></w:document>', /not well-formed/],
      ['undeclared nested prefix', `<w:document ${W}><w:body><x:p/></w:body></w:document>`, /not well-formed/],
      ['wrong namespace', '<w:document xmlns:w="urn:not-word"><w:body/></w:document>', /no WordprocessingML document root/],
      ['body outside the namespace', `<w:document ${W}><body/></w:document>`, /no WordprocessingML document root/],
      ['no body', `<w:document ${W}><w:p/></w:document>`, /no WordprocessingML document root/],
      ['mismatched tags', `<w:document ${W}><w:body></w:document>`, /not well-formed/],
      ['internal DTD', `<!DOCTYPE d [<!ENTITY e "x">]><w:document ${W}><w:body>&e;</w:body></w:document>`, /declares a DTD/],
    ];
    for (const [why, document, expected] of bad) {
      const problems = await verdict(document);
      assert.ok(problems.some((p) => expected.test(p)), `${why}: ${JSON.stringify(problems)}`);
    }
    const ok = await stageFile(env, item, 'original', 'cv.docx', docx());
    const record = await env.artifacts.archive(ok.staged, item.identity, ok.validation, []);
    assert.equal((await env.store.commitItem(item.id, [record])).counted, true);
  } finally {
    await env.cleanup();
  }
});

test('the decoder fails closed when unavailable, and cancellation or timeout waits for its exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-inspect-'));
  try {
    const target = join(dir, 'x.pdf');
    writeFileSync(target, pdf(1));
    const missing = await createMacMediaInspector(join(dir, 'no-such-osascript')).inspect(target, 'pdf');
    assert.equal(missing.ok, false);

    const slow = join(dir, 'slow-osascript');
    writeFileSync(slow, `#!/bin/sh\necho $$ > "${dir}/pid-$$"\nexec sleep 30\n`, { mode: 0o755 });
    const pids = () =>
      readdirSync(dir)
        .filter((f) => f.startsWith('pid-'))
        .map((f) => Number(readFileSync(join(dir, f), 'utf8')))
        .filter((pid) => pid > 0); // a file caught mid-write is not a pid yet
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const started = async (n: number) => {
      for (const deadline = Date.now() + 10_000; pids().length < n && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 20));
      assert.equal(pids().length, n, 'the fake decoder started');
    };
    if (process.platform === 'darwin') {
      const controller = new AbortController();
      const cancelled = createMacMediaInspector(slow).inspect(target, 'pdf', controller.signal);
      await started(1);
      assert.ok(alive(pids()[0]!));
      controller.abort();
      await rejectsCode(cancelled, 'cancelled');
      assert.ok(pids().every((pid) => !alive(pid)), 'the decoder process is gone when cancel returns');

      const timedOut = await createMacMediaInspector(slow, 2_000).inspect(target, 'pdf');
      assert.deepEqual(timedOut, { ok: false, problem: 'pdf decoder timed out after 2000 ms' });
      await started(2);
      assert.ok(pids().every((pid) => !alive(pid)));
    }

    // An original whose PDF cannot be parsed is never archivable as a resume.
    const env = await setup('available', failingInspector('no pdf decoder'));
    try {
      const item = await itemAt(env, 1);
      const { staged, validation } = await stageFile(env, item, 'original', 'a.pdf', pdf(2));
      assert.deepEqual(validation.problems, ['no pdf decoder']);
      assert.equal(validation.pageCount, undefined);
      await rejectsCode(env.artifacts.archive(staged, item.identity, validation, []), 'invalid_input');
      const word = await stageFile(env, item, 'original', 'cv.docx', docx());
      assert.deepEqual(word.validation.problems, ['DOCX entry [Content_Types].xml: no pdf decoder'], 'no XML parser: the DOCX stays unverified');
      await rejectsCode(env.artifacts.archive(word.staged, item.identity, word.validation, []), 'invalid_input');
      const kept = await env.artifacts.archive({ ...word.staged, kind: 'diagnostic' }, item.identity, word.validation, []);
      assert.equal(kept.completeness, 'unverified', 'but it can be retained as a diagnostic');
      const legacy = await stageFile(env, item, 'original', 'cv.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
      await rejectsCode(env.artifacts.archive(legacy.staged, item.identity, legacy.validation, []), 'invalid_input');
    } finally {
      await env.cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// staging and validation

test('each attempt gets its own staging directory inside the output root', async () => {
  const env = await setup();
  try {
    const a = await env.artifacts.stage('item-1');
    const b = await env.artifacts.stage('item-1');
    assert.notEqual(a.dir, b.dir);
    assert.ok(a.dir.includes(`${env.task.id}/.staging/item-1.`));
    assert.ok(existsSync(join(a.dir, '.attempt.json')));
    await rejectsCode(env.artifacts.stage('../escape'), 'invalid_input');
    const controller = new AbortController();
    controller.abort();
    await rejectsCode(env.artifacts.stage('item-2', controller.signal), 'cancelled');
    assert.throws(() => createArtifactStore({ outputDir: 'relative', taskId: 't' }), /absolute/);
    assert.throws(() => createArtifactStore({ outputDir: env.outputDir, taskId: '..' }), /safe path/);
  } finally {
    await env.cleanup();
  }
});

test('validation trusts bytes, not extensions', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const good = await stageFile(env, item, 'original', 'resume.pdf', pdf(2));
    assert.deepEqual(good.validation.problems, []);
    assert.equal(good.validation.pageCount, 2);
    assert.equal(good.validation.sizeStable, true);
    assert.match(good.validation.sha256 ?? '', /^[0-9a-f]{64}$/);

    const loginPage = await stageFile(env, item, 'original', 'resume.pdf', Buffer.from('<html><body>请登录</body></html>'));
    assert.ok(loginPage.validation.problems.some((p) => /original cannot be text\/html/.test(p)));
    assert.ok(loginPage.validation.problems.some((p) => /extension \.pdf does not match/.test(p)));

    const pngAsPdf = await stageFile(env, item, 'original', 'resume.pdf', png());
    assert.ok(pngAsPdf.validation.problems.some((p) => /extension \.pdf does not match content image\/png/.test(p)));

    const unfinished = await stageFile(env, item, 'original', 'resume.pdf.crdownload', pdf(1));
    assert.ok(unfinished.validation.problems.some((p) => /unfinished download/.test(p)));

    const truncated = await stageFile(env, item, 'original', 'resume.pdf', pdf(3).subarray(0, 100));
    assert.ok(truncated.validation.problems.length > 0);

    const empty = await stageFile(env, item, 'original', 'resume.pdf', Buffer.alloc(0));
    assert.ok(empty.validation.problems.includes('file is empty'));

    assert.deepEqual((await stageFile(env, item, 'original', 'cv', docx())).validation.problems, []);
    assert.deepEqual((await stageFile(env, item, 'resume_text', 'resume.txt', Buffer.from('教育经历 …'))).validation.problems, []);
    assert.ok((await stageFile(env, item, 'metadata', 'm.json', Buffer.from('[1]'))).validation.problems.some((p) => /JSON object/.test(p)));
    assert.ok((await stageFile(env, item, 'captured_image', 'resume.png', jpeg().subarray(0, 8))).validation.problems.length > 0);

    const area = await env.artifacts.stage(item.id);
    const missing = await env.artifacts.validate({ itemId: item.id, kind: 'original', path: join(area.dir, 'nothing.pdf') });
    assert.equal(missing.exists, false);
  } finally {
    await env.cleanup();
  }
});

test('a file still being written is not stable', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const area = await env.artifacts.stage(item.id);
    const path = join(area.dir, 'resume.pdf');
    writeFileSync(path, pdf(1));
    const timer = setTimeout(() => appendFileSync(path, ' more bytes'), 100);
    const validation = await env.artifacts.validate({ itemId: item.id, kind: 'original', path });
    clearTimeout(timer);
    assert.equal(validation.sizeStable, false);
    assert.ok(validation.problems.includes('file is still changing'));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await rejectsCode(env.artifacts.validate({ itemId: item.id, kind: 'original', path }, controller.signal), 'cancelled');
  } finally {
    await env.cleanup();
  }
});

test('staged paths cannot escape: traversal, symlinks, other items, outside files', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const other = await itemAt(env, 2);
    const area = await env.artifacts.stage(item.id);
    const outside = join(env.dir, 'secret.pdf');
    writeFileSync(outside, pdf(1));

    await rejectsCode(env.artifacts.validate({ itemId: item.id, kind: 'original', path: outside }), 'invalid_input');
    await rejectsCode(env.artifacts.validate({ itemId: item.id, kind: 'original', path: join(area.dir, '..', '..', '..', 'secret.pdf') }), 'invalid_input');
    symlinkSync(outside, join(area.dir, 'link.pdf'));
    await rejectsCode(env.artifacts.validate({ itemId: item.id, kind: 'original', path: join(area.dir, 'link.pdf') }), 'invalid_input');
    mkdirSync(join(env.dir, 'elsewhere'));
    writeFileSync(join(env.dir, 'elsewhere', 'x.pdf'), pdf(1));
    symlinkSync(join(env.dir, 'elsewhere'), join(area.dir, 'sub'));
    await rejectsCode(env.artifacts.validate({ itemId: item.id, kind: 'original', path: join(area.dir, 'sub', 'x.pdf') }), 'invalid_input');
    writeFileSync(join(area.dir, 'mine.pdf'), pdf(1));
    await rejectsCode(env.artifacts.validate({ itemId: other.id, kind: 'original', path: join(area.dir, 'mine.pdf') }), 'invalid_input');
    await rejectsCode(env.artifacts.validate({ itemId: item.id, kind: 'original', path: 'relative.pdf' }), 'invalid_input');
  } finally {
    await env.cleanup();
  }
});

test('pickStagedFile never guesses between several files', async () => {
  const env = await setup();
  try {
    const area = await env.artifacts.stage('item-1');
    await rejectsCode(pickStagedFile(area), 'conflict');
    writeFileSync(join(area.dir, 'a.pdf.crdownload'), 'x');
    await rejectsCode(pickStagedFile(area), 'conflict');
    rmSync(join(area.dir, 'a.pdf.crdownload'));
    writeFileSync(join(area.dir, 'a.pdf'), pdf(1));
    assert.equal(await pickStagedFile(area), join(area.dir, 'a.pdf'));
    writeFileSync(join(area.dir, 'b.pdf'), pdf(1));
    await rejectsCode(pickStagedFile(area), 'conflict');
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// archive

test('archive moves a validated original into the candidate folder by content name', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const { staged, validation } = await stageFile(env, item, 'original', '张三-简历.pdf', pdf(2));
    const record = await env.artifacts.archive(staged, item.identity, validation, ['proc-7']);
    assert.equal(record.relativePath, `candidates/cand-1/original/${validation.sha256!.slice(0, 12)}.pdf`);
    assert.equal(record.completeness, 'complete');
    assert.equal(record.sha256, validation.sha256);
    assert.deepEqual(record.procedureIds, ['proc-7']);
    assert.ok(!existsSync(staged.path), 'the staged copy is gone');
    assert.deepEqual(readFileSync(join(env.artifacts.root, record.relativePath)), pdf(2));
    assert.ok(!record.relativePath.includes('张三'), 'candidate names never reach paths');
    const { counted } = await env.store.commitItem(item.id, [record]);
    assert.equal(counted, true);
  } finally {
    await env.cleanup();
  }
});

test('archive refuses unsafe ids, failed validation and files changed after validation', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const ok = await stageFile(env, item, 'original', 'a.pdf', pdf(1));
    await rejectsCode(env.artifacts.archive(ok.staged, { ...item.identity, candidateId: '../../evil' }, ok.validation, []), 'invalid_input');
    const bad = await stageFile(env, item, 'original', 'b.pdf', Buffer.from('<html></html>'));
    await rejectsCode(env.artifacts.archive(bad.staged, item.identity, bad.validation, []), 'invalid_input');
    appendFileSync(ok.staged.path, 'tampered');
    await rejectsCode(env.artifacts.archive(ok.staged, item.identity, ok.validation, []), 'conflict');
    assert.equal(files(join(env.artifacts.root, 'candidates')).length, 0);
  } finally {
    await env.cleanup();
  }
});

test('archive never overwrites: a different capture gets a hash-suffixed name, the same one is idempotent', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const first = await stageFile(env, item, 'captured_image', 'stitched.png', png(4, 3, 1), COMPLETE);
    const r1 = await env.artifacts.archive(first.staged, item.identity, first.validation, []);
    assert.equal(r1.relativePath, 'candidates/cand-1/captured/resume.png');
    const second = await stageFile(env, item, 'captured_image', 'stitched.png', png(4, 3, 2), COMPLETE);
    const r2 = await env.artifacts.archive(second.staged, item.identity, second.validation, []);
    assert.equal(r2.relativePath, `candidates/cand-1/captured/resume-${second.validation.sha256!.slice(0, 12)}.png`);
    assert.deepEqual(readFileSync(join(env.artifacts.root, r1.relativePath)), png(4, 3, 1));
    const same = await stageFile(env, item, 'captured_image', 'stitched.png', png(4, 3, 1), COMPLETE);
    const r3 = await env.artifacts.archive(same.staged, item.identity, same.validation, []);
    assert.equal(r3.id, r1.id);
    assert.equal(r3.relativePath, r1.relativePath);
  } finally {
    await env.cleanup();
  }
});

test('a symlinked candidate folder cannot redirect files outside the root', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const outside = join(env.dir, 'outside');
    mkdirSync(outside);
    mkdirSync(join(env.artifacts.root, 'candidates'), { recursive: true });
    symlinkSync(outside, join(env.artifacts.root, 'candidates', 'cand-1'));
    const { staged, validation } = await stageFile(env, item, 'original', 'a.pdf', pdf(1));
    await rejectsCode(env.artifacts.archive(staged, item.identity, validation, []), 'invalid_input');
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    await env.cleanup();
  }
});

test('a partial capture is archived and indexed as a diagnostic; a navigation failure has no artifact', async () => {
  const env = await setup();
  try {
    const partialItem = await itemAt(env, 1);
    const { staged, validation } = await stageFile(env, partialItem, 'captured_image', 'stitched.png', png(), PARTIAL);
    const record = await env.artifacts.archive(staged, partialItem.identity, validation, []);
    assert.equal(record.completeness, 'partial_capture');
    const page = await stageFile(env, partialItem, 'captured_page', 'page-001.png', png(2, 2, 9), PARTIAL);
    const pageRecord = await env.artifacts.archive(page.staged, partialItem.identity, page.validation, []);
    assert.equal(pageRecord.relativePath, 'candidates/cand-1/captured/pages/page-001.png');
    assert.equal(pageRecord.completeness, 'unverified');
    const { counted, item: after } = await env.store.commitItem(partialItem.id, [record, pageRecord]);
    assert.equal(counted, false);
    assert.equal(after.status, 'failed');

    const navItem = await itemAt(env, 2, 'processing');
    await env.store.transitionWorkItem(navItem.id, 'failed', { reason: 'open_resume: page did not load' });

    const task = (await env.store.getTask(env.task.id))!;
    assert.equal(task.counts.committed, 0);
    assert.equal(task.counts.diagnostic, 1);
    await env.artifacts.writeIndex(task, await env.store.listWorkItems(task.id), await env.store.listArtifacts(task.id));
    const failures = JSON.parse(readFileSync(join(env.artifacts.root, 'failures.json'), 'utf8')).failures;
    assert.deepEqual(failures.map((f: { failure: string; persisted: boolean }) => [f.failure, f.persisted]), [
      ['saved_not_counted', true],
      ['no_artifact', false],
    ]);
    const manifest = JSON.parse(readFileSync(join(env.artifacts.root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.delivered, 0);
    assert.equal(manifest.candidates[0].artifacts.find((a: { kind: string }) => a.kind === 'captured_image').completeness, 'partial_capture');
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// crashes and reconciliation

test('crash before the rename (real SIGKILL): nothing is adopted, staging is quarantined, the item can retry', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    crashChild(env, item, 'await store.validate(staged);');
    const stagingRoot = join(env.artifacts.root, '.staging');
    const [attempt] = readdirSync(stagingRoot);
    assert.ok(attempt, 'the dead attempt left its staging directory');
    const report = await env.artifacts.reconcile(env.store, env.task.id);
    assert.deepEqual(report.adopted, []);
    assert.deepEqual(report.invalidated, []);
    // Reported by resolved path (macOS temp dirs live behind the /var -> /private/var link).
    assert.deepEqual(report.discardedStaging, [join(realpathSync(stagingRoot), attempt)]);
    assert.deepEqual(readdirSync(stagingRoot), []);
    assert.ok(existsSync(join(env.artifacts.root, '.quarantine', attempt, 'resume.pdf')), 'the partial download is kept for diagnosis');
    assert.equal(files(join(env.artifacts.root, 'candidates')).length, 0);
    assert.equal((await env.store.listArtifacts(env.task.id)).length, 0);
    assert.equal((await env.store.listWorkItems(env.task.id))[0]?.status, 'validated');
    await env.store.transitionWorkItem(item.id, 'processing'); // the runner retries
  } finally {
    await env.cleanup();
  }
});

test('crash after the rename, before the commit (real SIGKILL): reconcile adopts the file exactly once', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    crashChild(env, item, "await store.archive(staged, identity, await store.validate(staged), ['proc-1']);");
    const archived = files(join(env.artifacts.root, 'candidates'));
    assert.equal(archived.length, 1, 'the file was renamed before the crash');
    assert.equal((await env.store.listArtifacts(env.task.id)).length, 0, 'but never committed');

    const restarted = createArtifactStore({ outputDir: env.outputDir, taskId: env.task.id, clock: fixedClock(), inspector: fakeInspector });
    const report = await restarted.reconcile(env.store, env.task.id);
    assert.equal(report.adopted.length, 1);
    const [record] = await env.store.listArtifacts(env.task.id);
    assert.equal(record?.kind, 'original');
    assert.deepEqual(record?.procedureIds, ['proc-1']);
    const after = (await env.store.listWorkItems(env.task.id))[0]!;
    assert.equal(after.status, 'committed');
    assert.equal((await env.store.counts(env.task.id)).committed, 1);

    const again = await restarted.reconcile(env.store, env.task.id);
    assert.deepEqual(again, { adopted: [], invalidated: [], discardedStaging: [] });
    assert.equal((await env.store.listArtifacts(env.task.id)).length, 1);
    assert.equal(files(join(env.artifacts.root, 'candidates')).length, 1);
  } finally {
    await env.cleanup();
  }
});

test('a journaled partial capture is adopted as a diagnostic, never promoted', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1, 'processing');
    const { staged, validation } = await stageFile(env, item, 'captured_image', 'stitched.png', png(), PARTIAL);
    await env.artifacts.archive(staged, item.identity, validation, []);
    // crash before commit; the item was still processing
    const report = await createArtifactStore({ outputDir: env.outputDir, taskId: env.task.id, inspector: fakeInspector }).reconcile(env.store, env.task.id);
    assert.equal(report.adopted.length, 1);
    const after = (await env.store.listWorkItems(env.task.id))[0]!;
    assert.equal(after.status, 'failed');
    assert.equal((await env.store.counts(env.task.id)).committed, 0);
  } finally {
    await env.cleanup();
  }
});

test('adoption refuses a journal whose candidate binding does not match the item', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const { staged, validation } = await stageFile(env, item, 'original', 'a.pdf', pdf(1));
    const record = await env.artifacts.archive(staged, item.identity, validation, []);
    const journal = join(env.artifacts.root, '.journal', `${record.id}.json`);
    const entry = JSON.parse(readFileSync(journal, 'utf8'));
    entry.accountKey = 'acct-2';
    writeFileSync(journal, JSON.stringify(entry));
    const report = await env.artifacts.reconcile(env.store, env.task.id);
    assert.deepEqual(report.adopted, []);
    assert.equal((await env.store.listWorkItems(env.task.id))[0]?.status, 'validated');
    const events = await env.store.listEvents(env.task.id);
    assert.ok(events.some((e) => e.type === 'adoption_refused' && e.detail?.why === 'identity_mismatch'));
  } finally {
    await env.cleanup();
  }
});

test('a journal without its file (crash between journal and link) is dropped, not adopted', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const { staged, validation } = await stageFile(env, item, 'original', 'a.pdf', pdf(1));
    const record = await env.artifacts.archive(staged, item.identity, validation, []);
    rmSync(join(env.artifacts.root, record.relativePath));
    const report = await env.artifacts.reconcile(env.store, env.task.id);
    assert.deepEqual(report.adopted, []);
    assert.ok(!existsSync(join(env.artifacts.root, '.journal', `${record.id}.json`)));
    assert.equal((await env.store.listArtifacts(env.task.id)).length, 0);
  } finally {
    await env.cleanup();
  }
});

test('a committed file missing or changed on disk is reported; the item stays committed but is not delivered', async () => {
  const env = await setup();
  try {
    const one = await itemAt(env, 1);
    const a = await stageFile(env, one, 'original', 'a.pdf', pdf(1));
    const ra = await env.artifacts.archive(a.staged, one.identity, a.validation, []);
    await env.store.commitItem(one.id, [ra]);
    const two = await itemAt(env, 2);
    const b = await stageFile(env, two, 'original', 'b.pdf', pdf(2));
    const rb = await env.artifacts.archive(b.staged, two.identity, b.validation, []);
    await env.store.commitItem(two.id, [rb]);

    rmSync(join(env.artifacts.root, ra.relativePath));
    writeFileSync(join(env.artifacts.root, rb.relativePath), pdf(3)); // replaced by someone else
    const report = await env.artifacts.reconcile(env.store, env.task.id);
    assert.deepEqual(report.invalidated.sort(), [ra.id, rb.id].sort());
    const items = await env.store.listWorkItems(env.task.id);
    assert.deepEqual(items.map((i) => i.status), ['committed', 'committed'], 'terminal status is preserved');
    assert.equal((await env.store.counts(env.task.id)).committed, 2, 'the ledger count is historical');
    const events = (await env.store.listEvents(env.task.id)).filter((e) => e.type === 'artifact_missing');
    assert.deepEqual(events.map((e) => e.detail?.disk).sort(), ['changed', 'missing']);

    const task = (await env.store.getTask(env.task.id))!;
    await env.artifacts.writeIndex(task, items, await env.store.listArtifacts(task.id));
    const manifest = JSON.parse(readFileSync(join(env.artifacts.root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.ledgerCounts.committed, 2);
    assert.equal(manifest.delivered, 0, 'missing or corrupt evidence is never presented as delivered');
    assert.deepEqual(manifest.candidates.map((c: { artifacts: Array<{ disk: string }> }) => c.artifacts[0]!.disk), ['missing', 'changed']);
    const failures = JSON.parse(readFileSync(join(env.artifacts.root, 'failures.json'), 'utf8')).failures;
    assert.deepEqual(failures.map((f: { failure: string }) => f.failure), ['committed_evidence_missing', 'committed_evidence_missing']);
  } finally {
    await env.cleanup();
  }
});

test('a non-terminal item whose ledger file vanished goes back to processing', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const a = await stageFile(env, item, 'captured_image', 'x.png', png(), PARTIAL);
    const ra = await env.artifacts.archive(a.staged, item.identity, a.validation, []);
    await env.store.commitItem(item.id, [ra]); // not countable -> failed, kept as diagnostic
    await env.store.transitionWorkItem(item.id, 'processing');
    await env.store.transitionWorkItem(item.id, 'acquired');
    rmSync(join(env.artifacts.root, ra.relativePath));
    const report = await env.artifacts.reconcile(env.store, env.task.id);
    assert.deepEqual(report.invalidated, [ra.id]);
    assert.equal((await env.store.listWorkItems(env.task.id))[0]?.status, 'processing');
  } finally {
    await env.cleanup();
  }
});

test('reconcile leaves live, unowned and symlinked staging entries alone', async () => {
  const env = await setup();
  try {
    const mine = await env.artifacts.stage('item-live');
    const stagingRoot = join(env.artifacts.root, '.staging');
    const foreignLive = join(stagingRoot, 'item-x.other');
    mkdirSync(foreignLive);
    writeFileSync(join(foreignLive, '.attempt.json'), JSON.stringify({ v: 1, taskId: env.task.id, itemId: 'item-x', pid: process.ppid }));
    const unowned = join(stagingRoot, 'item-y.unknown');
    mkdirSync(unowned);
    writeFileSync(join(unowned, 'resume.pdf'), pdf(1));
    const outside = join(env.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(stagingRoot, 'item-z.link'));

    const report = await env.artifacts.reconcile(env.store, env.task.id);
    assert.deepEqual(report.discardedStaging, []);
    for (const dir of [mine.dir, foreignLive, unowned]) assert.ok(existsSync(dir), dir);
    assert.ok(existsSync(join(outside, 'keep.txt')));
    const skipped = (await env.store.listEvents(env.task.id)).filter((e) => e.type === 'staging_skipped').map((e) => e.detail?.why);
    assert.deepEqual(skipped.sort(), ['not_a_plain_directory', 'owner_alive', 'unowned']);
  } finally {
    await env.cleanup();
  }
});

test('a sibling store in the same process keeps its live attempt; a finished attempt leaves no staging', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1);
    const sibling = createArtifactStore({ outputDir: env.outputDir, taskId: env.task.id, inspector: fakeInspector });
    const live = await sibling.stage(item.id);
    writeFileSync(join(live.dir, 'resume.pdf.part'), 'downloading');
    const report = await env.artifacts.reconcile(env.store, env.task.id);
    assert.deepEqual(report.discardedStaging, []);
    assert.ok(existsSync(join(live.dir, 'resume.pdf.part')));

    const done = await stageFile(env, item, 'original', 'a.pdf', pdf(1));
    await env.artifacts.archive(done.staged, item.identity, done.validation, []);
    assert.ok(!existsSync(done.area.dir), 'an archived attempt removes its empty staging directory');
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// export

test('the index is rebuilt from the ledger alone, deterministically and safely', async () => {
  const env = await setup();
  try {
    const item = await itemAt(env, 1, 'validated', '=HYPERLINK("http://x","张三")');
    const a = await stageFile(env, item, 'original', 'a.pdf', pdf(2));
    const record = await env.artifacts.archive(a.staged, item.identity, a.validation, ['proc-1']);
    await env.store.commitItem(item.id, [record]);
    // Crash after commit, before the index: rebuild from a fresh store instance.
    const rebuild = async () => {
      const store = createArtifactStore({ outputDir: env.outputDir, taskId: env.task.id, clock: fixedClock('2026-10-04T09:00:00.000Z'), inspector: fakeInspector });
      const task = (await env.store.getTask(env.task.id))!;
      await store.writeIndex(task, await env.store.listWorkItems(task.id), await env.store.listArtifacts(task.id));
      return ['manifest.json', 'index.csv', 'failures.json'].map((f) => readFileSync(join(env.artifacts.root, f), 'utf8'));
    };
    const first = await rebuild();
    const second = await rebuild();
    assert.deepEqual(second, first);
    const [manifestText, csv, failuresText] = first as [string, string, string];
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.delivered, 1);
    assert.equal(manifest.task.captureMode, 'available');
    assert.equal(manifest.candidates[0].artifacts[0].pageCount, 2);
    assert.equal(manifest.candidates[0].artifacts[0].disk, 'present');
    assert.ok(!manifestText.includes(env.dir), 'no absolute paths in the export');
    assert.deepEqual(JSON.parse(failuresText).failures, []);
    assert.ok(csv.startsWith('﻿candidate_id,'));
    assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""张三"")"`), 'formulas from page text are defused');
    assert.ok(!readdirSync(env.artifacts.root).some((f) => f.endsWith('.tmp')));
    const foreign = { ...(await env.store.getTask(env.task.id))!, id: 'other' };
    await rejectsCode(env.artifacts.writeIndex(foreign, [], []), 'invalid_input');
  } finally {
    await env.cleanup();
  }
});
