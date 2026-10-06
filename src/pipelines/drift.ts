/**
 * Drift Detection pipeline — hash-registry + LLM semantic comparison.
 *
 * Previous behaviour: mtime-based — any file edit triggers drift. This was far
 * too noisy. New behaviour:
 *
 *   1. Load (or create) `.specguard/drift-registry.json`.
 *   2. For each spec, find the key source files registered against it (or all
 *      source files on first run).
 *   3. Hash each source file. If the hash hasn't changed since last check →
 *      skip (no LLM call needed).
 *   4. When the hash DID change, extract the `git diff` for that file and ask
 *      the LLM: "does this diff semantically affect the spec?"
 *   5. Update the registry with the new hash and verdict.
 *   6. Report only files where the LLM returns semantic drift.
 *
 * Backward compat:
 *   - `--mtime` flag restores the old mtime-based check.
 *   - `--force` bypasses the hash check and re-evaluates everything.
 *   - No registry → falls back to mtime on first run and populates the registry.
 *
 * CLI: specguard drift [--since <ref>] [--spec <key>] [--force] [--mtime]
 *
 * Spec: specs/pipelines/drift.md
 */
import { loadCanonicalSpecs, migrateRegistrySpecKeys, specFileOf } from '../core/spec-key.js';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';

import { z } from 'zod';
import type { AppConfig, SpecGuardConfig, PipelineResult, PipelineItem } from '../core/types.js';
import { featureFromPath, resolveProfile } from '../core/language-profiles.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists } from '../core/reader.js';
import { expandAppGlobs } from '../core/spec-key.js';
import { llmGenerateObject } from '../core/llm.js';
import { noteStaleProofs } from './proof.js';
import {
  loadRegistry, saveRegistry, hashFile, hashString, toRegistryKey,
  getOrCreateSpecEntry, updateFileEntry,
} from '../core/drift-registry.js';
import { writePlan } from '../core/plan-writer.js';

export interface DriftOpts {
  /** Git ref to diff against; the range becomes `<since>..HEAD`. Default `HEAD~1`. */
  since?: string;
  /** Restrict the report to a single spec key (e.g. `specguard-core/foo`). */
  spec?: string;
  /** Re-evaluate every file even if hash matches. */
  force?: boolean;
  /** Use legacy mtime comparison instead of hash+LLM. */
  mtime?: boolean;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export function getChangedFiles(range: string, cwd: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', range], {
    cwd, encoding: 'utf-8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(path.sep).join('/'));
}

export const driftGit = { getChangedFiles };

function getFileDiff(absPath: string, cwd: string, range: string): string {
  try {
    const rel = path.relative(cwd, absPath).split(path.sep).join('/');
    return execFileSync('git', ['diff', range, '--', rel], { cwd, encoding: 'utf-8' }).slice(0, 4000);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function deriveFeature(absFile: string, repoDir: string, app: AppConfig): string {
  return featureFromPath(absFile, repoDir, resolveProfile(app), app);
}

async function mtimeMs(absPath: string): Promise<number | null> {
  try { return (await stat(absPath)).mtimeMs; } catch { return null; }
}

// ---------------------------------------------------------------------------
// LLM semantic check
// ---------------------------------------------------------------------------

const SemanticDriftSchema = z.object({
  drifted: z.boolean().describe('true if the diff changes behaviour described in the spec'),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().describe('One sentence explaining the verdict'),
});

const DRIFT_SYSTEM = [
  'You are SpecGuard, a QA agent. Given a git diff and a spec excerpt, decide',
  'whether the diff represents a SEMANTIC change that would require updating the spec.',
  '',
  'Rules:',
  '- Formatting changes, comments, and internal refactors that keep public behaviour',
  '  identical are NOT drift.',
  '- New exports, changed API signatures, changed logic that the spec describes, or',
  '  missing/added scenarios ARE drift.',
  '- Output ONLY the JSON object.',
].join('\n');

async function llmSemanticDrift(
  config: SpecGuardConfig,
  diff: string,
  specExcerpt: string,
  specKey: string,
): Promise<{ drifted: boolean; reason: string }> {
  if (!diff || diff.trim().length < 10) return { drifted: false, reason: 'diff too small to analyse' };

  const prompt = [
    `Spec key: ${specKey}`,
    '',
    '--- Spec (acceptance criteria excerpt) ---',
    specExcerpt.slice(0, 2000),
    '',
    '--- Git diff (changed source file) ---',
    diff,
    '',
    'Does this diff require updating the spec? Answer with JSON.',
  ].join('\n');

  const result = await llmGenerateObject({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKeyEnv: config.llm.apiKeyEnv,
    system: DRIFT_SYSTEM,
    prompt,
    schema: SemanticDriftSchema,
  });

  return { drifted: result.drifted, reason: result.reason };
}

// ---------------------------------------------------------------------------
// Legacy mtime-based check (backward compat)
// ---------------------------------------------------------------------------

async function runMtimeDrift(
  config: SpecGuardConfig,
  opts: DriftOpts,
): Promise<PipelineResult> {
  const result = emptyResult('drift');
  const log = (line: string) => { result.messages.push(line); };

  const cwd = config.rootDir ?? process.cwd();
  const since = opts.since ?? 'HEAD~1';
  const range = `${since}..HEAD`;

  let changed: string[] | null = null;
  try {
    changed = driftGit.getChangedFiles(range, cwd);
  } catch (err) {
    log(`[warn] git diff failed (${(err as Error).message}); falling back to scanning all sources`);
    changed = null;
  }
  const changedAbs = changed ? new Set(changed.map((rel) => path.resolve(cwd, rel))) : null;

  for (const app of config.apps) {
    const repoDir = resolveFromRoot(config, app.repo);
    const specDirAbs = resolveFromRoot(config, app.specDir);
    const patterns: string[] = [];
    for (const group of Object.values(app.sources)) {
      if (Array.isArray(group)) patterns.push(...group);
    }
    if (!patterns.length) continue;

    const allSources = await expandAppGlobs(config, app, patterns);
    const inScope = changedAbs ? allSources.filter((abs) => changedAbs.has(abs)) : allSources;

    for (const absFile of inScope) {
      const feature = deriveFeature(absFile, repoDir, app);
      const key = `${app.name}/${feature}`;
      if (opts.spec && opts.spec !== key) continue;

      const targetSpec = path.join(specDirAbs, `${feature}.md`);
      if (!(await fileExists(targetSpec))) {
        const message = `no spec for changed source — expected ${path.relative(cwd, targetSpec).split(path.sep).join('/')}`;
        log(`[drift] ${key} — ${message}`);
        result.items.push({ key, status: 'failed', path: targetSpec, message });
        result.failed += 1;
        continue;
      }
      const [srcMtime, specMtime] = await Promise.all([mtimeMs(absFile), mtimeMs(targetSpec)]);
      if (srcMtime === null) continue;
      if (specMtime === null || srcMtime > specMtime) {
        const message = 'source modified after spec — spec is stale';
        log(`[drift] ${key} — ${message}`);
        result.items.push({ key, status: 'failed', path: targetSpec, message });
        result.failed += 1;
      }
    }
  }

  // Orphan spec detection for mtime mode
  const orphanResult = await detectOrphans(config, cwd);
  for (const item of orphanResult.items) {
    log(`[orphan] ${item.key} — orphan spec with no matching source file`);
    result.items.push(item);
    result.failed += 1;
  }

  if (result.failed > 0) {
    try {
      const driftedSpecs = result.items.filter((i) => i.status === 'failed' && !i.message?.startsWith('orphan'));
      const orphanSpecs = result.items.filter((i) => i.message?.startsWith('orphan'));
      writePlan({
        pipeline: 'drift',
        title: `Fix Spec Drift — ${result.failed} issue(s) found`,
        summary: `${driftedSpecs.length} drifted spec(s) and ${orphanSpecs.length} orphan spec(s) detected.`,
        sections: [
          ...(driftedSpecs.length > 0 ? [{
            heading: 'Drifted Specs',
            items: driftedSpecs.map((i) => `\`${i.key}\` — ${i.message ?? 'source modified after spec'}`),
          }] : []),
          ...(orphanSpecs.length > 0 ? [{
            heading: 'Orphan Specs',
            items: orphanSpecs.map((i) => `\`${i.key}\``),
          }] : []),
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'For drifted specs: update acceptance criteria to reflect current source.',
              'For orphan specs: delete if feature was removed, or rename to match new source path.',
              'Run `specguard drift` to confirm.',
            ],
          },
        ],
        rootDir: cwd,
      });
    } catch { /* best-effort */ }
  }

  result.exitCode = result.failed > 0 ? ExitCode.DriftDetected : ExitCode.Success;
  return result;
}

// ---------------------------------------------------------------------------
// Hash-registry + LLM drift check (default)
// ---------------------------------------------------------------------------

export async function runDrift(
  config: SpecGuardConfig,
  opts: DriftOpts = {},
): Promise<PipelineResult> {
  // Legacy mode requested or --mtime flag.
  if (opts.mtime) return runMtimeDrift(config, opts);

  const result = emptyResult('drift');
  const log = (line: string) => { result.messages.push(line); };

  const cwd = config.rootDir ?? process.cwd();
  const since = opts.since ?? 'HEAD~1';
  const range = `${since}..HEAD`;

  // Load registry.
  const registry = loadRegistry(cwd);
  if (migrateRegistrySpecKeys(config, registry)) {
    saveRegistry(cwd, registry);
    log('[drift] migrated legacy registry keys to canonical spec keys');
  }
  const hasRegistry = Object.keys(registry).length > 0;

  if (!hasRegistry) {
    log('[drift] no registry found — running mtime check to build initial registry');
    const mtimeResult = await runMtimeDrift(config, opts);
    // After mtime run, populate registry from all source files.
    await _buildInitialRegistry(config, cwd, registry);
    saveRegistry(cwd, registry);
    log('[drift] registry initialised — future runs will use hash+LLM check');
    return mtimeResult;
  }

  // Get recently changed files from git (may fail if not a git repo).
  let changedAbs: Set<string> | null = null;
  try {
    const changedRel = driftGit.getChangedFiles(range, cwd);
    changedAbs = new Set(changedRel.map((rel) => path.resolve(cwd, rel)));
    log(`[drift] ${changedAbs.size} file(s) changed in ${range}`);
  } catch {
    log('[drift] git unavailable — checking all files against registry hashes');
    changedAbs = null;
  }

  for (const app of config.apps) {
    const repoDir = resolveFromRoot(config, app.repo);
    const specDirAbs = resolveFromRoot(config, app.specDir);

    let specFiles: { key: string; local: string; specPath: string; criteria: string }[] = [];
    try {
      const specs = loadCanonicalSpecs(config, specDirAbs);
      specFiles = specs.map((s) => ({
        key: s.specKey,
        local: s.localKey ?? s.specKey,
        specPath: specFileOf(s, specDirAbs),
        criteria: s.acceptanceCriteria || s.overview,
      }));
    } catch { continue; }

    // Collect all source files for this app.
    const patterns: string[] = [];
    for (const [grp, globs] of Object.entries(app.sources)) {
      if (grp === 'tests') continue;
      if (Array.isArray(globs)) patterns.push(...globs);
    }
    if (!patterns.length) continue;
    const allSources = await expandAppGlobs(config, app, patterns);

    for (const { key, local, specPath, criteria } of specFiles) {
      if (opts.spec && opts.spec !== key && opts.spec !== `${app.name}/${local}`) continue;

      const feature = local;
      // Files that plausibly relate to this spec (same feature key in their path).
      const relatedSources = allSources.filter((abs) => {
        const f = deriveFeature(abs, repoDir, app);
        return f === feature;
      });

      const specContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';
      const specHash = hashString(specContent);
      const specEntry = getOrCreateSpecEntry(registry, key, specHash);

      // Also seed any source file that isn't registered yet.
      for (const absFile of relatedSources) {
        const regKey = toRegistryKey(cwd, absFile);
        if (!specEntry.files[regKey]) {
          const h = hashFile(absFile);
          if (h) {
            updateFileEntry(specEntry, regKey, h, 'new-file');
          }
        }
      }

      // Check files that are either new-to-registry or changed (hash diff).
      let specDrifted = false;
      for (const absFile of relatedSources) {
        // Skip files that are clearly out of scope (not changed by git).
        if (changedAbs && !changedAbs.has(absFile) && !opts.force) continue;

        const currentHash = hashFile(absFile);
        if (!currentHash) continue;

        const regKey = toRegistryKey(cwd, absFile);
        const prev = specEntry.files[regKey];
        const hashChanged = !prev || prev.hash !== currentHash;

        if (!hashChanged && !opts.force) {
          // Hash unchanged — use cached verdict.
          if (prev?.lastVerdict === 'drifted') specDrifted = true;
          continue;
        }

        // Hash changed — ask LLM.
        log(`[drift] ${key}: hash changed in ${path.relative(cwd, absFile)} — checking semantics…`);
        try {
          const diff = getFileDiff(absFile, cwd, range);
          const { drifted, reason } = await llmSemanticDrift(config, diff, criteria, key);
          updateFileEntry(specEntry, regKey, currentHash, drifted ? 'drifted' : 'no-drift');
          if (drifted) {
            specDrifted = true;
            log(`[drift] ${key} — semantic drift detected: ${reason}`);
            const item: PipelineItem = {
              key,
              status: 'failed',
              path: specPath,
              message: `semantic drift in ${path.relative(cwd, absFile)}: ${reason}`,
            };
            result.items.push(item);
            result.failed += 1;
          } else {
            log(`[drift] ${key} — no semantic drift (${reason})`);
          }
        } catch (err) {
          // LLM failed — fall back to flagging the hash change as drift.
          log(`[drift] ${key}: LLM check failed (${(err as Error).message}) — flagging as possible drift`);
          updateFileEntry(specEntry, regKey, currentHash, 'drifted');
          specDrifted = true;
          result.items.push({ key, status: 'failed', path: specPath, message: `hash changed, LLM unavailable` });
          result.failed += 1;
        }
      }

      if (!specDrifted) {
        log(`[drift] ${key}: no drift`);
      }
    }
  }

  saveRegistry(cwd, registry);

  saveRegistry(cwd, registry);

  // Orphan spec detection — run after semantic drift checks
  const orphanResult = await detectOrphans(config, cwd);
  for (const item of orphanResult.items) {
    log(`[orphan] ${item.key} — orphan spec with no matching source file`);
    result.items.push(item);
    result.failed += 1;
  }
  if (orphanResult.orphanCount > 0) {
    log(`[drift] ${orphanResult.orphanCount} orphan spec(s) detected`);
  }

  await noteStaleProofs(config, cwd, log, result);

  if (result.failed > 0) {
    try {
      const driftedSpecs = result.items.filter((i) => i.status === 'failed' && !i.message?.startsWith('orphan'));
      const orphanSpecs = result.items.filter((i) => i.message?.startsWith('orphan'));
      const allFailed = result.items.filter((i) => i.status === 'failed');
      writePlan({
        pipeline: 'drift',
        title: `Fix Spec Drift — ${allFailed.length} issue(s) found`,
        summary:
          (driftedSpecs.length > 0
            ? `${driftedSpecs.length} spec(s) have semantic drift. `
            : '') +
          (orphanSpecs.length > 0
            ? `${orphanSpecs.length} orphan spec(s) have no matching source file. `
            : '') +
          `Update drifted specs to reflect current code; delete or reconnect orphan specs.`,
        sections: [
          ...(driftedSpecs.length > 0 ? [{
            heading: 'Drifted Specs',
            items: driftedSpecs.map((i) => `\`${i.key}\` — ${i.message ?? 'semantic drift detected'}`),
          }] : []),
          ...(orphanSpecs.length > 0 ? [{
            heading: 'Orphan Specs (no matching source)',
            items: orphanSpecs.map((i) => `\`${i.key}\` — ${i.path}`),
          }] : []),
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'For drifted specs: open each spec and update acceptance criteria to match the current source.',
              'For orphan specs: delete the spec file if the feature was removed, or rename it to match the new source path.',
              'Run `specguard drift` again to confirm no remaining issues.',
            ],
          },
        ],
        rootDir: cwd,
      });
      log(`[drift] fix plan written to .specguard/plans/`);
    } catch { /* best-effort */ }
  }

  result.exitCode = result.failed > 0 ? ExitCode.DriftDetected : ExitCode.Success;
  return result;
}

// ---------------------------------------------------------------------------
// Orphan spec detection
// ---------------------------------------------------------------------------

/**
 * Return true for spec keys that intentionally have no corresponding source
 * file and should be excluded from orphan analysis.
 */
function isOrphanExempt(specKey: string): boolean {
  // Test-aligned specs live under __tests__/ — they align to tests, not source files
  if (specKey.includes('__tests__')) return true;
  // Root index.md is the architecture overview doc
  if (specKey === 'index') return true;
  // README docs
  if (specKey === 'README' || specKey.endsWith('/README')) return true;
  return false;
}

export interface OrphanResult {
  items: PipelineItem[];
  orphanCount: number;
}

/**
 * For each app, scan `specDir` for all `.md` files and flag any spec that has
 * no matching source file as an orphan. Orphan specs indicate deleted features,
 * renamed files, or specs that were never connected to source.
 */
export async function detectOrphans(
  config: SpecGuardConfig,
  _cwd?: string,
): Promise<OrphanResult> {
  const items: PipelineItem[] = [];
  let orphanCount = 0;

  for (const app of config.apps) {
    const repoDir = resolveFromRoot(config, app.repo);
    const specDirAbs = resolveFromRoot(config, app.specDir);

    // Build the full feature set from source files for this app
    const patterns: string[] = [];
    for (const [grp, globs] of Object.entries(app.sources)) {
      if (grp === 'tests') continue;
      if (Array.isArray(globs)) patterns.push(...globs);
    }
    if (!patterns.length) continue;

    // Build the feature set AND the "domain" (set of first-path-segment prefixes this app covers)
    let allSources: string[] = [];
    try { allSources = await expandAppGlobs(config, app, patterns); } catch { continue; }
    const featureSet = new Set(allSources.map((abs) => deriveFeature(abs, repoDir, app)));

    // Domain filtering: only flag orphans for specs whose first-segment prefix
    // matches what this app's sources can produce. This prevents apps with a
    // broad specDir (e.g. "specs") from falsely flagging specs that belong to
    // sibling apps in the same specDir tree.
    const sourceDomainPrefixes = new Set<string>();
    for (const feature of featureSet) {
      sourceDomainPrefixes.add(feature.split('/')[0]);
    }

    // Load all specs from the specDir
    let specs: import('../core/types.js').ParsedSpec[] = [];
    try { specs = loadCanonicalSpecs(config, specDirAbs); } catch { continue; }

    for (const spec of specs) {
      const specKey = spec.localKey ?? spec.specKey;
      if (isOrphanExempt(specKey)) continue;

      // Only flag orphans for specs within this app's feature domain
      const specFirstSegment = specKey.split('/')[0];
      if (!sourceDomainPrefixes.has(specFirstSegment)) continue;

      // index files match their parent directory index.{ts,tsx}
      const featureToMatch = specKey.endsWith('/index')
        ? specKey  // keep full path including /index
        : specKey;

      if (!featureSet.has(featureToMatch)) {
        const key = spec.specKey;
        const specPath = path.join(specDirAbs, `${specKey}.md`);
        items.push({
          key,
          status: 'failed',
          path: specPath,
          message: 'orphan spec — no matching source file found',
        });
        orphanCount += 1;
      }
    }
  }

  return { items, orphanCount };
}

// ---------------------------------------------------------------------------
// Initial registry builder (run once when registry doesn't exist)
// ---------------------------------------------------------------------------

async function _buildInitialRegistry(
  config: SpecGuardConfig,
  cwd: string,
  registry: Record<string, import('../core/drift-registry.js').DriftSpecEntry>,
): Promise<void> {
  for (const app of config.apps) {
    const repoDir = resolveFromRoot(config, app.repo);
    const specDirAbs = resolveFromRoot(config, app.specDir);

    const patterns: string[] = [];
    for (const [grp, globs] of Object.entries(app.sources)) {
      if (grp === 'tests') continue;
      if (Array.isArray(globs)) patterns.push(...globs);
    }
    if (!patterns.length) continue;

    const allSources = await expandAppGlobs(config, app, patterns);
    let specs: import('../core/types.js').ParsedSpec[] = [];
    try { specs = loadCanonicalSpecs(config, specDirAbs); } catch { continue; }

    for (const spec of specs) {
      const key = spec.specKey;
      const specPath = specFileOf(spec, specDirAbs);
      const specContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';
      const specHash = hashString(specContent);
      const specEntry = getOrCreateSpecEntry(registry, key, specHash);

      const feature = spec.localKey ?? spec.specKey;
      const related = allSources.filter((abs) => deriveFeature(abs, repoDir, app) === feature);
      for (const absFile of related) {
        const h = hashFile(absFile);
        if (h) updateFileEntry(specEntry, toRegistryKey(cwd, absFile), h, 'no-drift');
      }
    }
  }
}
