/**
 * Rate limits for the team server.
 *
 * Each caller (the signed-in user, or the connecting address when there is no credential) gets a fixed number of
 * requests a minute, a smaller one for the routes that can start a model call (`/docs/`), and anyone with no credential
 * a small one too, which also slows down guessing tokens. A caller over a limit gets `429` with `Retry-After`. Counters
 * live in memory: one server process, which is how it is deployed.
 *
 * Spec: specs/capabilities/team-server.md
 */

export interface RateLimitConfig {
  /** Requests per minute for a signed-in caller. Default 600. */
  perMinute: number;
  /** Requests per minute to document routes, which can cost model spend. Default 30. */
  docsPerMinute: number;
  /** Requests per minute with no valid credential, per connecting address. Default 60. */
  anonymousPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = { perMinute: 600, docsPerMinute: 30, anonymousPerMinute: 60 };

export function rateLimitsFromEnv(env: NodeJS.ProcessEnv): RateLimitConfig {
  const n = (v: string | undefined, d: number): number => (v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    perMinute: n(env.SPECGUARD_RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMITS.perMinute),
    docsPerMinute: n(env.SPECGUARD_RATE_LIMIT_DOCS_PER_MIN, DEFAULT_RATE_LIMITS.docsPerMinute),
    anonymousPerMinute: n(env.SPECGUARD_RATE_LIMIT_ANON_PER_MIN, DEFAULT_RATE_LIMITS.anonymousPerMinute),
  };
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly config: RateLimitConfig = DEFAULT_RATE_LIMITS) {}

  /**
   * Count a request. Returns the seconds to wait when it is over a limit (the request is not counted), else undefined.
   * `caller` is a user or address; `anonymous` says it has no credential; `docs` marks a route that can start a model call.
   */
  hit(caller: string, opts: { anonymous?: boolean; docs?: boolean } = {}, now: number = Date.now()): number | undefined {
    this.sweep(now);
    const checks: Array<[string, number]> = [[`${opts.anonymous ? 'anon' : 'user'}:${caller}`, opts.anonymous ? this.config.anonymousPerMinute : this.config.perMinute]];
    if (opts.docs) checks.push([`docs:${caller}`, this.config.docsPerMinute]);
    for (const [key, limit] of checks) {
      const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= limit) return Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
    }
    for (const [key] of checks) this.hits.set(key, [...(this.hits.get(key) ?? []).filter((t) => now - t < 60_000), now]);
    return undefined;
  }

  /** Forget callers that have been quiet for a minute, so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) if (times.every((t) => now - t >= 60_000)) this.hits.delete(key);
  }
}
