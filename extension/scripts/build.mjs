#!/usr/bin/env node
/**
 * Bundle the CLI (dist/cli.js) and the extension host (dist/extension.js).
 *
 *   node scripts/build.mjs cli
 *   node scripts/build.mjs host [--watch]
 *
 * The CLI version is read from the repo-root package.json, the single source of
 * truth, and injected into both bundles:
 *   __SPECGUARD_VERSION__    the bundled CLI reports it (specguard --version)
 *   __EXPECTED_CLI_VERSION__ the host warns when the CLI it finds differs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, '..');
const rootPkg = JSON.parse(readFileSync(path.resolve(extRoot, '..', 'package.json'), 'utf8'));
const version = JSON.stringify(rootPkg.version);

const target = process.argv[2];
const watch = process.argv.includes('--watch');

// jsonc-parser's default entry is a UMD build whose runtime require('./impl/format') esbuild cannot follow,
// so the bundle crashes at startup. Point it at the ESM build instead.
const jsoncEsm = (from) => createRequire(from).resolve('jsonc-parser/lib/esm/main.js');
const activityIgnore = path.resolve(extRoot, '..', 'src', 'core', 'activity-ignore.ts');

const common = { bundle: true, platform: 'node', sourcemap: true, logLevel: 'info' };

const targets = {
  cli: {
    ...common,
    entryPoints: [path.resolve(extRoot, '..', 'src', 'cli', 'index.ts')],
    format: 'cjs',
    alias: { 'jsonc-parser': jsoncEsm(path.resolve(extRoot, '..', 'package.json')) },
    outfile: path.resolve(extRoot, 'dist', 'cli.js'),
    // import.meta.url does not exist in CJS: map it to the bundle's own file URL.
    define: { 'import.meta.url': '__importMetaUrl', __SPECGUARD_VERSION__: version },
    banner: { js: "const __importMetaUrl=require('url').pathToFileURL(__filename).href;" },
    // `pg` is loaded only by the team server (`specguard server` with DATABASE_URL), which the extension never runs.
    external: ['pg', 'pg-native'],
    // Plugins are found by esbuild's glob import (src/plugins/<name>/index.ts); the .js probe finds none.
    logOverride: { 'empty-glob': 'silent' },
  },
  host: {
    ...common,
    entryPoints: [path.resolve(extRoot, 'src', 'extension.ts')],
    external: ['vscode'],
    alias: { 'jsonc-parser': jsoncEsm(path.resolve(extRoot, 'package.json')), 'specguard-core/activity-ignore': activityIgnore },
    outfile: path.resolve(extRoot, 'dist', 'extension.js'),
    define: { 'import.meta.url': '__importMetaUrl', __EXPECTED_CLI_VERSION__: version },
    banner: { js: "const __importMetaUrl=require('url').pathToFileURL(__filename).href;" },
  },
};

/**
 * The generated documentation ships inside the extension (media/docs) so it opens offline: the index, the user
 * and developer pages, the manifest and the help topics. Rebuilt from docs/ on every host build.
 */
function copyDocs() {
  const from = path.resolve(extRoot, '..', 'docs');
  const to = path.resolve(extRoot, 'media', 'docs');
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const entry of ['index.md', 'guide', 'dev', 'manifest.json', 'help-topics.json']) {
    const src = path.join(from, entry);
    if (existsSync(src)) cpSync(src, path.join(to, entry), { recursive: true });
    else console.warn(`docs: ${entry} not found; run "specguard docs build" first`);
  }
}

const options = targets[target];
if (!options) {
  console.error(`usage: node scripts/build.mjs <${Object.keys(targets).join('|')}> [--watch]`);
  process.exit(2);
}

// Tests can verify the real host bundle in isolation without replacing an active extension's files.
const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1]) options.outfile = path.resolve(process.argv[outIndex + 1]);

if (target === 'host') copyDocs();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`watching ${target} (SpecGuard ${rootPkg.version})`);
} else {
  await build(options);
  console.log(`built ${target} (SpecGuard ${rootPkg.version})`);
}
