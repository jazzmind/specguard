/**
 * Status pipeline.
 *
 * Read-only coverage report. For every app in the SpecGuard config it expands
 * the configured source globs, derives each source file's expected spec key,
 * and checks whether a spec exists under `specDir` and whether a generated test
 * exists under `testOutput`. It prints a per-app coverage report and a totals
 * line, and returns exit code 4 (`MissingSpecs`) if any source file lacks a
 * spec.
 *
 * Spec: specs/pipelines/status.md
 *
 * Source-file -> feature mapping
 * ------------------------------
 * Matches the reverse pipeline (`src/pipelines/reverse-generate.ts`) exactly so
 * status cross-references the same spec paths the reverse pipeline writes:
 *   1. Path relative to the app `repo`, normalised to POSIX separators.
 *   2. Drop a leading `src/` or `tests/` segment.
 *   3. Drop the next segment (the source group / area directory) — the area is
 *      already encoded by `specDir`.
 *   4. Strip a `.test`/`.spec` qualifier and the file extension.
 * The expected spec is `<specDir>/<feature>.md`; the item key is
 * `<app.name>/<feature>`.
 */
import path from 'node:path';

import type { SpecGuardConfig, AppConfig, PipelineResult, PipelineItem } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists, expandGlobs } from '../core/reader.js';
import {
  resolveProfile,
  featureFromPath,
  type LanguageProfile,
} from '../core/language-profiles.js';

/** Options for the status pipeline (reserved for forward-compat). */
export interface StatusOpts {}

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

// Source-path → feature-key derivation lives in core/language-profiles.ts
// (`featureFromPath`) so it stays consistent with reverse/gap-analysis.

/** Candidate generated-test paths for a feature under `testOutput`. */
function testCandidates(
  testOutputAbs: string,
  feature: string,
  profile: LanguageProfile,
): string[] {
  return profile.testFileCandidates(feature).map((name) => path.join(testOutputAbs, name));
}

function pct(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * Report spec/test coverage for every app in the config.
 */
export async function runStatus(
  config: SpecGuardConfig,
  _opts?: StatusOpts,
): Promise<PipelineResult> {
  const result = emptyResult('status');

  const log = (line: string): void => {
    result.messages.push(line);
  };

  let totalFiles = 0;
  let totalSpecs = 0;
  let totalTests = 0;
  let totalMissingSpecs = 0;

  for (const app of config.apps) {
    const repoDir = resolveFromRoot(config, app.repo);
    const specDirAbs = resolveFromRoot(config, app.specDir);
    const testOutputAbs = resolveFromRoot(config, app.testOutput);
    const profile = resolveProfile(app);

    // Collect source files from every group EXCEPT `tests` — test files are
    // not features that need their own spec.
    const patterns: string[] = [];
    for (const [group, globs] of Object.entries(app.sources)) {
      if (group === 'tests') continue;
      if (Array.isArray(globs)) patterns.push(...globs);
    }
    const files = await expandGlobs(patterns, repoDir);

    let appSpecs = 0;
    let appTests = 0;
    const missing: string[] = [];

    log(`# ${app.name} (${app.specDir})`);

    for (const absFile of files) {
      const feature = featureFromPath(absFile, repoDir, profile);
      const key = `${app.name}/${feature}`;

      const specPath = path.join(specDirAbs, `${feature}.md`);
      const hasSpec = await fileExists(specPath);

      const candidates = testCandidates(testOutputAbs, feature, profile);
      let hasTest = false;
      for (const c of candidates) {
        if (await fileExists(c)) {
          hasTest = true;
          break;
        }
      }

      if (hasSpec) appSpecs += 1;
      if (hasTest) appTests += 1;

      const item: PipelineItem = {
        key,
        status: hasSpec ? 'ok' : 'failed',
        path: specPath,
      };
      if (!hasSpec) {
        item.message = hasTest ? 'missing spec' : 'missing spec; missing test';
        missing.push(feature);
        log(`  [missing-spec] ${key}`);
      } else if (!hasTest) {
        item.message = 'missing test';
        log(`  [ok] ${key} (no test)`);
      } else {
        log(`  [ok] ${key}`);
      }
      result.items.push(item);
    }

    const appTotal = files.length;

    // Spec-driven pass: for spec-first / import-first projects that have specs
    // but no matching source files yet, count specs and tests from the specDir
    // directly so the dashboard reflects reality (e.g. after `specguard import`).
    if (appTotal === 0) {
      let specFileCount = 0;
      let specTestCount = 0;
      try {
        const { readdirSync } = await import('node:fs');
        const entries = readdirSync(specDirAbs).filter((f) => f.endsWith('.md') && f !== 'README.md');
        for (const specFile of entries) {
          const feature = specFile.replace(/\.md$/, '');
          const key = `${app.name}/${feature}`;
          specFileCount += 1;

          const candidates = testCandidates(testOutputAbs, feature, profile);
          let hasTest = false;
          for (const c of candidates) {
            if (await fileExists(c)) { hasTest = true; break; }
          }
          if (hasTest) specTestCount += 1;

          result.items.push({
            key,
            status: 'ok',
            path: path.join(specDirAbs, specFile),
            message: hasTest ? undefined : 'no test yet',
          });
          log(hasTest ? `  [ok] ${key}` : `  [ok] ${key} (no test)`);
        }
      } catch { /* specDir may not exist — ignore */ }

      if (specFileCount > 0) {
        log(
          `  ${app.name}: 0 source files (spec-first), ` +
            `${specFileCount} specs imported, ` +
            `${specTestCount} tests`,
        );
        totalSpecs += specFileCount;
        totalTests += specTestCount;
      }
    } else {
      log(
        `  ${app.name}: ${appTotal} source files, ` +
          `${appSpecs} specs (${pct(appSpecs, appTotal)}%), ` +
          `${appTests} tests (${pct(appTests, appTotal)}%), ` +
          `${missing.length} missing specs`,
      );
      if (missing.length > 0) {
        log(`  missing specs: ${missing.join(', ')}`);
      }
      totalFiles += appTotal;
      totalSpecs += appSpecs;
      totalTests += appTests;
      totalMissingSpecs += missing.length;
    }
  }

  log(
    `TOTAL: ${totalFiles} source files, ` +
      `${totalSpecs} specs (${pct(totalSpecs, totalFiles)}%), ` +
      `${totalTests} tests (${pct(totalTests, totalFiles)}%), ` +
      `${totalMissingSpecs} missing specs`,
  );

  result.failed = totalMissingSpecs;
  result.exitCode = totalMissingSpecs > 0 ? ExitCode.MissingSpecs : ExitCode.Success;

  return result;
}
