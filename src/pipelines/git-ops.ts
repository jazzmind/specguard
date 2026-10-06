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
import fs from 'node:fs';
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
  /** Per change type scope. Takes precedence over `scope`: a dependency bump or code fix stages only its own files. */
  changeScope?: ChangeScope;
  /**
   * Context from the originating pipeline, used to produce a descriptive
   * conventional-commit message and a changelog entry.
   */
  context?: {
    /** Pipeline that produced the output being committed, e.g. `generate`. */
    pipeline: string;
    /** One-sentence summary of what was done, e.g. "generated tests for 5 specs". */
    summary?: string;
  };
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

/** The defaults plus every directory this config tells SpecGuard to write into. */
export function safeRootsFor(config: SpecGuardConfig): string[] {
  const root = config.rootDir ?? process.cwd();
  const dirs = new Set(DEFAULT_SAFE_ROOTS);
  const add = (p: string | undefined) => {
    if (!p) return;
    const rel = (path.isAbsolute(p) ? path.relative(root, p) : p).split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (rel && !rel.startsWith('..') && rel !== '.') dirs.add(`${rel}/`);
  };
  for (const app of config.apps) {
    add(app.specDir);
    add(app.testOutput);
    if (typeof app.docs === 'string') add(app.docs);
  }
  add(config.paths?.specsRoot);
  add(config.paths?.docsOut);
  add(config.paths?.securityTests);
  return [...dirs];
}

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function isSafeToStage(rel: string, safeRoots: string[]): boolean {
  // Normalize so `tests/../src/x.ts` cannot slip past a prefix check.
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return false;
  return safeRoots.some((root) => normalized.startsWith(root));
}

/**
 * Paths from `git status --porcelain -z`. Handles renames (both paths), spaces and non-ASCII names,
 * which the newline format quotes. Also accepts newline-separated text for stubs.
 */
export function parsePorcelain(out: string): string[] {
  if (!out.includes('\0')) {
    return out
      .split('\n')
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
      .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
      .filter(Boolean);
  }
  const parts = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1; // the original name follows as its own field
      if (parts[i]) files.push(parts[i]);
    }
  }
  return files;
}

function getChangedFiles(cwd: string): string[] {
  const res = gitRunner.exec(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  if (res.status !== 0) return [];
  return parsePorcelain(res.stdout);
}

// ---------------------------------------------------------------------------
// Change-type scopes (used by `specguard remediate`)
// ---------------------------------------------------------------------------

export type ChangeScope =
  | { type: 'generated' }
  /** A dependency bump may only stage these manifest and lockfile paths (repo-relative POSIX). */
  | { type: 'dependency'; files: string[] }
  /** A code fix may only stage the files the finding names. */
  | { type: 'code-fix'; files: string[] };

/** Is `rel` inside the scope? */
export function inScope(rel: string, scope: ChangeScope, safeRoots: string[] = DEFAULT_SAFE_ROOTS): boolean {
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return false;
  if (scope.type === 'generated') return isSafeToStage(normalized, safeRoots);
  return scope.files.some((f) => path.posix.normalize(f) === normalized);
}

/** Split changed paths into the ones the scope allows and the rest. */
export function partitionByScope(changed: string[], scope: ChangeScope, safeRoots?: string[]): { stage: string[]; skipped: string[] } {
  const stage: string[] = [];
  const skipped: string[] = [];
  for (const f of changed) (inScope(f, scope, safeRoots) ? stage : skipped).push(f);
  return { stage, skipped };
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
  const safeRoots = opts.scope ?? safeRootsFor(config);
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
  const part = opts.changeScope ? partitionByScope(changed, opts.changeScope) : undefined;
  const toStage = part ? part.stage : changed.filter((f) => isSafeToStage(f, safeRoots));
  const skipped = part ? part.skipped : changed.filter((f) => !isSafeToStage(f, safeRoots));

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

  // Build commit message — use conventional-commit style when pipeline context is provided.
  const changedRoots = [...new Set(toStage.map((f) => f.split('/')[0]))].join(', ');
  const autoSummary = `${toStage.length} file(s) in ${changedRoots}`;
  let commitMsg: string;
  if (opts.context?.pipeline) {
    const scope = opts.context.pipeline;
    const body = opts.message ?? opts.context.summary ?? autoSummary;
    commitMsg = `specguard(${scope}): ${body}`;
  } else if (opts.message) {
    commitMsg = `specguard: ${opts.message}`;
  } else {
    commitMsg = `specguard: generated — ${autoSummary}`;
  }

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

  // Append to the append-only changelog.
  _appendChangelog(cwd, {
    hash: shortHash,
    message: commitMsg,
    pipeline: opts.context?.pipeline,
    files: toStage,
    timestamp: new Date().toISOString(),
  });

  return result;
}

// ---------------------------------------------------------------------------
// Changelog helper
// ---------------------------------------------------------------------------

export interface ChangelogEntry {
  hash: string;
  message: string;
  pipeline?: string;
  files: string[];
  timestamp: string;
}

/**
 * Append a single entry to `.specguard/changelog.md`.
 * The file is append-only — never truncated — so every commit is tracked.
 */
export function _appendChangelog(cwd: string, entry: ChangelogEntry): void {
  try {
    const changelogPath = path.join(cwd, '.specguard', 'changelog.md');
    fs.mkdirSync(path.dirname(changelogPath), { recursive: true });
    const isNew = !fs.existsSync(changelogPath);

    const lines: string[] = [];
    if (isNew) {
      lines.push('# SpecGuard Changelog', '', '_Append-only log of every SpecGuard commit. Do not edit manually._', '', '---', '');
    }
    lines.push(
      `## ${entry.hash} · ${entry.timestamp}`,
      '',
      `**Message:** \`${entry.message}\``,
      entry.pipeline ? `**Pipeline:** \`${entry.pipeline}\`` : '',
      '',
      `**Files committed (${entry.files.length}):**`,
      ...entry.files.map((f) => `- \`${f}\``),
      '',
      '---',
      '',
    );

    fs.appendFileSync(changelogPath, lines.filter((l) => l !== undefined).join('\n'));
  } catch { /* best-effort — never block a commit for a changelog write failure */ }
}
