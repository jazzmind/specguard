/**
 * Proof-ledger glue for remediate: ingest a test run into a ledger file, snapshot it,
 * and read the stale / re-proven state that the behavior verdict needs.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ClaimState } from '../../core/behavior-verdict.js';
import { dependencyFingerprint } from '../../core/dependency-fingerprint.js';
import { loadConfig } from '../../core/config.js';
import { effectiveVerdict, type ProofLedger } from '../../core/proof-ledger.js';
import { aggregateClaims, type TestCaseResult } from '../../core/test-results.js';
import { currentFileHashes, ingestVerdicts, ledgerPath, type VerdictFile } from '../proof.js';
import { specClaimRefs } from '../results.js';

/** Where the user's ledger lives: `--ledger`, `paths.proofLedger`, or the default. */
export async function resolveUserLedger(root: string, override?: string): Promise<string> {
  if (override) return path.isAbsolute(override) ? override : path.resolve(root, override);
  let configured: string | undefined;
  try {
    configured = (await loadConfig(root)).paths?.proofLedger;
  } catch {
    /* default */
  }
  return ledgerPath(root, configured);
}

/** Copy a ledger (when it exists) to `dest`, so a run starts from the same proofs. */
export function seedLedger(from: string, dest: string): boolean {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (!existsSync(from)) return false;
  copyFileSync(from, dest);
  return true;
}

export interface IngestOutcome {
  /** Claim states for the claims this run covered (tagged or unexercised spec claims). */
  claims: Record<string, ClaimState>;
  stored: string[];
  failed: string[];
}

/**
 * Ingest a run into `ledgerFile` the way `results ingest --unexercised` does: one verdict per
 * claim tag, plus `unexercised` for spec claims no test tagged. `cwd` is the (worktree) config root.
 */
export async function ingestRun(tests: TestCaseResult[], cwd: string, ledgerFile: string, runId: string): Promise<IngestOutcome> {
  const aggregates = aggregateClaims(tests);
  const verdicts: VerdictFile['verdicts'] = aggregates.map((a) => ({
    claim: a.claim,
    verdict: a.verdict,
    exercised: a.exercised,
    counterexamples: a.counterexamples,
  }));
  try {
    const config = await loadConfig(cwd);
    const tagged = new Set(aggregates.map((a) => a.claim));
    for (const ref of await specClaimRefs(config, cwd)) {
      if (!tagged.has(ref)) verdicts.push({ claim: ref, verdict: 'unexercised', exercised: 0, counterexamples: 0 });
    }
  } catch {
    /* no config: tagged claims only */
  }
  const res = await ingestVerdicts({ runId, verdicts }, cwd, { ledger: ledgerFile });
  const stored = res.items.filter((i) => i.status === 'updated').map((i) => i.key);
  const failed = res.items.filter((i) => i.status === 'failed').map((i) => i.key);
  const claims: Record<string, ClaimState> = {};
  for (const v of verdicts) if (stored.includes(v.claim)) claims[v.claim] = v.verdict;
  return { claims, stored, failed };
}

export function readLedgerFile(file: string): ProofLedger | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ProofLedger;
  } catch {
    return undefined;
  }
}

/** Claims of `ledger` that read `stale` against the fingerprint of `cwd` as it is now. */
export function staleClaims(ledger: ProofLedger, cwd: string, claims: string[]): string[] {
  const fp = dependencyFingerprint(cwd);
  const out: string[] = [];
  for (const claim of claims) {
    const rec = ledger.proofs[claim];
    if (!rec) continue;
    const v = effectiveVerdict(rec, { specHash: rec.specHash, fileHashes: currentFileHashes(cwd, rec.fileHashes), dependencyFingerprint: fp });
    if (v === 'stale') out.push(claim);
  }
  return out;
}

/** Claims proven in `ledger` with the dependency fingerprint of `cwd` as it is now. */
export function reprovenClaims(ledger: ProofLedger, cwd: string, claims: string[]): string[] {
  const fp = dependencyFingerprint(cwd);
  return claims.filter((c) => {
    const rec = ledger.proofs[c];
    return rec && rec.verdict === 'proven' && rec.dependencyFingerprint !== undefined && rec.dependencyFingerprint === fp;
  });
}
