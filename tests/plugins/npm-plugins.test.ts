import { describe, expect, it } from 'vitest';

import { loadPlugins } from '../../src/plugins/index.js';
import { installNpmPlugin } from '../helpers/npm-plugin.js';
import { makeRepo } from '../helpers/repo.js';

describe('npm plugins [npm-plugins]', () => {
  // [claims: capabilities/integration-surfaces#planned-plugin-extensions]
  it('loads a package only when config lists it as { name, package }, resolving it from the project [allowlist]', async () => {
    const repo = makeRepo({});
    installNpmPlugin(repo, 'specguard-plugin-demo', "exports.plugin = { id: 'demo', commands: [{ name: 'demo', description: 'd', run: async () => ({}) }] };");
    const plugins = await loadPlugins([{ name: 'demo', package: 'specguard-plugin-demo' }], repo.dir);
    expect(plugins.map((p) => p.id)).toEqual(['demo']);
    expect(plugins[0].commands?.[0].name).toBe('demo');
    // Naming it as a bare string is not enough: strings are built-ins only.
    await expect(loadPlugins(['demo'], repo.dir)).rejects.toThrow(/unknown plugin 'demo'.*\{ "name": "demo", "package"/);
  });

  // [claims: capabilities/integration-surfaces#planned-plugin-extensions, capabilities/integration-surfaces#plugin-package-names]
  it('refuses a package name that is a path or URL, one that is not installed, and one whose id differs from the listed name [refusals]', async () => {
    const repo = makeRepo({});
    for (const bad of ['../evil', './local', 'https://x.example/p.js', '/abs/path', 'Upper Case']) {
      await expect(loadPlugins([{ name: 'x', package: bad }], repo.dir)).rejects.toThrow(/invalid plugin package/);
    }
    await expect(loadPlugins([{ name: 'ghost', package: 'specguard-plugin-ghost' }], repo.dir)).rejects.toThrow(/not installed/);
    installNpmPlugin(repo, 'specguard-plugin-other', "exports.plugin = { id: 'something-else' };");
    await expect(loadPlugins([{ name: 'wanted', package: 'specguard-plugin-other' }], repo.dir)).rejects.toThrow(/does not export a plugin with that id/);
  });

  // [claims: capabilities/integration-surfaces#planned-plugin-extensions]
  it('resolves from the project it is asked about, so two projects can use different versions [per-project]', async () => {
    const a = makeRepo({});
    const b = makeRepo({});
    installNpmPlugin(a, 'specguard-plugin-ver', "exports.plugin = { id: 'ver', moduleStems: ['from-a'] };");
    installNpmPlugin(b, 'specguard-plugin-ver', "exports.plugin = { id: 'ver', moduleStems: ['from-b'] };");
    const entry = [{ name: 'ver', package: 'specguard-plugin-ver' }];
    expect((await loadPlugins(entry, a.dir))[0].moduleStems).toEqual(['from-a']);
    expect((await loadPlugins(entry, b.dir))[0].moduleStems).toEqual(['from-b']);
  });
});
