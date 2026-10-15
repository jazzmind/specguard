import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildClaimTestIndex } from '../../src/core/claim-tags.js';
import { commentPrefix, insertClaimTags, scanTestDeclarations } from '../../src/core/test-declarations.js';

describe('test declarations [test-declarations]', () => {
  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('finds leaf tests in JS/TS, Python, Go and Rust, and never suites [scan]', () => {
    const ts = "describe('suite', () => {\n  it('does a thing', () => {});\n  test.each([1])('table %i', () => {});\n  it.skip(\"quoted\", () => {});\n});\n";
    // A table-driven title is not a plain string literal, so it is not offered for tagging.
    expect(scanTestDeclarations(ts, 'a.test.ts').map((d) => [d.line, d.title, d.indent])).toEqual([
      [2, 'does a thing', '  '],
      [4, 'quoted', '  '],
    ]);
    expect(scanTestDeclarations('def test_a():\n    pass\n\nasync def test_b():\n    pass\ndef helper():\n    pass\n', 'a.py').map((d) => d.title)).toEqual(['test_a', 'test_b']);
    expect(scanTestDeclarations('func TestX(t *testing.T) {}\nfunc helper() {}\n', 'a_test.go').map((d) => d.title)).toEqual(['TestX']);
    expect(scanTestDeclarations('#[test]\nfn adds() {}\nfn helper() {}\n', 'lib.rs').map((d) => d.title)).toEqual(['adds']);
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('knows whether a test already carries a claim tag on its line or the line above [tagged]', () => {
    const src = "it('a @claim:x/y#one', () => {});\n// [claims: x/y#two]\nit('b', () => {});\nit('c', () => {});\n";
    expect(scanTestDeclarations(src, 'a.test.ts').map((d) => d.tagged)).toEqual([true, true, false]);
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('inserts a comment above the test at its indentation, in the file\'s comment style, and never above a tagged test [insert]', () => {
    const src = "describe('s', () => {\n  it('a', () => {});\n  it('b', () => {});\n  // [claims: x/y#old]\n  it('c', () => {});\n});\n";
    const edits = new Map<number, string[]>([[2, ['x/y#one']], [3, ['x/y#two', 'x/y#two', 'x/y#three']], [5, ['x/y#nope']]]);
    const { text, added } = insertClaimTags(src, 'a.test.ts', edits);
    expect(added).toBe(2);
    expect(text).toBe("describe('s', () => {\n  // [claims: x/y#one]\n  it('a', () => {});\n  // [claims: x/y#two, x/y#three]\n  it('b', () => {});\n  // [claims: x/y#old]\n  it('c', () => {});\n});\n");
    expect(insertClaimTags('def test_a():\n    pass\n', 'a.py', new Map([[1, ['x/y#one']]])).text).toBe('# [claims: x/y#one]\ndef test_a():\n    pass\n');
    expect(commentPrefix('a.go')).toBe('//');
    expect(commentPrefix('a.py')).toBe('#');
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('writes tags the claim scanner reads back, attached to the right test [roundtrip]', () => {
    const { text } = insertClaimTags("it('logs in', () => {});\n", 'a.test.ts', new Map([[1, ['capabilities/auth#login']]]));
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'sg-rt-')), 'a.test.ts');
    writeFileSync(file, text);
    expect(buildClaimTestIndex({ testFiles: [file] }).get('capabilities/auth#login')?.[0].title).toBe('logs in');
  });
});

describe('what counts as a test [test-declarations-edges]', () => {
  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('does not offer Playwright suites, steps or hooks for tagging [not-suites]', () => {
    const src = "test.describe('Auth', () => {\n  test.beforeEach(async () => {});\n  test('logs in', async () => {\n    await test.step('open page', async () => {});\n  });\n  test.skip('later', () => {});\n});\n";
    expect(scanTestDeclarations(src, 'a.spec.ts').map((d) => d.title)).toEqual(['logs in', 'later']);
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('does not give a test the tag that ends the previous test\'s line [prev-line-owner]', () => {
    const src = "it('a', () => {}); // [claim: x/y#one]\nit('b', () => {});\n// [claims: x/y#two]\nit('c', () => {});\n";
    expect(scanTestDeclarations(src, 'a.test.ts').map((d) => [d.title, d.tagged])).toEqual([['a', true], ['b', false], ['c', true]]);
  });
});
