/**
 * The proof statement: for each capability, whether the intent was approved, the claims are testable, the code
 * is what the claims specify, and the tests prove it. Each of those four pillars is `ok`, `fail` or `unknown`.
 *
 * Pure composition: it reads no file, runs no process and calls no model. `check` gathers the evidence and
 * hands it in as plain data. Pillar status never depends on policy: a certificate whose meaning changed with
 * per-repo config would not be a certificate. Policy (the `proof.require*` gates) decides only which reasons
 * block, and so only the exit code. The statement uses the raw ledger verdict (no model opinion keeps a proof
 * fresh) and keeps approval in its own pillar.
 *
 * Evidence from the testability, test-strength, coverage, mutation and weakening modules enters as small
 * structural types defined here, so each of those modules' results is assignable without this module
 * importing them.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { ExitCode } from './exit-codes.js';
import type { ClaimProof, EffectiveVerdict } from './proof-ledger.js';
import type { TestLayer } from './test-layers.js';
import type { Assurance } from './types.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type PillarName = 'approved' | 'testable' | 'aligned' | 'conforms';
export type PillarStatus = 'ok' | 'fail' | 'unknown';
export type CertLevel = 'certified' | 'provisional' | 'not-certified' | 'planned';
export type Origin = 'local' | 'ci' | 'server';

/** Pillars in the owner's order: spec, then tests, then code, then validated. */
export const PILLARS: readonly PillarName[] = ['approved', 'testable', 'aligned', 'conforms'];

export interface ProofPolicy {
  /** Unapproved claims block. Existing key `proof.requireApproval`. */
  requireApproval: boolean;
  requireTestable: boolean;
  requireStrength: boolean;
  requireSensitivity: boolean;
  /** Failed, stale or unproven claims, and missing layers, block. */
  requireConforms: boolean;
  /** Coverage-based Aligned reasons block. */
  requireAlignment: boolean;
  /** Local and server evidence does not count for Conforms. */
  requireCi: boolean;
  enforceLayers: 'off' | 'warn' | 'fail';
  /** Minimum percentage (0 to 100) of changed executable lines tests must reach. */
  minDiffCoverage: number;
  /** `minScore` is a percentage (0 to 100). */
  mutation: { minScore: number; minKilled: number; timeoutAsKilled: boolean };
}

export const DEFAULT_MIN_DIFF_COVERAGE = 80;
export const DEFAULT_MUTATION = { minScore: 70, minKilled: 1, timeoutAsKilled: true } as const;

const GATE_FLAGS = ['requireApproval', 'requireTestable', 'requireStrength', 'requireSensitivity', 'requireConforms', 'requireAlignment', 'requireCi'] as const;

/**
 * The effective policy from config. `strict` (from `opts` or `proof.strict`) turns every `require*` gate on and
 * `enforceLayers` to `fail`; every flag is otherwise off, `enforceLayers` is `warn` and `minDiffCoverage` is 80.
 */
export function resolveProofPolicy(
  cfg?: { proof?: Partial<Omit<ProofPolicy, 'mutation'>> & { strict?: boolean }; mutation?: Partial<ProofPolicy['mutation']> },
  opts?: { strict?: boolean },
): ProofPolicy {
  const proof = cfg?.proof ?? {};
  const strict = opts?.strict ?? proof.strict ?? false;
  const flags = Object.fromEntries(GATE_FLAGS.map((k) => [k, strict ? true : proof[k] === true])) as Record<(typeof GATE_FLAGS)[number], boolean>;
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    ...flags,
    enforceLayers: strict ? 'fail' : (proof.enforceLayers ?? 'warn'),
    minDiffCoverage: num(proof.minDiffCoverage, DEFAULT_MIN_DIFF_COVERAGE),
    mutation: {
      minScore: num(cfg?.mutation?.minScore, DEFAULT_MUTATION.minScore),
      minKilled: num(cfg?.mutation?.minKilled, DEFAULT_MUTATION.minKilled),
      timeoutAsKilled: cfg?.mutation?.timeoutAsKilled ?? DEFAULT_MUTATION.timeoutAsKilled,
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ApprovalInfo {
  method: 'command' | 'as-built' | 'pr' | 'plan';
  by: string;
  date: string;
  entry: string;
}

/** A testability finding (the testability lint's `TestabilityFinding`). */
export interface TestabilityFindingInput {
  rule: string;
  severity: 'error' | 'warn';
  /** `specKey#claimId`; absent for capability-level findings. */
  claim?: string;
  example?: string;
  matches: string[];
  message: string;
  /** An error downgraded to a warning for this claim by a waiver. */
  waived?: boolean;
}
export interface ClaimTestabilityInput {
  ref: string;
  testable: boolean;
  findings: TestabilityFindingInput[];
}
export interface CapabilityTestabilityInput {
  capability: string;
  /** Includes bullets without an anchor (refs `specKey#?n`). */
  claims: ClaimTestabilityInput[];
  capabilityFindings: TestabilityFindingInput[];
  testable: boolean;
}

/** Tests tagged to a claim at one layer, by strength class (the strength module's `LayerStrength`). */
export interface LayerStrengthInput {
  strong: readonly unknown[];
  weak: readonly unknown[];
  skipped: readonly unknown[];
  conditional: readonly unknown[];
  unknown: readonly unknown[];
}
export type ClaimStrengthReasonCode = 'NO_TAGGED_TESTS' | 'ALL_SKIPPED' | 'CONDITIONAL_ONLY' | 'WEAK_ONLY' | 'LAYER_NOT_MEANINGFUL' | 'STRENGTH_UNKNOWN';
/** The strength module's `ClaimStrength`. */
export interface ClaimStrengthInput {
  ref: string;
  meaningful: boolean | 'unknown';
  perLayer: Partial<Record<string, LayerStrengthInput>>;
  reasons: Array<{ code: ClaimStrengthReasonCode; layer?: string }>;
  /** At least one strong property test. */
  property: boolean;
}

/** The mutation module's `ClaimMutationScore`. `score` is a percentage (0 to 100), or null without per-test coverage. */
export interface ClaimMutationInput {
  ref: string;
  /** Valid in-scope mutants the claim's tests could have killed. */
  considered: number;
  killed: number;
  survived: number;
  score: number | null;
  stale: boolean;
  limits: string[];
}
/** The mutation module's `CapabilityMutationScore`; `origin` and `tool` are added by the caller when known. */
export interface CapabilityMutationInput {
  /** Percentage (0 to 100), or null. */
  score: number | null;
  origin?: Origin;
  tool?: string;
}

/** The coverage module's `CapabilityCoverage`. Percentages are 0 to 100. */
export interface CoverageInput {
  source: 'capability' | 'suite';
  selection?: 'tests' | 'files';
  evidence: { runId: string; origin: Origin; repoSha?: string };
  /** Owned files present and fresh in the report. */
  reported: number;
  stale: string[];
  lines: { executable: number; hit: number; pct: number | null };
  diff?: {
    changedExecutable: number;
    hit: number;
    pct: number | null;
    missed: Array<{ file: string; lines: unknown }>;
    unknownFiles: string[];
  };
  unreached: { lines: number };
  testsStale: boolean;
}

/** The weakening module's `WeakeningFinding`. */
export interface WeakeningInput {
  kind: string;
  severity: 'error' | 'warn';
  file: string;
  line?: number;
  test?: string;
  claims: string[];
  message: string;
}

export type LayerEvidenceKind = 'test' | 'agentic' | 'manual' | 'property' | 'bounded' | 'proof-model' | 'proof-code';

export interface ExampleInput {
  /** `cap#claim/row`. */
  ref: string;
  id: string;
  hash: string;
  /** Undefined means unapproved. */
  approval?: ApprovalInfo;
  proof: EffectiveVerdict;
  proofOrigins: Origin[];
  strength?: 'meaningful' | 'not-meaningful' | 'unknown';
}

export interface ClaimInput {
  /** `specKey#claimId`. */
  ref: string;
  id: string;
  text: string;
  /** The claim hash (`claimHashOf`). */
  claimHash: string;
  approval?: ApprovalInfo;
  /** Hash of the newest approval at any wording, to tell a stale approval from a missing one. */
  lastApprovedHash?: string;
  /** Against the base; undefined outside change mode. */
  change?: 'added' | 'modified' | 'unchanged';
  required: TestLayer[];
  assurance: Assurance;
  evidence: 'test' | 'agentic' | 'manual';
  verifier?: string;
  /** `effectiveClaimProof` WITHOUT a drift-assessment `fileChange`: deterministic, no model opinion. */
  proof: ClaimProof;
  /** Evidence kind recorded per layer row; absent means a test. */
  layerEvidence: Partial<Record<string, LayerEvidenceKind>>;
  /** Origins of the non-stale layer rows used. */
  proofOrigins: Origin[];
  proofShas: string[];
  testability: ClaimTestabilityInput;
  /** Undefined means not computed. */
  strength?: ClaimStrengthInput;
  /** Undefined means no mutation evidence. */
  mutation?: ClaimMutationInput;
  redGreen?: 'ok' | 'fail';
  examples: ExampleInput[];
}

export interface CapabilityInput {
  id: string;
  specKey: string;
  title: string;
  status: string;
  /** Spec file, tagged test files and owned files: the files whose uncommitted change makes a certificate provisional. */
  inputs: string[];
  ownedFiles: string[];
  claims: ClaimInput[];
  testability: CapabilityTestabilityInput;
  /** Undefined means none ingested. */
  coverage?: CoverageInput;
  mutation?: CapabilityMutationInput;
  /** Change mode only. */
  weakening: WeakeningInput[];
  /** True when the repo has at least one approval entry. */
  approvalsInUse: boolean;
  intentGap?: { codeDate: string; intentDate: string };
  /** A diff was supplied. */
  changeMode: boolean;
}

export interface StatementInput {
  /** Injected for determinism. */
  generated: string;
  head: { sha?: string; dirty: string[]; base?: string };
  policy: ProofPolicy;
  unowned: string[];
  capabilities: CapabilityInput[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type ReasonCode =
  // approved
  | 'APPROVAL_MISSING' | 'APPROVAL_STALE' | 'EXAMPLE_APPROVAL_MISSING' | 'APPROVALS_NOT_IN_USE' | 'APPROVED_AS_BUILT'
  // testable
  | 'NO_CLAIMS' | 'LINT_ERROR' | 'LINT_WARNING' | 'LINT_WAIVED' | 'NO_LAYERS_DECLARED'
  // aligned
  | 'NO_OWNED_FILES' | 'NO_COVERAGE_EVIDENCE' | 'COVERAGE_STALE' | 'SUITE_ONLY_COVERAGE'
  | 'CLAIM_TESTS_REACH_NO_OWNED_CODE' | 'DIFF_COVERAGE_LOW' | 'UNSPECIFIED_CHANGE' | 'UNREACHED_OWNED_CODE' | 'INTENT_GAP'
  | 'UNOWNED_FILES'
  // conforms
  | 'CLAIM_FAILED' | 'CLAIM_ERROR' | 'CLAIM_STALE' | 'CLAIM_UNPROVEN' | 'CLAIM_UNEXERCISED' | 'NO_TAGGED_TESTS'
  | 'LAYER_MISSING' | 'LAYER_UNTESTED' | 'AGENTIC_NOT_ACCEPTED'
  | 'EXAMPLE_FAILED' | 'EXAMPLE_STALE' | 'EXAMPLE_UNPROVEN' | 'EXAMPLE_NOT_MEANINGFUL'
  | 'TESTS_SKIPPED_ONLY' | 'CONDITIONAL_ONLY' | 'WEAK_ONLY' | 'LAYER_NOT_MEANINGFUL' | 'STRENGTH_UNKNOWN'
  | 'SENSITIVITY_MISSING' | 'MUTATION_NOT_KILLED' | 'MUTATION_SCORE_LOW' | 'MUTATION_STALE'
  | 'ASSURANCE_UNMET' | 'ASSURANCE_TOOLING_MISSING' | 'MANUAL_EVIDENCE' | 'WEAKENING'
  | 'LOCAL_EVIDENCE' | 'CI_EVIDENCE_REQUIRED' | 'DIRTY_TREE'
  // capability status
  | 'PLANNED';

/** The policy flag that makes a reason block. `layers` is `requireConforms` or `enforceLayers: fail`; `never` never blocks. */
export type Gate =
  | 'requireApproval' | 'requireTestable' | 'requireAlignment' | 'requireConforms'
  | 'requireStrength' | 'requireSensitivity' | 'requireCi' | 'layers' | 'never';

export interface Reason {
  code: ReasonCode;
  pillar: PillarName;
  /** A `note` never changes a status. */
  outcome: 'fail' | 'unknown' | 'note';
  gate: Gate;
  blocking: boolean;
  claim?: string;
  example?: string;
  file?: string;
  message: string;
  /** A command that resolves it. */
  fix?: string;
  data?: Record<string, string | number | boolean | string[]>;
}
export interface PillarVerdict {
  status: PillarStatus;
  reasons: Reason[];
  summary: string;
}
export interface ClaimStatement {
  ref: string;
  pillars: Record<PillarName, PillarStatus>;
  reasons: Reason[];
}
export interface CapabilityStatement {
  capability: string;
  title: string;
  status: string;
  level: CertLevel;
  /** Set only when `level` is `certified`. */
  certifiedAt?: string;
  pillars: Record<PillarName, PillarVerdict>;
  /** Blocking reasons, in precedence order. */
  blocking: Reason[];
  claims: ClaimStatement[];
  metrics: {
    claims: number;
    approved: number;
    testable: number;
    proven: number;
    meaningful: number | null;
    lineCoverage: number | null;
    diffCoverage: number | null;
    mutationScore: number | null;
  };
  evidence: { origins: Origin[]; shas: string[]; coverageRunId?: string; mutationTool?: string };
  /** One-line headline. */
  headline: string;
  /** Honest limits of the evidence used (for example mutation attribution); present only when there are any. */
  limits?: string[];
}
export interface SystemStatement {
  version: 1;
  generated: string;
  head?: string;
  base?: string;
  policy: ProofPolicy;
  level: CertLevel;
  certifiedAt?: string;
  capabilities: CapabilityStatement[];
  system: { reasons: Reason[] };
  counts: Record<CertLevel, number>;
  /** 0, or `ExitCode.NotCertified` when any reason blocks. */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Reason construction
// ---------------------------------------------------------------------------

/** Whether the policy turns a gate on. */
export function gateOn(policy: ProofPolicy, gate: Gate): boolean {
  switch (gate) {
    case 'never':
      return false;
    case 'layers':
      return policy.requireConforms || policy.enforceLayers === 'fail';
    default:
      return policy[gate];
  }
}

type Extra = Partial<Pick<Reason, 'claim' | 'example' | 'file' | 'fix' | 'data'>>;
type MakeReason = (code: ReasonCode, pillar: PillarName, outcome: Reason['outcome'], gate: Gate, message: string, extra?: Extra) => Reason;

/** Builds reasons with `blocking` set from the policy. Keys are added in a fixed order so the JSON is stable. */
function reasonMaker(policy: ProofPolicy): MakeReason {
  return (code, pillar, outcome, gate, message, extra = {}) => {
    const r: Reason = { code, pillar, outcome, gate, blocking: outcome !== 'note' && gateOn(policy, gate), message };
    const out: Reason = { code: r.code, pillar: r.pillar, outcome: r.outcome, gate: r.gate, blocking: r.blocking } as Reason;
    if (extra.claim !== undefined) out.claim = extra.claim;
    if (extra.example !== undefined) out.example = extra.example;
    if (extra.file !== undefined) out.file = extra.file;
    out.message = message;
    if (extra.fix !== undefined) out.fix = extra.fix;
    if (extra.data !== undefined) out.data = extra.data;
    return out;
  };
}

/** Short label of each code, used in headlines. */
export const REASON_LABELS: Record<ReasonCode, string> = {
  APPROVAL_MISSING: 'approval missing',
  APPROVAL_STALE: 'approval out of date',
  EXAMPLE_APPROVAL_MISSING: 'example approval missing',
  APPROVALS_NOT_IN_USE: 'no approvals recorded',
  APPROVED_AS_BUILT: 'approved as built',
  NO_CLAIMS: 'no anchored claims',
  LINT_ERROR: 'claim not testable',
  LINT_WARNING: 'testability warning',
  LINT_WAIVED: 'testability finding waived',
  NO_LAYERS_DECLARED: 'no layers declared',
  NO_OWNED_FILES: 'no owned files',
  NO_COVERAGE_EVIDENCE: 'no coverage evidence',
  COVERAGE_STALE: 'coverage out of date',
  SUITE_ONLY_COVERAGE: 'suite-only coverage',
  CLAIM_TESTS_REACH_NO_OWNED_CODE: 'claim tests reach no owned code',
  DIFF_COVERAGE_LOW: 'diff coverage low',
  UNSPECIFIED_CHANGE: 'changed code no claim test reaches',
  UNREACHED_OWNED_CODE: 'owned code never reached',
  INTENT_GAP: 'code newer than intent',
  UNOWNED_FILES: 'files without a spec',
  CLAIM_FAILED: 'claim failed',
  CLAIM_ERROR: 'claim errored',
  CLAIM_STALE: 'proof out of date',
  CLAIM_UNPROVEN: 'claim unproven',
  CLAIM_UNEXERCISED: 'claim unexercised',
  NO_TAGGED_TESTS: 'no tagged tests',
  LAYER_MISSING: 'layer unproven',
  LAYER_UNTESTED: 'layer has no tests',
  AGENTIC_NOT_ACCEPTED: 'agentic evidence not accepted at this layer',
  EXAMPLE_FAILED: 'example failed',
  EXAMPLE_STALE: 'example proof out of date',
  EXAMPLE_UNPROVEN: 'example unproven',
  EXAMPLE_NOT_MEANINGFUL: 'example test not meaningful',
  TESTS_SKIPPED_ONLY: 'tests skipped',
  CONDITIONAL_ONLY: 'tests conditional',
  WEAK_ONLY: 'tests weak',
  LAYER_NOT_MEANINGFUL: 'layer tests not meaningful',
  STRENGTH_UNKNOWN: 'test strength unknown',
  SENSITIVITY_MISSING: 'sensitivity unproven',
  MUTATION_NOT_KILLED: 'no mutant killed',
  MUTATION_SCORE_LOW: 'mutation score low',
  MUTATION_STALE: 'mutation evidence out of date',
  ASSURANCE_UNMET: 'assurance unmet',
  ASSURANCE_TOOLING_MISSING: 'assurance tooling missing',
  MANUAL_EVIDENCE: 'manual evidence',
  WEAKENING: 'weakened',
  LOCAL_EVIDENCE: 'local evidence',
  CI_EVIDENCE_REQUIRED: 'CI evidence required',
  DIRTY_TREE: 'uncommitted changes',
  PLANNED: 'planned',
};

const short = (hash: string): string => hash.slice(0, 16);
const claimIdOf = (ref: string): string => ref.slice(ref.indexOf('#') + 1);
const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const sum = (l: LayerStrengthInput | undefined): number => (l ? l.strong.length + l.weak.length + l.skipped.length + l.conditional.length + l.unknown.length : 0);

// ---------------------------------------------------------------------------
// Approved
// ---------------------------------------------------------------------------

function approvedReasons(cap: CapabilityInput, mk: MakeReason): Reason[] {
  const out: Reason[] = [];
  if (!cap.approvalsInUse) {
    out.push(mk('APPROVALS_NOT_IN_USE', 'approved', 'fail', 'requireApproval', 'no requirement in this repository has been approved by a person', {
      fix: `specguard spec approve ${cap.id}  (or: specguard baseline --as-built)`,
    }));
    return out;
  }
  for (const c of cap.claims) {
    if (!c.approval) {
      const stale = c.lastApprovedHash !== undefined;
      out.push(mk(stale ? 'APPROVAL_STALE' : 'APPROVAL_MISSING', 'approved', 'fail', 'requireApproval',
        stale ? `wording changed since approval (approved ${short(c.lastApprovedHash!)}, now ${short(c.claimHash)})` : `current wording (${short(c.claimHash)}) has no approval`,
        { claim: c.ref, fix: `specguard spec approve ${c.ref}` }));
    } else if (c.approval.method === 'as-built') {
      out.push(mk('APPROVED_AS_BUILT', 'approved', 'note', 'requireApproval', `approved as built by ${c.approval.by} on ${c.approval.date}: accepts what the code does, not independent intent`, { claim: c.ref }));
    }
    for (const ex of c.examples) {
      if (!ex.approval) {
        out.push(mk('EXAMPLE_APPROVAL_MISSING', 'approved', 'fail', 'requireApproval', `example row "${ex.id}" (${short(ex.hash)}) has no approval`, {
          claim: c.ref, example: ex.id, fix: `specguard spec approve ${ex.ref}`,
        }));
      } else if (ex.approval.method === 'as-built') {
        out.push(mk('APPROVED_AS_BUILT', 'approved', 'note', 'requireApproval', `example row "${ex.id}" approved as built by ${ex.approval.by}`, { claim: c.ref, example: ex.id }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Testable
// ---------------------------------------------------------------------------

function lintReason(f: TestabilityFindingInput, claim: string | undefined, mk: MakeReason): Reason {
  const message = f.message.startsWith(f.rule) ? f.message : `${f.rule}: ${f.message}`;
  const extra: Extra = { ...(claim !== undefined ? { claim } : {}), ...(f.example !== undefined ? { example: f.example } : {}), data: { rule: f.rule, matches: f.matches } };
  if (f.rule === 'T-NO-ANCHOR') extra.fix = 'specguard spec tag';
  if (f.waived) return mk('LINT_WAIVED', 'testable', 'note', 'requireTestable', message, extra);
  if (f.severity === 'error') return mk('LINT_ERROR', 'testable', 'fail', 'requireTestable', message, extra);
  return mk('LINT_WARNING', 'testable', 'note', 'requireTestable', message, extra);
}

function testableReasons(cap: CapabilityInput, mk: MakeReason): Reason[] {
  const out: Reason[] = [];
  if (cap.claims.length === 0) out.push(mk('NO_CLAIMS', 'testable', 'fail', 'requireTestable', 'the capability has no anchored claims, so nothing can be tested or approved', { fix: 'specguard spec tag' }));
  for (const f of cap.testability.capabilityFindings) out.push(lintReason(f, undefined, mk));
  const known = new Set(cap.claims.map((c) => c.ref));
  for (const c of cap.claims) {
    for (const f of c.testability.findings) out.push(lintReason(f, c.ref, mk));
    if (c.required.length === 0) out.push(mk('NO_LAYERS_DECLARED', 'testable', 'note', 'requireTestable', 'no test layer is required for this claim and the project declares no default', { claim: c.ref }));
  }
  // Bullets without an anchor are only known to the lint.
  for (const t of cap.testability.claims) {
    if (known.has(t.ref)) continue;
    for (const f of t.findings) out.push(lintReason(f, t.ref, mk));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aligned
// ---------------------------------------------------------------------------

function alignedReasons(cap: CapabilityInput, policy: ProofPolicy, mk: MakeReason): Reason[] {
  const out: Reason[] = [];
  if (cap.ownedFiles.length === 0) {
    out.push(mk('NO_OWNED_FILES', 'aligned', 'fail', 'never', 'the capability owns no files, so no code can be shown to match its claims', { fix: 'add the files to the spec\'s `sources:`' }));
  }
  const cov = cap.coverage;
  const gate = 'requireAlignment';
  if (!cov) {
    out.push(mk('NO_COVERAGE_EVIDENCE', 'aligned', 'unknown', gate, 'no coverage ingested for this capability', { fix: 'specguard test run --coverage --per-capability' }));
  } else if (cov.testsStale) {
    out.push(mk('COVERAGE_STALE', 'aligned', 'unknown', gate, 'the tests tagged to this capability changed since the coverage run', { fix: 'specguard test run --coverage --per-capability' }));
  } else if (cov.reported === 0 && cov.stale.length > 0) {
    out.push(mk('COVERAGE_STALE', 'aligned', 'unknown', gate, `coverage is out of date for all ${cov.stale.length} owned file(s)`, { fix: 'specguard test run --coverage --per-capability', data: { stale: cov.stale.slice(0, 20) } }));
  } else {
    const diffLow = (d: NonNullable<CoverageInput['diff']>): boolean => d.pct !== null && d.pct < policy.minDiffCoverage;
    const fix = 'specguard test run --coverage --per-capability';
    if (cov.source === 'capability' && cov.selection === 'tests') {
      if (cov.lines.executable > 0 && cov.lines.hit === 0) {
        out.push(mk('CLAIM_TESTS_REACH_NO_OWNED_CODE', 'aligned', 'fail', gate, 'the tests tagged to this capability execute none of its owned code'));
      }
      if (cap.changeMode && cov.diff) {
        if (cov.diff.unknownFiles.length > 0) {
          out.push(mk('COVERAGE_STALE', 'aligned', 'unknown', gate, `${cov.diff.unknownFiles.length} changed owned file(s) have no fresh coverage`, { fix, data: { files: cov.diff.unknownFiles.slice(0, 20) } }));
        } else if (diffLow(cov.diff)) {
          out.push(mk('UNSPECIFIED_CHANGE', 'aligned', 'fail', gate,
            `${cov.diff.pct}% of changed lines are reached by claim tests (minimum ${policy.minDiffCoverage}%): the rest changes behaviour no claim covers`,
            { data: { pct: cov.diff.pct as number, missed: cov.diff.missed.map((m) => m.file) } }));
        }
      }
    } else if (cap.changeMode && cov.diff && cov.diff.unknownFiles.length > 0) {
      out.push(mk('COVERAGE_STALE', 'aligned', 'unknown', gate, `${cov.diff.unknownFiles.length} changed owned file(s) have no fresh coverage`, { fix, data: { files: cov.diff.unknownFiles.slice(0, 20) } }));
    } else if (cap.changeMode && cov.diff && diffLow(cov.diff)) {
      out.push(mk('DIFF_COVERAGE_LOW', 'aligned', 'fail', gate, `only ${cov.diff.pct}% of changed lines are reached by any test (minimum ${policy.minDiffCoverage}%)`, {
        data: { pct: cov.diff.pct as number, missed: cov.diff.missed.map((m) => m.file) },
      }));
    } else {
      out.push(mk('SUITE_ONLY_COVERAGE', 'aligned', 'unknown', gate, 'coverage comes from the whole suite or from files, which cannot show that claim tests reach the code or that executed code is specified', { fix }));
    }
    if (!cap.changeMode && cov.unreached.lines > 0) {
      out.push(mk('UNREACHED_OWNED_CODE', 'aligned', 'note', gate, `${cov.unreached.lines} owned executable line(s) are not reached by the tests`, { data: { lines: cov.unreached.lines } }));
    }
    if (cov.evidence.origin !== 'ci') {
      out.push(mk('LOCAL_EVIDENCE', 'aligned', 'note', gate, `coverage was recorded by a ${cov.evidence.origin} run (${cov.evidence.runId})`, { data: { origin: cov.evidence.origin } }));
    }
  }
  if (cap.intentGap) {
    out.push(mk('INTENT_GAP', 'aligned', 'note', 'never', `code changed ${cap.intentGap.codeDate}, after the intent was last changed ${cap.intentGap.intentDate}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conforms
// ---------------------------------------------------------------------------

type MutationOutcome = { ok: true } | { ok: false; reason: 'NO_MUTANTS' | 'NOT_KILLED' | 'SCORE_LOW' | 'STALE' };

/** The policy applied to a claim's mutation evidence; the capability score stands in when no per-claim score exists. */
function mutationOutcome(m: ClaimMutationInput, capScore: number | null, policy: ProofPolicy): MutationOutcome {
  if (m.stale) return { ok: false, reason: 'STALE' };
  if (m.considered === 0) return { ok: false, reason: 'NO_MUTANTS' };
  if (m.killed < policy.mutation.minKilled) return { ok: false, reason: 'NOT_KILLED' };
  const score = m.score ?? capScore;
  if (score !== null && score < policy.mutation.minScore) return { ok: false, reason: 'SCORE_LOW' };
  return { ok: true };
}

const EVIDENCE_OF_ASSURANCE: Partial<Record<Assurance, LayerEvidenceKind>> = { bounded: 'bounded', 'proved-model': 'proof-model', 'proved-code': 'proof-code' };

function ledgerReason(verdict: EffectiveVerdict, what: 'claim' | 'example', noTests: boolean): { code: ReasonCode; outcome: 'fail' | 'unknown' } | undefined {
  const ex = what === 'example';
  switch (verdict) {
    case 'failed':
      return { code: ex ? 'EXAMPLE_FAILED' : 'CLAIM_FAILED', outcome: 'fail' };
    case 'error':
      return { code: ex ? 'EXAMPLE_FAILED' : 'CLAIM_ERROR', outcome: 'fail' };
    case 'stale':
      return { code: ex ? 'EXAMPLE_STALE' : 'CLAIM_STALE', outcome: 'unknown' };
    case 'unproven':
      return { code: ex ? 'EXAMPLE_UNPROVEN' : 'CLAIM_UNPROVEN', outcome: 'unknown' };
    case 'unexercised':
      if (ex) return { code: 'EXAMPLE_UNPROVEN', outcome: 'unknown' };
      return noTests ? { code: 'NO_TAGGED_TESTS', outcome: 'fail' } : { code: 'CLAIM_UNEXERCISED', outcome: 'unknown' };
    default:
      return undefined;
  }
}

const VERDICT_MESSAGE: Record<string, string> = {
  CLAIM_FAILED: 'a tagged test failed',
  CLAIM_ERROR: 'a tagged test errored',
  CLAIM_STALE: 'the proof is out of date: the claim, the code or the dependencies changed since the run',
  CLAIM_UNPROVEN: 'no test run has proven this claim',
  CLAIM_UNEXERCISED: 'tests ran but exercised nothing for this claim',
  NO_TAGGED_TESTS: 'no test is tagged to this claim',
};

function conformsClaimReasons(cap: CapabilityInput, c: ClaimInput, policy: ProofPolicy, mk: MakeReason): Reason[] {
  const out: Reason[] = [];
  const claim = c.ref;
  const nonTest = c.evidence !== 'test';
  const strengthNoTests = c.strength !== undefined && (c.strength.reasons.some((r) => r.code === 'NO_TAGGED_TESTS') || Object.values(c.strength.perLayer).every((l) => sum(l) === 0));

  // 1. Ledger verdict.
  let emittedNoTests = false;
  const lr = ledgerReason(c.proof.verdict, 'claim', strengthNoTests);
  if (lr) {
    emittedNoTests = lr.code === 'NO_TAGGED_TESTS';
    const failing = Object.entries(c.proof.layers).filter(([, v]) => v === c.proof.verdict).map(([l]) => l);
    out.push(mk(lr.code, 'conforms', lr.outcome, 'requireConforms', `${VERDICT_MESSAGE[lr.code]}${failing.length > 0 && c.proof.verdict !== 'unexercised' ? ` (${failing.join(', ')})` : ''}`, {
      claim, fix: lr.code === 'NO_TAGGED_TESTS' ? `tag a test with // [claims: ${claim}]` : lr.code === 'CLAIM_FAILED' || lr.code === 'CLAIM_ERROR' ? undefined : 'specguard test run',
    }));
  } else if (nonTest && !Object.entries(c.proof.layers).some(([l, v]) => v === 'proven' && c.layerEvidence[l] === c.evidence)) {
    // Proven by tests does not satisfy a claim that declares manual or agentic evidence.
    out.push(mk('CLAIM_UNPROVEN', 'conforms', 'unknown', 'requireConforms', `needs ${c.evidence} evidence${c.verifier ? ` from ${c.verifier}` : ''}, which the ledger does not hold`, { claim, fix: c.evidence === 'agentic' ? 'specguard verify' : 'record the manual verdict with specguard proof ingest' }));
  }

  // 2. Required layers.
  for (const layer of c.proof.missing) {
    const tests = c.strength ? sum(c.strength.perLayer[layer]) : undefined;
    out.push(tests === 0
      ? mk('LAYER_UNTESTED', 'conforms', 'fail', 'layers', `no test is tagged to this claim at the ${layer} layer`, { claim, data: { layer }, fix: `add a ${layer} test tagged // [claims: ${claim}]` })
      : mk('LAYER_MISSING', 'conforms', 'unknown', 'layers', `the ${layer} layer has no current proof`, { claim, data: { layer }, fix: 'specguard test run' }));
  }
  for (const layer of c.required) {
    const kind = c.layerEvidence[layer];
    if (layer !== 'functional' && c.proof.layers[layer] === 'proven' && (kind === 'agentic' || kind === 'manual')) {
      out.push(mk('AGENTIC_NOT_ACCEPTED', 'conforms', 'fail', 'layers', `the ${layer} layer is satisfied only by ${kind} evidence, which never stands in for an automated layer`, { claim, data: { layer, evidence: kind } }));
    }
  }

  // 3. Example rows.
  for (const ex of c.examples) {
    const er = ledgerReason(ex.proof, 'example', false);
    if (er) out.push(mk(er.code, 'conforms', er.outcome, 'requireConforms', `example row "${ex.id}": ${ex.proof}`, { claim, example: ex.id, fix: er.outcome === 'unknown' ? 'specguard test run' : undefined }));
    if (ex.strength === 'not-meaningful') out.push(mk('EXAMPLE_NOT_MEANINGFUL', 'conforms', 'fail', 'requireStrength', `no strong test is tagged to example row "${ex.id}"`, { claim, example: ex.id }));
  }

  // 4. Strength (a claim proven by a person or an agent has no test source to judge).
  if (!nonTest) {
    const s = c.strength;
    if (!s) {
      out.push(mk('STRENGTH_UNKNOWN', 'conforms', 'unknown', 'requireStrength', 'test strength was not analysed for this claim', { claim }));
    } else {
      for (const r of s.reasons) {
        const layerData = r.layer !== undefined ? { data: { layer: r.layer } } : {};
        switch (r.code) {
          case 'ALL_SKIPPED':
            out.push(mk('TESTS_SKIPPED_ONLY', 'conforms', 'fail', 'requireStrength', 'every tagged test is skipped', { claim }));
            break;
          case 'CONDITIONAL_ONLY':
            out.push(mk('CONDITIONAL_ONLY', 'conforms', 'fail', 'requireStrength', 'every tagged test that runs is conditional on a flag or environment', { claim }));
            break;
          case 'WEAK_ONLY':
            out.push(mk('WEAK_ONLY', 'conforms', 'fail', 'requireStrength', 'every tagged test is weak: it cannot fail on wrong behaviour', { claim }));
            break;
          case 'LAYER_NOT_MEANINGFUL':
            out.push(mk('LAYER_NOT_MEANINGFUL', 'conforms', 'fail', 'requireStrength', `no strong test is tagged at the ${r.layer ?? 'required'} layer`, { claim, ...layerData }));
            break;
          case 'STRENGTH_UNKNOWN':
            out.push(mk('STRENGTH_UNKNOWN', 'conforms', 'unknown', 'requireStrength', 'the tagged tests are in a language whose strength cannot be judged', { claim }));
            break;
          case 'NO_TAGGED_TESTS':
            if (!emittedNoTests) out.push(mk('NO_TAGGED_TESTS', 'conforms', 'fail', 'requireStrength', VERDICT_MESSAGE.NO_TAGGED_TESTS!, { claim, fix: `tag a test with // [claims: ${claim}]` }));
            break;
        }
      }
    }
  }

  // 5. Sensitivity: only for a claim that changed against the base, and only with a base (so never unknown for lack of one).
  if (!nonTest && cap.changeMode && (c.change === 'added' || c.change === 'modified')) {
    const mutation = c.mutation;
    const verdict = mutation ? mutationOutcome(mutation, cap.mutation?.score ?? null, policy) : undefined;
    if (c.redGreen === 'ok' || verdict?.ok === true) {
      // sensitive
    } else if (!mutation || (verdict?.ok === false && verdict.reason === 'NO_MUTANTS')) {
      out.push(mk('SENSITIVITY_MISSING', 'conforms', c.redGreen === 'fail' ? 'fail' : 'unknown', 'requireSensitivity',
        c.redGreen === 'fail' ? 'the red-green check failed: the claim\'s tests also pass without the change' : `no evidence that the tests detect a change (${c.change} claim): no mutation result and no red-green run`,
        { claim, fix: 'specguard mutation ingest <report>' }));
    } else if (verdict && !verdict.ok) {
      const lim = policy.mutation;
      if (verdict.reason === 'NOT_KILLED') out.push(mk('MUTATION_NOT_KILLED', 'conforms', 'fail', 'requireSensitivity', `the claim's tests killed ${mutation.killed} of ${mutation.considered} mutants (need at least ${lim.minKilled})`, { claim, data: { killed: mutation.killed, considered: mutation.considered } }));
      else if (verdict.reason === 'SCORE_LOW') out.push(mk('MUTATION_SCORE_LOW', 'conforms', 'fail', 'requireSensitivity', `mutation score ${mutation.score ?? cap.mutation?.score}% is below the minimum ${lim.minScore}%`, { claim, data: { score: (mutation.score ?? cap.mutation?.score) as number, minScore: lim.minScore } }));
      else out.push(mk('MUTATION_STALE', 'conforms', 'unknown', 'requireSensitivity', 'the mutation report predates the current code', { claim, fix: 'specguard mutation ingest <report>' }));
    }
  }

  // 6. Assurance.
  if (!nonTest && c.assurance !== 'tested') {
    if (c.assurance === 'property') {
      if (!c.strength) out.push(mk('ASSURANCE_UNMET', 'conforms', 'unknown', 'requireConforms', 'a property test is required but test strength was not analysed', { claim, data: { assurance: c.assurance } }));
      else if (!c.strength.property) out.push(mk('ASSURANCE_UNMET', 'conforms', 'fail', 'requireConforms', 'assurance `property` needs a strong property-based test tagged to the claim', { claim, data: { assurance: c.assurance } }));
    } else {
      const kind = EVIDENCE_OF_ASSURANCE[c.assurance];
      const met = Object.entries(c.proof.layers).some(([l, v]) => v === 'proven' && c.layerEvidence[l] === kind);
      if (!met) out.push(mk('ASSURANCE_TOOLING_MISSING', 'conforms', 'unknown', 'requireConforms', `assurance \`${c.assurance}\` needs ${kind} evidence, which no tool has recorded`, { claim, data: { assurance: c.assurance } }));
    }
  }

  // 7. Manual and agentic evidence.
  if (nonTest && Object.entries(c.proof.layers).some(([l, v]) => v === 'proven' && c.layerEvidence[l] === c.evidence)) {
    out.push(mk('MANUAL_EVIDENCE', 'conforms', 'note', 'requireConforms', `${c.evidence} evidence${c.verifier ? `, verified by ${c.verifier}` : ''}`, { claim, data: { kind: c.evidence } }));
  }

  // 8. Origins.
  const origins = unique([...c.proofOrigins, ...c.examples.flatMap((e) => e.proofOrigins)]);
  const nonCi = origins.filter((o) => o !== 'ci');
  if (nonCi.length > 0) {
    out.push(policy.requireCi
      ? mk('CI_EVIDENCE_REQUIRED', 'conforms', 'unknown', 'requireCi', `proof was earned on a ${nonCi.join(' and ')} run and policy requires CI evidence`, { claim, data: { origins: nonCi }, fix: 'push and let CI run the tests' })
      : mk('LOCAL_EVIDENCE', 'conforms', 'note', 'requireConforms', `proof was earned on a ${nonCi.join(' and ')} run, not in CI`, { claim, data: { origins: nonCi } }));
  }
  return out;
}

function conformsCapabilityReasons(cap: CapabilityInput, policy: ProofPolicy, head: StatementInput['head'], mk: MakeReason): Reason[] {
  const out: Reason[] = [];
  const claimRefs = new Set(cap.claims.map((c) => c.ref));
  const inputs = new Set(cap.inputs);

  // 9. Weakening that names this capability's claims or tagged test files.
  for (const w of cap.weakening) {
    const named = w.claims.find((r) => claimRefs.has(r));
    if (named === undefined && !inputs.has(w.file)) continue;
    out.push(mk('WEAKENING', 'conforms', w.severity === 'error' ? 'fail' : 'note', 'requireStrength', `${w.kind}: ${w.message}`, {
      ...(named !== undefined ? { claim: named } : {}), file: w.file, data: { kind: w.kind, ...(w.line !== undefined ? { line: w.line } : {}) },
    }));
  }

  // Coverage and mutation evidence earned off CI.
  const m = cap.mutation;
  if (m?.origin !== undefined && m.origin !== 'ci') {
    out.push(policy.requireCi
      ? mk('CI_EVIDENCE_REQUIRED', 'conforms', 'unknown', 'requireCi', `mutation evidence came from a ${m.origin} run and policy requires CI evidence`, { data: { origins: [m.origin] } })
      : mk('LOCAL_EVIDENCE', 'conforms', 'note', 'requireConforms', `mutation evidence came from a ${m.origin} run, not in CI`, { data: { origin: m.origin } }));
  }

  const dirty = cap.inputs.filter((f) => head.dirty.includes(f));
  if (dirty.length > 0) {
    out.push(mk('DIRTY_TREE', 'conforms', 'note', 'requireConforms', `${dirty.length} input file(s) have uncommitted changes: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', ...' : ''}`, { data: { files: dirty.slice(0, 20) } }));
  } else if (head.sha === undefined) {
    out.push(mk('DIRTY_TREE', 'conforms', 'note', 'requireConforms', 'the commit is unknown (not a git checkout), so nothing can be certified at a commit', { data: { unknownHead: true } }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const OUTCOME_RANK = { fail: 0, unknown: 1, note: 2 } as const;

function statusOf(reasons: readonly Reason[]): PillarStatus {
  if (reasons.some((r) => r.outcome === 'fail')) return 'fail';
  if (reasons.some((r) => r.outcome === 'unknown')) return 'unknown';
  return 'ok';
}

/** Precedence: pillar order, fail before unknown, capability-level before claim-level, claim order, example order. */
function sorter(cap: CapabilityInput): (a: Reason, b: Reason) => number {
  const claimIdx = new Map<string, number>();
  cap.claims.forEach((c, i) => claimIdx.set(c.ref, i));
  cap.testability.claims.forEach((t, i) => {
    if (!claimIdx.has(t.ref)) claimIdx.set(t.ref, cap.claims.length + i);
  });
  const exampleIdx = new Map<string, number>();
  for (const c of cap.claims) c.examples.forEach((e, i) => exampleIdx.set(`${c.ref}/${e.id}`, i));
  const key = (r: Reason): number[] => [
    PILLARS.indexOf(r.pillar),
    OUTCOME_RANK[r.outcome],
    r.claim === undefined ? 0 : 1,
    r.claim === undefined ? 0 : (claimIdx.get(r.claim) ?? Number.MAX_SAFE_INTEGER),
    r.example === undefined ? -1 : (exampleIdx.get(`${r.claim}/${r.example}`) ?? Number.MAX_SAFE_INTEGER),
  ];
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return 0;
  };
}

const pct = (n: number | null | undefined): string => (n === null || n === undefined ? '-' : `${Math.round(n)}%`);

function pillarSummaries(cap: CapabilityInput, byPillar: Record<PillarName, Reason[]>, status: Record<PillarName, PillarStatus>, planned: boolean): Record<PillarName, string> {
  const n = cap.claims.length;
  const approvedN = cap.claims.filter((c) => c.approval !== undefined).length;
  const first = (p: PillarName): Reason | undefined => byPillar[p].find((r) => r.outcome !== 'note');
  const lintErrors = byPillar.testable.filter((r) => r.code === 'LINT_ERROR').length;
  const lintWarnings = byPillar.testable.filter((r) => r.code === 'LINT_WARNING').length;
  const verdicts = { proven: 0, failed: 0, stale: 0, unproven: 0 };
  for (const c of cap.claims) {
    const v = c.proof.verdict;
    if (v === 'proven') verdicts.proven++;
    else if (v === 'failed' || v === 'error') verdicts.failed++;
    else if (v === 'stale') verdicts.stale++;
    else verdicts.unproven++;
  }
  const cov = cap.coverage;
  const alignedFirst = first('aligned');
  return {
    approved: `${approvedN}/${n} claims approved`,
    testable: n === 0 ? 'no anchored claims' : `${lintErrors} errors, ${lintWarnings} warnings`,
    aligned: planned ? 'planned' : status.aligned !== 'ok' && alignedFirst ? REASON_LABELS[alignedFirst.code] : cov ? `lines ${pct(cov.lines.pct)}${cov.diff ? `, diff ${pct(cov.diff.pct)}` : ''}` : 'no coverage evidence',
    conforms: planned ? 'planned' : `${verdicts.proven} proven, ${verdicts.failed} failed, ${verdicts.stale} stale${verdicts.unproven > 0 ? `, ${verdicts.unproven} unproven` : ''}`,
  };
}

const LEVEL_TEXT: Record<CertLevel, string> = { certified: 'CERTIFIED', provisional: 'PROVISIONAL', 'not-certified': 'NOT CERTIFIED', planned: 'PLANNED' };
const STATUS_MARK: Record<PillarStatus, string> = { ok: 'ok', fail: 'FAIL', unknown: '??' };

function reasonSummary(r: Reason): string {
  const label = REASON_LABELS[r.code];
  if (r.claim === undefined) return label;
  return `${label} (${claimIdOf(r.claim)}${r.example !== undefined ? `/${r.example}` : ''})`;
}

function headlineOf(id: string, level: CertLevel, pillars: Record<PillarName, PillarVerdict>, blocking: Reason[]): string {
  if (blocking.length > 0) return `${id}: ${LEVEL_TEXT[level]} - ${blocking.length} blocking: ${blocking.slice(0, 2).map(reasonSummary).join('; ')}`;
  return `${id}: ${LEVEL_TEXT[level]} - ${PILLARS.map((p) => `${p} ${STATUS_MARK[pillars[p].status]}`).join(' ')}`;
}

export function composeCapabilityStatement(input: CapabilityInput, ctx: { head: StatementInput['head']; policy: ProofPolicy }): CapabilityStatement {
  const { head, policy } = ctx;
  const mk = reasonMaker(policy);
  const planned = input.status === 'planned';

  const all: Reason[] = [...approvedReasons(input, mk), ...testableReasons(input, mk)];
  if (planned) {
    all.push(mk('PLANNED', 'aligned', 'note', 'never', 'the capability is planned: no code exists to align yet'));
    all.push(mk('PLANNED', 'conforms', 'note', 'never', 'the capability is planned: nothing to prove yet'));
  } else {
    all.push(...alignedReasons(input, policy, mk));
    for (const c of input.claims) all.push(...conformsClaimReasons(input, c, policy, mk));
    all.push(...conformsCapabilityReasons(input, policy, head, mk));
  }
  all.sort(sorter(input));

  const byPillar: Record<PillarName, Reason[]> = { approved: [], testable: [], aligned: [], conforms: [] };
  for (const r of all) byPillar[r.pillar].push(r);
  const status = Object.fromEntries(PILLARS.map((p) => [p, planned && (p === 'aligned' || p === 'conforms') ? 'unknown' : statusOf(byPillar[p])])) as Record<PillarName, PillarStatus>;
  const summaries = pillarSummaries(input, byPillar, status, planned);
  const pillars = Object.fromEntries(PILLARS.map((p) => [p, { status: status[p], reasons: byPillar[p], summary: summaries[p] }])) as Record<PillarName, PillarVerdict>;
  const blocking = all.filter((r) => r.blocking);

  const claims: ClaimStatement[] = input.claims.map((c) => {
    const reasons = all.filter((r) => r.claim === c.ref);
    const of = (p: PillarName): PillarStatus => statusOf(reasons.filter((r) => r.pillar === p));
    return { ref: c.ref, pillars: { approved: of('approved'), testable: of('testable'), aligned: status.aligned, conforms: planned ? 'unknown' : of('conforms') }, reasons };
  });

  const origins = unique<Origin>([
    ...input.claims.flatMap((c) => [...c.proofOrigins, ...c.examples.flatMap((e) => e.proofOrigins)]),
    ...(input.coverage ? [input.coverage.evidence.origin] : []),
    ...(input.mutation?.origin ? [input.mutation.origin] : []),
  ]).sort();
  const dirty = input.inputs.some((f) => head.dirty.includes(f));
  const allOk = PILLARS.every((p) => status[p] === 'ok');
  let level: CertLevel;
  if (planned) level = 'planned';
  else if (!allOk) level = 'not-certified';
  else if (origins.every((o) => o === 'ci') && head.sha !== undefined && !dirty) level = 'certified';
  else level = 'provisional';

  const limits = unique(input.claims.flatMap((c) => c.mutation?.limits ?? []));
  const strengths = input.claims.filter((c) => c.strength !== undefined);
  const out: CapabilityStatement = {
    capability: input.id,
    title: input.title,
    status: input.status,
    level,
    ...(level === 'certified' ? { certifiedAt: head.sha } : {}),
    pillars,
    blocking,
    claims,
    metrics: {
      claims: input.claims.length,
      approved: input.claims.filter((c) => c.approval !== undefined).length,
      testable: input.claims.filter((c) => c.testability.testable).length,
      proven: input.claims.filter((c) => c.proof.complete).length,
      meaningful: strengths.length === 0 ? null : strengths.filter((c) => c.strength!.meaningful === true).length,
      lineCoverage: input.coverage?.lines.pct ?? null,
      diffCoverage: input.coverage?.diff?.pct ?? null,
      mutationScore: input.mutation?.score ?? null,
    },
    evidence: {
      origins,
      shas: unique(input.claims.flatMap((c) => c.proofShas)).sort(),
      ...(input.coverage ? { coverageRunId: input.coverage.evidence.runId } : {}),
      ...(input.mutation?.tool ? { mutationTool: input.mutation.tool } : {}),
    },
    headline: headlineOf(input.id, level, pillars, blocking),
  };
  if (limits.length > 0) out.limits = limits;
  return out;
}

const LEVEL_ORDER: CertLevel[] = ['not-certified', 'provisional', 'certified'];

export function composeSystemStatement(input: StatementInput): SystemStatement {
  const { head, policy } = input;
  const mk = reasonMaker(policy);
  const capabilities = input.capabilities.map((c) => composeCapabilityStatement(c, { head, policy }));
  const counts: Record<CertLevel, number> = { certified: 0, provisional: 0, 'not-certified': 0, planned: 0 };
  for (const c of capabilities) counts[c.level]++;

  const reasons: Reason[] = [];
  if (input.unowned.length > 0) {
    reasons.push(mk('UNOWNED_FILES', 'aligned', 'fail', 'never', `${input.unowned.length} source file(s) have no owning spec`, { fix: 'specguard spec draft', data: { files: input.unowned.slice(0, 20), count: input.unowned.length } }));
  }

  const live = capabilities.filter((c) => c.level !== 'planned');
  let level: CertLevel;
  if (live.length === 0) level = counts.planned > 0 && reasons.length === 0 ? 'planned' : 'not-certified';
  else if (reasons.length > 0) level = 'not-certified';
  else level = live.reduce<CertLevel>((worst, c) => (LEVEL_ORDER.indexOf(c.level) < LEVEL_ORDER.indexOf(worst) ? c.level : worst), 'certified');

  const blocking = capabilities.some((c) => c.blocking.length > 0) || reasons.some((r) => r.blocking);
  return {
    version: 1,
    generated: input.generated,
    ...(head.sha !== undefined ? { head: head.sha } : {}),
    ...(head.base !== undefined ? { base: head.base } : {}),
    policy,
    level,
    ...(level === 'certified' && head.sha !== undefined ? { certifiedAt: head.sha } : {}),
    capabilities,
    system: { reasons },
    counts,
    exitCode: blocking ? ExitCode.NotCertified : ExitCode.Success,
  };
}

/** The statement for `input`, optionally under a different `policy` than the one it carries. */
export function computeStatement(input: StatementInput, policy?: ProofPolicy): SystemStatement {
  return composeSystemStatement(policy ? { ...input, policy } : input);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const levelToken = (l: CertLevel): string => l.toUpperCase();

/** `STATEMENT: <id> <LEVEL> approved=ok testable=ok aligned=?? conforms=FAIL`. */
export function statementLine(c: CapabilityStatement): string {
  return `STATEMENT: ${c.capability} ${levelToken(c.level)} ${PILLARS.map((p) => `${p}=${STATUS_MARK[c.pillars[p].status]}`).join(' ')}`;
}

/** One `STATEMENT:` line per capability, then the system line. These are what `check` appends to its summary. */
export function headlineLines(s: SystemStatement): string[] {
  const lines = s.capabilities.map(statementLine);
  const n = s.counts;
  const at = s.certifiedAt ? ` at ${s.certifiedAt.slice(0, 7)}` : '';
  const unowned = s.system.reasons.find((r) => r.code === 'UNOWNED_FILES');
  lines.push(`STATEMENT: system ${levelToken(s.level)}${at} certified=${n.certified} provisional=${n.provisional} not-certified=${n['not-certified']} planned=${n.planned}${unowned ? ` unowned=${unowned.data?.count ?? 0}` : ''}`);
  return lines;
}

/** The names of the gates a policy turns on, for the explain header (`approval, conforms`). */
export function policyLabel(p: ProofPolicy): string {
  const names = GATE_FLAGS.filter((k) => p[k]).map((k) => k.slice('require'.length).toLowerCase());
  if (p.enforceLayers === 'fail' && !p.requireConforms) names.push('layers');
  return names.length > 0 ? names.join(', ') : 'none';
}

const MAX_ADVISORY_PER_CODE = 3;

function target(r: Reason): string {
  if (r.claim === undefined) return r.file !== undefined ? ` ${r.file}` : '';
  return ` ${r.claim}${r.example !== undefined ? `/${r.example}` : ''}`;
}

/**
 * The `check --explain` text for one capability: the pillars, the blocking reasons in precedence order with the
 * command that fixes each, and the advisory reasons (grouped by code, the first few of each shown).
 */
export function explainCapability(s: CapabilityStatement, ctx?: { head?: string; policy?: ProofPolicy }): string[] {
  const at = s.certifiedAt ?? ctx?.head;
  const policy = ctx?.policy ? ` (policy: ${policyLabel(ctx.policy)})` : '';
  const lines = [`${s.capability} (${s.title}): ${LEVEL_TEXT[s.level]}${at ? ` at ${at.slice(0, 7)}` : ''}${policy}`];
  for (const p of PILLARS) {
    const v = s.pillars[p];
    const tag = v.reasons.some((r) => r.blocking) ? 'blocking' : v.status !== 'ok' ? 'advisory' : '';
    lines.push(`  ${p.padEnd(9)}${STATUS_MARK[v.status].padEnd(8)} ${v.summary.padEnd(38)}${tag ? ` ${tag}` : ''}`.trimEnd());
  }
  if (s.blocking.length > 0) {
    lines.push('Blocking:');
    s.blocking.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.code}${target(r)}: ${r.message}`);
      if (r.fix) lines.push(`     fix: ${r.fix}`);
    });
  }
  const advisory = PILLARS.flatMap((p) => s.pillars[p].reasons).filter((r) => !r.blocking);
  if (advisory.length > 0) {
    lines.push('Advisory:');
    const shown = new Map<ReasonCode, number>();
    const hidden = new Map<ReasonCode, number>();
    for (const r of advisory) {
      const k = shown.get(r.code) ?? 0;
      if (k >= MAX_ADVISORY_PER_CODE) {
        hidden.set(r.code, (hidden.get(r.code) ?? 0) + 1);
        continue;
      }
      shown.set(r.code, k + 1);
      lines.push(`  - ${r.code}${target(r)}: ${r.message}${r.fix ? `; fix: ${r.fix}` : ''}`);
    }
    for (const [code, n] of hidden) lines.push(`  - ${code}: ${n} more`);
  }
  if (s.limits && s.limits.length > 0) lines.push(`Limits: ${s.limits.join('; ')}`);
  return lines;
}
