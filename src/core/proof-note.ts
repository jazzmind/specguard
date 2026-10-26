/**
 * The proof note: one JSON document per proven commit, kept in git notes (`refs/notes/specguard`) by CI. It is
 * cumulative: it holds every ledger row that is fresh at its commit, so a reader needs only the nearest noted
 * ancestor. Rows share one file-hash table to stay small. Pure: this module parses, serializes and converts; the git
 * plumbing lives in `proof-store.ts`.
 *
 * Spec: specs/capabilities/proof-store.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod/v4';

import { CHANGE_KINDS, type ChangeKind } from './change-record.js';
import { PACKET_VERDICTS, type PacketVerdict } from './proof-packet.js';
import { layersOf, mergeLayerRecord, type ProofEvidence, type ProofLedger, type ProofRecord, type StoredVerdict } from './proof-ledger.js';
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

/** Code-unit order, so the result does not depend on the locale. */
const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value with object keys sorted at every depth and `undefined` members dropped. Arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(cmp)) {
    const v = value[key];
    if (v !== undefined) out[key] = canonical(v);
  }
  return out;
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value));

const rowOrder = (a: NoteRow, b: NoteRow): number => cmp(a.claim, b.claim) || cmp(a.layer, b.layer);

/**
 * Text -> note. `not-json` when it is not JSON; `wrong-schema` when `schema` is not `specguard.proof-note`;
 * `newer-version` when `version` is above NOTE_VERSION (the reader treats the note as absent and walks on);
 * `invalid` when it fails {@link ProofNoteSchema}. Unknown fields are kept.
 */
export function parseNote(text: string): NoteParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'not-json', detail: (err as Error).message };
  }
  if (!isObject(raw) || raw.schema !== NOTE_SCHEMA) {
    const found = isObject(raw) && typeof raw.schema === 'string' ? `schema "${raw.schema}"` : 'no schema field';
    return { ok: false, reason: 'wrong-schema', detail: `expected schema "${NOTE_SCHEMA}", found ${found}` };
  }
  // The version is read before the shape: a newer note may have a shape this reader cannot validate.
  if (typeof raw.version === 'number' && raw.version > NOTE_VERSION) {
    return { ok: false, reason: 'newer-version', detail: `note version ${raw.version} is newer than the ${NOTE_VERSION} this SpecGuard reads` };
  }
  const result = ProofNoteSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: 'invalid', detail };
  }
  return { ok: true, note: result.data };
}

/** Stable serialization: keys sorted, rows sorted by (claim, layer), 0 indent, trailing newline. Same input -> same bytes. */
export function serializeNote(note: ProofNote): string {
  const rows = Array.isArray(note.rows) ? [...note.rows].sort(rowOrder) : note.rows;
  return `${canonicalJson({ ...note, rows })}\n`;
}

/** sha256 hex of the serialized note. */
export function noteDigest(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/** Ledger rows -> note rows + files table. Only rows fresh at `commit` are passed in (the caller filters). */
export function compactLedger(ledger: ProofLedger, opts: { commit: string; deps?: string }): Pick<ProofNote, 'files' | 'rows' | 'deps'> {
  const files: Record<string, string> = {};
  const rows: NoteRow[] = [];
  for (const key of Object.keys(ledger.proofs).sort(cmp)) {
    const record = ledger.proofs[key];
    const layers = layersOf(record);
    for (const layer of (Object.keys(layers) as EvidenceLayer[]).sort(cmp)) {
      const proof = layers[layer];
      if (!proof) continue;
      const paths = Object.keys(proof.fileHashes ?? {}).sort(cmp);
      // Rows are fresh at one commit, so a path has one hash; if two rows disagree the first in order keeps the slot.
      for (const path of paths) if (files[path] === undefined) files[path] = proof.fileHashes[path];
      rows.push({
        claim: record.claim ?? key,
        layer,
        verdict: proof.verdict,
        runId: proof.runId,
        specHash: proof.specHash,
        ...(proof.claimHash !== undefined && { claimHash: proof.claimHash }),
        hashVersion: proof.hashVersion ?? 1,
        files: paths,
        exercised: proof.exercised,
        counterexamples: proof.counterexamples,
        ...(proof.evidence !== undefined && { evidence: proof.evidence }),
        provedAt: proof.repoSha ?? opts.commit,
        ingestedAt: proof.ingestedAt,
      });
    }
  }
  rows.sort(rowOrder);
  return { files: canonical(files) as Record<string, string>, rows, ...(opts.deps !== undefined && { deps: opts.deps }) };
}

/** Note -> ProofLedger with origin 'ci', repoSha = provedAt, fileHashes rehydrated, layers rebuilt via mergeLayerRecord. */
export function expandNote(note: ProofNote): ProofLedger {
  const proofs: Record<string, ProofRecord> = {};
  for (const row of [...note.rows].sort(rowOrder)) {
    const fileHashes: Record<string, string> = {};
    for (const path of row.files) {
      const hash = note.files[path];
      if (hash !== undefined) fileHashes[path] = hash;
    }
    const record: ProofRecord = {
      claim: row.claim,
      verdict: row.verdict,
      runId: row.runId,
      specHash: row.specHash,
      ...(row.claimHash !== undefined && { claimHash: row.claimHash }),
      repoSha: row.provedAt,
      fileHashes,
      ...(note.deps !== undefined && { dependencyFingerprint: note.deps }),
      exercised: row.exercised,
      counterexamples: row.counterexamples,
      ...(row.evidence !== undefined && { evidence: row.evidence }),
      origin: 'ci',
      ...(note.ci.repo !== undefined && { repo: note.ci.repo }),
      ...(note.ci.ref !== undefined && { branch: note.ci.ref }),
      ...(note.ci.actor !== undefined && { actor: note.ci.actor }),
      hashVersion: row.hashVersion,
      ingestedAt: row.ingestedAt,
    };
    proofs[row.claim] = mergeLayerRecord(proofs[row.claim], record, row.layer);
  }
  return { version: 1, proofs };
}

const NOTE_ROW_KEYS: ReadonlySet<string> = new Set(Object.keys(NoteRowSchema.shape));

/**
 * Enforce limits: within soft -> unchanged; over soft -> strip optional fields + warning; over hard -> { refused }.
 * Stripping goes in two steps and stops as soon as the note is within the soft limit: first the row fields this
 * version does not define (an evidence path, runner details), then the `exercised` and `counterexamples` counts
 * (set to 0, since the schema requires them). The hard limit applies to the stripped note, which is what would be written.
 */
export function fitNote(note: ProofNote): { note: ProofNote; serialized: string; warnings: string[] } | { refused: true; bytes: number } {
  let serialized = serializeNote(note);
  let bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= NOTE_SOFT_LIMIT) return { note, serialized, warnings: [] };

  const original = bytes;
  const dropped: string[] = [];
  let fitted: ProofNote = note;
  const restrip = (strip: (row: NoteRow) => NoteRow, what: string): void => {
    fitted = { ...fitted, rows: fitted.rows.map(strip) };
    serialized = serializeNote(fitted);
    bytes = Buffer.byteLength(serialized, 'utf8');
    dropped.push(what);
  };
  restrip((row) => Object.fromEntries(Object.entries(row).filter(([k]) => NOTE_ROW_KEYS.has(k))) as unknown as NoteRow, 'evidence paths and runner details');
  if (bytes > NOTE_SOFT_LIMIT) restrip((row) => ({ ...row, exercised: 0, counterexamples: 0 }), 'exercised and counterexample counts');

  if (bytes > NOTE_HARD_LIMIT) return { refused: true, bytes };
  const warnings = [`proof note is ${original} bytes, over the ${NOTE_SOFT_LIMIT} byte soft limit; dropped ${dropped.join(' and ')} (now ${bytes} bytes)`];
  if (bytes > NOTE_SOFT_LIMIT) warnings.push(`proof note is still over the ${NOTE_SOFT_LIMIT} byte soft limit after trimming`);
  return { note: fitted, serialized, warnings };
}

const isFailure = (v: StoredVerdict): boolean => v === 'failed' || v === 'error';

/** The row that stands for a (claim, layer) when two runs of one commit both have evidence. Symmetric in its arguments. */
function chooseRow(a: NoteRow, b: NoteRow): NoteRow {
  if (a.runId === b.runId && isFailure(a.verdict) !== isFailure(b.verdict)) return isFailure(a.verdict) ? a : b;
  if (a.ingestedAt !== b.ingestedAt) return a.ingestedAt > b.ingestedAt ? a : b;
  // Same instant: a failure, then the later run id, then the serialization, so the pick never depends on argument order.
  if (isFailure(a.verdict) !== isFailure(b.verdict)) return isFailure(a.verdict) ? a : b;
  if (a.runId !== b.runId) return a.runId > b.runId ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

/**
 * Same-commit re-run: per (claim, layer) the newer ingestedAt wins, failures from the same runId win; approvals union by (claim, hash, reviewId).
 * Note-level fields (tool, ci, statement, packet, createdAt) come from the note created later; countersigns and changes
 * are unions by `entry` and `id` that prefer that note. The result does not depend on which note is `existing`.
 * The caller refreshes the statement summary when the merged rows change it.
 */
export function mergeNotes(existing: ProofNote, incoming: ProofNote): ProofNote {
  const newer = existing.createdAt !== incoming.createdAt ? (existing.createdAt > incoming.createdAt ? existing : incoming) : serializeNote(existing) >= serializeNote(incoming) ? existing : incoming;
  const older = newer === existing ? incoming : existing;

  // Each chosen row keeps the hashes of the note it came from.
  const chosen = new Map<string, { row: NoteRow; note: ProofNote }>();
  for (const source of [older, newer]) {
    for (const row of source.rows) {
      const key = `${row.claim}\u0000${row.layer}`;
      const held = chosen.get(key);
      chosen.set(key, !held || chooseRow(held.row, row) === row ? { row, note: source } : held);
    }
  }
  const rows: NoteRow[] = [];
  const files: Record<string, string> = {};
  for (const { row, note } of chosen.values()) {
    rows.push(structuredClone(row));
    for (const path of row.files) {
      const hash = note.files[path];
      if (hash !== undefined && files[path] === undefined) files[path] = hash;
    }
  }
  rows.sort(rowOrder);

  const union = <T>(key: (item: T) => string, a: T[], b: T[]): T[] => {
    const seen = new Map<string, T>();
    for (const item of [...a, ...b]) if (!seen.has(key(item))) seen.set(key(item), structuredClone(item));
    return [...seen.entries()].sort(([x], [y]) => cmp(x, y)).map(([, item]) => item);
  };
  // `newer` first so its entry survives a duplicate.
  const approvals = union((x: NoteApproval) => `${x.claim}\u0000${x.hash}\u0000${x.reviewId}`, newer.approvals, older.approvals);
  const countersigns = union((x: NoteCountersign) => x.entry, newer.countersigns, older.countersigns);
  const changes = union((x: ProofNote['changes'][number]) => x.id, newer.changes, older.changes);

  const merged: ProofNote = structuredClone({ ...newer, rows: [], approvals: [], countersigns: [], changes: [], files: {} });
  merged.rows = rows;
  merged.files = canonical(files) as Record<string, string>;
  merged.approvals = approvals;
  merged.countersigns = countersigns;
  merged.changes = changes;
  const deps = newer.deps ?? older.deps;
  if (deps !== undefined) merged.deps = deps;
  return merged;
}
