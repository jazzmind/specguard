import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUNDLE, ROOT } from '../helpers/hook-repo.js';

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Build the same dependency graph in the layouts npm and pnpm can install. */
function buildLayout(layout: 'flat' | 'nested' | 'pnpm', distinctVersions = false): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sg-layout-'));
  const write = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  try {
    write('package.json', '{"type":"module"}');
    write('src/hooks/main.ts', "import value from 'parent'; console.log(value);\n");
    write('scripts/build-hook-bundle.mjs', '');
    copyFileSync(path.join(ROOT, 'scripts/build-hook-bundle.mjs'), path.join(root, 'scripts/build-hook-bundle.mjs'));
    const require = createRequire(path.join(ROOT, 'package.json'));
    mkdirSync(path.join(root, 'node_modules'));
    symlinkSync(path.dirname(require.resolve('esbuild/package.json')), path.join(root, 'node_modules/esbuild'), 'dir');
    const parent = layout === 'pnpm' ? 'node_modules/.pnpm/parent@1.0.0/node_modules/parent' : 'node_modules/parent';
    const child = layout === 'flat' ? 'node_modules/@fixture/child'
      : layout === 'nested' ? `${parent}/node_modules/@fixture/child`
        : 'node_modules/.pnpm/@fixture+child@1.0.0_peer@2.0.0/node_modules/@fixture/child';
    write(`${parent}/package.json`, '{"name":"parent","version":"1.0.0","main":"index.js"}');
    write(`${parent}/index.js`, "module.exports = require('@fixture/child');\n");
    write(`${child}/package.json`, '{"name":"@fixture/child","version":"1.0.0","main":"index.js"}');
    write(`${child}/index.js`, 'module.exports = 42;\n');
    if (distinctVersions) {
      write('node_modules/@fixture/child/package.json', '{"name":"@fixture/child","version":"2.0.0","main":"index.js"}');
      write('node_modules/@fixture/child/index.js', 'module.exports = 84;\n');
      write('src/hooks/main.ts', "import value from 'parent'; import other from '@fixture/child'; console.log(value, other);\n");
    }
    if (layout === 'pnpm') {
      symlinkSync(path.join(root, parent), path.join(root, 'node_modules/parent'), 'dir');
      mkdirSync(path.join(root, parent, 'node_modules/@fixture'), { recursive: true });
      symlinkSync(path.join(root, child), path.join(root, parent, 'node_modules/@fixture/child'), 'dir');
    }
    const out = path.join(root, 'hook.mjs');
    execFileSync(process.execPath, [path.join(root, 'scripts/build-hook-bundle.mjs'), '--out', out], { cwd: os.tmpdir(), stdio: 'pipe' });
    // Compare working bundles, not merely stripped strings or hashes.
    expect(execFileSync(process.execPath, [out], { encoding: 'utf8' }).trim()).toBe(distinctVersions ? '42 84' : '42');
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the committed hook bundle [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#hook-bundle-fresh]
  it('builds identical working bundles with hoisted npm, nested npm and pnpm dependencies', () => {
    const flat = buildLayout('flat');
    expect(buildLayout('nested')).toBe(flat);
    expect(buildLayout('pnpm')).toBe(flat);
  });

  // [claims: capabilities/spec-first-changes#hook-bundle-fresh]
  it('keeps distinct versions and their labels when normalizing nested npm and pnpm layouts', () => {
    const nested = buildLayout('nested', true);
    expect(nested).toContain('node_modules/@fixture/child@1.0.0/index.js');
    expect(nested).toContain('node_modules/@fixture/child@2.0.0/index.js');
    expect(buildLayout('pnpm', true)).toBe(nested);
  });

  // [claims: capabilities/spec-first-changes#hook-bundle-fresh]
  it('equals a fresh build of the sources (run `npm run build:hook` after changing src/hooks or what they import)', () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'sg-bundle-')), 'specguard-hook.mjs');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-hook-bundle.mjs'), '--out', out], { cwd: ROOT, stdio: 'pipe' });
    expect(sha(out), 'plugins/specguard/hooks/dist/specguard-hook.mjs is stale').toBe(sha(BUNDLE));
  }, 60_000);

  // [claims: capabilities/spec-first-changes#hook-bundle-fresh]
  it('is one self-contained file: it imports only node built-ins', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    const imports = [...text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(builtinModules, spec).toContain(spec.replace(/^node:/, ''));
  });
});
