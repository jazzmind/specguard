import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { buildServer } from '../../src/mcp/server.js';

function registered(): Map<string, { description?: string; inputSchema?: Record<string, unknown> }> {
  const tools = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
  const spy = vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(((name: string, config: { description?: string; inputSchema?: Record<string, unknown> }) => {
    tools.set(name, config);
    return {} as never;
  }) as never);
  buildServer();
  spy.mockRestore();
  return tools;
}

describe('MCP tools for the functional-spec commands [mcp-functional-tools]', () => {
  const tools = registered();

  // [claims: capabilities/integration-surfaces#mcp-tools-parity]
  it('exposes check, the spec graph, history, test runs and security [names]', () => {
    for (const name of [
      'specguard_check',
      'specguard_spec_graph',
      'specguard_history_add',
      'specguard_history_log',
      'specguard_test_run',
      'specguard_security_scan',
      'specguard_security_plan',
      'specguard_verify',
    ]) {
      expect(tools.has(name), name).toBe(true);
    }
  });

  it('keeps validate and adds verify as a second name with its own description [verify-alias]', () => {
    expect(tools.has('specguard_validate')).toBe(true);
    expect(tools.get('specguard_verify')?.description).toContain('capability');
    expect(tools.get('specguard_validate')?.description).toContain('PERCEIVE-PLAN-ACT-VERIFY');
    expect(Object.keys(tools.get('specguard_verify')?.inputSchema ?? {})).toEqual(Object.keys(tools.get('specguard_validate')?.inputSchema ?? {}));
  });

  // [claims: capabilities/integration-surfaces#plugin-commands]
  it('no longer registers the tools that plugins provide; they register while the plugin is enabled [plugin-tools-not-static]', () => {
    for (const name of ['specguard_quality', 'specguard_commit', 'specguard_feature_state', 'specguard_features']) {
      expect(tools.has(name), name).toBe(false);
    }
  });

  // [claims: capabilities/integration-surfaces#mcp-tools-parity]
  it('takes typed inputs where they matter [inputs]', () => {
    expect(Object.keys(tools.get('specguard_test_run')?.inputSchema ?? {})).toEqual(['app', 'units', 'affected', 'since', 'cwd']);
    expect(Object.keys(tools.get('specguard_security_plan')?.inputSchema ?? {})).toContain('action');
  });
});
