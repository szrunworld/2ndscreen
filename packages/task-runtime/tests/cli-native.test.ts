import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { parseBridgeEvent } from '../src/contracts.ts';

// The native entries of the built 2ndscreen CLI: `vision`, `agent-bridge`,
// `task` and the MCP task tools. Set SECONDSCREEN_CLI to the built binary
// (e.g. .build/debug/2ndscreen) to run them. Only synthetic images, temporary
// folders and a synthetic task runtime are used: no screen, app, model or
// BOSS is touched, and no running 2ndscreen.app is needed.

const CLI = process.env.SECONDSCREEN_CLI;
const skip = CLI ? false : 'set SECONDSCREEN_CLI to the built 2ndscreen to run';
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

interface Run { code: number | null; stdout: string; stderr: string }

function run(args: string[], options: { input?: string; env?: Record<string, string | undefined> } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const child = spawn(CLI!, args, { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

/** A gray RGB PNG with horizontal stripes, enough texture for compare. */
function png(width: number, height: number, top = 0): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const v = ((y + top) * 37 + x * 11) % 251;
      raw.fill(v, row + 1 + x * 3, row + 4 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const NO_RUNTIME = { SECONDSCREEN_TASK_RUNTIME: undefined, SECONDSCREEN_NODE: undefined };

test('vision answers metadata, compare and OCR on synthetic PNGs', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a7-vision-'));
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  await writeFile(a, png(200, 240));
  await writeFile(b, png(200, 240, 60));
  const meta = await run(['vision'], { input: JSON.stringify({ v: 1, op: 'metadata', image: a }) + '\n' });
  assert.equal(meta.code, 0, meta.stderr);
  const m = JSON.parse(meta.stdout);
  assert.equal(m.ok, true);
  assert.deepEqual([m.result.widthPx, m.result.heightPx, m.result.type], [200, 240, 'public.png']);
  const cmp = await run(['vision'], { input: JSON.stringify({ v: 1, op: 'compare', before: a, after: b }) + '\n' });
  assert.equal(cmp.code, 0, cmp.stdout);
  assert.ok(JSON.parse(cmp.stdout).result.similarity < 1);
  const ocr = await run(['vision'], { input: JSON.stringify({ v: 1, op: 'ocr', image: a }) + '\n' });
  assert.equal(ocr.code, 0, ocr.stdout);
  assert.ok(Array.isArray(JSON.parse(ocr.stdout).result.lines));
  const bad = await run(['vision'], { input: '{"v":1,"op":"ocr","image":"relative.png"}\n' });
  assert.equal(bad.code, 2);
  assert.equal((await run(['vision', '--help'])).code, 0);
  assert.equal((await run(['vision', 'extra'])).code, 2);
});

test('agent-bridge refuses an invalid request with one unit_failed line and exit 2', { skip }, async () => {
  const r = await run(['agent-bridge'], { input: '{"v":1,"taskId":"t1","unitAttemptId":"u1"}\n', env: { SECONDSCREEN_SOCKET: '/nonexistent.sock', ARK_API_KEY: undefined } });
  assert.equal(r.code, 2, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const event = parseBridgeEvent(lines[0]!, { taskId: 't1', unitAttemptId: 'u1' });
  assert.ok(event.ok, event.ok ? '' : event.errors.join('; '));
  assert.equal(event.value.type, 'unit_failed');
});

test('task without a runtime fails honestly, and help still works', { skip }, async () => {
  const empty = await mkdtemp(join(tmpdir(), 'a7-empty-runtime-'));
  const missing = await run(['task', 'status', 'task-1'], { env: { ...NO_RUNTIME, SECONDSCREEN_TASK_RUNTIME: empty } });
  assert.equal(missing.code, 1);
  const lines = missing.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const json = JSON.parse(lines[0]!);
  assert.equal(json.ok, false);
  assert.equal(json.command, 'status');
  assert.equal(json.error.code, 'capability_missing');
  assert.match(json.error.message, /no bin\/node/);
  const relative = await run(['task', 'status', 'x'], { env: { ...NO_RUNTIME, SECONDSCREEN_TASK_RUNTIME: 'relative/dir' } });
  assert.match(JSON.parse(relative.stdout).error.message, /absolute/);
  const noEntry = await run(['task', 'status', 'x'], { env: { SECONDSCREEN_TASK_RUNTIME: empty, SECONDSCREEN_NODE: process.execPath } });
  assert.match(JSON.parse(noEntry.stdout).error.message, /no main\.mjs/);
  const help = await run(['task', '--help'], { env: { ...NO_RUNTIME, SECONDSCREEN_TASK_RUNTIME: empty } });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /2ndscreen task run SKILL_ID/);
  // The global help lists task, vision and agent-bridge.
  const global = await run(['--help']);
  for (const word of ['2ndscreen task run', '2ndscreen vision', '2ndscreen agent-bridge']) assert.ok(global.stdout.includes(word), word);
});

/** A runtime folder whose entry echoes what it was given. */
async function echoRuntime(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'a7-echo-runtime-'));
  await writeFile(join(dir, 'main.mjs'), [
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cli: process.env.SECONDSCREEN_CLI }) + '\\n');",
    'process.exit(7);',
  ].join('\n'));
  return dir;
}

test('task hands its words to the runtime verbatim, with no shell', { skip }, async () => {
  const dir = await echoRuntime();
  const marker = join(dir, 'pwned');
  const words = ['run', 'boss.collect-resumes', '--job', `$(touch ${marker}); \`touch ${marker}\` "q" 'q' * ~ \\`, '--limit', '3', '--output', '/tmp/a b/c'];
  const r = await run(['task', ...words], { env: { SECONDSCREEN_TASK_RUNTIME: dir, SECONDSCREEN_NODE: process.execPath } });
  assert.equal(r.code, 7, 'the runtime exit status passes through');
  const echoed = JSON.parse(r.stdout);
  assert.deepEqual(echoed.argv, words);
  assert.ok(existsSync(echoed.cli), 'SECONDSCREEN_CLI names this CLI');
  assert.ok(!existsSync(marker), 'nothing was interpreted by a shell');
  // The bundled layout is <runtime>/bin/node.
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  await chmod(join(dir, 'bin', 'node'), 0o755);
  const bundled = await run(['task', 'status', 'task-1'], { env: { SECONDSCREEN_TASK_RUNTIME: dir, SECONDSCREEN_NODE: undefined } });
  assert.deepEqual(JSON.parse(bundled.stdout).argv, ['status', 'task-1']);
});

/** A runtime folder whose entry runs the real runCli over a synthetic TaskControl. */
async function synthRuntime(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'a7-synth-runtime-'));
  const tsx = join(PACKAGE, 'node_modules/tsx/dist/esm/api/index.mjs');
  // One module graph, so the control's RuntimeError is the CLI's RuntimeError.
  await writeFile(join(dir, 'synthetic.mts'), `
import { runCli } from ${JSON.stringify(join(PACKAGE, 'src/cli.ts'))};
import { RuntimeError, type TaskControl } from ${JSON.stringify(join(PACKAGE, 'src/contracts.ts'))};
// Synthetic control for this smoke only: it records, it runs nothing.
const none = async (): Promise<never> => { throw new RuntimeError('not_found', 'none'); };
const control = {
  submit: async (skillId: string, input: unknown) => ({ taskId: 'synthetic-1', echo: { skillId, input } }),
  status: async (id: string) => { throw new RuntimeError('not_found', 'no task ' + id); },
  pause: none, resume: none, cancel: none,
  artifacts: async () => [],
  inspectProcedure: async () => undefined,
} as unknown as TaskControl;
process.exitCode = await runCli(process.argv.slice(2), { stdout: (l) => process.stdout.write(l + '\\n'), stderr: (l) => process.stderr.write(l + '\\n') }, control);
`);
  await writeFile(join(dir, 'main.mjs'), `import { tsImport } from ${JSON.stringify(tsx)};\nawait tsImport(${JSON.stringify(join(dir, 'synthetic.mts'))}, import.meta.url);\n`);
  return dir;
}

async function mcp(messages: object[], env: Record<string, string | undefined>): Promise<Array<Record<string, any>>> {
  const input = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = await run(['mcp'], { input, env });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim().split('\n').map((l) => JSON.parse(l));
}

test('MCP lists the task tools beside the old ones', { skip }, async () => {
  const [init, list] = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ], NO_RUNTIME);
  assert.match(init!.result.instructions, /task_\*/);
  const tools = new Map<string, any>(list!.result.tools.map((t: any) => [t.name, t]));
  for (const old of ['screen_create', 'screen_list', 'screen_destroy', 'screen_resize', 'app_launch', 'window_move', 'window_release',
    'screenshot', 'state', 'click', 'type', 'key', 'scroll', 'drag']) assert.ok(tools.has(old), old);
  assert.equal(tools.size, 14 + 8);
  const run = tools.get('task_run');
  assert.deepEqual(run.inputSchema.required, ['skill_id', 'job', 'limit', 'output']);
  assert.deepEqual(Object.keys(run.inputSchema.properties).sort(),
    ['account', 'analysis', 'browse_limit', 'budget', 'deadline', 'job', 'keep_window', 'limit', 'mode', 'output', 'skill_id', 'source', 'take_over']);
  for (const name of ['task_status', 'task_pause', 'task_resume', 'task_cancel', 'task_artifacts'])
    assert.deepEqual(tools.get(name).inputSchema.required, ['task_id'], name);
  assert.deepEqual(tools.get('task_inspect_procedure').inputSchema.required, ['procedure_id']);
  assert.deepEqual(tools.get('task_bind_account').inputSchema.required, ['task_id', 'account']);
});

test('MCP task tools run the same CLI and refuse loose arguments', { skip }, async () => {
  const dir = await synthRuntime();
  const env = { SECONDSCREEN_TASK_RUNTIME: dir, SECONDSCREEN_NODE: process.execPath };
  const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const replies = await mcp([
    call(1, 'task_run', { skill_id: 'boss.collect-resumes', job: '前端', limit: 3, output: '/tmp/out', budget: { taskModelCalls: 0 }, take_over: true }),
    call(2, 'task_status', { task_id: 'task-9' }),
    call(3, 'task_status', { task_id: 'task-9', extra: 1 }),
    call(4, 'task_run', { skill_id: 's', job: 'x', limit: 2.5, output: '/o' }),
    call(5, 'task_run', { skill_id: 's', job: 'x', limit: '3', output: '/o' }),
    call(6, 'task_run', { skill_id: 's', job: 'x', limit: 3, output: '/o', take_over: 1 }),
    call(7, 'task_run', { skill_id: 's', job: 'x', limit: 3, output: 'relative' }),
    call(8, 'task_inspect_procedure', { procedure_id: 'p-1' }),
    call(9, 'task_bind_account', { task_id: 'task-9', account: 'hr-zhang' }),
    call(10, 'task_bind_account', { task_id: 'task-9', account: 'a:b' }),
    call(11, 'task_run', { skill_id: 's', job: 'x', limit: 3, output: '/o', account: 7 }),
    call(12, 'task_run', { skill_id: 's', job: 'x', limit: 3, output: '/o', account: 'hr-zhang' }),
  ], env);
  const text = (i: number) => JSON.parse(replies[i]!.result.content[0].text.trim());
  assert.equal(replies[0]!.result.isError, false, replies[0]!.result.content[0].text);
  assert.deepEqual(text(0).result, {
    taskId: 'synthetic-1',
    echo: { skillId: 'boss.collect-resumes', input: { job: '前端', requestedCount: 3, outputDir: '/tmp/out', source: 'conversations', captureMode: 'available', budget: { taskModelCalls: 0 }, takeOver: true } },
  });
  assert.equal(replies[1]!.result.isError, true);
  assert.equal(text(1).error.code, 'not_found');
  for (const [i, message] of [[2, /unknown argument extra/], [3, /limit must be a whole number/], [4, /limit must be a whole number/], [5, /take_over must be true or false/]] as const) {
    assert.equal(replies[i]!.result.isError, true);
    assert.equal(text(i).error.code, 'invalid_input');
    assert.match(text(i).error.message, message);
  }
  // Values are the runtime's to judge, exactly as on the command line.
  assert.equal(text(6).error.code, 'invalid_input');
  assert.match(text(6).error.message, /outputDir must be an absolute path/);
  assert.equal(text(7).error.code, 'not_found');
  // The synthetic control cannot bind accounts: the runtime refuses instead of dropping the account.
  assert.equal(text(8).error.code, 'capability_missing');
  assert.equal(text(8).command, 'bind-account');
  assert.equal(text(9).error.code, 'invalid_input');
  assert.match(text(9).error.message, /ACCOUNT_KEY/);
  assert.match(text(10).error.message, /account must be a string/);
  assert.equal(text(11).error.code, 'capability_missing');
  assert.equal(text(11).command, 'run');
});
