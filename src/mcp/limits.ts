/**
 * Limits on what an agent can do through the MCP server in one process.
 *
 * The server runs as the user who started it and trusts its client, as any stdio tool does: there is nothing to
 * authenticate. What it can do is bound, though. A runaway or misdirected agent loop is cut off by a per-minute call
 * limit (a tighter one for history entries, which are permanent files), and `SPECGUARD_MCP_READONLY=1` stops the server
 * offering any tool that changes files.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */

/** Tools that create or change files. Not offered when the server is read-only. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'specguard_write_spec',
  'specguard_history_add',
  'specguard_agent_work',
  'specguard_init',
  'specguard_scaffold',
  'specguard_generate',
  'specguard_reverse',
  'specguard_heal',
  'specguard_import',
  'specguard_test_run',
  'specguard_verify',
  'specguard_validate',
  'specguard_security',
  'specguard_security_scan',
  'specguard_results_ingest',
  'specguard_proof_ingest',
  'specguard_contracts',
  'specguard_docs',
  'specguard_matrix',
  'specguard_remediate',
  'specguard_claims',
  'specguard_gap_analysis',
  'specguard_drift',
  'specguard_status',
  'specguard_security_plan',
]);

export const mcpReadOnly = (env: NodeJS.ProcessEnv = process.env): boolean => env.SPECGUARD_MCP_READONLY === '1';

export interface RateLimits {
  /** Calls per minute across every tool. */
  perMinute: number;
  /** Calls per minute of `history-add`, which writes a permanent entry each time. */
  historyPerMinute: number;
}

export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimits {
  const n = (v: string | undefined, d: number): number => (v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return { perMinute: n(env.SPECGUARD_MCP_RATE_PER_MIN, 300), historyPerMinute: n(env.SPECGUARD_MCP_HISTORY_PER_MIN, 20) };
}

/** A sliding one-minute window of call times, per key. */
export class CallLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(private readonly limits: () => RateLimits = rateLimitsFromEnv) {}

  /** Record a call to `tool`; a message when it is over a limit (and the call is not recorded), else undefined. */
  check(tool: string, now: number = Date.now()): string | undefined {
    const { perMinute, historyPerMinute } = this.limits();
    const recent = (key: string): number[] => (this.calls.get(key) ?? []).filter((t) => now - t < 60_000);
    const all = recent('*');
    if (all.length >= perMinute) return `rate limit: more than ${perMinute} tool calls in a minute. Slow down; set SPECGUARD_MCP_RATE_PER_MIN to change it.`;
    if (tool === 'history-add') {
      const history = recent('history-add');
      if (history.length >= historyPerMinute) return `rate limit: more than ${historyPerMinute} history entries in a minute. Set SPECGUARD_MCP_HISTORY_PER_MIN to change it.`;
      this.calls.set('history-add', [...history, now]);
    }
    this.calls.set('*', [...all, now]);
    return undefined;
  }
}

/** The one limiter for this process. */
export const mcpLimiter = new CallLimiter();
