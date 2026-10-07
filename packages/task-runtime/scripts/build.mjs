// Builds the task runtime as it ships inside an app
// (Contents/Resources/task-runtime): two self-contained ES modules for the
// bundled Node, with every import compiled in. Nothing is loaded from
// node_modules, npx or the working directory at run time; Node's built-ins
// (node:sqlite among them) are the only imports left.
//
//   node scripts/build.mjs [OUT_DIR] [--generic | --legacy]     default dist/task-runtime, --legacy
//
// Two variants (build.json says which):
//   --legacy   as 2ndscreen.app ships it: the BOSS workflow and its parsers
//              under src/boss compiled in, and the skills copied beside.
//   --generic  the generic runtime a product ships (roadmap C01b): no
//              module under src/boss is in the bundle (every import of one
//              is replaced by an empty module and the build fails if the
//              dependency graph still reaches one), and no skills directory.
//              The runtime then registers no workflow and runs no business
//              task until a business package is installed beside it.
//
// OUT_DIR gets main.mjs (the `2ndscreen task` command line), worker.mjs (the
// background daemon, which also hosts the agents), skills/ (legacy only) and
// build.json. bin/node is added by scripts/install-task-runtime.sh at the
// repository root.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repo = resolve(pkg, '../..');
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const flag of flags) if (flag !== '--generic' && flag !== '--legacy') throw new Error(`unknown option ${flag}`);
if (flags.includes('--generic') && flags.includes('--legacy')) throw new Error('--generic and --legacy exclude each other');
const variant = flags.includes('--generic') ? 'generic' : 'legacy';
const out = resolve(positional[0] ?? join(pkg, 'dist/task-runtime'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** Imports of business modules the generic build replaced, importer → module. */
const excluded = [];
const BUSINESS = /(^|\/)boss\/[^/]+\.ts$/;
const noBusinessPackage = {
  name: 'no-business-package',
  setup(b) {
    b.onResolve({ filter: BUSINESS }, (args) => {
      excluded.push({ from: relative(pkg, args.importer), module: args.path });
      return { path: args.path, namespace: 'business-excluded' };
    });
    b.onLoad({ filter: /.*/, namespace: 'business-excluded' }, () => ({ contents: 'export {};', loader: 'js' }));
  },
};

const result = await build({
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
  metafile: true,
  plugins: variant === 'generic' ? [noBusinessPackage] : [],
  banner: { js: `// 2ndscreen task runtime (${variant}), built by packages/task-runtime/scripts/build.mjs` },
});

// What the bundles are made of, as evidence: a generic build reaches no business module.
const inputs = Object.keys(result.metafile.inputs)
  .map((p) => relative(pkg, resolve(pkg, p)))
  .sort();
const business = inputs.filter((p) => p.startsWith('src/boss/'));
if (variant === 'generic' && business.length) throw new Error(`the generic build still contains business modules: ${business.join(', ')}`);
if (variant === 'generic' && excluded.length === 0) throw new Error('the generic build excluded nothing; the import of the business package moved');

if (variant === 'legacy') {
  const skills = join(repo, 'skills');
  for (const name of readdirSync(skills)) {
    if (existsSync(join(skills, name, 'task.json'))) cpSync(join(skills, name), join(out, 'skills', name), { recursive: true });
  }
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
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      variant,
      node: manifest.engines.node,
      files: files(out),
      inputs,
      ...(variant === 'generic' ? { excluded } : {}),
    },
    null,
    2,
  ) + '\n',
);
console.log(`built ${relative(process.cwd(), out) || out} (${variant})`);
