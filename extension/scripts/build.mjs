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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, '..');
const rootPkg = JSON.parse(readFileSync(path.resolve(extRoot, '..', 'package.json'), 'utf8'));
const version = JSON.stringify(rootPkg.version);

const target = process.argv[2];
const watch = process.argv.includes('--watch');

const common = { bundle: true, platform: 'node', sourcemap: true, logLevel: 'info' };

const targets = {
  cli: {
    ...common,
    entryPoints: [path.resolve(extRoot, '..', 'src', 'cli', 'index.ts')],
    format: 'cjs',
    outfile: path.resolve(extRoot, 'dist', 'cli.js'),
    // import.meta.url does not exist in CJS: map it to the bundle's own file URL.
    define: { 'import.meta.url': '__importMetaUrl', __SPECGUARD_VERSION__: version },
    banner: { js: "const __importMetaUrl=require('url').pathToFileURL(__filename).href;" },
    // Plugins are found by esbuild's glob import (src/plugins/<name>/index.ts); the .js probe finds none.
    logOverride: { 'empty-glob': 'silent' },
  },
  host: {
    ...common,
    entryPoints: [path.resolve(extRoot, 'src', 'extension.ts')],
    external: ['vscode'],
    outfile: path.resolve(extRoot, 'dist', 'extension.js'),
    define: { __EXPECTED_CLI_VERSION__: version },
  },
};

const options = targets[target];
if (!options) {
  console.error(`usage: node scripts/build.mjs <${Object.keys(targets).join('|')}> [--watch]`);
  process.exit(2);
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`watching ${target} (SpecGuard ${rootPkg.version})`);
} else {
  await build(options);
  console.log(`built ${target} (SpecGuard ${rootPkg.version})`);
}
