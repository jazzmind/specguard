/**
 * Apply a plan item in the worktree and enforce the write allowlist and size limits.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { EcosystemAdapter } from '../../core/ecosystems/index.js';
import { partitionByScope, parsePorcelain, type ChangeScope } from '../git-ops.js';
import { RemediateSetupError } from './git.js';
import type { ChangeType, Exec, FileChange, PlanItem, SastIssue } from './types.js';

export interface Limits {
  maxFiles: number;
  maxLines: number;
}

export const DEFAULT_LIMITS: Limits = { maxFiles: 20, maxLines: 2000 };

/** Allowed paths (repo-relative POSIX) for a dependency bump: manifests and lockfiles of the project dirs. */
export function dependencyScope(ecos: Array<{ dir: string; eco: EcosystemAdapter }>, gitTop: string): ChangeScope {
  const files = new Set<string>();
  for (const { dir, eco } of ecos) {
    const rel = path.relative(gitTop, dir).split(path.sep).join('/');
    for (const name of [...eco.manifests(), ...eco.lockfiles()]) files.add(rel ? `${rel}/${name}` : name);
  }
  return { type: 'dependency', files: [...files] };
}

export function codeFixScope(issues: SastIssue[]): ChangeScope {
  return { type: 'code-fix', files: [...new Set(issues.map((i) => i.path))] };
}

export function scopeFor(type: ChangeType, ecos: Array<{ dir: string; eco: EcosystemAdapter }>, gitTop: string, issues: SastIssue[] = []): ChangeScope {
  return type === 'dependency' ? dependencyScope(ecos, gitTop) : codeFixScope(issues);
}

export interface ChangeSet {
  /** Every modified, deleted or new file not present before the apply. */
  changed: string[];
  allowed: string[];
  violations: string[];
  files: FileChange[];
  totalLines: number;
}

/** Changed paths since `before` (a snapshot from `snapshotTree`). */
export function snapshotTree(git: Exec, wt: string): Map<string, string> {
  const r = git(['status', '--porcelain', '-z', '--untracked-files=normal'], wt);
  const map = new Map<string, string>();
  for (const p of parsePorcelain(r.stdout)) {
    let sig = 'dir';
    if (!p.endsWith('/')) {
      try {
        sig = String(readFileSync(path.join(wt, p)).length) + ':' + readFileSync(path.join(wt, p)).toString('base64').slice(0, 64);
      } catch {
        sig = 'gone';
      }
    }
    map.set(p, sig);
  }
  return map;
}

/**
 * Compare the tree now with `before`. A path counts when it is new or its content changed.
 * Untracked directories that already existed (installed packages, caches) are ignored.
 */
export function collectChanges(git: Exec, wt: string, before: Map<string, string>, scope: ChangeScope): ChangeSet {
  const now = snapshotTree(git, wt);
  const changed = [...now.entries()].filter(([p, sig]) => before.get(p) !== sig).map(([p]) => p);
  const { stage, skipped } = partitionByScope(changed, scope);
  const files: FileChange[] = [];
  let totalLines = 0;
  if (stage.length) {
    const r = git(['diff', '--numstat', 'HEAD', '--', ...stage], wt);
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [a, d, ...rest] = line.split('\t');
      const additions = a === '-' ? 0 : Number(a);
      const deletions = d === '-' ? 0 : Number(d);
      files.push({ path: rest.join('\t'), additions, deletions });
      totalLines += additions + deletions;
    }
    for (const p of stage) if (!files.some((f) => f.path === p)) files.push({ path: p, additions: 0, deletions: 0 });
  }
  return { changed, allowed: stage, violations: skipped, files, totalLines };
}

export function enforce(cs: ChangeSet, limits: Limits): void {
  if (cs.violations.length) {
    throw new RemediateSetupError(`the change touched files outside its write allowlist: ${cs.violations.slice(0, 8).join(', ')}${cs.violations.length > 8 ? ` (+${cs.violations.length - 8} more)` : ''}`);
  }
  if (cs.allowed.length > limits.maxFiles) throw new RemediateSetupError(`the change touches ${cs.allowed.length} files, over the limit of ${limits.maxFiles}`);
  if (cs.totalLines > limits.maxLines) throw new RemediateSetupError(`the change touches ${cs.totalLines} lines, over the limit of ${limits.maxLines}`);
}

/** Dependency bump: ecosystem apply() on the project dir, then install. */
export async function applyDependency(
  item: PlanItem,
  ecos: Array<{ dir: string; eco: EcosystemAdapter }>,
  root: string,
  install: (eco: EcosystemAdapter, dir: string) => Promise<{ ok: boolean; output: string }>,
): Promise<void> {
  const repo = item.advisories[0]?.repo;
  const dir = path.resolve(root, repo ?? '.');
  const match = ecos.find((e) => e.dir === dir && (e.eco.osvEcosystem.toLowerCase() === item.candidate.ecosystem.toLowerCase() || e.eco.id === item.candidate.ecosystem));
  if (!match) throw new RemediateSetupError(`no ecosystem adapter for ${item.candidate.ecosystem} in ${repo ?? '.'}`);
  const changed = await match.eco.apply(dir, item.candidate);
  if (changed.length === 0) throw new RemediateSetupError(`${match.eco.id} apply changed nothing for ${item.candidate.package}@${item.candidate.toVersion}`);
  const res = await install(match.eco, dir);
  if (!res.ok) throw new RemediateSetupError(`install failed after the bump: ${res.output.slice(-400).trim()}`);
}

// ---------------------------------------------------------------------------
// Code fixes (Semgrep findings)
// ---------------------------------------------------------------------------

/** Produce a fixed version of `content` for the finding, or null when no safe fix exists. */
export type CodeFixer = (issue: SastIssue, content: string) => Promise<string | null>;

/** Apply a code fix to the single file named by the finding. */
export async function applyCodeFix(issue: SastIssue, root: string, fix: CodeFixer): Promise<boolean> {
  const abs = path.resolve(root, issue.path);
  if (path.relative(root, abs).startsWith('..')) throw new RemediateSetupError(`finding path escapes the repository: ${issue.path}`);
  const before = readFileSync(abs, 'utf8');
  const after = await fix(issue, before);
  if (after === null || after === before) return false;
  writeFileSync(abs, after);
  return true;
}
