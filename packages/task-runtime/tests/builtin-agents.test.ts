import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateHostConfig } from '../src/agent-config.ts';
import { agentSpecFromTaskSpec } from '../src/agent-contracts.ts';
import { createMemoryEffectLedger } from '../src/agent-host.ts';
import { outcomeOfSkillTask } from '../src/agent-requests.ts';
import { builtinPolicySource, checkedSessionManager } from '../src/builtin-agents.ts';
import { isRuntimeError, type Action, type ActionRequest, type Session, type SessionManager, type TaskRecord, type TaskSpec } from '../src/contracts.ts';
import { loadSkills } from '../src/bootstrap.ts';

const skills = loadSkills(join(import.meta.dirname, '../../../skills'));
const boss = skills.get('boss.collect-resumes')!.spec as TaskSpec;
const BOSS = boss.application;

test('a builtin skill may have an entry in the agent config: builtin:<skill id>', () => {
  const entry = { package: 'builtin:boss.collect-resumes', enabled: true, account: { platform: 'boss', accountKey: 'boss-main' } };
  assert.equal(validateHostConfig({ agents: [entry], providers: {} }).ok, true);
  const bad = validateHostConfig({ agents: [{ ...entry, package: 'builtin:Boss' }], providers: {} });
  assert.equal(bad.ok, false);
  assert.equal(agentSpecFromTaskSpec(boss).id, 'boss.collect-resumes');
  assert.deepEqual(Object.keys(agentSpecFromTaskSpec(boss).tasks), ['collect-resumes']);
});

function fakeSessions(): { manager: SessionManager; sent: ActionRequest[] } {
  const sent: ActionRequest[] = [];
  const manager: SessionManager = {
    async open() {
      return {
        binding: () => ({ screenId: 's', socket: '/tmp/x', launchedByRuntime: false, window: { pid: 1, windowId: 2, bundleId: BOSS, title: 'BOSS', frame: { x: 0, y: 0, width: 1, height: 1 }, contentFrame: { x: 0, y: 0, width: 1, height: 1 }, scale: 2, displayId: 1 } }),
        observe: async () => ({ snapshotId: 'o1' }),
        act: async (q: ActionRequest) => {
          sent.push(q);
          return { actionId: q.actionId, status: 'ok', startedAt: '', finishedAt: '' };
        },
      } as unknown as Session;
    },
  };
  return { manager, sent };
}

const click = (effect: Action['effect']): ActionRequest => ({ actionId: `a-${effect}`, action: { kind: 'click', target: { kind: 'element', role: 'AXButton', label: '下一页' }, effect } }) as ActionRequest;

test('the builtin runner\'s acts pass the check chain with its entry\'s work hours and ceilings, read again when the config changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'builtin-agent-'));
  const config = join(dir, 'config.json');
  const write = (entry: Record<string, unknown>, mtime: number) => {
    writeFileSync(config, JSON.stringify({ agents: [{ package: 'builtin:boss.collect-resumes', enabled: true, account: { platform: 'boss', accountKey: 'boss-main' }, ...entry }], providers: {} }));
    utimesSync(config, mtime, mtime);
  };
  try {
    const { manager, sent } = fakeSessions();
    const ledger = createMemoryEffectLedger();
    const refusals: string[] = [];
    let now = new Date('2026-10-07T03:00:00Z'); // Wednesday 11:00 in Shanghai
    const checked = checkedSessionManager(manager, {
      spec: agentSpecFromTaskSpec(boss),
      policy: builtinPolicySource(config, 'boss.collect-resumes'),
      ledger,
      clock: { now: () => now },
      onRefusal: (r) => refusals.push(r.reason),
    });
    const session = await checked.open({ taskId: 't1', profile: {} as never, takeOver: false, leaseTtlMs: 1000 });

    // No entry: as before, any hour, the manifest's effects only.
    await session.act(click('navigation'));
    await assert.rejects(session.act(click('external-submit')), (e) => isRuntimeError(e, 'permission_missing') && /effect_undeclared/.test(e.message));
    assert.equal((await session.observe()).snapshotId, 'o1', 'the rest of the session is the inner one');

    // Work hours of the entry: outside them the run waits on permission_missing.
    write({ workHours: { timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5], windows: ['09:00-12:00'] } }, 1000);
    await session.act(click('navigation'));
    now = new Date('2026-10-07T05:00:00Z'); // 13:00
    await assert.rejects(session.act(click('navigation')), (e) => isRuntimeError(e, 'permission_missing') && /outside_work_hours/.test(e.message));

    // A ceiling on navigation: counted in the effect ledger, per account.
    write({ ceilings: { user: { navigation: { perDay: 2 } } } }, 2000);
    await session.act(click('navigation'));
    await session.act(click('navigation'));
    await assert.rejects(session.act(click('navigation')), (e) => isRuntimeError(e, 'permission_missing') && /quota_exhausted/.test(e.message));
    assert.deepEqual(ledger.all.map((u) => [u.agentId, u.accountKey, u.effect]), [
      ['boss.collect-resumes', 'boss-main', 'navigation'],
      ['boss.collect-resumes', 'boss-main', 'navigation'],
    ]);

    // A config that does not validate keeps the last good policy.
    writeFileSync(config, '{ not json');
    utimesSync(config, 3000, 3000);
    await assert.rejects(session.act(click('navigation')), (e) => isRuntimeError(e, 'permission_missing'));
    assert.equal(sent.filter((q) => q.action.effect === 'navigation').length, 4);
    assert.deepEqual(refusals, ['effect_undeclared', 'outside_work_hours', 'quota_exhausted', 'quota_exhausted']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a builtin task reads like an agent task\'s outcome, with its own status and counts', () => {
  const task = {
    id: 'b1',
    skillId: 'boss.collect-resumes',
    skillVersion: '1.0.0',
    input: {},
    status: 'waiting_user',
    waitReason: 'login_required',
    counts: { delivered: 1 },
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:05:00Z',
    error: { code: 'login_required', message: 'log in' },
  } as unknown as TaskRecord;
  const o = outcomeOfSkillTask(task, '/out/b1');
  assert.deepEqual(
    [o.agentId, o.taskType, o.state, o.endedAt, o.failure, o.builtin?.waitReason, o.builtin?.outputPath],
    ['boss.collect-resumes', 'collect-resumes', 'waiting_user', undefined, 'login_required', 'login_required', '/out/b1'],
  );
  assert.equal(outcomeOfSkillTask({ ...task, status: 'succeeded' } as TaskRecord).endedAt, '2026-10-07T00:05:00Z');
  assert.equal(outcomeOfSkillTask({ ...task, status: 'cancelling' } as TaskRecord).state, 'running');
});
