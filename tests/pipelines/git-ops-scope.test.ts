import { describe, expect, it } from 'vitest';

import { inScope, parsePorcelain, partitionByScope } from '../../src/pipelines/git-ops.js';

describe('git-ops change scopes', () => {
  it('parses -z porcelain output with renames and spaces', () => {
    // claim: porcelain-parse
    const out = ' M tests/a b.test.ts\0R  docs/new.md\0docs/old.md\0?? .specguard/x.json\0';
    expect(parsePorcelain(out)).toEqual(['tests/a b.test.ts', 'docs/new.md', 'docs/old.md', '.specguard/x.json']);
    expect(parsePorcelain(' M a.ts\n?? "b c.ts"\nR  x -> y\n')).toEqual(['a.ts', 'b c.ts', 'y']);
  });

  it('dependency scope stages only the listed manifest and lockfiles', () => {
    // claim: change-scope
    const scope = { type: 'dependency' as const, files: ['package.json', 'package-lock.json'] };
    const { stage, skipped } = partitionByScope(['package.json', 'package-lock.json', 'src/a.ts', 'tests/a.test.ts', 'node_modules/x/index.js'], scope);
    expect(stage).toEqual(['package.json', 'package-lock.json']);
    expect(skipped).toEqual(['src/a.ts', 'tests/a.test.ts', 'node_modules/x/index.js']);
  });

  it('code-fix scope stages only the named files, and traversal never passes', () => {
    const scope = { type: 'code-fix' as const, files: ['src/a.ts'] };
    expect(inScope('src/a.ts', scope)).toBe(true);
    expect(inScope('src/b.ts', scope)).toBe(false);
    expect(inScope('tests/../src/x.ts', { type: 'generated' })).toBe(false);
    expect(inScope('../outside.ts', scope)).toBe(false);
    expect(inScope('tests/a.test.ts', { type: 'generated' })).toBe(true);
  });
});
