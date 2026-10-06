import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as pw from '../../src/adapters/playwright.js';
import * as auth from '../../src/adapters/auth-state-machine.js';
import { SessionPool } from '../../src/adapters/sessions.js';
import type { BrowserHandle } from '../../src/adapters/playwright.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

const config: SpecGuardConfig = {
  rootDir: '/proj',
  apps: [],
  llm: { provider: 'none', model: 'n', apiKeyEnv: 'N' },
  auth: {
    profiles: [
      { name: 'admin', loginUrl: '/login', usernameEnvVar: 'A_U', passwordEnvVar: 'A_P' },
      { name: 'learner', loginUrl: '/login', usernameEnvVar: 'L_U', passwordEnvVar: 'L_P' },
      { name: 'svc', strategy: 'token', tokenEnvVar: 'SVC_T' },
    ],
  },
};
const browser = { _browser: {}, _page: {}, _consoleErrors: [], _ownsBrowser: true } as unknown as BrowserHandle;

let opened: Array<{ id: number; options: unknown }>;
beforeEach(() => {
  opened = [];
  let n = 0;
  vi.spyOn(pw, 'openSession').mockImplementation(async (_b, options) => {
    n += 1;
    opened.push({ id: n, options });
    return { _browser: {}, _page: { id: n }, _consoleErrors: [], _ownsBrowser: false } as unknown as BrowserHandle;
  });
  vi.spyOn(pw, 'closeBrowser').mockResolvedValue();
  vi.spyOn(auth, 'authenticate').mockResolvedValue({ success: true, profile: 'x' });
  process.env.SVC_T = 'tok';
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SVC_T;
});

describe('SessionPool', () => {
  it('gives each auth profile its own context, reuses it, and keeps anonymous pages on the first context', async () => {
    const pool = new SessionPool(browser, config, '/proj');
    const anon = await pool.acquire(undefined);
    expect(anon.handle).toBe(browser);
    const admin = await pool.acquire('admin');
    const learner = await pool.acquire('learner');
    expect(admin.handle).not.toBe(learner.handle);
    expect((await pool.acquire('admin')).handle).toBe(admin.handle);
    expect(opened).toHaveLength(2);
    expect(auth.authenticate).toHaveBeenCalledTimes(2);
  });

  it('passes the profile context options (headers) when the context is created', async () => {
    const pool = new SessionPool(browser, config, '/proj');
    await pool.acquire('svc');
    expect(opened[0].options).toEqual({ extraHTTPHeaders: { Authorization: 'Bearer tok' } });
  });

  it('a failed login closes its context, is not cached, and is retried', async () => {
    vi.mocked(auth.authenticate).mockResolvedValueOnce({ success: false, profile: 'admin', error: 'nope' });
    const pool = new SessionPool(browser, config, '/proj');
    const first = await pool.acquire('admin');
    expect(first.auth).toMatchObject({ success: false, error: 'nope' });
    expect(pw.closeBrowser).toHaveBeenCalledTimes(1);
    const second = await pool.acquire('admin');
    expect(second.auth?.success).toBe(true);
    expect(opened).toHaveLength(2);
  });

  it('an unknown profile or missing credentials is an auth failure, not a throw', async () => {
    const pool = new SessionPool(browser, config, '/proj');
    expect((await pool.acquire('ghost')).auth).toMatchObject({ success: false, error: expect.stringContaining('Profile not found') });
    delete process.env.SVC_T;
    expect((await pool.acquire('svc')).auth).toMatchObject({ success: false, error: expect.stringContaining('SVC_T') });
    expect(opened).toHaveLength(0);
  });

  it('closeAll closes the contexts it opened and not the browser', async () => {
    const pool = new SessionPool(browser, config, '/proj');
    await pool.acquire(undefined);
    await pool.acquire('admin');
    await pool.acquire('learner');
    await pool.closeAll();
    expect(pw.closeBrowser).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pw.closeBrowser).mock.calls.some((c) => c[0] === browser)).toBe(false);
  });
});
