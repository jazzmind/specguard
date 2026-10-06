/**
 * Auth state machine adapter.
 *
 * Handles deterministic browser-based authentication for the validate pipeline.
 * Credentials come from environment variables only — never from config values
 * directly, never sent to the LLM.
 *
 * Strategies (per profile):
 *   form          NavigateToLogin → FillCredentials → WaitForResult → Success | Failed
 *   storageState  reuse `.specguard/auth/<profile>.json`; create it with a form login when missing
 *   header/token  request headers on the profile's context, no login page
 *   script        a project module drives the page
 *
 * Each profile gets its own browser context (see `contextOptionsFor`), and
 * sessions are cached per profile name (in-memory).
 *
 * Spec: specs/adapters/auth-state-machine.md
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SpecGuardConfig, AuthProfile } from '../core/types.js';
import type { BrowserHandle, ContextOpts } from './playwright.js';
import { saveStorageState } from './playwright.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an authentication attempt. */
export interface AuthResult {
  success: boolean;
  profile: string;
  error?: string;
}

export interface AuthOpts {
  /** Config root, for `.specguard/auth/` and `scriptPath`. Default: `config.rootDir` or cwd. */
  rootDir?: string;
}

// ---------------------------------------------------------------------------
// Session cache (in-memory, per-process)
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, AuthResult>();

/** Empty the session cache. Call between validate runs or in test cleanup. */
export function clearSessionCache(): void {
  sessionCache.clear();
}

// ---------------------------------------------------------------------------
// Credential redaction
// ---------------------------------------------------------------------------

/** Every secret value this profile can read from the environment. */
function secretValues(profile: AuthProfile): string[] {
  const names = [
    profile.usernameEnvVar,
    profile.passwordEnvVar,
    profile.tokenEnvVar,
    ...Object.values(profile.headers ?? {}),
  ].filter((n): n is string => Boolean(n));
  return names.map((n) => process.env[n]).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Replace all occurrences of credential values with `[REDACTED]` in `text`.
 * Call this on any string before logging that may have been derived from an
 * auth flow.
 */
export function redact(text: string, profile: AuthProfile): string {
  let result = text;
  for (const secret of secretValues(profile)) result = result.split(secret).join('[REDACTED]');
  return result;
}

// ---------------------------------------------------------------------------
// URL predicates
// ---------------------------------------------------------------------------

function resolveAgainst(url: string, base?: string): URL | null {
  try {
    return base ? new URL(url, base) : new URL(url);
  } catch {
    return null;
  }
}

/** origin + pathname, no trailing slash, no query, no hash. */
function pageKey(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.origin}${pathname}`;
}

/**
 * True when `current` is the login page itself. Compares origin and path, so
 * `/login?next=/home` is still the login page, while `/login-success` and
 * `/loginhistory` are not (a substring test would call them the login page).
 * A relative `loginUrl` is resolved against the current origin.
 */
export function isLoginUrl(current: string, loginUrl: string): boolean {
  const now = resolveAgainst(current);
  if (!now) return false;
  const login = resolveAgainst(loginUrl, now.origin);
  if (!login) return false;
  return pageKey(now) === pageKey(login);
}

/**
 * True when `current` counts as logged in. With `successUrl` (a URL, a path, or
 * `/regex/`) the page must match it; otherwise it must simply not be the login page.
 */
export function isLoggedInUrl(current: string, profile: Pick<AuthProfile, 'loginUrl' | 'successUrl'>): boolean {
  if (profile.successUrl) {
    const spec = profile.successUrl;
    const regex = /^\/(.+)\/([a-z]*)$/.exec(spec);
    if (regex) {
      try {
        return new RegExp(regex[1], regex[2]).test(current);
      } catch {
        return false;
      }
    }
    const now = resolveAgainst(current);
    const want = resolveAgainst(spec, now?.origin);
    return Boolean(now && want && pageKey(now) === pageKey(want));
  }
  return !profile.loginUrl || !isLoginUrl(current, profile.loginUrl);
}

// ---------------------------------------------------------------------------
// Per-profile context options
// ---------------------------------------------------------------------------

function rootOf(config: SpecGuardConfig, opts?: AuthOpts): string {
  return opts?.rootDir ?? config.rootDir ?? process.cwd();
}

/** Where a profile's saved browser state lives. */
export function storageStateFile(profile: AuthProfile, rootDir: string): string {
  return path.resolve(rootDir, profile.storageStatePath ?? path.join('.specguard', 'auth', `${profile.name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`));
}

/** The strategy a profile uses. */
export function strategyOf(profile: AuthProfile): NonNullable<AuthProfile['strategy']> {
  return profile.strategy ?? 'form';
}

/**
 * What the profile's browser context must be created with: a saved login, or
 * headers every request carries. Missing credentials give `error`, not a throw.
 */
export function contextOptionsFor(
  profile: AuthProfile,
  rootDir: string,
): { options: ContextOpts; error?: string } {
  const strategy = strategyOf(profile);
  if (strategy === 'storageState') {
    const file = storageStateFile(profile, rootDir);
    return { options: existsSync(file) ? { storageState: file } : {} };
  }
  if (strategy === 'header') {
    const headers: Record<string, string> = {};
    for (const [header, envVar] of Object.entries(profile.headers ?? {})) {
      const value = process.env[envVar];
      if (!value) return { options: {}, error: `Missing credentials env var: ${envVar}` };
      headers[header] = value;
    }
    return { options: { extraHTTPHeaders: headers } };
  }
  if (strategy === 'token') {
    const envVar = profile.tokenEnvVar ?? '';
    const value = process.env[envVar];
    if (!value) return { options: {}, error: `Missing credentials env var: ${envVar}` };
    const header = profile.tokenHeader ?? 'Authorization';
    const prefix = profile.tokenPrefix ?? 'Bearer ';
    return { options: { extraHTTPHeaders: { [header]: `${prefix}${value}` } } };
  }
  return { options: {} };
}

// ---------------------------------------------------------------------------
// Internal: page interaction seams
// ---------------------------------------------------------------------------

interface LoginPage {
  goto: (url: string, opts?: unknown) => Promise<unknown>;
  fill: (selector: string, value: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  waitForURL?: (pattern: string | RegExp | ((url: URL) => boolean), opts?: unknown) => Promise<void>;
  waitForSelector?: (selector: string, opts?: unknown) => Promise<unknown>;
  waitForTimeout?: (ms: number) => Promise<void>;
  url: () => string;
}

/** Auth runner seam — tests stub `authRunner.fillAndSubmit` and `authRunner.runScript`. */
export const authRunner = {
  async fillAndSubmit(
    handle: BrowserHandle,
    profile: AuthProfile,
    username: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    const page = handle._page as LoginPage;
    const loginUrl = profile.loginUrl ?? '';

    try {
      await page.goto(handle._rewriteUrl ? handle._rewriteUrl(loginUrl) : loginUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

      const usernameSelector =
        profile.usernameSelector ?? '[name="username"],[type="email"],[name="email"]';
      const passwordSelector = profile.passwordSelector ?? '[type="password"]';
      const submitSelector = profile.submitSelector ?? '[type="submit"]';

      await page.fill(usernameSelector, username);
      await page.fill(passwordSelector, password);
      await page.click(submitSelector);

      // Wait for the browser to leave the login page (or reach the configured success URL).
      if (page.waitForURL) {
        await page.waitForURL((url: URL) => isLoggedInUrl(String(url), profile), { timeout: 10_000 });
      } else if (page.waitForTimeout) {
        await page.waitForTimeout(1_500);
      }
      if (profile.successSelector && page.waitForSelector) {
        await page.waitForSelector(profile.successSelector, { state: 'visible', timeout: 10_000 });
      }

      // Never report success while still on the login page (a rejected login re-renders it).
      const finalUrl = page.url();
      if (!isLoggedInUrl(finalUrl, profile)) {
        return { success: false, error: 'still on the login page after submitting; check the credentials and selectors' };
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  },

  async runScript(
    handle: BrowserHandle,
    profile: AuthProfile,
    rootDir: string,
  ): Promise<{ success: boolean; error?: string }> {
    const abs = path.resolve(rootDir, profile.scriptPath ?? '');
    const rel = path.relative(rootDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { success: false, error: `auth script ${profile.scriptPath} must be inside the project` };
    }
    if (!existsSync(abs)) return { success: false, error: `auth script not found: ${profile.scriptPath}` };
    try {
      const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
      if (typeof mod.default !== 'function') {
        return { success: false, error: `auth script ${profile.scriptPath} must export a default async function` };
      }
      await (mod.default as (ctx: unknown) => Promise<void>)({
        page: handle._page,
        context: handle._context,
        profile: { name: profile.name },
        env: process.env,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Authenticate using the named profile on `handle` (a context created from
 * `contextOptionsFor(profile)`). Returns a cached result if the profile was
 * already authenticated in this process.
 */
export async function authenticate(
  handle: BrowserHandle,
  profileName: string,
  config: SpecGuardConfig,
  opts?: AuthOpts,
): Promise<AuthResult> {
  // Return cached session if available.
  const cached = sessionCache.get(profileName);
  if (cached) return cached;

  // Look up the profile.
  const profile = config.auth?.profiles.find((p) => p.name === profileName);
  if (!profile) {
    return { success: false, profile: profileName, error: `Profile not found: ${profileName}` };
  }

  const rootDir = rootOf(config, opts);
  const strategy = strategyOf(profile);
  const fail = (error: string): AuthResult => ({ success: false, profile: profileName, error: redact(error, profile) });
  const done = (): AuthResult => {
    const ok: AuthResult = { success: true, profile: profileName };
    sessionCache.set(profileName, ok);
    return ok;
  };

  if (strategy === 'header' || strategy === 'token') {
    // The headers are on the context already; they only need to be present.
    const { error } = contextOptionsFor(profile, rootDir);
    return error ? fail(error) : done();
  }

  if (strategy === 'script') {
    const res = await authRunner.runScript(handle, profile, rootDir);
    return res.success ? done() : fail(`Login failed: ${res.error ?? 'unknown error'}`);
  }

  if (strategy === 'storageState') {
    const file = storageStateFile(profile, rootDir);
    if (existsSync(file)) return done();
    if (!(profile.loginUrl && profile.usernameEnvVar && profile.passwordEnvVar)) {
      return fail(`No saved login at ${path.relative(rootDir, file)} and no form login configured to create it`);
    }
    // Fall through to a form login, then save the state.
  }

  // Resolve credentials from env — never from config values.
  const username = process.env[profile.usernameEnvVar ?? ''];
  const password = process.env[profile.passwordEnvVar ?? ''];

  if (!username) {
    return { success: false, profile: profileName, error: `Missing credentials env var: ${profile.usernameEnvVar}` };
  }
  if (!password) {
    return { success: false, profile: profileName, error: `Missing credentials env var: ${profile.passwordEnvVar}` };
  }

  // Execute the login state machine.
  const loginResult = await authRunner.fillAndSubmit(handle, profile, username, password);
  if (!loginResult.success) {
    // Redact credentials from error messages before storing/returning.
    return fail(`Login failed: ${loginResult.error ?? 'unknown error'}`);
  }

  if (strategy === 'storageState') {
    try {
      await saveStorageState(handle, storageStateFile(profile, rootDir));
    } catch (err) {
      return fail(`Logged in but could not save the browser state: ${(err as Error).message}`);
    }
  }
  return done();
}
