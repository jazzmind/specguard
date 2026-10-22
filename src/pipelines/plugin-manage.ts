/**
 * Browse, enable, disable, add and remove plugins: the operations behind `specguard plugin ...`,
 * `GET /api/v1/plugins`, the `plugin_list` MCP tool and the editor's Plugins view.
 *
 * The state lives in the repo's own `.specguard/config.json` (`plugins` and `disabledPlugins`). Edits
 * are made to the raw file, never to the loaded config, so `extends`, comments-as-keys and every
 * other key survive. Adding an npm plugin runs that package's code (it is imported to check it is
 * a plugin), so it is refused unless the caller says it has confirmed.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../core/config.js';
import { ConfigInvalidError } from '../core/errors.js';
import type { PluginEntry, SpecGuardConfig } from '../core/types.js';
import { BUILTIN_PLUGINS, builtinPluginInfo } from '../plugins/catalog.js';
import { loadPlugins } from '../plugins/index.js';
import type { SpecGuardPlugin } from '../plugins/types.js';

export const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
export const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/;

export interface PluginRow {
  id: string;
  source: 'builtin' | 'npm';
  /** npm package, for source `npm`. */
  package?: string;
  title: string;
  description: string;
  /** Parts of the plugin interface it implements. */
  provides: string[];
  /** CLI commands it adds while enabled. */
  commands: string[];
  enabled: boolean;
  /** Enabled only because a config this one extends lists it. */
  inherited: boolean;
  /** Turned off in this repo although an extended config enables it. */
  disabledHere: boolean;
  /** Set when an enabled plugin could not be loaded. */
  error?: string;
  /** For built-ins: on in every project `init` creates. */
  defaultOn?: boolean;
  configKey?: string;
}

export interface PluginList {
  rootDir: string;
  plugins: PluginRow[];
}

type Json = Record<string, unknown>;

const entryName = (e: PluginEntry): string => (typeof e === 'string' ? e : e.name);
const providedBy = (p: SpecGuardPlugin): string[] =>
  (['commands', 'catalogProviders', 'discoverers', 'externalIdAdapters', 'resultSources', 'featureState', 'moduleStems', 'contractImporters', 'detectors', 'docRenderers'] as const).filter(
    (k) => p[k] !== undefined && !(Array.isArray(p[k]) && (p[k] as unknown[]).length === 0),
  );

function configFile(rootDir: string): string {
  return path.join(rootDir, '.specguard', 'config.json');
}

function readRaw(rootDir: string): Json {
  return JSON.parse(readFileSync(configFile(rootDir), 'utf-8')) as Json;
}

function writeRaw(rootDir: string, raw: Json): void {
  const file = configFile(rootDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, file);
}

async function tryLoad(entry: PluginEntry, rootDir: string): Promise<{ plugin?: SpecGuardPlugin; error?: string }> {
  try {
    return { plugin: (await loadPlugins([entry], rootDir))[0] };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Every built-in plugin and every configured npm plugin, with whether it is on and what it adds. */
export async function listPlugins(cwd: string = process.cwd()): Promise<PluginList> {
  const config = await loadConfig(cwd);
  const rootDir = config.rootDir ?? cwd;
  const raw = readRaw(rootDir);
  const own = new Set(((raw.plugins as PluginEntry[] | undefined) ?? []).map(entryName));
  const off = new Set((raw.disabledPlugins as string[] | undefined) ?? []);
  const enabledEntries = config.plugins ?? [];
  const enabledNames = new Set(enabledEntries.map(entryName));
  const rows: PluginRow[] = [];

  for (const info of BUILTIN_PLUGINS) {
    const enabled = enabledNames.has(info.id);
    const { plugin, error } = await tryLoad(info.id, rootDir);
    rows.push({
      id: info.id,
      source: 'builtin',
      title: info.title,
      description: info.description,
      provides: info.provides.map(String),
      commands: (plugin?.commands ?? []).map((c) => c.name),
      enabled,
      inherited: enabled && !own.has(info.id),
      disabledHere: !enabled && off.has(info.id),
      ...(enabled && error ? { error } : {}),
      defaultOn: info.defaultOn,
      ...(info.configKey ? { configKey: info.configKey } : {}),
    });
  }

  const seen = new Set(BUILTIN_PLUGINS.map((p) => p.id));
  // npm plugins: those enabled here, and those this repo turned off
  const npmEntries = new Map<string, { name: string; package: string }>();
  for (const e of [...((raw.plugins as PluginEntry[] | undefined) ?? []), ...enabledEntries]) if (typeof e !== 'string') npmEntries.set(e.name, e);
  for (const e of npmEntries.values()) {
    if (seen.has(e.name)) continue;
    const enabled = enabledNames.has(e.name);
    const { plugin, error } = enabled ? await tryLoad(e, rootDir) : { plugin: undefined, error: undefined };
    rows.push({
      id: e.name,
      source: 'npm',
      package: e.package,
      title: plugin?.meta?.title ?? e.name,
      description: plugin?.meta?.description ?? `npm package ${e.package}`,
      provides: plugin ? providedBy(plugin) : [],
      commands: (plugin?.commands ?? []).map((c) => c.name),
      enabled,
      inherited: enabled && !own.has(e.name),
      disabledHere: !enabled && off.has(e.name),
      ...(error ? { error } : {}),
    });
  }
  return { rootDir, plugins: rows };
}

export interface PluginChange {
  changed: boolean;
  /** What happened, or why nothing did. */
  note: string;
}

function strings(raw: Json, key: string): string[] {
  return Array.isArray(raw[key]) ? [...(raw[key] as string[])] : [];
}

/**
 * `extends` replaces arrays wholesale: a repo with its own `plugins` list ignores its parent's, and one
 * without inherits the parent's. So what a change must write depends on whether this repo has its own list.
 */
const hasOwnList = (raw: Json): boolean => Array.isArray(raw.plugins);

/** Whether the config `raw` extends enables `id` (only meaningful when `raw` has no list of its own). */
async function parentEnables(rootDir: string, raw: Json, id: string): Promise<boolean> {
  if (!raw.extends) return false;
  let parentPath = path.resolve(rootDir, String(raw.extends));
  if (!parentPath.endsWith('.json')) parentPath = path.join(parentPath, '.specguard', 'config.json');
  if (!existsSync(parentPath)) return false;
  try {
    const parent = await loadConfig(path.dirname(path.dirname(parentPath)));
    return (parent.plugins ?? []).some((e) => entryName(e) === id);
  } catch {
    return false;
  }
}

/** Turn a built-in or already-configured plugin on. */
export async function enablePlugin(cwd: string, id: string): Promise<PluginChange> {
  if (!PLUGIN_NAME.test(id)) throw new ConfigInvalidError(`invalid plugin name '${id}'`);
  const config = await loadConfig(cwd);
  const rootDir = config.rootDir ?? cwd;
  const raw = readRaw(rootDir);
  const known = [...((raw.plugins as PluginEntry[] | undefined) ?? []), ...(config.plugins ?? [])];
  const npm = known.find((e): e is { name: string; package: string } => typeof e !== 'string' && e.name === id);
  if (!builtinPluginInfo(id) && !npm) {
    throw new ConfigInvalidError(`unknown plugin '${id}'. Built-in plugins: ${BUILTIN_PLUGINS.map((p) => p.id).join(', ')}. Add an npm plugin with \`specguard plugin add\`.`);
  }
  const off = strings(raw, 'disabledPlugins');
  const wasOff = off.includes(id);
  if ((config.plugins ?? []).some((e) => entryName(e) === id)) return { changed: false, note: `${id} is already enabled` };

  if (wasOff) {
    const rest = off.filter((n) => n !== id);
    if (rest.length > 0) raw.disabledPlugins = rest;
    else delete raw.disabledPlugins;
  }
  if (hasOwnList(raw)) {
    const list = raw.plugins as PluginEntry[];
    if (!list.some((e) => entryName(e) === id)) list.push(npm ?? id);
  } else if (!(wasOff && (await parentEnables(rootDir, raw, id)))) {
    // No list of its own: write one that restates what is enabled now, so nothing inherited is dropped.
    raw.plugins = [...(config.plugins ?? []), npm ?? id];
  }
  writeRaw(rootDir, raw);
  return { changed: true, note: `enabled ${id}` };
}

/** Turn a plugin off in this repo, including one enabled only by an extended config. */
export async function disablePlugin(cwd: string, id: string): Promise<PluginChange> {
  if (!PLUGIN_NAME.test(id)) throw new ConfigInvalidError(`invalid plugin name '${id}'`);
  const config = await loadConfig(cwd);
  const rootDir = config.rootDir ?? cwd;
  const raw = readRaw(rootDir);
  if (!(config.plugins ?? []).some((e) => entryName(e) === id)) return { changed: false, note: `${id} is not enabled` };

  let note = `disabled ${id}`;
  const ownNpm = hasOwnList(raw) && (raw.plugins as PluginEntry[]).some((e) => typeof e !== 'string' && e.name === id);
  if (ownNpm) {
    // An npm plugin keeps its entry (it records the package), so it can be turned back on by id.
    const off = strings(raw, 'disabledPlugins');
    if (!off.includes(id)) off.push(id);
    raw.disabledPlugins = off;
  } else if (hasOwnList(raw)) {
    raw.plugins = (raw.plugins as PluginEntry[]).filter((e) => entryName(e) !== id);
  } else {
    // Enabled only by the extended config: record that this repo turned it off.
    const off = strings(raw, 'disabledPlugins');
    if (!off.includes(id)) off.push(id);
    raw.disabledPlugins = off;
    note = `disabled ${id} here (an extended config enables it)`;
  }
  writeRaw(rootDir, raw);
  return { changed: true, note };
}

export interface AddOptions {
  /** The caller has confirmed that this package's code will run. Required. */
  confirmed: boolean;
  /** Run `npm install --save-dev <package>` first. */
  install?: boolean;
}

/** Add an npm plugin: install it (optionally), check it exports a plugin with that id, then list it. */
export async function addNpmPlugin(cwd: string, id: string, pkg: string, opts: AddOptions): Promise<PluginChange> {
  if (!PLUGIN_NAME.test(id)) throw new ConfigInvalidError(`invalid plugin name '${id}'`);
  if (!NPM_PACKAGE.test(pkg)) throw new ConfigInvalidError(`invalid plugin package '${pkg}'`);
  if (builtinPluginInfo(id)) throw new ConfigInvalidError(`'${id}' is a built-in plugin; use \`specguard plugin enable ${id}\``);
  if (!opts.confirmed) {
    throw new ConfigInvalidError(`adding '${pkg}' runs that package's code. Confirm with --yes once you trust it.`);
  }
  const config = await loadConfig(cwd);
  const rootDir = config.rootDir ?? cwd;
  const raw = readRaw(rootDir);
  const list: PluginEntry[] = hasOwnList(raw) ? [...(raw.plugins as PluginEntry[])] : [...(config.plugins ?? [])];
  if (list.some((e) => entryName(e) === id)) return { changed: false, note: `${id} is already listed` };

  if (opts.install) {
    // `--ignore-scripts` keeps install-time scripts from running; the package is imported below only to check it.
    execFileSync('npm', ['install', '--save-dev', '--ignore-scripts', pkg], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const entry = { name: id, package: pkg };
  const loaded = await tryLoad(entry, rootDir);
  if (!loaded.plugin) throw new ConfigInvalidError(loaded.error ?? `'${pkg}' did not load as plugin '${id}'`);

  list.push(entry);
  raw.plugins = list;
  const off = strings(raw, 'disabledPlugins').filter((n) => n !== id);
  if (off.length > 0) raw.disabledPlugins = off;
  else delete raw.disabledPlugins;
  writeRaw(rootDir, raw);
  return { changed: true, note: `added ${id} (${pkg})` };
}

/** Drop an npm plugin from this repo's list. The package stays installed; remove it with npm. */
export async function removeNpmPlugin(cwd: string, id: string): Promise<PluginChange> {
  const config = await loadConfig(cwd);
  const rootDir = config.rootDir ?? cwd;
  const raw = readRaw(rootDir);
  if (builtinPluginInfo(id)) throw new ConfigInvalidError(`'${id}' is a built-in plugin; use \`specguard plugin disable ${id}\``);
  const own = Array.isArray(raw.plugins) ? (raw.plugins as PluginEntry[]) : [];
  const next = own.filter((e) => entryName(e) !== id);
  if (next.length === own.length) return { changed: false, note: `${id} is not in this repo's plugin list` };
  raw.plugins = next;
  const off = strings(raw, 'disabledPlugins').filter((n) => n !== id);
  if (off.length > 0) raw.disabledPlugins = off;
  else delete raw.disabledPlugins;
  writeRaw(rootDir, raw);
  return { changed: true, note: `removed ${id}` };
}

/** Plugin rows as plain text, one line each. */
export function formatPluginRows(rows: PluginRow[]): string[] {
  return rows.map((r) => {
    const state = r.error ? 'ERROR ' : r.enabled ? 'on    ' : 'off   ';
    const tags = [r.source === 'npm' ? `npm:${r.package}` : '', r.inherited ? 'inherited' : '', r.disabledHere ? 'disabled here' : '', r.commands.length ? `commands: ${r.commands.join(', ')}` : ''].filter(Boolean);
    return `${state}${r.id.padEnd(20)}${r.title}${tags.length ? `  (${tags.join('; ')})` : ''}${r.error ? `\n        ${r.error}` : ''}`;
  });
}

export type { SpecGuardConfig };
