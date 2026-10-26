import { describe, expect, it } from 'vitest';

import type { CoverageEvidence, CoverageScope, LineRanges } from '../../src/core/coverage.js';
import type { ChangedFile } from '../../src/core/diff-lines.js';
import { findUnrequested, type UnrequestedInput } from '../../src/core/unrequested.js';

const CLAIMS: CoverageScope = { kind: 'claims', claims: ['capabilities/cart#total'], tests: ['t1'], testsHash: 'th', selection: 'tests' };
const CAPABILITY: CoverageScope = { kind: 'capability', capability: 'cart', selection: 'tests', tests: ['t1', 't2'], testsHash: 'th2' };

const evidence = (scope: CoverageScope, files: Record<string, { hash?: string; exec: LineRanges; hit: LineRanges }>, granularity: 'lines' | 'summary' = 'lines'): CoverageEvidence => ({
  version: 1,
  scope,
  runId: 'run-1',
  origin: 'ci',
  ingestedAt: '2026-10-25T00:00:00.000Z',
  formats: ['lcov'],
  granularity,
  files: Object.fromEntries(Object.entries(files).map(([f, v]) => [f, { hash: v.hash ?? `h-${f}`, exec: v.exec, hit: v.hit }])),
  summary: {},
  unmapped: { count: 0, sample: [] },
});

const changed = (file: string, added: number[], status: ChangedFile['status'] = 'modified'): ChangedFile => ({ file, status, added, removed: [], addedText: [], binary: false });

const base = (over: Partial<UnrequestedInput> = {}): UnrequestedInput => ({
  changed: [changed('src/cart/total.ts', [10, 11, 12])],
  ownedBy: new Map([['src/cart/total.ts', ['cart']]]),
  changeCaps: new Set(['cart']),
  currentHashes: { 'src/cart/total.ts': 'h-src/cart/total.ts' },
  ...over,
});

describe('findUnrequested', () => {
  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('changed line hit by change tests -> not reported', () => {
    const r = findUnrequested(
      base({ changeCoverage: evidence(CLAIMS, { 'src/cart/total.ts': { exec: [[1, 20]], hit: [[1, 20]] } }) }),
    );
    expect(r.lines).toEqual([]);
    expect(r.withoutChange).toEqual([]);
    expect(r.claimable).toBe(true);
    expect(r.diffCoverage).toEqual({ changedExecutable: 3, hitByChangeTests: 3, pct: 100 });
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('hit only by capability tests -> incidental', () => {
    const r = findUnrequested(
      base({
        changeCoverage: evidence(CLAIMS, { 'src/cart/total.ts': { exec: [[10, 12]], hit: [[10, 10]] } }),
        capabilityCoverage: new Map([['cart', evidence(CAPABILITY, { 'src/cart/total.ts': { exec: [[10, 12]], hit: [[10, 12]] } })]]),
      }),
    );
    expect(r.lines).toEqual([{ file: 'src/cart/total.ts', capability: 'cart', lines: [[11, 12]], class: 'incidental' }]);
    expect(r.diffCoverage).toEqual({ changedExecutable: 3, hitByChangeTests: 1, pct: 33.3 });
    expect(r.claimable).toBe(true);
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('hit by none -> unrequested; a mix of classes is split per class and lines are ranges', () => {
    const r = findUnrequested(
      base({
        changed: [changed('src/cart/total.ts', [10, 11, 12, 13, 40, 41])],
        changeCoverage: evidence(CLAIMS, { 'src/cart/total.ts': { exec: [[10, 13], [40, 41]], hit: [[10, 10]] } }),
        capabilityCoverage: new Map([['cart', evidence(CAPABILITY, { 'src/cart/total.ts': { exec: [[10, 13], [40, 41]], hit: [[10, 12]] } })]]),
      }),
    );
    expect(r.lines).toEqual([
      { file: 'src/cart/total.ts', capability: 'cart', lines: [[13, 13], [40, 41]], class: 'unrequested' },
      { file: 'src/cart/total.ts', capability: 'cart', lines: [[11, 12]], class: 'incidental' },
    ]);
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('without capability coverage a missed line is unrequested (the stricter reading)', () => {
    const r = findUnrequested(base({ changeCoverage: evidence(CLAIMS, { 'src/cart/total.ts': { exec: [[10, 12]], hit: [] } }) }));
    expect(r.lines).toEqual([{ file: 'src/cart/total.ts', capability: 'cart', lines: [[10, 12]], class: 'unrequested' }]);
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('changed lines that are not executable (comments, blanks) are never reported', () => {
    const r = findUnrequested(base({ changeCoverage: evidence(CLAIMS, { 'src/cart/total.ts': { exec: [[11, 11]], hit: [[11, 11]] } }) }));
    expect(r.lines).toEqual([]);
    expect(r.diffCoverage).toEqual({ changedExecutable: 1, hitByChangeTests: 1, pct: 100 });
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('file-selection evidence -> unknown, claimable false', () => {
    const files = evidence({ ...CLAIMS, selection: 'files' }, { 'src/cart/total.ts': { exec: [[10, 12]], hit: [[10, 12]] } });
    const r = findUnrequested(base({ changeCoverage: files }));
    expect(r.claimable).toBe(false);
    expect(r.lines).toEqual([{ file: 'src/cart/total.ts', capability: 'cart', lines: [[10, 12]], class: 'unknown' }]);
    expect(r.diffCoverage).toEqual({ changedExecutable: 0, hitByChangeTests: 0, pct: null });
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('suite-wide, summarized or absent evidence cannot be claimed either', () => {
    const suite = evidence({ kind: 'suite' }, { 'src/cart/total.ts': { exec: [[10, 12]], hit: [[10, 12]] } });
    expect(findUnrequested(base({ changeCoverage: suite })).claimable).toBe(false);
    const summary = evidence(CLAIMS, {}, 'summary');
    const s = findUnrequested(base({ changeCoverage: summary }));
    expect(s.claimable).toBe(false);
    expect(s.lines.map((l) => l.class)).toEqual(['unknown']);
    const none = findUnrequested(base());
    expect(none.claimable).toBe(false);
    expect(none.lines).toEqual([{ file: 'src/cart/total.ts', capability: 'cart', lines: [[10, 12]], class: 'unknown' }]);
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('owned file changed without covering change -> withoutChange; unowned, non-code and deleted files are ignored', () => {
    const r = findUnrequested(
      base({
        changed: [
          changed('src/billing/tax.ts', [3]),
          changed('src/billing/tax.ts.bak.md', [1]),
          changed('src/free.ts', [2]),
          changed('src/billing/gone.ts', [], 'deleted'),
          changed('src/cart/total.ts', [10]),
        ],
        ownedBy: new Map([
          ['src/billing/tax.ts', ['billing']],
          ['src/billing/tax.ts.bak.md', ['billing']],
          ['src/billing/gone.ts', ['billing']],
          ['src/cart/total.ts', ['cart']],
        ]),
        changeCoverage: evidence(CLAIMS, { 'src/cart/total.ts': { exec: [[10, 10]], hit: [[10, 10]] } }),
      }),
    );
    expect(r.withoutChange).toEqual([{ file: 'src/billing/tax.ts', capabilities: ['billing'] }]);
    expect(r.lines).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('a file shared with a covered capability counts as covered, and its lines go to the first covered capability', () => {
    const r = findUnrequested(
      base({
        ownedBy: new Map([['src/cart/total.ts', ['billing', 'cart']]]),
        changeCaps: new Set(['cart']),
        changeCoverage: evidence(CLAIMS, { 'src/cart/total.ts': { exec: [[10, 12]], hit: [] } }),
      }),
    );
    expect(r.withoutChange).toEqual([]);
    expect(r.lines.map((l) => l.capability)).toEqual(['cart']);
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('stale coverage -> unknown', () => {
    const stale = evidence(CLAIMS, { 'src/cart/total.ts': { hash: 'old-hash', exec: [[10, 12]], hit: [] } });
    const r = findUnrequested(base({ changeCoverage: stale }));
    expect(r.claimable).toBe(false);
    expect(r.lines).toEqual([{ file: 'src/cart/total.ts', capability: 'cart', lines: [[10, 12]], class: 'unknown' }]);
  });

  // [claims: capabilities/spec-first-changes#unrequested-lines]
  it('output is ordered by file, then class, whatever the input order', () => {
    const files = {
      'src/b.ts': { exec: [[1, 2]] as LineRanges, hit: [] as LineRanges },
      'src/a.ts': { exec: [[1, 2]] as LineRanges, hit: [] as LineRanges },
    };
    const input = (order: string[]): UnrequestedInput => ({
      changed: order.map((f) => changed(f, [1, 2])),
      ownedBy: new Map(order.map((f) => [f, ['cart']])),
      changeCaps: new Set(['cart']),
      changeCoverage: evidence(CLAIMS, files),
      currentHashes: { 'src/a.ts': 'h-src/a.ts', 'src/b.ts': 'h-src/b.ts' },
    });
    const one = findUnrequested(input(['src/b.ts', 'src/a.ts']));
    expect(one.lines.map((l) => l.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(findUnrequested(input(['src/a.ts', 'src/b.ts']))).toEqual(one);
  });
});
