/**
 * The PR proof packet: what the requirements now say, the evidence for each changed requirement, the verdict per
 * capability and for the whole change, rendered as one markdown comment and one JSON document. The same builder
 * serves CI and `change report` (which marks the packet provisional). Pure: build and render only; no LLM, so every
 * sentence is made from text already in the specs, history and statement.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import type { ChangedClaim, ClaimChange } from './change-claims.js';
import type { ChangeKind } from './change-record.js';
import type { EffectiveVerdict } from './proof-ledger.js';
import type { PillarName, PillarStatus, SystemStatement } from './proof-statement.js';
import type { UnrequestedReport } from './unrequested.js';
import type { EnforceLevel } from './types.js';
import type { WeakeningFinding } from './weakening.js';

export const PACKET_SCHEMA = 'specguard.proof-packet';
export const PACKET_VERSION = 1;
/** First line of the packet comment; CI finds its own comment by it. */
export const PACKET_MARKER = '<!-- specguard-proof-packet v1 -->';
/** Default `maxChars` of the markdown rendering. GitHub rejects a comment of more than 65536 characters. */
export const PACKET_MAX_CHARS = 60_000;
export const PACKET_GITHUB_LIMIT = 65_536;

export const PACKET_VERDICTS = ['ready', 'blocked', 'advisory', 'no-change'] as const;
export type PacketVerdict = (typeof PACKET_VERDICTS)[number];

export const APPROVAL_TRUSTS = ['verified', 'countersigned', 'self-approved', 'inherited', 'recorded', 'missing'] as const;
export type ApprovalTrust = (typeof APPROVAL_TRUSTS)[number];

export interface PacketApproval {
  method: 'pr' | 'plan' | 'command' | 'as-built';
  by: string;
  trust: ApprovalTrust;
  /** pr: review id + reviewer; plan/command/as-built: history entry id. */
  source: string;
  date: string;
  countersignedBy?: string;
}

export interface IntentChange {
  ref: string;
  capability: string;
  change: ClaimChange;
  text?: string;
  baseText?: string;
  /** Plain-language one-liner: "now reads: ..." / "was: ...". Text only, never LLM. */
  summary: string;
  /** Absent for removed claims unless an approved removal (a PR review covers removals). */
  approval?: PacketApproval;
}

export interface ClaimEvidence {
  ref: string;
  layers: Array<{ layer: string; verdict: EffectiveVerdict; origin: 'ci' | 'local' | 'note' }>;
  examples: { total: number; proven: number; failing: string[] };
  sensitivity:
    | { kind: 'red-green'; status: 'ok' | 'fail' | 'unknown'; redTests: number }
    | { kind: 'mutation'; status: 'ok' | 'fail' | 'unknown'; score: number | null; killed: number }
    | { kind: 'none' };
  strength: 'strong' | 'weak' | 'skipped' | 'conditional' | 'unknown';
  verdict: 'pass' | 'fail' | 'unknown';
  /** ReasonCode labels from the statement, in precedence order. */
  reasons: string[];
}

export interface CapabilityVerdict {
  capability: string;
  title: string;
  enforce: EnforceLevel;
  pillars: Record<PillarName, PillarStatus>;
  verdict: 'pass' | 'fail' | 'unknown';
  /** What this capability does to the merge: enforce+fail -> blocks; warn+fail -> warns; observe -> none. */
  effect: 'blocks' | 'warns' | 'none';
  blocking: Array<{ code: string; message: string; fix?: string }>;
}

export interface ChangeVerdict {
  id: string;
  kind: ChangeKind;
  capabilities: string[];
  verdict: 'pass' | 'fail' | 'spike';
  claims: string[];
  /** Advisory, from PR commit order. */
  chronology?: { testsBeforeCode: boolean | null; note: string };
  refactor?: { claimsProvenBefore: number; claimsProvenAfter: number; changedLineCoverage: number | null; mutation?: { killed: number; total: number } };
}

export interface PipelineChange {
  file: string;
  kind: 'workflow' | 'specguard-config' | 'codeowners' | 'action';
  severity: 'warn' | 'error';
}

export interface ProofPacket {
  schema: typeof PACKET_SCHEMA;
  version: 1;
  generated: string;
  head: string;
  base: string;
  baseRef?: string;
  pr?: { number: number; author: string; url?: string };
  run?: { id: string; url?: string };
  /** specguard version. */
  tool: string;
  verdict: PacketVerdict;
  headline: string;
  intent: IntentChange[];
  evidence: ClaimEvidence[];
  capabilities: CapabilityVerdict[];
  changes: ChangeVerdict[];
  weakening: WeakeningFinding[];
  unrequested: UnrequestedReport;
  pipeline: PipelineChange[];
  /** Ordered fix commands (deduplicated), first = most important. */
  fixes: string[];
  limits: string[];
  /** True for `change report` (local). */
  provisional: boolean;
}

export interface PacketInput {
  /** Change mode (base given). */
  statement: SystemStatement;
  changed: ChangedClaim[];
  /** By ref, after the CI trust rules. */
  approvals: Map<string, PacketApproval>;
  sensitivity: Map<string, ClaimEvidence['sensitivity']>;
  changes: ChangeVerdict[];
  weakening: WeakeningFinding[];
  unrequested: UnrequestedReport;
  pipeline: PipelineChange[];
  enforce: Map<string, EnforceLevel>;
  meta: Pick<ProofPacket, 'generated' | 'head' | 'base' | 'baseRef' | 'pr' | 'run' | 'tool' | 'provisional'>;
  policy: { unrequested: 'error' | 'warn' };
}

/**
 * Verdict rules. Per capability touched by the PR: pass when the changed claims' four pillars are ok, there is no
 * error-level weakening, no unrequested line (policy `error`), no file without a change (when required) and every
 * covering change passed; unknown when the only problems are unknown reasons. Effect: enforce + fail or unknown blocks;
 * warn + not pass warns; observe has none. Overall: blocked, else advisory, else no-change, else ready.
 */
export function buildPacket(_input: PacketInput): ProofPacket {
  throw new Error('not implemented: buildPacket');
}

/** Markdown comment, sections with nothing to show omitted (except the headline and Capabilities), cut to `maxChars` (default PACKET_MAX_CHARS). */
export function renderPacketMarkdown(_p: ProofPacket, _opts?: { maxChars?: number }): string {
  throw new Error('not implemented: renderPacketMarkdown');
}

/** sha256 hex of the packet JSON in a stable key order. */
export function packetDigest(_p: ProofPacket): string {
  throw new Error('not implemented: packetDigest');
}
