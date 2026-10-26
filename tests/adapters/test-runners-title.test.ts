import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ADAPTERS, escapeRegex, maxTitleFlagLength, prepareRun, type TitleContext } from '../../src/adapters/test-runners.js';

/** What the shell hands the runner: the flag string parsed by sh into argv (argument arrays, no interpolation survives). */
function argv(flags: string): string[] {
  const res = spawnSync('sh', ['-c', `node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${flags}`], { encoding: 'utf8' });
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout) as string[];
}

const TRICKY = [
  'handles a.b (and [c]) * + ? ^$ | \\ / {1,2}',
  `it's "quoted" and \`ticked\``,
  'unicode: 日本語 café 🚀',
  '$(touch /tmp/pwned) ; rm -rf ~ && `id`',
  'percent 100% and #hash and = equals',
  'multi word title',
];

const names = (describes: string[], title: string): string => [...describes, title].join(' ');

describe('titleFlags: title selection per runner [title-selection]', () => {
  // [claims: capabilities/conformance-testing#title-selection-per-runner]
  it('vitest and jest select by an anchored, escaped alternation that matches the full name and nothing else', () => {
    for (const id of ['vitest', 'jest'] as const) {
      const flags = ADAPTERS[id].titleFlags(['awards once', 'no dupes'])!;
      const [flag, pattern] = argv(flags);
      expect(flag).toBe('-t');
      const re = new RegExp(pattern);
      expect(re.test('awards once')).toBe(true);
      expect(re.test('awards describe awards once')).toBe(true);
      expect(re.test('no dupes')).toBe(true);
      expect(re.test('awards once more')).toBe(false);
      expect(re.test('xawards once')).toBe(false);
    }
  });

  // [claims: capabilities/conformance-testing#title-selection-per-runner]
  it('playwright uses --grep with the same pattern', () => {
    const [flag, pattern] = argv(ADAPTERS.playwright.titleFlags(['logs in'])!);
    expect(flag).toBe('--grep');
    expect(new RegExp(pattern).test('chromium login.spec.ts Auth logs in')).toBe(true);
    expect(new RegExp(pattern).test('chromium login.spec.ts Auth logs in twice')).toBe(false);
  });

  // [claims: capabilities/conformance-testing#title-selection-per-runner]
  it('pytest selects with -k over the test function names', () => {
    expect(argv(ADAPTERS.pytest.titleFlags(['test_a', 'test_b'])!)).toEqual(['-k', 'test_a or test_b']);
  });

  // [claims: capabilities/conformance-testing#title-selection-per-runner]
  it('go selects with an anchored -run alternation', () => {
    expect(argv(ADAPTERS.go.titleFlags(['TestA', 'TestB'])!)).toEqual(['-run', '^(TestA|TestB)$']);
  });

  // [claims: capabilities/conformance-testing#title-selection-per-runner]
  it('cargo passes the names as test-binary filters', () => {
    expect(argv(ADAPTERS.cargo.titleFlags(['a_test', 'mod_x::b_test'])!)).toEqual(['a_test', 'mod_x::b_test']);
  });

  // [claims: capabilities/conformance-testing#title-selection-per-runner]
  it('maven selects Class#method, gradle --tests, from the declaration the title came from', () => {
    const ctx: TitleContext = {
      tests: [
        { file: 'src/test/java/com/acme/AwardsTest.java', title: 'awards once', method: 'awardsOnce' },
        { file: 'src/test/java/com/acme/AwardsTest.java', title: 'rejects dupes', method: 'rejectsDupes' },
        { file: 'src/test/java/com/acme/CartTest.java', title: 'totals', method: 'totals' },
      ],
    };
    const titles = ['awards once', 'rejects dupes', 'totals'];
    expect(argv(ADAPTERS.junit.titleFlags(titles, ctx)!)).toEqual([
      '-Dtest=AwardsTest#awardsOnce+rejectsDupes,CartTest#totals',
      '-Dsurefire.failIfNoSpecifiedTests=false',
      '-DfailIfNoTests=false',
    ]);
    expect(argv(ADAPTERS.junit.titleFlags(['awards once'], { ...ctx, command: './gradlew test' })!)).toEqual(['--tests', 'com.acme.AwardsTest.awardsOnce']);
    // outside src/<set>/java the package is unknown: match any package
    expect(argv(ADAPTERS.junit.titleFlags(['t'], { command: 'gradle test', tests: [{ file: 'Odd.kt', title: 't', method: 'm' }] })!)).toEqual(['--tests', '*Odd.m']);
  });

  // [claims: capabilities/conformance-testing#title-selection-per-runner]
  it('puts the flags in the command in the place each runner reads them', () => {
    const run = (id: keyof typeof ADAPTERS, opts: Record<string, unknown> = {}) =>
      prepareRun(ADAPTERS[id], { cwd: '/repo', titles: ['TestA', 'a_test'], ...opts }, '/repo/.specguard/runs/x');
    const go = run('go', { selection: ['./pkg'], titles: ['TestA', 'TestB'] });
    expect(go.command).toBe("go test -json -run '^(TestA|TestB)$' ./pkg > /repo/.specguard/runs/x/results.jsonl");
    expect(go.selection).toBe('tests');
    // 'a_test' is not a Go test name, so go cannot select by title: files only, never a guess
    expect(run('go', { selection: ['./pkg'] }).selection).toBe('files');
    const cargo = run('cargo', { titles: ['a_test'] });
    expect(cargo.command).toBe('cargo test -- -Z unstable-options --format json a_test > /repo/.specguard/runs/x/results.jsonl');
    expect(cargo.selection).toBe('tests');
    const vitest = prepareRun(ADAPTERS.vitest, { cwd: '/repo', command: 'npm test', titles: ['one'], selection: ['a.test.ts'] }, '/r');
    expect(vitest.command).toBe("npm test -- --reporter=json --outputFile=/r/results.json -t '(?:^|\\s)(?:one)$' a.test.ts");
    expect(vitest.selection).toBe('tests');
  });
});

describe('titleFlags: tricky titles and limits [title-safety]', () => {
  // [claims: capabilities/conformance-testing#title-selection-safe-quoting]
  it('hands regex metacharacters, quotes, unicode and shell syntax to the runner as one literal pattern', () => {
    for (const id of ['vitest', 'jest', 'playwright'] as const) {
      const flags = ADAPTERS[id].titleFlags(TRICKY)!;
      const out = argv(flags);
      expect(out).toHaveLength(2);
      const re = new RegExp(out[1]);
      for (const title of TRICKY) {
        expect(re.test(names(['outer describe', 'inner'], title))).toBe(true);
        expect(re.test(`${names([], title)} extra`)).toBe(false);
      }
    }
  });

  // [claims: capabilities/conformance-testing#title-selection-safe-quoting]
  it('does not run anything a title contains', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-title-'));
    const marker = path.join(dir, 'pwned');
    const flags = ADAPTERS.vitest.titleFlags([`$(touch ${marker}) \`touch ${marker}\` ; touch ${marker}`])!;
    const out = argv(flags);
    expect(out[1]).toContain('touch');
    expect(existsSync(marker)).toBe(false);
  });

  // [claims: capabilities/conformance-testing#title-selection-safe-quoting]
  it('escapes every regex metacharacter', () => {
    const text = '.*+?^${}()|[]\\/';
    expect(new RegExp(`^${escapeRegex(text)}$`).test(text)).toBe(true);
    expect(new RegExp(`^${escapeRegex('a.c')}$`).test('abc')).toBe(false);
  });

  // [claims: capabilities/conformance-testing#title-selection-safe-quoting]
  it('selects a very long list when it fits one command line, and says unknown when it does not', () => {
    const fits = Array.from({ length: 300 }, (_, i) => `test number ${i} of a long list`);
    const flags = ADAPTERS.vitest.titleFlags(fits)!;
    expect(flags.length).toBeLessThan(maxTitleFlagLength());
    expect(new RegExp(argv(flags)[1]).test('x test number 299 of a long list')).toBe(true);
    const tooMany = Array.from({ length: 20_000 }, (_, i) => `test number ${i} of a long list`);
    for (const id of ['vitest', 'jest', 'playwright', 'pytest', 'go', 'cargo'] as const) expect(ADAPTERS[id].titleFlags(tooMany)).toBeUndefined();
    expect(maxTitleFlagLength('win32')).toBeLessThan(8191);
  });

  // [claims: capabilities/conformance-testing#title-selection-safe-quoting]
  it('says unknown for a title the shell cannot be given', () => {
    expect(ADAPTERS.vitest.titleFlags(['nul \0 inside'])).toBeUndefined();
  });

  // [claims: capabilities/conformance-testing#title-selection-safe-quoting]
  it('de-duplicates titles and ignores empty ones', () => {
    expect(argv(ADAPTERS.vitest.titleFlags(['a', 'a', ''])!)).toEqual(['-t', '(?:^|\\s)(?:a)$']);
  });
});

describe('titleFlags: runners that cannot select [title-unknown]', () => {
  // [claims: capabilities/conformance-testing#title-unsupported-unknown]
  it('every runner says unknown for an empty list', () => {
    for (const adapter of Object.values(ADAPTERS)) expect(adapter.titleFlags([])).toBeUndefined();
  });

  // [claims: capabilities/conformance-testing#title-unsupported-unknown]
  it('pytest, go and cargo say unknown for a title that is not a name they can filter on', () => {
    expect(ADAPTERS.pytest.titleFlags(['does something'])).toBeUndefined();
    expect(ADAPTERS.pytest.titleFlags(['or'])).toBeUndefined();
    expect(ADAPTERS.pytest.titleFlags(['test_ok', 'not ok'])).toBeUndefined();
    expect(ADAPTERS.go.titleFlags(['helper'])).toBeUndefined();
    expect(ADAPTERS.go.titleFlags(['TestA', 'Test B'])).toBeUndefined();
    expect(ADAPTERS.cargo.titleFlags(['--exact'])).toBeUndefined();
    expect(ADAPTERS.cargo.titleFlags(['has space'])).toBeUndefined();
  });

  // [claims: capabilities/conformance-testing#title-unsupported-unknown]
  it('junit says unknown without the class and method of every title', () => {
    expect(ADAPTERS.junit.titleFlags(['a'])).toBeUndefined();
    expect(ADAPTERS.junit.titleFlags(['a'], { tests: [{ file: 'A.java', title: 'other', method: 'm' }] })).toBeUndefined();
    expect(ADAPTERS.junit.titleFlags(['a'], { tests: [{ file: 'A.java', title: 'a' }] })).toBeUndefined();
    expect(ADAPTERS.junit.titleFlags(['a'], { tests: [{ file: 'A.java', title: 'a', method: 'bad name' }] })).toBeUndefined();
    expect(ADAPTERS.junit.titleFlags(['a'], { tests: [{ file: 'notes.txt', title: 'a', method: 'm' }] })).toBeUndefined();
  });

  // [claims: capabilities/conformance-testing#title-unsupported-unknown]
  it('prepareRun reports files, or the whole suite, when the runner could not select by title', () => {
    const files = prepareRun(ADAPTERS.pytest, { cwd: '/r', titles: ['not an identifier'], selection: ['tests/test_a.py'] }, '/r/x');
    expect(files.selection).toBe('files');
    expect(files.command).toBe('pytest --junitxml=/r/x/results.xml tests/test_a.py');
    const suite = prepareRun(ADAPTERS.junit, { cwd: '/r', titles: ['a'] }, '/r/x');
    expect(suite.selection).toBe('suite');
  });
});
