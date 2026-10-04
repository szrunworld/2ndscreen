import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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

/** The one task the synthetic control knows: a status report and its artifact index. */
const SYNTH_TASK = {
  report: {
    task: {
      id: 'task-7', skillId: 'boss.collect-resumes', skillVersion: '1.0.0', status: 'partial', terminationReason: 'source_exhausted',
      input: { job: '前端工程师', requestedCount: 2, outputDir: '/tmp/out', source: 'conversations', captureMode: 'available' },
      counts: { requested: 2, browsed: 3, committed: 1, unavailable: 1, failed: 0, ambiguous: 0, diagnostic: 1 },
      account: { platform: 'boss', accountKey: 'hr-zhang', binding: 'explicit' },
      createdAt: '2026-10-04T08:00:00.000Z', updatedAt: '2026-10-04T08:10:00.000Z',
    },
    outputPath: '/tmp/out/task-7',
  },
  artifacts: [
    { id: 'a1', taskId: 'task-7', itemId: 'i1', kind: 'captured_image', path: '/tmp/out/task-7/candidates/c1/captured/resume.png', sha256: 'a'.repeat(64), bytes: 1234, completeness: 'complete', createdAt: '2026-10-04T08:05:00.000Z' },
    { id: 'a2', taskId: 'task-7', itemId: 'i2', kind: 'diagnostic', path: '/tmp/out/task-7/candidates/c2/captured/pages/1.png', sha256: 'b'.repeat(64), bytes: 99, completeness: 'partial_capture', createdAt: '2026-10-04T08:07:00.000Z' },
  ],
};

/** A runtime folder whose entry runs the real runCli over a synthetic TaskControl. */
async function synthRuntime(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'a7-synth-runtime-'));
  const tsx = join(PACKAGE, 'node_modules/tsx/dist/esm/api/index.mjs');
  // One module graph, so the control's RuntimeError is the CLI's RuntimeError.
  await writeFile(join(dir, 'synthetic.mts'), `
import { runCli } from ${JSON.stringify(join(PACKAGE, 'src/cli.ts'))};
import { RuntimeError, type TaskControl } from ${JSON.stringify(join(PACKAGE, 'src/contracts.ts'))};
import { appendFileSync } from 'node:fs';
// Synthetic control for this smoke only: it records, it runs nothing. task-7 is the one known task.
if (process.env.SYNTH_LOG) appendFileSync(process.env.SYNTH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
// A runtime that says ok but fails: the exit status must decide.
if (process.argv[3] === 'task-exit') { process.stdout.write(JSON.stringify({ ok: true, command: process.argv[2], result: { task: { id: 'task-exit' } } }) + '\\n'); process.exit(3); }
const none = async (): Promise<never> => { throw new RuntimeError('not_found', 'none'); };
const known = ${JSON.stringify(SYNTH_TASK)};
const control = {
  submit: async (skillId: string, input: unknown) => ({ taskId: 'synthetic-1', echo: { skillId, input } }),
  status: async (id: string) => { if (id === known.report.task.id) return known.report; throw new RuntimeError('not_found', 'no task ' + id); },
  pause: none, resume: none, cancel: none,
  artifacts: async (id: string) => { if (id === known.report.task.id) return known.artifacts; throw new RuntimeError('not_found', 'no task ' + id); },
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

// The whole path with nothing synthetic but the ledger's folder: MCP → this
// CLI → execv into the installed runtime's own node → a detached worker.
// The socket names no running 2ndscreen and the app named cannot start, so
// the worker can only report that the desktop is unavailable; nothing
// touches a screen.
const INSTALLED = process.env.TASK_RUNTIME_UNDER_TEST;
const skipInstalled = skip || (INSTALLED ? false : 'set TASK_RUNTIME_UNDER_TEST to an installed runtime to run');

test('MCP runs a task through the installed runtime and its background worker', { skip: skipInstalled }, async () => {
  const root = await mkdtemp(join('/tmp', 'a7-mcp-'));
  const env = {
    SECONDSCREEN_TASK_RUNTIME: INSTALLED,
    SECONDSCREEN_NODE: undefined,
    SECONDSCREEN_TASKS_DIR: join(root, 'tasks'),
    SECONDSCREEN_SOCKET: join(root, 'none.sock'),
    // Never the real app, even when the runtime under test sits inside one: no side instance may start.
    SECONDSCREEN_APP: join(root, 'no-such.app'),
  };
  const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const text = (reply: Record<string, any>) => JSON.parse(reply.result.content[0].text.trim());
  const [submitted] = await mcp([call(1, 'task_run', { skill_id: 'boss.collect-resumes', job: '前端工程师', limit: 2, output: join(root, 'out'), account: 'hr-zhang' })], env);
  assert.equal(submitted!.result.isError, false, submitted!.result.content[0].text);
  const taskId: string = text(submitted!).result.taskId;
  // The worker finds no desktop and stops to wait: the task neither runs on blindly nor claims success.
  let task: Record<string, any> = {};
  for (let i = 0; i < 100; i++) {
    const [s] = await mcp([call(2, 'task_status', { task_id: taskId })], env);
    task = text(s!).result.task;
    if (task.status !== 'queued' && task.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(task.account, { platform: 'boss', accountKey: 'hr-zhang', binding: 'explicit' });
  assert.ok(['waiting_user', 'paused'].includes(task.status), JSON.stringify(task));
  assert.equal(task.counts.committed, 0);
  const [cancelled] = await mcp([call(3, 'task_cancel', { task_id: taskId })], env);
  assert.ok(['cancelling', 'cancelled'].includes(text(cancelled!).result.status));
  for (let i = 0; i < 50 && task.status !== 'cancelled'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    task = text((await mcp([call(5, 'task_status', { task_id: taskId })], env))[0]!).result.task;
  }
  assert.equal(task.status, 'cancelled');
  const [artifacts] = await mcp([call(4, 'task_artifacts', { task_id: taskId })], env);
  assert.deepEqual(text(artifacts!).result, []);
  // The linked resources read the same ledger.
  assert.deepEqual(artifacts!.result.content.slice(1).map((c: any) => c.uri), [`2ndscreen://tasks/${taskId}`, `2ndscreen://tasks/${taskId}/artifacts`]);
  const [statusRes, indexRes, unknownRes] = await mcp([
    { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: `2ndscreen://tasks/${taskId}` } },
    { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: `2ndscreen://tasks/${taskId}/artifacts` } },
    { jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: '2ndscreen://tasks/no-such-task' } },
  ], env);
  const read = JSON.parse(statusRes!.result.contents[0].text);
  assert.equal(read.task.id, taskId);
  assert.equal(read.task.status, 'cancelled');
  assert.deepEqual(JSON.parse(indexRes!.result.contents[0].text), []);
  assert.equal(unknownRes!.error.code, -32002);
  // Stop the worker it started.
  const actors = await readdir(join(root, 'tasks', 'actors'));
  for (const name of actors) {
    const pid = Number(name.split('-')[0]);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
});

test('MCP links task resources and reads them through the same task commands, and nothing else', { skip }, async () => {
  const dir = await synthRuntime();
  const root = await mkdtemp(join('/tmp', 'a7-res-'));
  const log = join(root, 'calls.log');
  const env = {
    SECONDSCREEN_TASK_RUNTIME: dir, SECONDSCREEN_NODE: process.execPath, SYNTH_LOG: log,
    // Never a desktop: a socket nobody serves and an app that does not exist.
    SECONDSCREEN_SOCKET: join(root, 'none.sock'), SECONDSCREEN_APP: join(root, 'no-such.app'),
  };
  const init = (version: string) => ({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: version } });
  const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const read = (id: number, uri: unknown) => ({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri } });
  const replies = await mcp([
    init('2025-06-18'),
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call(2, 'task_run', { skill_id: 'boss.collect-resumes', job: '前端', limit: 3, output: '/tmp/out' }),
    call(3, 'task_status', { task_id: 'task-7' }),
    call(4, 'task_artifacts', { task_id: 'task-7' }),
    call(5, 'task_status', { task_id: 'task-9' }),
    read(6, '2ndscreen://tasks/task-7'),
    read(7, '2ndscreen://tasks/task-7/artifacts'),
    read(8, '2ndscreen://tasks/task-9'),
    { jsonrpc: '2.0', id: 9, method: 'resources/templates/list' },
    read(11, '2ndscreen://tasks/task-exit'),
    { jsonrpc: '2.0', id: 10, method: 'resources/list' },
  ], env);
  const byId = new Map(replies.map((r) => [r.id, r]));
  const initialized = byId.get(0)!.result;
  assert.deepEqual(initialized.capabilities.resources, {});
  assert.ok(initialized.capabilities.tools);
  assert.equal(byId.get(1)!.result.tools.length, 14 + 8, 'the old tools are all still there');

  const links = (r: Record<string, any>) => r.result.content.filter((c: any) => c.type === 'resource_link').map((c: any) => [c.uri, c.mimeType]);
  // The existing text payload stays first and unchanged; the links follow it.
  const run = byId.get(2)!.result;
  assert.equal(run.isError, false);
  assert.equal(JSON.parse(run.content[0].text).result.taskId, 'synthetic-1');
  assert.deepEqual(links(byId.get(2)!), [['2ndscreen://tasks/synthetic-1', 'application/json'], ['2ndscreen://tasks/synthetic-1/artifacts', 'application/json']]);
  assert.deepEqual(links(byId.get(3)!), [['2ndscreen://tasks/task-7', 'application/json'], ['2ndscreen://tasks/task-7/artifacts', 'application/json']]);
  assert.deepEqual(links(byId.get(4)!), [['2ndscreen://tasks/task-7', 'application/json'], ['2ndscreen://tasks/task-7/artifacts', 'application/json']]);
  assert.equal(byId.get(5)!.result.isError, true);
  assert.deepEqual(links(byId.get(5)!), [], 'a failed call links nothing');

  // The resources are the runtime's own answers, exactly.
  const status = byId.get(6)!.result.contents;
  assert.equal(status.length, 1);
  assert.equal(status[0].uri, '2ndscreen://tasks/task-7');
  assert.equal(status[0].mimeType, 'application/json');
  assert.deepEqual(JSON.parse(status[0].text), SYNTH_TASK.report);
  const index = byId.get(7)!.result.contents[0];
  assert.equal(index.uri, '2ndscreen://tasks/task-7/artifacts');
  assert.deepEqual(JSON.parse(index.text), SYNTH_TASK.artifacts);
  // A task the ledger does not have is reported as missing, not made up.
  const missing = byId.get(8)!;
  assert.equal(missing.error.code, -32002);
  assert.equal(missing.error.data.uri, '2ndscreen://tasks/task-9');
  assert.equal(missing.error.data.error.code, 'not_found');
  assert.deepEqual(byId.get(9)!.result.resourceTemplates.map((t: any) => t.uriTemplate), ['2ndscreen://tasks/{taskId}', '2ndscreen://tasks/{taskId}/artifacts']);
  assert.deepEqual(byId.get(10)!.result.resources, []);
  const exited = byId.get(11)!;
  assert.equal(exited.result, undefined, 'ok:true with a failing exit status is not a resource');
  assert.equal(exited.error.code, -32603);

  // Only the task commands ran, with the IDs as given.
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.filter((c) => c[0] !== 'run'), [
    ['status', 'task-7'], ['artifacts', 'task-7'], ['status', 'task-9'], ['status', 'task-7'], ['artifacts', 'task-7'], ['status', 'task-9'], ['status', 'task-exit'],
  ]);
});

test('MCP refuses every URI that is not exactly a task or its artifacts, before anything runs', { skip }, async () => {
  const dir = await synthRuntime();
  const root = await mkdtemp(join('/tmp', 'a7-res-'));
  const log = join(root, 'calls.log');
  const env = { SECONDSCREEN_TASK_RUNTIME: dir, SECONDSCREEN_NODE: process.execPath, SYNTH_LOG: log,
    SECONDSCREEN_SOCKET: join(root, 'none.sock'), SECONDSCREEN_APP: join(root, 'no-such.app') };
  const bad: unknown[] = [
    '2ndscreen://tasks/../etc/passwd', '2ndscreen://tasks/task-7/../../x', '2ndscreen://tasks/.hidden', '2ndscreen://tasks/task-7/',
    '2ndscreen://tasks/task-7/artifacts/x', '2ndscreen://tasks/task-7/files', '2ndscreen://tasks/', '2ndscreen://tasks', '2ndscreen://tasks//artifacts',
    '2ndscreen://tasks/task-7?x=1', '2ndscreen://tasks/task-7#a', '2ndscreen://tasks/task%2D7', '2ndscreen://tasks/task 7', '2ndscreen://tasks/-rf',
    '2ndscreen://other/task-7', '2ndscreen://user@tasks/task-7', '2ndscreen://tasks:80/task-7', 'file:///etc/passwd', 'https://tasks/task-7',
    '2NDSCREEN://tasks/task-7', `2ndscreen://tasks/${'a'.repeat(129)}`, 'tasks/task-7', '', 7, null,
    '2ndscreen://tasks/task-7\n', '2ndscreen://tasks/task-7\r', '2ndscreen://tasks/task-7\r\n', '2ndscreen://tasks/task-7/artifacts\n',
    '2ndscreen://tasks/task-7%2Fartifacts', '2ndscreen://tasks/..%2F..%2Fetc', '2ndscreen://tasks/task-7%0A', '2ndscreen://tasks/task\u00e9',
    '2ndscreen://tasks/task-7\\artifacts', '2ndscreen://tasks/task-7/./artifacts', '2ndscreen://tasks/\uff54ask-7',
  ];
  const replies = await mcp(bad.map((uri, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'resources/read', params: { uri } })), env);
  assert.equal(replies.length, bad.length);
  for (const [i, reply] of replies.entries()) {
    assert.equal(reply.error?.code, -32602, `${JSON.stringify(bad[i])}: ${JSON.stringify(reply)}`);
    assert.equal(reply.result, undefined);
  }
  assert.equal(existsSync(log), false, 'the runtime was never started');
});

test('MCP before 2025-06-18 gets the task URIs as text instead of resource_link content', { skip }, async () => {
  const dir = await synthRuntime();
  const root = await mkdtemp(join('/tmp', 'a7-res-'));
  const env = { SECONDSCREEN_TASK_RUNTIME: dir, SECONDSCREEN_NODE: process.execPath,
    SECONDSCREEN_SOCKET: join(root, 'none.sock'), SECONDSCREEN_APP: join(root, 'no-such.app') };
  const [, status] = await mcp([
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_status', arguments: { task_id: 'task-7' } } },
  ], env);
  const content = status!.result.content;
  assert.equal(JSON.parse(content[0].text).result.task.id, 'task-7');
  assert.ok(content.every((c: any) => c.type === 'text'));
  assert.equal(content[1].text, 'resources: 2ndscreen://tasks/task-7 2ndscreen://tasks/task-7/artifacts');
});
