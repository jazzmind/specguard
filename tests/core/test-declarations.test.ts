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

const JAVA = [
  'package a;',
  '',
  'import org.junit.Test;',
  'import org.junit.jupiter.api.Test;',
  '',
  '/* @Test in a block comment',
  '   @Test',
  '   void ghost() {} */',
  'class LoginTest {',
  '    @Test',
  '    void plain() {}',
  '',
  '    @DisplayName("Signs in \\"fast\\"")',
  '    @Test',
  '    void withDisplay() {}',
  '',
  '    @ParameterizedTest',
  '    @MethodSource("codes")',
  '    void table(String code) {}',
  '',
  '    @Test(groups = {"REGRESSION"})',
  '    public void testng() {}',
  '',
  '    @Test(expected = IllegalStateException.class)',
  '    @Disabled("later")',
  '    // why: flaky',
  '',
  '    /* more */',
  '    @Override',
  '    public void gap() {}',
  '',
  '    @RepeatedTest(3) void inline() {}',
  '',
  '    @TestFactory',
  '    Stream<DynamicTest> factory() { return null; }',
  '',
  '    @TestInstance(Lifecycle.PER_CLASS)',
  '    void notATest() {}',
  '',
  '    @Test',
  '    @DisplayName(',
  '        "Multi line")',
  '    void multi() {}',
  '',
  '    // [claims: x/y#done]',
  '    @Test',
  '    void alreadyTagged() {}',
  '}',
  '',
].join('\n');

describe('Java and Kotlin tests [java-declarations]', () => {
  // [claims: capabilities/spec-authoring#spec-tag-java-tests]
  it('finds JUnit 5, JUnit 4 and TestNG tests with their title and signature line, and ignores imports, comments and non-test annotations [java-scan]', () => {
    const found = scanTestDeclarations(JAVA, 'LoginTest.java');
    expect(found.map((d) => [d.title, d.line, d.anchor ?? d.line, d.tagged])).toEqual([
      ['plain', 11, 10, false],
      ['Signs in "fast"', 15, 13, false],
      ['table', 19, 17, false],
      ['testng', 22, 21, false],
      ['gap', 30, 24, false],
      ['inline', 32, 32, false],
      ['factory', 35, 34, false],
      ['Multi line', 43, 40, false],
      ['alreadyTagged', 47, 46, true],
    ]);
    expect(found[0].indent).toBe('    ');
  });

  // [claims: capabilities/spec-authoring#spec-tag-java-tests]
  it('places the claim comment above the first annotation of the test, never between annotation and method [java-insert]', () => {
    const src = JAVA;
    const { text, added } = insertClaimTags(src, 'LoginTest.java', new Map([[15, ['x/y#one']], [30, ['x/y#two']], [32, ['x/y#three']], [47, ['x/y#nope']]]));
    expect(added).toBe(3);
    expect(text).toContain('    // [claims: x/y#one]\n    @DisplayName("Signs in \\"fast\\"")\n    @Test\n    void withDisplay');
    expect(text).toContain('    // [claims: x/y#two]\n    @Test(expected = IllegalStateException.class)\n    @Disabled("later")');
    expect(text).toContain('    // [claims: x/y#three]\n    @RepeatedTest(3) void inline()');
    expect(text).not.toContain('nope');
    // Re-scanning sees the tests as tagged, and the tag is read back by the claim scanner.
    expect(scanTestDeclarations(text, 'LoginTest.java').filter((d) => d.tagged).map((d) => d.title)).toEqual(['Signs in "fast"', 'gap', 'inline', 'alreadyTagged']);
    expect(commentPrefix('A.java')).toBe('//');
    expect(commentPrefix('A.kt')).toBe('//');
  });

  // [claims: capabilities/spec-authoring#spec-tag-java-tests]
  it('reads Kotlin tests, including backtick names [kotlin-scan]', () => {
    const kt = '@Test\nfun `signs in`() {}\n\n@Test fun plain() {}\n\n@Ignore\nfun helper() {}\n';
    expect(scanTestDeclarations(kt, 'A.kt').map((d) => [d.title, d.line, d.anchor ?? d.line])).toEqual([
      ['signs in', 2, 1],
      ['plain', 4, 4],
    ]);
  });
});

describe('skipped, focused and property test declarations', () => {
  // [claims: capabilities/test-strength#declarations-markers]
  it('finds xit, xtest, xspecify, fit and ftest tests so skips and focus stay visible', () => {
    const src = "xit('skipped one', () => {});\nxtest('skipped two', () => {});\nfit('focused', () => {});\nftest('focused two', () => {});\nxspecify('s', () => {});\nfunction fit(a) {}\n";
    expect(scanTestDeclarations(src, 'a.test.ts').map((d) => d.title)).toEqual(['skipped one', 'skipped two', 'focused', 'focused two', 's']);
  });

  // [claims: capabilities/test-strength#declarations-markers]
  it('finds jqwik @Property and @Example methods', () => {
    const src = ['class P {', '  @Property', '  void always(@ForAll int x) {}', '', '  @Example', '  boolean one() { return true; }', '}', ''].join('\n');
    expect(scanTestDeclarations(src, 'P.java').map((d) => [d.title, d.annotations])).toEqual([
      ['always', ['Property']],
      ['one', ['Example']],
    ]);
  });

  // [claims: capabilities/test-strength#declarations-markers]
  it('exposes JVM annotation names, argument text and the method name', () => {
    const src = [
      '@Test(enabled = false)',
      '@DisplayName("Nice name")',
      '@Disabled("flaky",',
      '          reason = "x")',
      'void realMethod() {}',
      '',
      '@Test(expected = IllegalStateException.class) public void other() {}',
      '',
    ].join('\n');
    const [a, b] = scanTestDeclarations(src, 'T.java');
    expect(a?.title).toBe('Nice name');
    expect(a?.method).toBe('realMethod');
    expect(a?.annotations).toEqual(['Test', 'DisplayName', 'Disabled']);
    expect(a?.annotationArgs?.Test).toBe('enabled = false');
    expect(a?.annotationArgs?.DisplayName).toBe('"Nice name"');
    expect(a?.annotationArgs?.Disabled).toBe('"flaky", reason = "x"');
    expect(b?.annotationArgs?.Test).toBe('expected = IllegalStateException.class');
  });
});

describe('declarations behind modifiers and attributes', () => {
  // [claims: capabilities/test-strength#declarations-markers]
  it('finds it.skipIf(cond)(title) and Rust tests with attributes between #[test] and fn', () => {
    const js = "it.skipIf(process.platform === 'win32')('posix only', () => {});\nit.runIf(ok)('gated', () => {});\n";
    expect(scanTestDeclarations(js, 'a.test.ts').map((d) => d.title)).toEqual(['posix only', 'gated']);
    const rs = '#[test]\n#[ignore]\nfn slow() {}\n\n#[test]\n// note\n#[should_panic]\nfn boom() {}\n\nfn helper() {}\n';
    expect(scanTestDeclarations(rs, 'lib.rs').map((d) => d.title)).toEqual(['slow', 'boom']);
  });
});
