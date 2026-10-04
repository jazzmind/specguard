/**
 * Proof ledger pipeline.
 *
 * `ingest` merges a verdicts file into `.specguard/proofs.json` on the
 * workspace root when a workspace is present, otherwise on the repo root.
 * Each row records the spec hash and the drift-registry file hashes at ingest
 * time. `stale` is computed later by comparing those hashes; it is not stored.
 *
 * Spec: specs/pipelines/proof.md
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { z } from 'zod';

import { loadConfig } from '../core/config.js';
import { formatClaimRef, parseClaimRef } from '../core/claims.js';
import { hashString, loadRegistry } from '../core/drift-registry.js';
import { ExitCode } from '../core/exit-codes.js';
import {
  effectiveVerdict,
  emptyLedger,
  type ProofLedger,
  type ProofRecord,
} from '../core/proof-ledger.js';
import { fileExists, readFile } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { loadWorkspaceWithConfigs } from '../core/workspace.js';
import { writeFile } from '../core/writer.js';

const VerdictFileSchema = z.object({
  runId: z.string().min(1),
  repoShas: z.record(z.string(), z.string()).optional(),
  verdicts: z.array(
    z.object({
      claim: z.string().min(1),
      verdict: z.enum(['proven', 'failed', 'unexercised']),
      exercised: z.number().int().nonnegative().optional(),
      counterexamples: z.number().int().nonnegative().optional(),
      evidencePath: z.string().optional(),
    }),
  ),
});

export type VerdictFile = z.infer<typeof VerdictFileSchema>;

export function ledgerPath(rootDir: string): string {
  return path.join(rootDir, '.specguard', 'proofs.json');
}

async function ledgerRoot(cwd: string): Promise<string> {
  try {
    const { manifest } = await loadWorkspaceWithConfigs(cwd);
    return manifest.rootDir;
  } catch {
    return cwd;
  }
}

function gitHead(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function fileHashesFor(repoDir: string, specKey: string): Record<string, string> {
  const registry = loadRegistry(repoDir);
  const hashes: Record<string, string> = {};
  for (const entry of Object.values(registry)) {
    const feature = entry.specKey.includes('/')
      ? entry.specKey.split('/').slice(1).join('/')
      : entry.specKey;
    if (feature !== specKey && entry.specKey !== specKey) continue;
    for (const [file, meta] of Object.entries(entry.files)) {
      hashes[file] = meta.hash;
    }
  }
  return hashes;
}

async function repoKeyFor(cwd: string): Promise<string | undefined> {
  try {
    const { repos } = await loadWorkspaceWithConfigs(cwd);
    const match = repos.find((repo) => path.resolve(repo.absPath) === path.resolve(cwd));
    return match?.key;
  } catch {
    return undefined;
  }
}

interface LocatedSpec {
  abs: string;
  repoDir: string;
  content: string;
}

async function locateSpec(cwd: string, claim: string): Promise<LocatedSpec | null> {
  const ref = parseClaimRef(claim);
  if (!ref) return null;

  if (ref.repo) {
    try {
      const { repos } = await loadWorkspaceWithConfigs(cwd);
      const repo = repos.find((row) => row.key === ref.repo);
      if (!repo) return null;
      const top = path.join(repo.absPath, 'specs', `${ref.specKey}.md`);
      if (await fileExists(top)) {
        return { abs: top, repoDir: repo.absPath, content: await readFile(top) };
      }
      if (repo.specGuardConfig) {
        for (const app of repo.specGuardConfig.apps) {
          const abs = path.resolve(repo.absPath, app.specDir, `${ref.specKey}.md`);
          if (await fileExists(abs)) {
            return { abs, repoDir: repo.absPath, content: await readFile(abs) };
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  let config: SpecGuardConfig;
  try {
    config = await loadConfig(cwd);
  } catch {
    return null;
  }
  const root = config.rootDir ?? cwd;
  const top = path.join(root, 'specs', `${ref.specKey}.md`);
  if (await fileExists(top)) {
    return { abs: top, repoDir: root, content: await readFile(top) };
  }
  for (const app of config.apps) {
    const abs = path.resolve(root, app.specDir, `${ref.specKey}.md`);
    if (await fileExists(abs)) {
      return { abs, repoDir: root, content: await readFile(abs) };
    }
  }
  return null;
}

async function readLedger(file: string): Promise<ProofLedger> {
  if (!(await fileExists(file))) return emptyLedger();
  const parsed = JSON.parse(await readFile(file)) as ProofLedger;
  if (!parsed || parsed.version !== 1 || !parsed.proofs) return emptyLedger();
  return parsed;
}

export async function runProofIngest(verdictsPath: string, cwd: string): Promise<PipelineResult> {
  const result = emptyResult('proof-ingest');
  const absVerdicts = path.resolve(cwd, verdictsPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absVerdicts));
  } catch (err) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push(`Cannot read verdicts: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  const parsed = VerdictFileSchema.safeParse(raw);
  if (!parsed.success) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(`Verdicts file is not valid: ${parsed.error.message}`);
    return result;
  }

  const root = await ledgerRoot(cwd);
  const file = ledgerPath(root);
  const ledger = await readLedger(file);
  const body = parsed.data;

  for (const row of body.verdicts) {
    if (!parseClaimRef(row.claim)) {
      result.failed += 1;
      result.items.push({ key: row.claim, status: 'failed', message: 'claim ref is not repo:spec#id' });
      result.messages.push(`${row.claim}: malformed claim ref`);
      continue;
    }
    const located = await locateSpec(cwd, row.claim);
    if (!located) {
      result.failed += 1;
      result.items.push({ key: row.claim, status: 'failed', message: 'spec for claim was not found' });
      result.messages.push(`${row.claim}: spec not found`);
      continue;
    }
    const ref = parseClaimRef(row.claim);
    const repoSha = (ref?.repo && body.repoShas?.[ref.repo]) || gitHead(located.repoDir);
    const record: ProofRecord = {
      claim: row.claim,
      verdict: row.verdict,
      runId: body.runId,
      specHash: hashString(located.content),
      repoSha,
      fileHashes: fileHashesFor(located.repoDir, ref?.specKey ?? ''),
      exercised: row.exercised ?? 0,
      counterexamples: row.counterexamples ?? 0,
      evidencePath: row.evidencePath,
      ingestedAt: new Date().toISOString(),
    };
    ledger.proofs[row.claim] = record;
    result.updated += 1;
    result.items.push({ key: row.claim, status: 'updated', message: row.verdict });
    result.messages.push(`${row.claim}: ${row.verdict}`);
  }

  await writeFile(file, JSON.stringify(ledger, null, 2) + '\n');
  result.exitCode = result.failed > 0 ? ExitCode.ValidationFailed : ExitCode.Success;
  result.messages.push(`proof ingest: ${result.updated} stored, ${result.failed} failed, ledger ${file}`);
  return result;
}

interface CoverageCounts {
  proven: number;
  failed: number;
  unexercised: number;
  stale: number;
  unproven: number;
}

async function walkClaims(
  config: SpecGuardConfig,
  cwd: string,
  onVerdict: (ref: string, verdict: ReturnType<typeof effectiveVerdict>) => void,
): Promise<CoverageCounts | null> {
  const root = await ledgerRoot(cwd);
  const file = ledgerPath(root);
  if (!(await fileExists(file))) return null;
  const ledger = await readLedger(file);
  const repoKey = await repoKeyFor(cwd);
  const counts: CoverageCounts = { proven: 0, failed: 0, unexercised: 0, stale: 0, unproven: 0 };
  const top = path.join(cwd, 'specs');
  const specDirs = (await fileExists(top))
    ? [top]
    : config.apps.map((app) => path.resolve(cwd, app.specDir));

  for (const specDir of specDirs) {
    let specs;
    try {
      specs = loadAllSpecs(specDir);
    } catch {
      continue;
    }
    for (const spec of specs) {
      const specFile = path.join(specDir, `${spec.specKey}.md`);
      if (!(await fileExists(specFile))) continue;
      const current = {
        specHash: hashString(await readFile(specFile)),
        fileHashes: fileHashesFor(cwd, spec.specKey),
      };
      for (const claim of spec.claims) {
        if (!claim.id) {
          counts.unproven += 1;
          continue;
        }
        const ref = formatClaimRef(repoKey, spec.specKey, claim.id);
        const record = ledger.proofs[ref] ?? ledger.proofs[formatClaimRef(undefined, spec.specKey, claim.id)];
        const verdict = effectiveVerdict(record, current);
        counts[verdict] += 1;
        onVerdict(ref, verdict);
      }
    }
  }
  return counts;
}

/** Informational proof lines for `specguard status`. Does not change the exit code. */
export async function appendProofCoverage(
  config: SpecGuardConfig,
  log: (line: string) => void,
): Promise<void> {
  const cwd = config.rootDir ?? process.cwd();
  const counts = await walkClaims(config, cwd, (ref, verdict) => {
    if (verdict === 'proven' || verdict === 'unproven') return;
    log(`  [proof-${verdict}] ${ref}`);
  });
  if (!counts) {
    log('PROOFS: no ledger');
    return;
  }
  log(
    `PROOFS: ${counts.proven} proven, ${counts.failed} failed, ` +
      `${counts.unexercised} unexercised, ${counts.stale} stale, ${counts.unproven} unproven`,
  );
}

/**
 * Drift hook. A proof whose spec hash or recorded source-file hash no longer
 * matches is a failed drift item. Verdicts of failed or unexercised are left
 * to status; they are not source drift.
 */
export async function noteStaleProofs(
  config: SpecGuardConfig,
  cwd: string,
  log: (line: string) => void,
  result: PipelineResult,
): Promise<void> {
  const counts = await walkClaims(config, cwd, (ref, verdict) => {
    if (verdict !== 'stale') return;
    log(`[proof-stale] ${ref}`);
    result.items.push({
      key: ref,
      status: 'failed',
      message: `proof stale: ${ref}`,
    });
    result.failed += 1;
  });
  if (counts && counts.stale > 0) {
    log(`[drift] ${counts.stale} stale proof(s)`);
  }
}
