/**
 * Drift Detection pipeline.
 *
 * Detects specs that have drifted out of sync with the source code they
 * describe. It asks git which files changed in a range (default
 * `HEAD~1..HEAD`), maps each changed source file to the spec that should keep
 * it in sync, and compares modification times. A spec older than its source —
 * or missing entirely — is reported as drift, and the pipeline exits with
 * `ExitCode.DriftDetected` (3).
 *
 * Spec: specs/pipelines/drift.md
 *
 * Source-file -> spec-key mapping
 * -------------------------------
 * This MUST match the reverse pipeline (`src/pipelines/reverse-generate.ts`):
 *
 *   1. Take the path relative to the app repo, normalised to POSIX separators.
 *   2. Drop a leading `src/` or `tests/` segment if present.
 *   3. Drop the next segment (the source group / area directory) so the spec
 *      subpath is not redundant with `specDir`.
 *   4. Strip a `.test`/`.spec` qualifier and the file extension.
 *
 * The spec lives at `<specDir>/<feature>.md` and its key is
 * `<app.name>/<feature>` (e.g. `specguard-core/foo`).
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';

import type { SpecGuardConfig, PipelineResult, PipelineItem } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists, expandGlobs } from '../core/reader.js';

export interface DriftOpts {
  /** Git ref to diff against; the range becomes `<since>..HEAD`. Default `HEAD~1`. */
  since?: string;
  /** Restrict the report to a single spec key (e.g. `specguard-core/foo`). */
  spec?: string;
}

/**
 * Run `git diff --name-only <range>` and return the changed paths (repo-root
 * relative, POSIX separators). Throws if git fails — callers handle fallback.
 *
 * Isolated as its own export so tests can mock/override it via
 * {@link driftGit} without invoking real git.
 */
export function getChangedFiles(range: string, cwd: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', range], {
    cwd,
    encoding: 'utf-8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(path.sep).join('/'));
}

/**
 * Indirection seam for the git call. Production code goes through this object so
 * tests can replace `driftGit.getChangedFiles` (ESM-safe; spying on a bare
 * function export would not intercept the internal call).
 */
export const driftGit = { getChangedFiles };

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/** Derive the feature path (no extension) for a source file relative to repo. */
function deriveFeature(absFile: string, repoDir: string): string {
  let rel = path.relative(repoDir, absFile).split(path.sep).join('/');
  const segments = rel.split('/');

  // 1. Drop a leading src/ or tests/ segment.
  if (segments.length > 1 && (segments[0] === 'src' || segments[0] === 'tests')) {
    segments.shift();
  }

  // 2. Drop the next segment — the source group / area directory. The spec area
  //    is already encoded by `specDir`, so this avoids a redundant subpath.
  if (segments.length > 1) {
    segments.shift();
  }

  rel = segments.join('/');

  // 3. Strip extension and a .test/.spec qualifier.
  rel = rel.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '');
  rel = rel.replace(/\.[cm]?[jt]sx?$/i, '');
  return rel;
}

/** Modification time in ms, or null when the path does not exist. */
async function mtimeMs(absPath: string): Promise<number | null> {
  try {
    const st = await stat(absPath);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Detect drift between changed source files and their Living Specs.
 */
export async function runDrift(
  config: SpecGuardConfig,
  opts: DriftOpts = {},
): Promise<PipelineResult> {
  const result = emptyResult('drift');
  const log = (line: string): void => {
    result.messages.push(line);
  };

  const cwd = config.rootDir ?? process.cwd();
  const since = opts.since ?? 'HEAD~1';
  const range = `${since}..HEAD`;

  // 1. Ask git what changed. On failure, fall back to scanning everything.
  let changed: string[] | null = null;
  try {
    changed = driftGit.getChangedFiles(range, cwd);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log(
      `[warn] git diff failed for range ${range} (${message}); ` +
        'falling back to scanning all configured source files',
    );
    changed = null;
  }

  // Absolute set of changed files (only meaningful when git succeeded).
  const changedAbs = changed
    ? new Set(changed.map((rel) => path.resolve(cwd, rel)))
    : null;

  // 2. Per app, find source files in scope and check each for drift.
  for (const app of config.apps) {
    const repoDir = resolveFromRoot(config, app.repo);
    const specDirAbs = resolveFromRoot(config, app.specDir);

    const patterns: string[] = [];
    for (const group of Object.values(app.sources)) {
      if (Array.isArray(group)) patterns.push(...group);
    }
    if (patterns.length === 0) continue;

    // All source files matching this app's globs (absolute, sorted).
    const allSources = await expandGlobs(patterns, repoDir);

    // In scope = intersection with changed files, or everything on fallback.
    const inScope = changedAbs
      ? allSources.filter((abs) => changedAbs.has(abs))
      : allSources;

    for (const absFile of inScope) {
      const feature = deriveFeature(absFile, repoDir);
      const key = `${app.name}/${feature}`;

      // Optional single-spec filter.
      if (opts.spec && opts.spec !== key) continue;

      const targetSpec = path.join(specDirAbs, `${feature}.md`);

      if (!(await fileExists(targetSpec))) {
        const message = `no spec for changed source — expected ${path.relative(cwd, targetSpec).split(path.sep).join('/')}`;
        log(`[drift] ${key} — ${message}`);
        const item: PipelineItem = { key, status: 'failed', path: targetSpec, message };
        result.items.push(item);
        result.failed += 1;
        continue;
      }

      const [srcMtime, specMtime] = await Promise.all([mtimeMs(absFile), mtimeMs(targetSpec)]);

      // Source missing (race) — nothing to compare.
      if (srcMtime === null) continue;

      if (specMtime === null || srcMtime > specMtime) {
        const message = 'source modified after spec — spec is stale';
        log(`[drift] ${key} — ${message}`);
        const item: PipelineItem = { key, status: 'failed', path: targetSpec, message };
        result.items.push(item);
        result.failed += 1;
      }
    }
  }

  result.exitCode = result.failed > 0 ? ExitCode.DriftDetected : ExitCode.Success;
  return result;
}
