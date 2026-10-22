/**
 * Proof-ledger glue for remediate: ingest a test run into a ledger file, snapshot it,
 * and read the stale / re-proven state that the behavior verdict needs.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ClaimState } from '../../core/behavior-verdict.js';
import { dependencyFingerprint } from '../../core/dependency-fingerprint.js';
import { loadConfig } from '../../core/config.js';
import { effectiveVerdict, layersOf, type ProofLedger } from '../../core/proof-ledger.js';
import type { EvidenceLayer } from '../../core/test-layers.js';
import type { TestCaseResult } from '../../core/test-results.js';
import { currentFileHashes, ingestVerdicts, ledgerPath } from '../proof.js';
import { layeredVerdicts, specClaimRefs } from '../results.js';

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
  // Same layering as `results ingest`, so a remediation run records unit and e2e evidence where a normal run does.
  const { aggregates, verdicts } = await layeredVerdicts(tests, cwd);
  try {
    const config = await loadConfig(cwd);
    const tagged = new Set(aggregates.map((a) => a.claim));
    // A claim some layer already proved, in the ledger this run starts from, keeps that evidence: a test command that
    // does not reach a browser must not erase what the browser proved.
    const existing = readLedgerFile(ledgerFile);
    for (const ref of await specClaimRefs(config, cwd)) {
      if (tagged.has(ref)) continue;
      const row = existing?.proofs[ref];
      if (row && Object.values(layersOf(row)).some((l) => l?.verdict === 'proven')) continue;
      verdicts.push({ claim: ref, verdict: 'unexercised', exercised: 0, counterexamples: 0 });
    }
  } catch {
    /* no config: tagged claims only */
  }
  const res = await ingestVerdicts({ runId, verdicts }, cwd, { ledger: ledgerFile });
  const stored = res.items.filter((i) => i.status === 'updated').map((i) => i.key);
  const failed = res.items.filter((i) => i.status === 'failed').map((i) => i.key);
  const claims: Record<string, ClaimState> = {};
  // A claim's state is the worst of its layers' results in this run: one failing layer fails it.
  const rank: Record<string, number> = { failed: 3, error: 3, unexercised: 2, proven: 1 };
  for (const v of verdicts) {
    if (!stored.includes(v.claim)) continue;
    const prev = claims[v.claim];
    if (!prev || (rank[v.verdict] ?? 0) > (rank[prev] ?? 0)) claims[v.claim] = v.verdict;
  }
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

/** For each claim, the layers whose evidence reads `proven` against `fingerprint` and the files in `cwd`. Spec edits are ignored: a dependency fix does not touch specs. */
export function provenLayers(ledger: ProofLedger, cwd: string, fingerprint: string | undefined): Map<string, Set<EvidenceLayer>> {
  const out = new Map<string, Set<EvidenceLayer>>();
  for (const [claim, rec] of Object.entries(ledger.proofs)) {
    for (const [layer, proof] of Object.entries(layersOf(rec)) as Array<[EvidenceLayer, NonNullable<ReturnType<typeof layersOf>[EvidenceLayer]>]>) {
      const v = effectiveVerdict({ claim, ...proof }, { specHash: proof.specHash, claimHash: proof.claimHash, fileHashes: currentFileHashes(cwd, proof.fileHashes), dependencyFingerprint: fingerprint });
      if (v === 'proven') (out.get(claim) ?? out.set(claim, new Set()).get(claim)!).add(layer);
    }
  }
  return out;
}

/** Claims whose evidence in some layer was proven before the change and is not proven after it. */
export function layersNotReproven(before: Map<string, Set<EvidenceLayer>>, after: Map<string, Set<EvidenceLayer>>): Array<{ claim: string; layers: EvidenceLayer[] }> {
  const lost: Array<{ claim: string; layers: EvidenceLayer[] }> = [];
  for (const [claim, layers] of before) {
    const missing = [...layers].filter((l) => !after.get(claim)?.has(l));
    if (missing.length > 0) lost.push({ claim, layers: missing });
  }
  return lost.sort((a, b) => a.claim.localeCompare(b.claim));
}
