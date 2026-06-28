/**
 * Auth state machine adapter.
 *
 * Handles deterministic browser-based authentication for the validate pipeline.
 * Credentials come from environment variables only — never from config values
 * directly, never sent to the LLM.
 *
 * State machine:
 *   NavigateToLogin → FillCredentials → WaitForResult → Success | 2FA | Failed
 *
 * Sessions are cached per profile name (in-memory). The validate pipeline
 * calls authenticate() once per profile and reuses the result.
 *
 * Spec: specs/adapters/auth-state-machine.md
 */
import type { SpecGuardConfig, AuthProfile } from '../core/types.js';
import type { BrowserHandle } from './playwright.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an authentication attempt. */
export interface AuthResult {
  success: boolean;
  profile: string;
  error?: string;
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

/**
 * Replace all occurrences of credential values with `[REDACTED]` in `text`.
 * Call this on any string before logging that may have been derived from an
 * auth flow.
 */
export function redact(text: string, profile: AuthProfile): void;
export function redact(text: string, profile: AuthProfile): string;
export function redact(text: string, profile: AuthProfile): string {
  let result = text;

  const username = process.env[profile.usernameEnvVar];
  const password = process.env[profile.passwordEnvVar];

  if (username && username.length > 0) {
    result = result.split(username).join('[REDACTED]');
  }
  if (password && password.length > 0) {
    result = result.split(password).join('[REDACTED]');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal: page interaction seam
// ---------------------------------------------------------------------------

/** Auth runner seam — tests stub `authRunner.fillAndSubmit`. */
export const authRunner = {
  async fillAndSubmit(
    handle: BrowserHandle,
    profile: AuthProfile,
    username: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    const page = handle._page as {
      goto: (url: string, opts?: unknown) => Promise<unknown>;
      fill: (selector: string, value: string) => Promise<void>;
      click: (selector: string) => Promise<void>;
      waitForNavigation?: (opts?: unknown) => Promise<unknown>;
      waitForURL?: (pattern: string | RegExp | ((url: string) => boolean), opts?: unknown) => Promise<void>;
      url: () => string;
    };

    try {
      await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

      const usernameSelector =
        profile.usernameSelector ?? '[name="username"],[type="email"],[name="email"]';
      const passwordSelector = profile.passwordSelector ?? '[type="password"]';
      const submitSelector = profile.submitSelector ?? '[type="submit"]';

      await page.fill(usernameSelector, username);
      await page.fill(passwordSelector, password);
      await page.click(submitSelector);

      // Wait briefly for the result.
      if (page.waitForURL) {
        await page.waitForURL((url: string) => !url.includes(profile.loginUrl), {
          timeout: 10_000,
        });
      }

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Authenticate using the named profile. Returns a cached result if the
 * profile was already authenticated in this process.
 */
export async function authenticate(
  handle: BrowserHandle,
  profileName: string,
  config: SpecGuardConfig,
): Promise<AuthResult> {
  // Return cached session if available.
  const cached = sessionCache.get(profileName);
  if (cached) return cached;

  // Look up the profile.
  const profile = config.auth?.profiles.find((p) => p.name === profileName);
  if (!profile) {
    const result: AuthResult = {
      success: false,
      profile: profileName,
      error: `Profile not found: ${profileName}`,
    };
    return result;
  }

  // Resolve credentials from env — never from config values.
  const username = process.env[profile.usernameEnvVar];
  const password = process.env[profile.passwordEnvVar];

  if (!username) {
    return {
      success: false,
      profile: profileName,
      error: `Missing credentials env var: ${profile.usernameEnvVar}`,
    };
  }
  if (!password) {
    return {
      success: false,
      profile: profileName,
      error: `Missing credentials env var: ${profile.passwordEnvVar}`,
    };
  }

  // Execute the login state machine.
  const loginResult = await authRunner.fillAndSubmit(handle, profile, username, password);

  const authResult: AuthResult = loginResult.success
    ? { success: true, profile: profileName }
    : {
        success: false,
        profile: profileName,
        // Redact credentials from error messages before storing/returning.
        error: `Login failed: ${redact(loginResult.error ?? 'unknown error', profile)}`,
      };

  // Cache successful authentications only.
  if (authResult.success) {
    sessionCache.set(profileName, authResult);
  }

  return authResult;
}
