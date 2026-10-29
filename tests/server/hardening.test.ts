import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { peerIsTrusted } from '../../src/server/central/auth.js';
import { RateLimiter, rateLimitsFromEnv } from '../../src/server/central/rate-limit.js';
import { settingsFromEnv, settingsWarnings } from '../../src/server/central/config.js';
import { fileBackend } from '../../src/server/central/file-backend.js';
import { startCentralServer, type RunningCentralServer } from '../../src/server/central/server.js';
import { createRequestListener } from '../../src/server/index.js';
import { loadConfig } from '../../src/core/config.js';
import http from 'node:http';
import { makeV2Repo } from '../helpers/v2-repo.js';

let server: RunningCentralServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ADA = { 'x-deploykit-email': 'ada@acme.test' };
const BOOTSTRAP = 'bootstrap-secret-for-tests';

let lastBackend: ReturnType<typeof fileBackend> | undefined;
async function start(trustedProxies?: string[], rateLimit?: { perMinute: number; docsPerMinute: number; anonymousPerMinute: number }) {
  lastBackend = fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-hard-srv-')));
  server = await startCentralServer({
    backend: lastBackend,
    llm: { provider: 'litellm', model: 'fast', apiKeyEnv: 'NOKEY' },
    port: 0,
    host: '127.0.0.1',
    workDir: mkdtempSync(path.join(os.tmpdir(), 'sg-hard-work-')),
    ...(rateLimit ? { rateLimit } : {}),
    auth: { bootstrapToken: BOOTSTRAP, maintainerEmails: ['ada@acme.test'], allowedDomain: 'acme.test', ...(trustedProxies ? { trustedProxies } : {}) },
  });
  return server.url;
}

describe('who may send the sign-in header [trusted-proxies]', () => {
  // [claims: capabilities/team-server#trusted-proxies]
  it('matches exact addresses, IPv4 CIDR ranges and IPv4-mapped IPv6, and nothing malformed', () => {
    expect(peerIsTrusted('10.0.0.7', ['10.0.0.7'])).toBe(true);
    expect(peerIsTrusted('::ffff:10.0.0.7', ['10.0.0.7'])).toBe(true);
    expect(peerIsTrusted('10.0.5.9', ['10.0.0.0/16'])).toBe(true);
    expect(peerIsTrusted('10.1.0.1', ['10.0.0.0/16'])).toBe(false);
    expect(peerIsTrusted('172.18.0.2', ['172.16.0.0/12', '192.168.0.0/16'])).toBe(true);
    expect(peerIsTrusted('203.0.113.9', ['0.0.0.0/0'])).toBe(true);
    expect(peerIsTrusted('::1', ['::1'])).toBe(true);
    expect(peerIsTrusted('::2', ['::1'])).toBe(false);
    expect(peerIsTrusted(undefined, ['10.0.0.7'])).toBe(false);
    expect(peerIsTrusted('10.0.0.7', ['10.0.0.0/33', 'nonsense/8', '10.0.0.0/x'])).toBe(false);
    expect(peerIsTrusted('10.0.0.7', [])).toBe(false);
  });

  // [claims: capabilities/team-server#trusted-proxies]
  it('ignores the header from a peer that is not the proxy, and still honours tokens from anyone', async () => {
    const base = await start(['10.99.99.99']);
    const asHeader = await fetch(`${base}/api/v1/projects`, { headers: ADA });
    expect(asHeader.status).toBe(401); // this test connects from 127.0.0.1, which is not the trusted proxy
    const mint = await fetch(`${base}/api/v1/admin/tokens`, { method: 'POST', headers: { authorization: `Bearer ${BOOTSTRAP}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ci', role: 'viewer' }) });
    const { token } = (await mint.json()) as { token: string };
    expect((await fetch(`${base}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    // and it cannot be used to write a workspace as a maintainer either
    const put = await fetch(`${base}/api/v1/workspaces/x`, { method: 'PUT', headers: { ...ADA, 'x-requested-with': 'x', 'content-type': 'application/json' }, body: '{"projects":[]}' });
    expect(put.status).toBe(401);
  });

  // [claims: capabilities/team-server#trusted-proxies]
  it('honours the header from the trusted proxy, and from anywhere when none is configured', async () => {
    const trusted = await start(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
    expect((await fetch(`${trusted}/api/v1/projects`, { headers: ADA })).status).toBe(200);
    await server!.close();
    const open = await start();
    expect((await fetch(`${open}/api/v1/projects`, { headers: ADA })).status).toBe(200);
  });

  // [claims: capabilities/team-server#trusted-proxies]
  it('reads SPECGUARD_TRUSTED_PROXIES, and warns at startup when it is not set', () => {
    const base = { SPECGUARD_BOOTSTRAP_TOKEN: 'b', SPECGUARD_ALLOWED_DOMAIN: 'acme.test' };
    expect(settingsFromEnv({ ...base, SPECGUARD_TRUSTED_PROXIES: ' 10.0.0.1, 172.18.0.0/16 ' }).auth.trustedProxies).toEqual(['10.0.0.1', '172.18.0.0/16']);
    expect(settingsFromEnv(base).auth.trustedProxies).toBeUndefined();
    expect(settingsFromEnv(base).auth.appRoleHeader).toBeUndefined();
    expect(settingsFromEnv({ ...base, SPECGUARD_APP_ROLE_HEADER: 'X-Deploykit-App-Role' }).auth.appRoleHeader).toBe('x-deploykit-app-role');
    expect(settingsWarnings(settingsFromEnv(base)).join('\n')).toContain('SPECGUARD_TRUSTED_PROXIES is not set');
    expect(settingsWarnings(settingsFromEnv({ ...base, SPECGUARD_TRUSTED_PROXIES: '10.0.0.1' })).join('\n')).not.toContain('SPECGUARD_TRUSTED_PROXIES');
  });
});

describe('what naming a maintainer in the header is worth [header-role]', () => {
  const xrw = { ...ADA, 'x-requested-with': 'specguard', 'content-type': 'application/json' };
  const put = (base: string) => fetch(`${base}/api/v1/workspaces/x`, { method: 'PUT', headers: xrw, body: '{"projects":[]}' });
  const mint = (base: string, role: string) => fetch(`${base}/api/v1/tokens`, { method: 'POST', headers: xrw, body: JSON.stringify({ name: 'mine', role }) });

  // [claims: capabilities/team-server#header-is-viewer-without-proxy]
  it('is a viewer without trusted proxies: it cannot write, and cannot mint itself a maintainer token', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/v1/projects`, { headers: ADA })).status).toBe(200); // reading still works
    expect((await put(base)).status).toBe(403);
    expect((await mint(base, 'maintainer')).status).toBe(403);
    expect((await mint(base, 'viewer')).status).toBe(201); // a read-only token is harmless
  });

  // [claims: capabilities/team-server#header-is-viewer-without-proxy]
  it('is a maintainer only through the proxy, where it can write and mint up to that role, and never an admin', async () => {
    const base = await start(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
    expect((await put(base)).status).toBe(200);
    expect((await mint(base, 'maintainer')).status).toBe(201);
    expect((await mint(base, 'admin')).status).toBe(403);
    const admin = await fetch(`${base}/api/v1/admin/tokens`, { method: 'POST', headers: xrw, body: JSON.stringify({ name: 'x', role: 'admin' }) });
    expect(admin.status).toBe(403);
    // a person who is not a listed maintainer is a viewer even through the proxy
    const bob = { 'x-deploykit-email': 'bob@acme.test', 'x-requested-with': 'specguard', 'content-type': 'application/json' };
    expect((await fetch(`${base}/api/v1/workspaces/y`, { method: 'PUT', headers: bob, body: '{"projects":[]}' })).status).toBe(403);
  });
});

describe('what the HTML page may do [html-headers]', () => {
  // [claims: capabilities/documentation-api#html-headers]
  it('cannot be framed, has no base URL or foreign form target, and sends no referrer, on both servers', async () => {
    const base = await start();
    const central = await fetch(`${base}/`, { headers: ADA });
    const check = (get: (k: string) => string | null | undefined) => {
      expect(get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(get('content-security-policy')).toContain("base-uri 'none'");
      expect(get('content-security-policy')).toContain("object-src 'none'");
      expect(get('x-frame-options')).toBe('DENY');
      expect(get('referrer-policy')).toBe('no-referrer');
      expect(get('x-content-type-options')).toBe('nosniff');
    };
    check((k) => central.headers.get(k));

    const repo = makeV2Repo();
    const listener = createRequestListener(await loadConfig(repo.dir), {});
    const local = http.createServer(listener);
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    try {
      const port = (local.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      check((k) => res.headers.get(k));
      const api = await fetch(`http://127.0.0.1:${port}/api/v1/system`);
      expect(api.headers.get('content-security-policy')).toBeNull(); // JSON carries no page policy
    } finally {
      await new Promise<void>((r) => local.close(() => r()));
    }
  });
});

describe('how often one caller may ask [rate-limit]', () => {
  const limits = { perMinute: 3, docsPerMinute: 2, anonymousPerMinute: 2 };

  // [claims: capabilities/team-server#server-rate-limits]
  it('counts per caller over a sliding minute, says how long to wait, and does not count a refused request', () => {
    const l = new RateLimiter(limits);
    expect(l.hit('ada', {}, 0)).toBeUndefined();
    expect(l.hit('ada', {}, 1_000)).toBeUndefined();
    expect(l.hit('ada', {}, 2_000)).toBeUndefined();
    expect(l.hit('ada', {}, 3_000)).toBe(57); // the first request leaves the window at 60s
    expect(l.hit('bob', {}, 3_000)).toBeUndefined(); // another caller is unaffected
    expect(l.hit('ada', {}, 60_001)).toBeUndefined();
  });

  // [claims: capabilities/team-server#server-rate-limits]
  it('holds document routes and credential-less callers to their own smaller limits', () => {
    const l = new RateLimiter(limits);
    expect(l.hit('ada', { docs: true }, 0)).toBeUndefined();
    expect(l.hit('ada', { docs: true }, 1)).toBeUndefined();
    expect(l.hit('ada', { docs: true }, 2)).toBeGreaterThan(0); // 3rd document request, though only 2 of 3 general ones were used
    expect(l.hit('ada', {}, 3)).toBeUndefined(); // ordinary requests still fit
    const anon = new RateLimiter(limits);
    expect(anon.hit('10.0.0.9', { anonymous: true }, 0)).toBeUndefined();
    expect(anon.hit('10.0.0.9', { anonymous: true }, 1)).toBeUndefined();
    expect(anon.hit('10.0.0.9', { anonymous: true }, 2)).toBeGreaterThan(0);
    expect(anon.hit('10.0.0.9', {}, 3)).toBeUndefined(); // a user and an address are counted apart
  });

  // [claims: capabilities/team-server#server-rate-limits]
  it('reads limits from the environment and ignores nonsense', () => {
    expect(rateLimitsFromEnv({})).toEqual({ perMinute: 600, docsPerMinute: 30, anonymousPerMinute: 60 });
    expect(rateLimitsFromEnv({ SPECGUARD_RATE_LIMIT_PER_MIN: '10', SPECGUARD_RATE_LIMIT_DOCS_PER_MIN: '2', SPECGUARD_RATE_LIMIT_ANON_PER_MIN: '5' })).toEqual({ perMinute: 10, docsPerMinute: 2, anonymousPerMinute: 5 });
    expect(rateLimitsFromEnv({ SPECGUARD_RATE_LIMIT_PER_MIN: '0', SPECGUARD_RATE_LIMIT_DOCS_PER_MIN: 'x' })).toEqual({ perMinute: 600, docsPerMinute: 30, anonymousPerMinute: 60 });
  });

  // [claims: capabilities/team-server#server-rate-limits]
  it('answers 429 with Retry-After over HTTP, for a signed-in caller, a document route and a caller with no credential, but never for health', async () => {
    const base = await start(['127.0.0.1', '::1', '::ffff:127.0.0.1'], limits);
    const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { headers });
    for (let i = 0; i < 3; i += 1) expect((await get('/api/v1/projects', ADA)).status).toBe(200);
    const over = await get('/api/v1/projects', ADA);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await over.json()) as { error: string }).error).toMatch(/too many requests/);
    // a different person is not affected
    expect((await get('/api/v1/projects', { 'x-deploykit-email': 'bob@acme.test' })).status).toBe(200);
    // no credential: 401 twice, then 429
    expect((await get('/api/v1/projects')).status).toBe(401);
    expect((await get('/api/v1/projects')).status).toBe(401);
    expect((await get('/api/v1/projects')).status).toBe(429);
    // health is never limited
    for (let i = 0; i < 10; i += 1) expect((await get('/api/v1/health')).status).toBe(200);
  });

  // [claims: capabilities/team-server#server-rate-limits]
  it('limits the routes that can start a model call more tightly than the rest', async () => {
    const base = await start(['127.0.0.1', '::1', '::ffff:127.0.0.1'], { perMinute: 100, docsPerMinute: 2, anonymousPerMinute: 100 });
    const docs = () => fetch(`${base}/api/v1/projects/none/docs/user/auth`, { headers: ADA });
    expect((await docs()).status).toBe(404); // an unknown project, but counted
    expect((await docs()).status).toBe(404);
    expect((await docs()).status).toBe(429);
    expect((await fetch(`${base}/api/v1/projects`, { headers: ADA })).status).toBe(200);
  });
});

describe('the trail a change leaves [audit-trail]', () => {
  const PROXY = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const put = (base: string, headers: Record<string, string>) => fetch(`${base}/api/v1/workspaces/sandbox`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json', 'x-requested-with': 'specguard' }, body: '{"projects":[{"project":"web"}]}' });

  // [claims: capabilities/team-server#server-audit-trail]
  it('records who changed a workspace, and who tried to change one and was refused, and why', async () => {
    const base = await start(PROXY);
    const mint = await fetch(`${base}/api/v1/admin/tokens`, { method: 'POST', headers: { authorization: `Bearer ${BOOTSTRAP}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'v', role: 'viewer' }) });
    const viewerToken = ((await mint.json()) as { token: string }).token;
    expect((await put(base, { authorization: `Bearer ${viewerToken}` })).status).toBe(403);
    expect((await put(base, {})).status).toBe(401);
    expect((await put(base, ADA)).status).toBe(200);
    const trail = (await lastBackend!.readAudit()).filter((e) => e.action.startsWith('write.') || e.action === 'workspace.put');
    expect(trail.map((e) => e.action)).toEqual(['write.refused', 'write.refused', 'workspace.put']);
    expect(trail[0].detail).toContain('needs the maintainer role, has viewer');
    expect(trail[1]).toMatchObject({ actor: 'anonymous' });
    expect(trail[2]).toMatchObject({ actor: 'ada@acme.test', detail: 'sandbox: 1 project(s)' });
  });

  // [claims: capabilities/team-server#server-audit-trail]
  it('does not record a refused read, and writes no audit entry when the server is not asked to change anything', async () => {
    const base = await start(PROXY);
    await fetch(`${base}/api/v1/projects`, { headers: ADA });
    await fetch(`${base}/api/v1/projects`);
    expect(await lastBackend!.readAudit()).toEqual([]);
  });
});

