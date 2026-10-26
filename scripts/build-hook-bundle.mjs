// Builds the agent edit guard as one self-contained file, so the Claude Code plugin runs it with no install step:
//   node scripts/build-hook-bundle.mjs                 -> plugins/specguard/hooks/dist/specguard-hook.mjs (committed)
//   node scripts/build-hook-bundle.mjs --also-dist     -> and dist/hooks/specguard-hook.mjs (shipped in the npm package)
//   node scripts/build-hook-bundle.mjs --out <file>    -> only that file (the freshness test builds into a temp dir)
// The output depends only on the sources and the esbuild version, so a rebuild is byte-identical.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const outFile = flagValue('--out');
const targets = outFile
  ? [path.resolve(outFile)]
  : [path.join(root, 'plugins', 'specguard', 'hooks', 'dist', 'specguard-hook.mjs'), ...(args.includes('--also-dist') ? [path.join(root, 'dist', 'hooks', 'specguard-hook.mjs')] : [])];

// Some bundled dependencies are CommonJS and `require` node built-ins; an ES module has no `require`.
const banner = "import { createRequire as __sgCreateRequire } from 'node:module'; const require = __sgCreateRequire(import.meta.url);";

// esbuild prints paths relative to the working directory in its module comments: build from the repository root.
process.chdir(root);
const result = await build({
  entryPoints: ['src/hooks/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  write: false,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: banner },
  logLevel: 'warning',
});

const text = result.outputFiles[0].text;
for (const file of targets) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  process.stdout.write(`built ${path.relative(root, file) || file} (${Math.round(text.length / 1024)} KB)\n`);
}
