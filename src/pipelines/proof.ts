/**
 * Proof ledger pipeline.
 *
 * `ingest` merges a verdicts file into `.specguard/proofs.json` on the
 * workspace root when a workspace is present, otherwise on the repo root.
 * Each row records the spec hash and the drift-registry file hashes at ingest
 * time. `stale` is computed later by comparing those hashes; it is not stored.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { isInside } from '../core/safe-path.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { loadConfig } from '../core/config.js';
import { formatClaimRef, parseClaimRef } from '../core/claims.js';
import { dependencyFingerprint } from '../core/dependency-fingerprint.js';
import { fromRegistryKey, hashFile, hashString, loadRegistry, saveRegistry, toRegistryKey } from '../core/drift-registry.js';
import { ExitCode } from '../core/exit-codes.js';
import { HASH_VERSION, claimHashOf } from '../core/claim-hash.js';
import { detectProvenance, type Provenance } from '../core/provenance.js';
import { fileLedgerStore, type LedgerStore } from '../core/state/ledger-store.js';
import { fileChangeResolver, loadAssessments } from '../core/drift-assessments.js';
import {
  effectiveClaimProof,
  effectiveVerdict,
  mergeLayerRecord,
  type ClaimProof,
  type ProofLedger,
  type ProofRecord,
} from '../core/proof-ledger.js';
import { requiredLayersFor, TEST_LAYERS, type EvidenceLayer, type TestLayer } from '../core/test-layers.js';
import { fileExists, readFile } from '../core/reader.js';
import { parseSpecContent } from '../core/spec-parser.js';
import {
  appForSpecFile,
  declaredSources,
  loadCanonicalSpecs,
  migrateRegistrySpecKeys,
  resolveDeclaredSources,
  specFileOf,
} from '../core/spec-key.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { loadWorkspace, loadWorkspaceWithConfigs } from '../core/workspace.js';
import { canonicalClaimRef } from '../core/workspace-units.js';

const VerdictFileSchema = z.object({
  runId: z.string().min(1),
  repoShas: z.record(z.string(), z.string()).optional(),
  verdicts: z.array(
    z.object({
      claim: z.string().min(1),
      verdict: z.enum(['proven', 'failed', 'unexercised', 'error']),
      exercised: z.number().int().nonnegative().optional(),
      counterexamples: z.number().int().nonnegative().optional(),
      evidencePath: z.string().optional(),
      /** What produced the verdict: a test run (default) or the agentic browser run. */
      evidence: z.enum(['test', 'agentic']).optional(),
      /** The test layer this evidence belongs to. Default: `functional` for the browser run, else unclassified. */
      layer: z.enum([...TEST_LAYERS, 'unclassified']).optional(),
    }),
  ),
});

export type VerdictFile = z.infer<typeof VerdictFileSchema>;

export interface ProofOpts {
  /** Ledger file. Overrides `paths.proofLedger`. Relative paths resolve from the cwd. */
  ledger?: string;
  /** Keep the ledger somewhere other than a file (a team server's database). Overrides `ledger`. */
  store?: LedgerStore;
  /** Where these proofs were earned. Default: detected from the environment (GitHub Actions, other CI, or local). */
  provenance?: Partial<Provenance>;
}

export function ledgerPath(rootDir: string, override?: string): string {
  if (override) return path.isAbsolute(override) ? override : path.resolve(rootDir, override);
  return path.join(rootDir, '.specguard', 'proofs.json');
}

async function resolveLedgerFile(cwd: string, opts: ProofOpts): Promise<{ root: string; file: string }> {
  const root = await ledgerRoot(cwd);
  if (opts.ledger) return { root, file: path.isAbsolute(opts.ledger) ? opts.ledger : path.resolve(cwd, opts.ledger) };
  let configured: string | undefined;
  try {
    configured = (await loadConfig(cwd)).paths?.proofLedger;
  } catch {
    /* no config: the default location applies */
  }
  return { root, file: ledgerPath(root, configured) };
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

/**
 * File hashes recorded for one spec. The registry key is `<app>/<specKey>`; the
 * match is exact on a known app name, so two apps with the same spec key do not
 * share hashes. Values are read from disk so they reflect the file now.
 */
export function fileHashesFor(
  repoDir: string,
  specKey: string,
  appNames?: string[],
): Record<string, string> {
  const registry = loadRegistry(repoDir);
  const hashes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(registry)) {
    // Canonical key first; legacy `<app>/<key>` entries are still read.
    const matches =
      key === specKey ||
      (appNames
        ? appNames.some((app) => key === `${app}/${specKey}`)
        : key.endsWith(`/${specKey}`));
    if (!matches) continue;
    for (const [file, meta] of Object.entries(entry.files)) {
      hashes[file] = hashFile(fromRegistryKey(repoDir, file)) ?? meta.hash;
    }
  }
  return hashes;
}

/**
 * Hashes of the files a spec declares in `sources:` (else `module:`), keyed by
 * root-relative POSIX path. Globs resolve relative to the owning app's repo,
 * with a one-time-warned root-relative fallback.
 */
export async function declaredFileHashes(
  config: SpecGuardConfig,
  specAbs: string,
  content: string,
  warn?: (msg: string) => void,
): Promise<Record<string, string>> {
  const spec = parseSpecContent(content, specAbs, path.dirname(specAbs));
  const patterns = declaredSources(spec);
  if (patterns.length === 0) return {};
  const files = await resolveDeclaredSources(config, appForSpecFile(config, specAbs), patterns, warn);
  const root = config.rootDir ?? process.cwd();
  const hashes: Record<string, string> = {};
  for (const abs of files) {
    const hash = hashFile(abs);
    if (hash) hashes[toRegistryKey(root, abs)] = hash;
  }
  return hashes;
}

/** Current on-disk hash for each recorded file. Files that no longer exist are omitted. */
export function currentFileHashes(repoDir: string, recorded: Record<string, string>): Record<string, string> {
  const now: Record<string, string> = {};
  for (const key of Object.keys(recorded)) {
    const hash = hashFile(fromRegistryKey(repoDir, key));
    if (hash) now[key] = hash;
  }
  return now;
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
  config?: SpecGuardConfig;
}

/** `claimHashOf` for a spec given as raw content; undefined for v1 specs and unparsable files. */
function claimHashInContent(content: string, file: string, claimId: string): string | undefined {
  try {
    return claimHashOf(parseSpecContent(content, file, path.dirname(file)), claimId);
  } catch {
    return undefined;
  }
}

/** The units of the workspace manifest at `cwd` itself, when there is one. */
async function workspaceUnits(cwd: string): Promise<Record<string, { kind: string }> | undefined> {
  if (!existsSync(path.join(cwd, '.specguard', 'workspace.json'))) return undefined;
  try {
    const m = await loadWorkspace(cwd);
    return path.resolve(m.rootDir) === path.resolve(cwd) ? m.units : undefined;
  } catch {
    return undefined;
  }
}

async function locateSpec(cwd: string, claim: string): Promise<LocatedSpec | null> {
  const ref = parseClaimRef(claim);
  if (!ref) return null;

  if (ref.repo) {
    try {
      const { repos } = await loadWorkspaceWithConfigs(cwd);
      const repo = repos.find((row) => row.key === ref.repo);
      if (!repo) return null;
      const top = path.join(path.resolve(repo.absPath, repo.specGuardConfig?.paths?.specsRoot ?? 'specs'), `${ref.specKey}.md`);
      if (await fileExists(top)) {
        return { abs: top, repoDir: repo.absPath, content: await readFile(top), config: repo.specGuardConfig ?? undefined };
      }
      if (repo.specGuardConfig) {
        for (const app of repo.specGuardConfig.apps) {
          const abs = path.resolve(repo.absPath, app.specDir, `${ref.specKey}.md`);
          if (await fileExists(abs)) {
            return { abs, repoDir: repo.absPath, content: await readFile(abs), config: repo.specGuardConfig ?? undefined };
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
  const top = path.join(path.resolve(root, config.paths?.specsRoot ?? 'specs'), `${ref.specKey}.md`);
  if (await fileExists(top)) {
    return { abs: top, repoDir: root, content: await readFile(top), config };
  }
  for (const app of config.apps) {
    const abs = path.resolve(root, app.specDir, `${ref.specKey}.md`);
    if (await fileExists(abs)) {
      return { abs, repoDir: root, content: await readFile(abs), config };
    }
  }
  return null;
}

async function candidateRoots(cwd: string): Promise<string[]> {
  const roots = [path.resolve(cwd)];
  try {
    const { manifest, repos } = await loadWorkspaceWithConfigs(cwd);
    roots.push(path.resolve(manifest.rootDir), ...repos.map((repo) => path.resolve(repo.absPath)));
  } catch {
    /* single repo */
  }
  return roots;
}

/** Rewrite absolute fileHashes keys as repo-relative POSIX keys. Returns true when changed. */
export function migrateLedgerPaths(ledger: ProofLedger, roots: string[]): boolean {
  let changed = false;
  const ordered = [...roots].sort((a, b) => b.length - a.length);
  for (const record of Object.values(ledger.proofs)) {
    for (const key of Object.keys(record.fileHashes ?? {})) {
      if (!path.isAbsolute(key) && !/^[A-Za-z]:[\\/]/.test(key)) continue;
      const root = ordered.find((candidate) => !path.relative(candidate, key).startsWith('..')) ?? ordered[ordered.length - 1];
      const rel = root ? toRegistryKey(root, key) : path.basename(key);
      record.fileHashes[rel] = record.fileHashes[key];
      delete record.fileHashes[key];
      changed = true;
    }
  }
  return changed;
}

/** The file-backed ledger store for `file`, rewriting absolute paths from another machine on read. */
async function fileStoreFor(file: string, cwd: string): Promise<LedgerStore> {
  const roots = await candidateRoots(cwd);
  return fileLedgerStore(file, { migrate: (ledger) => migrateLedgerPaths(ledger, roots) });
}

async function storeFor(cwd: string, opts: ProofOpts, file: string): Promise<LedgerStore> {
  return opts.store ?? (await fileStoreFor(file, cwd));
}

/**
 * An evidence path as it is stored: relative, with `..` collapsed, and inside the repository. Anything else (an absolute
 * path, one that climbs out, a symlink that leaves) is not recorded, so a verdict file from outside cannot make the
 * ledger, or anything that follows an evidence path, point somewhere it should not. The verdict itself is kept.
 */
export function safeEvidencePath(raw: string | undefined, root: string, warn: (message: string) => void = () => undefined): string | undefined {
  if (raw === undefined) return undefined;
  const abs = path.resolve(root, raw);
  if (!isInside(root, abs)) {
    warn(`evidence path "${raw.slice(0, 80)}" is outside the repository and was not recorded`);
    return undefined;
  }
  return path.relative(root, abs).split(path.sep).join('/') || undefined;
}

export async function runProofIngest(
  verdictsPath: string,
  cwd: string,
  opts: ProofOpts = {},
): Promise<PipelineResult> {
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
  return ingestVerdicts(parsed.data, cwd, opts, result);
}

/**
 * Merge validated verdicts into the ledger. Shared by `proof ingest` and
 * `results ingest` so both write identical rows.
 */
export async function ingestVerdicts(
  body: VerdictFile,
  cwd: string,
  opts: ProofOpts = {},
  result: PipelineResult = emptyResult('proof-ingest'),
): Promise<PipelineResult> {
  const { file } = await resolveLedgerFile(cwd, opts);
  const store = await storeFor(cwd, opts, file);
  const appNames = await appNamesFor(cwd);
  // Claims that name a package unit are claims of the workspace root's specs.
  const packageUnits = await workspaceUnits(cwd);
  const provenance: Provenance = { ...detectProvenance(cwd), ...opts.provenance };

  await store.update(async (ledger) => {
    for (const row of body.verdicts.map((r) => ({ ...r, claim: canonicalClaimRef(r.claim, packageUnits) }))) {
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
      if (ref && !new RegExp(`<!--\\s*claim:\\s*${ref.claimId}\\s*-->`, 'i').test(located.content)) {
        result.failed += 1;
        result.items.push({ key: row.claim, status: 'failed', message: 'claim id is not anchored in the spec' });
        result.messages.push(`${row.claim}: claim id not found in spec`);
        continue;
      }
      const repoSha = (ref?.repo && body.repoShas?.[ref.repo]) || gitHead(located.repoDir);
      const record: ProofRecord = {
        claim: row.claim,
        verdict: row.verdict,
        runId: body.runId,
        specHash: hashString(located.content),
        claimHash: ref ? claimHashInContent(located.content, located.abs, ref.claimId) : undefined,
        repoSha,
        fileHashes: await recordedFileHashes(located, ref?.specKey ?? '', appNames, result),
        dependencyFingerprint: dependencyFingerprint(located.repoDir),
        exercised: row.exercised ?? 0,
        counterexamples: row.counterexamples ?? 0,
        evidencePath: safeEvidencePath(row.evidencePath, cwd, (m) => result.messages.push(`${row.claim}: ${m}`)),
        evidence: row.evidence,
        origin: provenance.origin,
        ...(provenance.repo ? { repo: provenance.repo } : {}),
        ...(provenance.branch ? { branch: provenance.branch } : {}),
        ...(provenance.actor ? { actor: provenance.actor } : {}),
        hashVersion: HASH_VERSION,
        ingestedAt: new Date().toISOString(),
      };
      // Evidence is kept per layer, so a browser failure and a passing unit test do not overwrite each other.
      const layer: EvidenceLayer = row.layer ?? (row.evidence === 'agentic' ? 'functional' : 'unclassified');
      const previous = ledger.proofs[row.claim];
      // An unclassified `unexercised` row is a sweep marker for a claim no test cited: it replaces the row, layers and all.
      const replacesRow = layer === 'unclassified' && (!previous?.layers || row.verdict === 'unexercised');
      ledger.proofs[row.claim] = replacesRow ? record : mergeLayerRecord(previous, record, layer);
      result.updated += 1;
      result.items.push({ key: row.claim, status: 'updated', message: row.verdict });
      result.messages.push(`${row.claim}: ${row.verdict}`);
    }

  });
  result.exitCode = result.failed > 0 ? ExitCode.ValidationFailed : ExitCode.Success;
  result.messages.push(`proof ingest: ${result.updated} stored, ${result.failed} failed, ledger ${store.location}`);
  return result;
}

/** Registry hashes for the spec merged with hashes of its declared `sources:`. */
async function recordedFileHashes(
  located: LocatedSpec,
  specKey: string,
  appNames: string[] | undefined,
  result: PipelineResult,
): Promise<Record<string, string>> {
  let config = located.config;
  if (!config) {
    try {
      config = await loadConfig(located.repoDir);
    } catch {
      return fileHashesFor(located.repoDir, specKey, appNames);
    }
  }
  const registry = loadRegistry(located.repoDir);
  if (migrateRegistrySpecKeys(config, registry)) saveRegistry(located.repoDir, registry);
  const hashes = fileHashesFor(located.repoDir, specKey, appNames);
  const declared = await declaredFileHashes(config, located.abs, located.content, (msg) => {
    if (!result.messages.includes(msg)) result.messages.push(msg);
  });
  return { ...hashes, ...declared };
}

async function appNamesFor(cwd: string): Promise<string[] | undefined> {
  try {
    return (await loadConfig(cwd)).apps.map((app) => app.name);
  } catch {
    return undefined;
  }
}

interface CoverageCounts {
  proven: number;
  failed: number;
  unexercised: number;
  error: number;
  stale: number;
  unproven: number;
  /** Claims not proven in every layer they require. Not part of the verdict counts above. */
  incomplete: number;
}

/** What a verdict callback learns beyond the verdict: the claim's evidence by layer and what it still needs. */
export interface ClaimDetail extends ClaimProof {
  required: TestLayer[];
}

type VerdictCallback = (ref: string, verdict: ReturnType<typeof effectiveVerdict>, detail?: ClaimDetail) => void;

/** Effective verdict of every anchored claim (used by status, proof status and tests). */
export async function walkClaimVerdicts(
  config: SpecGuardConfig,
  onVerdict: VerdictCallback,
  opts: ProofOpts = {},
): Promise<CoverageCounts | null> {
  return walkClaims(config, config.rootDir ?? process.cwd(), onVerdict, opts);
}

async function walkClaims(
  config: SpecGuardConfig,
  cwd: string,
  onVerdict: VerdictCallback,
  opts: ProofOpts = {},
): Promise<CoverageCounts | null> {
  const { file } = await resolveLedgerFile(cwd, opts);
  if (!opts.store && !(await fileExists(file))) return null;
  const ledger = await (await storeFor(cwd, opts, file)).read();
  const fingerprint = dependencyFingerprint(cwd);
  const assessments = loadAssessments(cwd);
  const repoKey = await repoKeyFor(cwd);
  const counts: CoverageCounts = { proven: 0, failed: 0, unexercised: 0, error: 0, stale: 0, unproven: 0, incomplete: 0 };
  const top = path.resolve(cwd, config.paths?.specsRoot ?? 'specs');
  const specDirs = (await fileExists(top))
    ? [top]
    : config.apps.map((app) => path.resolve(cwd, app.specDir));

  for (const specDir of specDirs) {
    let specs;
    try {
      specs = loadCanonicalSpecs(config, specDir);
    } catch {
      continue;
    }
    for (const spec of specs) {
      const specFile = specFileOf(spec, specDir);
      if (!(await fileExists(specFile))) continue;
      const specHash = hashString(await readFile(specFile));
      for (const claim of spec.claims) {
        if (!claim.id) {
          counts.unproven += 1;
          continue;
        }
        const ref = formatClaimRef(repoKey, spec.specKey, claim.id);
        const record = ledger.proofs[ref] ?? ledger.proofs[formatClaimRef(undefined, spec.specKey, claim.id)];
        const required = requiredLayersFor(claim.id, spec.meta.layers, config.proof?.requiredLayers);
        const claimHash = claimHashOf(spec, claim.id);
        const fileChange = fileChangeResolver(assessments, spec.specKey, claim.id);
        const proof = effectiveClaimProof(
          record,
          (_layer, layerProof) => ({
            specHash,
            claimHash,
            fileChange,
            fileHashes: currentFileHashes(cwd, layerProof.fileHashes),
            dependencyFingerprint: fingerprint,
          }),
          required,
        );
        counts[proof.verdict] += 1;
        if (required.length > 0 && !proof.complete && proof.verdict !== 'unproven') counts.incomplete += 1;
        onVerdict(ref, proof.verdict, { ...proof, required });
      }
    }
  }
  return counts;
}

/** Informational proof lines for `specguard status`. Does not change the exit code. */
export async function appendProofCoverage(
  config: SpecGuardConfig,
  log: (line: string) => void,
  opts: ProofOpts = {},
): Promise<void> {
  const cwd = config.rootDir ?? process.cwd();
  const enforce = config.proof?.enforceLayers ?? 'warn';
  const tally = new Map<TestLayer, { required: number; proven: number }>();
  const counts = await walkClaims(config, cwd, (ref, verdict, detail) => {
    if (detail && detail.required.length > 0 && verdict !== 'unproven') {
      for (const layer of detail.required) {
        const t = tally.get(layer) ?? { required: 0, proven: 0 };
        t.required += 1;
        if (detail.layers[layer] === 'proven') t.proven += 1;
        tally.set(layer, t);
      }
      if (!detail.complete && enforce !== 'off') log(`  [proof-incomplete] ${ref} (missing: ${detail.missing.join(', ')})`);
    }
    if (verdict === 'proven' || verdict === 'unproven') return;
    log(`  [proof-${verdict}] ${ref}`);
  }, opts);
  if (!counts) {
    log('PROOFS: no ledger');
    return;
  }
  log(
    `PROOFS: ${counts.proven} proven, ${counts.failed} failed, ${counts.error} error, ` +
      `${counts.unexercised} unexercised, ${counts.stale} stale, ${counts.unproven} unproven`,
  );
  if (tally.size > 0) {
    log(`LAYERS: ${TEST_LAYERS.filter((l) => tally.has(l)).map((l) => `${l} ${tally.get(l)!.proven}/${tally.get(l)!.required}`).join('  ')}${counts.incomplete > 0 ? `; ${counts.incomplete} claim(s) missing a required layer` : ''}`);
  }
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
