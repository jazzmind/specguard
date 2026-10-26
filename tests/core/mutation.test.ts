import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import type { PathContext } from '../../src/core/coverage.js';
import type { ChangedFile } from '../../src/core/diff-lines.js';
import {
  MutationParseError,
  buildTestKeyIndex,
  detectMutationFormat,
  mergeMutationReports,
  meetsMutationPolicy,
  parseMutationReport,
  parsePitTestName,
  parsePitXml,
  parseStrykerReport,
  resolveMutationPolicy,
  scoreMutation,
  type Mutant,
  type MutationPolicy,
  type MutationReport,
  type MutationTest,
} from '../../src/core/mutation.js';

const ctx: PathContext = { rootDir: '/work/app', repoFiles: new Set(['src/cart.ts', 'src/tax.ts', 'src/main/java/com/acme/Cart.java']) };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const SOURCE = 'export const total = () => 1;\n';

function strykerJson(over: { testFiles?: boolean; coveredBy?: boolean; extraKiller?: boolean } = {}): string {
  const { testFiles = true, coveredBy = true, extraKiller = false } = over;
  const m = (id: string, status: string, line: number, extra: Record<string, unknown> = {}) => ({
    id,
    mutatorName: 'ArithmeticOperator',
    replacement: '-',
    location: { start: { line, column: 1 }, end: { line: line + 1, column: 4 } },
    status,
    ...(coveredBy ? { coveredBy: ['t1', 't2'] } : {}),
    ...extra,
  });
  return JSON.stringify({
    schemaVersion: '1',
    thresholds: { high: 80, low: 60 },
    files: {
      'src/cart.ts': {
        language: 'typescript',
        source: SOURCE,
        mutants: [
          m('1', 'Killed', 3, { killedBy: extraKiller ? ['t1', 't2'] : ['t1'] }),
          m('2', 'Survived', 5),
          m('3', 'NoCoverage', 7, coveredBy ? { coveredBy: [] } : {}),
          m('4', 'Timeout', 9),
          m('5', 'CompileError', 11),
          m('6', 'RuntimeError', 13),
          m('7', 'Ignored', 15),
          m('8', 'Pending', 17),
        ],
      },
      '/elsewhere/lib.ts': { language: 'typescript', source: '', mutants: [m('9', 'Killed', 1, { killedBy: ['t1'] })] },
    },
    ...(testFiles
      ? { testFiles: { 'tests/cart.test.ts': { tests: [{ id: 't1', name: 'Cart sums prices' }, { id: 't2', name: 'Cart applies tax' }] } } }
      : {}),
  });
}

const PIT = `<?xml version="1.0" encoding="UTF-8"?>
<mutations partial="true">
<mutation detected='true' status='KILLED' numberOfTestsRun='2'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>total</mutatedMethod><methodDescription>()I</methodDescription><lineNumber>12</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>4</index></indexes><blocks><block>1</block></blocks><killingTest>com.acme.CartTest.[engine:junit-jupiter]/[class:com.acme.CartTest]/[method:totalSumsPrices()]</killingTest><description>Replaced integer addition with subtraction</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>total</mutatedMethod><methodDescription>()I</methodDescription><lineNumber>14</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.ReturnValsMutator</mutator><indexes><index>5</index></indexes><blocks><block>2</block></blocks><killingTest/><description>replaced int return with 0</description></mutation>
<mutation detected='false' status='NO_COVERAGE' numberOfTestsRun='0'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart$Inner</mutatedClass><mutatedMethod>x</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>30</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.VoidMethodCallMutator</mutator><indexes><index>1</index></indexes><blocks><block>0</block></blocks><killingTest/><description>removed call</description></mutation>
<mutation detected='true' status='TIMED_OUT' numberOfTestsRun='1'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>loop</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>20</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.NegateConditionalsMutator</mutator><indexes><index>1</index></indexes><blocks><block>0</block></blocks><killingTest/><description>negated</description></mutation>
<mutation detected='true' status='MEMORY_ERROR' numberOfTestsRun='1'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>loop</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>21</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>2</index></indexes><blocks><block>0</block></blocks><killingTest/><description>oom</description></mutation>
<mutation detected='false' status='RUN_ERROR' numberOfTestsRun='0'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>m</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>22</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>3</index></indexes><blocks><block>0</block></blocks><killingTest/><description>err</description></mutation>
<mutation detected='false' status='NON_VIABLE' numberOfTestsRun='0'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>m</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>23</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>4</index></indexes><blocks><block>0</block></blocks><killingTest/><description>nv</description></mutation>
<mutation detected='true' status='KILLED' numberOfTestsRun='1'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>old</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>40</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>5</index></indexes><blocks><block>0</block></blocks><killingTest>com.acme.OldTest.sums(com.acme.OldTest)</killingTest><description>x &amp; y</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Missing.java</sourceFile><mutatedClass>com.acme.Missing</mutatedClass><mutatedMethod>m</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>1</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>1</index></indexes><blocks><block>0</block></blocks><killingTest/><description>m</description></mutation>
</mutations>`;

const PIT_MATRIX = `<mutations>
<mutation detected='true' status='KILLED' numberOfTestsRun='4'><sourceFile>Cart.java</sourceFile><mutatedClass>com.acme.Cart</mutatedClass><mutatedMethod>total</mutatedMethod><methodDescription>()I</methodDescription><lineNumber>12</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>4</index></indexes><blocks><block>1</block></blocks><killingTests>com.acme.CartTest.a(com.acme.CartTest)|com.acme.CartTest.b(com.acme.CartTest)</killingTests><succeedingTests>com.acme.CartTest.c(com.acme.CartTest)</succeedingTests><description>d</description></mutation>
</mutations>`;

describe('stryker report [coverage-and-mutation]', () => {
  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('every status mapped; killedBy resolved via testFiles; unmapped paths listed', () => {
    const r = parseStrykerReport(strykerJson(), ctx);
    expect(r.tool).toBe('stryker');
    expect(r.mutants.map((m) => [m.id, m.status])).toEqual([
      ['1', 'killed'],
      ['2', 'survived'],
      ['3', 'no-coverage'],
      ['4', 'timeout'],
      ['5', 'invalid'],
      ['6', 'invalid'],
      ['7', 'ignored'],
      ['8', 'pending'],
    ]);
    expect(r.mutants[0]).toMatchObject({ file: 'src/cart.ts', line: 3, endLine: 4, mutator: 'ArithmeticOperator', replacement: '-', killedBy: ['t1'] });
    expect(r.tests.t1).toEqual({ id: 't1', file: 'tests/cart.test.ts', name: 'Cart sums prices' });
    expect(r.unmapped).toEqual(['/elsewhere/lib.ts']);
    expect(r.mutants.some((m) => m.id === '9')).toBe(false);
  });

  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('legacy reports without testFiles use the killedBy strings as test names', () => {
    const r = parseStrykerReport(strykerJson({ testFiles: false }), ctx);
    expect(r.tests.t1).toEqual({ id: 't1', name: 't1' });
    expect(r.mutants[0].killedBy).toEqual(['t1']);
  });

  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('coveredBy presence -> per-test; more than one killer -> full; config full; source hashes recorded', () => {
    const base = parseStrykerReport(strykerJson(), ctx);
    expect(base).toMatchObject({ coverage: 'per-test', attribution: 'first-kill' });
    expect(base.sourceHashes).toEqual({ 'src/cart.ts': sha(SOURCE) });
    expect(parseStrykerReport(strykerJson({ coveredBy: false }), ctx).coverage).toBe('none');
    expect(parseStrykerReport(strykerJson({ extraKiller: true }), ctx).attribution).toBe('full');
    expect(parseStrykerReport(strykerJson(), ctx, { attribution: 'full' }).attribution).toBe('full');
  });

  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('rejects non-reports with MutationParseError and detects the format', () => {
    expect(() => parseStrykerReport('{', ctx)).toThrow(MutationParseError);
    expect(() => parseStrykerReport('{"nothing":1}', ctx)).toThrow(MutationParseError);
    expect(() => parseMutationReport('hello', ctx)).toThrow(MutationParseError);
    expect(detectMutationFormat(strykerJson())).toBe('stryker');
    expect(detectMutationFormat(PIT)).toBe('pit');
    expect(detectMutationFormat('junk')).toBeNull();
    expect(parseMutationReport(PIT, ctx).tool).toBe('pit');
  });
});

describe('pit report [coverage-and-mutation]', () => {
  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('statuses mapped; killingTest JUnit 5 and JUnit 4 names; unmapped class listed', () => {
    const r = parsePitXml(PIT, ctx);
    expect(r.tool).toBe('pit');
    expect(r.mutants.map((m) => m.status)).toEqual(['killed', 'survived', 'timeout', 'timeout', 'invalid', 'invalid', 'no-coverage', 'killed']);
    expect(r.mutants[0]).toMatchObject({ file: 'src/main/java/com/acme/Cart.java', line: 12, mutator: 'MathMutator', replacement: 'Replaced integer addition with subtraction' });
    const jupiter = r.tests[r.mutants[0].killedBy[0]];
    expect(jupiter).toMatchObject({ className: 'com.acme.CartTest', method: 'totalSumsPrices', name: 'totalSumsPrices' });
    const junit4 = r.tests['com.acme.OldTest.sums(com.acme.OldTest)'];
    expect(junit4).toMatchObject({ className: 'com.acme.OldTest', method: 'sums' });
    expect(r.mutants.find((m) => m.line === 40)?.replacement).toBe('x & y');
    expect(r.unmapped).toEqual(['com/acme/Missing.java']);
    expect(r).toMatchObject({ attribution: 'first-kill', coverage: 'none', sourceHashes: {} });
  });

  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('killingTests and succeedingTests (full matrix) -> full attribution and per-test coverage', () => {
    const r = parsePitXml(PIT_MATRIX, ctx);
    const m = r.mutants[0];
    expect(m.killedBy).toHaveLength(2);
    expect(m.coveredBy).toHaveLength(3);
    expect(r).toMatchObject({ attribution: 'full', coverage: 'per-test' });
  });

  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('mutatedClass + sourceFile mapped to the repo file, inner classes included; test templates give the method', () => {
    const r = parsePitXml(PIT, ctx);
    expect(r.mutants.find((m) => m.line === 30)?.file).toBe('src/main/java/com/acme/Cart.java');
    expect(parsePitTestName('com.acme.CartTest.[engine:junit-jupiter]/[class:com.acme.CartTest]/[test-template:rounds(double)]/[test-template-invocation:#2]')).toMatchObject({
      className: 'com.acme.CartTest',
      method: 'rounds',
    });
    expect(parsePitTestName('plain name')).toEqual({ id: 'plain name', name: 'plain name' });
  });

  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('merging reports prefixes ids so two packages do not collide, and refuses mixed tools', () => {
    const a = parseStrykerReport(strykerJson(), ctx);
    const merged = mergeMutationReports([a, a]);
    expect(merged.mutants).toHaveLength(a.mutants.length * 2);
    expect(new Set(merged.mutants.map((m) => m.id)).size).toBe(merged.mutants.length);
    expect(Object.keys(merged.tests)).toEqual(['0:t1', '0:t2', '1:t1', '1:t2']);
    expect(() => mergeMutationReports([a, parsePitXml(PIT, ctx)])).toThrow(MutationParseError);
    expect(mergeMutationReports([a])).toBe(a);
  });
});

describe('test to claim mapping [coverage-and-mutation]', () => {
  const decls = [
    { file: 'tests/cart.test.ts', title: 'sums prices', claims: ['capabilities/cart#total'] },
    { file: 'tests/cart.test.ts', title: 'applies tax', claims: ['capabilities/cart#tax'] },
    { file: 'src/test/java/com/acme/CartTest.java', title: 'totalSumsPrices', method: 'totalSumsPrices', claims: ['capabilities/cart#total'] },
    { file: 'tests/param.test.ts', title: 'rounds', claims: ['capabilities/cart#round'] },
    { file: 'tests/amb.test.ts', title: 'sums', claims: [] },
    { file: 'tests/amb.test.ts', title: 'adds sums', claims: [] },
  ];
  const index = buildTestKeyIndex(decls);
  const t = (over: Partial<MutationTest> & { name: string }): MutationTest => ({ id: over.name, ...over });

  // [claims: capabilities/coverage-and-mutation#tests-mapped-to-claims]
  it('file + title, describe-prefixed names, JVM method, parameterized suffix', () => {
    expect(index.keyOf(t({ name: 'sums prices', file: 'tests/cart.test.ts' }))).toBe('tests/cart.test.ts::sums prices');
    expect(index.keyOf(t({ name: 'Cart sums prices', file: 'tests/cart.test.ts' }))).toBe('tests/cart.test.ts::sums prices');
    expect(index.keyOf(t({ name: 'Cart applies tax', file: '/abs/repo/tests/cart.test.ts' }))).toBe('tests/cart.test.ts::applies tax');
    expect(index.keyOf(t({ name: 'Cart sums prices' }))).toBe('tests/cart.test.ts::sums prices');
    expect(index.keyOf(t({ name: 'totalSumsPrices', className: 'com.acme.CartTest', method: 'totalSumsPrices' }))).toBe('src/test/java/com/acme/CartTest.java::totalSumsPrices');
    expect(index.keyOf(t({ name: 'rounds [0.5]', file: 'tests/param.test.ts' }))).toBe('tests/param.test.ts::rounds');
    expect(index.keyOf(t({ name: 'rounds (1, 2)', file: 'tests/param.test.ts' }))).toBe('tests/param.test.ts::rounds');
    expect(index.claimsOf('tests/cart.test.ts::sums prices')).toEqual(['capabilities/cart#total']);
    expect(index.claimsOf('nope')).toEqual([]);
  });

  // [claims: capabilities/coverage-and-mutation#tests-mapped-to-claims]
  it('unmatched and ambiguous tests are listed and never guessed', () => {
    const ambiguous = t({ name: 'adds sums', file: 'tests/amb.test.ts' });
    const unknown = t({ name: 'something else', file: 'tests/cart.test.ts' });
    const wrongFile = t({ name: 'sums prices', file: 'tests/other.test.ts' });
    expect(index.keyOf(ambiguous)).toBeUndefined();
    expect(index.keyOf(unknown)).toBeUndefined();
    expect(index.keyOf(wrongFile)).toBeUndefined();
    expect(index.unmatched([unknown, ambiguous, t({ name: 'sums prices', file: 'tests/cart.test.ts' })]).map((x) => x.name)).toEqual(['adds sums', 'something else']);
  });
});

// A hand-built report: two tests, per-test coverage, one mutant of each status.
const K_TOTAL = 'tests/cart.test.ts::sums prices';
const K_TAX = 'tests/cart.test.ts::applies tax';
const keys = buildTestKeyIndex([
  { file: 'tests/cart.test.ts', title: 'sums prices', claims: [] },
  { file: 'tests/cart.test.ts', title: 'applies tax', claims: [] },
]);
const TESTS: Record<string, MutationTest> = {
  t1: { id: 't1', file: 'tests/cart.test.ts', name: 'sums prices' },
  t2: { id: 't2', file: 'tests/cart.test.ts', name: 'applies tax' },
};
const POLICY: MutationPolicy = { minScore: 70, minKilled: 1, timeoutAsKilled: true };
const CLAIMS = new Map([
  ['capabilities/cart#total', new Set([K_TOTAL])],
  ['capabilities/cart#tax', new Set([K_TAX])],
]);

function mut(id: string, status: Mutant['status'], line: number, over: Partial<Mutant> = {}): Mutant {
  return { id, file: 'src/cart.ts', line, endLine: line, mutator: 'Arith', status, killedBy: [], ...over };
}

function report(over: Partial<MutationReport> = {}): MutationReport {
  return {
    tool: 'stryker',
    mutants: [
      mut('m1', 'killed', 3, { killedBy: ['t1'], coveredBy: ['t1', 't2'] }),
      mut('m2', 'survived', 5, { coveredBy: ['t1'] }),
      mut('m3', 'killed', 8, { killedBy: ['t2'], coveredBy: ['t2'] }),
      mut('m4', 'no-coverage', 12, { coveredBy: [] }),
      mut('m5', 'timeout', 14, { coveredBy: ['t1'] }),
      mut('m6', 'ignored', 20),
      mut('m7', 'invalid', 21),
      mut('m8', 'pending', 22),
      mut('mx', 'killed', 1, { file: 'src/other.ts', killedBy: ['t1'], coveredBy: ['t1'] }),
    ],
    tests: TESTS,
    attribution: 'first-kill',
    coverage: 'per-test',
    sourceHashes: {},
    unmapped: [],
    warnings: [],
    ...over,
  };
}

function score(over: Partial<Parameters<typeof scoreMutation>[0]> = {}) {
  return scoreMutation({ report: report(), capability: 'cart', ownedFiles: ['src/cart.ts'], claimTests: CLAIMS, keys, currentHashes: {}, policy: POLICY, ...over });
}

const claim = (r: ReturnType<typeof score>, id: string) => r.claims.find((c) => c.ref === `capabilities/cart#${id}`)!;

function changedFile(file: string, added: number[], over: Partial<ChangedFile> = {}): ChangedFile {
  return { file, status: 'modified', added, removed: [], addedText: [], binary: false, ...over };
}

describe('mutation scoring [coverage-and-mutation]', () => {
  // [claims: capabilities/coverage-and-mutation#mutation-score-per-claim]
  it('per-test coverage claim score: killed over killed plus survived among mutants the claim tests cover', () => {
    const r = score();
    expect(claim(r, 'total')).toMatchObject({ considered: 3, killed: 2, survived: 1, unattributed: 0, score: 66.7, sensitive: true, scope: 'owned', stale: false, attribution: 'first-kill', coverage: 'per-test' });
    // m1 was killed by the other test (first-kill: unattributed), m3 by this one
    expect(claim(r, 'tax')).toMatchObject({ considered: 2, killed: 1, survived: 0, unattributed: 1, score: 100 });
    expect(claim(r, 'tax').limits.some((l) => l.includes('one killing test'))).toBe(true);
  });

  // [claims: capabilities/coverage-and-mutation#mutation-score-per-claim]
  it('full attribution: a mutant the claim tests covered and only others killed is a survivor for that claim', () => {
    const r = score({ report: report({ attribution: 'full' }) });
    expect(claim(r, 'tax')).toMatchObject({ killed: 1, survived: 1, unattributed: 0, score: 50 });
  });

  // [claims: capabilities/coverage-and-mutation#mutation-score-per-claim]
  it('without per-test coverage the claim score is null and only its own kills are counted', () => {
    const none = report({ coverage: 'none', mutants: report().mutants.map((m) => ({ ...m, coveredBy: undefined })) });
    const r = score({ report: none });
    expect(claim(r, 'total')).toMatchObject({ score: null, killed: 1, survived: 0, unattributed: 0, sensitive: true, coverage: 'none' });
    expect(claim(r, 'total').limits.some((l) => l.includes('per-test coverage'))).toBe(true);
  });

  // [claims: capabilities/coverage-and-mutation#mutation-score-per-claim]
  it('scope: owned files without a diff, only mutants whose line range meets an added line with one', () => {
    const multi = report({ mutants: [...report().mutants, mut('mr', 'killed', 4, { endLine: 6, killedBy: ['t1'], coveredBy: ['t1'] })] });
    const owned = score({ report: multi });
    expect(owned.capability).toMatchObject({ scope: 'owned', total: 9 });
    const diff = score({ report: multi, changed: [changedFile('src/cart.ts', [5]), changedFile('src/other.ts', [1])] });
    expect(diff.capability).toMatchObject({ scope: 'changed', total: 2, survived: 1, killed: 1 });
    expect(claim(diff, 'total')).toMatchObject({ scope: 'changed', considered: 2, killed: 1, survived: 1 });
    // a change that touches no owned code (a spec-only change) scores the owned files
    const specOnly = score({ changed: [changedFile('specs/capabilities/cart.md', [1])] });
    expect(specOnly.capability.scope).toBe('owned');
    const deleted = score({ changed: [changedFile('src/cart.ts', [], { status: 'deleted' })] });
    expect(deleted.capability.scope).toBe('owned');
  });

  // [claims: capabilities/coverage-and-mutation#mutation-edge-statuses]
  it('timeoutAsKilled on and off; ignored, invalid and pending are excluded from scores but counted', () => {
    const on = score();
    expect(on.capability).toMatchObject({ total: 8, killed: 2, survived: 1, noCoverage: 1, timeout: 1, ignored: 1, invalid: 1, pending: 1, score: 60 });
    const off = score({ policy: { ...POLICY, timeoutAsKilled: false } });
    expect(off.capability).toMatchObject({ timeout: 1, score: 50 });
    expect(claim(off, 'total')).toMatchObject({ considered: 2, killed: 1, survived: 1, score: 50 });
    expect(on.capability.survivors).toEqual([{ file: 'src/cart.ts', line: 5, mutator: 'Arith' }]);
  });

  // [claims: capabilities/coverage-and-mutation#mutation-edge-statuses]
  it('no-coverage counts against the capability score and is left out of every claim score', () => {
    const only = score({ report: report({ mutants: [mut('a', 'killed', 1, { killedBy: ['t1'], coveredBy: ['t1'] }), mut('b', 'no-coverage', 2, { coveredBy: [] })] }) });
    expect(only.capability).toMatchObject({ noCoverage: 1, score: 50 });
    expect(claim(only, 'total')).toMatchObject({ considered: 1, killed: 1, survived: 0, score: 100 });
  });

  // [claims: capabilities/coverage-and-mutation#evidence-staleness]
  it('a stale file is excluded and the claims whose tests touch it are stale', () => {
    const stale = report({
      sourceHashes: { 'src/cart.ts': 'old', 'src/tax.ts': 'old' },
      mutants: [...report().mutants, mut('s1', 'survived', 2, { file: 'src/tax.ts', coveredBy: ['t2'] })],
    });
    const r = score({ report: stale, ownedFiles: ['src/cart.ts', 'src/tax.ts'], currentHashes: { 'src/cart.ts': 'old', 'src/tax.ts': 'new' } });
    expect(r.capability.staleFiles).toEqual(['src/tax.ts']);
    expect(r.capability.total).toBe(8);
    expect(claim(r, 'tax').stale).toBe(true);
    expect(claim(r, 'total').stale).toBe(false);
    const gone = score({ report: stale, ownedFiles: ['src/cart.ts', 'src/tax.ts'], currentHashes: { 'src/cart.ts': 'old' } });
    expect(gone.capability.staleFiles).toEqual(['src/tax.ts']);
    const noCoverageInfo = score({ report: { ...stale, coverage: 'none' }, ownedFiles: ['src/cart.ts', 'src/tax.ts'], currentHashes: { 'src/cart.ts': 'old', 'src/tax.ts': 'new' } });
    expect(claim(noCoverageInfo, 'total').stale).toBe(true);
  });

  // [claims: capabilities/coverage-and-mutation#mutation-min-score]
  it('meetsMutationPolicy: NOT_KILLED, SCORE_LOW, STALE, and ok', () => {
    const r = score();
    expect(meetsMutationPolicy(claim(r, 'total'), POLICY)).toEqual({ ok: false, reason: 'SCORE_LOW' });
    expect(meetsMutationPolicy(claim(r, 'total'), { ...POLICY, minScore: 60 })).toEqual({ ok: true });
    expect(meetsMutationPolicy(claim(r, 'tax'), POLICY)).toEqual({ ok: true });
    expect(meetsMutationPolicy(claim(r, 'tax'), { ...POLICY, minKilled: 2 })).toEqual({ ok: false, reason: 'NOT_KILLED' });
    expect(meetsMutationPolicy({ ...claim(r, 'tax'), stale: true }, POLICY)).toEqual({ ok: false, reason: 'STALE' });
    const noKill = score({ report: report({ mutants: [mut('a', 'survived', 1, { coveredBy: ['t1'] })] }) });
    expect(meetsMutationPolicy(claim(noKill, 'total'), POLICY)).toEqual({ ok: false, reason: 'NOT_KILLED' });
    const noScore = score({ report: report({ coverage: 'none', mutants: [mut('a', 'killed', 1, { killedBy: ['t1'] })] }) });
    expect(meetsMutationPolicy(claim(noScore, 'total'), POLICY)).toEqual({ ok: true });
  });

  // [claims: capabilities/coverage-and-mutation#mutation-min-score]
  it('resolveMutationPolicy defaults to 70, 1 and timeouts as killed', () => {
    expect(resolveMutationPolicy()).toEqual({ minScore: 70, minKilled: 1, timeoutAsKilled: true });
    expect(resolveMutationPolicy({ minScore: 85, timeoutAsKilled: false })).toEqual({ minScore: 85, minKilled: 1, timeoutAsKilled: false });
  });

  // [claims: capabilities/coverage-and-mutation#mutation-score-per-claim]
  it('output ordering is deterministic whatever order the mutants and claims arrive in', () => {
    const a = score();
    const reversed = score({ report: report({ mutants: [...report().mutants].reverse() }), claimTests: new Map([...CLAIMS].reverse()) });
    expect(reversed).toEqual(a);
    expect(a.claims.map((c) => c.ref)).toEqual(['capabilities/cart#tax', 'capabilities/cart#total']);
  });
});
