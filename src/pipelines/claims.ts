/**
 * Claims pipeline.
 *
 * `assign` writes stable `<!-- claim: slug -->` anchors onto acceptance
 * criteria that lack one, and never rewrites an anchor that is already there.
 * `list` prints the catalog and fails when a journey invariant cites a claim
 * that is not in the catalog, or when one spec repeats a claim id.
 *
 * Spec: specs/core/claims.md
 */
import path from 'node:path';

import {
  assignClaimIds,
  danglingClaimRefs,
  duplicateClaimIds,
  formatClaimRef,
} from '../core/claims.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists, readFile } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import type { ParsedSpec, PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { loadWorkspaceWithConfigs } from '../core/workspace.js';
import { writeFile } from '../core/writer.js';

export interface ClaimsAssignOpts {
  /** Assign only inside this directory. Otherwise every app specDir is used. */
  dir?: string;
  dryRun?: boolean;
  config?: SpecGuardConfig;
}

export interface ClaimsListOpts {
  cwd: string;
  workspace: boolean;
  config?: SpecGuardConfig;
}

interface SpecSource {
  repo?: string;
  specDir: string;
}

/**
 * Claim refs are rooted at `<repo>/specs` so `automation/index` stays stable
 * even when SpecGuard apps split that tree into several specDirs. App specDirs
 * are the fallback when a repo has no top-level specs directory.
 */
async function claimSpecDirs(repoDir: string, config: SpecGuardConfig | null): Promise<string[]> {
  const top = path.resolve(repoDir, config?.paths?.specsRoot ?? 'specs');
  if (await fileExists(top)) return [top];
  if (!config) return [];
  const root = config.rootDir ?? repoDir;
  return config.apps.map((app) => path.resolve(root, app.specDir));
}

async function sourcesFor(opts: ClaimsListOpts): Promise<SpecSource[]> {
  if (opts.workspace) {
    const { repos } = await loadWorkspaceWithConfigs(opts.cwd);
    const sources: SpecSource[] = [];
    for (const repo of repos) {
      for (const specDir of await claimSpecDirs(repo.absPath, repo.specGuardConfig)) {
        sources.push({ repo: repo.key, specDir });
      }
    }
    return sources;
  }
  if (!opts.config) return [];
  const root = opts.config.rootDir ?? process.cwd();
  return (await claimSpecDirs(root, opts.config)).map((specDir) => ({ specDir }));
}

function loadDir(specDir: string): ParsedSpec[] {
  try {
    return loadAllSpecs(specDir);
  } catch {
    return [];
  }
}

export async function runClaimsAssign(opts: ClaimsAssignOpts): Promise<PipelineResult> {
  const result = emptyResult('claims-assign');
  const dirs = opts.dir
    ? [path.resolve(opts.dir)]
    : opts.config
      ? await claimSpecDirs(opts.config.rootDir ?? process.cwd(), opts.config)
      : [];
  if (dirs.length === 0) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push('No spec directory. Pass --dir or run inside a SpecGuard repo.');
    return result;
  }

  for (const dir of dirs) {
    for (const spec of loadDir(dir)) {
      const original = await readFile(spec.filePath);
      const { content, assigned } = assignClaimIds(original);
      const dupes = duplicateClaimIds(spec.claims);
      if (dupes.length > 0) {
        result.failed += 1;
        result.items.push({
          key: spec.specKey,
          status: 'failed',
          path: spec.filePath,
          message: `duplicate claim ids: ${dupes.join(', ')}`,
        });
        result.messages.push(`${spec.specKey}: duplicate claim ids ${dupes.join(', ')}`);
      }
      if (assigned.length === 0) {
        result.skipped += 1;
        continue;
      }
      if (!opts.dryRun && content !== original) {
        await writeFile(spec.filePath, content);
      }
      result.updated += 1;
      result.items.push({
        key: spec.specKey,
        status: 'updated',
        path: spec.filePath,
        message: assigned.map((claim) => claim.id).join(', '),
      });
      result.messages.push(
        `${spec.specKey}: ${opts.dryRun ? 'would assign' : 'assigned'} ${assigned.map((c) => c.id).join(', ')}`,
      );
    }
  }

  result.exitCode = result.failed > 0 ? ExitCode.ValidationFailed : ExitCode.Success;
  result.messages.push(
    `claims assign: ${result.updated} updated, ${result.skipped} unchanged, ${result.failed} failed`,
  );
  return result;
}

export async function runClaimsList(opts: ClaimsListOpts): Promise<PipelineResult> {
  const result = emptyResult('claims-list');
  const sources = await sourcesFor(opts);
  const catalog = new Set<string>();
  const journeys: ParsedSpec[] = [];

  for (const source of sources) {
    for (const spec of loadDir(source.specDir)) {
      for (const claim of spec.claims) {
        if (!claim.id) {
          result.messages.push(`${formatClaimRef(source.repo, spec.specKey, '(unanchored)')}  ${claim.text}`);
          continue;
        }
        const ref = formatClaimRef(source.repo, spec.specKey, claim.id);
        catalog.add(ref);
        result.messages.push(`${ref}  ${claim.text}`);
      }
      const dupes = duplicateClaimIds(spec.claims);
      if (dupes.length > 0) {
        result.failed += 1;
        result.items.push({
          key: formatClaimRef(source.repo, spec.specKey, dupes[0]),
          status: 'failed',
          path: spec.filePath,
          message: `duplicate claim ids: ${dupes.join(', ')}`,
        });
      }
      if (spec.journey) journeys.push(spec);
    }
  }

  for (const spec of journeys) {
    const missing = danglingClaimRefs(spec.journey?.invariants ?? [], catalog);
    for (const ref of missing) {
      result.failed += 1;
      result.items.push({
        key: spec.specKey,
        status: 'failed',
        path: spec.filePath,
        message: `dangling claim ref ${ref}`,
      });
      result.messages.push(`${spec.specKey}: dangling claim ref ${ref}`);
    }
  }

  result.exitCode = result.failed > 0 ? ExitCode.ValidationFailed : ExitCode.Success;
  result.messages.push(`claims list: ${catalog.size} claims, ${result.failed} problems`);
  return result;
}
