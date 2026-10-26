import { describe, expect, it } from 'vitest';

import { readCiContext } from '../../src/ci/context.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);

const baseEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_EVENT_PATH: '/event.json',
  GITHUB_REPOSITORY: 'acme/shop',
  GITHUB_SHA: MERGE,
  GITHUB_RUN_ID: '555',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW: 'specguard',
  GITHUB_ACTOR: 'ada',
  GITHUB_SERVER_URL: 'https://github.com',
  SG_GITHUB_TOKEN: 'tok',
  ...over,
});

const prEvent = (over: { headRepo?: string | null; draft?: boolean } = {}): unknown => ({
  repository: { default_branch: 'main' },
  pull_request: {
    number: 12,
    user: { login: 'ada' },
    draft: over.draft ?? false,
    base: { sha: BASE },
    head: { sha: HEAD, repo: over.headRepo === null ? null : { full_name: over.headRepo ?? 'acme/shop' } },
  },
});

const read = (payload: unknown) => () => payload;

describe('readCiContext [ci-context]', () => {
  // [claims: capabilities/integration-surfaces#ci-context-pull-request]
  it('pull_request event: head, base, pr author, run facts and fork detection', () => {
    const ctx = readCiContext(baseEnv(), read(prEvent()));
    expect(ctx).toMatchObject({
      provider: 'github',
      event: 'pull_request',
      repo: 'acme/shop',
      defaultBranch: 'main',
      head: HEAD,
      baseSha: BASE,
      pr: { number: 12, author: 'ada', headRepo: 'acme/shop', isFork: false, draft: false },
      runId: '555',
      runAttempt: 2,
      runUrl: 'https://github.com/acme/shop/actions/runs/555',
      workflow: 'specguard',
      actor: 'ada',
    });
  });

  // [claims: capabilities/integration-surfaces#ci-context-pull-request]
  it('a head repository other than this one is a fork, whatever its case; a deleted head repository is a fork', () => {
    expect(readCiContext(baseEnv(), read(prEvent({ headRepo: 'Acme/Shop' }))).pr?.isFork).toBe(false);
    expect(readCiContext(baseEnv(), read(prEvent({ headRepo: 'mallory/shop' }))).pr).toMatchObject({ isFork: true, headRepo: 'mallory/shop' });
    expect(readCiContext(baseEnv(), read(prEvent({ headRepo: null }))).pr).toMatchObject({ isFork: true, headRepo: '' });
  });

  // [claims: capabilities/integration-surfaces#ci-context-pull-request]
  it('push with a zero before sha has no base; a real before sha is the base', () => {
    const env = baseEnv({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: HEAD });
    expect(readCiContext(env, read({ before: '0'.repeat(40), after: HEAD })).baseSha).toBeUndefined();
    const ctx = readCiContext(env, read({ before: BASE, after: HEAD }));
    expect(ctx).toMatchObject({ event: 'push', head: HEAD, baseSha: BASE });
    expect(ctx.pr).toBeUndefined();
  });

  // [claims: capabilities/integration-surfaces#ci-context-pull-request]
  it('merge_group: head and base from the merge group', () => {
    const ctx = readCiContext(baseEnv({ GITHUB_EVENT_NAME: 'merge_group' }), read({ merge_group: { head_sha: HEAD, base_sha: BASE } }));
    expect(ctx).toMatchObject({ event: 'merge_group', head: HEAD, baseSha: BASE });
  });

  // [claims: capabilities/integration-surfaces#ci-context-pull-request]
  it('workflow_dispatch and schedule have no base; an unknown event reads as other', () => {
    expect(readCiContext(baseEnv({ GITHUB_EVENT_NAME: 'workflow_dispatch' }), read({})).baseSha).toBeUndefined();
    expect(readCiContext(baseEnv({ GITHUB_EVENT_NAME: 'schedule' }), read({})).event).toBe('schedule');
    expect(readCiContext(baseEnv({ GITHUB_EVENT_NAME: 'pull_request_target' }), read({})).event).toBe('other');
  });

  // [claims: capabilities/integration-surfaces#ci-context-pull-request]
  it('is defensive: a missing, malformed or throwing payload and an empty environment never throw', () => {
    expect(() => readCiContext({}, () => undefined)).not.toThrow();
    const empty = readCiContext({}, () => undefined);
    expect(empty).toMatchObject({ provider: 'other', event: 'other', head: '', canWrite: { notes: false, comment: false, checks: false } });
    const bad = readCiContext(baseEnv(), () => {
      throw new Error('no such file');
    });
    expect(bad.pr).toBeUndefined();
    expect(bad.head).toBe(MERGE);
    expect(readCiContext(baseEnv(), read('not an object')).pr).toBeUndefined();
    expect(readCiContext(baseEnv(), read({ pull_request: { number: 'x', head: 3, base: [] } })).pr).toBeUndefined();
    expect(readCiContext(baseEnv({ GITHUB_RUN_ATTEMPT: 'two' }), read(prEvent())).runAttempt).toBeUndefined();
  });

  // [claims: capabilities/integration-surfaces#ci-context-write-rights]
  it('a same-repo pull request with a token can write notes, comments and check runs', () => {
    expect(readCiContext(baseEnv(), read(prEvent())).canWrite).toEqual({ notes: true, comment: true, checks: true });
  });

  // [claims: capabilities/integration-surfaces#ci-context-write-rights]
  it('fork -> canWrite all false, token or not', () => {
    const ctx = readCiContext(baseEnv(), read(prEvent({ headRepo: 'mallory/shop' })));
    expect(ctx.canWrite).toEqual({ notes: false, comment: false, checks: false });
  });

  // [claims: capabilities/integration-surfaces#ci-context-write-rights]
  it('no token -> nothing is writable; a push with a token writes notes and checks but cannot comment', () => {
    expect(readCiContext(baseEnv({ SG_GITHUB_TOKEN: '  ' }), read(prEvent())).canWrite).toEqual({ notes: false, comment: false, checks: false });
    const push = readCiContext(baseEnv({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: HEAD }), read({ before: BASE }));
    expect(push.canWrite).toEqual({ notes: true, comment: false, checks: true });
  });

  // [claims: capabilities/integration-surfaces#ci-context-write-rights]
  it('outside GitHub Actions nothing is writable and the payload is not read', () => {
    let reads = 0;
    const ctx = readCiContext({ SG_GITHUB_TOKEN: 'tok', GITHUB_EVENT_PATH: '/e.json' }, () => {
      reads++;
      return {};
    });
    expect(reads).toBe(0);
    expect(ctx).toMatchObject({ provider: 'other', canWrite: { notes: false, comment: false, checks: false } });
  });
});
