import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ConfigInvalidError } from '../../src/core/errors.js';

import {
  analyzeTestFile,
  applyResultStatus,
  claimStrength,
  diffTestFile,
  resolveStrengthConfig,
  testLanguageOf,
  type TestStrength,
  type TestStrengthConfig,
} from '../../src/core/test-strength.js';

const cfg = (over: Partial<TestStrengthConfig> = {}): TestStrengthConfig => ({ ...resolveStrengthConfig(), ...over });
const analyze = (src: string, file: string, c: TestStrengthConfig = cfg()): TestStrength[] => analyzeTestFile(src, file, c);
const one = (src: string, file: string, c?: TestStrengthConfig): TestStrength => {
  const out = analyze(src, file, c);
  expect(out).toHaveLength(1);
  return out[0]!;
};
const summary = (src: string, file: string, c?: TestStrengthConfig): Array<[string, string, string[]]> =>
  analyze(src, file, c).map((t) => [t.test.title, t.class, t.reasons]);

describe('testLanguageOf', () => {
  // [claims: capabilities/test-strength#skip-detected]
  it('maps extensions to languages', () => {
    expect(['a.ts', 'a.tsx', 'a.mjs', 'a.cts', 'a.py', 'a.go', 'a.rs', 'A.java', 'A.kt', 'A.kts', 'a.rb'].map(testLanguageOf)).toEqual([
      'js', 'js', 'js', 'js', 'python', 'go', 'rust', 'jvm', 'jvm', 'jvm', undefined,
    ]);
  });
});

describe('js skipped and conditional', () => {
  // [claims: capabilities/test-strength#skip-detected]
  it('js: it.skip / test.skip / xit / it.todo / test.fixme are skipped with the right reason', () => {
    const src = [
      "it.skip('a', () => { expect(1 + x).toBe(2); });",
      "test.skip('b', () => { expect(1 + x).toBe(2); });",
      "xit('c', () => { expect(1 + x).toBe(2); });",
      "it.todo('d');",
      "test.fixme('e', async () => { expect(x).toBe(2); });",
    ].join('\n');
    expect(summary(src, 'a.test.ts')).toEqual([
      ['a', 'skipped', ['skip-static']],
      ['b', 'skipped', ['skip-static']],
      ['c', 'skipped', ['skip-static']],
      ['d', 'skipped', ['todo']],
      ['e', 'skipped', ['skip-static']],
    ]);
  });

  // [claims: capabilities/test-strength#skip-detected]
  it('js: tests inside describe.skip and xdescribe are enclosing-skip', () => {
    const src = [
      "describe.skip('suite', () => {",
      "  it('a', () => { expect(f()).toBe(1); });",
      '});',
      "xdescribe('other', () => {",
      "  it('b', () => { expect(f()).toBe(1); });",
      '});',
      "describe('live', () => {",
      "  it('c', () => { expect(f()).toBe(1); });",
      '});',
    ].join('\n');
    expect(summary(src, 'a.test.ts')).toEqual([
      ['a', 'skipped', ['enclosing-skip']],
      ['b', 'skipped', ['enclosing-skip']],
      ['c', 'strong', []],
    ]);
  });

  // [claims: capabilities/test-strength#skip-detected]
  it('js: a .only in the file makes the other tests focus-elsewhere', () => {
    const src = ["it.only('a', () => { expect(f()).toBe(1); });", "it('b', () => { expect(f()).toBe(1); });", "fit('c', () => { expect(f()).toBe(1); });"].join('\n');
    expect(summary(src, 'a.test.ts')).toEqual([
      ['a', 'strong', []],
      ['b', 'skipped', ['focus-elsewhere']],
      ['c', 'strong', []],
    ]);
  });

  // [claims: capabilities/test-strength#skip-detected]
  it('js: Playwright test.skip() as the first statement is skip-in-body', () => {
    const src = ["test('a', async ({ page }) => {", '  test.skip();', '  await expect(page).toHaveURL("/x");', '});'].join('\n');
    expect(summary(src, 'a.spec.ts')).toEqual([['a', 'skipped', ['skip-in-body']]]);
  });

  // [claims: capabilities/test-strength#conditional-gates]
  it('js: skipIf, runIf and Playwright test.skip(condition) are conditional', () => {
    const src = [
      "it.skipIf(process.platform === 'win32')('a', () => { expect(f()).toBe(1); });",
      "it.runIf(ready)('b', () => { expect(f()).toBe(1); });",
      "test('c', async ({ browserName }) => {",
      "  test.skip(browserName === 'firefox', 'no support');",
      '  expect(f()).toBe(1);',
      '});',
      "it('d', (ctx) => {",
      '  if (x) { ctx.skip(); }',
      '  expect(f()).toBe(1);',
      '});',
    ].join('\n');
    expect(summary(src, 'a.test.ts')).toEqual([
      ['a', 'conditional', ['conditional-builtin']],
      ['b', 'conditional', ['conditional-builtin']],
      ['c', 'conditional', ['conditional-builtin']],
      ['d', 'conditional', ['conditional-builtin']],
    ]);
  });

  // [claims: capabilities/test-strength#conditional-gates]
  it('config conditional regex matches body, declaration and file head; invalid regex throws', () => {
    const c = resolveStrengthConfig({ conditional: ['process\\.env\\.RUN_REGRESSION', 'REGRESSION_ONLY'] });
    const body = "it('a', () => { if (!process.env.RUN_REGRESSION) return; expect(f()).toBe(1); });";
    expect(one(body, 'a.test.ts', c)).toMatchObject({ class: 'conditional', reasons: ['conditional-config'] });
    const head = "// REGRESSION_ONLY\nit('a', () => { expect(f()).toBe(1); });";
    expect(one(head, 'a.test.ts', c)).toMatchObject({ class: 'conditional' });
    const filler = Array.from({ length: 35 }, () => '').join('\n');
    const decl = `${filler}\nit('REGRESSION_ONLY a', () => { expect(f()).toBe(1); });\nit('b', () => { expect(f()).toBe(1); });`;
    expect(summary(decl, 'a.test.ts', c).map((r) => r[1])).toEqual(['conditional', 'strong']);
    expect(() => resolveStrengthConfig({ conditional: ['('] })).toThrow(/invalid regular expression/);
    expect(resolveStrengthConfig({ conditional: ['a'] }, { conditional: ['b', 'a'] }).conditional).toEqual(['a', 'b']);
    expect(resolveStrengthConfig().snapshotIsWeak).toBe(true);
  });
});

describe('js assertions', () => {
  // [claims: capabilities/test-strength#no-assertion-weak]
  it('js: expect(true).toBe(true) and expect(x).toBe(x) are trivial', () => {
    expect(one("it('a', () => { expect(true).toBe(true); });", 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['trivial-assertion'] });
    expect(one("it('a', () => { const x = f(); expect(x).toBe(x); });", 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['trivial-assertion'] });
  });

  // [claims: capabilities/test-strength#no-assertion-weak]
  it('js: a test with no assertion is weak/no-assertion and an unknown imported call alone does not count', () => {
    expect(one("it('a', () => { f(); });", 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['no-assertion'] });
    expect(one("import { validateThing } from './v';\nit('a', () => { validateThing(f()); });", 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['no-assertion'] });
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('js: a sole toBeDefined is existence-only; with toEqual it is strong', () => {
    expect(one("it('a', () => { expect(f()).toBeDefined(); });", 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['existence-only'] });
    expect(one("it('a', () => { expect(f()).toBeDefined(); expect(f()).toEqual({ a: 1 }); });", 'a.test.ts').class).toBe('strong');
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('js: only not.toThrow is no-throw-only', () => {
    expect(one("it('a', () => { expect(() => f()).not.toThrow(); });", 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['no-throw-only'] });
  });

  // [claims: capabilities/test-strength#snapshot-weak]
  it('js: snapshot-only is weak by default and strong with snapshotIsWeak false', () => {
    const src = "it('a', () => { expect(render()).toMatchSnapshot(); });";
    expect(one(src, 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['snapshot-only'] });
    expect(one(src, 'a.test.ts', cfg({ snapshotIsWeak: false })).class).toBe('strong');
    // a weak assertion next to a snapshot does not turn the pair strong while snapshots are weak
    expect(one("it('a', () => { expect(render()).toMatchSnapshot(); expect(render()).toBeDefined(); });", 'a.test.ts').class).toBe('weak');
  });

  // [claims: capabilities/test-strength#no-assertion-weak]
  it('js: commented-out assertions do not count, nor do assertions inside strings', () => {
    const src = ["it('a', () => {", '  f();', '  // expect(f()).toEqual(1);', '  /* expect(f()).toEqual(2); */', "  const s = 'expect(f()).toEqual(3)';", '});'].join('\n');
    expect(one(src, 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['no-assertion'] });
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('js: a multi-line expect chain with resolves/not is detected', () => {
    const src = ["it('a', async () => {", '  await expect(', '    load(1),', '  )', '    .resolves', '    .toEqual({ a: 1 });', '});'].join('\n');
    const t = one(src, 'a.test.ts');
    expect(t.class).toBe('strong');
    expect(t.assertions).toHaveLength(1);
    expect(t.assertions[0]).toMatchObject({ kind: 'exact', strength: 3, line: 2 });
    expect(one("it('a', async () => { await expect(load()).rejects.toThrow('boom'); });", 'a.test.ts').assertions[0]).toMatchObject({ kind: 'throws', strength: 3 });
  });

  // [claims: capabilities/test-strength#helper-assertions]
  it('js: same-file helper with expect counts; helper chains to depth 3', () => {
    const src = [
      'function deep(x) { expect(x).toEqual(1); }',
      'function mid(x) { deep(x); }',
      'const top = (x) => { mid(x); };',
      "it('a', () => { top(f()); });",
      "it('b', () => { other(f()); });",
      'function other(x) { return x; }',
    ].join('\n');
    expect(summary(src, 'a.test.ts')).toEqual([
      ['a', 'strong', []],
      ['b', 'weak', ['no-assertion']],
    ]);
    expect(analyze(src, 'a.test.ts')[0]!.assertions[0]).toMatchObject({ kind: 'helper', helper: 'top', strength: 3 });
  });

  // [claims: capabilities/test-strength#helper-assertions]
  it('js: convention helper expectValidUser counts at strength 2; config helper at 3', () => {
    const src = "it('a', () => { expectValidUser(f()); });\nit('b', () => { confirmOut(f()); });";
    const plain = analyze(src, 'a.test.ts');
    expect(plain[0]!.assertions[0]).toMatchObject({ kind: 'helper', strength: 2, helper: 'expectValidUser' });
    expect(plain[0]!.class).toBe('strong');
    expect(plain[1]!.class).toBe('weak'); // `confirmOut` is not a convention name
    const configured = analyze(src, 'a.test.ts', cfg({ assertHelpers: ['confirmOut', 'expectValid*'] }));
    expect(configured[0]!.assertions[0]).toMatchObject({ strength: 3 });
    expect(configured[1]!.assertions[0]).toMatchObject({ strength: 3, helper: 'confirmOut' });
  });

  // [claims: capabilities/test-strength#helper-assertions]
  it('js: a same-file helper that asserts nothing is not rescued by its name', () => {
    const src = "function expectNothing(x) { return x; }\nit('a', () => { expectNothing(f()); });";
    expect(one(src, 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['no-assertion'] });
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('js: fc.assert sets property and is strong', () => {
    const t = one("it('a', () => { fc.assert(fc.property(fc.integer(), (n) => n + 0 === n)); });", 'a.test.ts');
    expect(t).toMatchObject({ class: 'strong', property: true });
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('js: wildcard matchers are counted', () => {
    const t = one("it('a', () => { expect(f()).toEqual({ id: expect.any(String), n: expect.anything() }); });", 'a.test.ts');
    expect(t.wildcards).toBe(2);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('js: node assert, chai and ava styles are graded', () => {
    expect(one("it('a', () => { assert.strictEqual(f(), 2); });", 'a.test.ts').class).toBe('strong');
    expect(one("it('a', () => { assert.ok(f()); });", 'a.test.ts')).toMatchObject({ class: 'weak', reasons: ['existence-only'] });
    expect(one("it('a', () => { expect(f()).to.deep.equal({ a: 1 }); });", 'a.test.ts').class).toBe('strong');
    expect(one("it('a', () => { expect(f()).to.be.ok; });", 'a.test.ts').class).toBe('weak');
    expect(one("test('a', (t) => { t.is(f(), 2); });", 'a.test.ts').class).toBe('strong');
  });
});

describe('lexical robustness', () => {
  // [claims: capabilities/test-strength#weak-assertions]
  it('js: regex literals, nested template literals and CRLF line endings do not derail body detection', () => {
    const src = [
      "it('a', () => {",
      '  expect(x).not.toMatch(/[;&|`$]/);',
      '  const s = `a ${`b ${"}"}`} {`;',
      '  expect(f(s)).toEqual({ a: 1 });',
      '});',
      "it('b', () => { f(); });",
    ].join('\r\n');
    expect(summary(src, 'a.test.ts')).toEqual([
      ['a', 'strong', []],
      ['b', 'weak', ['no-assertion']],
    ]);
  });
});

describe('python', () => {
  // [claims: capabilities/test-strength#no-assertion-weak]
  it('python: assert True trivial; assert x is not None existence-only; assert a == b strong', () => {
    const src = ['def test_a():', '    assert True', '', 'def test_b():', '    assert f() is not None', '', 'def test_c():', '    assert f() == 2', ''].join('\n');
    expect(summary(src, 'test_x.py')).toEqual([
      ['test_a', 'weak', ['trivial-assertion']],
      ['test_b', 'weak', ['existence-only']],
      ['test_c', 'strong', []],
    ]);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('python: pytest.raises with match is exact; self.assertEqual strong; assert_called_once_with strong', () => {
    const src = [
      'def test_a():',
      '    with pytest.raises(ValueError, match="bad"):',
      '        f()',
      '',
      'class T(unittest.TestCase):',
      '    def test_b(self):',
      '        self.assertEqual(f(), 2)',
      '',
      'def test_c():',
      '    m.assert_called_once_with(1)',
      '',
      'def test_d():',
      '    with pytest.raises(ValueError):',
      '        f()',
      '',
    ].join('\n');
    const out = analyze(src, 'test_x.py');
    expect(out.map((t) => t.class)).toEqual(['strong', 'strong', 'strong', 'strong']);
    expect(out[0]!.assertions[0]).toMatchObject({ kind: 'throws', strength: 3 });
    expect(out[3]!.assertions[0]).toMatchObject({ kind: 'throws', strength: 2 });
    expect(out[2]!.assertions[0]).toMatchObject({ kind: 'mock-verify', strength: 3 });
  });

  // [claims: capabilities/test-strength#skip-detected]
  it('python: skip/skipif/xfail decorators, class decorators and module pytestmark', () => {
    const src = [
      '@pytest.mark.skip(reason="x")',
      'def test_a():',
      '    assert f() == 1',
      '',
      '@pytest.mark.skipif(sys.platform == "win32", reason="x")',
      'def test_b():',
      '    assert f() == 1',
      '',
      '@pytest.mark.xfail',
      'def test_c():',
      '    assert f() == 1',
      '',
      '@unittest.skip("no")',
      'def test_d():',
      '    assert f() == 1',
      '',
      '@pytest.mark.skip',
      'class TestK:',
      '    def test_e(self):',
      '        assert f() == 1',
      '',
      'def test_f():',
      '    assert f() == 1',
      '',
    ].join('\n');
    expect(summary(src, 'test_x.py')).toEqual([
      ['test_a', 'skipped', ['skip-static']],
      ['test_b', 'conditional', ['conditional-builtin']],
      ['test_c', 'skipped', ['skip-static']],
      ['test_d', 'skipped', ['skip-static']],
      ['test_e', 'skipped', ['skip-static']],
      ['test_f', 'strong', []],
    ]);
    const marked = 'pytestmark = pytest.mark.skip\n\ndef test_a():\n    assert f() == 1\n';
    expect(summary(marked, 'test_x.py')).toEqual([['test_a', 'skipped', ['skip-static']]]);
  });

  // [claims: capabilities/test-strength#skip-detected]
  it('python: pytest.skip as first statement is skipped, inside if is conditional', () => {
    const src = [
      'def test_a():',
      '    pytest.skip("later")',
      '    assert f() == 1',
      '',
      'def test_b():',
      '    if not ready():',
      '        pytest.skip("later")',
      '    assert f() == 1',
      '',
    ].join('\n');
    expect(summary(src, 'test_x.py')).toEqual([
      ['test_a', 'skipped', ['skip-in-body']],
      ['test_b', 'conditional', ['conditional-builtin']],
    ]);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('python: @given sets property', () => {
    const src = ['@given(st.integers())', 'def test_a(n):', '    assert n + 0 == n', ''].join('\n');
    expect(one(src, 'test_x.py')).toMatchObject({ class: 'strong', property: true });
  });

  // [claims: capabilities/test-strength#helper-assertions]
  it('python: same-file helper and snake-case convention helper count', () => {
    const src = ['def check_equal(a, b):', '    assert a == b', '', 'def test_a():', '    check_equal(f(), 1)', '', 'def test_b():', '    assert_valid(f())', ''].join('\n');
    expect(summary(src, 'test_x.py').map((r) => r[1])).toEqual(['strong', 'strong']);
  });
});

describe('go', () => {
  // [claims: capabilities/test-strength#skip-detected]
  it('go: t.Skip first is skipped, inside if conditional; testing.Short conditional; build tag file-wide', () => {
    const src = [
      'func TestA(t *testing.T) {',
      '\tt.Skip("later")',
      '\tif got := f(); got != 1 { t.Errorf("x") }',
      '}',
      '',
      'func TestB(t *testing.T) {',
      '\tif os.Getenv("CI") == "" {',
      '\t\tt.Skip("no ci")',
      '\t}',
      '\tif got := f(); got != 1 { t.Errorf("x") }',
      '}',
      '',
      'func TestC(t *testing.T) {',
      '\tif testing.Short() { return }',
      '\tif got := f(); got != 1 { t.Errorf("x") }',
      '}',
      '',
    ].join('\n');
    expect(summary(src, 'a_test.go')).toEqual([
      ['TestA', 'skipped', ['skip-static']],
      ['TestB', 'conditional', ['conditional-builtin']],
      ['TestC', 'conditional', ['conditional-builtin']],
    ]);
    const tagged = '//go:build integration\n\npackage x\n\nfunc TestA(t *testing.T) {\n\tif got := f(); got != 1 { t.Errorf("x") }\n}\n';
    expect(summary(tagged, 'a_test.go')).toEqual([['TestA', 'conditional', ['build-tag']]]);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('go: only if err != nil { t.Fatal } is error-check-only; if got != want { t.Errorf } strong', () => {
    const src = [
      'func TestA(t *testing.T) {',
      '\t_, err := f()',
      '\tif err != nil {',
      '\t\tt.Fatal(err)',
      '\t}',
      '}',
      '',
      'func TestB(t *testing.T) {',
      '\tgot := f()',
      '\tif got != want {',
      '\t\tt.Errorf("got %v", got)',
      '\t}',
      '}',
      '',
    ].join('\n');
    expect(summary(src, 'a_test.go')).toEqual([
      ['TestA', 'weak', ['error-check-only']],
      ['TestB', 'strong', []],
    ]);
  });

  // [claims: capabilities/test-strength#helper-assertions]
  it('go: testify require.NoError only is weak; assert.Equal strong; helper receiving t counts', () => {
    const src = [
      'func TestA(t *testing.T) {',
      '\t_, err := f()',
      '\trequire.NoError(t, err)',
      '}',
      '',
      'func TestB(t *testing.T) {',
      '\tassert.Equal(t, 2, f())',
      '}',
      '',
      'func TestC(t *testing.T) {',
      '\tassertSameUser(t, f())',
      '}',
      '',
      'func TestD(t *testing.T) {',
      '\tcheckIt(t, f())',
      '}',
      '',
      'func checkIt(t *testing.T, v int) {',
      '\tif v != 2 {',
      '\t\tt.Errorf("bad")',
      '\t}',
      '}',
      '',
    ].join('\n');
    expect(summary(src, 'a_test.go')).toEqual([
      ['TestA', 'weak', ['error-check-only']],
      ['TestB', 'strong', []],
      ['TestC', 'strong', []],
      ['TestD', 'strong', []],
    ]);
  });
});

describe('rust', () => {
  // [claims: capabilities/test-strength#skip-detected]
  it('rust: #[ignore] skipped; #[cfg] conditional; assert_eq strong; unwrap-only weak; should_panic(expected) strong; assert!(true) trivial', () => {
    const src = [
      '#[test]',
      '#[ignore]',
      'fn a() { assert_eq!(f(), 2); }',
      '',
      '#[test]',
      '#[cfg(feature = "slow")]',
      'fn b() { assert_eq!(f(), 2); }',
      '',
      '#[test]',
      'fn c() { assert_eq!(f(), 2); }',
      '',
      '#[test]',
      'fn d() { f().unwrap(); }',
      '',
      '#[test]',
      '#[should_panic(expected = "boom")]',
      'fn e() { f(); }',
      '',
      '#[test]',
      'fn g() { assert!(true); }',
      '',
    ].join('\n');
    expect(summary(src, 'lib.rs')).toEqual([
      ['a', 'skipped', ['skip-static']],
      ['b', 'conditional', ['conditional-builtin']],
      ['c', 'strong', []],
      ['d', 'weak', ['no-assertion', 'no-throw-only']],
      ['e', 'strong', []],
      ['g', 'weak', ['trivial-assertion']],
    ]);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('rust: proptest! sets property', () => {
    const src = ['proptest! {', '    #[test]', '    fn adds(a in 0..10, b in 0..10) {', '        prop_assert_eq!(a + b, b + a);', '    }', '}', ''].join('\n');
    expect(one(src, 'lib.rs')).toMatchObject({ class: 'strong', property: true });
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('rust: lifetimes and char literals do not derail brace matching', () => {
    const src = ["#[test]", "fn a() { let c = '{'; let s: &'static str = \"}\"; assert_eq!(f(c, s), 1); }", ''].join('\n');
    expect(one(src, 'lib.rs').class).toBe('strong');
  });
});

describe('jvm', () => {
  // [claims: capabilities/test-strength#skip-detected]
  it('jvm: @Disabled, @Ignore, @Test(enabled=false), class-level @Disabled are skipped', () => {
    const src = [
      'class A {',
      '  @Test @Disabled',
      '  void a() { assertEquals(1, f()); }',
      '  @Test @Ignore("x")',
      '  public void b() { assertEquals(1, f()); }',
      '  @Test(enabled = false)',
      '  public void c() { assertEquals(1, f()); }',
      '  @Test',
      '  void d() { assertEquals(1, f()); }',
      '}',
      '@Disabled',
      'class B {',
      '  @Test',
      '  void e() { assertEquals(1, f()); }',
      '}',
    ].join('\n');
    expect(summary(src, 'A.java')).toEqual([
      ['a', 'skipped', ['disabled-annotation']],
      ['b', 'skipped', ['disabled-annotation']],
      ['c', 'skipped', ['disabled-annotation']],
      ['d', 'strong', []],
      ['e', 'skipped', ['disabled-annotation']],
    ]);
  });

  // [claims: capabilities/test-strength#conditional-gates]
  it('jvm: @EnabledIfEnvironmentVariable and Assumptions.assumeTrue are conditional', () => {
    const src = [
      'class A {',
      '  @Test @EnabledIfEnvironmentVariable(named = "CI", matches = ".*")',
      '  void a() { assertEquals(1, f()); }',
      '  @Test',
      '  void b() { Assumptions.assumeTrue(ready()); assertEquals(1, f()); }',
      '}',
    ].join('\n');
    expect(summary(src, 'A.java')).toEqual([
      ['a', 'conditional', ['conditional-builtin']],
      ['b', 'conditional', ['assumption']],
    ]);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('jvm: assertEquals strong; sole assertNotNull weak; assertThat(x) without matcher trivial', () => {
    const src = [
      'class A {',
      '  @Test void a() { assertEquals(2, f()); }',
      '  @Test void b() { assertNotNull(f()); }',
      '  @Test void c() { assertThat(f()); }',
      '  @Test void d() { assertThat(f()).isEqualTo(2); }',
      '  @Test void e() { assertThat(f()).isNotNull(); }',
      '  @Test void f2() { assertThat(f(), is(equalTo(2))); }',
      '}',
    ].join('\n');
    expect(summary(src, 'A.java')).toEqual([
      ['a', 'strong', []],
      ['b', 'weak', ['existence-only']],
      ['c', 'weak', ['trivial-assertion']],
      ['d', 'strong', []],
      ['e', 'weak', ['existence-only']],
      ['f2', 'strong', []],
    ]);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('jvm: assertThatThrownBy(...).hasMessage strong; Mockito verify with literal args strong', () => {
    const src = [
      'class A {',
      '  @Test void a() { assertThatThrownBy(() -> f()).hasMessage("boom"); }',
      '  @Test void b() { verify(mock).save(user); }',
      '  @Test void c() { verify(mock).save(any()); }',
      '}',
    ].join('\n');
    const out = analyze(src, 'A.java');
    expect(out.map((t) => t.class)).toEqual(['strong', 'strong', 'strong']);
    expect(out[0]!.assertions[0]).toMatchObject({ kind: 'throws', strength: 3 });
    expect(out[1]!.assertions[0]).toMatchObject({ kind: 'mock-verify', strength: 3 });
    expect(out[2]!.assertions[0]).toMatchObject({ kind: 'mock-verify', strength: 2 });
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('kotlin: shouldBe strong; backtick method names', () => {
    const src = ['class A {', '  @Test', '  fun `adds two numbers`() {', '    add(1, 2) shouldBe 3', '  }', '  @Test fun noAssert() { add(1, 2) }', '}'].join('\n');
    expect(summary(src, 'A.kt')).toEqual([
      ['adds two numbers', 'strong', []],
      ['noAssert', 'weak', ['no-assertion']],
    ]);
  });

  // [claims: capabilities/test-strength#weak-assertions]
  it('jvm: @Test(expected=) is throws; jqwik @Property sets property', () => {
    const src = [
      'class A {',
      '  @Test(expected = IllegalStateException.class)',
      '  public void a() { f(); }',
      '  @Property',
      '  void b(@ForAll int x) { assertEquals(x, x + 0); }',
      '}',
    ].join('\n');
    const out = analyze(src, 'A.java');
    expect(out[0]).toMatchObject({ class: 'strong' });
    expect(out[0]!.assertions[0]).toMatchObject({ kind: 'throws', strength: 2 });
    expect(out[1]).toMatchObject({ class: 'strong', property: true });
  });
});

describe('unknowns and results', () => {
  // [claims: capabilities/test-strength#no-assertion-weak]
  it('unsupported extension is unknown/unsupported-language; unbalanced braces unparsable-body', () => {
    expect(analyze("it('a', () => { expect(1).toBe(1); });", 'a_spec.rb')).toMatchObject([{ class: 'unknown', reasons: ['unsupported-language'], language: 'other' }]);
    expect(one("it('a', () => { expect(f()).toBe(1);\n", 'a.test.ts')).toMatchObject({ class: 'unknown', reasons: ['unparsable-body'] });
    expect(one('func TestA(t *testing.T) {\n\tf()\n', 'a_test.go')).toMatchObject({ class: 'unknown', reasons: ['unparsable-body'] });
  });

  // [claims: capabilities/test-strength#skip-detected]
  it('applyResultStatus(skip) turns strong into skipped/skip-result and keeps static reasons', () => {
    const strong = one("it('a', () => { expect(f()).toBe(1); });", 'a.test.ts');
    expect(applyResultStatus(strong, 'skip')).toMatchObject({ class: 'skipped', reasons: ['skip-result'] });
    expect(applyResultStatus(strong, 'pass')).toBe(strong);
    expect(applyResultStatus(strong, undefined)).toBe(strong);
    const skipped = one("it.skip('a', () => {});", 'a.test.ts');
    expect(applyResultStatus(skipped, 'skip').reasons).toEqual(['skip-static']);
  });

  // [claims: capabilities/test-strength#claim-layer-rule]
  it('collects claim tags above a test, through decorators', () => {
    const src = ['# [claims: capabilities/x#a, capabilities/x#b]', '@pytest.mark.slow', 'def test_a():', '    assert f() == 1', ''].join('\n');
    expect(one(src, 'test_x.py').claims).toEqual(['capabilities/x#a', 'capabilities/x#b']);
    const js = "// [claims: capabilities/x#a]\nit('a', () => { expect(f()).toBe(1); });\n// [claims: capabilities/x#b]\nit('b', () => { expect(f()).toBe(1); });";
    expect(analyze(js, 'a.test.ts').map((t) => t.claims)).toEqual([['capabilities/x#a'], ['capabilities/x#b']]);
  });
});

describe('claimStrength', () => {
  const t = (cls: TestStrength['class'], title = 't', over: Partial<TestStrength> = {}): TestStrength => ({
    test: { file: 'a.test.ts', line: 1, title },
    language: 'js',
    class: cls,
    reasons: [],
    assertions: [],
    property: false,
    conditions: [],
    body: [1, 1],
    claims: [],
    wildcards: 0,
    ...over,
  });

  // [claims: capabilities/test-strength#claim-layer-rule]
  it('claimStrength: no tests -> NO_TAGGED_TESTS', () => {
    expect(claimStrength('c#a', [], [])).toMatchObject({ meaningful: false, reasons: [{ code: 'NO_TAGGED_TESTS' }] });
    expect(claimStrength('c#a', [], ['unit'])).toMatchObject({ meaningful: false, reasons: [{ code: 'NO_TAGGED_TESTS' }] });
  });

  // [claims: capabilities/test-strength#claim-layer-rule]
  it('claimStrength: strong unit + weak e2e with e2e required -> LAYER_NOT_MEANINGFUL(e2e)', () => {
    const r = claimStrength('c#a', [{ strength: t('strong'), layer: 'unit' }, { strength: t('weak'), layer: 'e2e' }], ['unit', 'e2e']);
    expect(r.meaningful).toBe(false);
    expect(r.reasons).toEqual([{ code: 'LAYER_NOT_MEANINGFUL', layer: 'e2e' }]);
    expect(r.perLayer.unit?.strong).toHaveLength(1);
    expect(r.perLayer.e2e?.weak).toHaveLength(1);
    expect(claimStrength('c#a', [{ strength: t('strong'), layer: 'unit' }, { strength: t('strong'), layer: 'e2e' }], ['unit', 'e2e']).meaningful).toBe(true);
  });

  // [claims: capabilities/test-strength#claim-layer-rule]
  it('claimStrength: no required layers -> any strong test suffices', () => {
    const r = claimStrength('c#a', [{ strength: t('weak'), layer: 'unit' }, { strength: t('strong', 's', { property: true }), layer: 'e2e' }], []);
    expect(r).toMatchObject({ meaningful: true, property: true });
    expect(r.perLayer.any?.strong).toHaveLength(1);
  });

  // [claims: capabilities/test-strength#claim-layer-rule]
  it('claimStrength: functional layer requirement is ignored', () => {
    expect(claimStrength('c#a', [{ strength: t('strong'), layer: 'unit' }], ['functional']).meaningful).toBe(true);
    expect(claimStrength('c#a', [{ strength: t('strong'), layer: 'unit' }], ['unit', 'functional']).meaningful).toBe(true);
  });

  // [claims: capabilities/test-strength#claim-layer-rule]
  it('claimStrength: conditional-only, all-skipped and weak-only reasons', () => {
    expect(claimStrength('c#a', [{ strength: t('skipped'), layer: 'unit' }], []).reasons).toEqual([{ code: 'ALL_SKIPPED' }]);
    expect(claimStrength('c#a', [{ strength: t('skipped'), layer: 'unit' }, { strength: t('conditional'), layer: 'unit' }], []).reasons).toEqual([{ code: 'CONDITIONAL_ONLY' }]);
    expect(claimStrength('c#a', [{ strength: t('skipped'), layer: 'unit' }, { strength: t('weak'), layer: 'unit' }], ['unit']).reasons).toEqual([
      { code: 'WEAK_ONLY' },
      { code: 'LAYER_NOT_MEANINGFUL', layer: 'unit' },
    ]);
  });

  // [claims: capabilities/test-strength#claim-layer-rule]
  it('claimStrength: only unknown tests -> unknown', () => {
    const r = claimStrength('c#a', [{ strength: t('unknown'), layer: 'unit' }], []);
    expect(r).toMatchObject({ meaningful: 'unknown', reasons: [{ code: 'STRENGTH_UNKNOWN' }] });
    expect(claimStrength('c#a', [{ strength: t('unknown'), layer: 'unit' }, { strength: t('weak'), layer: 'unit' }], []).meaningful).toBe('unknown');
  });
});

describe('diffTestFile', () => {
  const live = new Set(['c#a']);
  const c = cfg();
  const diff = (before: string | undefined, after: string | undefined, file = 'a.test.ts'): string[] => diffTestFile(before, after, file, c, live).map((f) => `${f.kind}:${f.severity}`);
  const T = (body: string, tag = '// [claims: c#a]'): string => `${tag}\nit('x', () => { ${body} });`;

  // [claims: capabilities/test-strength#weakening-tests]
  it('diffTestFile: assertion removed; toEqual -> toBeDefined weakened; wildcard added', () => {
    expect(diff(T('expect(f()).toEqual(1); expect(g()).toEqual(2);'), T('expect(f()).toEqual(1);'))).toEqual(['assertions-removed:error']);
    expect(diff(T('expect(f()).toEqual(1);'), T('expect(f()).toContain(1);'))).toEqual(['assertion-weakened:error']);
    expect(diff(T('expect(f()).toEqual(1);'), T('expect(f()).toEqual({ a: expect.any(Number) });'))).toEqual(['wildcard-added:warn']);
    const weakened = diffTestFile(T('expect(f()).toEqual(1);'), T('expect(f()).toBeDefined();'), 'a.test.ts', c, live).map((f) => f.kind);
    expect(weakened).toEqual(['became-weak', 'assertions-removed']);
  });

  // [claims: capabilities/test-strength#weakening-tests]
  it('diffTestFile: skip added; only added; became weak', () => {
    expect(diff(T('expect(f()).toEqual(1);'), T('expect(f()).toEqual(1);').replace("it('x'", "it.skip('x'"))).toEqual(['skip-added:error']);
    expect(diff(T('expect(f()).toEqual(1);'), T('expect(f()).toEqual(1);').replace("it('x'", "it.skipIf(ci)('x'"))).toEqual(['conditional-added:error']);
    const only = `${T('expect(f()).toEqual(1);')}\nit('y', () => { expect(g()).toEqual(1); });`;
    const before = only;
    const after = only.replace("it('x'", "it.only('x'");
    const found = diffTestFile(before, after, 'a.test.ts', c, live);
    expect(found.map((f) => f.kind)).toEqual(['focus-added']);
    expect(found[0]!.severity).toBe('error');
    expect(diff(T('expect(f()).toEqual(1);'), T('f();'))).toContain('became-weak:error');
  });

  // [claims: capabilities/test-strength#weakening-tests]
  it('diffTestFile: tagged test removed is error, rename with same tags is warn', () => {
    const before = T('expect(f()).toEqual(1);');
    expect(diff(before, '')).toEqual(['test-removed:error']);
    expect(diff(before, undefined)).toEqual(['test-removed:error']);
    const renamed = before.replace("it('x'", "it('renamed'");
    expect(diff(before, renamed)).toEqual(['test-removed:warn']);
  });

  // [claims: capabilities/test-strength#weakening-tests]
  it('diffTestFile: tag removed while claim live is error; claim deleted is no finding', () => {
    const before = T('expect(f()).toEqual(1);');
    const after = T('expect(f()).toEqual(1);', '// no tag');
    expect(diff(before, after)).toEqual(['tag-removed:error']);
    expect(diffTestFile(before, after, 'a.test.ts', c, new Set())).toEqual([]);
  });

  // [claims: capabilities/test-strength#weakening-tests]
  it('diffTestFile: identical files, added tests and untagged tests produce nothing', () => {
    const a = T('expect(f()).toEqual(1);');
    expect(diff(a, a)).toEqual([]);
    expect(diff(a, `${a}\nit('new', () => { f(); });`)).toEqual([]);
    expect(diff(undefined, a)).toEqual([]);
    expect(diff("it('u', () => { expect(f()).toEqual(1); });", "it('u', () => { f(); });")).toEqual([]);
  });
});

describe('testStrength config block', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const configWith = async (extra: Record<string, unknown>, appTest?: Record<string, unknown>) => {
    const root = mkdtempSync(path.join(tmpdir(), 'specguard-ts-'));
    dirs.push(root);
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    const app = { name: 'a', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/', ...(appTest ? { test: appTest } : {}) };
    writeFileSync(path.join(root, '.specguard', 'config.json'), JSON.stringify({ apps: [app], llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' }, ...extra }));
    return loadConfig(root);
  };

  // [claims: capabilities/test-strength#conditional-gates]
  it('loads testStrength and the per-app test.conditional, and resolves them together', async () => {
    const config = await configWith({ testStrength: { conditional: ['RUN_X'], assertHelpers: ['expectOk*'], snapshotIsWeak: false } }, { conditional: ['@Tag\\("slow"\\)'] });
    expect(config.testStrength).toEqual({ conditional: ['RUN_X'], assertHelpers: ['expectOk*'], snapshotIsWeak: false });
    const resolved = resolveStrengthConfig(config.testStrength, config.apps[0]?.test);
    expect(resolved).toEqual({ conditional: ['RUN_X', '@Tag\\("slow"\\)'], assertHelpers: ['expectOk*'], snapshotIsWeak: false });
  });

  // [claims: capabilities/test-strength#conditional-gates]
  it('rejects a conditional that is not a valid regular expression', async () => {
    await expect(configWith({ testStrength: { conditional: ['('] } })).rejects.toBeInstanceOf(ConfigInvalidError);
    await expect(configWith({}, { conditional: ['[a'] })).rejects.toBeInstanceOf(ConfigInvalidError);
  });
});
