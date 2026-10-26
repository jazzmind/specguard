import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import {
  composeCapabilityStatement,
  composeSystemStatement,
  computeStatement,
  explainCapability,
  headlineLines,
  resolveProofPolicy,
  statementLine,
  type ApprovalInfo,
  type CapabilityInput,
  type CapabilityStatement,
  type ClaimInput,
  type CoverageInput,
  type ExampleInput,
  type PillarName,
  type ProofPolicy,
  type Reason,
  type ReasonCode,
  type StatementInput,
  type SystemStatement,
} from '../../src/core/proof-statement.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HASH = 'ab12'.repeat(16);
const APPROVAL: ApprovalInfo = { method: 'command', by: 'Ada', date: '2026-10-20', entry: '2026-10-20-approve' };

const noPolicy = (): ProofPolicy => resolveProofPolicy();
const policyWith = (proof: Record<string, unknown>): ProofPolicy => resolveProofPolicy({ proof });
const strictPolicy = (): ProofPolicy => resolveProofPolicy(undefined, { strict: true });

function claim(id: string, over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    ref: `cart#${id}`,
    id,
    text: `The cart does ${id}.`,
    claimHash: HASH,
    approval: APPROVAL,
    required: ['unit'],
    assurance: 'tested',
    evidence: 'test',
    proof: { verdict: 'proven', layers: { unit: 'proven' }, missing: [], complete: true },
    layerEvidence: { unit: 'test' },
    proofOrigins: ['ci'],
    proofShas: [SHA],
    testability: { ref: `cart#${id}`, testable: true, findings: [] },
    strength: {
      ref: `cart#${id}`,
      meaningful: true,
      perLayer: { unit: { strong: [{}], weak: [], skipped: [], conditional: [], unknown: [] } },
      reasons: [],
      property: false,
    },
    examples: [],
    ...over,
  };
}

const COVERAGE: CoverageInput = {
  source: 'capability',
  selection: 'tests',
  evidence: { runId: 'ci-1', origin: 'ci', repoSha: SHA },
  reported: 2,
  stale: [],
  lines: { executable: 100, hit: 90, pct: 90 },
  unreached: { lines: 0 },
  testsStale: false,
};

function cap(over: Partial<CapabilityInput> = {}): CapabilityInput {
  const claims = over.claims ?? [claim('total'), claim('tax')];
  return {
    id: 'cart',
    specKey: 'cart',
    title: 'Cart',
    status: 'active',
    inputs: ['specs/capabilities/cart.md', 'tests/cart.test.ts', 'src/cart.ts'],
    ownedFiles: ['src/cart.ts'],
    claims,
    testability: { capability: 'cart', claims: claims.map((c) => c.testability), capabilityFindings: [], testable: true },
    coverage: COVERAGE,
    weakening: [],
    approvalsInUse: true,
    changeMode: false,
    ...over,
  };
}

function statementFor(capOver: Partial<CapabilityInput> = {}, policy: ProofPolicy = noPolicy(), head: StatementInput['head'] = { sha: SHA, dirty: [] }): CapabilityStatement {
  return composeCapabilityStatement(cap(capOver), { head, policy });
}

const allReasons = (s: CapabilityStatement): Reason[] => (['approved', 'testable', 'aligned', 'conforms'] as PillarName[]).flatMap((p) => s.pillars[p].reasons);
const find = (s: CapabilityStatement, code: ReasonCode, claimRef?: string): Reason | undefined => allReasons(s).find((r) => r.code === code && (claimRef === undefined || r.claim === claimRef));
const codes = (s: CapabilityStatement): ReasonCode[] => allReasons(s).map((r) => r.code);

describe('proof statement: policy [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-policy-only-blocks]
  it('resolves defaults with every gate off and strict with every gate on', () => {
    const d = noPolicy();
    expect(Object.entries(d).filter(([k, v]) => k.startsWith('require') && v === true)).toEqual([]);
    expect(d).toMatchObject({ enforceLayers: 'warn', minDiffCoverage: 80, mutation: { minScore: 70, minKilled: 1, timeoutAsKilled: true } });
    const s = strictPolicy();
    expect([s.requireApproval, s.requireTestable, s.requireStrength, s.requireSensitivity, s.requireConforms, s.requireAlignment, s.requireCi]).toEqual(Array(7).fill(true));
    expect(s.enforceLayers).toBe('fail');
    expect(resolveProofPolicy({ proof: { strict: true } }).requireAlignment).toBe(true);
    expect(resolveProofPolicy({ proof: { strict: true } }, { strict: false }).requireAlignment).toBe(false);
    expect(resolveProofPolicy({ proof: { requireApproval: true, minDiffCoverage: 90 }, mutation: { minScore: 50 } })).toMatchObject({ requireApproval: true, requireConforms: false, minDiffCoverage: 90, mutation: { minScore: 50, minKilled: 1 } });
  });
});

describe('proof statement: policy config [traceability-and-drift]', () => {
  const base = {
    apps: [{ name: 'a', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' }],
    llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' },
  };
  const load = async (proof: unknown) => {
    const root = mkdtempSync(path.join(tmpdir(), 'specguard-stmt-'));
    try {
      mkdirSync(path.join(root, '.specguard'), { recursive: true });
      writeFileSync(path.join(root, '.specguard', 'config.json'), JSON.stringify({ ...base, proof }));
      return await loadConfig(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  // [claims: capabilities/traceability-and-drift#statement-policy-only-blocks]
  it('config accepts every proof gate flag and resolves them into the policy', async () => {
    const config = await load({ requireApproval: true, requireTestable: true, requireStrength: true, requireSensitivity: true, requireConforms: true, requireAlignment: true, requireCi: true, minDiffCoverage: 90, enforceLayers: 'fail' });
    const policy = resolveProofPolicy({ proof: config.proof });
    expect(policy).toMatchObject({ requireApproval: true, requireTestable: true, requireStrength: true, requireSensitivity: true, requireConforms: true, requireAlignment: true, requireCi: true, minDiffCoverage: 90, enforceLayers: 'fail' });
    expect(resolveProofPolicy({ proof: (await load({ strict: true })).proof }).requireSensitivity).toBe(true);
    await expect(load({ requireCi: 'yes' })).rejects.toThrow();
    await expect(load({ minDiffCoverage: 140 })).rejects.toThrow();
  });
});

describe('proof statement: certified rule [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('all pillars ok with ci evidence and clean inputs -> certified at the head sha', () => {
    const s = statementFor();
    expect(s.level).toBe('certified');
    expect(s.certifiedAt).toBe(SHA);
    for (const p of ['approved', 'testable', 'aligned', 'conforms'] as PillarName[]) expect(s.pillars[p].status).toBe('ok');
    expect(s.blocking).toEqual([]);
    expect(s.metrics).toMatchObject({ claims: 2, approved: 2, testable: 2, proven: 2, meaningful: 2, lineCoverage: 90, diffCoverage: null, mutationScore: null });
    expect(s.evidence).toMatchObject({ origins: ['ci'], shas: [SHA], coverageRunId: 'ci-1' });
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('local evidence -> provisional with a LOCAL_EVIDENCE note', () => {
    const s = statementFor({ claims: [claim('total', { proofOrigins: ['local'] }), claim('tax')] });
    expect(s.level).toBe('provisional');
    expect(s.certifiedAt).toBeUndefined();
    expect(find(s, 'LOCAL_EVIDENCE', 'cart#total')).toMatchObject({ outcome: 'note', blocking: false });
    expect(s.pillars.conforms.status).toBe('ok');
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('server evidence and local coverage also make the level provisional', () => {
    expect(statementFor({ claims: [claim('total', { proofOrigins: ['server'] })] }).level).toBe('provisional');
    const s = statementFor({ coverage: { ...COVERAGE, evidence: { runId: 'l-1', origin: 'local' } } });
    expect(s.level).toBe('provisional');
    expect(find(s, 'LOCAL_EVIDENCE')?.pillar).toBe('aligned');
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('a dirty input file -> provisional with DIRTY_TREE', () => {
    const s = statementFor({}, noPolicy(), { sha: SHA, dirty: ['src/cart.ts'] });
    expect(s.level).toBe('provisional');
    expect(find(s, 'DIRTY_TREE')).toMatchObject({ outcome: 'note', data: { files: ['src/cart.ts'] } });
    // a dirty file the capability does not use changes nothing
    expect(statementFor({}, noPolicy(), { sha: SHA, dirty: ['README.md'] }).level).toBe('certified');
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('an unknown commit can only be provisional', () => {
    const s = statementFor({}, noPolicy(), { dirty: [] });
    expect(s.level).toBe('provisional');
    expect(find(s, 'DIRTY_TREE')?.data).toEqual({ unknownHead: true });
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('requireCi turns local evidence into CI_EVIDENCE_REQUIRED (unknown, blocking)', () => {
    const s = statementFor({ claims: [claim('total', { proofOrigins: ['local'] })] }, policyWith({ requireCi: true }));
    expect(find(s, 'LOCAL_EVIDENCE')).toBeUndefined();
    expect(find(s, 'CI_EVIDENCE_REQUIRED')).toMatchObject({ outcome: 'unknown', blocking: true, claim: 'cart#total' });
    expect(s.pillars.conforms.status).toBe('unknown');
    expect(s.level).toBe('not-certified');
    // without requireCi the same evidence is only a note
    expect(find(statementFor({ claims: [claim('total', { proofOrigins: ['local'] })] }), 'CI_EVIDENCE_REQUIRED')).toBeUndefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('the system is certified only when every non-planned capability is certified and nothing is unowned', () => {
    const base = (caps: CapabilityInput[], unowned: string[] = []): SystemStatement => composeSystemStatement({ generated: 'g', head: { sha: SHA, dirty: [] }, policy: noPolicy(), unowned, capabilities: caps });
    expect(base([cap(), cap({ id: 'pay', title: 'Pay' })]).level).toBe('certified');
    expect(base([cap(), cap({ id: 'pay', title: 'Pay' })]).certifiedAt).toBe(SHA);
    expect(base([cap(), cap({ id: 'pay', status: 'planned' })]).level).toBe('certified');
    expect(base([cap()], ['src/stray.ts']).level).toBe('not-certified');
    expect(base([cap()], ['src/stray.ts']).system.reasons[0]).toMatchObject({ code: 'UNOWNED_FILES', blocking: false });
    expect(base([cap(), cap({ id: 'pay', claims: [claim('x', { proofOrigins: ['local'] })] })]).level).toBe('provisional');
    expect(base([cap(), cap({ id: 'pay', claims: [claim('x', { approval: undefined })] })]).level).toBe('not-certified');
    const mixed = base([cap({ id: 'a', claims: [claim('x', { proofOrigins: ['local'] })] }), cap({ id: 'b', claims: [claim('x', { approval: undefined })] }), cap({ id: 'c' }), cap({ id: 'd', status: 'planned' })]);
    expect(mixed.level).toBe('not-certified');
    expect(mixed.counts).toEqual({ certified: 1, provisional: 1, 'not-certified': 1, planned: 1 });
    expect(base([cap({ status: 'planned' })]).level).toBe('planned');
  });
});

describe('proof statement: approved pillar [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-four-pillars, capabilities/traceability-and-drift#statement-policy-only-blocks]
  it('an unapproved claim fails Approved, and blocks only with requireApproval', () => {
    const claims = [claim('total', { approval: undefined }), claim('tax')];
    const off = statementFor({ claims });
    expect(off.pillars.approved.status).toBe('fail');
    expect(find(off, 'APPROVAL_MISSING')).toMatchObject({ claim: 'cart#total', outcome: 'fail', blocking: false, gate: 'requireApproval', fix: 'specguard spec approve cart#total' });
    expect(off.blocking).toEqual([]);
    expect(off.pillars.approved.summary).toBe('1/2 claims approved');
    const on = statementFor({ claims }, policyWith({ requireApproval: true }));
    expect(on.pillars.approved.status).toBe('fail');
    expect(on.blocking.map((r) => r.code)).toEqual(['APPROVAL_MISSING']);
  });

  // [claims: capabilities/traceability-and-drift#statement-approval-own-pillar]
  it('approval never changes the ledger verdict: an unapproved but proven claim is still proven', () => {
    const s = statementFor({ claims: [claim('total', { approval: undefined })] }, policyWith({ requireApproval: true, requireConforms: true }));
    expect(s.pillars.conforms.status).toBe('ok');
    expect(s.metrics).toMatchObject({ approved: 0, proven: 1 });
    expect(s.claims[0]!.pillars).toMatchObject({ approved: 'fail', conforms: 'ok' });
    expect(allReasons(s).filter((r) => r.pillar === 'conforms' && r.outcome !== 'note')).toEqual([]);
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('an approval at an older hash -> APPROVAL_STALE', () => {
    const s = statementFor({ claims: [claim('total', { approval: undefined, lastApprovedHash: 'ff'.repeat(32) })] });
    expect(find(s, 'APPROVAL_STALE')).toMatchObject({ claim: 'cart#total', outcome: 'fail' });
    expect(find(s, 'APPROVAL_MISSING')).toBeUndefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('no approval entries in the repo -> a single APPROVALS_NOT_IN_USE instead of per-claim noise', () => {
    const s = statementFor({ approvalsInUse: false, claims: [claim('a', { approval: undefined }), claim('b', { approval: undefined }), claim('c', { approval: undefined })] });
    expect(s.pillars.approved.reasons.map((r) => r.code)).toEqual(['APPROVALS_NOT_IN_USE']);
    expect(s.pillars.approved.status).toBe('fail');
    expect(s.pillars.approved.reasons[0]!.fix).toContain('specguard spec approve cart');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('an as-built approval is ok and reported as APPROVED_AS_BUILT', () => {
    const s = statementFor({ claims: [claim('total', { approval: { ...APPROVAL, method: 'as-built' } })] });
    expect(s.pillars.approved.status).toBe('ok');
    expect(find(s, 'APPROVED_AS_BUILT')).toMatchObject({ outcome: 'note', blocking: false, claim: 'cart#total' });
    expect(s.level).toBe('certified');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('example rows need their own approval and proof', () => {
    const row = (id: string, over: Partial<ExampleInput> = {}): ExampleInput => ({ ref: `cart#total/${id}`, id, hash: HASH, approval: APPROVAL, proof: 'proven', proofOrigins: ['ci'], strength: 'meaningful', ...over });
    const s = statementFor({
      claims: [claim('total', { examples: [row('ok'), row('unapproved', { approval: undefined }), row('red', { proof: 'failed' }), row('old', { proof: 'stale' }), row('none', { proof: 'unproven' }), row('weak', { strength: 'not-meaningful' })] })],
    }, strictPolicy());
    expect(find(s, 'EXAMPLE_APPROVAL_MISSING')).toMatchObject({ claim: 'cart#total', example: 'unapproved', outcome: 'fail', blocking: true });
    expect(find(s, 'EXAMPLE_FAILED')).toMatchObject({ example: 'red', outcome: 'fail' });
    expect(find(s, 'EXAMPLE_STALE')).toMatchObject({ example: 'old', outcome: 'unknown' });
    expect(find(s, 'EXAMPLE_UNPROVEN')).toMatchObject({ example: 'none', outcome: 'unknown' });
    expect(find(s, 'EXAMPLE_NOT_MEANINGFUL')).toMatchObject({ example: 'weak', outcome: 'fail' });
    expect(allReasons(s).filter((r) => r.example === 'ok')).toEqual([]);
  });
});

describe('proof statement: testable pillar [traceability-and-drift]', () => {
  const finding = (rule: string, severity: 'error' | 'warn', over: Record<string, unknown> = {}) => ({ rule, severity, matches: ['x'], message: `${rule} fired`, ...over });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a lint error fails Testable; warnings and waived findings are notes', () => {
    const claims = [
      claim('vague', { testability: { ref: 'cart#vague', testable: false, findings: [finding('T-VAGUE', 'error', { matches: ['properly'] })] } }),
      claim('long', { testability: { ref: 'cart#long', testable: true, findings: [finding('T-LONG', 'warn'), finding('T-VAGUE', 'warn', { waived: true })] } }),
    ];
    const s = statementFor({ claims });
    expect(s.pillars.testable.status).toBe('fail');
    expect(find(s, 'LINT_ERROR')).toMatchObject({ claim: 'cart#vague', outcome: 'fail', blocking: false, data: { rule: 'T-VAGUE', matches: ['properly'] } });
    expect(find(s, 'LINT_WARNING')).toMatchObject({ claim: 'cart#long', outcome: 'note' });
    expect(find(s, 'LINT_WAIVED')).toMatchObject({ claim: 'cart#long', outcome: 'note' });
    expect(s.claims.find((c) => c.ref === 'cart#long')!.pillars.testable).toBe('ok');
    expect(s.metrics.testable).toBe(1);
    expect(statementFor({ claims }, policyWith({ requireTestable: true })).blocking.map((r) => r.code)).toEqual(['LINT_ERROR']);
    // warnings alone leave the pillar ok
    expect(statementFor({ claims: [claims[1]!] }).pillars.testable.status).toBe('ok');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('capability-level findings and unanchored bullets count, and T-NO-ANCHOR points at spec tag', () => {
    const noAnchor = { ref: 'cart#?3', testable: false, findings: [finding('T-NO-ANCHOR', 'error')] };
    const s = statementFor({
      testability: { capability: 'cart', claims: [claim('total').testability, noAnchor], capabilityFindings: [finding('T-LAYER-UNKNOWN', 'error', { message: 'unknown layer' })], testable: false },
    });
    expect(s.pillars.testable.status).toBe('fail');
    const errors = s.pillars.testable.reasons.filter((r) => r.code === 'LINT_ERROR');
    expect(errors.map((r) => r.claim)).toEqual([undefined, 'cart#?3']);
    expect(errors[1]!.fix).toBe('specguard spec tag');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a capability without anchored claims -> NO_CLAIMS', () => {
    const s = statementFor({ claims: [], testability: { capability: 'cart', claims: [], capabilityFindings: [], testable: true } });
    expect(s.pillars.testable.reasons.map((r) => r.code)).toEqual(['NO_CLAIMS']);
    expect(s.pillars.testable.status).toBe('fail');
    expect(s.level).toBe('not-certified');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a claim with no required layer gets a NO_LAYERS_DECLARED note', () => {
    const s = statementFor({ claims: [claim('total', { required: [] })] });
    expect(find(s, 'NO_LAYERS_DECLARED')).toMatchObject({ outcome: 'note', claim: 'cart#total' });
    expect(s.pillars.testable.status).toBe('ok');
  });
});

describe('proof statement: planned capabilities [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a planned capability is level planned; aligned and conforms are PLANNED notes; approved and testable are evaluated', () => {
    const s = statementFor({ status: 'planned', ownedFiles: [], coverage: undefined, claims: [claim('total', { approval: undefined, proof: { verdict: 'unproven', layers: {}, missing: ['unit'], complete: false } })] }, strictPolicy());
    expect(s.level).toBe('planned');
    expect(s.pillars.aligned.reasons.map((r) => r.code)).toEqual(['PLANNED']);
    expect(s.pillars.conforms.reasons.map((r) => r.code)).toEqual(['PLANNED']);
    expect(s.pillars.aligned.status).toBe('unknown');
    expect(s.pillars.conforms.status).toBe('unknown');
    expect(s.pillars.approved.status).toBe('fail');
    expect(s.blocking.map((r) => r.pillar)).toEqual(['approved']);
    expect(codes(s)).not.toContain('NO_OWNED_FILES');
  });
});

describe('proof statement: aligned pillar [traceability-and-drift]', () => {
  const diff = (pct: number, over: Record<string, unknown> = {}) => ({ changedExecutable: 10, hit: Math.round(pct / 10), pct, missed: [{ file: 'src/cart.ts', lines: [[3, 5]] }], unknownFiles: [] as string[], ...over });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('no owned files -> NO_OWNED_FILES, whose gate is never', () => {
    const s = statementFor({ ownedFiles: [] }, strictPolicy());
    expect(find(s, 'NO_OWNED_FILES')).toMatchObject({ outcome: 'fail', gate: 'never', blocking: false });
    expect(s.pillars.aligned.status).toBe('fail');
    expect(s.blocking.map((r) => r.code)).not.toContain('NO_OWNED_FILES');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('no coverage -> NO_COVERAGE_EVIDENCE unknown, blocking only with requireAlignment', () => {
    const s = statementFor({ coverage: undefined });
    expect(find(s, 'NO_COVERAGE_EVIDENCE')).toMatchObject({ outcome: 'unknown', blocking: false, fix: 'specguard test run --coverage --per-capability' });
    expect(s.pillars.aligned.status).toBe('unknown');
    expect(s.level).toBe('not-certified');
    expect(statementFor({ coverage: undefined }, policyWith({ requireAlignment: true })).blocking.map((r) => r.code)).toEqual(['NO_COVERAGE_EVIDENCE']);
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('suite-only coverage outside change mode -> SUITE_ONLY_COVERAGE unknown', () => {
    const s = statementFor({ coverage: { ...COVERAGE, source: 'suite', selection: undefined } });
    expect(find(s, 'SUITE_ONLY_COVERAGE')).toMatchObject({ outcome: 'unknown' });
    expect(s.pillars.aligned.status).toBe('unknown');
    const files = statementFor({ coverage: { ...COVERAGE, selection: 'files' } });
    expect(find(files, 'SUITE_ONLY_COVERAGE')).toBeDefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a suite diff below the minimum -> DIFF_COVERAGE_LOW fail', () => {
    const s = statementFor({ changeMode: true, coverage: { ...COVERAGE, source: 'suite', selection: undefined, diff: diff(50) } });
    expect(find(s, 'DIFF_COVERAGE_LOW')).toMatchObject({ outcome: 'fail', data: { pct: 50, missed: ['src/cart.ts'] } });
    // at or above the minimum the suite still cannot show reach
    const ok = statementFor({ changeMode: true, coverage: { ...COVERAGE, source: 'suite', selection: undefined, diff: diff(80) } });
    expect(find(ok, 'DIFF_COVERAGE_LOW')).toBeUndefined();
    expect(find(ok, 'SUITE_ONLY_COVERAGE')).toBeDefined();
    // the minimum is policy
    expect(find(statementFor({ changeMode: true, coverage: { ...COVERAGE, source: 'suite', selection: undefined, diff: diff(80) } }, policyWith({ minDiffCoverage: 90 })), 'DIFF_COVERAGE_LOW')).toBeDefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('capability tests-selection diff below the minimum -> UNSPECIFIED_CHANGE fail with the missed files', () => {
    const s = statementFor({ changeMode: true, coverage: { ...COVERAGE, diff: diff(40) } });
    expect(find(s, 'UNSPECIFIED_CHANGE')).toMatchObject({ outcome: 'fail', data: { pct: 40, missed: ['src/cart.ts'] } });
    const ok = statementFor({ changeMode: true, coverage: { ...COVERAGE, diff: diff(95) } });
    expect(ok.pillars.aligned.status).toBe('ok');
    // diff coverage is only judged in change mode
    expect(statementFor({ changeMode: false, coverage: { ...COVERAGE, diff: diff(10) } }).pillars.aligned.status).toBe('ok');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('claim tests that reach no owned code fail', () => {
    const s = statementFor({ coverage: { ...COVERAGE, lines: { executable: 100, hit: 0, pct: 0 } } });
    expect(find(s, 'CLAIM_TESTS_REACH_NO_OWNED_CODE')).toMatchObject({ outcome: 'fail' });
    expect(s.pillars.aligned.status).toBe('fail');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a changed file without fresh coverage, or a changed test selection -> COVERAGE_STALE unknown', () => {
    const unknownFile = statementFor({ changeMode: true, coverage: { ...COVERAGE, diff: diff(100, { unknownFiles: ['src/cart.ts'] }) } });
    expect(find(unknownFile, 'COVERAGE_STALE')).toMatchObject({ outcome: 'unknown' });
    expect(unknownFile.pillars.aligned.status).toBe('unknown');
    expect(find(statementFor({ coverage: { ...COVERAGE, testsStale: true } }), 'COVERAGE_STALE')).toBeDefined();
    expect(find(statementFor({ coverage: { ...COVERAGE, reported: 0, stale: ['src/cart.ts'] } }), 'COVERAGE_STALE')).toBeDefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('unreached owned code outside change mode is a note only', () => {
    const s = statementFor({ coverage: { ...COVERAGE, unreached: { lines: 12 } } });
    expect(find(s, 'UNREACHED_OWNED_CODE')).toMatchObject({ outcome: 'note', data: { lines: 12 } });
    expect(s.pillars.aligned.status).toBe('ok');
    expect(find(statementFor({ changeMode: true, coverage: { ...COVERAGE, unreached: { lines: 12 } } }), 'UNREACHED_OWNED_CODE')).toBeUndefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('an intent gap is a note that never blocks', () => {
    const s = statementFor({ intentGap: { codeDate: '2026-10-20', intentDate: '2026-10-01' } }, strictPolicy());
    expect(find(s, 'INTENT_GAP')).toMatchObject({ outcome: 'note', gate: 'never', blocking: false });
    expect(s.pillars.aligned.status).toBe('ok');
  });
});

describe('proof statement: conforms pillar [traceability-and-drift]', () => {
  const proof = (verdict: ClaimInput['proof']['verdict'], over: Partial<ClaimInput['proof']> = {}): ClaimInput['proof'] => ({ verdict, layers: { unit: verdict }, missing: [], complete: verdict === 'proven', ...over });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars, capabilities/traceability-and-drift#statement-approval-own-pillar]
  it('ledger failed/error -> fail; stale/unproven -> unknown; unexercised without tests -> NO_TAGGED_TESTS', () => {
    const one = (verdict: ClaimInput['proof']['verdict'], over: Partial<ClaimInput> = {}): CapabilityStatement => statementFor({ claims: [claim('total', { proof: proof(verdict), ...over })] });
    expect(find(one('failed'), 'CLAIM_FAILED')).toMatchObject({ outcome: 'fail', blocking: false });
    expect(find(one('error'), 'CLAIM_ERROR')).toMatchObject({ outcome: 'fail' });
    expect(find(one('stale'), 'CLAIM_STALE')).toMatchObject({ outcome: 'unknown', fix: 'specguard test run' });
    expect(find(one('unproven'), 'CLAIM_UNPROVEN')).toMatchObject({ outcome: 'unknown' });
    expect(find(one('unexercised'), 'CLAIM_UNEXERCISED')).toMatchObject({ outcome: 'unknown' });
    const noTests = one('unexercised', { strength: { ref: 'cart#total', meaningful: false, perLayer: {}, reasons: [{ code: 'NO_TAGGED_TESTS' }], property: false } });
    expect(find(noTests, 'NO_TAGGED_TESTS')).toMatchObject({ outcome: 'fail' });
    expect(find(noTests, 'CLAIM_UNEXERCISED')).toBeUndefined();
    expect(one('failed').pillars.conforms.status).toBe('fail');
    expect(one('stale').pillars.conforms.status).toBe('unknown');
    expect(one('failed').pillars.conforms.summary).toBe('0 proven, 1 failed, 0 stale');
    expect(statementFor({ claims: [claim('total', { proof: proof('failed') })] }, policyWith({ requireConforms: true })).blocking.map((r) => r.code)).toEqual(['CLAIM_FAILED']);
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a missing required layer: untested -> LAYER_UNTESTED, tested but unproven -> LAYER_MISSING', () => {
    const empty = { strong: [], weak: [], skipped: [], conditional: [], unknown: [] };
    const base = { proof: proof('unproven', { layers: {}, missing: ['unit', 'e2e'] }), required: ['unit', 'e2e'] as ClaimInput['required'] };
    const s = statementFor({ claims: [claim('total', { ...base, strength: { ref: 'cart#total', meaningful: false, perLayer: { unit: { ...empty, strong: [{}] }, e2e: empty }, reasons: [], property: false } })] });
    expect(find(s, 'LAYER_MISSING')).toMatchObject({ outcome: 'unknown', data: { layer: 'unit' } });
    expect(find(s, 'LAYER_UNTESTED')).toMatchObject({ outcome: 'fail', data: { layer: 'e2e' } });
    // gate `layers`: requireConforms or enforceLayers fail
    expect(s.blocking).toEqual([]);
    expect(statementFor({ claims: [claim('total', base)] }, policyWith({ enforceLayers: 'fail' })).blocking.map((r) => r.code)).toContain('LAYER_MISSING');
    expect(statementFor({ claims: [claim('total', base)] }, policyWith({ requireConforms: true })).blocking.map((r) => r.code)).toContain('LAYER_MISSING');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('an agentic row at the unit layer -> AGENTIC_NOT_ACCEPTED, but fine at functional', () => {
    const s = statementFor({ claims: [claim('total', { layerEvidence: { unit: 'agentic' } })] });
    expect(find(s, 'AGENTIC_NOT_ACCEPTED')).toMatchObject({ outcome: 'fail', data: { layer: 'unit', evidence: 'agentic' } });
    const fn = statementFor({ claims: [claim('page', { required: ['functional'], proof: { verdict: 'proven', layers: { functional: 'proven' }, missing: [], complete: true }, layerEvidence: { functional: 'agentic' } })] });
    expect(find(fn, 'AGENTIC_NOT_ACCEPTED')).toBeUndefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars, capabilities/traceability-and-drift#statement-policy-only-blocks]
  it('weak-only, conditional-only and all-skipped map to their codes; blocking only with requireStrength', () => {
    const withReason = (code: 'WEAK_ONLY' | 'CONDITIONAL_ONLY' | 'ALL_SKIPPED' | 'LAYER_NOT_MEANINGFUL', layer?: string) =>
      claim('total', { strength: { ref: 'cart#total', meaningful: false, perLayer: { unit: { strong: [], weak: [{}], skipped: [], conditional: [], unknown: [] } }, reasons: [{ code, ...(layer ? { layer } : {}) }], property: false } });
    const expected: Array<[Parameters<typeof withReason>[0], ReasonCode]> = [['WEAK_ONLY', 'WEAK_ONLY'], ['CONDITIONAL_ONLY', 'CONDITIONAL_ONLY'], ['ALL_SKIPPED', 'TESTS_SKIPPED_ONLY'], ['LAYER_NOT_MEANINGFUL', 'LAYER_NOT_MEANINGFUL']];
    for (const [reason, code] of expected) {
      const off = statementFor({ claims: [withReason(reason, 'unit')] });
      expect(find(off, code)).toMatchObject({ outcome: 'fail', blocking: false });
      expect(off.pillars.conforms.status).toBe('fail');
      expect(statementFor({ claims: [withReason(reason, 'unit')] }, policyWith({ requireStrength: true })).blocking.map((r) => r.code)).toEqual([code]);
      // requireConforms alone does not gate strength
      expect(statementFor({ claims: [withReason(reason, 'unit')] }, policyWith({ requireConforms: true })).blocking).toEqual([]);
    }
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('strength not computed -> STRENGTH_UNKNOWN; unsupported languages too', () => {
    const s = statementFor({ claims: [claim('total', { strength: undefined })] });
    expect(find(s, 'STRENGTH_UNKNOWN')).toMatchObject({ outcome: 'unknown', claim: 'cart#total' });
    expect(s.pillars.conforms.status).toBe('unknown');
    expect(s.metrics.meaningful).toBeNull();
    const unsupported = statementFor({ claims: [claim('total', { strength: { ref: 'cart#total', meaningful: 'unknown', perLayer: {}, reasons: [{ code: 'STRENGTH_UNKNOWN' }], property: false } })] });
    expect(find(unsupported, 'STRENGTH_UNKNOWN')).toBeDefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a changed claim without mutation or red-green -> SENSITIVITY_MISSING', () => {
    const changed = (over: Partial<ClaimInput> = {}, capOver: Partial<CapabilityInput> = {}, policy: ProofPolicy = noPolicy()) =>
      statementFor({ changeMode: true, claims: [claim('total', { change: 'modified', ...over })], ...capOver }, policy);
    const s = changed();
    expect(find(s, 'SENSITIVITY_MISSING')).toMatchObject({ outcome: 'unknown', gate: 'requireSensitivity', blocking: false });
    expect(changed({}, {}, policyWith({ requireSensitivity: true })).blocking.map((r) => r.code)).toEqual(['SENSITIVITY_MISSING']);
    expect(find(changed({ change: 'added' }), 'SENSITIVITY_MISSING')).toBeDefined();
    expect(find(changed({ redGreen: 'ok' }), 'SENSITIVITY_MISSING')).toBeUndefined();
    expect(find(changed({ redGreen: 'fail' }), 'SENSITIVITY_MISSING')).toMatchObject({ outcome: 'fail' });
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a changed claim with a kill and a score at the minimum is ok; NOT_KILLED and SCORE_LOW fail; stale is unknown', () => {
    const mut = (over: Record<string, unknown> = {}) => ({ ref: 'cart#total', considered: 10, killed: 8, survived: 2, score: 80, stale: false, limits: [], ...over });
    const changed = (m: ReturnType<typeof mut>, capScore: number | null = null) =>
      statementFor({ changeMode: true, mutation: { score: capScore }, claims: [claim('total', { change: 'modified', mutation: m })] });
    expect(changed(mut()).pillars.conforms.status).toBe('ok');
    expect(changed(mut({ score: 70 })).pillars.conforms.status).toBe('ok');
    expect(find(changed(mut({ killed: 0, survived: 10, score: 0 })), 'MUTATION_NOT_KILLED')).toMatchObject({ outcome: 'fail' });
    expect(find(changed(mut({ score: 50 })), 'MUTATION_SCORE_LOW')).toMatchObject({ outcome: 'fail', data: { score: 50, minScore: 70 } });
    expect(find(changed(mut({ stale: true })), 'MUTATION_STALE')).toMatchObject({ outcome: 'unknown' });
    // without a per-claim score the capability score stands in
    expect(find(changed(mut({ score: null }), 40), 'MUTATION_SCORE_LOW')).toBeDefined();
    expect(changed(mut({ score: null }), 90).pillars.conforms.status).toBe('ok');
    // no mutant in scope is not a kill
    expect(find(changed(mut({ considered: 0, killed: 0 })), 'SENSITIVITY_MISSING')).toBeDefined();
    expect(changed(mut()).metrics.mutationScore).toBeNull();
    expect(changed(mut(), 66).metrics.mutationScore).toBe(66);
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('unchanged claims never need sensitivity, and without a base it is not evaluated', () => {
    expect(codes(statementFor({ changeMode: true, claims: [claim('total', { change: 'unchanged' })] }))).not.toContain('SENSITIVITY_MISSING');
    expect(codes(statementFor({ changeMode: false, claims: [claim('total', { change: 'modified' })] }))).not.toContain('SENSITIVITY_MISSING');
    expect(codes(statementFor({ claims: [claim('total')] }))).not.toContain('SENSITIVITY_MISSING');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('assurance property needs a strong property test; bounded -> ASSURANCE_TOOLING_MISSING', () => {
    expect(find(statementFor({ claims: [claim('total', { assurance: 'property' })] }), 'ASSURANCE_UNMET')).toMatchObject({ outcome: 'fail' });
    const strength = (property: boolean): ClaimInput['strength'] => ({ ...claim('total').strength!, property });
    expect(codes(statementFor({ claims: [claim('total', { assurance: 'property', strength: strength(true) })] }))).not.toContain('ASSURANCE_UNMET');
    expect(find(statementFor({ claims: [claim('total', { assurance: 'property', strength: undefined })] }), 'ASSURANCE_UNMET')).toMatchObject({ outcome: 'unknown' });
    const bounded = statementFor({ claims: [claim('total', { assurance: 'bounded' })] });
    expect(find(bounded, 'ASSURANCE_TOOLING_MISSING')).toMatchObject({ outcome: 'unknown', gate: 'requireConforms' });
    const proven = statementFor({ claims: [claim('total', { assurance: 'bounded', proof: { verdict: 'proven', layers: { unit: 'proven', unclassified: 'proven' }, missing: [], complete: true }, layerEvidence: { unit: 'test', unclassified: 'bounded' } })] });
    expect(codes(proven)).not.toContain('ASSURANCE_TOOLING_MISSING');
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('a manual-evidence claim conforms with a MANUAL_EVIDENCE note naming the verifier', () => {
    const manual = claim('copy', { evidence: 'manual', verifier: 'Content lead', required: [], strength: undefined, proof: { verdict: 'proven', layers: { unclassified: 'proven' }, missing: [], complete: true }, layerEvidence: { unclassified: 'manual' } });
    const s = statementFor({ claims: [manual] });
    expect(find(s, 'MANUAL_EVIDENCE')).toMatchObject({ outcome: 'note', message: expect.stringContaining('Content lead') });
    expect(s.pillars.conforms.status).toBe('ok');
    expect(codes(s)).not.toContain('STRENGTH_UNKNOWN');
    // test evidence alone does not satisfy a manual claim
    const byTest = statementFor({ claims: [{ ...manual, layerEvidence: { unclassified: 'test' } }] });
    expect(find(byTest, 'CLAIM_UNPROVEN')).toMatchObject({ outcome: 'unknown' });
    expect(find(byTest, 'MANUAL_EVIDENCE')).toBeUndefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-four-pillars]
  it('error-level weakening touching the capability -> WEAKENING fail; warn -> note', () => {
    const w = (severity: 'error' | 'warn', over: Record<string, unknown> = {}) => ({ kind: 'skip-added', severity, file: 'tests/cart.test.ts', claims: ['cart#total'], message: 'a skip was added', ...over });
    const err = statementFor({ weakening: [w('error')] }, policyWith({ requireStrength: true }));
    expect(find(err, 'WEAKENING')).toMatchObject({ outcome: 'fail', claim: 'cart#total', blocking: true });
    expect(err.pillars.conforms.status).toBe('fail');
    expect(statementFor({ weakening: [w('error')] }).blocking).toEqual([]);
    const warn = statementFor({ weakening: [w('warn')] });
    expect(find(warn, 'WEAKENING')).toMatchObject({ outcome: 'note' });
    expect(warn.pillars.conforms.status).toBe('ok');
    // matched by tagged test file when no claim is named, ignored when neither matches
    expect(find(statementFor({ weakening: [w('error', { claims: [] })] }), 'WEAKENING')).toMatchObject({ file: 'tests/cart.test.ts' });
    expect(find(statementFor({ weakening: [w('error', { claims: ['other#x'], file: 'tests/other.test.ts' })] }), 'WEAKENING')).toBeUndefined();
  });
});

describe('proof statement: blocking, exit code and degradation [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-blocking-precedence]
  it('orders blocking reasons approved > testable > aligned > conforms, fail before unknown, then spec order', () => {
    const claims = [
      claim('first', { proof: { verdict: 'stale', layers: { unit: 'stale' }, missing: [], complete: false } }),
      claim('second', { approval: undefined, proof: { verdict: 'failed', layers: { unit: 'failed' }, missing: [], complete: false } }),
      claim('third', { approval: undefined, testability: { ref: 'cart#third', testable: false, findings: [{ rule: 'T-VAGUE', severity: 'error', matches: ['properly'], message: 'vague' }] } }),
    ];
    const s = statementFor({ claims, coverage: undefined, weakening: [] }, strictPolicy());
    const order = s.blocking.map((r) => `${r.pillar}:${r.outcome}:${r.code}:${r.claim ?? '-'}`);
    expect(order.slice(0, 3)).toEqual(['approved:fail:APPROVAL_MISSING:cart#second', 'approved:fail:APPROVAL_MISSING:cart#third', 'testable:fail:LINT_ERROR:cart#third']);
    expect(order.indexOf('aligned:unknown:NO_COVERAGE_EVIDENCE:-')).toBeGreaterThan(2);
    const conforms = order.filter((o) => o.startsWith('conforms'));
    expect(conforms.slice(0, 2)).toEqual(['conforms:fail:CLAIM_FAILED:cart#second', 'conforms:unknown:CLAIM_STALE:cart#first']);
    // pillar order across the whole list
    const pillars = s.blocking.map((r) => ['approved', 'testable', 'aligned', 'conforms'].indexOf(r.pillar));
    expect(pillars).toEqual([...pillars].sort((a, b) => a - b));
    expect(s.headline).toMatch(/^cart: NOT CERTIFIED - \d+ blocking: approval missing \(second\); approval missing \(third\)$/);
  });

  // [claims: capabilities/traceability-and-drift#statement-policy-only-blocks, capabilities/traceability-and-drift#statement-degradation]
  it('default policy: nothing blocks and exitCode is 0 whatever the statuses', () => {
    const bad = cap({
      approvalsInUse: false,
      coverage: undefined,
      ownedFiles: [],
      claims: [claim('total', { approval: undefined, proof: { verdict: 'failed', layers: { unit: 'failed' }, missing: ['e2e'], complete: false }, strength: undefined })],
    });
    const s = computeStatement({ generated: 'g', head: { sha: SHA, dirty: [] }, policy: noPolicy(), unowned: ['src/x.ts'], capabilities: [bad] });
    expect(s.capabilities[0]!.level).toBe('not-certified');
    expect(s.capabilities[0]!.pillars.approved.status).toBe('fail');
    expect(s.capabilities[0]!.pillars.conforms.status).toBe('fail');
    expect(s.capabilities[0]!.blocking).toEqual([]);
    expect(s.exitCode).toBe(0);
    expect(s.level).toBe('not-certified');
  });

  // [claims: capabilities/traceability-and-drift#statement-policy-only-blocks]
  it('statuses do not depend on policy: the same input has the same pillars under every policy', () => {
    const input = cap({ claims: [claim('total', { approval: undefined, proof: { verdict: 'stale', layers: { unit: 'stale' }, missing: [], complete: false } })], coverage: undefined });
    const head = { sha: SHA, dirty: [] };
    const statuses = (p: ProofPolicy) => Object.values(composeCapabilityStatement(input, { head, policy: p }).pillars).map((v) => v.status);
    expect(statuses(strictPolicy())).toEqual(statuses(noPolicy()));
    expect(statuses(policyWith({ requireConforms: true }))).toEqual(statuses(noPolicy()));
  });

  // [claims: capabilities/traceability-and-drift#statement-exit-code-not-certified]
  it('strict policy turns every gate on; any blocking reason -> exit code 13', () => {
    const head = { sha: SHA, dirty: [] };
    const bad = cap({ claims: [claim('total', { approval: undefined })] });
    const s = composeSystemStatement({ generated: 'g', head, policy: strictPolicy(), unowned: [], capabilities: [bad] });
    expect(s.exitCode).toBe(ExitCode.NotCertified);
    expect(s.exitCode).toBe(13);
    // a single gate is enough
    expect(composeSystemStatement({ generated: 'g', head, policy: policyWith({ requireApproval: true }), unowned: [], capabilities: [bad] }).exitCode).toBe(13);
    // a gate that is on but whose pillar is satisfied does not block
    expect(composeSystemStatement({ generated: 'g', head, policy: policyWith({ requireConforms: true }), unowned: [], capabilities: [bad] }).exitCode).toBe(0);
    // a fully certified repo exits 0 even under strict
    expect(composeSystemStatement({ generated: 'g', head, policy: strictPolicy(), unowned: [], capabilities: [cap()] }).exitCode).toBe(0);
    // unowned files are exit 4 elsewhere, never 13
    expect(composeSystemStatement({ generated: 'g', head, policy: strictPolicy(), unowned: ['a.ts'], capabilities: [cap()] }).exitCode).toBe(0);
  });

  // [claims: capabilities/traceability-and-drift#statement-degradation]
  it('a repo using none of the new features is not certified, with exact reasons, and nothing blocks', () => {
    const legacy = cap({
      approvalsInUse: false,
      coverage: undefined,
      claims: [claim('total', { approval: undefined, strength: undefined, proof: { verdict: 'proven', layers: { unclassified: 'proven' }, missing: [], complete: true }, required: [], layerEvidence: {} })],
    });
    const s = statementFor(legacy as Partial<CapabilityInput>);
    expect(s.pillars.approved.reasons.map((r) => r.code)).toEqual(['APPROVALS_NOT_IN_USE']);
    expect(s.pillars.aligned.reasons.map((r) => r.code)).toEqual(['NO_COVERAGE_EVIDENCE']);
    expect(s.pillars.conforms.status).toBe('unknown');
    expect(s.pillars.testable.status).toBe('ok');
    expect(s.level).toBe('not-certified');
    expect(s.blocking).toEqual([]);
    expect(composeSystemStatement({ generated: 'g', head: { sha: SHA, dirty: [] }, policy: noPolicy(), unowned: [], capabilities: [legacy] }).exitCode).toBe(0);
  });
});

describe('proof statement: output [traceability-and-drift]', () => {
  const fixture = (): StatementInput => ({
    generated: '2026-10-25T12:00:00.000Z',
    head: { sha: SHA, dirty: [], base: 'origin/main' },
    policy: policyWith({ requireApproval: true, requireConforms: true }),
    unowned: [],
    capabilities: [
      cap({
        claims: [
          claim('total', { approval: undefined, proof: { verdict: 'failed', layers: { unit: 'failed' }, missing: [], complete: false } }),
          claim('tax', { testability: { ref: 'cart#tax', testable: true, findings: [{ rule: 'T-COMPOUND', severity: 'warn', matches: [], message: '5 clauses (max 3)' }] } }),
        ],
        coverage: undefined,
      }),
      cap({ id: 'pay', specKey: 'pay', title: 'Pay', claims: [claim('charge')] }),
    ],
  });

  // [claims: capabilities/traceability-and-drift#statement-json-and-explain]
  it('the JSON shape of the statement is stable', () => {
    const s = composeSystemStatement(fixture());
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(Object.keys(s)).toEqual(['version', 'generated', 'head', 'base', 'policy', 'level', 'capabilities', 'system', 'counts', 'exitCode']);
    expect(s.version).toBe(1);
    expect(s.head).toBe(SHA);
    expect(s.base).toBe('origin/main');
    expect(s.counts).toEqual({ certified: 1, provisional: 0, 'not-certified': 1, planned: 0 });
    const c = s.capabilities[0]!;
    expect(Object.keys(c)).toEqual(['capability', 'title', 'status', 'level', 'pillars', 'blocking', 'claims', 'metrics', 'evidence', 'headline']);
    expect(Object.keys(c.pillars)).toEqual(['approved', 'testable', 'aligned', 'conforms']);
    expect(Object.keys(c.pillars.approved)).toEqual(['status', 'reasons', 'summary']);
    expect(c.blocking[0]).toEqual({
      code: 'APPROVAL_MISSING',
      pillar: 'approved',
      outcome: 'fail',
      gate: 'requireApproval',
      blocking: true,
      claim: 'cart#total',
      message: `current wording (${HASH.slice(0, 16)}) has no approval`,
      fix: 'specguard spec approve cart#total',
    });
    expect(Object.keys(c.blocking[0]!)).toEqual(['code', 'pillar', 'outcome', 'gate', 'blocking', 'claim', 'message', 'fix']);
    expect(c.claims[0]).toMatchObject({ ref: 'cart#total', pillars: { approved: 'fail', testable: 'ok', aligned: 'unknown', conforms: 'fail' } });
    expect(c.headline).toBe('cart: NOT CERTIFIED - 2 blocking: approval missing (total); claim failed (total)');
    expect(s.exitCode).toBe(13);
    // the whole statement carries no undefined values
    expect(JSON.stringify(s)).not.toContain('undefined');
  });

  // [claims: capabilities/traceability-and-drift#statement-json-and-explain]
  it('renders the STATEMENT lines for check', () => {
    const s = composeSystemStatement(fixture());
    expect(statementLine(s.capabilities[0]!)).toBe('STATEMENT: cart NOT-CERTIFIED approved=FAIL testable=ok aligned=?? conforms=FAIL');
    expect(headlineLines(s)).toEqual([
      'STATEMENT: cart NOT-CERTIFIED approved=FAIL testable=ok aligned=?? conforms=FAIL',
      'STATEMENT: pay CERTIFIED approved=ok testable=ok aligned=ok conforms=ok',
      'STATEMENT: system NOT-CERTIFIED certified=1 provisional=0 not-certified=1 planned=0',
    ]);
  });

  // [claims: capabilities/traceability-and-drift#statement-json-and-explain]
  it('the headline of a capability with nothing blocking names the four pillars', () => {
    const s = statementFor();
    expect(s.headline).toBe('cart: CERTIFIED - approved ok testable ok aligned ok conforms ok');
    const none = statementFor({ coverage: undefined });
    expect(none.headline).toBe('cart: NOT CERTIFIED - approved ok testable ok aligned ?? conforms ok');
  });

  // [claims: capabilities/traceability-and-drift#statement-json-and-explain]
  it('explain lines include the pillars, codes, fixes, advisory reasons and limits', () => {
    const input = fixture();
    input.capabilities[0]!.claims[0]!.mutation = { ref: 'cart#total', considered: 4, killed: 1, survived: 1, score: 50, stale: false, limits: ['mutation attribution first-kill (survivor counts per claim are lower bounds)'] };
    const s = composeSystemStatement(input);
    const lines = explainCapability(s.capabilities[0]!, { head: SHA, policy: s.policy });
    expect(lines[0]).toBe('cart (Cart): NOT CERTIFIED at a1b2c3d (policy: approval, conforms)');
    expect(lines.find((l) => l.startsWith('  approved'))).toMatch(/^ {2}approved +FAIL +1\/2 claims approved +blocking$/);
    expect(lines.find((l) => l.startsWith('  aligned'))).toMatch(/aligned\s+\?\?\s+no coverage evidence\s+advisory$/);
    expect(lines.find((l) => l.startsWith('  testable'))).toMatch(/testable\s+ok\s+0 errors, 1 warnings$/);
    expect(lines).toContain('Blocking:');
    expect(lines).toContain(`  1. APPROVAL_MISSING cart#total: current wording (${HASH.slice(0, 16)}) has no approval`);
    expect(lines).toContain('     fix: specguard spec approve cart#total');
    expect(lines.some((l) => l.startsWith('  2. CLAIM_FAILED cart#total'))).toBe(true);
    expect(lines).toContain('Advisory:');
    expect(lines).toContain('  - NO_COVERAGE_EVIDENCE: no coverage ingested for this capability; fix: specguard test run --coverage --per-capability');
    expect(lines.some((l) => l.startsWith('  - LINT_WARNING cart#tax: T-COMPOUND'))).toBe(true);
    expect(lines.at(-1)).toBe('Limits: mutation attribution first-kill (survivor counts per claim are lower bounds)');
    // a certified capability explains itself without a blocking section
    const ok = explainCapability(statementFor());
    expect(ok).not.toContain('Blocking:');
    expect(ok[0]).toBe(`cart (Cart): CERTIFIED at ${SHA.slice(0, 7)}`);
  });

  // [claims: capabilities/traceability-and-drift#statement-json-and-explain]
  it('explain groups repeated advisory reasons of one code', () => {
    const claims = ['a', 'b', 'c', 'd', 'e'].map((id) => claim(id, { required: [] }));
    const lines = explainCapability(statementFor({ claims }));
    expect(lines.filter((l) => l.startsWith('  - NO_LAYERS_DECLARED'))).toHaveLength(4);
    expect(lines).toContain('  - NO_LAYERS_DECLARED: 2 more');
  });

  // [claims: capabilities/traceability-and-drift#statement-is-pure]
  it('same input -> deep-equal output, and the input is not mutated', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const a = composeSystemStatement(input);
    const b = composeSystemStatement(fixture());
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(before);
    expect(computeStatement(input)).toEqual(a);
    expect(computeStatement(input, strictPolicy()).policy.requireCi).toBe(true);
  });

  // [claims: capabilities/traceability-and-drift#statement-is-pure]
  it('the module imports no node:fs and no node:child_process (purity guard)', () => {
    const source = readFileSync(new URL('../../src/core/proof-statement.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
    expect(imports.filter((i) => i.startsWith('node:') || ['fs', 'child_process', 'path', 'os'].includes(i))).toEqual([]);
    expect(source).not.toMatch(/\b(fetch|execSync|spawn|readFileSync|process\.env)\b/);
  });
});
