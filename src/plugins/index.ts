/**
 * Plugin registry. `config.plugins` names built-in plugins that live in
 * `src/plugins/<name>/index.ts` and export `plugin`, or lists npm packages as
 * `{ name, package }`. An unknown name is a configuration error, never silently ignored.
 *
 * Plugins are loaded by name so core never imports a platform-specific module,
 * and a package is imported only when config lists it.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigInvalidError } from '../core/errors.js';
import type { PluginEntry, SpecGuardPlugin } from './types.js';

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

// npm package names, scoped or not. Anything else (paths, URLs, `..`) is refused before it reaches `import`.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/;

/** Import an allowlisted npm package from the project's own `node_modules`. */
async function importPackage(pkg: string, rootDir: string): Promise<{ plugin?: SpecGuardPlugin }> {
  const require = createRequire(path.join(rootDir, 'noop.js'));
  let file: string;
  try {
    file = require.resolve(pkg);
  } catch {
    throw new ConfigInvalidError(`plugin package '${pkg}' is not installed in ${rootDir}. Run \`npm install ${pkg}\`.`);
  }
  return (await import(pathToFileURL(file).href)) as { plugin?: SpecGuardPlugin };
}

/**
 * Resolve plugin entries to plugins, in order. A string is a built-in plugin; `{ name, package }` is an npm
 * package, loaded only because config lists it (importing a package runs its code). Throws on an unknown,
 * malformed or uninstalled entry. `rootDir` is where npm packages are resolved from (default: the cwd).
 */
export async function loadPlugins(entries: PluginEntry[] | undefined, rootDir: string = process.cwd()): Promise<SpecGuardPlugin[]> {
  const out: SpecGuardPlugin[] = [];
  for (const entry of entries ?? []) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const pkg = typeof entry === 'string' ? undefined : entry.package;
    const key = pkg ? `${name}@${pkg}@${path.resolve(rootDir)}` : name;
    const hit = cache.get(key);
    if (hit) {
      out.push(hit);
      continue;
    }
    if (!NAME.test(name)) throw new ConfigInvalidError(`invalid plugin name '${name}'`);
    let mod: { plugin?: SpecGuardPlugin };
    if (pkg) {
      if (!NPM_NAME.test(pkg)) throw new ConfigInvalidError(`invalid plugin package '${pkg}'`);
      mod = await importPackage(pkg, rootDir);
    } else {
      try {
        mod = await importPlugin(name);
      } catch {
        throw new ConfigInvalidError(`unknown plugin '${name}'. Built-in plugins are directories under src/plugins/; an npm plugin must be listed as { "name": "${name}", "package": "<npm package>" }.`);
      }
    }
    if (!mod.plugin || mod.plugin.id !== name) {
      throw new ConfigInvalidError(`unknown plugin '${name}': module does not export a plugin with that id`);
    }
    cache.set(key, mod.plugin);
    out.push(mod.plugin);
  }
  return out;
}

export * from './types.js';
