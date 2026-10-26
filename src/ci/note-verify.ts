/**
 * Note authenticity. Anyone with push access can write the notes ref, and GitHub cannot protect it, so CI also records
 * a check run named `specguard/proof-note` whose summary carries the note's sha256. Only the workflow's own token can
 * create a check run attributed to the `github-actions` app; a personal token cannot. A reader trusts a note only when
 * a check run on the same commit carries the same digest. Opt-in: `proofStore.verify` is `off` unless set to `check-run`.
 *
 * What this defeats: a hand-pushed note. What it does not: a workflow change merged with review that then writes notes.
 *
 * Spec: specs/capabilities/proof-store.md
 */
import type { ProofNote } from '../core/proof-note.js';
import type { ProofStoreConfig } from '../core/types.js';
import type { ApiCheckRun, GitHubApi } from './github-api.js';

export const NOTE_CHECK_NAME = 'specguard/proof-note';
/** The app that owns check runs created with the workflow token. */
export const NOTE_CHECK_APP = 'github-actions';

export interface NoteVerification {
  status: 'verified' | 'unverified' | 'mismatch' | 'not-checked';
  checkRunId?: number;
  detail?: string;
}

export interface VerifyOptions {
  /** Require the check run's suite to have run on this branch. Set it for commits on the default branch, so a run a branch's own workflow made for another commit does not count. */
  branch?: string;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;
const SUMMARY_RE = /^note-sha256:[ \t]*([0-9a-fA-F]{64})[ \t]*$/m;

/** The check run summary that binds a note to its digest. The first line is what a verifier reads. */
export function checkRunSummary(digest: string, note: ProofNote): string {
  return [`note-sha256: ${digest.toLowerCase()}`, `schema: ${note.version}`, `rows: ${note.rows.length}`, `level: ${note.statement.level}`].join('\n');
}

/** The digest a check run's summary claims, if it has the line. */
export function digestFromSummary(summary: string | null | undefined): string | undefined {
  const m = SUMMARY_RE.exec(summary ?? '');
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Pure verdict over the check runs found for a commit. Only runs of the workflow app count. Any run carrying the digest
 * (on the required branch, when one is set) verifies; runs that exist but none match is a `mismatch`; no run is `unverified`.
 */
export function evaluateCheckRuns(runs: ApiCheckRun[], digest: string, opts: VerifyOptions = {}): NoteVerification {
  const want = digest.toLowerCase();
  if (!DIGEST_RE.test(want)) return { status: 'unverified', detail: 'the note has no valid sha256 digest' };
  const ours = runs.filter((r) => r.app?.slug === NOTE_CHECK_APP);
  if (ours.length === 0) return { status: 'unverified', detail: `no ${NOTE_CHECK_NAME} check run from ${NOTE_CHECK_APP} on this commit` };
  const onBranch = opts.branch ? ours.filter((r) => r.check_suite?.head_branch === opts.branch) : ours;
  if (onBranch.length === 0) return { status: 'mismatch', detail: `${NOTE_CHECK_NAME} runs exist but none ran on ${opts.branch}` };
  const match = onBranch.find((r) => digestFromSummary(r.output?.summary) === want);
  if (match) return { status: 'verified', checkRunId: match.id };
  return { status: 'mismatch', detail: `${NOTE_CHECK_NAME} exists but its digest differs from the note's` };
}

/** Look up the commit's `specguard/proof-note` check runs and judge the digest. An API failure is `not-checked`, never a pass. */
export async function verifyNote(api: Pick<GitHubApi, 'listCheckRuns'>, repo: string, commit: string, digest: string, opts: VerifyOptions = {}): Promise<NoteVerification> {
  try {
    return evaluateCheckRuns(await api.listCheckRuns(repo, commit, NOTE_CHECK_NAME), digest, opts);
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === 'number' ? ` (HTTP ${(err as { status: number }).status})` : '';
    return { status: 'not-checked', detail: `could not read check runs${status}` };
  }
}

/**
 * Verification as configured. `off` (the default) returns `unverified` without touching the network. `check-run`
 * without an API client (no token) is also `unverified`, which a CI that requires verification treats as "ignore this note".
 */
export async function verifyNoteWithConfig(
  mode: ProofStoreConfig['verify'],
  api: Pick<GitHubApi, 'listCheckRuns'> | undefined,
  repo: string | undefined,
  commit: string,
  digest: string,
  opts: VerifyOptions = {},
): Promise<NoteVerification> {
  if ((mode ?? 'off') !== 'check-run') return { status: 'unverified', detail: 'note verification is off (proofStore.verify)' };
  if (!api || !repo) return { status: 'unverified', detail: 'no GitHub token or repository to check the note against' };
  return verifyNote(api, repo, commit, digest, opts);
}
