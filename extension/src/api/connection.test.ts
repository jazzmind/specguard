import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { connect, normalizeUrl, readSavedToken, readServerConfig, resolveServer } from './connection.js';

function workspace(server?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-conn-'));
  fs.mkdirSync(path.join(root, '.specguard'), { recursive: true });
  fs.writeFileSync(path.join(root, '.specguard', 'config.json'), JSON.stringify({ apps: [], ...(server ? { server } : {}) }));
  return root;
}

const HEALTH = { ok: true, apiVersion: 1, engineVersion: '0.3.0', hashVersion: 1, writable: true };

/** A fake fetch: health answers `health`, the project's system route answers `system` (a status code or a body). */
function fakeFetch(over: { health?: unknown; healthStatus?: number; system?: number | unknown; down?: boolean } = {}) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (over.down) throw new Error('connect ECONNREFUSED');
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (u.endsWith('/api/v1/health')) return reply(over.healthStatus ?? 200, over.health ?? HEALTH);
    if (u.endsWith('/system')) return typeof over.system === 'number' ? reply(over.system, { error: `status ${over.system}` }) : reply(200, over.system ?? { capabilities: [] });
    return reply(404, { error: 'no route' });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const base = (root: string, extra: Partial<Parameters<typeof connect>[0]> = {}) => ({
  workspaceRoot: root,
  settings: {},
  resolveCli: async () => '/fake/specguard.js',
  env: { HOME: root } as NodeJS.ProcessEnv,
  startLocal: async () => ({ url: 'http://127.0.0.1:5555', dispose: vi.fn() }),
  ...extra,
});

describe('connecting [ext-connection]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('serves the workspace locally when no server is configured [no-server]', async () => {
    const root = workspace();
    const startLocal = vi.fn(async () => ({ url: 'http://127.0.0.1:5555/', dispose: vi.fn() }));
    const live = await connect(base(root, { startLocal }));
    expect(live).toMatchObject({ source: 'local', url: 'http://127.0.0.1:5555' });
    expect(live.notice).toBeUndefined();
    expect(live.client.target).toEqual({ baseUrl: 'http://127.0.0.1:5555' });
    expect(startLocal).toHaveBeenCalledWith('/fake/specguard.js', root);
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('uses the team server when it is configured, healthy and has the project, with the token it was given [server]', async () => {
    const root = workspace({ url: 'http://sandbox/specguard/', project: 'portal' });
    const f = fakeFetch();
    const startLocal = vi.fn();
    const live = await connect(base(root, { fetchImpl: f.impl, startLocal, storedToken: 'sg_stored' }));
    expect(live).toMatchObject({ source: 'server', url: 'http://sandbox/specguard', project: 'portal', health: HEALTH });
    expect(live.client.target).toEqual({ baseUrl: 'http://sandbox/specguard', project: 'portal', token: 'sg_stored' });
    expect(startLocal).not.toHaveBeenCalled();
    expect(f.calls.map((c) => c.url)).toEqual(['http://sandbox/specguard/api/v1/health', 'http://sandbox/specguard/api/v1/projects/portal/system']);
    // The probe of the project carries the credential.
    expect(f.calls[1].auth).toBe('Bearer sg_stored');
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('falls back to the local server, with a reason, when the server is down, refuses, lacks the project or is another version [fallbacks]', async () => {
    const root = workspace({ url: 'http://sandbox/specguard', project: 'portal' });
    const cases: Array<[Parameters<typeof fakeFetch>[0], RegExp]> = [
      [{ down: true }, /unavailable.*ECONNREFUSED/],
      [{ system: 401 }, /did not accept your credentials/],
      [{ system: 404 }, /not on the team server yet/],
      [{ health: { ...HEALTH, apiVersion: 7 } }, /API version 7/],
      [{ health: { hello: 'world' } }, /does not look like a SpecGuard server/],
      [{ healthStatus: 503, health: {} }, /unavailable/],
    ];
    for (const [over, notice] of cases) {
      const live = await connect(base(root, { fetchImpl: fakeFetch(over).impl }));
      expect(live.source).toBe('local');
      expect(live.notice).toMatch(notice);
      expect(live.notice).toContain('Showing local data');
    }
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('never contacts a server when the mode is off, and lets the editor setting win over the project\'s [off-and-override]', async () => {
    const root = workspace({ url: 'http://configured/specguard', project: 'portal' });
    const f = fakeFetch();
    expect((await connect(base(root, { fetchImpl: f.impl, settings: { mode: 'off', url: 'http://x' } }))).source).toBe('local');
    expect(f.calls).toEqual([]);
    const live = await connect(base(root, { fetchImpl: f.impl, settings: { url: 'http://override/sg', project: 'other' } }));
    expect(live).toMatchObject({ source: 'server', url: 'http://override/sg', project: 'other' });
    const projectOff = workspace({ url: 'http://configured/specguard', mode: 'off' });
    expect(resolveServer(base(projectOff))).toBeNull();
  });
});

describe('server settings [ext-server-settings]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('reads the project\'s server block, names the project after the directory by default, and finds a token in order [resolve]', () => {
    const root = workspace({ url: 'http://sandbox/sg' });
    expect(readServerConfig(root)).toEqual({ url: 'http://sandbox/sg' });
    expect(readServerConfig('/no/such/dir')).toEqual({});
    expect(resolveServer(base(root))).toEqual({ url: 'http://sandbox/sg', project: path.basename(root) });
    // Stored token beats the environment, which beats the saved login.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-home-'));
    fs.mkdirSync(path.join(home, '.config', 'specguard'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'specguard', 'credentials.json'), JSON.stringify({ 'http://sandbox/sg': { token: 'sg_saved' } }));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    expect(readSavedToken('http://Sandbox/sg/', env)).toBe('sg_saved');
    expect(resolveServer(base(root, { env }))!.token).toBe('sg_saved');
    expect(resolveServer(base(root, { env: { ...env, SPECGUARD_TOKEN: 'sg_env' } }))!.token).toBe('sg_env');
    expect(resolveServer(base(root, { env: { ...env, SPECGUARD_TOKEN: 'sg_env' }, storedToken: 'sg_stored' }))!.token).toBe('sg_stored');
    expect(normalizeUrl('HTTP://Host:80/a//')).toBe('http://host/a');
  });
});
