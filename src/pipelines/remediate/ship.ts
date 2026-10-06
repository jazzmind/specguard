/**
 * Ship: scoped commit on the remediation branch, then (only with `--pr`) push and `gh pr create`.
 * There is no auto-merge anywhere in this module.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Verdict } from '../../core/behavior-verdict.js';
import { parsePorcelain, partitionByScope, type ChangeScope } from '../git-ops.js';
import { currentBranch, hasRemote, RemediateSetupError } from './git.js';
import type { Exec } from './types.js';

export interface ShipArgs {
  git: Exec;
  gh: Exec;
  /** The worktree (branch checked out). */
  wtDir: string;
  /** The user's repo, used to read the base branch. */
  repoRoot: string;
  branch: string;
  scope: ChangeScope;
  commitMessage: string;
  title: string;
  bodyPath: string;
  body: string;
  verdict: Verdict;
  pr: boolean;
  baseBranch?: string;
}

export interface ShipResult {
  commit: string;
  staged: string[];
  skippedPaths: string[];
  pushed: boolean;
  prUrl?: string;
  draft: boolean;
}

/** Commit identity for CI machines that have none configured. */
function identityArgs(git: Exec, cwd: string): string[] {
  const email = git(['config', 'user.email'], cwd).stdout.trim();
  const name = git(['config', 'user.name'], cwd).stdout.trim();
  return email && name ? [] : ['-c', 'user.name=specguard-remediate', '-c', 'user.email=specguard-remediate@users.noreply.github.com'];
}

function ok(r: { status: number; stderr: string; stdout: string }, what: string): string {
  if (r.status !== 0) throw new RemediateSetupError(`${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

export function shouldBeDraft(v: Verdict): boolean {
  return v !== 'PRESERVED';
}

export function ship(a: ShipArgs): ShipResult {
  const status = a.git(['status', '--porcelain', '-z', '--untracked-files=all'], a.wtDir);
  const changed = parsePorcelain(status.stdout);
  const { stage, skipped } = partitionByScope(changed, a.scope);
  if (stage.length === 0) throw new RemediateSetupError('nothing to commit inside the allowed scope');
  ok(a.git(['add', '--', ...stage], a.wtDir), 'git add');
  ok(a.git([...identityArgs(a.git, a.wtDir), 'commit', '-m', a.commitMessage], a.wtDir), 'git commit');
  const commit = ok(a.git(['rev-parse', 'HEAD'], a.wtDir), 'git rev-parse HEAD');
  const draft = shouldBeDraft(a.verdict);
  const result: ShipResult = { commit, staged: stage, skippedPaths: skipped, pushed: false, draft };
  if (!a.pr) return result;

  if (!hasRemote(a.git, a.repoRoot)) throw new RemediateSetupError('--pr needs a git remote named origin');
  ok(a.git(['push', '--set-upstream', 'origin', a.branch], a.wtDir), `git push origin ${a.branch}`);
  result.pushed = true;

  mkdirSync(path.dirname(a.bodyPath), { recursive: true });
  writeFileSync(a.bodyPath, a.body);
  const base = a.baseBranch ?? currentBranch(a.git, a.repoRoot) ?? 'main';
  const args = ['pr', 'create', '--title', a.title, '--body-file', a.bodyPath, '--base', base, '--head', a.branch];
  if (draft) args.push('--draft');
  const out = ok(a.gh(args, a.wtDir), 'gh pr create');
  result.prUrl = /https?:\/\/\S+/.exec(out)?.[0];
  return result;
}
