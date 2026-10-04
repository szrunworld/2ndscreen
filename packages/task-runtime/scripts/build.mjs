// Builds the task runtime as it ships inside 2ndscreen.app
// (Contents/Resources/task-runtime): two self-contained ES modules for the
// bundled Node, with every import — this package, the BOSS workflow under
// agents/boss/src/resumes and its parsers — compiled in, and the skills.
// Nothing is loaded from node_modules, npx or the working directory at run
// time; Node's built-ins (node:sqlite among them) are the only imports left.
//
//   node scripts/build.mjs [OUT_DIR]      default dist/task-runtime
//
// OUT_DIR gets main.mjs (the `2ndscreen task` command line), worker.mjs (the
// background daemon), skills/ and build.json. bin/node is added by
// scripts/install-task-runtime.sh at the repository root.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repo = resolve(pkg, '../..');
const out = resolve(process.argv[2] ?? join(pkg, 'dist/task-runtime'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { main: join(pkg, 'src/main.ts'), worker: join(pkg, 'src/worker.ts') },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  // Everything but Node's built-ins is compiled in.
  packages: 'bundle',
  external: ['node:*'],
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
  banner: { js: '// 2ndscreen task runtime, built by packages/task-runtime/scripts/build.mjs' },
});

const skills = join(repo, 'skills');
for (const name of readdirSync(skills)) {
  if (existsSync(join(skills, name, 'task.json'))) cpSync(join(skills, name), join(out, 'skills', name), { recursive: true });
}

/** Every file with its size and sha256, so an install can be checked against its build. */
function files(dir) {
  const list = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) list.push(...files(path));
    else list.push({ path: relative(out, path), bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  }
  return list;
}
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
writeFileSync(
  join(out, 'build.json'),
  JSON.stringify({ name: manifest.name, version: manifest.version, node: manifest.engines.node, files: files(out) }, null, 2) + '\n',
);
console.log(`built ${relative(process.cwd(), out) || out}`);
