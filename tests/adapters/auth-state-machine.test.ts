import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  authenticate,
  clearSessionCache,
  redact,
  authRunner,
} from '../../src/adapters/auth-state-machine.js';
import type { SpecGuardConfig } from '../../src/core/types.js';
import type { BrowserHandle } from '../../src/adapters/playwright.js';

function makeHandle(): BrowserHandle {
  return {
    _browser: { close: vi.fn(async () => {}) },
    _page: {},
    _consoleErrors: [],
  };
}

function makeConfig(profileOverrides?: Partial<{ usernameEnvVar: string; passwordEnvVar: string }>): SpecGuardConfig {
  return {
    apps: [],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
    auth: {
      profiles: [
        {
          name: 'admin',
          loginUrl: 'http://localhost:3000/login',
          usernameEnvVar: profileOverrides?.usernameEnvVar ?? 'TEST_ADMIN_USER',
          passwordEnvVar: profileOverrides?.passwordEnvVar ?? 'TEST_ADMIN_PASS',
        },
      ],
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearSessionCache();
  // Clean up env vars between tests
  delete process.env['TEST_ADMIN_USER'];
  delete process.env['TEST_ADMIN_PASS'];
});

describe('authenticate', () => {
  it('scenario 1: successful login caches and returns success', async () => {
    process.env['TEST_ADMIN_USER'] = 'admin@example.com';
    process.env['TEST_ADMIN_PASS'] = 'secret123';

    vi.spyOn(authRunner, 'fillAndSubmit').mockResolvedValue({ success: true });

    const handle = makeHandle();
    const result = await authenticate(handle, 'admin', makeConfig());

    expect(result.success).toBe(true);
    expect(result.profile).toBe('admin');
    expect(result.error).toBeUndefined();
    expect(authRunner.fillAndSubmit).toHaveBeenCalledOnce();

    // Second call should use cache (no second fillAndSubmit call).
    const result2 = await authenticate(handle, 'admin', makeConfig());
    expect(result2.success).toBe(true);
    expect(authRunner.fillAndSubmit).toHaveBeenCalledOnce();
  });

  it('scenario 2: missing password env var returns error without throwing', async () => {
    process.env['TEST_ADMIN_USER'] = 'admin@example.com';
    // TEST_ADMIN_PASS not set

    const handle = makeHandle();
    const result = await authenticate(handle, 'admin', makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain('TEST_ADMIN_PASS');
    expect(result.error).toContain('Missing credentials env var');
  });

  it('scenario 3: unknown profile returns error', async () => {
    const handle = makeHandle();
    const result = await authenticate(handle, 'nonexistent', makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Profile not found: nonexistent');
  });

  it('redacts credentials from login failure error messages', async () => {
    process.env['TEST_ADMIN_USER'] = 'admin@example.com';
    process.env['TEST_ADMIN_PASS'] = 'supersecret';

    vi.spyOn(authRunner, 'fillAndSubmit').mockResolvedValue({
      success: false,
      error: 'Authentication failed for admin@example.com with password supersecret',
    });

    const handle = makeHandle();
    const result = await authenticate(handle, 'admin', makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('supersecret');
    expect(result.error).not.toContain('admin@example.com');
    expect(result.error).toContain('[REDACTED]');
  });

  it('failed login is not cached', async () => {
    process.env['TEST_ADMIN_USER'] = 'admin@example.com';
    process.env['TEST_ADMIN_PASS'] = 'wrongpassword';

    vi.spyOn(authRunner, 'fillAndSubmit').mockResolvedValue({
      success: false,
      error: 'Invalid credentials',
    });

    const handle = makeHandle();
    await authenticate(handle, 'admin', makeConfig());
    await authenticate(handle, 'admin', makeConfig());

    // fillAndSubmit should be called both times (no caching on failure)
    expect(authRunner.fillAndSubmit).toHaveBeenCalledTimes(2);
  });
});

describe('redact', () => {
  it('scenario 4: replaces credential values with [REDACTED]', () => {
    process.env['TEST_ADMIN_USER'] = 'admin@example.com';
    process.env['TEST_ADMIN_PASS'] = 'secretABC';

    const config = makeConfig();
    const profile = config.auth!.profiles[0];

    const result = redact('Error: invalid password secretABC for admin@example.com', profile);
    expect(result).not.toContain('secretABC');
    expect(result).not.toContain('admin@example.com');
    expect(result).toBe('Error: invalid password [REDACTED] for [REDACTED]');
  });

  it('is a no-op when env vars are not set', () => {
    const config = makeConfig();
    const profile = config.auth!.profiles[0];
    const text = 'Some log message';
    expect(redact(text, profile)).toBe(text);
  });
});

describe('clearSessionCache', () => {
  it('removes cached sessions so authenticate runs again', async () => {
    process.env['TEST_ADMIN_USER'] = 'u';
    process.env['TEST_ADMIN_PASS'] = 'p';
    vi.spyOn(authRunner, 'fillAndSubmit').mockResolvedValue({ success: true });

    const handle = makeHandle();
    await authenticate(handle, 'admin', makeConfig());
    clearSessionCache();
    await authenticate(handle, 'admin', makeConfig());

    expect(authRunner.fillAndSubmit).toHaveBeenCalledTimes(2);
  });
});
