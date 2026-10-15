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
}

/** The fully parsed workspace manifest. */
export interface WorkspaceManifest {
  version: string;
  /** Workspace name. */
  name: string;
  /** Map of short repo key → repo config. Holds the units of kind `repo`, so existing pipelines see them. */
  repos: Record<string, WorkspaceRepo>;
  /** Every unit, repos and packages, by key. Always present after loading. */
  units: Record<string, WorkspaceUnit>;
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

const repoSchema = z
  .object({
    path: z.string(),
    role: z.string(),
    description: z.string().optional(),
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
  })
  .passthrough();

/** Relative path from workspace root to the manifest file. */
const WORKSPACE_REL = path.join('.specguard', 'workspace.json');

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

/**
 * Load and validate `.specguard/workspace.json`, searching from `cwd` upward.
 *
 * @throws {ConfigNotFoundError} when no workspace.json is found in any ancestor.
 * @throws {ConfigInvalidError} when the file is not valid JSON or fails schema validation.
 */
export async function loadWorkspace(cwd: string = process.cwd()): Promise<WorkspaceManifest> {
  const rootDir = await findWorkspaceDir(cwd);
  if (rootDir === null) {
    throw new ConfigNotFoundError(path.resolve(cwd));
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
  for (const [key, repo] of Object.entries(manifest.repos)) {
    if (manifest.units[key]) {
      throw new ConfigInvalidError(`unit "${key}" is listed under both repos and units`);
    }
    manifest.units[key] = { path: repo.path, kind: 'repo', role: repo.role, description: repo.description };
  }
  for (const [key, unit] of Object.entries(manifest.units)) {
    unit.role ??= unit.kind === 'repo' ? 'consumer' : 'package';
    if (unit.kind === 'repo' && !manifest.repos[key]) {
      manifest.repos[key] = { path: unit.path, role: unit.role, description: unit.description };
    }
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
): Promise<{ manifest: WorkspaceManifest; repos: WorkspaceRepoWithConfig[] }> {
  const manifest = await loadWorkspace(cwd);

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
export async function hasWorkspace(cwd: string = process.cwd()): Promise<boolean> {
  const dir = await findWorkspaceDir(cwd);
  return dir !== null;
}
