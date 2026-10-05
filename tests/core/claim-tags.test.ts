import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildClaimTestIndex,
  claimTag,
  extractClaimRefs,
  scanSourceForClaimTags,
} from '../../src/core/claim-tags.js';

describe('claim tags', () => {
  it('extracts the three forms', () => {
    const refs = extractClaimRefs('award once @claim:core/awards#award-once [claim: core/awards#no-dupes] [claims: a/b#c-d, repo:e/f#g]');
    expect(refs).toEqual(['core/awards#award-once', 'core/awards#no-dupes', 'a/b#c-d', 'repo:e/f#g']);
  });

  it('keeps slashes and repo prefix, drops trailing period, lowercases the claim id', () => {
    expect(extractClaimRefs('see @claim:api:mutations/designer#Create-It.')).toEqual(['api:mutations/designer#create-it']);
    expect(extractClaimRefs('no tag here, issue #12')).toEqual([]);
  });

  it('round-trips claimTag', () => {
    expect(extractClaimRefs(claimTag('x/y#z'))).toEqual(['x/y#z']);
  });

  it('scans source lines with titles', () => {
    const src = [
      "describe('awards', () => {",
      "  it('awards once @claim:core/awards#award-once', () => {});",
      '  // [claim: core/awards#no-dupes]',
      "  it('no dupes', () => {});",
      '});',
    ].join('\n');
    const hits = scanSourceForClaimTags(src, 'a.test.ts');
    expect(hits).toEqual([
      { ref: 'core/awards#award-once', file: 'a.test.ts', line: 2, title: 'awards once @claim:core/awards#award-once' },
      { ref: 'core/awards#no-dupes', file: 'a.test.ts', line: 3, title: 'no dupes' },
    ]);
  });

  it('merges sources and results into one index', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-tags-'));
    const file = path.join(dir, 'a.test.ts');
    writeFileSync(file, "it('x @claim:a/b#c', () => {});\n");
    const index = buildClaimTestIndex({
      rootDir: dir,
      testFiles: [file],
      results: [{ file: 'r.xml', title: 't', status: 'pass', claims: ['a/b#c'] }],
    });
    expect(index.get('a/b#c')?.map((e) => e.origin)).toEqual(['source', 'result']);
    expect(index.get('a/b#c')?.[0].file).toBe('a.test.ts');
  });
});
