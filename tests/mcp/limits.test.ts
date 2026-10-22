import { describe, expect, it } from 'vitest';

import { CallLimiter, mcpReadOnly, rateLimitsFromEnv, WRITE_TOOLS } from '../../src/mcp/limits.js';
import { buildServer, CORE_TOOLS } from '../../src/mcp/server.js';

describe('what an agent can do through MCP in a minute [mcp-limits]', () => {
  const limiter = (perMinute: number, historyPerMinute: number) => new CallLimiter(() => ({ perMinute, historyPerMinute }));

  // [claims: capabilities/integration-surfaces#mcp-limits]
  it('allows up to the per-minute limit across all tools, then answers with a message, until the window moves on', () => {
    const l = limiter(3, 10);
    expect(l.check('check', 0)).toBeUndefined();
    expect(l.check('status', 10)).toBeUndefined();
    expect(l.check('impact', 20)).toBeUndefined();
    expect(l.check('check', 30)).toMatch(/more than 3 tool calls in a minute.*SPECGUARD_MCP_RATE_PER_MIN/);
    expect(l.check('check', 30)).toMatch(/rate limit/); // a refused call is not counted, so this stays refused until time passes
    expect(l.check('check', 60_001)).toBeUndefined(); // the first three have left the window
  });

  // [claims: capabilities/integration-surfaces#mcp-limits]
  it('holds history entries to a tighter limit that does not use up the general one', () => {
    const l = limiter(100, 2);
    expect(l.check('history-add', 0)).toBeUndefined();
    expect(l.check('history-add', 1)).toBeUndefined();
    expect(l.check('history-add', 2)).toMatch(/more than 2 history entries in a minute/);
    expect(l.check('history-log', 3)).toBeUndefined();
    expect(l.check('history-add', 60_005)).toBeUndefined();
  });

  // [claims: capabilities/integration-surfaces#mcp-limits]
  it('reads its limits from the environment and ignores nonsense', () => {
    expect(rateLimitsFromEnv({})).toEqual({ perMinute: 300, historyPerMinute: 20 });
    expect(rateLimitsFromEnv({ SPECGUARD_MCP_RATE_PER_MIN: '50', SPECGUARD_MCP_HISTORY_PER_MIN: '5' })).toEqual({ perMinute: 50, historyPerMinute: 5 });
    expect(rateLimitsFromEnv({ SPECGUARD_MCP_RATE_PER_MIN: '-4', SPECGUARD_MCP_HISTORY_PER_MIN: 'many' })).toEqual({ perMinute: 300, historyPerMinute: 20 });
  });

  // [claims: capabilities/integration-surfaces#mcp-readonly]
  it('read-only mode is switched on only by SPECGUARD_MCP_READONLY=1, and names every default tool that changes files', () => {
    expect(mcpReadOnly({})).toBe(false);
    expect(mcpReadOnly({ SPECGUARD_MCP_READONLY: '0' })).toBe(false);
    expect(mcpReadOnly({ SPECGUARD_MCP_READONLY: '1' })).toBe(true);
    for (const tool of ['specguard_write_spec', 'specguard_history_add', 'specguard_init', 'specguard_test_run', 'specguard_verify', 'specguard_security_scan', 'specguard_results_ingest', 'specguard_contracts']) {
      expect(WRITE_TOOLS.has(tool), tool).toBe(true);
    }
    // the read-only tools an agent needs to look around
    const readers = [...CORE_TOOLS].filter((t) => !WRITE_TOOLS.has(t)).sort();
    expect(readers).toEqual(expect.arrayContaining(['specguard_check', 'specguard_read_spec', 'specguard_spec_graph', 'specguard_history_log', 'specguard_proof_status', 'specguard_impact', 'specguard_workspace_status']));
  });

  // [claims: capabilities/integration-surfaces#mcp-readonly]
  it('a read-only server really offers no tool that changes files, and the normal one offers them', () => {
    const names = (): string[] => Object.keys((buildServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const before = process.env.SPECGUARD_MCP_READONLY;
    try {
      delete process.env.SPECGUARD_MCP_READONLY;
      const normal = names();
      expect(normal).toEqual(expect.arrayContaining(['specguard_write_spec', 'specguard_history_add', 'specguard_check']));
      process.env.SPECGUARD_MCP_READONLY = '1';
      const readOnly = names();
      expect(readOnly.filter((n) => WRITE_TOOLS.has(n))).toEqual([]);
      expect(readOnly).toEqual(expect.arrayContaining(['specguard_check', 'specguard_read_spec', 'specguard_spec_graph']));
      expect(readOnly.length).toBeLessThan(normal.length);
    } finally {
      if (before === undefined) delete process.env.SPECGUARD_MCP_READONLY;
      else process.env.SPECGUARD_MCP_READONLY = before;
    }
  });
});
