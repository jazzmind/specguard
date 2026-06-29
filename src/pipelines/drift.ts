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
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';

import { z } from 'zod';
import type { SpecGuardConfig, PipelineResult, PipelineItem } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists, expandGlobs } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import { llmGenerateObject } from '../core/llm.js';
import {
  loadRegistry, saveRegistry, hashFile, hashString,
  getOrCreateSpecEntry, updateFileEntry,
} from '../core/drift-registry.js';

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

function deriveFeature(absFile: string, repoDir: string): string {
  let rel = path.relative(repoDir, absFile).split(path.sep).join('/');
  const segments = rel.split('/');
  if (segments.length > 1 && (segments[0] === 'src' || segments[0] === 'tests')) segments.shift();
  if (segments.length > 1) segments.shift();
  rel = segments.join('/');
  rel = rel.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '');
  rel = rel.replace(/\.[cm]?[jt]sx?$/i, '');
  return rel;
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

    const allSources = await expandGlobs(patterns, repoDir);
    const inScope = changedAbs ? allSources.filter((abs) => changedAbs.has(abs)) : allSources;

    for (const absFile of inScope) {
      const feature = deriveFeature(absFile, repoDir);
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

    let specFiles: { key: string; specPath: string; criteria: string }[] = [];
    try {
      const specs = loadAllSpecs(specDirAbs);
      specFiles = specs.map((s) => ({
        key: `${app.name}/${s.specKey}`,
        specPath: path.join(specDirAbs, `${s.specKey}.md`),
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
    const allSources = await expandGlobs(patterns, repoDir);

    for (const { key, specPath, criteria } of specFiles) {
      if (opts.spec && opts.spec !== key) continue;

      const feature = key.split('/').slice(1).join('/');
      // Files that plausibly relate to this spec (same feature key in their path).
      const relatedSources = allSources.filter((abs) => {
        const f = deriveFeature(abs, repoDir);
        return f === feature;
      });

      const specContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';
      const specHash = hashString(specContent);
      const specEntry = getOrCreateSpecEntry(registry, key, specHash);

      // Also seed any source file that isn't registered yet.
      for (const absFile of relatedSources) {
        if (!specEntry.files[absFile]) {
          const h = hashFile(absFile);
          if (h) {
            updateFileEntry(specEntry, absFile, h, 'new-file');
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

        const prev = specEntry.files[absFile];
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
          updateFileEntry(specEntry, absFile, currentHash, drifted ? 'drifted' : 'no-drift');
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
          updateFileEntry(specEntry, absFile, currentHash, 'drifted');
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

  result.exitCode = result.failed > 0 ? ExitCode.DriftDetected : ExitCode.Success;
  return result;
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

    const allSources = await expandGlobs(patterns, repoDir);
    let specs: import('../core/types.js').ParsedSpec[] = [];
    try { specs = loadAllSpecs(specDirAbs); } catch { continue; }

    for (const spec of specs) {
      const key = `${app.name}/${spec.specKey}`;
      const specPath = path.join(specDirAbs, `${spec.specKey}.md`);
      const specContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';
      const specHash = hashString(specContent);
      const specEntry = getOrCreateSpecEntry(registry, key, specHash);

      const feature = spec.specKey;
      const related = allSources.filter((abs) => deriveFeature(abs, repoDir) === feature);
      for (const absFile of related) {
        const h = hashFile(absFile);
        if (h) updateFileEntry(specEntry, absFile, h, 'no-drift');
      }
    }
  }
}
