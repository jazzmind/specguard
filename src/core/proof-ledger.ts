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

export type StoredVerdict = 'proven' | 'failed' | 'unexercised' | 'error';

export type EffectiveVerdict = StoredVerdict | 'stale' | 'unproven';

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
  /** What produced the verdict. Absent means a test run. */
  evidence?: 'test' | 'agentic';
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
