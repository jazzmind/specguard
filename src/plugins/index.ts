/**
 * Plugin registry. `config.plugins` names built-in plugins that live in
 * `src/plugins/<name>/index.ts` and export `plugin`. An unknown name is a
 * configuration error, never silently ignored.
 *
 * Plugins are loaded by name so core never imports a platform-specific module.
 *
 * Spec: specs/plugins/plugins.md
 */
import { ConfigInvalidError } from '../core/errors.js';
import { BUILTIN_EXTERNAL_ID_ADAPTERS } from './external-id.js';
import type { ExternalIdAdapter, SpecGuardPlugin } from './types.js';

const NAME = /^[a-z][a-z0-9-]*$/;
const cache = new Map<string, SpecGuardPlugin>();

/**
 * Load `./<name>/index`. The `.js` specifier is the one Node resolves from the
 * compiled `dist/` tree and the one vitest maps to the TypeScript source. The
 * `.ts` specifier exists for esbuild, whose glob imports match real files: it is
 * what lets the bundled CLI in the VS Code extension include every plugin.
 */
async function importPlugin(name: string): Promise<{ plugin?: SpecGuardPlugin }> {
  try {
    return (await import(`./${name}/index.js`)) as { plugin?: SpecGuardPlugin };
  } catch (first) {
    try {
      return (await import(`./${name}/index.ts`)) as { plugin?: SpecGuardPlugin };
    } catch {
      throw first;
    }
  }
}

/** Resolve plugin names to plugins, in order. Throws on an unknown or malformed name. */
export async function loadPlugins(names: string[] | undefined): Promise<SpecGuardPlugin[]> {
  const out: SpecGuardPlugin[] = [];
  for (const name of names ?? []) {
    const hit = cache.get(name);
    if (hit) {
      out.push(hit);
      continue;
    }
    if (!NAME.test(name)) throw new ConfigInvalidError(`invalid plugin name '${name}'`);
    let mod: { plugin?: SpecGuardPlugin };
    try {
      mod = await importPlugin(name);
    } catch {
      throw new ConfigInvalidError(`unknown plugin '${name}'. Built-in plugins are directories under src/plugins/.`);
    }
    if (!mod.plugin || mod.plugin.id !== name) {
      throw new ConfigInvalidError(`unknown plugin '${name}': module does not export a plugin with that id`);
    }
    cache.set(name, mod.plugin);
    out.push(mod.plugin);
  }
  return out;
}

/** External-id adapters named in config (`generic`, `zephyr`, `jira`) plus any a plugin brings. */
export function resolveExternalIdAdapters(names: string[] | undefined, plugins: SpecGuardPlugin[]): ExternalIdAdapter[] {
  const adapters = new Map<string, ExternalIdAdapter>();
  for (const plugin of plugins) for (const a of plugin.externalIdAdapters ?? []) adapters.set(a.id, a);
  for (const name of names ?? []) {
    const adapter = BUILTIN_EXTERNAL_ID_ADAPTERS[name];
    if (!adapter) {
      throw new ConfigInvalidError(
        `unknown external-id adapter '${name}'. Built-in adapters: ${Object.keys(BUILTIN_EXTERNAL_ID_ADAPTERS).join(', ')}.`,
      );
    }
    adapters.set(adapter.id, adapter);
  }
  return [...adapters.values()];
}

export * from './types.js';
