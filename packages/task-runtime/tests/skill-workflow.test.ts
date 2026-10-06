import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillWorkflow, loadSkills } from '../src/bootstrap.ts';
import { RuntimeError, isRuntimeError, validateTaskSpec } from '../src/contracts.ts';

// A skill may ship its own workflow as an ES module inside its directory
// (task.json workflowModule); the worker imports it, the command line never does.

const BOSS = new URL('../../../skills/boss-resumes/', import.meta.url).pathname;

/** A copy of the BOSS skill under a fresh skills dir, with task.json changed by `patch`. */
function skillsWith(patch: Record<string, unknown>, files: Record<string, string> = {}): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'skills-'));
  const dir = join(root, 'own');
  cpSync(BOSS, dir, { recursive: true });
  const spec = { ...JSON.parse(readFileSync(join(BOSS, 'task.json'), 'utf8')), id: 'own.collect', ...patch };
  writeFileSync(join(dir, 'task.json'), JSON.stringify(spec));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { root, dir };
}

const WORKFLOW = `
export function createWorkflow(deps) {
  const fn = () => undefined;
  return { id: deps.spec.workflow, units: {}, skillDir: deps.skillDir,
    classifyPage: fn, readAccount: fn, listCandidates: fn, identify: fn, verifyUnit: fn, runScripted: fn, acquireResume: fn };
}`;

test('workflowModule must stay a relative module path inside the skill', () => {
  const base = JSON.parse(readFileSync(join(BOSS, 'task.json'), 'utf8'));
  for (const bad of ['/abs/w.mjs', '../w.mjs', 'a/../../w.mjs', 'w.ts', '']) {
    const r = validateTaskSpec({ ...base, workflowModule: bad });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(validateTaskSpec({ ...base, workflowModule: 'dist/workflow.mjs' }).ok, true);
});

test('a skill with its own workflow loads, and the worker gets that workflow', async () => {
  const { root, dir } = skillsWith({ workflow: 'own-v1', workflowModule: 'dist/workflow.mjs' }, { 'dist/workflow.mjs': WORKFLOW });
  try {
    const skill = loadSkills(root).get('own.collect');
    assert.ok(skill);
    assert.equal(skill.workflowModule, join(dir, 'dist/workflow.mjs'));
    const workflow = (await createSkillWorkflow(skill, {})) as unknown as { id: string; skillDir: string };
    assert.equal(workflow.id, 'own-v1');
    assert.equal(workflow.skillDir, dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown workflow without a module is refused at load', () => {
  const { root } = skillsWith({ workflow: 'own-v1' });
  try {
    assert.throws(() => loadSkills(root), (e) => isRuntimeError(e, 'capability_missing') && /ships no workflowModule/.test(e.message));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing module, or one that leads outside the skill by a symlink, is refused at load', () => {
  const missing = skillsWith({ workflow: 'own-v1', workflowModule: 'dist/workflow.mjs' });
  const outside = skillsWith({ workflow: 'own-v1', workflowModule: 'dist/workflow.mjs' });
  const elsewhere = join(outside.root, 'elsewhere.mjs');
  writeFileSync(elsewhere, WORKFLOW);
  mkdirSync(join(outside.dir, 'dist'));
  symlinkSync(elsewhere, join(outside.dir, 'dist/workflow.mjs'));
  try {
    assert.throws(() => loadSkills(missing.root), (e) => isRuntimeError(e, 'capability_missing') && /missing/.test(e.message));
    assert.throws(() => loadSkills(outside.root), (e) => isRuntimeError(e, 'invalid_input') && /outside the skill/.test(e.message));
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
    rmSync(outside.root, { recursive: true, force: true });
  }
});

test('a module that does not implement the named workflow is refused when the worker loads it', async () => {
  const cases: Array<[string, RegExp]> = [
    ['export const nothing = 1;', /does not export createWorkflow/],
    ['export function createWorkflow() { return { id: "other-v1", units: {} }; }', /implements other-v1/],
    ['export function createWorkflow(d) { return { id: d.spec.workflow, units: {} }; }', /missing classifyPage/],
    ['throw new Error("boom");', /could not load: boom/],
  ];
  for (const [text, expected] of cases) {
    const { root } = skillsWith({ workflow: 'own-v1', workflowModule: 'w.mjs' }, { 'w.mjs': text });
    try {
      const skill = loadSkills(root).get('own.collect')!;
      await assert.rejects(createSkillWorkflow(skill, {}), (e) => isRuntimeError(e) && expected.test(e.message), text);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the built-in BOSS workflow is still what boss-resumes gets', async () => {
  const skills = loadSkills(new URL('../../../skills/', import.meta.url).pathname);
  const workflow = await createSkillWorkflow(skills.get('boss.collect-resumes')!, {});
  assert.equal(workflow.id, 'boss-resumes-v1');
});

test('a RuntimeError from another copy of the contracts is still recognised', () => {
  const brand = Symbol.for('2ndscreen.task-runtime.RuntimeError');
  const foreign = Object.assign(new Error('from a skill bundle'), { name: 'RuntimeError', code: 'invalid_input', [brand]: true });
  assert.ok(isRuntimeError(foreign));
  assert.ok(isRuntimeError(foreign, 'invalid_input'));
  assert.ok(!isRuntimeError(foreign, 'cancelled'));
  assert.ok(!isRuntimeError(new Error('plain')));
  assert.ok(isRuntimeError(new RuntimeError('cancelled', 'own')));
});
