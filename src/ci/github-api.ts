/**
 * A thin GitHub REST client over the global `fetch`, for exactly the calls the CI gate makes: list a pull request's
 * reviews and files, list check runs, create a check run, and keep one comment up to date by marker. No retries, no
 * caching, no dependency. The token goes only into the `Authorization` header of requests to the configured API root;
 * it is never logged and never part of an error message.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */

export const DEFAULT_API_URL = 'https://api.github.com';
const PER_PAGE = 100;
/** Pages read for one list, so a runaway `Link` chain ends. 50 pages is 5000 items. */
const MAX_PAGES = 50;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface ApiReview {
  id: number;
  user: { login: string; type: string };
  state: string;
  commit_id: string;
  submitted_at: string;
  author_association: string;
}
export interface ApiPrFile {
  filename: string;
  status: string;
  previous_filename?: string;
}
export interface ApiCheckRun {
  id: number;
  app: { slug: string };
  output: { summary: string | null };
  check_suite?: { head_branch: string | null };
}
export interface CheckRunBody {
  name: string;
  head_sha: string;
  status: 'completed';
  conclusion: 'success' | 'neutral' | 'failure';
  output: { title: string; summary: string };
}

export interface GitHubApi {
  listReviews(repo: string, pr: number): Promise<ApiReview[]>;
  listPrFiles(repo: string, pr: number): Promise<ApiPrFile[]>;
  listCheckRuns(repo: string, sha: string, name: string): Promise<ApiCheckRun[]>;
  createCheckRun(repo: string, body: CheckRunBody): Promise<{ id: number }>;
  /** Update the comment on the pull request that holds `marker`, or post a new one. Never throws: a comment is a convenience. */
  upsertComment(repo: string, pr: number, marker: string, body: string): Promise<{ posted: boolean; updated: boolean; reason?: string }>;
}

/** A failed call. `status` 0 means no HTTP answer (network failure, bad argument). The message never holds the token. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  /** Path and query without the host, so the message names the call and nothing secret. */
  readonly path: string;
  readonly rateLimited: boolean;
  constructor(init: { status: number; method: string; path: string; detail?: string; rateLimited?: boolean }) {
    super(`GitHub API ${init.method} ${init.path}: ${init.status === 0 ? 'no response' : `HTTP ${init.status}`}${init.detail ? ` (${init.detail})` : ''}`);
    this.name = 'GitHubApiError';
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.rateLimited = init.rateLimited === true;
  }
}

type FetchLike = typeof fetch;

/** The `rel="next"` target of a `Link` header, if any. */
function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

export function githubApi(token: string, baseUrl: string = DEFAULT_API_URL, fetchImpl: FetchLike = globalThis.fetch): GitHubApi {
  if (!token) throw new GitHubApiError({ status: 0, method: 'INIT', path: '/', detail: 'no token given' });
  const root = baseUrl.replace(/\/+$/, '');
  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'specguard-ci',
  });
  const scrub = (text: string): string => (token ? text.split(token).join('***') : text);

  async function call(method: string, urlOrPath: string, body?: unknown): Promise<Response> {
    const url = urlOrPath.startsWith('http') ? urlOrPath : `${root}${urlOrPath}`;
    // A pagination link that leaves the configured API root is never followed: the token would travel with it.
    if (!url.startsWith(`${root}/`)) throw new GitHubApiError({ status: 0, method, path: '/', detail: 'refusing a URL outside the API root' });
    const path = scrub(url.slice(root.length));
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (err) {
      throw new GitHubApiError({ status: 0, method, path, detail: scrub(err instanceof Error ? err.message : String(err)).slice(0, 120) });
    }
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const message = ((await res.json()) as { message?: unknown } | null)?.message;
        if (typeof message === 'string') detail = scrub(message).slice(0, 160);
      } catch {
        // No JSON body: the status says enough.
      }
      const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      throw new GitHubApiError({ status: res.status, method, path, detail, rateLimited });
    }
    return res;
  }

  /** Every item of a list endpoint, following `Link: rel="next"` and, without it, page numbers until a short page. */
  async function paged<T>(path: string, pick: (json: unknown) => T[]): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    let next: string | undefined = `${path}${sep}per_page=${PER_PAGE}`;
    for (let page = 1; next && page <= MAX_PAGES; page++) {
      const res: Response = await call('GET', next);
      const items = pick(await res.json());
      out.push(...items);
      const link = nextLink(res.headers.get('link'));
      next = link ?? (res.headers.has('link') || items.length < PER_PAGE ? undefined : `${path}${sep}per_page=${PER_PAGE}&page=${page + 1}`);
    }
    return out;
  }

  const repoPath = (repo: string): string => {
    if (!REPO_RE.test(repo) || repo.split('/').some((part) => /^\.+$/.test(part))) throw new GitHubApiError({ status: 0, method: 'INIT', path: '/', detail: 'repository must be owner/name' });
    return `/repos/${repo}`;
  };
  const list = (json: unknown): unknown[] => (Array.isArray(json) ? json : []);

  return {
    listReviews: async (repo, pr) => paged<ApiReview>(`${repoPath(repo)}/pulls/${Math.trunc(pr)}/reviews`, list as (j: unknown) => ApiReview[]),
    listPrFiles: async (repo, pr) => paged<ApiPrFile>(`${repoPath(repo)}/pulls/${Math.trunc(pr)}/files`, list as (j: unknown) => ApiPrFile[]),
    listCheckRuns: async (repo, sha, name) =>
      paged<ApiCheckRun>(`${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?check_name=${encodeURIComponent(name)}`, (j) => {
        const runs = (j as { check_runs?: unknown } | null)?.check_runs;
        return Array.isArray(runs) ? (runs as ApiCheckRun[]) : [];
      }),
    async createCheckRun(repo, body) {
      const res = await call('POST', `${repoPath(repo)}/check-runs`, body);
      const id = ((await res.json()) as { id?: unknown } | null)?.id;
      if (typeof id !== 'number') throw new GitHubApiError({ status: res.status, method: 'POST', path: `${repoPath(repo)}/check-runs`, detail: 'response had no check run id' });
      return { id };
    },
    async upsertComment(repo, pr, marker, body) {
      try {
        const base = repoPath(repo);
        const comments = await paged<{ id: number; body?: string }>(`${base}/issues/${Math.trunc(pr)}/comments`, list as (j: unknown) => Array<{ id: number; body?: string }>);
        const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker));
        const text = body.includes(marker) ? body : `${marker}\n${body}`;
        if (existing) {
          await call('PATCH', `${base}/issues/comments/${existing.id}`, { body: text });
          return { posted: true, updated: true };
        }
        await call('POST', `${base}/issues/${Math.trunc(pr)}/comments`, { body: text });
        return { posted: true, updated: false };
      } catch (err) {
        return { posted: false, updated: false, reason: err instanceof Error ? scrub(err.message) : 'unknown error' };
      }
    },
  };
}
