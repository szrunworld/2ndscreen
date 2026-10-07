import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createInboxApprover, createInboxAsker, decide, formatInbox, inboxPaths, listInbox, type InboxPaths } from '../src/agent-inbox.ts';
import type { ApprovalRequest, UserQuestion } from '../src/agent-host.ts';
import { agentDataPaths } from '../src/agent-ledgers.ts';
import { runCli, type AgentViewControl } from '../src/cli.ts';
import { isRuntimeError, type TaskControl } from '../src/contracts.ts';

const run = promisify(execFile);

async function withInbox<T>(fn: (paths: InboxPaths, tasksDir: string) => Promise<T>): Promise<T> {
  const tasksDir = await mkdtemp(join(tmpdir(), 'agent-inbox-'));
  try {
    return await fn(inboxPaths(agentDataPaths(tasksDir).dir), tasksDir);
  } finally {
    await rm(tasksDir, { recursive: true, force: true });
  }
}

const request: ApprovalRequest = {
  agentId: 'remotedesk.boss-recruiter',
  taskId: 't-1',
  approvalId: 'a1',
  effect: 'external-submit',
  summary: '向陈一求简历',
  target: 'cand-1',
  consequences: { application: 'com.zhipin.www', accountKey: 'hr-zhang', usedInWindow: 3, remainingInWindow: 17, msSinceLast: 120_000, targetHadUnknownResult: false, inWorkHours: true },
};
const question: UserQuestion = { agentId: 'remotedesk.boss-recruiter', taskId: 't-1', questionId: 'q1', reason: 'job_ambiguous', message: '两个岗位都叫工程师，选哪个？', choices: ['前端', '后端'] };

const until = async (ok: () => boolean | Promise<boolean>, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let ids = 0;
const newId = () => `e${++ids}`;

test('an approval waits in the inbox until a person decides, and both files are gone afterwards', () =>
  withInbox(async (paths) => {
    const pending: string[] = [];
    const approver = createInboxApprover({ paths, pollMs: 10, newId, onPending: (e) => pending.push(e.id) });
    const decision = approver.request(request, new AbortController().signal);
    await until(() => listInbox(paths).length === 1);
    const [entry] = listInbox(paths);
    assert.equal(entry!.kind, 'approval');
    assert.deepEqual(pending, [entry!.id]);
    assert.equal((await stat(join(paths.pending, `${entry!.id}.json`))).mode & 0o777, 0o600);
    assert.equal((await stat(paths.dir)).mode & 0o777, 0o700);
    decide(paths, entry!.id, { kind: 'approval', decision: 'deny', guidance: { text: '太快', hints: ['too_fast'] } });
    assert.deepEqual(await decision, { decision: 'deny', guidance: { text: '太快', hints: ['too_fast'] } });
    assert.deepEqual(await readdir(paths.pending), []);
    assert.deepEqual(await readdir(paths.answers), []);
  }));

test('a question takes only one of its choices, and an entry is decided once', () =>
  withInbox(async (paths) => {
    const asker = createInboxAsker({ paths, pollMs: 10, newId });
    const answer = asker.ask(question, new AbortController().signal);
    await until(() => listInbox(paths).length === 1);
    const id = listInbox(paths)[0]!.id;
    assert.throws(() => decide(paths, id, { kind: 'question', answer: '运营' }), (e) => isRuntimeError(e, 'invalid_input') && /前端, 后端/.test(e.message));
    assert.throws(() => decide(paths, id, { kind: 'approval', decision: 'grant' }), (e) => isRuntimeError(e, 'invalid_input'));
    decide(paths, id, { kind: 'question', answer: '前端' });
    assert.throws(() => decide(paths, id, { kind: 'question', answer: '后端' }), (e) => isRuntimeError(e, 'conflict'));
    assert.equal(await answer, '前端');
    assert.throws(() => decide(paths, id, { kind: 'question', answer: '前端' }), (e) => isRuntimeError(e, 'not_found'));
    assert.throws(() => decide(paths, '../x', { kind: 'question', answer: 'a' }), (e) => isRuntimeError(e, 'invalid_input'));
  }));

test('giving up on a request takes it out of the inbox', () =>
  withInbox(async (paths) => {
    const controller = new AbortController();
    const approver = createInboxApprover({ paths, pollMs: 10, newId });
    const decision = approver.request(request, controller.signal);
    await until(() => listInbox(paths).length === 1);
    controller.abort();
    await assert.rejects(decision, (e) => isRuntimeError(e, 'cancelled'));
    assert.deepEqual(listInbox(paths), []);
  }));

test('the inbox lists oldest first and shows the consequences the runtime worked out', () =>
  withInbox(async (paths) => {
    const signal = new AbortController().signal;
    let t = Date.parse('2026-10-07T08:00:00Z');
    const clock = { now: () => new Date((t += 1000)) };
    void createInboxApprover({ paths, pollMs: 10, newId: () => 'b-approval', clock }).request(request, signal).catch(() => {});
    void createInboxAsker({ paths, pollMs: 10, newId: () => 'a-question', clock }).ask(question, signal).catch(() => {});
    await until(() => listInbox(paths).length === 2);
    const lines = formatInbox(listInbox(paths));
    assert.equal(lines[0], 'b-approval  审批  remotedesk.boss-recruiter  t-1  向陈一求简历  [com.zhipin.www · hr-zhang · 今日已用 3，剩 17，距上次 120 秒]');
    assert.equal(lines[1], 'a-question  问题  remotedesk.boss-recruiter  t-1  两个岗位都叫工程师，选哪个？（前端 / 后端）');
    assert.deepEqual(formatInbox([]), ['inbox is empty']);
    decide(paths, 'b-approval', { kind: 'approval', decision: 'grant' });
    decide(paths, 'a-question', { kind: 'question', answer: '后端' });
  }));

test('a person decides from another process through the real task command line', () =>
  withInbox(async (paths, tasksDir) => {
    const approver = createInboxApprover({ paths, pollMs: 10, newId: () => 'from-cli' });
    const controller = new AbortController();
    const decision = approver.request(request, controller.signal);
    // Whatever an assertion does, the request must not outlive the test.
    decision.catch(() => {});
    try {
    await until(() => listInbox(paths).length === 1);
    const main = resolve(import.meta.dirname, '../src/main.ts');
    const tsx = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
    const env = { ...process.env, SECONDSCREEN_TASKS_DIR: tasksDir };
    const listed = JSON.parse((await run(tsx, [main, 'inbox'], { env })).stdout);
    assert.equal(listed.result.entries[0].id, 'from-cli');
    const bad = await run(tsx, [main, 'deny', 'from-cli', '--hint', 'because'], { env }).catch((e) => e);
    assert.equal(bad.code, 2, 'an unknown hint is invalid input');
    assert.match(bad.stdout, /not one of/);
    const approved = JSON.parse((await run(tsx, [main, 'approve', 'from-cli'], { env })).stdout);
    assert.deepEqual(approved, { ok: true, command: 'approve', result: { decided: 'from-cli', decision: 'grant' } });
    assert.deepEqual(await decision, { decision: 'grant' });
    } finally {
      controller.abort();
    }
  }));

test('the inbox commands check their words before anything is decided', async () => {
  const calls: unknown[] = [];
  const unused = async () => {
    throw new Error('not used');
  };
  const control = {
    submit: unused, status: unused, pause: unused, resume: unused, cancel: unused, artifacts: unused, inspectProcedure: unused, agents: unused, usage: unused,
    inbox: async () => (calls.push(['inbox']), { entries: [] }),
    approve: async (id: string) => (calls.push(['approve', id]), {}),
    deny: async (id: string, g: unknown) => (calls.push(['deny', id, g]), {}),
    answer: async (id: string, text: string) => (calls.push(['answer', id, text]), {}),
    host: unused, grants: unused, grant: unused, revoke: unused, submitTask: unused, outcome: unused,
  } as unknown as TaskControl & AgentViewControl;
  const cli = async (words: string[]) => {
    const out: string[] = [];
    const code = await runCli(words, { stdout: (l) => out.push(l), stderr: () => {} }, control);
    return { code, json: JSON.parse(out[0]!) };
  };
  assert.equal((await cli(['inbox'])).code, 0);
  assert.equal((await cli(['approve', 'e1'])).code, 0);
  assert.equal((await cli(['deny', 'e2', '--hint', 'too_fast', '--hint', 'not_now', '--text', '明天再说'])).code, 0);
  assert.equal((await cli(['answer', 'e3', '前端', '工程师'])).code, 0);
  assert.deepEqual(calls, [
    ['inbox'],
    ['approve', 'e1'],
    ['deny', 'e2', { hints: ['too_fast', 'not_now'], text: '明天再说' }],
    ['answer', 'e3', '前端 工程师'],
  ]);
  for (const words of [['inbox', 'x'], ['approve'], ['approve', 'e1', 'extra'], ['approve', '../e'], ['deny', 'e1', '--why', 'x'], ['answer', 'e1'], ['answer', 'e1', 'a\u0007b']]) {
    const { code, json } = await cli(words);
    assert.equal(code, 2, words.join(' '));
    assert.equal(json.error.code, 'invalid_input');
  }
  assert.equal(calls.length, 4, 'nothing reached the inbox for bad words');
});

test('grant and revoke words: default effect, mode and a 7-day end; one end at most; bad words reach nothing', async () => {
  const calls: unknown[] = [];
  const unused = async () => {
    throw new Error('not used');
  };
  const control = {
    submit: unused, status: unused, pause: unused, resume: unused, cancel: unused, artifacts: unused, inspectProcedure: unused,
    agents: unused, usage: unused, inbox: unused, approve: unused, deny: unused, answer: unused, host: unused,
    grants: async (id?: string) => (calls.push(['grants', id]), {}),
    grant: async (r: unknown) => (calls.push(['grant', r]), {}),
    revoke: async (r: unknown) => (calls.push(['revoke', r]), {}),
    submitTask: unused, outcome: unused,
  } as unknown as TaskControl & AgentViewControl;
  const cli = async (words: string[]) => {
    const out: string[] = [];
    const code = await runCli(words, { stdout: (l) => out.push(l), stderr: () => {} }, control);
    return { code, json: JSON.parse(out[0]!) };
  };
  const before = Date.now();
  assert.equal((await cli(['grant', 'remotedesk.boss-recruiter', 'com.zhipin.www'])).code, 0);
  const first = (calls[0] as [string, { expiresAt: string }])[1];
  assert.deepEqual({ ...first, expiresAt: undefined }, { agentId: 'remotedesk.boss-recruiter', application: 'com.zhipin.www', effect: 'external-submit', mode: 'human_in_the_loop', expiresAt: undefined });
  const days = (Date.parse(first.expiresAt) - before) / 86_400_000;
  assert.ok(days > 6.99 && days < 7.01, `a default grant ends after 7 days, got ${days}`);
  assert.equal((await cli(['grant', 'a.b', 'com.x', '--mode', 'trusted_within_ceiling', '--durable'])).code, 0);
  assert.deepEqual(calls[1], ['grant', { agentId: 'a.b', application: 'com.x', effect: 'external-submit', mode: 'trusted_within_ceiling', durable: true }]);
  assert.equal((await cli(['grant', 'a.b', 'com.x', '--until', '2026-10-14T18:00:00+08:00'])).code, 0);
  assert.equal((calls[2] as [string, { expiresAt: string }])[1].expiresAt, '2026-10-14T10:00:00.000Z');
  assert.equal((await cli(['revoke', 'a.b', 'com.x', '--effect', 'external-submit'])).code, 0);
  assert.deepEqual(calls[3], ['revoke', { agentId: 'a.b', application: 'com.x', effect: 'external-submit' }]);
  assert.equal((await cli(['grants'])).code, 0);
  for (const words of [
    ['grant', 'a.b'],
    ['grant', 'a.b', 'com.x', '--for', '7 days'],
    ['grant', 'a.b', 'com.x', '--for', '7d', '--durable'],
    ['grant', 'a.b', 'com.x', '--until', 'tomorrow'],
    ['revoke', 'a.b', 'com.x', '--durable'],
    ['grants', 'a', 'b'],
  ]) {
    const { code, json } = await cli(words);
    assert.equal(code, 2, words.join(' '));
    assert.equal(json.error.code, 'invalid_input');
  }
  assert.equal(calls.length, 5, 'nothing reached the config for bad words');
});
