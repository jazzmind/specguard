/**
 * Git-ops pipeline.
 *
 * Stages and commits SpecGuard-generated files (tests, docs, specs,
 * .specguard/ reports) only — never commits hand-written source code.
 *
 * Commit message format: `specguard: <pipeline> — <summary>`
 *
 * CLI:
 *   specguard commit [--dry-run] [--message <msg>] [--app <name>]
 *
 * Safety rules:
 * - Only stages files under the safe-scoped paths (tests/, docs/, specs/,
 *   .specguard/). The allowed roots can be overridden via opts.scope.
 * - Never touches src/, app/, lib/ or any file outside the safe roots.
 * - --dry-run prints what would be staged/committed without changing anything.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { SpecGuardConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitOpsOpts {
  /** Preview without staging/committing. */
  dryRun?: boolean;
  /** Custom commit message suffix (appended after the auto-generated summary). */
  message?: string;
  /** Restrict staged files to a single app's directories. */
  app?: string;
  /** Override the default set of safe root prefixes. Relative to workspaceRoot. */
  scope?: string[];
}

/** Seam for test stubbing. */
export const gitRunner = {
  exec(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
    const res = spawnSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
    return {
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      status: res.status ?? 1,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default file scopes that SpecGuard is allowed to commit. */
const DEFAULT_SAFE_ROOTS = ['tests/', 'docs/', 'specs/', '.specguard/'];

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function isSafeToStage(rel: string, safeRoots: string[]): boolean {
  const normalized = rel.replace(/\\/g, '/');
  return safeRoots.some((root) => normalized.startsWith(root));
}

function getChangedFiles(cwd: string): string[] {
  const res = gitRunner.exec(['status', '--porcelain'], cwd);
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.slice(3).trim()) // remove XY status prefix
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runGitOps(
  config: SpecGuardConfig,
  opts: GitOpsOpts = {},
): Promise<PipelineResult> {
  const result = emptyResult('git-ops');
  const cwd = resolveFromRoot(config, '.');
  const safeRoots = opts.scope ?? DEFAULT_SAFE_ROOTS;
  const dryRun = opts.dryRun ?? false;

  const log = (line: string) => result.messages.push(line);

  // Check git is available
  const versionCheck = gitRunner.exec(['--version'], cwd);
  if (versionCheck.status !== 0) {
    log('[git-ops] git not available');
    result.exitCode = ExitCode.InternalError;
    return result;
  }

  // Get all uncommitted files
  const changed = getChangedFiles(cwd);
  if (changed.length === 0) {
    log('[git-ops] nothing to commit — working tree clean');
    return result;
  }

  // Filter to safe roots
  const toStage = changed.filter((f) => isSafeToStage(f, safeRoots));
  const skipped = changed.filter((f) => !isSafeToStage(f, safeRoots));

  if (skipped.length > 0) {
    log(`[git-ops] skipped ${skipped.length} file(s) outside safe scope:`);
    for (const f of skipped.slice(0, 10)) log(`  skip: ${f}`);
    if (skipped.length > 10) log(`  ... and ${skipped.length - 10} more`);
  }

  if (toStage.length === 0) {
    log('[git-ops] no SpecGuard-generated files to commit');
    return result;
  }

  log(`[git-ops] ${dryRun ? '[dry-run] ' : ''}staging ${toStage.length} file(s):`);
  for (const f of toStage) log(`  + ${f}`);

  if (dryRun) {
    result.messages.push('[git-ops] dry-run complete — no changes made');
    return result;
  }

  // Stage files
  const addResult = gitRunner.exec(['add', '--', ...toStage], cwd);
  if (addResult.status !== 0) {
    log(`[git-ops] git add failed: ${addResult.stderr}`);
    result.exitCode = ExitCode.InternalError;
    return result;
  }

  // Build commit message
  const changedRoots = [...new Set(toStage.map((f) => f.split('/')[0]))].join(', ');
  const autoSummary = `${toStage.length} file(s) in ${changedRoots}`;
  const commitMsg = opts.message
    ? `specguard: ${opts.message}`
    : `specguard: generated — ${autoSummary}`;

  // Commit
  const commitResult = gitRunner.exec(['commit', '-m', commitMsg], cwd);
  if (commitResult.status !== 0) {
    log(`[git-ops] git commit failed: ${commitResult.stderr}`);
    result.exitCode = ExitCode.InternalError;
    return result;
  }

  const shortHash = gitRunner.exec(['rev-parse', '--short', 'HEAD'], cwd).stdout.trim();
  log(`[git-ops] committed: ${shortHash} — ${commitMsg}`);

  result.created = toStage.length;
  return result;
}
