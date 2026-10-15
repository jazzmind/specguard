/**
 * Which paths SpecGuard may stage, and how git status output is read.
 *
 * Shared by `remediate` (a dependency bump or code fix stages only its own
 * files) and by the `git` plugin's `commit` command (only generated files).
 * Pure functions: nothing here runs git.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import path from 'node:path';

import type { SpecGuardConfig } from './types.js';

/** Default file scopes that SpecGuard is allowed to commit. */
export const DEFAULT_SAFE_ROOTS = ['tests/', 'docs/', 'specs/', '.specguard/'];

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

export function isSafeToStage(rel: string, safeRoots: string[]): boolean {
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
      .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p).replace(/^"|"$/g, ''))
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
