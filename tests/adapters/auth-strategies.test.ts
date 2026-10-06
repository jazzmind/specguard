import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  authenticate,
  authRunner,
  clearSessionCache,
  contextOptionsFor,
  isLoggedInUrl,
  isLoginUrl,
  storageStateFile,
} from '../../src/adapters/auth-state-machine.js';
import type { BrowserHandle } from '../../src/adapters/playwright.js';
import type { AuthProfile, SpecGuardConfig } from '../../src/core/types.js';

const root = () => mkdtempSync(path.join(os.tmpdir(), 'sg-auth-'));
const config = (profiles: AuthProfile[], rootDir: string): SpecGuardConfig => ({
  rootDir,
  apps: [],
  llm: { provider: 'none', model: 'n', apiKeyEnv: 'N' },
  auth: { profiles },
});

beforeEach(() => {
  clearSessionCache();
  for (const k of ['SG_USER', 'SG_PASS', 'SG_TOKEN', 'SG_KEY']) delete process.env[k];
});
afterEach(() => vi.restoreAllMocks());

describe('login URL predicate', () => {
  it('compares origin and path, so look-alike paths are not the login page', () => {
    expect(isLoginUrl('https://app.example/login', 'https://app.example/login')).toBe(true);
    expect(isLoginUrl('https://app.example/login/', 'https://app.example/login')).toBe(true);
    expect(isLoginUrl('https://app.example/login?next=/home#x', 'https://app.example/login')).toBe(true);
    expect(isLoginUrl('https://app.example/login', '/login')).toBe(true);
    expect(isLoginUrl('https://app.example/login-success', 'https://app.example/login')).toBe(false);
    expect(isLoginUrl('https://app.example/loginhistory', 'https://app.example/login')).toBe(false);
    expect(isLoginUrl('https://app.example/account/login', 'https://app.example/login')).toBe(false);
    expect(isLoginUrl('https://other.example/login', 'https://app.example/login')).toBe(false);
    expect(isLoginUrl('not a url', '/login')).toBe(false);
  });

  it('logged in means off the login page, or on the configured success URL', () => {
    const p = { loginUrl: 'https://app.example/login' };
    expect(isLoggedInUrl('https://app.example/home', p)).toBe(true);
    expect(isLoggedInUrl('https://app.example/login-success', p)).toBe(true);
    expect(isLoggedInUrl('https://app.example/login?error=1', p)).toBe(false);
    expect(isLoggedInUrl('https://app.example/home', { ...p, successUrl: '/dashboard' })).toBe(false);
    expect(isLoggedInUrl('https://app.example/dashboard/', { ...p, successUrl: '/dashboard' })).toBe(true);
    expect(isLoggedInUrl('https://app.example/app/42/overview', { ...p, successUrl: '/app\\/\\d+\\/overview/' })).toBe(true);
    expect(isLoggedInUrl('https://app.example/app/x/overview', { ...p, successUrl: '/app\\/\\d+\\/overview/' })).toBe(false);
  });
});

describe('fillAndSubmit with a fake page', () => {
  const profile: AuthProfile = { name: 'p', loginUrl: 'https://app.example/login', usernameEnvVar: 'SG_USER', passwordEnvVar: 'SG_PASS' };

  function pageThatEndsAt(finalUrl: string) {
    let url = 'https://app.example/login';
    const page = {
      goto: vi.fn(async (u: string) => void (url = u)),
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => void (url = finalUrl)),
      waitForURL: vi.fn(async (pred: (u: URL) => boolean) => {
        if (!pred(new URL(url))) throw new Error('Timeout waiting for URL');
      }),
      url: () => url,
    };
    return { _browser: {}, _page: page, _consoleErrors: [] } as unknown as BrowserHandle;
  }

  it('succeeds when the browser leaves the login page, including a /login-success page', async () => {
    const res = await authRunner.fillAndSubmit(pageThatEndsAt('https://app.example/login-success'), profile, 'u', 'p');
    expect(res).toEqual({ success: true });
  });

  it('fails when the login page is still showing', async () => {
    const res = await authRunner.fillAndSubmit(pageThatEndsAt('https://app.example/login?error=1'), profile, 'u', 'p');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Timeout|still on the login page/);
  });

  it('without waitForURL it still refuses to report success on the login page', async () => {
    const handle = pageThatEndsAt('https://app.example/login');
    delete (handle._page as { waitForURL?: unknown }).waitForURL;
    const res = await authRunner.fillAndSubmit(handle, profile, 'u', 'p');
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('still on the login page') });
  });

  it('rewrites the login URL for a containerised browser', async () => {
    const handle = pageThatEndsAt('https://app.example/home');
    handle._rewriteUrl = (u) => u.replace('app.example', 'host.docker.internal');
    await authRunner.fillAndSubmit(handle, profile, 'u', 'p');
    expect((handle._page as { goto: ReturnType<typeof vi.fn> }).goto.mock.calls[0][0]).toBe('https://host.docker.internal/login');
  });
});

describe('context options per strategy', () => {
  it('header: resolves each header from its env var and names the missing one', () => {
    const profile: AuthProfile = { name: 'svc', strategy: 'header', headers: { 'X-Api-Key': 'SG_KEY' } };
    expect(contextOptionsFor(profile, '/r').error).toMatch(/SG_KEY/);
    process.env.SG_KEY = 'k-123';
    expect(contextOptionsFor(profile, '/r')).toEqual({ options: { extraHTTPHeaders: { 'X-Api-Key': 'k-123' } } });
  });

  it('token: Authorization Bearer by default, configurable header and prefix', () => {
    process.env.SG_TOKEN = 't-9';
    expect(contextOptionsFor({ name: 'a', strategy: 'token', tokenEnvVar: 'SG_TOKEN' }, '/r').options).toEqual({
      extraHTTPHeaders: { Authorization: 'Bearer t-9' },
    });
    expect(contextOptionsFor({ name: 'a', strategy: 'token', tokenEnvVar: 'SG_TOKEN', tokenHeader: 'X-Token', tokenPrefix: '' }, '/r').options).toEqual({
      extraHTTPHeaders: { 'X-Token': 't-9' },
    });
    delete process.env.SG_TOKEN;
    expect(contextOptionsFor({ name: 'a', strategy: 'token', tokenEnvVar: 'SG_TOKEN' }, '/r').error).toMatch(/SG_TOKEN/);
  });

  it('storageState: uses .specguard/auth/<profile>.json when it exists', () => {
    const dir = root();
    const profile: AuthProfile = { name: 'admin user', strategy: 'storageState' };
    expect(storageStateFile(profile, dir)).toBe(path.join(dir, '.specguard', 'auth', 'admin_user.json'));
    expect(contextOptionsFor(profile, dir).options).toEqual({});
    mkdirSync(path.join(dir, '.specguard', 'auth'), { recursive: true });
    writeFileSync(storageStateFile(profile, dir), '{}');
    expect(contextOptionsFor(profile, dir).options).toEqual({ storageState: storageStateFile(profile, dir) });
    expect(storageStateFile({ name: 'x', storageStatePath: 'custom/state.json' }, dir)).toBe(path.join(dir, 'custom', 'state.json'));
  });
});

describe('authenticate per strategy', () => {
  const handle = (extra: Record<string, unknown> = {}) => ({ _browser: {}, _page: {}, _consoleErrors: [], ...extra }) as unknown as BrowserHandle;

  it('token and header succeed when their env vars are set, and fail naming the variable', async () => {
    const dir = root();
    const cfg = config([{ name: 'api', strategy: 'token', tokenEnvVar: 'SG_TOKEN' }], dir);
    expect((await authenticate(handle(), 'api', cfg)).error).toMatch(/SG_TOKEN/);
    process.env.SG_TOKEN = 'secret-token';
    expect(await authenticate(handle(), 'api', cfg)).toEqual({ success: true, profile: 'api' });
  });

  it('script: runs the project module, and rejects a path outside the project', async () => {
    const dir = root();
    writeFileSync(path.join(dir, 'login.mjs'), "export default async ({ page }) => { page.visited = true; };");
    const page: Record<string, unknown> = {};
    const cfg = config([{ name: 's', strategy: 'script', scriptPath: 'login.mjs' }], dir);
    expect(await authenticate(handle({ _page: page }), 's', cfg, { rootDir: dir })).toEqual({ success: true, profile: 's' });
    expect(page.visited).toBe(true);
    clearSessionCache();
    const outside = config([{ name: 's', strategy: 'script', scriptPath: '../evil.mjs' }], dir);
    expect((await authenticate(handle(), 's', outside, { rootDir: dir })).error).toMatch(/inside the project/);
    clearSessionCache();
    const missing = config([{ name: 's', strategy: 'script', scriptPath: 'nope.mjs' }], dir);
    expect((await authenticate(handle(), 's', missing, { rootDir: dir })).error).toMatch(/not found/);
  });

  it('storageState: an existing file is a ready session with no login', async () => {
    const dir = root();
    const profile: AuthProfile = { name: 'saved', strategy: 'storageState' };
    mkdirSync(path.join(dir, '.specguard', 'auth'), { recursive: true });
    writeFileSync(storageStateFile(profile, dir), '{}');
    const spy = vi.spyOn(authRunner, 'fillAndSubmit');
    expect(await authenticate(handle(), 'saved', config([profile], dir))).toEqual({ success: true, profile: 'saved' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('storageState: without a file it logs in with the form and saves the state under .specguard/auth', async () => {
    const dir = root();
    process.env.SG_USER = 'u@example.com';
    process.env.SG_PASS = 'pw-1';
    const profile: AuthProfile = { name: 'saved', strategy: 'storageState', loginUrl: '/login', usernameEnvVar: 'SG_USER', passwordEnvVar: 'SG_PASS' };
    vi.spyOn(authRunner, 'fillAndSubmit').mockResolvedValue({ success: true });
    const storageState = vi.fn(async ({ path: file }: { path: string }) => writeFileSync(file, '{"cookies":[]}'));
    const result = await authenticate(handle({ _context: { storageState } }), 'saved', config([profile], dir));
    expect(result.success).toBe(true);
    expect(storageState).toHaveBeenCalledOnce();
    expect(existsSync(storageStateFile(profile, dir))).toBe(true);
    expect(readFileSync(storageStateFile(profile, dir), 'utf8')).toContain('cookies');
  });

  it('storageState: no file and no form configured is a clear error', async () => {
    const dir = root();
    const res = await authenticate(handle(), 'saved', config([{ name: 'saved', strategy: 'storageState' }], dir));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No saved login/);
  });

  it('a failed form login redacts credentials from the error', async () => {
    const dir = root();
    process.env.SG_USER = 'user@example.com';
    process.env.SG_PASS = 'hunter2hunter2';
    vi.spyOn(authRunner, 'fillAndSubmit').mockResolvedValue({ success: false, error: 'bad password hunter2hunter2 for user@example.com' });
    const res = await authenticate(handle(), 'f', config([{ name: 'f', loginUrl: '/login', usernameEnvVar: 'SG_USER', passwordEnvVar: 'SG_PASS' }], dir));
    expect(res.error).not.toContain('hunter2hunter2');
    expect(res.error).not.toContain('user@example.com');
    expect(res.error).toContain('[REDACTED]');
  });

  it('config validation: each strategy states what it needs', async () => {
    const { loadConfig } = await import('../../src/core/config.js');
    const base = { apps: [{ name: 'a', repo: '.', specDir: 's', sources: {}, framework: 'vitest', testOutput: 't' }], llm: { provider: 'none', model: 'n', apiKeyEnv: 'N' } };
    const dir = root();
    const write = (profiles: unknown[]) => {
      mkdirSync(path.join(dir, '.specguard'), { recursive: true });
      writeFileSync(path.join(dir, '.specguard', 'config.json'), JSON.stringify({ ...base, auth: { profiles } }));
    };
    write([{ name: 'a' }]);
    await expect(loadConfig(dir)).rejects.toThrow(/strategy form needs loginUrl/);
    write([{ name: 'a', strategy: 'header' }]);
    await expect(loadConfig(dir)).rejects.toThrow(/needs headers/);
    write([{ name: 'a', strategy: 'token' }]);
    await expect(loadConfig(dir)).rejects.toThrow(/needs tokenEnvVar/);
    write([{ name: 'a', strategy: 'script' }]);
    await expect(loadConfig(dir)).rejects.toThrow(/needs scriptPath/);
    write([{ name: 'a', strategy: 'storageState' }, { name: 'b', strategy: 'token', tokenEnvVar: 'T' }]);
    expect((await loadConfig(dir)).auth?.profiles).toHaveLength(2);
  });
});
