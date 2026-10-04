import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLI_COMMANDS, RUN_DEFAULTS, runCli } from '../src/cli.ts';
import {
  RuntimeError,
  emptyUsage,
  validateTaskSpec,
  type ArtifactRecord,
  type CollectResumesInput,
  type ProcedureV2,
  type TaskControl,
  type TaskRecord,
} from '../src/contracts.ts';

// A synthetic TaskControl: it records every call and answers from fixtures,
// so no ledger, worker, screen, model or BOSS is involved.

type Call = { method: keyof TaskControl; args: unknown[] };

const TASK: TaskRecord = {
  id: 'task-1',
  skillId: 'boss.collect-resumes',
  skillVersion: '1.0.0',
  input: { job: '前端工程师', requestedCount: 2, outputDir: '/tmp/out', source: 'conversations', captureMode: 'available' },
  status: 'running',
  counts: { requested: 2, browsed: 0, committed: 0, unavailable: 0, failed: 0, ambiguous: 0, diagnostic: 0 },
  createdAt: '2026-10-04T08:00:00.000Z',
  updatedAt: '2026-10-04T08:00:00.000Z',
};

function fakeControl(overrides: Partial<Record<keyof TaskControl, (...args: never[]) => Promise<unknown>>> = {}) {
  const calls: Call[] = [];
  const answer = {
    submit: async () => ({ taskId: 'task-1' }),
    status: async () => ({ task: TASK, usage: emptyUsage(), outputPath: '/tmp/out/task-1' }),
    pause: async () => ({ ...TASK, status: 'paused' }),
    resume: async () => ({ ...TASK, status: 'running' }),
    cancel: async () => ({ ...TASK, status: 'cancelling' }),
    artifacts: async () => [] as ArtifactRecord[],
    inspectProcedure: async () => undefined as ProcedureV2 | undefined,
    ...overrides,
  } as Record<keyof TaskControl, (...args: unknown[]) => Promise<unknown>>;
  // A Proxy so that any method outside TaskControl (or any property read
  // at all, such as a model or env handle) shows up in the record.
  const touched: string[] = [];
  const control = new Proxy({} as TaskControl, {
    get(_t, name: string) {
      touched.push(name);
      const fn = answer[name as keyof TaskControl];
      if (!fn) return undefined;
      return (...args: unknown[]) => {
        calls.push({ method: name as keyof TaskControl, args });
        return fn(...args);
      };
    },
  });
  return { control, calls, touched };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) }, out, err };
}

async function cli(argv: string[], control = fakeControl()) {
  const { io, out, err } = capture();
  const code = await runCli(argv, io, control.control);
  assert.equal(out.length, 1, `exactly one stdout line for ${argv.join(' ')}`);
  assert.equal(err.length, 0, 'nothing on stderr');
  assert.ok(!out[0]!.includes('\n'), 'a single line');
  return { code, json: JSON.parse(out[0]!) as Record<string, any>, calls: control.calls, touched: control.touched };
}

const RUN = ['run', 'boss.collect-resumes', '--job', '前端工程师', '--limit', '20', '--output', '/Users/x/招聘/前端'];

test('run builds the contract input and submits it once', async () => {
  const { code, json, calls, touched } = await cli([...RUN, '--browse-limit', '40', '--deadline', '2999-01-01T00:00:00Z',
    '--budget', 'taskModelCalls=0', '--budget', 'taskTokens=5000', '--take-over', '--keep-window', '--analysis', 'off', '--mode', 'original-only']);
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, command: 'run', result: { taskId: 'task-1' } });
  assert.deepEqual(touched, ['submit']);
  assert.equal(calls.length, 1);
  const [skill, input] = calls[0]!.args as [string, CollectResumesInput];
  assert.equal(skill, 'boss.collect-resumes');
  assert.deepEqual(input, {
    job: '前端工程师', requestedCount: 20, outputDir: '/Users/x/招聘/前端', source: 'conversations', captureMode: 'original-only',
    browseLimit: 40, deadline: '2999-01-01T00:00:00Z', budget: { taskModelCalls: 0, taskTokens: 5000 },
    analysis: 'off', takeOver: true, keepWindow: true,
  });
});

test('run defaults source and mode, and leaves optional fields out', async () => {
  const { code, calls } = await cli(RUN);
  assert.equal(code, 0);
  assert.deepEqual(calls[0]!.args[1], { job: '前端工程师', requestedCount: 20, outputDir: '/Users/x/招聘/前端', ...RUN_DEFAULTS });
});

test('the run defaults match the skill package', async () => {
  const spec = JSON.parse(await readFile(new URL('../../../skills/boss-resumes/task.json', import.meta.url), 'utf8'));
  assert.ok(validateTaskSpec(spec).ok);
  assert.equal(RUN_DEFAULTS.captureMode, spec.defaults.captureMode);
});

test('each command routes to its one TaskControl method', async () => {
  const procedure = { schemaVersion: 2, id: 'proc-1' } as unknown as ProcedureV2;
  const control = fakeControl({ inspectProcedure: async () => procedure });
  const expect: Array<[string[], keyof TaskControl, string]> = [
    [['status', 'task-1'], 'status', 'task-1'],
    [['pause', 'task-1'], 'pause', 'task-1'],
    [['resume', 'task-1'], 'resume', 'task-1'],
    [['cancel', 'task-1'], 'cancel', 'task-1'],
    [['artifacts', 'task-1'], 'artifacts', 'task-1'],
    [['inspect-procedure', 'proc-1'], 'inspectProcedure', 'proc-1'],
  ];
  for (const [argv, method, id] of expect) {
    control.calls.length = 0;
    control.touched.length = 0;
    const { code, json } = await cli(argv, control);
    assert.equal(code, 0, argv.join(' '));
    assert.equal(json.ok, true);
    assert.equal(json.command, argv[0]);
    assert.deepEqual(control.calls, [{ method, args: [id] }]);
    assert.deepEqual(control.touched, [method]);
  }
  const status = await cli(['status', 'task-1']);
  assert.equal(status.json.result.task.status, 'running');
  assert.equal(status.json.result.outputPath, '/tmp/out/task-1');
  assert.deepEqual((await cli(['artifacts', 'task-1'])).json.result, []);
  assert.deepEqual((await cli(['inspect-procedure', 'proc-1'], control)).json.result, procedure);
  assert.deepEqual(CLI_COMMANDS, ['run', 'status', 'pause', 'resume', 'cancel', 'artifacts', 'inspect-procedure', 'bind-account']);
});

test('--account binds the named account at submit, as explicit, and nothing else does', async () => {
  const bindAccount = async () => TASK;
  const control = fakeControl({ bindAccount } as never);
  const { code, json, calls } = await cli([...RUN, '--account', 'hr-zhang.2'], control);
  assert.equal(code, 0);
  assert.deepEqual(json.result, { taskId: 'task-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'submit');
  assert.deepEqual(calls[0]!.args[2], { account: { platform: 'boss', accountKey: 'hr-zhang.2', binding: 'explicit' } });
  // Without --account the contract's two-argument submit is used, and no account is made up.
  const plain = fakeControl({ bindAccount } as never);
  await cli(RUN, plain);
  assert.equal(plain.calls[0]!.args.length, 2);
});

test('an account the control cannot bind is refused, never dropped', async () => {
  const control = fakeControl();
  const { code, json, calls } = await cli([...RUN, '--account', 'hr-zhang'], control);
  assert.equal(code, 1);
  assert.equal(json.error.code, 'capability_missing');
  assert.deepEqual(calls, []);
});

test('bind-account names the account for a waiting task; bad keys never reach the control', async () => {
  const control = fakeControl({ bindAccount: async () => ({ ...TASK, status: 'waiting_user' }) } as never);
  const ok = await cli(['bind-account', 'task-1', 'hr_zhang'], control);
  assert.equal(ok.code, 0);
  assert.equal(ok.json.command, 'bind-account');
  assert.deepEqual(control.calls, [{ method: 'bindAccount', args: ['task-1', { platform: 'boss', accountKey: 'hr_zhang', binding: 'explicit' }] }]);
  for (const argv of [['bind-account', 'task-1'], ['bind-account', 'task-1', 'a:b'], ['bind-account', 'task-1', 'a/b'], ['bind-account', 'task-1', '-x'],
    ['bind-account', 'task-1', 'x'.repeat(65)], [...RUN, '--account', 'acct:1'], [...RUN, '--account']]) {
    control.calls.length = 0;
    const bad = await cli(argv, control);
    assert.equal(bad.code, 2, argv.join(' '));
    assert.equal(bad.json.error.code, 'invalid_input');
    assert.deepEqual(control.calls, []);
  }
});

test('invalid words fail with code 2, one JSON line, and never reach the control', async () => {
  const bad: Array<[string[], RegExp]> = [
    [[], /a command is required/],
    [['start', 'x'], /unknown command "start"/],
    [['status'], /exactly one TASK_ID/],
    [['status', 'a', 'b'], /exactly one TASK_ID/],
    [['status', '../etc'], /TASK_ID must be/],
    [['status', 'x'.repeat(129)], /TASK_ID must be/],
    [['inspect-procedure', ''], /PROCEDURE_ID must be/],
    [['run'], /needs a SKILL_ID.*--job.*--limit.*--output/],
    [['run', 'a', 'b', '--job', 'x', '--limit', '1', '--output', '/o'], /one SKILL_ID, got 2/],
    [['run', 'bad/skill', '--job', 'x', '--limit', '1', '--output', '/o'], /SKILL_ID must be/],
    [[...RUN, '--limit', '3'], /--limit is given twice/],
    [[...RUN, '--take-over', '--take-over'], /--take-over is given twice/],
    [[...RUN, '--jobs', 'x'], /unknown option "--jobs"/],
    [[...RUN, '--mode=available'], /as two words/],
    [[...RUN, '--source'], /--source needs a value/],
    [['run', 'boss.collect-resumes', '--job', '--limit', '3', '--output', '/o'], /--job needs a value/],
    [[...RUN, '--mode', 'all'], /--mode must be one of/],
    [[...RUN, '--source', 'everything'], /--source must be one of/],
    [[...RUN, '--analysis', 'yes'], /--analysis must be one of/],
    [['run', 's', '--job', ' ', '--limit', '1', '--output', '/o'], /--job must not be empty/],
    [['run', 's', '--job', 'a\nb', '--limit', '1', '--output', '/o'], /control characters/],
    [['run', 's', '--job', 'x'.repeat(201), '--limit', '1', '--output', '/o'], /at most 200/],
    [['run', 's', '--job', 'x', '--limit', '1', '--output', 'relative/dir'], /outputDir must be an absolute path/],
    [['run', 's', '--job', 'x', '--limit', '1', '--output', '~/out'], /outputDir must be an absolute path/],
    [['run', 's', '--job', 'x', '--limit', '1', '--output', '/o\u0000x'], /control characters/],
  ];
  for (const [argv, message] of bad) {
    const control = fakeControl();
    const { code, json } = await cli(argv, control);
    assert.equal(code, 2, argv.join(' '));
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'invalid_input');
    assert.match(json.error.message, message, argv.join(' '));
    assert.deepEqual(control.touched, [], `no control call for ${argv.join(' ')}`);
  }
});

test('numbers must be plain, finite, bounded digits', async () => {
  const numbers = ['0', '-1', '1.5', '1e3', '0x10', ' 5', '5 ', '+5', '05', 'NaN', 'Infinity', '10001', '99999999999999999999', '٣'];
  for (const n of numbers) {
    const control = fakeControl();
    const { code, json } = await cli(['run', 's', '--job', 'x', '--limit', n, '--output', '/o'], control);
    assert.equal(code, 2, `--limit ${JSON.stringify(n)}`);
    assert.match(json.error.message, /--limit/);
    assert.deepEqual(control.touched, []);
  }
  for (const b of ['taskModelCalls=-1', 'taskModelCalls=1.0', 'taskModelCalls=', 'taskModelCalls', 'model=3', 'taskModelCalls=1e9', '=3']) {
    const { code, json } = await cli([...RUN, '--budget', b]);
    assert.equal(code, 2, `--budget ${b}`);
    assert.match(json.error.message, /--budget/);
  }
  const twice = await cli([...RUN, '--budget', 'taskModelCalls=1', '--budget', 'taskModelCalls=2']);
  assert.match(twice.json.error.message, /taskModelCalls is given twice/);
  const below = await cli([...RUN, '--browse-limit', '5']);
  assert.match(below.json.error.message, /browseLimit must not be below requestedCount/);
  assert.equal((await cli(['run', 's', '--job', 'x', '--limit', '10000', '--output', '/o'])).code, 0);
});

test('deadlines need a zone and must be in the future', async () => {
  for (const d of ['2999-01-01', '2999-01-01T00:00:00', 'tomorrow', '2999-13-01T00:00:00Z']) {
    const { code, json } = await cli([...RUN, '--deadline', d]);
    assert.equal(code, 2, d);
    assert.match(json.error.message, /deadline/);
  }
  const past = await cli([...RUN, '--deadline', '2000-01-01T00:00:00+08:00']);
  assert.match(past.json.error.message, /deadline is already past/);
  assert.equal((await cli([...RUN, '--deadline', '2999-01-01T08:00:00+08:00'])).code, 0);
});

test('every problem of a run is listed at once', async () => {
  const { json } = await cli(['run', 's', '--limit', 'x', '--mode', 'all', '--bogus']);
  const errors: string[] = json.error.details.errors;
  for (const part of ['unknown option "--bogus"', '--limit must be', '--mode must be', 'run needs --job', 'run needs --output'])
    assert.ok(errors.some((e) => e.includes(part)), part);
});

test('runtime errors keep their code; not_found and others exit 1', async () => {
  const control = fakeControl({
    status: async () => { throw new RuntimeError('not_found', 'no task task-9'); },
    cancel: async () => { throw new RuntimeError('conflict', 'task already succeeded', { status: 'succeeded' }); },
    submit: async () => { throw new RuntimeError('lease_held', 'another task holds com.zhipin.www:*'); },
    pause: async () => { throw new TypeError('boom'); },
  });
  const status = await cli(['status', 'task-9'], control);
  assert.equal(status.code, 1);
  assert.deepEqual(status.json, { ok: false, command: 'status', error: { code: 'not_found', message: 'no task task-9' } });
  const cancel = await cli(['cancel', 'task-1'], control);
  assert.deepEqual(cancel.json.error, { code: 'conflict', message: 'task already succeeded', details: { status: 'succeeded' } });
  assert.equal((await cli(RUN, control)).json.error.code, 'lease_held');
  const pause = await cli(['pause', 'task-1'], control);
  assert.equal(pause.code, 1);
  assert.deepEqual(pause.json.error, { code: 'internal', message: 'boom' });
  const proc = await cli(['inspect-procedure', 'proc-x']);
  assert.equal(proc.code, 1);
  assert.equal(proc.json.error.code, 'not_found');
  // A control-side invalid_input is a usage problem too.
  const invalid = await cli(['resume', 'task-1'], fakeControl({ resume: async () => { throw new RuntimeError('invalid_input', 'unknown skill'); } }));
  assert.equal(invalid.code, 2);
});

test('a result that cannot be JSON is an internal error, still one line', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const { code, json } = await cli(['status', 'task-1'], fakeControl({ status: async () => cyclic }));
  assert.equal(code, 1);
  assert.equal(json.error.code, 'internal');
  const big = await cli(['artifacts', 'task-1'], fakeControl({ artifacts: async () => [{ size: 10n }] }));
  assert.equal(big.json.error.code, 'internal');
});

test('help is one JSON line naming every command', async () => {
  for (const h of ['help', '--help', '-h']) {
    const { code, json, touched } = await cli([h]);
    assert.equal(code, 0);
    assert.equal(json.command, 'help');
    for (const c of CLI_COMMANDS) assert.ok(json.result.usage.includes(`task ${c}`), c);
    assert.deepEqual(touched, []);
  }
  for (const argv of [['status', '--help'], ['run', '-h'], [...RUN, '--help']]) {
    const { code, json, touched } = await cli(argv);
    assert.equal(code, 0, argv.join(' '));
    assert.equal(json.command, 'help');
    assert.deepEqual(touched, [], 'help never acts');
  }
  // As a value it is just text: a job called "-h" is submitted like any other.
  const job = await cli(['run', 's', '--job', '-h', '--limit', '1', '--output', '/o']);
  assert.equal(job.code, 0);
  assert.deepEqual(job.touched, ['submit']);
});

test('the CLI module imports only the contracts and uses no model, env or process', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./contracts.ts']);
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['process.', 'ARK_', 'fetch(', 'require(', 'import(', 'child_process', 'Explorer', 'Bridge', 'Model'])
    assert.ok(!code.includes(banned), `cli.ts must not use ${banned}`);
});
