import { describe, expect, it } from 'vitest';

import {
  CoverageParseError,
  capabilityCoverage,
  detectCoverageFormat,
  enforceSizeCap,
  fromRanges,
  mapCoveragePath,
  mappedCoverageFiles,
  normalizeCoverage,
  parseCobertura,
  parseCoverage,
  parseGoCoverprofile,
  parseJacoco,
  parseLcov,
  selectCapabilityTests,
  toRanges,
  type CoverageEvidence,
  type PathContext,
  type RawCoverage,
} from '../../src/core/coverage.js';
import type { ClaimTestIndex } from '../../src/core/claim-tags.js';
import type { ChangedFile } from '../../src/core/diff-lines.js';

const LCOV = `TN:
SF:src/cart.ts
FN:1,add
FNDA:2,add
DA:1,2
DA:2,2
DA:3,0
DA:4,1,abcdef==
BRDA:2,0,0,1
BRDA:2,0,1,-
LF:4
LH:3
end_of_record
SF:src/util.ts
DA:1,1
DA:2,0
`;

const JACOCO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="app">
  <sessioninfo id="host-1" start="1" dump="2"/>
  <package name="com/acme">
    <class name="com/acme/Cart" sourcefilename="Cart.java"><method name="add" desc="()V" line="3"><counter type="LINE" missed="0" covered="1"/></method></class>
    <sourcefile name="Cart.java">
      <line nr="3" mi="0" ci="2" mb="0" cb="0"/>
      <line nr="4" mi="2" ci="0" mb="1" cb="1"/>
      <line nr="5" mi="0" ci="0" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

const JACOCO_ENTITY = `<?xml version="1.0"?>
<!DOCTYPE report [<!ENTITY boom "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">]>
<report name="&boom;&boom;"><package name="a"><sourcefile name="B.java"><line nr="1" mi="0" ci="1"/></sourcefile></package></report>`;

const COBERTURA = `<?xml version="1.0" ?>
<coverage line-rate="0.5" branch-rate="0.5" version="1" timestamp="1">
  <sources><source>/ci/work/app</source><source>/ci/work/lib</source></sources>
  <packages><package name="p"><classes>
    <class name="Cart" filename="src/cart.py" line-rate="0.5"><methods><method name="add" signature=""><lines><line number="1" hits="1"/></lines></method></methods>
      <lines><line number="1" hits="1"/><line number="2" hits="0" branch="true" condition-coverage="50% (1/2)"/></lines></class>
    <class name="Cart.Inner" filename="src/cart.py"><lines><line number="3" hits="2"/></lines></class>
  </classes></package></packages>
</coverage>`;

const GO = `mode: set
example.com/app/cart/cart.go:3.20,5.2 2 1
example.com/app/cart/cart.go:6.2,7.3 1 0
example.com/app/cart/cart.go:6.2,7.3 1 3
example.com/app/cart/cart.go:9.1,9.10 0 0
`;

const hex = (c: string) => c.repeat(64);

function ctx(files: string[], extra: Partial<PathContext> = {}): PathContext {
  return { rootDir: '/work/app', repoFiles: new Set(files), ...extra };
}

describe('coverage parsers [coverage-and-mutation]', () => {
  // [claims: capabilities/coverage-and-mutation#coverage-formats-parsed]
  it('lcov: DA and BRDA (with "-" taken), several SF records, checksum field, missing end_of_record', () => {
    const raw = parseLcov(LCOV);
    expect(raw.format).toBe('lcov');
    expect(raw.files.map((f) => f.path)).toEqual(['src/cart.ts', 'src/util.ts']);
    const cart = raw.files[0];
    expect([...cart.lines]).toEqual([[1, 2], [2, 2], [3, 0], [4, 1]]);
    expect(cart.branches.get(2)).toEqual({ total: 2, covered: 1 });
    expect(raw.files[1].lines.get(2)).toBe(0);
    expect(raw.warnings).toEqual(['missing final end_of_record']);
  });

  // [claims: capabilities/coverage-and-mutation#coverage-formats-parsed]
  it('jacoco: package/sourcefile path, mi/ci executable and hit, mb/cb branches', () => {
    const raw = parseJacoco(JACOCO);
    expect(raw.files).toHaveLength(1);
    const f = raw.files[0];
    expect(f.path).toBe('com/acme/Cart.java');
    expect([...f.lines]).toEqual([[3, 2], [4, 0]]);
    expect(f.branches.get(4)).toEqual({ total: 2, covered: 1 });
    expect(f.branches.has(3)).toBe(false);
  });

  // [claims: capabilities/coverage-and-mutation#coverage-formats-parsed]
  it('jacoco: a DOCTYPE entity is not expanded', () => {
    const raw = parseJacoco(JACOCO_ENTITY);
    expect(raw.files[0].path).toBe('a/B.java');
    expect(JSON.stringify(raw)).not.toContain('AAAA');
  });

  // [claims: capabilities/coverage-and-mutation#coverage-formats-parsed]
  it('cobertura: multiple sources, condition-coverage parsing, repeated class for one file merged', () => {
    const raw = parseCobertura(COBERTURA);
    expect(raw.files).toHaveLength(1);
    const f = raw.files[0];
    expect(f.path).toBe('src/cart.py');
    expect(f.alternatives).toEqual(['/ci/work/app/src/cart.py', '/ci/work/lib/src/cart.py']);
    expect([...f.lines]).toEqual([[1, 1], [2, 0], [3, 2]]);
    expect(f.branches.get(2)).toEqual({ total: 2, covered: 1 });
  });

  // [claims: capabilities/coverage-and-mutation#coverage-formats-parsed]
  it('go: mode line, multi-line blocks, max count for duplicate blocks, numStmt 0 ignored', () => {
    const raw = parseGoCoverprofile(GO);
    expect(raw.files).toHaveLength(1);
    const f = raw.files[0];
    expect(f.path).toBe('example.com/app/cart/cart.go');
    expect([...f.lines]).toEqual([[3, 1], [4, 1], [5, 1], [6, 3], [7, 3]]);
    expect(f.lines.has(9)).toBe(false);
  });

  // [claims: capabilities/coverage-and-mutation#coverage-formats-parsed]
  it('detectCoverageFormat recognises each format and returns null for junk; parse errors are CoverageParseError', () => {
    expect(detectCoverageFormat(LCOV)).toBe('lcov');
    expect(detectCoverageFormat(JACOCO)).toBe('jacoco');
    expect(detectCoverageFormat(COBERTURA)).toBe('cobertura');
    expect(detectCoverageFormat(GO)).toBe('go');
    expect(detectCoverageFormat('hello world')).toBeNull();
    expect(parseCoverage(GO).format).toBe('go');
    expect(() => parseCoverage('hello world')).toThrow(CoverageParseError);
    expect(() => parseCoverage('hello', 'lcov')).toThrow(CoverageParseError);
    expect(() => parseCoverage('<report></report>', 'jacoco')).toThrow(CoverageParseError);
    expect(() => parseCoverage('nope', 'go')).toThrow(CoverageParseError);
    expect(() => parseCoverage('<coverage line-rate="1"/>', 'cobertura')).toThrow(CoverageParseError);
  });
});

describe('coverage path mapping [coverage-and-mutation]', () => {
  const files = ['src/cart.ts', 'src/util.ts', 'svc/pay/pay.go', 'src/main/java/com/acme/Cart.java', 'mod/src/main/java/com/acme/Pay.java', 'a/index.ts', 'b/index.ts'];

  // [claims: capabilities/coverage-and-mutation#paths-normalized]
  it('absolute under root, Windows backslashes and drive letter, file:// URI', () => {
    expect(mapCoveragePath('/work/app/src/cart.ts', ctx(files))).toEqual({ file: 'src/cart.ts' });
    expect(mapCoveragePath('./src//cart.ts', ctx(files))).toEqual({ file: 'src/cart.ts' });
    expect(mapCoveragePath('c:\\a\\app\\src\\cart.ts', ctx(files, { rootDir: 'C:/a/app' }))).toEqual({ file: 'src/cart.ts' });
    expect(mapCoveragePath('file:///work/app/src/util.ts', ctx(files))).toEqual({ file: 'src/util.ts' });
    expect(mapCoveragePath('file:///C:/a/app/src/util.ts', ctx(files, { rootDir: 'C:/a/app' }))).toEqual({ file: 'src/util.ts' });
  });

  // [claims: capabilities/coverage-and-mutation#paths-normalized]
  it('CI checkout prefix stripped, Go module prefix (nested modules), JaCoCo source roots', () => {
    expect(mapCoveragePath('/home/runner/work/app/app/src/cart.ts', ctx(files, { stripPrefixes: ['/home/runner/work/app/app'] }))).toEqual({ file: 'src/cart.ts' });
    const goModules = [{ module: 'example.com/app', dir: '.' }, { module: 'example.com/app/svc', dir: 'svc' }];
    expect(mapCoveragePath('example.com/app/svc/pay/pay.go', ctx(files, { goModules }))).toEqual({ file: 'svc/pay/pay.go' });
    expect(mapCoveragePath('com/acme/Cart.java', ctx(files))).toEqual({ file: 'src/main/java/com/acme/Cart.java' });
    expect(mapCoveragePath('com/acme/Cart.java', ctx(files, { sourceRoots: ['lib/java'] }))).toEqual({ file: 'src/main/java/com/acme/Cart.java' });
    // a multi-module build: no source root matches at the repo root, the unique suffix does
    expect(mapCoveragePath('com/acme/Pay.java', ctx(files))).toEqual({ file: 'mod/src/main/java/com/acme/Pay.java' });
  });

  // [claims: capabilities/coverage-and-mutation#paths-normalized]
  it('unique suffix, ambiguous suffix, outside root, not found', () => {
    expect(mapCoveragePath('cart.ts', ctx(files))).toEqual({ file: 'src/cart.ts' });
    expect(mapCoveragePath('index.ts', ctx(files))).toEqual({ reason: 'ambiguous', candidates: ['a/index.ts', 'b/index.ts'] });
    expect(mapCoveragePath('/elsewhere/src/cart.ts', ctx(files))).toEqual({ reason: 'outside-root' });
    expect(mapCoveragePath('src/missing.ts', ctx(files))).toEqual({ reason: 'not-found' });
  });
});

describe('normalized coverage evidence [coverage-and-mutation]', () => {
  const meta = { scope: { kind: 'suite' } as const, runId: 'r1', origin: 'local' as const, ingestedAt: '2026-10-25T00:00:00.000Z' };

  // [claims: capabilities/coverage-and-mutation#paths-normalized]
  it('normalizeCoverage merges reports per file and records unmapped with a 50-entry sample', () => {
    const c = ctx(['src/cart.ts', 'src/util.ts']);
    const extra: RawCoverage = {
      format: 'lcov',
      warnings: [],
      files: [
        { path: 'src/cart.ts', lines: new Map([[3, 4], [9, 0]]), branches: new Map([[2, { total: 2, covered: 2 }]]) },
        ...Array.from({ length: 60 }, (_, i) => ({ path: `/other/f${String(i).padStart(2, '0')}.ts`, lines: new Map<number, number>(), branches: new Map<number, { total: number; covered: number }>() })),
      ],
    };
    const raws = [parseLcov(LCOV), extra];
    expect(mappedCoverageFiles(raws, c)).toEqual(['src/cart.ts', 'src/util.ts']);
    const e = normalizeCoverage(raws, c, { 'src/cart.ts': hex('a'), 'src/util.ts': hex('b') }, meta);
    expect(e.formats).toEqual(['lcov']);
    expect(e.files['src/cart.ts']).toEqual({ hash: hex('a'), exec: [[1, 4], [9, 9]], hit: [[1, 4]], br: [[2, 2, 2]] });
    expect(e.summary['src/cart.ts']).toEqual({ exec: 5, hit: 4 });
    expect(e.files['src/util.ts'].hit).toEqual([[1, 1]]);
    expect(e.unmapped.count).toBe(60);
    expect(e.unmapped.sample).toHaveLength(50);
    expect(e.granularity).toBe('lines');
  });

  // [claims: capabilities/coverage-and-mutation#paths-normalized]
  it('tries a Cobertura source-joined path before the bare filename', () => {
    const raw = parseCobertura(COBERTURA);
    const e = normalizeCoverage([raw], ctx(['src/cart.py'], { rootDir: '/ci/work/app' }), { 'src/cart.py': hex('c') }, meta);
    expect(Object.keys(e.files)).toEqual(['src/cart.py']);
  });

  // [claims: capabilities/coverage-and-mutation#paths-normalized]
  it('ranges round-trip; enforceSizeCap drops branches, then line data (granularity summary)', () => {
    expect(toRanges([5, 1, 2, 3, 9, 2])).toEqual([[1, 3], [5, 5], [9, 9]]);
    expect(fromRanges([[1, 3], [5, 5]])).toEqual([1, 2, 3, 5]);
    expect(toRanges([])).toEqual([]);

    const lines = Array.from({ length: 400 }, (_, i) => i * 2 + 1);
    const raw: RawCoverage = {
      format: 'lcov',
      warnings: [],
      files: [{ path: 'src/cart.ts', lines: new Map(lines.map((n) => [n, n % 3])), branches: new Map(lines.map((n) => [n, { total: 2, covered: 1 }])) }],
    };
    const e = normalizeCoverage([raw], ctx(['src/cart.ts']), { 'src/cart.ts': hex('a') }, meta);
    const full = Buffer.byteLength(JSON.stringify(e));
    expect(enforceSizeCap(e, full)).toBe(e);
    const noBranches = enforceSizeCap(e, full - 1);
    expect(noBranches.files['src/cart.ts'].br).toBeUndefined();
    expect(noBranches.files['src/cart.ts'].exec.length).toBeGreaterThan(0);
    expect(noBranches.granularity).toBe('lines');
    const summary = enforceSizeCap(e, 600);
    expect(summary.granularity).toBe('summary');
    expect(summary.files['src/cart.ts'].exec).toEqual([]);
    expect(summary.summary['src/cart.ts'].exec).toBe(400);
  });
});

function evidence(over: Partial<CoverageEvidence> = {}): CoverageEvidence {
  return {
    version: 1,
    scope: { kind: 'suite' },
    runId: 'run-1',
    repoSha: 'abc123',
    origin: 'ci',
    ingestedAt: '2026-10-25T00:00:00.000Z',
    formats: ['lcov'],
    granularity: 'lines',
    files: {
      'src/cart.ts': { hash: hex('a'), exec: [[1, 10]], hit: [[1, 6]] },
      'src/tax.ts': { hash: hex('b'), exec: [[1, 4]], hit: [[1, 4]] },
      'src/old.ts': { hash: hex('c'), exec: [[1, 5]], hit: [[1, 5]] },
    },
    summary: { 'src/cart.ts': { exec: 10, hit: 6 }, 'src/tax.ts': { exec: 4, hit: 4 }, 'src/old.ts': { exec: 5, hit: 5 } },
    unmapped: { count: 0, sample: [] },
    ...over,
  };
}

const HASHES = { 'src/cart.ts': hex('a'), 'src/tax.ts': hex('b'), 'src/old.ts': hex('z'), 'src/new.ts': hex('n') };

function changed(file: string, added: number[], over: Partial<ChangedFile> = {}): ChangedFile {
  return { file, status: 'modified', added, removed: [], addedText: added.map((line) => ({ line, text: '' })), binary: false, ...over };
}

describe('capability coverage [coverage-and-mutation]', () => {
  // [claims: capabilities/coverage-and-mutation#attributed-by-ownership]
  it('line pct is over fresh reported owned files; unreported listed; stale excluded; documents not counted', () => {
    const c = capabilityCoverage({
      capability: 'cart',
      ownedFiles: ['src/cart.ts', 'src/tax.ts', 'src/old.ts', 'src/new.ts', 'README.md'],
      evidence: evidence(),
      currentHashes: HASHES,
    });
    expect(c.owned).toBe(4);
    expect(c.reported).toBe(2);
    expect(c.stale).toEqual(['src/old.ts']);
    expect(c.unreported).toEqual(['src/new.ts']);
    expect(c.unreportedCount).toBe(1);
    expect(c.lines).toEqual({ executable: 14, hit: 10, pct: 71.4 });
    expect(c.unreached).toEqual({ lines: 4, files: [{ file: 'src/cart.ts', lines: [[7, 10]] }] });
    expect(c.source).toBe('suite');
    expect(c.evidence).toEqual({ runId: 'run-1', origin: 'ci', repoSha: 'abc123' });
  });

  // [claims: capabilities/coverage-and-mutation#attributed-by-ownership]
  it('pct is null when no owned file has executable lines', () => {
    const c = capabilityCoverage({ capability: 'x', ownedFiles: ['src/new.ts'], evidence: evidence(), currentHashes: HASHES });
    expect(c.lines).toEqual({ executable: 0, hit: 0, pct: null });
  });

  // [claims: capabilities/coverage-and-mutation#diff-coverage]
  it('diff pct ignores non-executable changed lines; a changed file without fresh coverage goes to unknownFiles', () => {
    const c = capabilityCoverage({
      capability: 'cart',
      ownedFiles: ['src/cart.ts', 'src/old.ts', 'src/new.ts', 'src/gone.ts'],
      evidence: evidence(),
      currentHashes: HASHES,
      changed: [
        changed('src/cart.ts', [2, 3, 8, 9, 40]), // 40 is not executable; 8 and 9 are not hit
        changed('src/old.ts', [1]),
        changed('src/new.ts', [1, 2], { status: 'added' }),
        changed('src/gone.ts', [], { status: 'deleted' }),
        changed('docs/elsewhere.ts', [1]),
      ],
    });
    expect(c.diff).toEqual({
      changedExecutable: 4,
      hit: 2,
      pct: 50,
      missed: [{ file: 'src/cart.ts', lines: [[8, 9]] }],
      unknownFiles: ['src/new.ts', 'src/old.ts'],
    });
  });

  // [claims: capabilities/coverage-and-mutation#diff-coverage]
  it('diff pct is null when no changed line is executable; summary granularity cannot judge changed lines', () => {
    const none = capabilityCoverage({ capability: 'cart', ownedFiles: ['src/cart.ts'], evidence: evidence(), currentHashes: HASHES, changed: [changed('src/cart.ts', [50])] });
    expect(none.diff).toMatchObject({ changedExecutable: 0, pct: null, unknownFiles: [] });
    const summary = evidence({ granularity: 'summary', files: { 'src/cart.ts': { hash: hex('a'), exec: [], hit: [] } } });
    const c = capabilityCoverage({ capability: 'cart', ownedFiles: ['src/cart.ts'], evidence: summary, currentHashes: HASHES, changed: [changed('src/cart.ts', [2])] });
    expect(c.diff?.unknownFiles).toEqual(['src/cart.ts']);
    expect(c.lines).toEqual({ executable: 10, hit: 6, pct: 60 });
  });

  // [claims: capabilities/coverage-and-mutation#suite-report-limit]
  it('claimable flags: suite and files selections prove neither reach nor unspecified; tests selection proves both', () => {
    const base = { capability: 'cart', ownedFiles: ['src/cart.ts'], currentHashes: HASHES };
    const scope = (selection: 'tests' | 'files') => ({ kind: 'capability' as const, capability: 'cart', selection, tests: ['t.test.ts::a'], testsHash: 'h1' });
    expect(capabilityCoverage({ ...base, evidence: evidence() }).claimable).toEqual({ reach: false, unspecified: false });
    const files = capabilityCoverage({ ...base, evidence: evidence({ scope: scope('files') }), currentTestsHash: 'h1' });
    expect(files).toMatchObject({ claimable: { reach: false, unspecified: false }, source: 'capability', selection: 'files' });
    const tests = capabilityCoverage({ ...base, evidence: evidence({ scope: scope('tests') }), currentTestsHash: 'h1' });
    expect(tests).toMatchObject({ claimable: { reach: true, unspecified: true }, selection: 'tests', testsStale: false });
  });

  // [claims: capabilities/coverage-and-mutation#evidence-staleness]
  it('testsHash mismatch marks testsStale and withdraws the claims', () => {
    const e = evidence({ scope: { kind: 'capability', capability: 'cart', selection: 'tests', tests: ['t.test.ts::a'], testsHash: 'h1' } });
    const c = capabilityCoverage({ capability: 'cart', ownedFiles: ['src/cart.ts'], evidence: e, currentHashes: HASHES, currentTestsHash: 'h2' });
    expect(c.testsStale).toBe(true);
    expect(c.claimable).toEqual({ reach: false, unspecified: false });
  });

  // [claims: capabilities/coverage-and-mutation#evidence-staleness]
  it('a file whose content hash changed is excluded from every metric and listed as stale', () => {
    const c = capabilityCoverage({
      capability: 'cart',
      ownedFiles: ['src/cart.ts', 'src/tax.ts'],
      evidence: evidence(),
      currentHashes: { ...HASHES, 'src/tax.ts': hex('9') },
      changed: [changed('src/tax.ts', [1])],
    });
    expect(c.stale).toEqual(['src/tax.ts']);
    expect(c.lines).toEqual({ executable: 10, hit: 6, pct: 60 });
    expect(c.diff?.unknownFiles).toEqual(['src/tax.ts']);
  });
});

describe('capability test selection [coverage-and-mutation]', () => {
  const index: ClaimTestIndex = new Map([
    ['capabilities/cart#total', [{ file: 'tests/b.test.ts', title: 'sums', origin: 'source' as const }, { file: 'tests/a.test.ts', title: 'adds', origin: 'source' as const }]],
    ['capabilities/cart#tax', [{ file: 'tests/a.test.ts', title: 'taxes', origin: 'source' as const }, { file: 'tests/r.json', title: 'from results', origin: 'result' as const }]],
    ['capabilities/other#x', [{ file: 'tests/z.test.ts', title: 'z', origin: 'source' as const }]],
  ]);

  // [claims: capabilities/coverage-and-mutation#suite-report-limit]
  it('selectCapabilityTests is order-independent and deterministic', () => {
    const a = selectCapabilityTests(['capabilities/cart#total', 'capabilities/cart#tax'], index);
    const b = selectCapabilityTests(['capabilities/cart#tax', 'capabilities/cart#total', 'capabilities/cart#tax'], index);
    expect(a).toEqual(b);
    expect(a.tests).toEqual(['tests/a.test.ts::adds', 'tests/a.test.ts::taxes', 'tests/b.test.ts::sums']);
    expect(a.files).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(a.testsHash).toMatch(/^[0-9a-f]{64}$/);
    const fewer = selectCapabilityTests(['capabilities/cart#total'], index);
    expect(fewer.testsHash).not.toBe(a.testsHash);
  });
});
