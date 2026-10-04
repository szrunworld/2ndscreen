import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { CLI_COMMANDS } from '../src/cli.ts';
import { BOSS_UNITS, validateProcedure, validateTaskSpec, type Action, type ProcedureV2, type TaskSpec } from '../src/contracts.ts';
import { BOSS_RESUME_UNITS } from '../../../agents/boss/src/resumes/workflow.ts';

// skills/boss-resumes is the package the runtime loads: every machine file
// must pass the contract validators and agree with the others.

const SKILL = new URL('../../../skills/boss-resumes/', import.meta.url);
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, SKILL), 'utf8'));

async function spec(): Promise<TaskSpec> {
  const result = validateTaskSpec(await json('task.json'));
  assert.ok(result.ok, result.ok ? '' : result.errors.join('; '));
  return result.value;
}

test('task.json is a valid, read-only spec', async () => {
  const s = await spec();
  assert.equal(s.id, 'boss.collect-resumes');
  assert.equal(s.application, 'com.zhipin.www');
  assert.equal(s.workflow, 'boss-resumes-v1');
  assert.equal(s.inputSchema, 'collect-resumes-input-v1');
  assert.equal(s.submitAllowed, false);
  assert.equal(s.foregroundAllowed, false);
  assert.equal(s.learning.promoteAfterSuccesses, 3);
  assert.deepEqual(s.defaults, { captureMode: 'available', analysis: 'off' });
  assert.ok(!s.capabilities.some((c) => /submit|send|message|greet|request/i.test(c)), 'no sending capability');
  const known = new Set(['schemaVersion', 'id', 'version', 'platforms', 'application', 'windowProfile', 'workflow', 'inputSchema',
    'capabilities', 'submitAllowed', 'foregroundAllowed', 'learning', 'defaults']);
  assert.deepEqual(Object.keys(s).filter((k) => !known.has(k)), [], 'no fields outside TaskSpec');
});

test('the window profile matches the spec and the WindowProfile shape', async () => {
  const s = await spec();
  const entries = await readdir(new URL('profiles/macos/', SKILL));
  assert.deepEqual(entries, [`${s.windowProfile}.json`]);
  const p = (await json(`profiles/macos/${s.windowProfile}.json`)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(p).sort(), ['bundleId', 'id', 'logicalHeight', 'logicalWidth', 'version']);
  assert.equal(p.id, s.windowProfile);
  assert.equal(p.bundleId, s.application);
  for (const k of ['version', 'logicalWidth', 'logicalHeight']) assert.ok(Number.isInteger(p[k]) && (p[k] as number) >= 1, k);
  assert.deepEqual([p.logicalWidth, p.logicalHeight], [1440, 900]);
  // appVersion, locale, content frame and scale are measured at bind time, never assumed.
  assert.ok(!('appVersion' in p) && !('scale' in p));
});

test('procedure seeds are valid, seeded, safe and keyed to this skill', async () => {
  const s = await spec();
  const files = (await readdir(new URL('procedures/', SKILL))).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1);
  const ids = new Set<string>();
  for (const file of files) {
    const raw = await json(`procedures/${file}`);
    const result = validateProcedure(raw, { submitAllowed: false });
    assert.ok(result.ok, `${file}: ${result.ok ? '' : result.errors.join('; ')}`);
    const p: ProcedureV2 = result.value;
    assert.equal(file, `${p.key.unit}.seed.json`);
    assert.ok(!ids.has(p.id), `${p.id} repeated`);
    ids.add(p.id);
    assert.equal(p.status, 'seeded');
    assert.equal(p.source, 'seed');
    assert.equal(p.version, 1);
    assert.equal(p.parentVersion, undefined);
    assert.deepEqual(p.counters, { successes: 0, failures: 0, successItemIds: [], consecutiveFailures: 0 });
    assert.equal(p.key.skill, s.id);
    assert.equal(p.key.skillVersion, s.version);
    assert.equal(p.key.profile, s.windowProfile);
    assert.ok((BOSS_UNITS as readonly string[]).includes(p.key.unit));
    const unit = BOSS_RESUME_UNITS[p.key.unit as keyof typeof BOSS_RESUME_UNITS];
    assert.ok(unit.learnable, `${p.key.unit} is learnable`);
    for (const step of p.steps) {
      const action: Action = step.action;
      assert.ok(unit.allowedEffects.includes(action.effect), `${file}/${step.id}: ${action.effect} not allowed`);
      assert.ok(action.effect === 'read' || action.effect === 'navigation', `${file}/${step.id}: seeds only read or navigate`);
      if (action.kind === 'type') assert.fail('seeds never type');
      if (action.kind === 'key') assert.ok(!['return', 'enter', 'kpenter'].includes(action.key.toLowerCase()), 'no Enter');
      const labels = JSON.stringify([action, step.fallbacks ?? []]);
      assert.ok(!/发送|打招呼|索取|求简历|交换|沟通|确认|确定|同意|举报|send|submit|confirm/i.test(labels), `${file}/${step.id} targets no submit control`);
    }
    // A seed may only claim what the workflow's own unit checks.
    assert.deepEqual(p.postconditions, unit.postconditions, `${file} postconditions`);
  }
});

test('SKILL.md has valid front matter and names only real commands', async () => {
  const s = await spec();
  const text = await readFile(new URL('SKILL.md', SKILL), 'utf8');
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
  assert.ok(front, 'front matter with name and description');
  assert.equal(front[1], 'boss-resumes');
  assert.ok(front[2]!.length > 40 && front[2]!.length <= 1024);
  assert.ok(text.includes(`task run ${s.id}`));
  for (const used of text.matchAll(/2ndscreen task ([a-z-]+)/g)) assert.ok((CLI_COMMANDS as readonly string[]).includes(used[1]!), used[1]);
  for (const c of CLI_COMMANDS) assert.ok(text.includes(`task_${c.replace('-', '_')}`), `MCP tool for ${c}`);
  // Honest about what is not supported.
  assert.match(text, /recommend.*capability_missing/);
  assert.match(text, /original-only.*capability_missing/);
  assert.ok(!/npx/.test(text.replace(/不要尝试用 npx/, '')), 'never tells the agent to use npx');
});
