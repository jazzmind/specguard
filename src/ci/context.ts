/**
 * The CI context: what the run is, read from the GitHub Actions environment and the event payload. Pure: the caller
 * passes the environment and a reader for the payload file. Every field is optional on the wire, so nothing here
 * throws on a missing or malformed value; a run that cannot be understood reads as `provider: other` with no write rights.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */

export const CI_EVENTS = ['pull_request', 'push', 'merge_group', 'workflow_dispatch', 'schedule', 'other'] as const;
export type CiEvent = (typeof CI_EVENTS)[number];

export interface CiContext {
  provider: 'github' | 'other';
  event: CiEvent;
  repo?: string;
  defaultBranch?: string;
  /** Ref the run was triggered for (`GITHUB_REF`), as given. */
  ref?: string;
  /** Commit under test (the one checked out). Empty only when the environment names none. */
  head: string;
  /** PR: pull_request.base.sha; push: event.before (absent when it is the all-zero sha); merge_group: merge_group.base_sha. */
  baseSha?: string;
  pr?: { number: number; author: string; headRepo: string; isFork: boolean; draft: boolean };
  runId?: string;
  runAttempt?: number;
  runUrl?: string;
  workflow?: string;
  actor?: string;
  /** API root for GitHub Enterprise; absent means api.github.com. */
  apiUrl?: string;
  /** `SG_GITHUB_TOKEN`. Never printed. */
  token?: string;
  /** What this run may write. All false on a fork, without a token, or off GitHub. */
  canWrite: { notes: boolean; comment: boolean; checks: boolean };
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const ZERO_SHA = /^0+$/;

/** A sha that names a commit: a run on a new branch has `before` all zeros, which is no base. */
const realSha = (v: unknown): string | undefined => {
  const s = str(v);
  return s && !ZERO_SHA.test(s) ? s : undefined;
};

const eventOf = (name: string | undefined): CiEvent => ((CI_EVENTS as readonly string[]).includes(name ?? '') && name !== 'other' ? (name as CiEvent) : 'other');

export function readCiContext(env: NodeJS.ProcessEnv, readEvent: (path: string) => unknown): CiContext {
  const provider = env.GITHUB_ACTIONS === 'true' ? 'github' : 'other';
  const event = provider === 'github' ? eventOf(str(env.GITHUB_EVENT_NAME)) : 'other';
  const repo = str(env.GITHUB_REPOSITORY);

  let payload: Json | undefined;
  const eventPath = str(env.GITHUB_EVENT_PATH);
  if (provider === 'github' && eventPath) {
    try {
      payload = obj(readEvent(eventPath));
    } catch {
      payload = undefined;
    }
  }

  const pull = obj(payload?.pull_request);
  const group = obj(payload?.merge_group);
  let pr: CiContext['pr'];
  let head = str(env.GITHUB_SHA) ?? '';
  let baseSha: string | undefined;

  if (event === 'pull_request') {
    const number = num(pull?.number) ?? num(payload?.number);
    const headObj = obj(pull?.head);
    // The generated workflow checks out the PR head, not GitHub's merge commit, so the head sha is the commit under test.
    head = str(headObj?.sha) ?? head;
    baseSha = realSha(obj(pull?.base)?.sha);
    if (number !== undefined) {
      const headRepo = str(obj(headObj?.repo)?.full_name) ?? '';
      // A head repository that is gone (a deleted fork) is a fork: it is not this repository.
      const isFork = !repo || headRepo.toLowerCase() !== repo.toLowerCase();
      pr = { number, author: str(obj(pull?.user)?.login) ?? '', headRepo, isFork, draft: pull?.draft === true };
    }
  } else if (event === 'push') {
    head = str(env.GITHUB_SHA) ?? str(payload?.after) ?? '';
    baseSha = realSha(payload?.before);
  } else if (event === 'merge_group') {
    head = str(group?.head_sha) ?? head;
    baseSha = realSha(group?.base_sha);
  }

  const runId = str(env.GITHUB_RUN_ID);
  const attempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? '', 10);
  const server = str(env.GITHUB_SERVER_URL) ?? 'https://github.com';
  const token = str(env.SG_GITHUB_TOKEN);
  const forkOrNoPr = event === 'pull_request' && (pr === undefined || pr.isFork);
  const writable = provider === 'github' && token !== undefined && !forkOrNoPr;

  return {
    provider,
    event,
    ...(repo ? { repo } : {}),
    ...(str(obj(payload?.repository)?.default_branch) ? { defaultBranch: str(obj(payload?.repository)?.default_branch) } : {}),
    ...(str(env.GITHUB_REF) ? { ref: str(env.GITHUB_REF) } : {}),
    head,
    ...(baseSha ? { baseSha } : {}),
    ...(pr ? { pr } : {}),
    ...(runId ? { runId } : {}),
    ...(Number.isInteger(attempt) && attempt > 0 ? { runAttempt: attempt } : {}),
    ...(runId && repo ? { runUrl: `${server.replace(/\/+$/, '')}/${repo}/actions/runs/${runId}` } : {}),
    ...(str(env.GITHUB_WORKFLOW) ? { workflow: str(env.GITHUB_WORKFLOW) } : {}),
    ...(str(env.GITHUB_ACTOR) ? { actor: str(env.GITHUB_ACTOR) } : {}),
    ...(str(env.GITHUB_API_URL) ? { apiUrl: str(env.GITHUB_API_URL) } : {}),
    ...(token ? { token } : {}),
    canWrite: {
      notes: writable && repo !== undefined,
      comment: writable && repo !== undefined && event === 'pull_request' && pr !== undefined,
      checks: writable && repo !== undefined && head !== '',
    },
  };
}
