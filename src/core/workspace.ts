/**
 * Workspace manifest loader for SpecGuard.
 *
 * A workspace manifest (`<workspace>/.specguard/workspace.json`) registers
 * every repo that participates in the system, their roles, and their paths
 * relative to the workspace root. It sits one level above the individual
 * per-repo `.specguard/config.json` files and enables workspace-level
 * pipelines such as `contracts`, `impact`, and `workspace drift`.
 */
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import type { SpecGuardConfig } from './types.js';
import { ConfigNotFoundError, ConfigInvalidError } from './errors.js';
import { readFile, fileExists } from './reader.js';
import { loadConfig } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Role a repo plays in the system. */
export type RepoRole = 'consumer' | 'provider' | 'test' | 'docs' | string;

/** A single repo entry in the workspace manifest. */
export interface WorkspaceRepo {
  /** Path to the repo directory, relative to workspace root. */
  path: string;
  /** The role this repo plays. */
  role: RepoRole;
  /** Optional human-readable description. */
  description?: string;
  /** True when this repo is left out of every workspace pipeline. */
  ignore?: boolean;
  /** Why it is ignored: `auto:no-config`, `auto:removed`, or free text. */
  ignoreReason?: string;
}

/** The fully parsed workspace manifest. */
export interface WorkspaceManifest {
  version: string;
  /** Workspace name. */
  name: string;
  /** Map of short repo key → repo config. Holds the units of kind `repo`, so existing pipelines see them. */
  repos: Record<string, WorkspaceRepo>;
  /** Every unit, repos and packages, by key. Always present after loading. Ignored units are not here. */
  units: Record<string, WorkspaceUnit>;
  /** Units marked `ignore: true`, by key. Left out of `repos` and `units` so every pipeline skips them. */
  ignored: Record<string, WorkspaceUnit>;
  /** Where the manifest is kept in step with a VS Code `.code-workspace` file, when it is. */
  source?: WorkspaceSource;
  /** Team-server mapping used by `workspace publish`. */
  server?: { workspace?: string; projects?: Record<string, string> };
  /** Feature catalog directory, relative to the workspace root. */
  catalog?: string;
  /** Absolute path to the workspace root (the dir containing `.specguard/workspace.json`). */
  rootDir: string;
}

/** What a unit is: a separate repo, or a package inside a monorepo. */
export type UnitKind = 'repo' | 'package';

/** A unit of the workspace: the one model behind multi-repo and monorepo. */
export interface WorkspaceUnit {
  /** Directory relative to the workspace root, POSIX separators. */
  path: string;
  kind: UnitKind;
  /** consumer | provider | test | docs for repos; `package` for monorepo packages unless set. */
  role: RepoRole;
  description?: string;
  /** The package or module name in its ecosystem, used to find dependencies between units. */
  packageName?: string;
  ecosystem?: 'js' | 'python' | 'go' | 'rust';
  /** How to run just this unit's tests. */
  test?: { command?: string; framework?: string };
  ignore?: boolean;
  ignoreReason?: string;
  /** How the entry was created: by hand, from a `.code-workspace` sync, or by a folder scan. */
  origin?: 'manual' | 'code-workspace' | 'scan';
  /** The folder's display name in the `.code-workspace`, when it has one. */
  folderName?: string;
  /** What the last sync wrote, so a later sync can tell hand edits from its own. */
  syncedValues?: Record<string, string>;
}

/** Link between a manifest and the `.code-workspace` file that feeds it. */
export interface WorkspaceSource {
  /** Path to the `.code-workspace` file, relative to the manifest root, or absolute. */
  codeWorkspace: string;
  mode: 'auto' | 'prompt';
  /** Add folders without a SpecGuard config as ignored instead of registering them. */
  autoIgnoreUnconfigured: boolean;
  syncedAt?: string;
}

/** A repo entry augmented with its loaded SpecGuard config (when present). */
export interface WorkspaceRepoWithConfig extends WorkspaceRepo {
  key: string;
  /** Absolute path to the repo directory. */
  absPath: string;
  /** Loaded per-repo SpecGuard config, or null if the repo has no config. */
  specGuardConfig: SpecGuardConfig | null;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const unitStateFields = {
  ignore: z.boolean().optional(),
  ignoreReason: z.string().optional(),
  origin: z.enum(['manual', 'code-workspace', 'scan']).optional(),
  folderName: z.string().optional(),
  syncedValues: z.record(z.string(), z.string()).optional(),
};

const repoSchema = z
  .object({
    path: z.string(),
    role: z.string(),
    description: z.string().optional(),
    ...unitStateFields,
  })
  .passthrough();

const unitSchema = z
  .object({
    path: z.string(),
    kind: z.enum(['repo', 'package']).default('package'),
    role: z.string().optional(),
    description: z.string().optional(),
    packageName: z.string().optional(),
    ecosystem: z.enum(['js', 'python', 'go', 'rust']).optional(),
    test: z.object({ command: z.string().optional(), framework: z.string().optional() }).passthrough().optional(),
    ...unitStateFields,
  })
  .passthrough();

const sourceSchema = z
  .object({
    codeWorkspace: z.string(),
    mode: z.enum(['auto', 'prompt']).default('auto'),
    autoIgnoreUnconfigured: z.boolean().default(true),
    syncedAt: z.string().optional(),
  })
  .passthrough();

const workspaceSchema = z
  .object({
    version: z.string(),
    name: z.string(),
    // A monorepo-only workspace has no separate repos.
    repos: z.record(z.string(), repoSchema).default({}),
    units: z.record(z.string(), unitSchema).default({}),
    catalog: z.string().optional(),
    source: sourceSchema.optional(),
    server: z
      .object({ workspace: z.string().optional(), projects: z.record(z.string(), z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Relative path from workspace root to the manifest file. */
export const WORKSPACE_REL = path.join('.specguard', 'workspace.json');

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Walk up from `start` looking for `.specguard/workspace.json`.
 * Returns the directory containing `.specguard/`, or null if none found.
 */
async function findWorkspaceDir(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  while (true) {
    if (await fileExists(path.join(dir, WORKSPACE_REL))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Format a ZodError into a readable single-line message. */
function formatZodError(err: z.ZodError): string {
  return err.errors
    .map((e) => {
      const where = e.path.length > 0 ? e.path.join('.') : '(root)';
      return `${where}: ${e.message}`;
    })
    .join('; ');
}

/** Directory (under the `.code-workspace` file's folder) that holds a workspace's manifest by default. */
export const CODE_WORKSPACE_MANIFEST_DIR = '.specguard-workspaces';
/** The `.code-workspace` setting that points at the manifest kept for it. */
export const CODE_WORKSPACE_SETTING = 'specguard.workspaceManifest';

/** Read a `.code-workspace` file. It is JSON with comments and trailing commas allowed. */
export function readCodeWorkspace(file: string): { folders: { path: string; name?: string }[]; settings: Record<string, unknown> } {
  const errors: ParseError[] = [];
  const doc = parseJsonc(readFileSync(file, 'utf-8'), errors, { allowTrailingComma: true }) as
    | { folders?: unknown; settings?: Record<string, unknown> }
    | undefined;
  if (errors.length > 0 || !doc || typeof doc !== 'object') {
    throw new ConfigInvalidError(`${file} is not a valid .code-workspace file`);
  }
  const folders = Array.isArray(doc.folders)
    ? (doc.folders as { path?: unknown; name?: unknown }[]).flatMap((f) =>
        typeof f?.path === 'string' ? [{ path: f.path, name: typeof f.name === 'string' ? f.name : undefined }] : [],
      )
    : [];
  return { folders, settings: doc.settings && typeof doc.settings === 'object' ? doc.settings : {} };
}

/**
 * The directory that holds the manifest kept for a `.code-workspace` file: the one its
 * `specguard.workspaceManifest` setting names, else `<its folder>/.specguard-workspaces/<name>`.
 * Each `.code-workspace` gets its own directory because several often share a folder.
 */
export function manifestRootForCodeWorkspace(file: string): string {
  const abs = path.resolve(file);
  let setting: unknown;
  try {
    setting = readCodeWorkspace(abs).settings[CODE_WORKSPACE_SETTING];
  } catch {
    setting = undefined;
  }
  if (typeof setting === 'string' && setting.trim() !== '') {
    const target = path.resolve(path.dirname(abs), setting);
    return path.basename(target) === 'workspace.json' ? path.dirname(path.dirname(target)) : target;
  }
  return path.join(path.dirname(abs), CODE_WORKSPACE_MANIFEST_DIR, path.basename(abs, '.code-workspace'));
}

/**
 * The manifest a workspace-level command was pointed at with `--workspace` or
 * `SPECGUARD_WORKSPACE`. Only workspace-level commands pass this on: per-repo state such as
 * the proof ledger always resolves from its own directory, or every repo's proofs would
 * land in the workspace root.
 */
export function workspaceHint(explicit?: string): string | undefined {
  const v = explicit ?? process.env.SPECGUARD_WORKSPACE;
  return v && v.trim() !== '' ? v : undefined;
}

/**
 * The directory holding `.specguard/workspace.json` for an explicit pointer: a `.code-workspace`
 * file, a `workspace.json` file, or a directory that contains `.specguard/workspace.json` (or is
 * the `.specguard` directory). Returns null when it does not name a manifest.
 */
export function resolveWorkspaceRoot(explicit: string, base: string = process.cwd()): string | null {
  const abs = path.resolve(base, explicit);
  if (!existsSync(abs)) return null;
  let candidate: string;
  if (statSync(abs).isFile()) {
    candidate = abs.endsWith('.code-workspace')
      ? manifestRootForCodeWorkspace(abs)
      : path.basename(abs) === 'workspace.json'
        ? path.dirname(path.dirname(abs))
        : '';
  } else {
    candidate = path.basename(abs) === '.specguard' ? path.dirname(abs) : abs;
  }
  return candidate && existsSync(path.join(candidate, WORKSPACE_REL)) ? candidate : null;
}

/**
 * Load and validate `.specguard/workspace.json`, searching from `cwd` upward, or from the
 * manifest `explicit` points at (see `resolveWorkspaceRoot`).
 *
 * @throws {ConfigNotFoundError} when no workspace.json is found.
 * @throws {ConfigInvalidError} when the file is not valid JSON or fails schema validation.
 */
export async function loadWorkspace(cwd: string = process.cwd(), explicit?: string): Promise<WorkspaceManifest> {
  const rootDir = explicit ? resolveWorkspaceRoot(explicit, cwd) : await findWorkspaceDir(cwd);
  if (rootDir === null) {
    throw new ConfigNotFoundError(path.resolve(explicit ? path.resolve(cwd, explicit) : cwd));
  }

  const manifestPath = path.join(rootDir, WORKSPACE_REL);
  const raw = await readFile(manifestPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigInvalidError(
      `workspace.json is not valid JSON (${(err as Error).message})`,
      err,
    );
  }

  const result = workspaceSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigInvalidError(formatZodError(result.error), result.error);
  }

  const manifest = result.data as unknown as WorkspaceManifest;
  manifest.rootDir = rootDir;
  normalizeUnits(manifest);
  return manifest;
}

/**
 * Make `repos` and `units` two views of one set. A legacy `repos` entry is a
 * unit of kind `repo`; a `units` entry of kind `repo` is also a repo, so the
 * pipelines that walk `repos` keep seeing every separate repo.
 */
export function normalizeUnits(manifest: WorkspaceManifest): void {
  manifest.ignored = {};
  for (const [key, repo] of Object.entries(manifest.repos)) {
    if (manifest.units[key]) {
      throw new ConfigInvalidError(`unit "${key}" is listed under both repos and units`);
    }
    manifest.units[key] = { ...repo, kind: 'repo', role: repo.role };
  }
  for (const [key, unit] of Object.entries(manifest.units)) {
    unit.role ??= unit.kind === 'repo' ? 'consumer' : 'package';
    if (unit.kind === 'repo' && !manifest.repos[key]) {
      manifest.repos[key] = { path: unit.path, role: unit.role, description: unit.description };
    }
  }
  // The one place ignore is applied: pipelines walk `repos` and `units`, so an ignored entry
  // is moved out of both and they all skip it without a check of their own.
  for (const [key, unit] of Object.entries(manifest.units)) {
    if (unit.ignore !== true) continue;
    manifest.ignored[key] = unit;
    delete manifest.units[key];
    delete manifest.repos[key];
  }
}

/** The unit that owns `file` (workspace-root-relative, POSIX): the deepest unit path that contains it. */
export function unitOfFile(manifest: Pick<WorkspaceManifest, 'units'>, file: string): string | undefined {
  const f = file.split(path.sep).join('/').replace(/^\.\//, '');
  let best: { key: string; len: number } | undefined;
  for (const [key, unit] of Object.entries(manifest.units ?? {})) {
    const dir = unit.path.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (dir === '' || dir === '.') continue;
    if ((f === dir || f.startsWith(`${dir}/`)) && (!best || dir.length > best.len)) best = { key, len: dir.length };
  }
  return best?.key;
}

/**
 * Resolve the absolute path of a repo given the workspace manifest.
 */
export function resolveRepoPath(manifest: WorkspaceManifest, repoKey: string): string {
  const repo = manifest.repos[repoKey];
  if (!repo) throw new Error(`Unknown repo key: ${repoKey}`);
  return path.resolve(manifest.rootDir, repo.path);
}

/**
 * Load the workspace manifest and augment each repo with its absolute path
 * and its SpecGuard config (loaded from `<repoAbsPath>/.specguard/config.json`).
 * Repos without a SpecGuard config get `specGuardConfig: null`.
 */
export async function loadWorkspaceWithConfigs(
  cwd: string = process.cwd(),
  explicit?: string,
): Promise<{ manifest: WorkspaceManifest; repos: WorkspaceRepoWithConfig[] }> {
  const manifest = await loadWorkspace(cwd, explicit);

  const repos: WorkspaceRepoWithConfig[] = [];

  for (const [key, repo] of Object.entries(manifest.repos)) {
    const absPath = path.resolve(manifest.rootDir, repo.path);
    let specGuardConfig: SpecGuardConfig | null = null;
    try {
      specGuardConfig = await loadConfig(absPath);
    } catch {
      // Repo has no SpecGuard config — that's fine.
    }
    repos.push({ ...repo, key, absPath, specGuardConfig });
  }

  return { manifest, repos };
}

/**
 * Check whether a workspace manifest exists starting from `cwd`.
 */
export async function hasWorkspace(cwd: string = process.cwd(), explicit?: string): Promise<boolean> {
  const dir = explicit ? resolveWorkspaceRoot(explicit, cwd) : await findWorkspaceDir(cwd);
  return dir !== null;
}
