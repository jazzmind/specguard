import { describe, expect, it } from 'vitest';

import type { Advisory } from '../../src/core/advisory.js';
import { computeVerdict, testId, type ClaimState, type RunSnapshot, type VerdictInput } from '../../src/core/behavior-verdict.js';
import type { TestCaseResult } from '../../src/core/test-results.js';

const t = (title: string, status: TestCaseResult['status'] = 'pass', file = 'a.test.ts'): TestCaseResult => ({
  file, title, fullTitle: title, status, durationMs: 1, tags: [], claims: [], externalIds: [],
});
const adv = (id: string, severity: Advisory['severity'] = 'high', extra: Partial<Advisory> = {}): Advisory => ({
  id, aliases: [], ecosystem: 'npm', package: 'lodash', installedVersion: '1', vulnerableRange: '', fixedVersions: ['2'],
  severity, direct: true, dependencyPath: [], source: 't', ...extra,
});
const snap = (tests: TestCaseResult[], claims: Record<string, ClaimState> = {}, parsed = true): RunSnapshot => ({ tests, parsed, claims });

const FP = { baselineFingerprint: 'a', patchedFingerprint: 'b' };
function input(over: Partial<VerdictInput> = {}): VerdictInput {
  const tests = [t('one'), t('two')];
  const claims: Record<string, ClaimState> = { 'r:s#c1': 'proven' };
  return {
    threshold: 'high',
    changeType: 'dependency',
    targetAdvisoryIds: ['GHSA-1'],
    baseline: snap(tests, claims),
    patched: snap(tests, claims),
    quarantined: [],
    advisoriesBefore: [adv('GHSA-1')],
    advisoriesAfter: [],
    build: { ok: true },
    typecheck: { ok: true },
    proofs: { ...FP, staleBeforeIngest: ['r:s#c1'], reprovenWithNewFingerprint: ['r:s#c1'] },
    selectedForPackage: 2,
    ...over,
  };
}

describe('behavior verdict', () => {
  it('PRESERVED when every condition holds', () => {
    // claim: preserved-all
    const r = computeVerdict(input());
    expect(r.verdict).toBe('PRESERVED');
    expect(r.reasons).toEqual([]);
  });

  const changedCases: Array<[string, Partial<VerdictInput>, string]> = [
    ['test regressed', { patched: snap([t('one', 'fail'), t('two')], { 'r:s#c1': 'proven' }) }, 'test-regressed'],
    ['test turned skip', { patched: snap([t('one', 'skip'), t('two')], { 'r:s#c1': 'proven' }) }, 'test-regressed'],
    ['test vanished', { patched: snap([t('two'), t('three')], { 'r:s#c1': 'proven' }) }, 'test-vanished'],
    ['claim failed', { patched: snap([t('one'), t('two')], { 'r:s#c1': 'failed' }) }, 'claim-dropped'],
    ['claim error', { patched: snap([t('one'), t('two')], { 'r:s#c1': 'error' }) }, 'claim-dropped'],
    ['claim unexercised', { patched: snap([t('one'), t('two')], { 'r:s#c1': 'unexercised' }) }, 'claim-dropped'],
    ['claim missing', { patched: snap([t('one'), t('two')], {}) }, 'claim-count'],
    ['extra claim', { patched: snap([t('one'), t('two')], { 'r:s#c1': 'proven', 'r:s#c2': 'proven' }) }, 'claim-count'],
    ['fewer tests', { patched: snap([t('one')], { 'r:s#c1': 'proven' }) }, 'test-count-drop'],
    ['advisory unresolved', { advisoriesAfter: [adv('GHSA-1')] }, 'advisory-unresolved'],
    ['unresolved via alias', { advisoriesAfter: [adv('CVE-9', 'high', { aliases: ['ghsa-1'] })] }, 'advisory-unresolved'],
    ['new high advisory', { advisoriesAfter: [adv('GHSA-2', 'critical')] }, 'advisory-new'],
    ['build red', { build: { ok: false } }, 'build-red'],
    ['typecheck red', { typecheck: { ok: false } }, 'typecheck-red'],
  ];
  it.each(changedCases)('CHANGED: %s', (_name, over, kind) => {
    const r = computeVerdict(input(over));
    expect(r.verdict).toBe('CHANGED');
    expect(r.reasons.map((x) => x.kind)).toContain(kind);
  });

  it('lists the exact differing tests and claims', () => {
    // claim: test-regressed
    // claim: claim-dropped
    const r = computeVerdict(input({ patched: snap([t('one', 'fail'), t('two')], { 'r:s#c1': 'failed' }) }));
    expect(r.diff.regressedTests).toEqual([{ id: 'a.test.ts::one', from: 'pass', to: 'fail' }]);
    expect(r.diff.claimDrops).toEqual([{ claim: 'r:s#c1', from: 'proven', to: 'failed' }]);
  });

  it('a vanished test is named by id', () => {
    // claim: test-vanished
    expect(computeVerdict(input({ patched: snap([t('two'), t('x')], { 'r:s#c1': 'proven' }) })).diff.vanishedTests).toEqual(['a.test.ts::one']);
  });

  it('a new test that fails is not a regression, a new advisory below threshold is ignored', () => {
    const r = computeVerdict(input({ patched: snap([t('one'), t('two'), t('new', 'fail')], { 'r:s#c1': 'proven' }), advisoriesAfter: [adv('GHSA-3', 'low')] }));
    expect(r.verdict).toBe('PRESERVED');
    expect(r.diff.newTests).toEqual(['a.test.ts::new']);
  });

  it('a pre-existing advisory that remains below target is not "new"', () => {
    const r = computeVerdict(input({ advisoriesBefore: [adv('GHSA-1'), adv('GHSA-7', 'critical')], advisoriesAfter: [adv('GHSA-7', 'critical')] }));
    expect(r.verdict).toBe('PRESERVED');
  });

  it('excludes flaky tests from comparison and reports them', () => {
    // claim: flaky-excluded
    const flaky = 'a.test.ts::two';
    const r = computeVerdict(input({
      quarantined: [flaky],
      baseline: snap([t('one'), t('two')], { 'r:s#c1': 'proven' }),
      patched: snap([t('one'), t('two', 'fail')], { 'r:s#c1': 'proven' }),
      selectedTestIds: ['a.test.ts::one'],
    }));
    expect(r.verdict).toBe('PRESERVED');
    expect(r.diff.flaky).toEqual([flaky]);
    expect(r.notes.join()).toMatch(/flaky/);
  });

  const inconclusive: Array<[string, Partial<VerdictInput>, string]> = [
    ['flaky in selection', { quarantined: ['a.test.ts::two'], selectedTestIds: ['a.test.ts::two'] }, 'flaky'],
    ['flaky, selection unknown', { quarantined: ['a.test.ts::two'] }, 'flaky'],
    ['patched unparsed', { patched: snap([t('one'), t('two')], { 'r:s#c1': 'proven' }, false) }, 'patched-unparsed'],
    ['baseline unparsed', { baseline: snap([t('one'), t('two')], { 'r:s#c1': 'proven' }, false) }, 'baseline-unparsed'],
    ['no tests selected', { selectedForPackage: 0 }, 'no-selection'],
    ['baseline unexercised', { baseline: snap([t('one'), t('two')], { 'r:s#c1': 'proven', 'r:s#c2': 'unexercised' }), patched: snap([t('one'), t('two')], { 'r:s#c1': 'proven', 'r:s#c2': 'unexercised' }) }, 'baseline-unexercised'],
    ['fingerprint unchanged', { proofs: { baselineFingerprint: 'a', patchedFingerprint: 'a', staleBeforeIngest: [], reprovenWithNewFingerprint: [] } }, 'fingerprint-unchanged'],
    ['proofs did not go stale', { proofs: { ...FP, staleBeforeIngest: [], reprovenWithNewFingerprint: ['r:s#c1'] } }, 'proofs-not-stale'],
    ['proofs not re-proven', { proofs: { ...FP, staleBeforeIngest: ['r:s#c1'], reprovenWithNewFingerprint: [] } }, 'proofs-not-reproven'],
  ];
  it.each(inconclusive)('INCONCLUSIVE: %s', (_n, over, kind) => {
    // claim: inconclusive
    const r = computeVerdict(input(over));
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.reasons.map((x) => x.kind)).toContain(kind);
  });

  it('code fixes do not need package selection or proof staleness', () => {
    const r = computeVerdict(input({ changeType: 'code', selectedForPackage: 0, proofs: undefined }));
    expect(r.verdict).toBe('PRESERVED');
  });

  it('strictUnexercised=false lets baseline gaps through', () => {
    const claims: Record<string, ClaimState> = { 'r:s#c1': 'proven', 'r:s#c2': 'unexercised' };
    const r = computeVerdict(input({ baseline: snap([t('one'), t('two')], claims), patched: snap([t('one'), t('two')], claims), strictUnexercised: false }));
    expect(r.verdict).toBe('PRESERVED');
  });

  it('CHANGED wins over INCONCLUSIVE', () => {
    // claim: precedence
    const r = computeVerdict(input({ selectedForPackage: 0, build: { ok: false } }));
    expect(r.verdict).toBe('CHANGED');
    expect(r.reasons.map((x) => x.level).sort()).toEqual(['changed', 'inconclusive']);
  });

  it('identifies tests by file and full title only', () => {
    // claim: stable-id
    const a = { ...t('x'), durationMs: 5, message: 'm' };
    const b = { ...t('x'), durationMs: 900 };
    expect(testId(a)).toBe(testId(b));
    expect(testId(t('x', 'pass', 'b.test.ts'))).not.toBe(testId(a));
  });

  it('count and advisory-state claims', () => {
    // claim: count-drop
    // claim: advisory-state
    // claim: build-red
    expect(computeVerdict(input({ patched: snap([t('one')], { 'r:s#c1': 'proven' }) })).verdict).toBe('CHANGED');
    expect(computeVerdict(input({ advisoriesAfter: [adv('GHSA-1')] })).verdict).toBe('CHANGED');
    expect(computeVerdict(input({ build: { ok: false } })).verdict).toBe('CHANGED');
  });
});
