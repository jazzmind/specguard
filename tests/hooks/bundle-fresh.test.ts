import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUNDLE, ROOT } from '../helpers/hook-repo.js';

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('the committed hook bundle [spec-first-changes]', () => {
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
