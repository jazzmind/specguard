import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { buildSnapshot } from '../../src/pipelines/publish.js';
import { buildWorkspaceDef, runWorkspacePublish } from '../../src/pipelines/workspace-publish.js';
import { loadWorkspace } from '../../src/core/workspace.js';
import { fileBackend } from '../../src/server/central/file-backend.js';
import { startCentralServer, type RunningCentralServer } from '../../src/server/central/server.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const BOOTSTRAP = 'bootstrap-secret-for-tests';
const ADA = { 'x-deploykit-email': 'ada@plymouthrock.com' };
const BOB = { 'x-deploykit-email': 'bob@plymouthrock.com' };

let server: RunningCentralServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start() {
  server = await startCentralServer({
    backend: fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-ws-central-'))),
    llm: { provider: 'litellm', model: 'fast', apiKeyEnv: 'NOKEY' },
    port: 0,
    host: '127.0.0.1',
    workDir: mkdtempSync(path.join(os.tmpdir(), 'sg-ws-work-')),
    auth: { bootstrapToken: BOOTSTRAP, maintainerEmails: ['ada@plymouthrock.com'], allowedDomain: 'plymouthrock.com' },
  });
  return server.url;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
async function call(base: string, p: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}
async function mint(base: string, body: Record<string, unknown>) {
  const res = await call(base, '/api/v1/admin/tokens', { method: 'POST', headers: bearer(BOOTSTRAP), body });
  return res.json.token as string;
}
async function publishProject(base: string, token: string, project: string) {
  const snap = await buildSnapshot(await loadConfig(makeV2Repo().dir), { project });
  const res = await call(base, `/api/v1/projects/${project}/snapshots`, { method: 'POST', headers: bearer(token), body: snap });
  expect(res.status, res.text).toBe(201);
}

describe('team server: workspaces [server-workspaces]', () => {
  // [claims: capabilities/workspaces#server-workspace]
  it('a maintainer defines a workspace, anyone signed in reads it, and the rollup combines each project\'s newest snapshot', async () => {
    const base = await start();
    const admin = await mint(base, { name: 'admin', role: 'admin' });
    await publishProject(base, admin, 'web');
    await publishProject(base, admin, 'api');
    const put = await call(base, '/api/v1/workspaces/sandbox', {
      method: 'PUT',
      headers: bearer(admin),
      body: { description: 'the sandbox', projects: [{ project: 'web', key: 'web', role: 'consumer' }, { project: 'api', key: 'api', role: 'provider' }, { project: 'hub', key: 'hub', ignore: true }, { project: 'not-published', key: 'later' }] },
    });
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject({ name: 'sandbox', updatedBy: expect.any(String) });

    expect((await call(base, '/api/v1/workspaces', { headers: BOB })).json.workspaces.map((w: { name: string }) => w.name)).toEqual(['sandbox']);
    expect((await call(base, '/api/v1/workspaces/sandbox', { headers: BOB })).json.projects).toHaveLength(4);

    const rollup = (await call(base, '/api/v1/workspaces/sandbox/rollup', { headers: BOB })).json;
    expect(rollup.workspace).toBe('sandbox');
    expect(rollup.repos.map((r: { key: string; state: string; ignored: boolean }) => `${r.key}:${r.state}${r.ignored ? ':ignored' : ''}`)).toEqual(['api:ok', 'later:no-trace', 'web:ok', 'hub:no-trace:ignored']);
    // two published projects with the same spec tree: the totals are their sum, and ignored/unpublished add nothing
    const one = rollup.repos.find((r: { key: string }) => r.key === 'web').coverage.claims;
    expect(one).toBeGreaterThan(0);
    expect(rollup.totals.coverage.claims).toBe(one * 2);
    expect(rollup.totals).toMatchObject({ repos: 3, ignored: 1 });
  });

  // [claims: capabilities/workspaces#server-workspace]
  it('refuses a workspace from a viewer or an anonymous caller, bad names and bad bodies, and 404s an unknown one', async () => {
    const base = await start();
    const body = { projects: [{ project: 'web' }] };
    expect((await call(base, '/api/v1/workspaces/x', { method: 'PUT', body })).status).toBe(401);
    expect((await call(base, '/api/v1/workspaces/x', { method: 'PUT', headers: BOB, body })).status).toBeGreaterThanOrEqual(401); // a header sign-in alone cannot write
    const admin = await mint(base, { name: 'admin', role: 'admin' });
    expect((await call(base, '/api/v1/workspaces/bad name!', { method: 'PUT', headers: bearer(admin), body })).status).toBe(400);
    expect((await call(base, '/api/v1/workspaces/x', { method: 'PUT', headers: bearer(admin), body: { projects: [{ project: '../etc' }] } })).status).toBe(400);
    expect((await call(base, '/api/v1/workspaces/x', { method: 'PUT', headers: bearer(admin), body: { nope: 1 } })).status).toBe(400);
    expect((await call(base, '/api/v1/workspaces/missing', { headers: BOB })).status).toBe(404);
    expect((await call(base, '/api/v1/workspaces', { method: 'POST', headers: bearer(admin), body })).status).toBe(405);
  });

  // [claims: capabilities/workspaces#server-workspace]
  it('a token limited to one project cannot define a workspace and sees only one made of that project alone', async () => {
    const base = await start();
    const admin = await mint(base, { name: 'admin', role: 'admin' });
    const ci = await mint(base, { name: 'ci', role: 'maintainer', project: 'web', owner: 'ci:web' });
    expect((await call(base, '/api/v1/workspaces/x', { method: 'PUT', headers: bearer(ci), body: { projects: [{ project: 'web' }] } })).status).toBe(403);
    await call(base, '/api/v1/workspaces/solo', { method: 'PUT', headers: bearer(admin), body: { projects: [{ project: 'web' }] } });
    await call(base, '/api/v1/workspaces/both', { method: 'PUT', headers: bearer(admin), body: { projects: [{ project: 'web' }, { project: 'api' }] } });
    expect((await call(base, '/api/v1/workspaces', { headers: bearer(ci) })).json.workspaces.map((w: { name: string }) => w.name)).toEqual(['solo']);
    expect((await call(base, '/api/v1/workspaces/both', { headers: bearer(ci) })).status).toBe(404);
    expect((await call(base, '/api/v1/workspaces/both/rollup', { headers: bearer(ci) })).status).toBe(404);
    expect((await call(base, '/api/v1/workspaces/solo/rollup', { headers: bearer(ci) })).status).toBe(200);
    expect((await call(base, '/api/v1/workspaces', { headers: ADA })).json.workspaces).toHaveLength(2);
  });
});

describe('workspace publish [workspace-publish]', () => {
  function manifestOf(extra: Record<string, unknown> = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-wspub-'));
    const put = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    };
    const cfg = (project?: string, url?: string) => JSON.stringify({ apps: [{ name: 'a', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }], llm: { provider: 'none', model: 'none', apiKeyEnv: 'N' }, ...(project || url ? { server: { ...(project ? { project } : {}), ...(url ? { url } : {}) } } : {}) });
    put('ws/.specguard/workspace.json', JSON.stringify({ version: '1', name: 'My Workspace', repos: { web: { path: '../web', role: 'consumer' }, api: { path: '../api', role: 'provider' }, hub: { path: '../hub', role: 'consumer', ignore: true } }, ...extra }));
    put('web/.specguard/config.json', cfg('web-app', 'http://sandbox/specguard'));
    put('api/.specguard/config.json', cfg());
    put('hub/.specguard/config.json', cfg());
    return path.join(dir, 'ws');
  }

  // [claims: capabilities/workspaces#workspace-publish]
  it('names each repo by the manifest\'s map, else its own server.project, else its folder, and flags the ignored', async () => {
    const root = manifestOf({ server: { projects: { api: 'orders-api' } } });
    const def = await buildWorkspaceDef(await loadWorkspace(root));
    expect(def.projects).toEqual([
      { project: 'web-app', key: 'web', role: 'consumer' },
      { project: 'orders-api', key: 'api', role: 'provider' },
      { project: 'hub', key: 'hub', role: 'consumer', ignore: true },
    ]);
  });

  // [claims: capabilities/workspaces#workspace-publish]
  it('puts the workspace on the server found in a repo config, and says so when none is configured or the server refuses', async () => {
    const root = manifestOf();
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const ok = (async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body });
      return { ok: true, status: 200, text: async () => '{}' };
    }) as never;
    const res = await runWorkspacePublish(root, root, { fetchImpl: ok, token: 't' });
    expect(res.exitCode).toBe(0);
    expect(calls[0]).toMatchObject({ url: 'http://sandbox/specguard/api/v1/workspaces/my-workspace', method: 'PUT' });
    expect(JSON.parse(calls[0].body!).projects).toHaveLength(3);
    expect(res.messages[0]).toContain('2 project(s) and 1 ignored');

    const refused = (async () => ({ ok: false, status: 403, text: async () => '{"error":"nope"}' })) as never;
    const denied = await runWorkspacePublish(root, root, { fetchImpl: refused, token: 't' });
    expect(denied.exitCode).not.toBe(0);
    expect(denied.messages[0]).toContain('refused the workspace (403): nope');

    const bare = manifestOf();
    for (const r of ['web']) writeFileSync(path.join(bare, '..', r, '.specguard/config.json'), JSON.stringify({ apps: [{ name: 'a', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }], llm: { provider: 'none', model: 'none', apiKeyEnv: 'N' } }));
    const before = process.env.SPECGUARD_SERVER;
    delete process.env.SPECGUARD_SERVER;
    try {
      const none = await runWorkspacePublish(bare, bare, { fetchImpl: ok });
      expect(none.exitCode).not.toBe(0);
      expect(none.messages[0]).toContain('no team server is configured');
    } finally {
      if (before !== undefined) process.env.SPECGUARD_SERVER = before;
    }
  });
});
