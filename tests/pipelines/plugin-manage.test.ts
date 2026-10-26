import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUILTIN_PLUGINS } from '../../src/plugins/catalog.js';
import { loadPlugins } from '../../src/plugins/index.js';
import { loadConfig } from '../../src/core/config.js';
import {
  addNpmPlugin,
  disablePlugin,
  enablePlugin,
  formatPluginRows,
  listPlugins,
  removeNpmPlugin,
} from '../../src/pipelines/plugin-manage.js';
import { installNpmPlugin } from '../helpers/npm-plugin.js';
import { makeRepo, type TmpRepo } from '../helpers/repo.js';
import { readdirSync } from 'node:fs';

const cfgPath = (r: TmpRepo): string => path.join(r.dir, '.specguard', 'config.json');
const raw = (r: TmpRepo): Record<string, unknown> => JSON.parse(readFileSync(cfgPath(r), 'utf-8'));
const NPM_PLUGIN = "exports.plugin = { id: 'acme', meta: { title: 'Acme checks', description: 'Acme house rules' }, commands: [{ name: 'acme', description: 'run acme', async run() { return { pipeline: 'acme', messages: [], items: [], created: 0, updated: 0, skipped: 0, failed: 0, exitCode: 0 }; } }] };";

describe('plugin catalog [plugin-catalog]', () => {
  // [claims: capabilities/integration-surfaces#plugin-catalog]
  it('lists exactly the built-in plugin directories, and each plugin exports the id it is listed under', async () => {
    const dirs = readdirSync(path.resolve(__dirname, '../../src/plugins'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(BUILTIN_PLUGINS.map((p) => p.id).sort()).toEqual(dirs);
    for (const p of BUILTIN_PLUGINS) expect((await loadPlugins([p.id]))[0].id).toBe(p.id);
  });
});

describe('plugin management [plugin-manage]', () => {
  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('lists every built-in with whether it is on and the commands it adds', async () => {
    const repo = makeRepo({ plugins: ['quality'] });
    const { plugins } = await listPlugins(repo.dir);
    expect(plugins.map((p) => [p.id, p.enabled])).toEqual([['quality', true], ['git', false], ['feature-catalog', false], ['contract-mappings', false]]);
    expect(plugins.find((p) => p.id === 'quality')).toMatchObject({ source: 'builtin', commands: ['quality'], inherited: false });
    expect(formatPluginRows(plugins)[0]).toMatch(/^on\s+quality/);
  });

  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('enables and disables a built-in by editing only the repo\'s own config', async () => {
    const repo = makeRepo({ plugins: ['quality'], note: 'keep me' });
    expect((await enablePlugin(repo.dir, 'git')).changed).toBe(true);
    expect(raw(repo)).toMatchObject({ plugins: ['quality', 'git'], note: 'keep me' });
    expect((await enablePlugin(repo.dir, 'git')).changed).toBe(false);
    expect((await disablePlugin(repo.dir, 'quality')).changed).toBe(true);
    expect(raw(repo).plugins).toEqual(['git']);
    expect((await disablePlugin(repo.dir, 'quality')).note).toMatch(/not enabled/);
    expect((await loadConfig(repo.dir)).plugins).toEqual(['git']);
    await expect(enablePlugin(repo.dir, 'nope')).rejects.toThrow(/unknown plugin 'nope'/);
    await expect(enablePlugin(repo.dir, '../x')).rejects.toThrow(/invalid plugin name/);
  });

  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('turns off a plugin that an extended config enables, without restating the parent\'s list', async () => {
    const parent = makeRepo({ plugins: ['quality', 'git'] });
    const child = makeRepo({ extends: parent.dir });
    expect((await loadConfig(child.dir)).plugins).toEqual(['quality', 'git']);
    expect((await listPlugins(child.dir)).plugins.find((p) => p.id === 'git')).toMatchObject({ enabled: true, inherited: true });

    const off = await disablePlugin(child.dir, 'git');
    expect(off.note).toMatch(/extended config enables it/);
    expect(raw(child).disabledPlugins).toEqual(['git']);
    expect(raw(child).plugins).toBeUndefined(); // still inherits the parent's list
    expect((await loadConfig(child.dir)).plugins).toEqual(['quality']);
    expect((await listPlugins(child.dir)).plugins.find((p) => p.id === 'git')).toMatchObject({ enabled: false, disabledHere: true });

    // turning it back on only clears the override; nothing is copied into the child
    await enablePlugin(child.dir, 'git');
    expect(raw(child).disabledPlugins).toBeUndefined();
    expect(raw(child).plugins).toBeUndefined();
    expect((await loadConfig(child.dir)).plugins).toEqual(['quality', 'git']);
  });

  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('enabling in a child with no list of its own keeps what it inherits', async () => {
    const parent = makeRepo({ plugins: ['quality'] });
    const child = makeRepo({ extends: parent.dir });
    await enablePlugin(child.dir, 'feature-catalog');
    expect(raw(child).plugins).toEqual(['quality', 'feature-catalog']);
    expect((await loadConfig(child.dir)).plugins).toEqual(['quality', 'feature-catalog']);
  });

  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('adds an npm plugin only when confirmed and only if it loads as a plugin with that id', async () => {
    const repo = makeRepo({ plugins: ['quality'] });
    installNpmPlugin(repo, 'acme-plugin', NPM_PLUGIN);
    await expect(addNpmPlugin(repo.dir, 'acme', 'acme-plugin', { confirmed: false })).rejects.toThrow(/runs that package's code/);
    expect(raw(repo).plugins).toEqual(['quality']);
    await expect(addNpmPlugin(repo.dir, 'other', 'acme-plugin', { confirmed: true })).rejects.toThrow(/unknown plugin 'other'/);
    await expect(addNpmPlugin(repo.dir, 'acme', '../evil', { confirmed: true })).rejects.toThrow(/invalid plugin package/);
    await expect(addNpmPlugin(repo.dir, 'quality', 'acme-plugin', { confirmed: true })).rejects.toThrow(/built-in/);

    expect((await addNpmPlugin(repo.dir, 'acme', 'acme-plugin', { confirmed: true })).changed).toBe(true);
    expect(raw(repo).plugins).toEqual(['quality', { name: 'acme', package: 'acme-plugin' }]);
    const row = (await listPlugins(repo.dir)).plugins.find((p) => p.id === 'acme');
    expect(row).toMatchObject({ source: 'npm', package: 'acme-plugin', title: 'Acme checks', description: 'Acme house rules', enabled: true, commands: ['acme'] });
    expect((await addNpmPlugin(repo.dir, 'acme', 'acme-plugin', { confirmed: true })).changed).toBe(false);
  });

  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('keeps a disabled npm plugin listed with its package, so it can be turned back on by id', async () => {
    const repo = makeRepo({ plugins: [{ name: 'acme', package: 'acme-plugin' }] });
    installNpmPlugin(repo, 'acme-plugin', NPM_PLUGIN);
    expect((await disablePlugin(repo.dir, 'acme')).changed).toBe(true);
    expect(raw(repo)).toMatchObject({ plugins: [{ name: 'acme', package: 'acme-plugin' }], disabledPlugins: ['acme'] });
    expect((await loadConfig(repo.dir)).plugins).toEqual([]);
    expect((await listPlugins(repo.dir)).plugins.find((p) => p.id === 'acme')).toMatchObject({ enabled: false, disabledHere: true, package: 'acme-plugin' });
    expect((await enablePlugin(repo.dir, 'acme')).changed).toBe(true);
    expect(raw(repo).disabledPlugins).toBeUndefined();
    expect((await loadConfig(repo.dir)).plugins).toEqual([{ name: 'acme', package: 'acme-plugin' }]);
  });

  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('removes an npm plugin from the list but refuses a built-in', async () => {
    const repo = makeRepo({ plugins: ['quality', { name: 'acme', package: 'acme-plugin' }] });
    installNpmPlugin(repo, 'acme-plugin', NPM_PLUGIN);
    expect((await removeNpmPlugin(repo.dir, 'acme')).changed).toBe(true);
    expect(raw(repo).plugins).toEqual(['quality']);
    expect((await removeNpmPlugin(repo.dir, 'acme')).changed).toBe(false);
    await expect(removeNpmPlugin(repo.dir, 'quality')).rejects.toThrow(/built-in/);
  });

  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('reports an enabled npm plugin that is not installed as an error on its row instead of failing the list', async () => {
    const repo = makeRepo({ plugins: [{ name: 'ghost', package: 'ghost-plugin' }] });
    const row = (await listPlugins(repo.dir)).plugins.find((p) => p.id === 'ghost');
    expect(row?.enabled).toBe(true);
    expect(row?.error).toMatch(/not installed/);
  });
});

describe('plugin surfaces [plugin-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#plugin-surfaces]
  it('serves the list at /api/v1/plugins and reports none for a project with no working tree', async () => {
    const { Api } = await import('../../src/server/api.js');
    const repo = makeRepo({ plugins: ['git'] });
    const api = new Api(await loadConfig(repo.dir));
    const res = await api.handle({ method: 'GET', path: '/api/v1/plugins' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).plugins.filter((p: { enabled: boolean }) => p.enabled).map((p: { id: string }) => p.id)).toEqual(['git']);
    const post = await api.handle({ method: 'POST', path: '/api/v1/plugins' });
    expect(post.status).toBe(405);
  });

  // [claims: capabilities/integration-surfaces#plugin-surfaces]
  it('keeps plugin_list out of the default MCP tool set, which is capped, and registers it with the extra tools', async () => {
    const { CORE_TOOLS } = await import('../../src/mcp/server.js');
    expect(CORE_TOOLS.has('specguard_plugin_list')).toBe(false);
    expect(CORE_TOOLS.size).toBeLessThanOrEqual(23); // 16 core + agent_work + 5 change tools + proof_fetch; the verify/security/contracts/workspace tools move to plugins
  });
});
