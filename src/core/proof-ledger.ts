/**
 * Proof ledger types and the pure staleness rule.
 *
 * A stored verdict is `proven`, `failed`, `unexercised`, or `error`. `stale` is not
 * stored: it is computed when the spec hash (or, for v2 specs, the claim hash), or a drift-registry file hash
 * recorded at ingest, or the dependency fingerprint, no longer matches. `unproven` means the ledger has no
 * row for that claim.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */

import type { EvidenceLayer, TestLayer } from './test-layers.js';

export type StoredVerdict = 'proven' | 'failed' | 'unexercised' | 'error';

export type EffectiveVerdict = StoredVerdict | 'stale' | 'unproven';

/** What produced a verdict: a test run, the agentic browser run, or a person. */
export type ProofEvidence = 'test' | 'agentic' | 'manual';

/** True for evidence that is not an automated test run. Such evidence can only prove the `functional` layer. */
export function isNonAutomatedEvidence(evidence: ProofEvidence | undefined): boolean {
  return evidence === 'agentic' || evidence === 'manual';
}

export interface ProofRecord {
  claim: string;
  verdict: StoredVerdict;
  runId: string;
  /** SHA-256 of the spec file at ingest. */
  specHash: string;
  /**
   * v2 specs only: hash of this claim's text and the spec's Problem & Value
   * (`claimHashOf`). When present on both sides it replaces `specHash` in the
   * staleness rule, so editing another claim, a scenario, or the frontmatter
   * does not stale this proof.
   */
  claimHash?: string;
  /** Git HEAD of the owning repo at ingest. Recorded, not used for staleness. */
  repoSha?: string;
  /** Drift-registry file hashes captured at ingest, keyed by repo-relative POSIX path. */
  fileHashes: Record<string, string>;
  /** Hash of the repo's lockfiles/manifests at ingest. Absent on older rows and repos without any. */
  dependencyFingerprint?: string;
  exercised: number;
  counterexamples: number;
  evidencePath?: string;
  /** What produced the verdict. Absent means a test run. `agentic` and `manual` evidence can only prove the `functional` layer. */
  evidence?: ProofEvidence;
  /**
   * Where the proof was earned: `ci` (a pushed commit), `local` (a working tree) or `server` (a server-side run).
   * Absent on rows written before provenance was recorded, which are treated as `local`.
   */
  origin?: 'local' | 'ci' | 'server';
  /** `owner/name` of the repository, when known. */
  repo?: string;
  branch?: string;
  /** Who or what started the run (a CI actor). */
  actor?: string;
  /** `HASH_VERSION` in force when `claimHash` was computed. Absent means 1. */
  hashVersion?: number;
  ingestedAt: string;
  /**
   * Evidence per test layer. The fields above are the combined result across them (a failure in any layer
   * decides it; else the newest proof). Absent on rows written before layers existed, which are read as a
   * single layer by `layersOf`.
   */
  layers?: Partial<Record<EvidenceLayer, LayerProof>>;
}

/** One layer's evidence for a claim, with its own staleness inputs. */
export interface LayerProof {
  verdict: StoredVerdict;
  runId: string;
  specHash: string;
  claimHash?: string;
  hashVersion?: number;
  repoSha?: string;
  fileHashes: Record<string, string>;
  dependencyFingerprint?: string;
  exercised: number;
  counterexamples: number;
  evidencePath?: string;
  /** What produced it, as on the row. */
  evidence?: ProofEvidence;
  origin?: 'local' | 'ci' | 'server';
  repo?: string;
  branch?: string;
  actor?: string;
  ingestedAt: string;
}

export interface ProofLedger {
  version: 1;
  proofs: Record<string, ProofRecord>;
}

export function emptyLedger(): ProofLedger {
  return { version: 1, proofs: {} };
}

/** How a changed file bears on a claim; supplied for v2 specs from the drift assessments. */
export type FileChangeVerdict = 'affects' | 'unaffected' | 'unassessed';

export interface CurrentClaimState {
  specHash: string;
  /** Current `claimHashOf` for a v2 spec; leave unset for v1 specs. */
  claimHash?: string;
  fileHashes: Record<string, string>;
  dependencyFingerprint?: string;
  /**
   * v2 specs: how a changed file bears on this claim. When set (with claim
   * hashes on both sides), a changed file only stales the proof if the answer
   * is `affects` or `unassessed`. Absent, any changed file stales it.
   */
  fileChange?: (file: string, nowHash: string, since?: string) => FileChangeVerdict;
}

/**
 * Compare a stored proof with the spec and source hashes as they are now.
 * A file that has disappeared from the registry does not by itself make the
 * proof stale. A file whose hash changed does.
 */
export function effectiveVerdict(
  record: ProofRecord | undefined,
  current: CurrentClaimState,
): EffectiveVerdict {
  if (!record) return 'unproven';
  if (record.claimHash !== undefined && current.claimHash !== undefined) {
    if (record.claimHash !== current.claimHash) return 'stale';
  } else if (record.specHash !== current.specHash) {
    return 'stale';
  }
  if (
    record.dependencyFingerprint !== undefined &&
    current.dependencyFingerprint !== undefined &&
    record.dependencyFingerprint !== current.dependencyFingerprint
  ) {
    return 'stale';
  }
  const claimScoped = record.claimHash !== undefined && current.claimHash !== undefined && current.fileChange !== undefined;
  for (const [file, hash] of Object.entries(record.fileHashes)) {
    const now = current.fileHashes[file];
    if (now === undefined || now === hash) continue;
    if (claimScoped && current.fileChange!(file, now, record.ingestedAt) === 'unaffected') continue;
    return 'stale';
  }
  return record.verdict;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const LAYER_FIELDS = [
  'verdict', 'runId', 'specHash', 'claimHash', 'hashVersion', 'repoSha', 'fileHashes', 'dependencyFingerprint',
  'exercised', 'counterexamples', 'evidencePath', 'evidence', 'origin', 'repo', 'branch', 'actor', 'ingestedAt',
] as const;

/** The layer part of a row. */
export function layerProofOf(record: ProofRecord): LayerProof {
  const out: Record<string, unknown> = {};
  for (const k of LAYER_FIELDS) if (record[k] !== undefined) out[k] = record[k];
  return out as unknown as LayerProof;
}

/**
 * The evidence a row holds, by layer. A row written before layers existed is one layer: `functional` when the
 * browser check produced it, else `unclassified`.
 */
export function layersOf(record: ProofRecord): Partial<Record<EvidenceLayer, LayerProof>> {
  if (record.layers && Object.keys(record.layers).length > 0) return record.layers;
  return { [isNonAutomatedEvidence(record.evidence) ? 'functional' : 'unclassified']: layerProofOf(record) };
}

/** Which of a claim's layers decides the combined row: a failure or error first (newest), else the newest proof, else the newest. */
function decisiveLayer(layers: Partial<Record<EvidenceLayer, LayerProof>>): LayerProof {
  const all = Object.values(layers) as LayerProof[];
  const newest = (rows: LayerProof[]): LayerProof => rows.reduce((a, b) => (b.ingestedAt > a.ingestedAt ? b : a));
  const bad = all.filter((l) => l.verdict === 'failed' || l.verdict === 'error');
  if (bad.length > 0) return newest(bad);
  const proven = all.filter((l) => l.verdict === 'proven');
  if (proven.length > 0) return newest(proven);
  return newest(all);
}

/**
 * Record `next` as the evidence of `layer` on a claim's row. The other layers' evidence is kept, and the
 * combined fields of the row are recomputed from the layer that decides it, so a failing browser check is not
 * overwritten by the next passing unit test (or the other way round).
 */
export function mergeLayerRecord(previous: ProofRecord | undefined, next: ProofRecord, layer: EvidenceLayer): ProofRecord {
  const layers: Partial<Record<EvidenceLayer, LayerProof>> = { ...(previous ? layersOf(previous) : {}) };
  // Classified evidence supersedes unclassified evidence of the same tests; keeping both would let an old
  // failure outlive the fix.
  if (layer !== 'unclassified') delete layers.unclassified;
  layers[layer] = layerProofOf(next);
  const decisive = decisiveLayer(layers);
  return { claim: next.claim, ...decisive, layers };
}

export interface ClaimProof {
  /** The combined result: a failing layer fails the claim, a stale required layer stales it, else the strongest layer. */
  verdict: EffectiveVerdict;
  /** Effective verdict of each layer that has evidence. */
  layers: Partial<Record<EvidenceLayer, EffectiveVerdict>>;
  /** Required layers with no proven evidence (none, or stale). */
  missing: TestLayer[];
  /** Proven, with nothing missing. */
  complete: boolean;
}

/**
 * The effective proof of a claim across its layers. With no required layers this is exactly `effectiveVerdict`
 * of the combined row, so repos that do not use layers see no change.
 */
export function effectiveClaimProof(
  record: ProofRecord | undefined,
  current: CurrentClaimState | ((layer: EvidenceLayer, proof: LayerProof) => CurrentClaimState),
  required: readonly TestLayer[] = [],
): ClaimProof {
  if (!record) return { verdict: 'unproven', layers: {}, missing: [...required], complete: false };
  const stateFor = (layer: EvidenceLayer, proof: LayerProof): CurrentClaimState => (typeof current === 'function' ? current(layer, proof) : current);
  const layers: Partial<Record<EvidenceLayer, EffectiveVerdict>> = {};
  for (const [layer, proof] of Object.entries(layersOf(record)) as Array<[EvidenceLayer, LayerProof]>) {
    layers[layer] = effectiveVerdict({ claim: record.claim, ...proof }, stateFor(layer, proof));
  }
  const values = Object.values(layers) as EffectiveVerdict[];
  // Agentic or manual evidence recorded under an automated layer (an older or hand-edited ledger) never satisfies it.
  const recorded = layersOf(record);
  const missing = required.filter((l) => layers[l] !== 'proven' || (l !== 'functional' && isNonAutomatedEvidence(recorded[l]?.evidence)));

  let verdict: EffectiveVerdict;
  if (values.some((v) => v === 'failed' || v === 'error')) verdict = values.includes('failed') ? 'failed' : 'error';
  else if (required.some((l) => layers[l] === 'stale')) verdict = 'stale';
  else if (values.includes('proven')) verdict = 'proven';
  else if (values.includes('stale')) verdict = 'stale';
  else verdict = values.includes('unexercised') ? 'unexercised' : 'unproven';
  return { verdict, layers, missing, complete: verdict === 'proven' && missing.length === 0 };
}
