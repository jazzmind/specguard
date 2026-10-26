/**
 * The proof note: one JSON document per proven commit, kept in git notes (`refs/notes/specguard`) by CI. It is
 * cumulative: it holds every ledger row that is fresh at its commit, so a reader needs only the nearest noted
 * ancestor. Rows share one file-hash table to stay small. Pure: this module parses, serializes and converts; the git
 * plumbing lives in `proof-store.ts`.
 *
 * Spec: specs/capabilities/proof-store.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import { z } from 'zod/v4';

import { CHANGE_KINDS, type ChangeKind } from './change-record.js';
import { PACKET_VERDICTS, type PacketVerdict } from './proof-packet.js';
import type { ProofEvidence, ProofLedger, StoredVerdict } from './proof-ledger.js';
import { PILLARS, type CertLevel, type PillarName, type PillarStatus } from './proof-statement.js';
import { TEST_LAYERS, type EvidenceLayer } from './test-layers.js';
import { ENFORCE_LEVELS, type EnforceLevel } from './types.js';

export const NOTE_SCHEMA = 'specguard.proof-note';
export const NOTE_VERSION = 1;
export const DEFAULT_NOTES_REF = 'refs/notes/specguard';
/** 1 MiB: warn, drop evidencePath and runner details. */
export const NOTE_SOFT_LIMIT = 1_048_576;
/** 8 MiB: refuse to write; upload as an artifact only. */
export const NOTE_HARD_LIMIT = 8_388_608;

export interface NoteRow {
  /** Local ref: `specKey#claim` or `specKey#claim/row` (never repo-prefixed). */
  claim: string;
  layer: EvidenceLayer;
  verdict: StoredVerdict;
  runId: string;
  specHash: string;
  claimHash?: string;
  hashVersion: number;
  /** Paths whose hashes this row depends on; hashes are in ProofNote.files. Sorted. */
  files: string[];
  exercised: number;
  counterexamples: number;
  evidence?: ProofEvidence;
  /** Commit where this evidence was earned (== ProofNote.commit for rows earned in this run). */
  provedAt: string;
  ingestedAt: string;
  /** Changed claims only: red->green by construction (change protocol). */
  sensitivity?: { kind: 'red-green'; red: 'fail' | 'error'; tests: number } | { kind: 'mutation'; score: number; killed: number };
}

export interface NoteApproval {
  /** `specKey#claim[/row]` */
  claim: string;
  /** First 16 hex of the claim (or row) hash approved. */
  hash: string;
  method: 'pr';
  /** GitHub login of the reviewer. */
  by: string;
  pr: number;
  reviewId: number;
  /** Review commit; the claim hash was equal there and at the noted commit. */
  reviewedAt: string;
  /** YYYY-MM-DD */
  date: string;
}

/** Recorded (committed) approvals that CI accepted, and how: kept so readers can label them. */
export interface NoteCountersign {
  /** History entry id. */
  entry: string;
  method: 'command' | 'plan' | 'as-built';
  /** inherited = the entry was already on the base branch. */
  status: 'countersigned' | 'self-approved' | 'inherited';
  /** Reviewer login when countersigned. */
  by?: string;
  pr?: number;
}

export interface NoteStatementSummary {
  level: CertLevel;
  counts: Record<CertLevel, number>;
  capabilities: Array<{ id: string; level: CertLevel; enforce: EnforceLevel; pillars: Record<PillarName, PillarStatus> }>;
}

export interface ProofNote {
  schema: typeof NOTE_SCHEMA;
  version: 1;
  commit: string;
  tree: string;
  parents: string[];
  createdAt: string;
  tool: { specguard: string; node: string; hashVersion: number };
  ci: {
    provider: 'github' | 'other';
    /** pull_request | push | merge_group | workflow_dispatch | schedule | other */
    event: string;
    repo?: string;
    ref?: string;
    actor?: string;
    runId?: string;
    runAttempt?: number;
    runUrl?: string;
    workflow?: string;
    pr?: number;
  };
  /** Set when the rows were copied from a note on a commit with the same tree (squash and rebase import). */
  importedFrom?: { commit: string; reason: 'tree-equal' };
  /** Nearest noted ancestor whose rows were carried forward. */
  carriedFrom?: string;
  /** path -> sha256 of the file at `commit`, for every path any row names. */
  files: Record<string, string>;
  /** dependencyFingerprint at `commit`; applies to every row. */
  deps?: string;
  rows: NoteRow[];
  approvals: NoteApproval[];
  countersigns: NoteCountersign[];
  statement: NoteStatementSummary;
  /** Change verdicts decided at this commit. */
  changes: Array<{ id: string; kind: ChangeKind; verdict: 'pass' | 'fail' | 'spike'; claims: string[] }>;
  /** sha256 of the packet JSON, when this run built one. */
  packet?: { pr?: number; verdict: PacketVerdict; sha256: string };
}

export type NoteParse =
  | { ok: true; note: ProofNote }
  | { ok: false; reason: 'not-json' | 'wrong-schema' | 'newer-version' | 'invalid'; detail: string };

// ---------------------------------------------------------------------------
// Schema: zod/v4 looseObject, so fields added within a version survive a read by an older reader.
// ---------------------------------------------------------------------------

const EVIDENCE_LAYERS = [...TEST_LAYERS, 'unclassified'] as const;
const STORED_VERDICTS = ['proven', 'failed', 'unexercised', 'error'] as const;
const PROOF_EVIDENCE = ['test', 'agentic', 'manual'] as const;
const CERT_LEVELS = ['certified', 'provisional', 'not-certified', 'planned'] as const;
const PILLAR_STATUSES = ['ok', 'fail', 'unknown'] as const;

const SHORT_HASH = /^[0-9a-f]{16}$/;
const nonNegInt = z.number().int().nonnegative();

export const NoteRowSchema = z.looseObject({
  claim: z.string().min(1),
  layer: z.enum(EVIDENCE_LAYERS),
  verdict: z.enum(STORED_VERDICTS),
  runId: z.string(),
  specHash: z.string(),
  claimHash: z.string().optional(),
  hashVersion: nonNegInt,
  files: z.array(z.string()),
  exercised: nonNegInt,
  counterexamples: nonNegInt,
  evidence: z.enum(PROOF_EVIDENCE).optional(),
  provedAt: z.string(),
  ingestedAt: z.string(),
  sensitivity: z
    .discriminatedUnion('kind', [
      z.looseObject({ kind: z.literal('red-green'), red: z.enum(['fail', 'error']), tests: nonNegInt }),
      z.looseObject({ kind: z.literal('mutation'), score: z.number(), killed: nonNegInt }),
    ])
    .optional(),
});

export const NoteApprovalSchema = z.looseObject({
  claim: z.string().min(1),
  hash: z.string().regex(SHORT_HASH, 'first 16 hex characters of the claim hash'),
  method: z.literal('pr'),
  by: z.string().min(1),
  pr: nonNegInt,
  reviewId: nonNegInt,
  reviewedAt: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
});

export const NoteCountersignSchema = z.looseObject({
  entry: z.string().min(1),
  method: z.enum(['command', 'plan', 'as-built']),
  status: z.enum(['countersigned', 'self-approved', 'inherited']),
  by: z.string().optional(),
  pr: nonNegInt.optional(),
});

export const NoteStatementSummarySchema = z.looseObject({
  level: z.enum(CERT_LEVELS),
  counts: z.record(z.enum(CERT_LEVELS), nonNegInt),
  capabilities: z.array(
    z.looseObject({
      id: z.string().min(1),
      level: z.enum(CERT_LEVELS),
      enforce: z.enum(ENFORCE_LEVELS),
      pillars: z.record(z.enum(PILLARS as readonly [PillarName, ...PillarName[]]), z.enum(PILLAR_STATUSES)),
    }),
  ),
});

export const ProofNoteSchema: z.ZodType<ProofNote> = z.looseObject({
  schema: z.literal(NOTE_SCHEMA),
  version: z.literal(NOTE_VERSION),
  commit: z.string().min(1),
  tree: z.string().min(1),
  parents: z.array(z.string()),
  createdAt: z.string(),
  tool: z.looseObject({ specguard: z.string(), node: z.string(), hashVersion: nonNegInt }),
  ci: z.looseObject({
    provider: z.enum(['github', 'other']),
    event: z.string(),
    repo: z.string().optional(),
    ref: z.string().optional(),
    actor: z.string().optional(),
    runId: z.string().optional(),
    runAttempt: nonNegInt.optional(),
    runUrl: z.string().optional(),
    workflow: z.string().optional(),
    pr: nonNegInt.optional(),
  }),
  importedFrom: z.looseObject({ commit: z.string().min(1), reason: z.literal('tree-equal') }).optional(),
  carriedFrom: z.string().optional(),
  files: z.record(z.string(), z.string()),
  deps: z.string().optional(),
  rows: z.array(NoteRowSchema),
  approvals: z.array(NoteApprovalSchema),
  countersigns: z.array(NoteCountersignSchema),
  statement: NoteStatementSummarySchema,
  changes: z.array(
    z.looseObject({
      id: z.string().min(1),
      kind: z.enum(CHANGE_KINDS),
      verdict: z.enum(['pass', 'fail', 'spike']),
      claims: z.array(z.string()),
    }),
  ),
  packet: z.looseObject({ pr: nonNegInt.optional(), verdict: z.enum(PACKET_VERDICTS), sha256: z.string().min(1) }).optional(),
});

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Text -> note. `not-json` when it is not JSON; `wrong-schema` when `schema` is not `specguard.proof-note`;
 * `newer-version` when `version` is above NOTE_VERSION (the reader treats the note as absent and walks on);
 * `invalid` when it fails {@link ProofNoteSchema}. Unknown fields are kept.
 */
export function parseNote(_text: string): NoteParse {
  throw new Error('not implemented: parseNote');
}

/** Stable serialization: keys sorted, rows sorted by (claim, layer), 0 indent, trailing newline. Same input -> same bytes. */
export function serializeNote(_note: ProofNote): string {
  throw new Error('not implemented: serializeNote');
}

/** sha256 hex of the serialized note. */
export function noteDigest(_serialized: string): string {
  throw new Error('not implemented: noteDigest');
}

/** Ledger rows -> note rows + files table. Only rows fresh at `commit` are passed in (the caller filters). */
export function compactLedger(_ledger: ProofLedger, _opts: { commit: string; deps?: string }): Pick<ProofNote, 'files' | 'rows' | 'deps'> {
  throw new Error('not implemented: compactLedger');
}

/** Note -> ProofLedger with origin 'ci', repoSha = provedAt, fileHashes rehydrated, layers rebuilt via mergeLayerRecord. */
export function expandNote(_note: ProofNote): ProofLedger {
  throw new Error('not implemented: expandNote');
}

/** Enforce limits: within soft -> unchanged; over soft -> strip optional fields + warning; over hard -> { refused }. */
export function fitNote(_note: ProofNote): { note: ProofNote; serialized: string; warnings: string[] } | { refused: true; bytes: number } {
  throw new Error('not implemented: fitNote');
}

/** Same-commit re-run: per (claim, layer) the newer ingestedAt wins, failures from the same runId win; approvals union by (claim, hash, reviewId). */
export function mergeNotes(_existing: ProofNote, _incoming: ProofNote): ProofNote {
  throw new Error('not implemented: mergeNotes');
}
