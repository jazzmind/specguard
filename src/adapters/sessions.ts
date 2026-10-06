/**
 * Browser sessions for the validate pipeline: one browser per run, one context
 * per auth profile (and one for anonymous pages), so a login never leaks into
 * another profile and a spec without `auth:` never runs logged in.
 *
 * Spec: specs/adapters/auth-state-machine.md
 */
import type { SpecGuardConfig } from '../core/types.js';
import { authenticate, contextOptionsFor, type AuthResult } from './auth-state-machine.js';
import { closeBrowser, openSession, type BrowserHandle } from './playwright.js';

export interface Session {
  handle: BrowserHandle;
  auth?: AuthResult;
}

const ANONYMOUS = '(anonymous)';

export class SessionPool {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly browser: BrowserHandle,
    private readonly config: SpecGuardConfig,
    private readonly rootDir: string,
  ) {}

  /**
   * The context for `profileName`, created and logged in on first use. A failed
   * login returns `{ auth: { success: false } }` and is retried on the next request.
   */
  async acquire(profileName?: string): Promise<Session> {
    const key = profileName ?? ANONYMOUS;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    if (!profileName) {
      // The browser's own first context is the anonymous one.
      const anon: Session = { handle: this.browser };
      this.sessions.set(key, anon);
      return anon;
    }

    const profile = this.config.auth?.profiles.find((p) => p.name === profileName);
    if (!profile) {
      return { handle: this.browser, auth: { success: false, profile: profileName, error: `Profile not found: ${profileName}` } };
    }

    const { options, error } = contextOptionsFor(profile, this.rootDir);
    if (error) return { handle: this.browser, auth: { success: false, profile: profileName, error } };

    const handle = await openSession(this.browser, options);
    const auth = await authenticate(handle, profileName, this.config, { rootDir: this.rootDir });
    if (!auth.success) {
      await closeBrowser(handle);
      return { handle: this.browser, auth };
    }
    const session: Session = { handle, auth };
    this.sessions.set(key, session);
    return session;
  }

  /** Close every context this pool opened. The browser itself is closed by whoever launched it. */
  async closeAll(): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (key === ANONYMOUS) continue;
      await closeBrowser(session.handle);
    }
    this.sessions.clear();
  }
}
