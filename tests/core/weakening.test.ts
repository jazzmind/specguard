import { describe, expect, it } from 'vitest';

import type { ChangedFile } from '../../src/core/diff-lines.js';
import type { ExampleTable } from '../../src/core/examples.js';
import type { ParsedSpec, SpecClaim, SpecMeta } from '../../src/core/types.js';
import { diffConfigPolicy, diffSpecPolicy, scanAddedSource, snapshotRewrites } from '../../src/core/weakening.js';

const rows = (...ids: string[]): ExampleTable => ({
  claimId: 'fee',
  headers: ['id'],
  idColumn: 'id',
  rows: ids.map((id, i) => ({ id, cells: { id }, line: 10 + i, hash: `h-${id}` })),
});

const spec = (meta: Partial<SpecMeta> = {}, claims: SpecClaim[] = [{ id: 'fee', text: 'The fee is set.' }, { id: 'tax', text: 'Tax applies.' }], pv = 'Problem and value.'): ParsedSpec =>
  ({
    title: 'Pricing',
    specKey: 'capabilities/pricing',
    filePath: 'specs/capabilities/pricing.md',
    meta: { kind: 'capability', ...meta } as SpecMeta,
    overview: '',
    acceptanceCriteria: '',
    claims,
    exampleIssues: [],
    scenarios: [],
    securityNotes: '',
    dependencies: '',
    visualExpectations: '',
    accessibilityRequirements: '',
    uxGuidelines: '',
    sections: { 'Problem & Value': pv },
  }) as unknown as ParsedSpec;

const kinds = (f: Array<{ kind: string }>): string[] => f.map((x) => x.kind);

describe('diffSpecPolicy', () => {
  // [claims: capabilities/test-strength#weakening-policy]
  it('policy: required layer removed; assurance lowered; evidence relaxed; verifier changed', () => {
    const before = spec({
      layers: { default: ['unit', 'e2e'], claims: { tax: ['unit'] }, unknown: [] },
      assurance: { default: 'property', claims: {}, unknown: [] },
      evidence: { tax: { kind: 'manual', verifier: 'Content lead' } },
    });
    const after = spec({
      layers: { default: ['unit'], claims: { tax: ['unit'] }, unknown: [] },
      assurance: { default: 'tested', claims: {}, unknown: [] },
      evidence: { tax: { kind: 'manual', verifier: 'Someone else' }, fee: { kind: 'agentic', verifier: 'verify' } },
    });
    const found = diffSpecPolicy(before, after, []);
    expect(found.every((f) => f.severity === 'error')).toBe(true);
    expect(found.map((f) => `${f.kind}@${f.claims[0]}`).sort()).toEqual(
      [
        'policy-layer-removed@capabilities/pricing#fee',
        'policy-assurance-lowered@capabilities/pricing#fee',
        'policy-assurance-lowered@capabilities/pricing#tax',
        'policy-evidence-relaxed@capabilities/pricing#fee',
        'policy-evidence-relaxed@capabilities/pricing#tax',
      ].sort(),
    );
    expect(found.find((f) => f.kind === 'policy-layer-removed')).toMatchObject({ before: 'unit, e2e', after: 'unit' });
  });

  // [claims: capabilities/test-strength#weakening-policy]
  it('policy: project default layers count and tightening or new claims are not reported', () => {
    const before = spec({ layers: { default: [], claims: {}, unknown: [] } });
    const after = spec({ layers: { default: [], claims: { fee: ['unit', 'e2e'] }, unknown: [] }, assurance: { default: 'property', claims: {}, unknown: [] } });
    expect(diffSpecPolicy(before, after, ['unit'])).toEqual([]);
    expect(diffSpecPolicy(after, before, ['unit'])).toHaveLength(3); // fee loses e2e; assurance lowered on both claims
    const withNew = spec({}, [{ id: 'fee', text: 'The fee is set.' }, { id: 'tax', text: 'Tax applies.' }, { id: 'new', text: 'Added.' }]);
    expect(diffSpecPolicy(spec(), withNew, [])).toEqual([]);
    expect(diffSpecPolicy(undefined, spec(), [])).toEqual([]);
    expect(diffSpecPolicy(spec(), undefined, [])).toEqual([]);
  });

  // [claims: capabilities/test-strength#weakening-policy]
  it('policy: example row removed while claim hash unchanged; row removed with claim change is not reported', () => {
    const withRows = (text: string, ...ids: string[]): ParsedSpec => spec({}, [{ id: 'fee', text, examples: rows(...ids) }]);
    const before = withRows('The fee is set.', 'ny-small', 'ny-free');
    const dropped = diffSpecPolicy(before, withRows('The fee is set.', 'ny-small'), []);
    expect(kinds(dropped)).toEqual(['policy-example-removed']);
    expect(dropped[0]).toMatchObject({ claims: ['capabilities/pricing#fee/ny-free'], line: 11 });
    expect(diffSpecPolicy(before, withRows('The fee is set differently.', 'ny-small'), [])).toEqual([]);
    expect(diffSpecPolicy(before, withRows('The fee is set.', 'ny-small', 'ny-free', 'extra'), [])).toEqual([]);
  });
});

describe('diffConfigPolicy', () => {
  // [claims: capabilities/test-strength#weakening-policy]
  it('config: require flag turned off; threshold lowered; allow/waive/assertHelpers grown; conditional shrunk', () => {
    const before = {
      proof: { requireApproval: true, requiredLayers: ['unit', 'e2e'], enforceLayers: 'fail', minDiffCoverage: 80 },
      mutation: { minScore: 70 },
      testability: { allow: ['fast'], waive: { 'a#b': ['T-VAGUE'] }, rules: { 'T-VAGUE': 'error' } },
      testStrength: { assertHelpers: ['expectOk'], conditional: ['RUN_X', 'RUN_Y'], snapshotIsWeak: true },
    };
    const after = {
      proof: { requireApproval: false, requiredLayers: ['unit'], enforceLayers: 'warn', minDiffCoverage: 50 },
      mutation: { minScore: 60 },
      testability: { allow: ['fast', 'high'], waive: { 'a#b': ['T-VAGUE', 'T-HEDGE'], 'a#c': ['T-LONG'] }, rules: { 'T-VAGUE': 'warn' } },
      testStrength: { assertHelpers: ['expectOk', 'mystery*'], conditional: ['RUN_X'], snapshotIsWeak: false },
    };
    const found = diffConfigPolicy(before, after);
    expect(found.every((f) => f.kind === 'config-weakened' && f.severity === 'error')).toBe(true);
    const messages = found.map((f) => f.message).join('\n');
    for (const needle of [
      'proof.requireApproval was turned off',
      'proof.requiredLayers no longer requires e2e',
      'proof.enforceLayers was relaxed',
      'proof.minDiffCoverage was lowered',
      'mutation.minScore was lowered',
      'testability.allow grew by high',
      'testability.waive widened for a#b: T-HEDGE',
      'testability.waive widened for a#c: T-LONG',
      'testability rule T-VAGUE was lowered',
      'testStrength.assertHelpers grew by mystery*',
      'testStrength.conditional dropped RUN_Y',
      'testStrength.snapshotIsWeak was turned off',
    ]) expect(messages).toContain(needle);
    expect(found).toHaveLength(12);
  });

  // [claims: capabilities/test-strength#weakening-policy]
  it('config: tightening, unchanged and missing config produce nothing', () => {
    const cfg = { proof: { requireApproval: true, requiredLayers: ['unit'], minDiffCoverage: 50 }, mutation: { minScore: 50 }, testStrength: { conditional: ['A'] } };
    const tighter = { proof: { requireApproval: true, requiredLayers: ['unit', 'e2e'], minDiffCoverage: 90 }, mutation: { minScore: 80 }, testStrength: { conditional: ['A', 'B'] } };
    expect(diffConfigPolicy(cfg, cfg)).toEqual([]);
    expect(diffConfigPolicy(cfg, tighter)).toEqual([]);
    expect(diffConfigPolicy(undefined, cfg)).toEqual([]);
    expect(diffConfigPolicy('nonsense', null)).toEqual([]);
    // a threshold that disappears is a lowering
    expect(diffConfigPolicy(cfg, { proof: { requireApproval: true, requiredLayers: ['unit'] }, mutation: { minScore: 50 }, testStrength: { conditional: ['A'] } })).toHaveLength(1);
  });
});

const changed = (file: string, lines: string[], over: Partial<ChangedFile> = {}): ChangedFile => ({
  file,
  status: 'modified',
  added: lines.map((_, i) => i + 1),
  removed: [],
  addedText: lines.map((text, i) => ({ line: i + 1, text })),
  binary: false,
  ...over,
});
const isTest = (f: string): boolean => /\.test\.|_test\.|\/tests?\//.test(f);

describe('scanAddedSource and snapshotRewrites', () => {
  // [claims: capabilities/test-strength#weakening-source]
  it('source: test-env branch detected per language; #[cfg(test)] mod excluded; test files ignored', () => {
    const diff = [
      changed('src/a.ts', ["if (process.env.NODE_ENV === 'test') return stub;", 'const ok = import.meta.env.MODE;', 'if (isTestEnv) x();']),
      changed('src/a.py', ['if "pytest" in sys.modules:', "os.environ['PYTEST_CURRENT_TEST']"]),
      changed('src/a.go', ['if testing.Testing() {']),
      changed('src/lib.rs', ['if cfg!(test) {', '#[cfg(test)]', 'mod tests {', '#[cfg(test)]', 'fn real() {}']),
      changed('src/A.java', ['String p = System.getProperty("test.mode");', '@Profile("test")']),
      changed('src/a.test.ts', ["if (process.env.NODE_ENV === 'test') {}"]),
      changed('src/clean.ts', ['const x = 1;']),
    ];
    const found = scanAddedSource(diff, isTest);
    expect(found.every((f) => f.kind === 'test-env-branch' && f.severity === 'warn')).toBe(true);
    const byFile = (f: string): number[] => found.filter((x) => x.file === f).map((x) => x.line!);
    expect(byFile('src/a.ts')).toEqual([1, 2, 3]);
    expect(byFile('src/a.py')).toEqual([1, 2]);
    expect(byFile('src/a.go')).toEqual([1]);
    expect(byFile('src/lib.rs')).toEqual([1, 4]);
    expect(byFile('src/A.java')).toEqual([1, 2]);
    expect(byFile('src/a.test.ts')).toEqual([]);
    expect(byFile('src/clean.ts')).toEqual([]);
  });

  // [claims: capabilities/test-strength#weakening-source]
  it('stryker disable comment added; snapshot files rewritten', () => {
    const found = scanAddedSource(
      [
        changed('src/a.ts', ['// Stryker disable next-line all']),
        changed('pom.xml', ['<excludedMethods>', 'x']),
        changed('src/a.test.ts', ['/* Stryker disable all */']),
        changed('src/b.ts', ['plain'], { binary: true, addedText: [] }),
        changed('gone.ts', ['Stryker disable'], { status: 'deleted' }),
      ],
      isTest,
    );
    expect(found.map((f) => `${f.kind}:${f.file}:${f.line}`)).toEqual([
      'mutation-disable-added:src/a.ts:1',
      'mutation-disable-added:pom.xml:1',
      'mutation-disable-added:src/a.test.ts:1',
    ]);

    const snaps = snapshotRewrites([
      changed('src/__snapshots__/a.test.ts.snap', ['x'], { removed: [1] }),
      changed('src/a.test.ts.snap', ['x'], { added: [], removed: [3], addedText: [] }),
      changed('e2e/a.spec.ts-snapshots/home.png', [], { binary: true, added: [], addedText: [] }),
      changed('src/new/__snapshots__/n.snap', ['new'], { status: 'added' }),
      changed('src/a.snap.new', ['pending'], { status: 'added' }),
      changed('src/ordinary.ts', ['x']),
    ]);
    expect(snaps.map((f) => f.file)).toEqual([
      'src/__snapshots__/a.test.ts.snap',
      'src/a.test.ts.snap',
      'e2e/a.spec.ts-snapshots/home.png',
      'src/a.snap.new',
    ]);
    expect(snaps.every((f) => f.kind === 'snapshot-rewritten' && f.severity === 'warn')).toBe(true);
  });
});
