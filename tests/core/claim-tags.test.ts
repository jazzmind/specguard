import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attachSourceClaimTags,
  buildClaimTestIndex,
  claimTag,
  extractClaimRefs,
  rewriteClaimRefs,
  scanSourceForClaimTags,
} from '../../src/core/claim-tags.js';

describe('claim tags', () => {
  // [claims: capabilities/conformance-testing#claim-tag-forms]
  it('extracts the three forms', () => {
    const refs = extractClaimRefs('award once @claim:core/awards#award-once [claim: core/awards#no-dupes] [claims: a/b#c-d, repo:e/f#g]');
    expect(refs).toEqual(['core/awards#award-once', 'core/awards#no-dupes', 'a/b#c-d', 'repo:e/f#g']);
  });

  // [claims: capabilities/conformance-testing#claim-tag-forms]
  it('keeps slashes and repo prefix, drops trailing period, lowercases the claim id', () => {
    expect(extractClaimRefs('see @claim:api:mutations/designer#Create-It.')).toEqual(['api:mutations/designer#create-it']);
    expect(extractClaimRefs('no tag here, issue #12')).toEqual([]);
  });

  // [claims: capabilities/conformance-testing#claim-tag-forms]
  it('round-trips claimTag', () => {
    expect(extractClaimRefs(claimTag('x/y#z'))).toEqual(['x/y#z']);
  });

  // [claims: capabilities/conformance-testing#claim-tag-forms]
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

  // [claims: capabilities/conformance-testing#claim-tag-forms]
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

describe('tags in comments reach the results [source-tags-in-results]', () => {
  function source(body: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-src-tags-'));
    const file = path.join(dir, 'a.test.ts');
    writeFileSync(file, body);
    return file;
  }
  const row = (file: string, title: string, claims: string[] = []) => ({ file, title, claims });

  it('gives a row the claims tagged above its test, matched by file and title [attach]', () => {
    const file = source("// [claims: x/y#one, x/y#two]\nit('does a thing', () => {});\nit('untagged', () => {});\nit('in the title @claim:x/y#three', () => {});\n");
    const rows = [row(file, 'does a thing'), row(file, 'untagged'), row(file, 'in the title @claim:x/y#three', ['x/y#three'])];
    expect(attachSourceClaimTags(rows)).toBe(1);
    expect(rows[0].claims).toEqual(['x/y#one', 'x/y#two']);
    expect(rows[1].claims).toEqual([]);
    expect(rows[2].claims).toEqual(['x/y#three']);
  });

  it('resolves escaped quotes in the source title before matching the runner\'s title [escapes]', () => {
    const file = source("// [claim: x/y#one]\nit('doesn\\'t throw', () => {});\n");
    const rows = [row(file, "doesn't throw")];
    attachSourceClaimTags(rows);
    expect(rows[0].claims).toEqual(['x/y#one']);
  });

  it('reads a relative file name against the root, and leaves rows alone when the file is unreadable [root-and-missing]', () => {
    const file = source("// [claim: x/y#one]\nit('t', () => {});\n");
    const rows = [row(path.basename(file), 't'), row('/no/such/file.test.ts', 't')];
    expect(attachSourceClaimTags(rows, path.dirname(file))).toBe(1);
    expect(rows[0].claims).toEqual(['x/y#one']);
    expect(rows[1].claims).toEqual([]);
  });
});

describe('claim tags with example rows [claim-row-refs]', () => {
  // [claims: capabilities/spec-authoring#claim-row-refs]
  it('extractClaimRefs accepts cap#claim/row in all three tag forms and keeps plain refs unchanged', () => {
    const refs = extractClaimRefs('@claim:core/ship#fee/ny-small [claim: web:core/ship#fee/ak-any] [claims: core/ship#fee, core/ship#fee/ny-free.]');
    expect(refs).toEqual(['core/ship#fee/ny-small', 'web:core/ship#fee/ak-any', 'core/ship#fee', 'core/ship#fee/ny-free']);
  });

  // [claims: capabilities/spec-authoring#claim-row-refs]
  it('a tag round-trips through claimTag and a scanned source line', () => {
    expect(extractClaimRefs(claimTag('a/b#c/d-e'))).toEqual(['a/b#c/d-e']);
    const hits = scanSourceForClaimTags("it('fee ny-small @claim:a/b#fee/ny-small', () => {});", 'x.test.ts');
    expect(hits).toMatchObject([{ ref: 'a/b#fee/ny-small', line: 1 }]);
  });

  // [claims: capabilities/spec-authoring#claim-row-refs]
  it('rewriteClaimRefs keeps the row when it maps a ref', () => {
    const out = rewriteClaimRefs('// [claims: old/x#fee/ny-small]', (ref) => (ref === 'old/x#fee/ny-small' ? 'new/x#fee/ny-small' : undefined));
    expect(out).toEqual({ text: '// [claims: new/x#fee/ny-small]', changed: 1 });
  });
});
