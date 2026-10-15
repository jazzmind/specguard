import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { writePlan } from '../../src/pipelines/security-plan.js';
import { Api, type Identity } from '../../src/server/api.js';
import { localProject, type ProjectRegistry } from '../../src/server/project.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const get = async (api: Api, p: string) => {
  const r = await api.handle({ method: 'GET', path: p });
  return { ...r, json: r.type.startsWith('application/json') ? JSON.parse(r.body) : null };
};

async function twoProjects(): Promise<{ api: Api; one: string; two: string }> {
  const a = makeV2Repo();
  const b = makeV2Repo();
  const projects = [localProject({ ...(await loadConfig(a.dir)), server: { project: 'alpha' } }), localProject({ ...(await loadConfig(b.dir)), server: { project: 'beta' } })];
  const registry: ProjectRegistry = {
    writable: false,
    list: async () => projects.map((p) => ({ name: p.name, kind: 'snapshot' as const, commit: 'abc', branch: 'main' })),
    get: async (name) => projects.find((p) => p.name === name),
  };
  return { api: new Api(registry), one: a.dir, two: b.dir };
}

describe('project-scoped routes [project-routes]', () => {
  // [claims: capabilities/documentation-api#spec-endpoints]
  it('lists projects and serves each under its own prefix [prefix]', async () => {
    const { api } = await twoProjects();
    const list = (await get(api, '/api/v1/projects')).json;
    expect(list.projects.map((p: { name: string }) => p.name)).toEqual(['alpha', 'beta']);
    expect(list.default).toBeNull();
    for (const name of ['alpha', 'beta']) {
      const sys = (await get(api, `/api/v1/projects/${name}/system`)).json;
      expect(sys.capabilities.map((c: { id: string }) => c.id)).toEqual(['auth', 'shop']);
    }
    expect((await get(api, '/api/v1/projects/alpha')).json).toMatchObject({ name: 'alpha', kind: 'snapshot', commit: 'abc' });
  });

  // [claims: capabilities/documentation-api#spec-endpoints]
  it('refuses unprefixed routes when there is no default project, and unknown projects [no-default]', async () => {
    const { api } = await twoProjects();
    const unprefixed = await get(api, '/api/v1/system');
    expect(unprefixed.status).toBe(404);
    expect(unprefixed.json.error).toContain('/api/v1/projects/<name>/');
    expect((await get(api, '/api/v1/projects/nope/system')).status).toBe(404);
    expect((await get(api, '/api/v1/health')).status).toBe(200);
  });

  // [claims: capabilities/documentation-api#spec-endpoints]
  it('serves a single local project both with and without the prefix [local-both-forms]', async () => {
    const repo = makeV2Repo();
    const api = new Api(await loadConfig(repo.dir));
    const name = (await get(api, '/api/v1/projects')).json.default as string;
    expect(name).toBeTruthy();
    const plain = (await get(api, '/api/v1/capabilities')).json;
    const prefixed = (await get(api, `/api/v1/projects/${name}/capabilities`)).json;
    expect(prefixed).toEqual(plain);
  });

  // [claims: capabilities/documentation-api#serve-readonly]
  it('answers writes with 405 while the registry is not writable [read-only-registry]', async () => {
    const { api } = await twoProjects();
    expect((await api.handle({ method: 'POST', path: '/api/v1/projects/alpha/proofs' })).status).toBe(405);
    expect((await api.handle({ method: 'PATCH', path: '/api/v1/projects/alpha/security/plans/p/items/i' })).status).toBe(405);
  });
});

describe('read routes for clients [client-routes]', () => {
  // [claims: capabilities/documentation-api#spec-endpoints]
  it('lists specs with the file an editor opens [specs]', async () => {
    const repo = makeV2Repo();
    const api = new Api(await loadConfig(repo.dir));
    const specs = (await get(api, '/api/v1/specs')).json.specs as Array<{ id: string; file: string; kind: string }>;
    expect(specs.find((s) => s.id === 'auth')).toMatchObject({ kind: 'capability', file: 'specs/capabilities/auth.md' });
    expect(specs.find((s) => s.id === 'system')).toMatchObject({ file: 'specs/system.md' });
  });

  // [claims: capabilities/documentation-api#audit-endpoints]
  it('summarises coverage per capability and overall [coverage]', async () => {
    const repo = makeV2Repo();
    const api = new Api(await loadConfig(repo.dir));
    const cov = (await get(api, '/api/v1/coverage')).json;
    expect(cov.unowned).toEqual(['src/orphan.ts']);
    // 5 source files, 1 of them owned by no spec.
    expect(cov.sourceCoverage).toBe(80);
    // A file owned by two capabilities, or a spec owning a file outside the source set, must not push it past 100.
    repo.write('specs/capabilities/shop.md', readFileSync(path.join(repo.dir, 'specs/capabilities/shop.md'), 'utf8').replace('  - "src/shop/**"', '  - "src/shop/**"\n  - "src/auth/**"\n  - "README.md"'));
    repo.write('README.md', '# x');
    const api2 = new Api(await loadConfig(repo.dir));
    expect((await get(api2, '/api/v1/coverage')).json.sourceCoverage).toBeLessThanOrEqual(100);
    const auth = cov.capabilities.find((c: { id: string }) => c.id === 'auth');
    expect(auth).toMatchObject({ files: 2, tests: 1 });
    expect(auth.testedPercent).toBe(50);
  });

  // [claims: capabilities/documentation-api#docs-endpoints]
  it('lists the documents that can be requested, system first [docs-list]', async () => {
    const repo = makeV2Repo();
    const api = new Api(await loadConfig(repo.dir));
    const list = (await get(api, '/api/v1/docs')).json;
    expect(list.audiences).toEqual(['user', 'dev', 'agent']);
    expect(list.documents.map((d: { id: string }) => d.id)).toEqual(['system', 'auth', 'shop']);
  });

  // [claims: capabilities/documentation-api#audit-endpoints]
  it('lists unresolved findings from the newest plan, and an empty list without one [findings]', async () => {
    const repo = makeV2Repo();
    const config = await loadConfig(repo.dir);
    const api = new Api(config);
    expect((await get(api, '/api/v1/findings')).json).toEqual({ plan: null, findings: [] });
    const item = (id: string, status: string) => ({ id, title: `t-${id}`, severity: 'high', type: 'code', change: 'code', summary: 's', findings: [{ id, detector: 'semgrep', message: 'm' }], capability: 'auth', unit: 'web', claims: [], files: ['src/auth/login.ts'], verify: { scope: 'listed', claims: [] }, status, statusHistory: [], fingerprint: id });
    await writePlan(config, { version: 1, id: 'scan-1', createdAt: '2026-10-15T00:00:00Z', tool: { name: 'specguard' }, items: [item('open-one', 'open'), item('done-one', 'fixed')] } as never);
    const found = (await get(api, '/api/v1/findings')).json;
    expect(found.plan).toBe('scan-1');
    expect(found.findings).toEqual([expect.objectContaining({ id: 'open-one', capability: 'auth', unit: 'web', severity: 'high' })]);
  });

  // [claims: capabilities/documentation-api#audit-endpoints]
  it('serves the contract graph, empty when there is none [contracts]', async () => {
    const repo = makeV2Repo();
    const api = new Api(await loadConfig(repo.dir));
    expect((await get(api, '/api/v1/contracts')).json).toMatchObject({ nodes: [], edges: [] });
    repo.write('.specguard/contracts.json', JSON.stringify({ version: '1', generatedAt: '2026-10-15', nodes: [{ id: 'web::a', repo: 'web', spec: 'a', title: 'A' }], edges: [] }));
    expect((await get(api, '/api/v1/contracts')).json.nodes).toHaveLength(1);
    // A damaged file is an error the client can read, not a crash.
    repo.write('.specguard/contracts.json', '{ nope');
    expect((await get(api, '/api/v1/contracts')).status).toBe(500);
  });

  // [claims: capabilities/documentation-api#serve-readonly]
  it('reports versions on /health and /version, including whether the server accepts writes [version]', async () => {
    const repo = makeV2Repo();
    const api = new Api(await loadConfig(repo.dir));
    for (const p of ['/api/v1/health', '/api/v1/version']) {
      expect((await get(api, p)).json).toMatchObject({ ok: true, apiVersion: 1, hashVersion: 1, writable: false });
    }
  });
});

describe('plan item updates [plan-write]', () => {
  const item = (id: string) => ({ id, title: id, severity: 'high', type: 'code', change: 'code', summary: 's', findings: [{ id, detector: 'semgrep', message: 'm' }], claims: [], files: ['src/a.ts'], verify: { scope: 'listed', claims: [] }, status: 'open', statusHistory: [], fingerprint: id });
  const maintainer: Identity = { user: 'ada@plymouthrock.com', role: 'maintainer' };

  async function writable() {
    const repo = makeV2Repo();
    const config = await loadConfig(repo.dir);
    await writePlan(config, { version: 1, id: 'scan-1', createdAt: '2026-10-15T00:00:00Z', tool: { name: 'specguard' }, items: [item('a'), item('b')] } as never);
    const project = localProject(config);
    const registry: ProjectRegistry = { defaultProject: project.name, writable: true, list: async () => [{ name: project.name, kind: 'snapshot' }], get: async (n) => (n === project.name ? project : undefined) };
    const api = new Api(registry);
    const patch = (itemId: string, body: unknown, over: { identity?: Identity | null; headers?: Record<string, string> } = {}) =>
      api.handle({
        method: 'PATCH',
        path: `/api/v1/security/plans/scan-1/items/${itemId}`,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: over.headers,
        identity: over.identity === null ? undefined : (over.identity ?? maintainer),
      });
    return { api, patch, project };
  }

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('moves an item, records who did it, and returns the new version [patch]', async () => {
    const { patch, api } = await writable();
    const res = await patch('a', { status: 'in-progress', note: 'on it', externalRef: 'SEC-7' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ plan: 'scan-1', was: 'open', version: 1, item: { status: 'in-progress', externalRef: 'SEC-7' } });
    const read = JSON.parse((await api.handle({ method: 'GET', path: '/api/v1/security/plans/scan-1' })).body);
    expect(read.items[0].statusHistory).toEqual([expect.objectContaining({ status: 'in-progress', by: 'ada@plymouthrock.com', note: 'on it' })]);
    // The findings list carries the version a client sends back as If-Match.
    const findings = JSON.parse((await api.handle({ method: 'GET', path: '/api/v1/findings' })).body).findings;
    expect(findings.find((f: { id: string }) => f.id === 'a')).toMatchObject({ status: 'in-progress', version: 1 });
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('answers 409 for a stale If-Match and applies the update for the current one [if-match]', async () => {
    const { patch } = await writable();
    expect((await patch('a', { status: 'in-progress' })).status).toBe(200);
    const stale = await patch('a', { status: 'wont-fix' }, { headers: { 'if-match': '0' } });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body).code).toBe('conflict');
    expect((await patch('a', { status: 'fixed' }, { headers: { 'if-match': '"1"' } })).status).toBe(200);
    expect((await patch('a', { status: 'verified' }, { headers: { 'if-match': 'banana' } })).status).toBe(400);
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('maps refusals to status codes: 401, 403, 400, 404, 422 [refusals]', async () => {
    const { patch } = await writable();
    expect((await patch('a', { status: 'fixed' }, { identity: null })).status).toBe(401);
    expect((await patch('a', { status: 'fixed' }, { identity: { user: 'v@x', role: 'viewer' } })).status).toBe(403);
    expect((await patch('a', 'not json')).status).toBe(400);
    expect((await patch('a', {})).status).toBe(400);
    expect((await patch('a', { status: 'done' })).status).toBe(400);
    expect((await patch('a', { status: 'fixed', note: 5 })).status).toBe(400);
    expect((await patch('missing', { status: 'fixed' })).status).toBe(404);
    expect((await patch('a', { status: 'verified' })).status).toBe(422);
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('loses nothing when many items are updated at once [concurrent]', async () => {
    const { patch, api } = await writable();
    await Promise.all([patch('a', { status: 'in-progress', externalRef: 'EXT-A' }), patch('b', { status: 'in-progress', externalRef: 'EXT-B' })]);
    const plan = JSON.parse((await api.handle({ method: 'GET', path: '/api/v1/security/plans/scan-1' })).body);
    expect(plan.items.map((i: { externalRef: string }) => i.externalRef)).toEqual(['EXT-A', 'EXT-B']);
  });
});
