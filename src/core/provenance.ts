/**
 * Where a proof came from. A proof earned in CI on a pushed commit and one earned on a
 * developer's laptop are not equally trustworthy, so each ledger row says which it is.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { execFileSync } from 'node:child_process';

export type ProofOrigin = 'local' | 'ci' | 'server';

export interface Provenance {
  origin: ProofOrigin;
  /** `owner/name` of the repository. */
  repo?: string;
  branch?: string;
  /** The commit the tests ran against. */
  commit?: string;
  /** Who or what started the run (a CI actor; never read from a developer's git identity). */
  actor?: string;
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What can be known about this run from its environment. GitHub Actions is recognised by its own
 * variables; any other CI by `CI=true` (origin only). Outside CI the branch comes from git.
 */
export function detectProvenance(dir: string, env: NodeJS.ProcessEnv = process.env): Provenance {
  if (env.GITHUB_ACTIONS === 'true') {
    return {
      origin: 'ci',
      ...(env.GITHUB_REPOSITORY ? { repo: env.GITHUB_REPOSITORY } : {}),
      ...((env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME) ? { branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME } : {}),
      ...(env.GITHUB_SHA ? { commit: env.GITHUB_SHA } : {}),
      ...(env.GITHUB_ACTOR ? { actor: env.GITHUB_ACTOR } : {}),
    };
  }
  if (env.CI === 'true' || env.CI === '1') {
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return { origin: 'ci', ...(branch && branch !== 'HEAD' ? { branch } : {}) };
  }
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { origin: 'local', ...(branch && branch !== 'HEAD' ? { branch } : {}) };
}
