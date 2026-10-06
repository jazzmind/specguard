/**
 * Behavior-preservation verdict: baseline run vs patched run. Pure, no I/O.
 *
 * Spec: specs/core/behavior-verdict.md
 */
import { meetsThreshold, type Advisory, type Severity } from './advisory.js';
import type { TestCaseResult } from './test-results.js';

export type Verdict = 'PRESERVED' | 'CHANGED' | 'INCONCLUSIVE';
export type ClaimState = 'proven' | 'failed' | 'error' | 'unexercised' | 'stale' | 'unproven';

/** Stable identity of a test: independent of duration and failure message. */
export function testId(t: Pick<TestCaseResult, 'file' | 'fullTitle' | 'title'>): string {
  return `${t.file}::${t.fullTitle || t.title}`;
}

export interface RunSnapshot {
  tests: TestCaseResult[];
  /** False when any report could not be read or parsed. */
  parsed: boolean;
  /** Effective claim states keyed by claim ref. */
  claims: Record<string, ClaimState>;
}

export interface ProofReprove {
  baselineFingerprint?: string;
  patchedFingerprint?: string;
  /** Baseline-proven claims that read as `stale` under the patched dependency fingerprint, before re-ingest. */
  staleBeforeIngest: string[];
  /** Claims whose patched-ledger row is `proven` and carries the patched fingerprint. */
  reprovenWithNewFingerprint: string[];
}

export interface VerdictInput {
  threshold: Severity;
  changeType: 'dependency' | 'code';
  /** Ids (and aliases) of the advisories the change is meant to fix. */
  targetAdvisoryIds: string[];
  baseline: RunSnapshot;
  patched: RunSnapshot;
  /** Test ids whose status differed between the two baseline runs. */
  quarantined: string[];
  /** Advisories before the patch (all severities). */
  advisoriesBefore: Advisory[];
  /** Advisories found by the detector after the patch. */
  advisoriesAfter: Advisory[];
  build: { ok: boolean };
  typecheck: { ok: boolean };
  proofs?: ProofReprove;
  /**
   * Ids of the tests selected for the package (import scan, claim tags). A flaky test inside this set
   * makes the verdict INCONCLUSIVE; flaky tests outside it are excluded and only reported.
   * Undefined: every flaky test counts as selected.
   */
  selectedTestIds?: string[];
  /** How many tests were selected for the package (import scan, claims). 0 is a coverage gap. */
  selectedForPackage: number;
  /** Whether `selectedForPackage === 0` should block (dependency bumps). Default true for dependency changes. */
  requireSelection?: boolean;
  /** Baseline claims no test exercised. Default: treated as a coverage gap. */
  baselineUnexercised?: string[];
  /** Treat baseline-unexercised claims as inconclusive. Default true. */
  strictUnexercised?: boolean;
}

export interface Reason {
  kind: string;
  level: 'changed' | 'inconclusive';
  detail: string;
}

export interface VerdictDiff {
  regressedTests: Array<{ id: string; from: 'pass'; to: 'fail' | 'skip'; message?: string }>;
  vanishedTests: string[];
  newTests: string[];
  claimDrops: Array<{ claim: string; from: ClaimState; to: ClaimState }>;
  flaky: string[];
  testCount: { baseline: number; patched: number };
  claimCount: { baseline: number; patched: number };
  unresolvedAdvisories: string[];
  newAdvisories: string[];
}

export interface VerdictResult {
  verdict: Verdict;
  reasons: Reason[];
  /** Non-blocking observations (excluded flaky tests outside the selection). */
  notes: string[];
  diff: VerdictDiff;
}

const advIds = (a: Advisory) => [a.id, ...a.aliases].map((s) => s.toUpperCase());

export function computeVerdict(input: VerdictInput): VerdictResult {
  const reasons: Reason[] = [];
  const quarantined = new Set(input.quarantined);
  const add = (level: Reason['level'], kind: string, detail: string) => reasons.push({ kind, level, detail });

  const base = new Map<string, TestCaseResult>();
  for (const t of input.baseline.tests) if (!quarantined.has(testId(t))) base.set(testId(t), t);
  const patched = new Map<string, TestCaseResult>();
  for (const t of input.patched.tests) if (!quarantined.has(testId(t))) patched.set(testId(t), t);

  // --- tests ---------------------------------------------------------------
  const regressed: VerdictDiff['regressedTests'] = [];
  const vanished: string[] = [];
  for (const [id, t] of base) {
    if (t.status !== 'pass') continue;
    const now = patched.get(id);
    if (!now) vanished.push(id);
    else if (now.status !== 'pass') regressed.push({ id, from: 'pass', to: now.status, ...(now.message ? { message: now.message } : {}) });
  }
  const newTests = [...patched.keys()].filter((id) => !base.has(id));
  if (regressed.length) add('changed', 'test-regressed', `${regressed.length} baseline-passing test(s) no longer pass: ${regressed.slice(0, 5).map((r) => r.id).join('; ')}`);
  if (vanished.length) add('changed', 'test-vanished', `${vanished.length} baseline-passing test(s) disappeared: ${vanished.slice(0, 5).join('; ')}`);
  if (patched.size < base.size) add('changed', 'test-count-drop', `test count fell from ${base.size} to ${patched.size}`);

  // --- claims --------------------------------------------------------------
  const claimDrops: VerdictDiff['claimDrops'] = [];
  for (const [claim, from] of Object.entries(input.baseline.claims)) {
    if (from !== 'proven') continue;
    const to = input.patched.claims[claim] ?? 'unproven';
    if (to === 'failed' || to === 'error' || to === 'unexercised') claimDrops.push({ claim, from, to });
  }
  if (claimDrops.length) add('changed', 'claim-dropped', `${claimDrops.length} proven claim(s) dropped: ${claimDrops.slice(0, 5).map((c) => `${c.claim} (${c.to})`).join('; ')}`);
  const baseClaims = Object.keys(input.baseline.claims).length;
  const patchedClaims = Object.keys(input.patched.claims).length;
  if (patchedClaims !== baseClaims) add('changed', 'claim-count', `claim count changed from ${baseClaims} to ${patchedClaims}`);

  // --- advisories ----------------------------------------------------------
  const target = new Set(input.targetAdvisoryIds.map((s) => s.toUpperCase()));
  const unresolved = input.advisoriesAfter.filter((a) => advIds(a).some((i) => target.has(i)));
  if (unresolved.length) add('changed', 'advisory-unresolved', `advisory still present after the patch: ${unresolved.map((a) => a.id).join(', ')}`);
  const beforeIds = new Set(input.advisoriesBefore.flatMap(advIds));
  const newAdv = input.advisoriesAfter.filter(
    (a) => meetsThreshold(a.severity, input.threshold) && !advIds(a).some((i) => beforeIds.has(i)) && !advIds(a).some((i) => target.has(i)),
  );
  if (newAdv.length) add('changed', 'advisory-new', `new advisory at or above ${input.threshold}: ${newAdv.map((a) => `${a.id} (${a.severity})`).join(', ')}`);

  // --- build ---------------------------------------------------------------
  if (!input.build.ok) add('changed', 'build-red', 'build failed after the patch');
  if (!input.typecheck.ok) add('changed', 'typecheck-red', 'typecheck failed after the patch');

  // --- inconclusive conditions ----------------------------------------------
  if (!input.baseline.parsed) add('inconclusive', 'baseline-unparsed', 'baseline test output could not be parsed');
  if (!input.patched.parsed) add('inconclusive', 'patched-unparsed', 'patched test output could not be parsed');
  const notes: string[] = [];
  if (input.quarantined.length) {
    const sel = input.selectedTestIds ? new Set(input.selectedTestIds) : undefined;
    const inSel = sel ? input.quarantined.filter((id) => sel.has(id)) : input.quarantined;
    if (inSel.length) add('inconclusive', 'flaky', `${inSel.length} flaky test(s) in the selected set were excluded from the comparison: ${inSel.slice(0, 5).join('; ')}`);
    if (inSel.length < input.quarantined.length) notes.push(`${input.quarantined.length - inSel.length} flaky test(s) outside the selected set were excluded: ${input.quarantined.filter((i) => !inSel.includes(i)).slice(0, 5).join('; ')}`);
  }
  const mustSelect = input.requireSelection ?? input.changeType === 'dependency';
  if (mustSelect && input.selectedForPackage === 0) add('inconclusive', 'no-selection', 'no test imports or exercises the affected package (0 tests selected)');
  const unex = input.baselineUnexercised ?? Object.entries(input.baseline.claims).filter(([, s]) => s === 'unexercised').map(([c]) => c);
  if ((input.strictUnexercised ?? true) && unex.length) add('inconclusive', 'baseline-unexercised', `${unex.length} claim(s) had no exercising test in the baseline: ${unex.slice(0, 5).join('; ')}`);
  if (input.changeType === 'dependency' && input.proofs && Object.values(input.baseline.claims).includes('proven')) {
    const p = input.proofs;
    const provenBase = Object.entries(input.baseline.claims).filter(([, s]) => s === 'proven').map(([c]) => c);
    if (!p.baselineFingerprint || !p.patchedFingerprint || p.baselineFingerprint === p.patchedFingerprint) {
      add('inconclusive', 'fingerprint-unchanged', 'the dependency fingerprint did not change, so proofs could not go stale');
    } else {
      const stale = new Set(p.staleBeforeIngest);
      const reproven = new Set(p.reprovenWithNewFingerprint);
      const notStale = provenBase.filter((c) => !stale.has(c));
      const notReproven = provenBase.filter((c) => !reproven.has(c));
      if (notStale.length) add('inconclusive', 'proofs-not-stale', `${notStale.length} proof(s) did not go stale after the bump`);
      if (notReproven.length) add('inconclusive', 'proofs-not-reproven', `${notReproven.length} proof(s) were not re-proven with the new fingerprint`);
    }
  }

  const verdict: Verdict = reasons.some((r) => r.level === 'changed') ? 'CHANGED' : reasons.length ? 'INCONCLUSIVE' : 'PRESERVED';
  return {
    verdict,
    reasons,
    notes,
    diff: {
      regressedTests: regressed,
      vanishedTests: vanished,
      newTests,
      claimDrops,
      flaky: [...input.quarantined],
      testCount: { baseline: base.size, patched: patched.size },
      claimCount: { baseline: baseClaims, patched: patchedClaims },
      unresolvedAdvisories: unresolved.map((a) => a.id),
      newAdvisories: newAdv.map((a) => a.id),
    },
  };
}
