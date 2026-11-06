import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerPluginCommands } from '../../src/cli/plugin-commands.js';
import { registerPluginTools, registerPluginToolsUnlessReadOnly } from '../../src/mcp/server.js';
import { enabledPluginCommands } from '../../src/plugins/commands.js';

/** A workspace root with no config of its own, over repos of which one enables the plugin. */
function overlay(plugins: string[][]): { root: string; elsewhere: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-pcw-'));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  const repos: Record<string, { path: string; role: string }> = {};
  plugins.forEach((list, i) => {
    repos[`r${i}`] = { path: `../r${i}`, role: i === 0 ? 'consumer' : 'provider' };
    put(`r${i}/.specguard/config.json`, JSON.stringify({ apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }], llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' }, plugins: list }));
  });
  put('ws/.specguard/workspace.json', JSON.stringify({ version: '1', name: 'ws', repos }));
  mkdirSync(path.join(dir, 'elsewhere'), { recursive: true });
  return { root: path.join(dir, 'ws'), elsewhere: path.join(dir, 'elsewhere') };
}

describe('plugin commands from a workspace root [plugin-commands-from-workspace]', () => {
  // [claims: capabilities/workspaces#plugin-commands-from-workspace]
  it('uses the union of the repos plugins when the folder has no config but a workspace manifest', async () => {
    const { root } = overlay([['quality'], ['contract-mappings'], ['quality']]);
    expect((await enabledPluginCommands(root)).map((c) => c.name).sort()).toEqual(['contracts-map', 'quality']);
  });

  // [claims: capabilities/workspaces#plugin-commands-from-workspace]
  it('registers contracts-map on the CLI and the MCP server from there, and names no commands where there is no workspace', async () => {
    const { root, elsewhere } = overlay([[], ['contract-mappings']]);
    const program = new Command();
    await registerPluginCommands(program, root);
    expect(program.commands.map((c) => c.name())).toEqual(['contracts-map']);
    const server = { registerTool: vi.fn() };
    expect(await registerPluginTools(server as never, root)).toEqual(['specguard_contracts-map']);
    expect(await enabledPluginCommands(elsewhere)).toEqual([]);
  });

  // [claims: capabilities/workspaces#plugin-commands-from-workspace]
  it('finds the workspace named with --workspace from any folder', async () => {
    const { root, elsewhere } = overlay([['contract-mappings']]);
    expect((await enabledPluginCommands(elsewhere, undefined, root)).map((c) => c.name)).toEqual(['contracts-map']);
    const program = new Command();
    await registerPluginCommands(program, elsewhere, ['contracts-map', '--workspace', root]);
    expect(program.commands.map((c) => c.name())).toEqual(['contracts-map']);
  });

  // [claims: capabilities/integration-surfaces#mcp-readonly]
  it('offers no specguard_contracts-map tool when SPECGUARD_MCP_READONLY=1', async () => {
    const { root } = overlay([['contract-mappings']]);
    const before = process.env.SPECGUARD_MCP_READONLY;
    try {
      process.env.SPECGUARD_MCP_READONLY = '1';
      const readOnly = { registerTool: vi.fn() };
      expect(await registerPluginToolsUnlessReadOnly(readOnly as never, root)).toEqual([]);
      expect(readOnly.registerTool).not.toHaveBeenCalled();
      delete process.env.SPECGUARD_MCP_READONLY;
      expect(await registerPluginToolsUnlessReadOnly({ registerTool: vi.fn() } as never, root)).toEqual(['specguard_contracts-map']);
    } finally {
      if (before === undefined) delete process.env.SPECGUARD_MCP_READONLY;
      else process.env.SPECGUARD_MCP_READONLY = before;
    }
  });
});
