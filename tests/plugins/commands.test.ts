import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerPluginCommands } from '../../src/cli/plugin-commands.js';
import { registerPluginTools } from '../../src/mcp/server.js';
import { enabledPluginCommands } from '../../src/plugins/commands.js';
import { collectFeatures, plugin as featureCatalog } from '../../src/plugins/feature-catalog/index.js';
import { mappingImporter } from '../../src/plugins/contract-mappings/index.js';
import { makeRepo } from '../helpers/repo.js';

const names = async (cwd: string) => (await enabledPluginCommands(cwd)).map((c) => c.name).sort();

describe('plugin commands [plugin-commands]', () => {
  // [claims: capabilities/integration-surfaces#plugin-commands, capabilities/integration-surfaces#core-plugin-boundary]
  it('are available only while the plugin is enabled in config [enabled-only]', async () => {
    expect(await names(makeRepo({}).dir)).toEqual([]);
    expect(await names(makeRepo({ plugins: ['quality'] }).dir)).toEqual(['quality']);
    expect(await names(makeRepo({ plugins: ['quality', 'git', 'feature-catalog'] }).dir)).toEqual(['commit', 'features', 'quality']);
  });

  // [claims: capabilities/integration-surfaces#plugin-commands, capabilities/integration-surfaces#plugin-contract]
  it('an unknown plugin is reported once and yields no commands instead of blocking the CLI [unknown-plugin]', async () => {
    const warn = vi.fn();
    expect(await enabledPluginCommands(makeRepo({ plugins: ['nope'] }).dir, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("unknown plugin 'nope'");
    expect(await enabledPluginCommands('/nonexistent-dir-for-specguard')).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#plugin-commands]
  it('are registered on the CLI with their options, and a core command wins a name clash [cli]', async () => {
    const repo = makeRepo({ plugins: ['quality', 'git'] });
    const program = new Command();
    program.command('commit').description('the core one');
    await registerPluginCommands(program, repo.dir);
    const byName = Object.fromEntries(program.commands.map((c) => [c.name(), c]));
    expect(byName.quality.description()).toContain('code quality');
    expect(byName.quality.options.map((o) => o.long)).toEqual(['--app', '--fix']);
    expect(byName.commit.description()).toBe('the core one');
    expect(byName.commit.options).toHaveLength(0);
  });

  // [claims: capabilities/integration-surfaces#plugin-commands]
  it('are registered on the MCP server with typed inputs, under the names the static tools had [mcp]', async () => {
    const repo = makeRepo({ plugins: ['quality', 'git', 'feature-catalog'] });
    const tools = new Map<string, { schema: { inputSchema: Record<string, unknown> }; handler: (i: Record<string, unknown>) => Promise<unknown> }>();
    const server = { registerTool: (name: string, schema: never, handler: never) => void tools.set(name, { schema, handler }) };
    const registered = await registerPluginTools(server as never, repo.dir);
    expect(registered.sort()).toEqual(['specguard_commit', 'specguard_features', 'specguard_quality']);
    expect(Object.keys(tools.get('specguard_quality')!.schema.inputSchema).sort()).toEqual(['app', 'cwd', 'fix']);
    expect(Object.keys(tools.get('specguard_commit')!.schema.inputSchema).sort()).toEqual(['app', 'cwd', 'dryRun', 'message']);
    const res = (await tools.get('specguard_features')!.handler({ cwd: repo.dir })) as { content: Array<{ text: string }> };
    // No spec carries a `feature:`, so the JSON list in the tool's text is empty.
    expect(res.content[0].text.split('\n')).toContain('[]');
  });

  // [claims: capabilities/integration-surfaces#plugin-commands]
  it('none are registered for a repo that enables no plugins [none]', async () => {
    const server = { registerTool: vi.fn() };
    expect(await registerPluginTools(server as never, makeRepo({}).dir)).toEqual([]);
    expect(server.registerTool).not.toHaveBeenCalled();
  });
});

describe('features command [features-plugin]', () => {
  // [claims: capabilities/integration-surfaces#feature-catalog]
  it('maps specs to catalog feature ids, as JSON a script can parse [features-json]', async () => {
    const repo = makeRepo({ plugins: ['feature-catalog'] });
    repo.write('specs/orders.md', '# Orders\n\n<!--\n  module: src/orders.ts\n  feature: orders.list, orders.create\n-->\n\n## Overview\n\nx\n');
    const cmd = featureCatalog.commands![0];
    expect(cmd.output).toBe('messages');
    const { loadConfig } = await import('../../src/core/config.js');
    const config = await loadConfig(repo.dir);
    expect(collectFeatures(config)).toEqual([{ spec: 'app:orders', features: ['orders.list', 'orders.create'] }]);
    const result = await cmd.run({ config, opts: {}, args: [] });
    expect(JSON.parse(result.messages[0])).toEqual([{ spec: 'app:orders', features: ['orders.list', 'orders.create'] }]);
  });
});

describe('contract mappings importer [contract-mappings]', () => {
  const manifest = (root: string) => ({ rootDir: root, repos: { web: { path: 'web' }, api: { path: 'api' } } });

  // [claims: capabilities/integration-surfaces#contract-mappings-importer]
  it('reads the default file shape and turns provider and doc paths into node ids [defaults]', () => {
    const repo = makeRepo({});
    repo.write('.specguard/contract-mappings.json', JSON.stringify({ mappings: [{ spec: 'orders', providers: ['../api/specs/orders.md'], docs: '../api/docs/orders.md' }] }));
    const root = path.dirname(repo.dir);
    const edges = mappingImporter.read({ key: 'web', absPath: repo.dir }, { rootDir: root, repos: { web: { path: path.basename(repo.dir) }, api: { path: 'api' } } });
    expect(edges).toEqual([
      { consumerSpec: 'orders', providerPath: 'api::specs/orders.md', docPage: null, type: 'dependency' },
      { consumerSpec: 'orders', providerPath: 'api::docs/orders.md', docPage: '../api/docs/orders.md', type: 'docs' },
    ]);
  });

  // [claims: capabilities/integration-surfaces#contract-mappings-importer]
  it('reads any other shape when config names the file and keys, and nothing when the file is missing or malformed [custom-keys]', () => {
    const repo = makeRepo({});
    repo.write('qa/links.json', JSON.stringify({ links: [{ consumer: 'orders', calls: ['../api/specs/orders.md'], page: '../api/docs/orders.md' }] }));
    const root = path.dirname(repo.dir);
    const m = { rootDir: root, repos: { web: { path: path.basename(repo.dir) }, api: { path: 'api' } } };
    const config = { contractMappings: { file: 'qa/links.json', list: 'links', spec: 'consumer', providers: ['calls'], docs: 'page', edgeType: 'rest' } } as never;
    const edges = mappingImporter.read({ key: 'web', absPath: repo.dir }, m, config);
    expect(edges.map((e) => [e.providerPath, e.type])).toEqual([['api::specs/orders.md', 'rest'], ['api::docs/orders.md', 'docs']]);
    expect(mappingImporter.read({ key: 'web', absPath: repo.dir }, manifest(root))).toEqual([]);
    writeFileSync(path.join(repo.dir, 'qa/links.json'), 'not json');
    expect(mappingImporter.read({ key: 'web', absPath: repo.dir }, m, config)).toEqual([]);
  });
});
