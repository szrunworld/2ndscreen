import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';
import { createLocalVision, partialComposePath } from '../src/adapters/local-vision.ts';
import { isRuntimeError, type LineProcess, type LineProcessSpawner, type LocalVision } from '../src/contracts.ts';

// A synthetic helper: every process the adapter starts is answered by a
// script here, so no real image, screen or BOSS data is touched. One test at
// the end runs the real helper when LOCAL_VISION_HELPER points at it.

const SHA = 'a'.repeat(64);

interface FakeChild extends LineProcess {
  written: string[];
  inputClosed: boolean;
  signals: string[];
  /** Emit a stdout line. */
  say(line: string): void;
  exit(code: number | null, signal?: string | null): void;
}

type Script = (child: FakeChild, request: Record<string, unknown>) => void | Promise<void>;

function fakeSpawner(script: Script, options: { ignoreTerm?: boolean } = {}) {
  const spawned: Array<{ file: string; args: string[]; env?: Record<string, string>; child: FakeChild }> = [];
  const spawn: LineProcessSpawner = (file, args, env) => {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let resolveExit!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (resolveExit = r));
    const child: FakeChild = {
      pid: 4000 + spawned.length,
      written: [],
      inputClosed: false,
      signals: [],
      write(line) {
        child.written.push(line);
      },
      closeInput() {
        child.inputClosed = true;
        const request = JSON.parse(child.written.join('')) as Record<string, unknown>;
        void Promise.resolve().then(() => script(child, request));
      },
      async *lines() {
        while (true) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      },
      exited: () => exited,
      kill(signal = 'SIGTERM') {
        child.signals.push(signal);
        if (signal === 'SIGKILL' || !options.ignoreTerm) child.exit(null, signal);
      },
      say(line) {
        queue.push(line);
        wake?.();
      },
      exit(code, signal = null) {
        if (ended) return;
        ended = true;
        wake?.();
        resolveExit({ code, signal });
      },
    };
    spawned.push({ file, args: [...args], env, child });
    return child;
  };
  return { spawn, spawned };
}

const ok = (result: unknown) => JSON.stringify({ v: 1, ok: true, result });
const fail = (code: string, message: string) => JSON.stringify({ v: 1, ok: false, error: { code, message } });
const reply = (line: string, code = 0): Script => (child) => {
  child.say(line);
  child.exit(code);
};
const never: Script = () => undefined;

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(isRuntimeError(e), `expected RuntimeError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

test('ocr sends one request line on stdin and returns pixel boxes with confidence', async () => {
  const result = { lines: [{ text: '张三 软件工程师', box: { x: 31.5, y: 40, width: 300, height: 48 }, confidence: 0.98 }], imageSha256: SHA, widthPx: 2720, heightPx: 1696 };
  const { spawn, spawned } = fakeSpawner(reply(ok(result)));
  const vision = createLocalVision({ helper: '/opt/2ndscreen', spawn, env: { LANG: 'C' } });
  const out = await vision.ocr('/tmp/shot.png', { roi: { x: 0, y: 100, width: 2720, height: 1500 }, languages: ['zh-Hans', 'en-US'] });
  assert.deepEqual(out, result);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.file, '/opt/2ndscreen');
  assert.deepEqual(spawned[0]!.args, ['vision']);
  assert.deepEqual(spawned[0]!.env, { LANG: 'C' });
  const child = spawned[0]!.child;
  assert.equal(child.inputClosed, true);
  assert.equal(child.written.length, 1);
  assert.ok(child.written[0]!.endsWith('\n'));
  assert.deepEqual(JSON.parse(child.written[0]!), {
    v: 1,
    op: 'ocr',
    image: '/tmp/shot.png',
    roi: { x: 0, y: 100, width: 2720, height: 1500 },
    languages: ['zh-Hans', 'en-US'],
  });
});

test('compare reports similarity and a vertical shift, and passes no shift through as absent', async () => {
  const { spawn, spawned } = fakeSpawner((child, request) => {
    child.say(ok(request.after === '/s/b.png' ? { similarity: 0.71, verticalShiftPx: 640, overlapMeanDiff: 0 } : { similarity: 1 }));
    child.exit(0);
  });
  const vision = createLocalVision({ helper: 'h', spawn });
  assert.deepEqual(await vision.compare('/s/a.png', '/s/b.png', { roi: { x: 0, y: 120, width: 1400, height: 1500 } }), { similarity: 0.71, verticalShiftPx: 640 });
  // Identical screens: similarity 1 with no proven shift is "no progress", never the end of the resume.
  assert.deepEqual(await vision.compare('/s/a.png', '/s/a2.png'), { similarity: 1 });
  assert.deepEqual(JSON.parse(spawned[0]!.child.written[0]!).roi, { x: 0, y: 120, width: 1400, height: 1500 });
});

test('compose sends frames and output and checks the reply against the request', async () => {
  const composed = {
    path: '/stage/resume.png',
    widthPx: 1400,
    heightPx: 2900,
    sha256: SHA,
    hasGap: true,
    frames: [
      { index: 0, placement: 'first', outputY: 0, rows: 1500 },
      { index: 1, placement: 'placed', outputY: 1500, rows: 700, overlapPx: 800 },
      { index: 2, placement: 'duplicate', outputY: 2200, rows: 0, overlapPx: 1500 },
      { index: 3, placement: 'gap', outputY: 2200, rows: 700 },
    ],
  };
  const { spawn, spawned } = fakeSpawner(reply(ok(composed)));
  const vision = createLocalVision({ helper: 'h', spawn });
  const frames = ['/stage/p0.png', '/stage/p1.png', '/stage/p2.png', '/stage/p3.png'];
  const out = await vision.compose(frames, '/stage/resume.png', { roi: { x: 0, y: 0, width: 1400, height: 1500 }, minOverlapPx: 64 });
  assert.deepEqual(out, composed);
  const { nonce, ...sent } = JSON.parse(spawned[0]!.child.written[0]!);
  assert.match(nonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent, {
    v: 1,
    op: 'compose',
    frames,
    output: '/stage/resume.png',
    roi: { x: 0, y: 0, width: 1400, height: 1500 },
    minOverlapPx: 64,
  });

  for (const bad of [
    { ...composed, frames: composed.frames.slice(1) },
    { ...composed, hasGap: false },
    { ...composed, heightPx: 2901 },
    { ...composed, path: '/elsewhere.png' },
    { ...composed, frames: [{ ...composed.frames[0], placement: 'stitched' }, ...composed.frames.slice(1)] },
  ]) {
    const v = createLocalVision({ helper: 'h', spawn: fakeSpawner(reply(ok(bad))).spawn });
    await rejects(v.compose(frames, '/stage/resume.png'), 'io');
  }
});

test('metadata returns size, bytes, hash and type', async () => {
  const meta = { widthPx: 2720, heightPx: 1696, bytes: 912345, sha256: SHA, type: 'public.png' };
  const vision = createLocalVision({ helper: 'h', spawn: fakeSpawner(reply(ok(meta))).spawn });
  assert.deepEqual(await vision.metadata('/s/a.png'), meta);
});

test('bad inputs are refused before any process starts', async () => {
  const { spawn, spawned } = fakeSpawner(reply(ok({})));
  const vision = createLocalVision({ helper: 'h', spawn });
  await rejects(vision.ocr('relative.png'), 'invalid_input');
  await rejects(vision.ocr('/a\0b.png'), 'invalid_input');
  await rejects(vision.ocr('/a.png', { roi: { x: 0, y: 0, width: 0, height: 10 } }), 'invalid_input');
  await rejects(vision.ocr('/a.png', { roi: { x: 0, y: 0, width: Number.NaN, height: 10 } }), 'invalid_input');
  await rejects(vision.ocr('/a.png', { roi: { x: -20, y: 0, width: 10, height: 10 } }), 'invalid_input');
  await rejects(vision.ocr('/a.png', { roi: { x: '0', y: 0, width: 10, height: 10 } as never }), 'invalid_input');
  await rejects(vision.ocr('/a.png', { languages: [] }), 'invalid_input');
  await rejects(vision.ocr('/a.png', { languages: ['zh-Hans; rm -rf'] }), 'invalid_input');
  await rejects(vision.ocr('/a.png', { languages: Array(9).fill('en') }), 'invalid_input');
  await rejects(vision.compare('/a.png', 'b.png'), 'invalid_input');
  await rejects(vision.compose([], '/out.png'), 'invalid_input');
  await rejects(vision.compose(Array(65).fill('/a.png'), '/out.png'), 'invalid_input');
  await rejects(vision.compose(['/a.png'], '/out.jpg'), 'invalid_input');
  await rejects(vision.compose(['/a.png'], 'out.png'), 'invalid_input');
  await rejects(vision.compose(['/a.png'], '/out.png', { minOverlapPx: 0.5 }), 'invalid_input');
  await rejects(vision.compose(['/a.png'], '/out.png', { minOverlapPx: 5000 }), 'invalid_input');
  await rejects(vision.metadata('/' + 'x'.repeat(5000)), 'invalid_input');
  assert.equal(spawned.length, 0);
});

test('helper errors keep their runtime code; unknown codes and malformed replies are io', async () => {
  const cases: Array<[Script, string]> = [
    [reply(fail('invalid_input', 'roi is outside the 2720x1696 px image'), 2), 'invalid_input'],
    [reply(fail('not_found', 'image does not exist'), 1), 'not_found'],
    [reply(fail('conflict', 'output exists'), 1), 'conflict'],
    [reply(fail('lease_held', 'not a vision error'), 1), 'io'],
    [reply('not json'), 'io'],
    [reply(JSON.stringify({ v: 2, ok: true, result: {} })), 'io'],
    [reply(ok({ similarity: 1 }), 1), 'io'],
    [reply(ok({ lines: [{ text: 'x', box: { x: 0, y: 0, width: 1, height: 1 }, confidence: 7 }], imageSha256: SHA, widthPx: 1, heightPx: 1 })), 'io'],
    [reply(ok({ lines: [], imageSha256: 'nope', widthPx: 1, heightPx: 1 })), 'io'],
    [(c) => c.exit(1), 'io'],
    [(c) => { c.say(ok({})); c.say(ok({})); c.exit(0); }, 'io'],
  ];
  for (const [script, code] of cases) {
    const vision = createLocalVision({ helper: 'h', spawn: fakeSpawner(script).spawn });
    await rejects(vision.ocr('/a.png'), code);
  }
  const error = await createLocalVision({ helper: 'h', spawn: fakeSpawner(reply(fail('invalid_input', 'roi is outside'), 2)).spawn })
    .ocr('/a.png')
    .catch((e: unknown) => e);
  assert.ok(isRuntimeError(error) && error.message === 'roi is outside');
});

test('an aborted call stops the helper and settles only after it exits', async () => {
  const { spawn, spawned } = fakeSpawner(never);
  const vision = createLocalVision({ helper: 'h', spawn });
  const controller = new AbortController();
  const pending = vision.ocr('/a.png', undefined, controller.signal);
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await rejects(pending, 'cancelled');
  assert.deepEqual(spawned[0]!.child.signals, ['SIGTERM']);

  const already = new AbortController();
  already.abort();
  await rejects(vision.ocr('/a.png', undefined, already.signal), 'cancelled');
  assert.equal(spawned.length, 1, 'an already-aborted signal starts nothing');
});

test('a helper that ignores SIGTERM is killed after the grace period', async () => {
  const { spawn, spawned } = fakeSpawner(never, { ignoreTerm: true });
  const vision = createLocalVision({ helper: 'h', spawn, timeoutMs: 20, killGraceMs: 30 });
  const started = Date.now();
  await rejects(vision.compare('/a.png', '/b.png'), 'timeout');
  assert.deepEqual(spawned[0]!.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started >= 45);
});

test('a cancelled compose removes only the partial file its own helper made', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-vision-'));
  const output = join(dir, 'resume.png');
  // Another compose of the same output, and the old fixed name: never ours to delete.
  const legacy = join(dir, '.resume.png.partial');
  const other = partialComposePath(output, 'other-compose-nonce');
  await writeFile(legacy, 'theirs');
  await writeFile(other, 'theirs');
  let mine = '';
  const { spawn, spawned } = fakeSpawner(async (_child, request) => {
    assert.match(String(request.nonce), /^[0-9a-f-]{36}$/);
    mine = partialComposePath(output, String(request.nonce));
    await writeFile(mine, 'half a png');
  }, { ignoreTerm: true });
  const vision = createLocalVision({ helper: 'h', spawn, killGraceMs: 5 });
  const controller = new AbortController();
  const pending = vision.compose([join(dir, 'a.png')], output, undefined, controller.signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(mine));
  controller.abort();
  await rejects(pending, 'cancelled');
  assert.deepEqual(spawned[0]!.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(existsSync(mine), false);
  assert.equal(await readFile(legacy, 'utf8'), 'theirs');
  assert.equal(await readFile(other, 'utf8'), 'theirs');
  assert.equal(existsSync(output), false);

  // Each call names a fresh partial file.
  const nonces = new Set<string>();
  const v2 = createLocalVision({ helper: 'h', spawn: fakeSpawner((c, req) => { nonces.add(String(req.nonce)); c.exit(1); }).spawn });
  for (let i = 0; i < 3; i++) await rejects(v2.compose(['/a.png'], output), 'io');
  assert.equal(nonces.size, 3);
});

test('a kill that throws still lets a cancelled call settle once the helper exits', async () => {
  const { spawn, spawned } = fakeSpawner(never, { ignoreTerm: true });
  const throwing: LineProcessSpawner = (file, args, env) => {
    const child = spawn(file, args, env) as FakeChild;
    const kill = child.kill.bind(child);
    child.kill = (sig) => {
      kill(sig === 'SIGKILL' ? 'SIGTERM' : sig); // record, but never exit from a kill
      throw new Error('ESRCH');
    };
    setTimeout(() => child.exit(0), 40);
    return child;
  };
  const vision = createLocalVision({ helper: 'h', spawn: throwing, killGraceMs: 5 });
  const controller = new AbortController();
  const pending = vision.ocr('/a.png', undefined, controller.signal);
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await rejects(pending, 'cancelled');
  assert.equal(spawned[0]!.child.signals.length, 2, 'SIGTERM then the SIGKILL attempt, both swallowed');
});

test('an abort that fires while the helper is starting is not missed', async () => {
  const { spawn, spawned } = fakeSpawner(never);
  const controller = new AbortController();
  const aborting: LineProcessSpawner = (file, args, env) => {
    const child = spawn(file, args, env);
    controller.abort(); // after the pre-spawn check, before the listener exists
    return child;
  };
  const vision = createLocalVision({ helper: 'h', spawn: aborting, timeoutMs: 60_000 });
  await rejects(vision.ocr('/a.png', undefined, controller.signal), 'cancelled');
  assert.deepEqual(spawned[0]!.child.signals, ['SIGTERM']);
});

test('a helper that cannot start or loses its exit status is io', async () => {
  const cannot: LineProcessSpawner = () => {
    throw new Error('ENOENT');
  };
  await rejects(createLocalVision({ helper: '/missing', spawn: cannot }).ocr('/a.png'), 'io');
  const { spawn } = fakeSpawner(never);
  const lost: LineProcessSpawner = (file, args, env) => {
    const child = spawn(file, args, env) as FakeChild;
    child.exited = () => Promise.reject(new Error('wait failed'));
    child.exit(1);
    return child;
  };
  await rejects(createLocalVision({ helper: 'h', spawn: lost }).ocr('/a.png'), 'io');
});

test('close stops running calls and refuses new ones', async () => {
  const { spawn, spawned } = fakeSpawner(never);
  const vision = createLocalVision({ helper: 'h', spawn });
  const pending = vision.ocr('/a.png');
  await new Promise((r) => setTimeout(r, 5));
  await vision.close();
  await rejects(pending, 'cancelled');
  assert.deepEqual(spawned[0]!.child.signals, ['SIGTERM']);
  await rejects(vision.ocr('/a.png'), 'cancelled');
  assert.equal(spawned.length, 1);
});

test('an oversized reply is cut off as io', async () => {
  const { spawn, spawned } = fakeSpawner((child) => {
    child.say('x'.repeat(17 << 20));
  });
  const vision = createLocalVision({ helper: 'h', spawn });
  await rejects(vision.metadata('/a.png'), 'io');
  assert.deepEqual(spawned[0]!.child.signals, ['SIGTERM']);
});

test('the client satisfies the LocalVision contract with compose present', () => {
  const vision: LocalVision = createLocalVision({ helper: 'h', spawn: fakeSpawner(never).spawn });
  assert.equal(typeof vision.compose, 'function');
  assert.equal(vision.findTemplate, undefined, 'template locators stay capability_missing');
});

// ---------------------------------------------------------------------------
// The real helper, on synthetic images, when built and pointed at.

const HELPER = process.env.LOCAL_VISION_HELPER;

/** A minimal spawner over node:child_process for the real helper. */
const childSpawner: LineProcessSpawner = (file, args, env) => {
  const child = spawnChild(file, [...args], { env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const rl = createInterface({ input: child.stdout! });
  return {
    pid: child.pid,
    write: (line) => void child.stdin!.write(line),
    closeInput: () => void child.stdin!.end(),
    lines: () => rl[Symbol.asyncIterator](),
    exited: () => exited,
    kill: (signal = 'SIGTERM') => void child.kill(signal),
  };
};

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** An RGB PNG whose pixel (x, y) is pixel(x, y). */
function png(width: number, height: number, pixel: (x: number, y: number) => number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = pixel(x, y);
      raw.set([v, v, v], y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Text-like dark blocks on white that never repeat. */
function pagePixel(x: number, y: number): number {
  const line = Math.floor(y / 24);
  if (y % 24 >= 12 || x < 8 || x > 230) return 255;
  const seed = (line * 2654435761 + Math.floor(x / (10 + (line % 7) * 3)) * 40503) >>> 0;
  return seed % 3 === 0 ? 255 : 40 + (seed % 90);
}

test('the real helper compares and composes synthetic screens', { skip: HELPER ? false : 'set LOCAL_VISION_HELPER to the built 2ndscreen to run' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-vision-real-'));
  const frame = (top: number) => png(240, 300, (x, y) => pagePixel(x, y + top));
  const paths = [join(dir, 'p0.png'), join(dir, 'p1.png'), join(dir, 'p2.png'), join(dir, 'p3.png')];
  await Promise.all([0, 180, 180, 360].map((top, i) => writeFile(paths[i]!, frame(top))));
  const vision = createLocalVision({ helper: HELPER!, spawn: childSpawner });
  const meta = await vision.metadata(paths[0]!);
  assert.equal(meta.widthPx, 240);
  assert.equal(meta.type, 'public.png');
  const progress = await vision.compare(paths[0]!, paths[1]!);
  assert.equal(progress.verticalShiftPx, 180);
  const still = await vision.compare(paths[1]!, paths[2]!);
  assert.equal(still.similarity, 1);
  const out = join(dir, 'resume.png');
  const composed = await vision.compose(paths, out);
  assert.deepEqual(composed.frames.map((f) => f.placement), ['first', 'placed', 'duplicate', 'placed']);
  assert.equal(composed.heightPx, 660);
  assert.equal(composed.hasGap, false);
  assert.ok((await readFile(out)).length > 0);
  await rejects(vision.compose(paths, out), 'conflict');
  await rejects(vision.ocr(paths[0]!, { roi: { x: 200, y: 0, width: 100, height: 10 } }), 'invalid_input');
  const ocr = await vision.ocr(paths[0]!, { languages: ['en-US'] });
  assert.equal(ocr.widthPx, 240);
  assert.equal(ocr.heightPx, 300);
  await vision.close();
});
