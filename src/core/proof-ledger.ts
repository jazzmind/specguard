/**
 * Proof ledger types and the pure staleness rule.
 *
 * A stored verdict is `proven`, `failed`, or `unexercised`. `stale` is not
 * stored: it is computed when the spec hash, or a drift-registry file hash
 * recorded at ingest, no longer matches. `unproven` means the ledger has no
 * row for that claim.
 *
 * Spec: specs/pipelines/proof.md
 */

export type StoredVerdict = 'proven' | 'failed' | 'unexercised';

export type EffectiveVerdict = StoredVerdict | 'stale' | 'unproven';

export interface ProofRecord {
  claim: string;
  verdict: StoredVerdict;
  runId: string;
  /** SHA-256 of the spec file at ingest. */
  specHash: string;
  /** Git HEAD of the owning repo at ingest. Recorded, not used for staleness. */
  repoSha?: string;
  /** Drift-registry file hashes captured at ingest, keyed by absolute path. */
  fileHashes: Record<string, string>;
  exercised: number;
  counterexamples: number;
  evidencePath?: string;
  ingestedAt: string;
}

export interface ProofLedger {
  version: 1;
  proofs: Record<string, ProofRecord>;
}

export function emptyLedger(): ProofLedger {
  return { version: 1, proofs: {} };
}

export interface CurrentClaimState {
  specHash: string;
  fileHashes: Record<string, string>;
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
  if (record.specHash !== current.specHash) return 'stale';
  for (const [file, hash] of Object.entries(record.fileHashes)) {
    const now = current.fileHashes[file];
    if (now !== undefined && now !== hash) return 'stale';
  }
  return record.verdict;
}
