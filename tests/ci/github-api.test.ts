import { describe, expect, it } from 'vitest';

import { GitHubApiError, githubApi } from '../../src/ci/github-api.js';

const TOKEN = 'ghs_SECRET_token_value';
const ROOT = 'https://api.example.test';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}
type Reply = Response | Error | ((call: Call) => Response | Error);

/** A fetch that answers from a script, in order, and records what it was asked. */
function mockFetch(replies: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    const next = replies.shift();
    if (!next) throw new Error('unexpected request');
    const r = typeof next === 'function' ? next(call) : next;
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch: fn as typeof fetch, calls };
}
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const items = (n: number, from = 0): Array<{ id: number }> => Array.from({ length: n }, (_, i) => ({ id: from + i }));

describe('githubApi [github-client]', () => {
  // [claims: capabilities/integration-surfaces#github-client-calls]
  it('sends the token as a bearer header and hits the review and file endpoints under the API root', async () => {
    const m = mockFetch([json([{ id: 1 }]), json([{ filename: 'a.ts', status: 'added' }])]);
    const api = githubApi(TOKEN, `${ROOT}/`, m.fetch);
    expect(await api.listReviews('acme/shop', 12)).toEqual([{ id: 1 }]);
    expect(await api.listPrFiles('acme/shop', 12)).toEqual([{ filename: 'a.ts', status: 'added' }]);
    expect(m.calls.map((c) => c.url)).toEqual([`${ROOT}/repos/acme/shop/pulls/12/reviews?per_page=100`, `${ROOT}/repos/acme/shop/pulls/12/files?per_page=100`]);
    expect(m.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(m.calls[0].method).toBe('GET');
  });

  // [claims: capabilities/integration-surfaces#github-client-calls]
  it('follows the Link header across pages and collects every item', async () => {
    const m = mockFetch([
      json(items(100), { headers: { link: `<${ROOT}/repos/acme/shop/pulls/3/files?per_page=100&page=2>; rel="next", <${ROOT}/x?page=3>; rel="last"` } }),
      json(items(100, 100), { headers: { link: `<${ROOT}/repos/acme/shop/pulls/3/files?per_page=100&page=3>; rel="next"` } }),
      json(items(7, 200), { headers: { link: `<${ROOT}/x?page=1>; rel="prev"` } }),
    ]);
    const files = await githubApi(TOKEN, ROOT, m.fetch).listPrFiles('acme/shop', 3);
    expect(files).toHaveLength(207);
    expect(m.calls.map((c) => c.url.split('?')[1])).toEqual(['per_page=100', 'per_page=100&page=2', 'per_page=100&page=3']);
  });

  // [claims: capabilities/integration-surfaces#github-client-calls]
  it('without a Link header pages by number until a short page', async () => {
    const m = mockFetch([json(items(100)), json(items(3, 100))]);
    expect(await githubApi(TOKEN, ROOT, m.fetch).listReviews('acme/shop', 3)).toHaveLength(103);
    expect(m.calls[1].url).toContain('page=2');
  });

  // [claims: capabilities/integration-surfaces#github-client-calls]
  it('lists check runs by name on a commit and unwraps the check_runs envelope', async () => {
    const m = mockFetch([json({ total_count: 1, check_runs: [{ id: 5, app: { slug: 'github-actions' }, output: { summary: 's' } }] }), json({})]);
    const api = githubApi(TOKEN, ROOT, m.fetch);
    expect(await api.listCheckRuns('acme/shop', 'abc123', 'specguard/proof-note')).toHaveLength(1);
    expect(m.calls[0].url).toBe(`${ROOT}/repos/acme/shop/commits/abc123/check-runs?check_name=specguard%2Fproof-note&per_page=100`);
    expect(await api.listCheckRuns('acme/shop', 'abc123', 'x')).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#github-client-calls]
  it('creates a check run with the given body and returns its id', async () => {
    const m = mockFetch([json({ id: 77 }, { status: 201 })]);
    const body = { name: 'specguard/proof-note', head_sha: 'abc', status: 'completed', conclusion: 'neutral', output: { title: 't', summary: 'note-sha256: x' } } as const;
    expect(await githubApi(TOKEN, ROOT, m.fetch).createCheckRun('acme/shop', body)).toEqual({ id: 77 });
    expect(m.calls[0]).toMatchObject({ method: 'POST', url: `${ROOT}/repos/acme/shop/check-runs`, body });
  });

  // [claims: capabilities/integration-surfaces#github-client-errors-and-token]
  it('a failed call throws a typed error with status, method and path', async () => {
    const m = mockFetch([json({ message: 'Not Found' }, { status: 404 })]);
    const err = await githubApi(TOKEN, ROOT, m.fetch).listReviews('acme/shop', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ status: 404, method: 'GET', rateLimited: false });
    expect((err as GitHubApiError).path).toBe('/repos/acme/shop/pulls/1/reviews?per_page=100');
    expect((err as Error).message).toContain('HTTP 404');
  });

  // [claims: capabilities/integration-surfaces#github-client-errors-and-token]
  it('flags a rate limit by status 429 or an exhausted 403', async () => {
    const m = mockFetch([json({}, { status: 429 }), json({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), json({}, { status: 403 })]);
    const api = githubApi(TOKEN, ROOT, m.fetch);
    expect(await api.listReviews('a/b', 1).catch((e: GitHubApiError) => e.rateLimited)).toBe(true);
    expect(await api.listReviews('a/b', 1).catch((e: GitHubApiError) => e.rateLimited)).toBe(true);
    expect(await api.listReviews('a/b', 1).catch((e: GitHubApiError) => e.rateLimited)).toBe(false);
  });

  // [claims: capabilities/integration-surfaces#github-client-errors-and-token]
  it('a network failure is a typed error with status 0, and neither it nor a server message leaks the token', async () => {
    const m = mockFetch([new Error(`connect failed for ${TOKEN}`), json({ message: `Bad credentials ${TOKEN}` }, { status: 401 })]);
    const api = githubApi(TOKEN, ROOT, m.fetch);
    const net = (await api.listReviews('a/b', 1).catch((e: unknown) => e)) as GitHubApiError;
    expect(net).toMatchObject({ status: 0 });
    const auth = (await api.listPrFiles('a/b', 1).catch((e: unknown) => e)) as GitHubApiError;
    expect(auth.status).toBe(401);
    for (const e of [net, auth]) {
      expect(e.message).not.toContain(TOKEN);
      expect(JSON.stringify({ ...e, message: e.message, stack: undefined })).not.toContain(TOKEN);
    }
  });

  // [claims: capabilities/integration-surfaces#github-client-errors-and-token]
  it('never follows a pagination link outside the API root, so the token stays with the configured host', async () => {
    const m = mockFetch([json(items(100), { headers: { link: '<https://evil.example.test/steal?page=2>; rel="next"' } })]);
    const err = (await githubApi(TOKEN, ROOT, m.fetch).listReviews('a/b', 1).catch((e: unknown) => e)) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(m.calls).toHaveLength(1);
    expect(err.message).not.toContain('evil');
  });

  // [claims: capabilities/integration-surfaces#github-client-errors-and-token]
  it('refuses a missing token and a repository that is not owner/name, without a request', async () => {
    expect(() => githubApi('', ROOT)).toThrow(GitHubApiError);
    const m = mockFetch([]);
    const api = githubApi(TOKEN, ROOT, m.fetch);
    await expect(api.listReviews('../..', 1)).rejects.toBeInstanceOf(GitHubApiError);
    await expect(api.listReviews('onlyname', 1)).rejects.toBeInstanceOf(GitHubApiError);
    expect(m.calls).toHaveLength(0);
  });

  // [claims: capabilities/integration-surfaces#github-comment-upsert]
  it('posts a new comment when no comment holds the marker', async () => {
    const m = mockFetch([json([{ id: 1, body: 'unrelated' }]), json({ id: 2 }, { status: 201 })]);
    const res = await githubApi(TOKEN, ROOT, m.fetch).upsertComment('acme/shop', 12, '<!-- m -->', 'hello');
    expect(res).toEqual({ posted: true, updated: false });
    expect(m.calls[1]).toMatchObject({ method: 'POST', url: `${ROOT}/repos/acme/shop/issues/12/comments`, body: { body: '<!-- m -->\nhello' } });
  });

  // [claims: capabilities/integration-surfaces#github-comment-upsert]
  it('updates the comment that holds the marker, found on a later page', async () => {
    const page1 = json(items(100).map((i) => ({ ...i, body: 'x' })), { headers: { link: `<${ROOT}/repos/acme/shop/issues/12/comments?per_page=100&page=2>; rel="next"` } });
    const page2 = json([{ id: 900, body: 'old\n<!-- m -->' }]);
    const m = mockFetch([page1, page2, json({ id: 900 })]);
    const res = await githubApi(TOKEN, ROOT, m.fetch).upsertComment('acme/shop', 12, '<!-- m -->', '<!-- m -->\nnew');
    expect(res).toEqual({ posted: true, updated: true });
    expect(m.calls[2]).toMatchObject({ method: 'PATCH', url: `${ROOT}/repos/acme/shop/issues/comments/900`, body: { body: '<!-- m -->\nnew' } });
  });

  // [claims: capabilities/integration-surfaces#github-comment-upsert]
  it('never throws: a refused write returns posted false with a reason that holds no token', async () => {
    const m = mockFetch([json([]), json({ message: `Resource not accessible ${TOKEN}` }, { status: 403 })]);
    const res = await githubApi(TOKEN, ROOT, m.fetch).upsertComment('acme/shop', 12, '<!-- m -->', 'b');
    expect(res.posted).toBe(false);
    expect(res.reason).toContain('403');
    expect(res.reason).not.toContain(TOKEN);
    const down = await githubApi(TOKEN, ROOT, mockFetch([new Error('offline')]).fetch).upsertComment('acme/shop', 12, 'm', 'b');
    expect(down).toMatchObject({ posted: false, updated: false });
  });
});
