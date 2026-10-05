#!/usr/bin/env node
/**
 * Make the extension version follow the CLI version.
 *
 *   node scripts/sync-version.mjs            write the root package.json version into extension/package.json
 *   node scripts/sync-version.mjs --check    exit 1 if they differ
 *   node scripts/sync-version.mjs 1.2.3      write 1.2.3 into both (release workflow: the tag is the source)
 *
 * The root package.json (the CLI, `specguard-ai`) is the single version source.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootPath = path.resolve(here, '..', '..', 'package.json');
const extPath = path.resolve(here, '..', 'package.json');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, doc) => writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);

const arg = process.argv[2];
const root = read(rootPath);
const ext = read(extPath);

if (arg === '--check') {
  if (root.version !== ext.version) {
    console.error(`version mismatch: CLI ${root.version} vs extension ${ext.version}`);
    process.exit(1);
  }
  console.log(`versions agree: ${root.version}`);
  process.exit(0);
}

const target = arg && /^\d+\.\d+\.\d+/.test(arg) ? arg : root.version;
if (root.version !== target) {
  root.version = target;
  write(rootPath, root);
}
if (ext.version !== target) {
  ext.version = target;
  write(extPath, ext);
}
console.log(`CLI and extension are at ${target}`);
