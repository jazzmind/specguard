/**
 * Git worktree, lock and ship helpers for remediate. Every call goes through the
 * injectable `Exec`; nothing here touches the user's working tree except the
 * lock file under `.specguard/`.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Exec, ExecResult } from './types.js';

export const realGit: Exec = (args, cwd) => spawn('git', args, cwd);
export const realGh: Exec = (args, cwd) => spawn('gh', args, cwd);

function spawn(bin: string, args: string[], cwd: string): ExecResult {
  const res = spawnSync(bin, args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? String(res.error) : ''), status: res.status ?? 1 };
}

export class RemediateSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemediateSetupError';
  }
}

function must(r: ExecResult, what: string): string {
  if (r.status !== 0) throw new RemediateSetupError(`${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

export function gitRoot(git: Exec, dir: string): string {
  return must(git(['rev-parse', '--show-toplevel'], dir), 'git rev-parse --show-toplevel');
}

export function headCommit(git: Exec, dir: string): string {
  return must(git(['rev-parse', 'HEAD'], dir), 'git rev-parse HEAD');
}

export function currentBranch(git: Exec, dir: string): string | undefined {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const name = r.stdout.trim();
  return r.status === 0 && name !== 'HEAD' ? name : undefined;
}

/** Paths remediate itself writes into the user's tree; they never make the tree "dirty". */
const OWN_PATHS = ['.specguard/remediate.lock', '.specguard/remediation/', '.specguard/runs/'];

/** Porcelain entries that count as uncommitted changes (ignoring remediate's own files). */
export function dirtyEntries(git: Exec, dir: string): string[] {
  const r = git(['status', '--porcelain', '--untracked-files=all'], dir);
  must(r, 'git status');
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((p) => !OWN_PATHS.some((own) => p === own || p.startsWith(own)));
}

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------

export const LOCK_FILE = path.join('.specguard', 'remediate.lock');
export const LOCK_TTL_MS = 2 * 60 * 60 * 1000;

export interface LockInfo {
  runId: string;
  pid: number;
  startedAt: string;
}

export function readLock(root: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(path.join(root, LOCK_FILE), 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/** Acquire the lock. Refuses when a fresh lock exists; a stale lock (older than the TTL) is replaced. */
export function acquireLock(root: string, runId: string, now: Date, force = false): void {
  const existing = readLock(root);
  if (existing && !force) {
    const age = now.getTime() - Date.parse(existing.startedAt);
    if (Number.isFinite(age) && age < LOCK_TTL_MS) {
      throw new RemediateSetupError(`${LOCK_FILE} is fresh (run ${existing.runId} started ${existing.startedAt}); another remediation is running. Remove it if that run died.`);
    }
  }
  mkdirSync(path.join(root, '.specguard'), { recursive: true });
  writeFileSync(path.join(root, LOCK_FILE), JSON.stringify({ runId, pid: process.pid, startedAt: now.toISOString() }) + '\n');
}

export function releaseLock(root: string, runId: string): void {
  const l = readLock(root);
  if (l && l.runId !== runId) return;
  rmSync(path.join(root, LOCK_FILE), { force: true });
}

// ---------------------------------------------------------------------------
// Worktree
// ---------------------------------------------------------------------------

export interface Worktree {
  dir: string;
  /** Branch checked out in the worktree (created from HEAD). */
  branch: string;
  repoRoot: string;
}

/** Create a temporary worktree on a new branch at `base` (default HEAD). */
export function createWorktree(git: Exec, repoRoot: string, branch: string, tmpRoot: string = os.tmpdir(), base = 'HEAD'): Worktree {
  const parent = mkdtempSync(path.join(tmpRoot, 'sg-remediate-'));
  const dir = path.join(parent, 'wt');
  must(git(['worktree', 'add', '-b', branch, dir, base], repoRoot), `git worktree add ${branch}`);
  return { dir, branch, repoRoot };
}

/** Remove the worktree; `deleteBranch` also drops the branch (rollback, dry-run). Never throws. */
export function removeWorktree(git: Exec, wt: Worktree, deleteBranch: boolean): void {
  try {
    git(['worktree', 'remove', '--force', wt.dir], wt.repoRoot);
  } catch {
    /* best effort */
  }
  try {
    rmSync(path.dirname(wt.dir), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    git(['worktree', 'prune'], wt.repoRoot);
    if (deleteBranch) git(['branch', '-D', wt.branch], wt.repoRoot);
  } catch {
    /* best effort */
  }
}

export function branchExists(git: Exec, repoRoot: string, branch: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot).status === 0;
}

export function remoteBranchExists(git: Exec, repoRoot: string, branch: string): boolean {
  const r = git(['ls-remote', '--exit-code', '--heads', 'origin', branch], repoRoot);
  return r.status === 0;
}

export function hasRemote(git: Exec, repoRoot: string, name = 'origin'): boolean {
  return git(['remote', 'get-url', name], repoRoot).status === 0;
}
