/**
 * Overlay spec sources: specs, configs and test results for a whole workspace kept in ONE separate "overlay"
 * repository, with nothing written into the application repositories they describe.
 *
 * An overlay holds one `.specguard/config.json` per application (`apps/<name>/.specguard/config.json`) whose
 * `apps[].repo` points out to the real repository. This module answers "where are the specs for this directory?"
 * when the directory's own repository has no config: a per-user registry of overlays (`overlays.json`), overlay roots
 * named by `SPECGUARD_OVERLAY`, and a config named directly by `SPECGUARD_CONFIG`. `loadConfig` and the agent edit guard
 * both resolve through it.
 *
 * Dependency-free on purpose (node built-ins and the error types): the edit guard's hot path imports it and must not
 * pay for the config schema. Configs are read as raw JSON, leniently; the real loader validates them later.
 *
 * Spec: specs/capabilities/platform-foundation.md
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigAmbiguousError, ConfigInvalidError } from './errors.js';

/** Environment variable naming overlay roots (path-list separator), scanned on the fly with no registration. */
export const OVERLAY_ENV = 'SPECGUARD_OVERLAY';
/** Environment variable naming one `.specguard/config.json` (or the directory that holds it) for every start directory. */
export const CONFIG_ENV = 'SPECGUARD_CONFIG';
/** How far below an overlay root a `.specguard/` folder is looked for (the root itself is depth 0). */
export const OVERLAY_SCAN_DEPTH = 4;

const CONFIG_REL = path.join('.specguard', 'config.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

/** How a directory's config was found. `repo` is the repository's own config; the others are overlay-style. */
export type ConfigVia = 'repo' | 'env-config' | 'env-overlay' | 'overlay';

/** The answer of the resolver: the directory that holds `.specguard/`, and how it was found. */
export interface ConfigResolution {
  /** The directory holding `.specguard/config.json` (the config's rootDir). */
  dir: string;
  via: ConfigVia;
  /** The overlay root the config was found under (`env-overlay`, `overlay`). */
  overlayRoot?: string;
  /** The real repository the config's app points at (`env-overlay`, `overlay`). */
  repo?: string;
  /** The app name in the overlay's config (`env-overlay`, `overlay`). */
  app?: string;
}

/** One application of an overlay: the real repository, the overlay config that describes it, and the app's name. */
export interface OverlayEntry {
  /** Absolute path of the real repository (canonical, symlinks resolved). */
  repo: string;
  /** Absolute path of the overlay's `.specguard/config.json` for it. */
  config: string;
  app: string;
}

export interface OverlayRecord {
  /** Absolute path of the overlay directory. */
  root: string;
  addedAt: string;
  entries: OverlayEntry[];
}

export interface OverlayRegistry {
  version: 1;
  overlays: OverlayRecord[];
}

/** A config or app the scan saw but could not turn into an entry, and why. */
export interface OverlaySkip {
  config: string;
  app?: string;
  reason: string;
}

export interface OverlayScan {
  root: string;
  entries: OverlayEntry[];
  skipped: OverlaySkip[];
}

export type OverlayCandidate = OverlayEntry & { overlayRoot: string; via: 'env-overlay' | 'overlay' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canonical path: symlinks resolved through the deepest ancestor that exists (`/tmp` and `/private/tmp` compare equal). */
export function realPathLoose(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// Scanning an overlay
// ---------------------------------------------------------------------------------------------------------------------

/** `apps[]` of a config as raw JSON (name and repo as written), following `extends` when the config has no apps of its own. */
function rawApps(configFile: string, depth = 0): { apps: Array<{ name?: string; repo?: string }> } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (err) {
    return { error: err instanceof SyntaxError ? `not valid JSON (${err.message})` : 'could not be read' };
  }
  if (!isRecord(raw)) return { error: 'is not a JSON object' };
  if (!Array.isArray(raw.apps) && typeof raw.extends === 'string' && depth < 5) {
    let parent = path.resolve(path.dirname(path.dirname(configFile)), raw.extends);
    if (!parent.endsWith('.json')) parent = path.join(parent, CONFIG_REL);
    return rawApps(parent, depth + 1);
  }
  if (!Array.isArray(raw.apps) || raw.apps.length === 0) return { error: 'has no apps' };
  return {
    apps: raw.apps.filter(isRecord).map((a) => ({
      ...(typeof a.name === 'string' ? { name: a.name } : {}),
      ...(typeof a.repo === 'string' ? { repo: a.repo } : {}),
    })),
  };
}

/**
 * The entries one overlay config yields: each `apps[].repo`, resolved against the directory that holds `.specguard/`.
 * An app whose repo is that directory itself is an ordinary in-repo config, not an overlay entry; an app whose repo
 * directory does not exist is skipped, with the reason.
 */
export function entriesOfConfig(configFile: string): { entries: OverlayEntry[]; skipped: OverlaySkip[] } {
  const config = realPathLoose(configFile);
  const holder = path.dirname(path.dirname(config));
  const parsed = rawApps(config);
  if ('error' in parsed) return { entries: [], skipped: [{ config, reason: parsed.error }] };
  const entries: OverlayEntry[] = [];
  const skipped: OverlaySkip[] = [];
  for (const app of parsed.apps) {
    const name = app.name ?? path.basename(holder);
    if (app.repo === undefined) {
      skipped.push({ config, app: name, reason: 'the app has no repo' });
      continue;
    }
    const abs = path.resolve(holder, app.repo);
    if (realPathLoose(abs) === holder) {
      skipped.push({ config, app: name, reason: 'an in-repo config (its repo is the folder that holds .specguard), not an overlay entry' });
    } else if (!isDirectory(abs)) {
      skipped.push({ config, app: name, reason: `the repo directory ${abs} does not exist` });
    } else {
      entries.push({ repo: realPathLoose(abs), config, app: name });
    }
  }
  return { entries, skipped };
}

/** Every `.specguard/config.json` up to {@link OVERLAY_SCAN_DEPTH} levels under `root`, as entries plus what was skipped. */
export function scanOverlay(root: string): OverlayScan {
  const real = realPathLoose(root);
  const entries: OverlayEntry[] = [];
  const skipped: OverlaySkip[] = [];
  const walk = (dir: string, depth: number): void => {
    if (existsSync(path.join(dir, CONFIG_REL))) {
      const found = entriesOfConfig(path.join(dir, CONFIG_REL));
      entries.push(...found.entries);
      skipped.push(...found.skipped);
    }
    if (depth >= OVERLAY_SCAN_DEPTH) return;
    let names: import('node:fs').Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  if (isDirectory(real)) walk(real, 0);
  return { root: real, entries, skipped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry: a per-user file, derived from scans
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The per-user registry: `$XDG_CONFIG_HOME/specguard/overlays.json`, else `~/.config/specguard/overlays.json`.
 * Undefined when the given environment names no home (a test that passes its own `env` never reads the real one).
 */
export function overlayRegistryFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  const base = env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : undefined);
  return base ? path.join(base, 'specguard', 'overlays.json') : undefined;
}

const emptyRegistry = (): OverlayRegistry => ({ version: 1, overlays: [] });

function cleanEntry(v: unknown): OverlayEntry | null {
  return isRecord(v) && typeof v.repo === 'string' && typeof v.config === 'string' && typeof v.app === 'string' ? { repo: v.repo, config: v.config, app: v.app } : null;
}

/** The registry on disk. A missing, unreadable or foreign file reads as empty (`problem` says why); it never throws. */
export function readOverlayRegistry(env: NodeJS.ProcessEnv = process.env): { file?: string; registry: OverlayRegistry; problem?: string } {
  const file = overlayRegistryFile(env);
  if (!file || !existsSync(file)) return { ...(file ? { file } : {}), registry: emptyRegistry() };
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.overlays)) return { file, registry: emptyRegistry(), problem: `${file} is not an overlay registry (version 1)` };
    const overlays: OverlayRecord[] = [];
    for (const o of data.overlays) {
      if (!isRecord(o) || typeof o.root !== 'string' || !Array.isArray(o.entries)) continue;
      overlays.push({
        root: o.root,
        addedAt: typeof o.addedAt === 'string' ? o.addedAt : '',
        entries: o.entries.map(cleanEntry).filter((e): e is OverlayEntry => e !== null),
      });
    }
    return { file, registry: { version: 1, overlays } };
  } catch (err) {
    return { file, registry: emptyRegistry(), problem: `${file} could not be read (${(err as Error).message})` };
  }
}

/** Write the registry atomically with mode 600 (its folder 700 when created). Returns the file; throws when no home is known. */
export function writeOverlayRegistry(registry: OverlayRegistry, env: NodeJS.ProcessEnv = process.env): string {
  const file = overlayRegistryFile(env);
  if (!file) throw new Error('cannot place the overlay registry: set HOME or XDG_CONFIG_HOME');
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

/** The registry with `record` added, or replacing the record of the same root. Pure. */
export function upsertOverlay(registry: OverlayRegistry, record: OverlayRecord): OverlayRegistry {
  const others = registry.overlays.filter((o) => o.root !== record.root);
  return { version: 1, overlays: [...others, record].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)) };
}

/** The registry without the overlay rooted at `root`, and whether there was one. Pure. */
export function dropOverlay(registry: OverlayRegistry, root: string): { registry: OverlayRegistry; removed: boolean } {
  const overlays = registry.overlays.filter((o) => o.root !== root);
  return { registry: { version: 1, overlays }, removed: overlays.length !== registry.overlays.length };
}

/** The directories `SPECGUARD_OVERLAY` names: the value split on the path-list separator, empty parts dropped. Pure. */
export function parseOverlayRoots(value: string | undefined, delimiter: string = path.delimiter): string[] {
  return (value ?? '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching and resolving
// ---------------------------------------------------------------------------------------------------------------------

/** The distinct overlay configs among candidates (one config that names a repo through several apps counts once). Pure. */
export function distinctConfigs<T extends { config: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  return candidates.filter((c) => (seen.has(c.config) ? false : (seen.add(c.config), true)));
}

/** The nearest directory at or above `dir` that holds `.git` (a folder or a worktree's file), canonical; null when none. */
export function enclosingGitRoot(dir: string): string | null {
  let cur = realPathLoose(dir);
  for (;;) {
    if (existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export interface OverlayMatch<T> {
  /** The application folder an entry names, in the spelling of the start directory (the git root itself when the match is ambiguous). */
  dir: string;
  hits: T[];
  /** Set when the entries matched as the git repository that encloses their repo folder, not by containing the start: that repository's root, in the start's spelling. */
  enclosing?: string;
}

/**
 * The entries that cover `start`. (1) The deepest ancestor-or-equal of `start` that some candidate names as its repo
 * wins. (2) Otherwise an entry covers the git repository that ENCLOSES its repo folder: candidates whose enclosing git
 * root is the git root enclosing `start` also match (a repo opened at its root while the config points at an app folder
 * inside it). The walk never crosses above `start`'s own git root, so a folder that merely holds several repos matches
 * nothing. Both sides are compared by real path. In case (2) with one distinct config `dir` is that entry's app folder
 * and `hits` holds that config's entries, first the one chosen; with several, they are all returned for the caller to
 * call ambiguous.
 */
export function matchOverlayEntries<T extends OverlayEntry>(start: string, candidates: T[]): OverlayMatch<T> | null {
  if (candidates.length === 0) return null;
  const byRepo = new Map<string, T[]>();
  for (const c of candidates) {
    const key = realPathLoose(c.repo);
    byRepo.set(key, [...(byRepo.get(key) ?? []), c]);
  }
  let dir = path.resolve(start);
  let gitDir: string | null = null;
  for (;;) {
    const hits = byRepo.get(realPathLoose(dir));
    if (hits) return { dir, hits };
    if (existsSync(path.join(dir, '.git'))) {
      gitDir = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (gitDir === null) return null;

  const realGit = realPathLoose(gitDir);
  const roots = new Map<string, string | null>();
  const hits = candidates
    .filter((c) => {
      const real = realPathLoose(c.repo);
      if (!roots.has(real)) roots.set(real, enclosingGitRoot(real));
      return roots.get(real) === realGit;
    })
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  if (hits.length === 0) return null;
  const distinct = distinctConfigs(hits);
  if (distinct.length > 1) return { dir: gitDir, hits, enclosing: gitDir };
  const mine = hits.filter((h) => h.config === distinct[0]!.config);
  return { dir: path.join(gitDir, path.relative(realGit, realPathLoose(mine[0]!.repo))), hits: mine, enclosing: gitDir };
}

/** The config directory a `SPECGUARD_CONFIG` / `--config` value names: a `.specguard/config.json`, its `.specguard` folder, or the folder that holds it. */
export function configDirFromPath(value: string): string | null {
  const abs = path.resolve(value);
  const file = path.basename(abs) === 'config.json' && path.basename(path.dirname(abs)) === '.specguard' ? abs : null;
  if (file) return existsSync(file) ? path.dirname(path.dirname(file)) : null;
  const holder = path.basename(abs) === '.specguard' ? path.dirname(abs) : abs;
  return existsSync(path.join(holder, CONFIG_REL)) ? holder : null;
}

/** The directory holding the repository's own `.specguard/config.json`, walking up to the git boundary; null when none. */
export function findOwnConfigDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_REL))) return dir;
    if (existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ResolveDetail {
  resolved: ConfigResolution | null;
  /** Stale registry entries that would have covered the directory, and other things worth saying. */
  warnings: string[];
  /** Whether any overlay is known at all (registered, or named by `SPECGUARD_OVERLAY`). */
  overlaysKnown: boolean;
  /** The application folder the matching overlay entry names, in the spelling of the start directory. */
  repoDir?: string;
  /** Set when the entry covers the git repository that encloses its folder (the start was that repository's root, not inside the app): its root. */
  gitRoot?: string;
}

/**
 * Where the specs for `start` live. Order: (a) the repository's own `.specguard/config.json`; (b) `SPECGUARD_CONFIG`;
 * (c) overlay entries, the roots of `SPECGUARD_OVERLAY` first, then the registry, each tier taking the entry whose repo
 * is the deepest ancestor-or-equal of `start`, else the entry whose repo sits inside the git repository `start` is in (see
 * {@link matchOverlayEntries}); otherwise null.
 * @throws {ConfigAmbiguousError} when two overlay configs name the same repository.
 * @throws {ConfigInvalidError} when `SPECGUARD_CONFIG` names nothing usable.
 */
export function resolveConfigDirDetailed(start: string, env: NodeJS.ProcessEnv = process.env): ResolveDetail {
  const warnings: string[] = [];
  const own = findOwnConfigDir(start);
  if (own) return { resolved: { dir: own, via: 'repo' }, warnings, overlaysKnown: false };

  const explicit = env[CONFIG_ENV];
  if (explicit) {
    const dir = configDirFromPath(explicit);
    if (!dir) throw new ConfigInvalidError(`${CONFIG_ENV}=${explicit} does not name a .specguard/config.json (or a folder that holds one)`);
    return { resolved: { dir, via: 'env-config' }, warnings, overlaysKnown: true };
  }

  const envRoots = parseOverlayRoots(env[OVERLAY_ENV]);
  const { registry } = readOverlayRegistry(env);
  const overlaysKnown = envRoots.length > 0 || registry.overlays.length > 0;
  if (!overlaysKnown) return { resolved: null, warnings, overlaysKnown };

  const tiers: OverlayCandidate[][] = [];
  if (envRoots.length > 0) {
    tiers.push(envRoots.flatMap((root) => {
      const scan = scanOverlay(root);
      return scan.entries.map((e): OverlayCandidate => ({ ...e, overlayRoot: scan.root, via: 'env-overlay' }));
    }));
  }
  tiers.push(registry.overlays.flatMap((o) => o.entries.map((e): OverlayCandidate => ({ ...e, overlayRoot: o.root, via: 'overlay' }))));

  for (const tier of tiers) {
    const live = tier.filter((c) => existsSync(c.config));
    const stale = matchOverlayEntries(start, tier.filter((c) => !live.includes(c)));
    for (const c of stale?.hits ?? []) {
      warnings.push(`the overlay entry for ${c.repo} points at ${c.config}, which no longer exists (run: specguard overlay refresh ${c.overlayRoot})`);
    }
    const match = matchOverlayEntries(start, live);
    if (!match) continue;
    const distinct = distinctConfigs(match.hits);
    if (distinct.length > 1) {
      throw new ConfigAmbiguousError(
        match.dir,
        distinct.map((c) => ({ config: c.config, overlayRoot: c.overlayRoot, app: c.app, repo: c.repo })),
        { enclosing: match.enclosing !== undefined },
      );
    }
    const hit = distinct[0]!;
    return {
      resolved: { dir: path.dirname(path.dirname(hit.config)), via: hit.via, overlayRoot: hit.overlayRoot, repo: hit.repo, app: hit.app },
      warnings,
      overlaysKnown,
      repoDir: match.dir,
      ...(match.enclosing !== undefined ? { gitRoot: match.enclosing } : {}),
    };
  }
  return { resolved: null, warnings, overlaysKnown };
}

/** {@link resolveConfigDirDetailed} without the extras: the resolution, or null. */
export function resolveConfigDir(start: string, env: NodeJS.ProcessEnv = process.env): ConfigResolution | null {
  return resolveConfigDirDetailed(start, env).resolved;
}

/** One line for a person: how this config was found. Empty for the repository's own config. */
export function describeResolution(r: ConfigResolution | undefined): string {
  if (!r || r.via === 'repo') return '';
  if (r.via === 'env-config') return `configured via ${CONFIG_ENV} (${r.dir})`;
  return `configured via overlay ${r.overlayRoot ?? r.dir} (app ${r.app ?? '?'})`;
}

/** A hint for "no config found": overlays exist but none covers the directory. Undefined when no overlay is known. */
export function overlayMissHint(detail: ResolveDetail): string | undefined {
  if (!detail.overlaysKnown) return undefined;
  const lines = [`An overlay is registered but none covers this directory: \`specguard overlay resolve\` shows why, \`specguard overlay add <dir>\` registers another.`];
  return [...lines, ...detail.warnings].join('\n');
}

/**
 * Whether an overlay (or `SPECGUARD_OVERLAY` root) covers the folder, as a resolution; null otherwise. For a folder that
 * has no config of its own. `SPECGUARD_CONFIG` is not coverage (it names one config for every folder), and a broken
 * or ambiguous overlay answer is "not covered": callers that only classify folders must not fail on it.
 */
export function overlayCoverage(dir: string, env: NodeJS.ProcessEnv = process.env): ConfigResolution | null {
  try {
    const r = resolveConfigDirDetailed(dir, { ...env, [CONFIG_ENV]: undefined }).resolved;
    return r && (r.via === 'overlay' || r.via === 'env-overlay') ? r : null;
  } catch {
    return null;
  }
}

/** The directory holding the config that applies to a folder: its own `.specguard/`, else an overlay's. Null when none. */
export function configDirOf(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (existsSync(path.join(dir, CONFIG_REL))) return path.resolve(dir);
  return overlayCoverage(dir, env)?.dir ?? null;
}
