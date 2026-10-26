/**
 * Where a folder's SpecGuard config lives, as the extension needs to know it.
 *
 * A folder is configured when it has its own `.specguard/config.json`, or when its specs live in an overlay repository
 * (a separate repo that keeps the config, specs and results for it; see `specguard overlay`). Only the CLI knows how to
 * resolve the second case (the overlay registry, `SPECGUARD_OVERLAY`, `SPECGUARD_CONFIG`), so when the file is absent
 * this asks it: `specguard overlay resolve <folder> --json`. No `vscode` import: the CLI runner is injected, which also
 * keeps this unit-testable.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** What the CLI's `overlay resolve --json` and the in-repo check agree on. */
export interface ProjectConfigInfo {
  configured: boolean;
  /** `repo`: the folder's own config. The others: found through an overlay or `SPECGUARD_CONFIG`. */
  via: 'repo' | 'overlay' | 'env-overlay' | 'env-config' | 'none';
  /** The directory holding `.specguard/` (where specs, results and the config are read and written). */
  configDir?: string;
  /** Absolute path of the config file. */
  configFile?: string;
  overlayRoot?: string;
  app?: string;
  /** Why the folder is not configured, when the CLI said. */
  reason?: string;
}

/** Runs the bundled CLI with `args` in `cwd`. Resolves (never rejects) with what it printed and its exit code. */
export type CliRunner = (args: string[], cwd: string) => Promise<{ stdout: string; code: number | null }>;

export interface DetectOptions {
  run?: CliRunner;
  exists?: (file: string) => boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const REL = path.join('.specguard', 'config.json');

/** The registry file the CLI keeps (`$XDG_CONFIG_HOME/specguard/overlays.json`, else `~/.config/...`). */
export function overlayRegistryPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME ?? home, '.config'), 'specguard', 'overlays.json');
}

/**
 * Whether any overlay could cover a folder: a registry file exists, or `SPECGUARD_OVERLAY` / `SPECGUARD_CONFIG` is set.
 * A cheap test so a plain unconfigured folder never starts the CLI just to hear "none".
 */
export function overlayMayApply(o: DetectOptions = {}): boolean {
  const env = o.env ?? process.env;
  if (env.SPECGUARD_OVERLAY || env.SPECGUARD_CONFIG) return true;
  return (o.exists ?? fs.existsSync)(overlayRegistryPath(env, o.home));
}

/** Parse the JSON `specguard overlay resolve --json` prints (it may be preceded by other lines). Null when there is none. */
export function parseResolveOutput(stdout: string): ProjectConfigInfo | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const doc = JSON.parse(text) as Record<string, unknown>;
      if (typeof doc.configured !== 'boolean') continue;
      if (!doc.configured) return { configured: false, via: 'none', ...(typeof doc.reason === 'string' ? { reason: doc.reason } : {}) };
      const via = doc.via === 'overlay' || doc.via === 'env-overlay' || doc.via === 'env-config' || doc.via === 'repo' ? doc.via : 'overlay';
      return {
        configured: true,
        via,
        ...(typeof doc.configDir === 'string' ? { configDir: doc.configDir } : {}),
        ...(typeof doc.config === 'string' ? { configFile: doc.config } : {}),
        ...(typeof doc.overlayRoot === 'string' ? { overlayRoot: doc.overlayRoot } : {}),
        ...(typeof doc.app === 'string' ? { app: doc.app } : {}),
      };
    } catch {
      /* not JSON: keep looking */
    }
  }
  return null;
}

/**
 * Resolve a folder: its own config (no CLI), else, when an overlay may apply, the CLI's answer. Never throws: a CLI that
 * cannot run or answers nonsense means "not configured".
 */
export async function resolveProjectConfig(folder: string, o: DetectOptions = {}): Promise<ProjectConfigInfo> {
  const own = path.join(folder, REL);
  if ((o.exists ?? fs.existsSync)(own)) return { configured: true, via: 'repo', configDir: folder, configFile: own };
  if (!o.run || !overlayMayApply(o)) return { configured: false, via: 'none' };
  try {
    const { stdout } = await o.run(['overlay', 'resolve', folder, '--json'], folder);
    return parseResolveOutput(stdout) ?? { configured: false, via: 'none' };
  } catch {
    return { configured: false, via: 'none' };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A small cache, so the synchronous readers (tree rows, dashboard pushes) can use the last answer
// ---------------------------------------------------------------------------------------------------------------------

const cache = new Map<string, ProjectConfigInfo>();
let runner: CliRunner | undefined;

/** The extension gives the cache its CLI runner once, on activation. */
export function setConfigRunner(run: CliRunner | undefined): void {
  runner = run;
}

/** Forget every cached answer (tests, and after an explicit refresh). */
export function clearProjectConfigCache(): void {
  cache.clear();
}

/** Ask (CLI when needed) and remember the answer for the synchronous readers below. */
export async function detectProjectConfig(folder: string, o: DetectOptions = {}): Promise<ProjectConfigInfo> {
  const info = await resolveProjectConfig(folder, { ...(runner ? { run: runner } : {}), ...o });
  cache.set(path.resolve(folder), info);
  return info;
}

/** The last answer for a folder, or the in-repo check when none was recorded yet. Synchronous. */
export function cachedProjectConfig(folder: string, exists: (file: string) => boolean = fs.existsSync): ProjectConfigInfo {
  const hit = cache.get(path.resolve(folder));
  if (hit?.configured) return hit;
  const own = path.join(folder, REL);
  return exists(own) ? { configured: true, via: 'repo', configDir: folder, configFile: own } : (hit ?? { configured: false, via: 'none' });
}

/** The directory holding the folder's `.specguard/`: the folder itself unless its specs live in an overlay. */
export function configDirFor(folder: string, exists?: (file: string) => boolean): string {
  return cachedProjectConfig(folder, exists).configDir ?? folder;
}

/** The folder's config file (existing or not): the overlay's when the specs live there. */
export function configFileFor(folder: string, exists?: (file: string) => boolean): string {
  return cachedProjectConfig(folder, exists).configFile ?? path.join(folder, REL);
}

/** One line for a tooltip or label, or '' for an ordinary in-repo config. */
export function describeProjectConfig(info: ProjectConfigInfo): string {
  if (!info.configured || info.via === 'repo' || info.via === 'none') return '';
  if (info.via === 'env-config') return `config from SPECGUARD_CONFIG (${info.configDir ?? ''})`;
  return `specs in overlay ${info.overlayRoot ?? ''}${info.app ? ` (app ${info.app})` : ''}`;
}
