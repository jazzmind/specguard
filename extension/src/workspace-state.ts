/**
 * Manages the "active workspace root" — which folder in a multi-root workspace
 * SpecGuard is currently operating on.
 *
 * When VS Code has only one workspace folder this is trivially that folder.
 * When there are multiple folders the user can pick via `specguard.switchProject`.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { inventorySpecs, specCountLabel, type SpecInventory } from './spec-inventory.js';
import { cachedProjectConfig, configDirFor, configFileFor, detectProjectConfig } from './project-config.js';

const STATE_KEY = 'specguard.activeWorkspaceRoot';

let _context: vscode.ExtensionContext | undefined;

export function initWorkspaceState(context: vscode.ExtensionContext): void {
  _context = context;
}

/** Return the active workspace root, falling back to the first folder. */
export function getActiveWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

  const stored = _context?.workspaceState.get<string>(STATE_KEY);
  if (stored && fs.existsSync(stored)) {
    // Make sure the stored path is still one of the open workspace folders
    if (folders.some((f) => f.uri.fsPath === stored)) return stored;
  }

  return folders[0].uri.fsPath;
}

/** Persist a new active workspace root. */
export async function setActiveWorkspaceRoot(fsPath: string): Promise<void> {
  await _context?.workspaceState.update(STATE_KEY, fsPath);
}

/**
 * Show a quick-pick to choose a workspace folder. Returns the chosen root or
 * undefined if the user cancelled. Skips the picker if there is only one folder.
 */
export async function pickWorkspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.');
    return undefined;
  }

  if (folders.length === 1) return folders[0].uri.fsPath;

  const current = getActiveWorkspaceRoot();

  interface FolderItem extends vscode.QuickPickItem {
    fsPath: string;
  }

  // A folder whose specs live in an overlay repo is configured too: ask the CLI before labelling.
  await warmProjectConfigs();
  const items: FolderItem[] = folders.map((f) => ({
    label: f.name,
    description: f.uri.fsPath,
    detail: f.uri.fsPath === current ? '$(check) current project' : hasSpecGuardConfig(f.uri.fsPath) ? '$(shield) configured' : '',
    fsPath: f.uri.fsPath,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'SpecGuard: Switch Project',
    placeHolder: 'Select the workspace folder to use with SpecGuard',
    matchOnDescription: true,
  });

  return picked?.fsPath;
}

function hasSpecGuardConfig(root: string): boolean {
  return cachedProjectConfig(root).configured;
}

/**
 * Resolve every open folder and every repo of the workspace manifest, so the synchronous readers (`hasSpecGuardConfig`,
 * `loadWorkspaceManifest`) see overlay-covered folders as configured. A folder with its own config costs no CLI call.
 */
export async function warmProjectConfigs(): Promise<void> {
  const folders = new Set<string>((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  for (const repo of loadWorkspaceManifest()?.repos ?? []) folders.add(repo.absPath);
  await Promise.all([...folders].map((f) => detectProjectConfig(f)));
}

// ---------------------------------------------------------------------------
// Workspace manifest (workspace.json) detection
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` looking for `.specguard/workspace.json`.
 * Returns the directory containing `.specguard/`, or undefined if not found.
 */
export function findWorkspaceManifestDir(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, '.specguard', 'workspace.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) return undefined;
    dir = parent;
  }
}

/** The `.code-workspace` file VS Code opened, when it is a file on disk. */
export function codeWorkspaceFile(): string | undefined {
  const file = vscode.workspace.workspaceFile;
  return file && file.scheme === 'file' && file.fsPath.endsWith('.code-workspace') ? file.fsPath : undefined;
}

/**
 * Where the manifest kept for a `.code-workspace` lives: the folder its `specguard.workspaceManifest`
 * setting names, else `<its folder>/.specguard-workspaces/<name>`. Mirrors the CLI's rule.
 */
export function manifestRootForCodeWorkspace(file: string): string {
  let setting: unknown;
  try {
    const doc = parseJsonc(fs.readFileSync(file, 'utf-8'), [], { allowTrailingComma: true }) as { settings?: Record<string, unknown> } | undefined;
    setting = doc?.settings?.['specguard.workspaceManifest'];
  } catch {
    setting = undefined;
  }
  if (typeof setting === 'string' && setting.trim() !== '') {
    const target = path.resolve(path.dirname(file), setting);
    return path.basename(target) === 'workspace.json' ? path.dirname(path.dirname(target)) : target;
  }
  return path.join(path.dirname(file), '.specguard-workspaces', path.basename(file, '.code-workspace'));
}

/**
 * Return the workspace manifest root for the active VS Code workspace.
 *
 * Strategy:
 * 1. The manifest kept for the open `.code-workspace` file, when there is one on disk.
 * 2. Walk up from the currently active workspace folder looking for workspace.json.
 * 3. If not found there, try each open folder.
 * 4. Returns undefined when no manifest exists anywhere.
 */
export function getWorkspaceManifestRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

  const cws = codeWorkspaceFile();
  if (cws) {
    const root = manifestRootForCodeWorkspace(cws);
    if (fs.existsSync(path.join(root, '.specguard', 'workspace.json'))) return root;
  }

  // Try the active project root first
  const active = getActiveWorkspaceRoot();
  if (active) {
    const found = findWorkspaceManifestDir(active);
    if (found) return found;
  }

  // Try each workspace folder
  for (const folder of folders) {
    const found = findWorkspaceManifestDir(folder.uri.fsPath);
    if (found) return found;
  }

  return undefined;
}

/** Return true when a workspace.json exists relative to the active workspace. */
export function hasWorkspaceManifest(): boolean {
  return getWorkspaceManifestRoot() !== undefined;
}

// ---------------------------------------------------------------------------
// Workspace manifest — full typed loader
// ---------------------------------------------------------------------------

export interface WorkspaceRepo {
  key: string;
  path: string;
  absPath: string;
  role: string;
  description: string;
  ignore: boolean;
  ignoreReason: string;
  hasConfig: boolean;
  /** What the last `check --workspace` recorded for this repo, when it has run. */
  rollup?: RepoRollupSummary;
  specCount: number;
  /** Sidebar and dashboard text, e.g. "9 capabilities" or "12 spec files". */
  specLabel: string;
  /** Retired v1 specs under specs/_archive. Not included in specCount. */
  archivedSpecs: number;
  hasSystemSpec: boolean;
}

/** The part of the CLI's per-repo rollup the panel shows. */
export interface RepoRollupSummary {
  state: string;
  claims: number;
  proven: number;
  provenPct: number;
  failed: number;
  stale: number;
  incomplete: number;
  securityTotal: number;
  securityCritical: number;
  securityHigh: number;
  docsStale: number;
  intentGaps: number;
  lagging: boolean;
}

export interface WorkspaceManifestData {
  name: string;
  catalog?: string;
  /** The `.code-workspace` the manifest follows, when linked. */
  codeWorkspace?: string;
  /** When the rollup was last computed. */
  rollupAt?: string;
  repos: WorkspaceRepo[];
  manifestRoot: string;
}

/**
 * Count spec files for a repo, accounting for monorepo layouts.
 *
 * When `.specguard/config.json` exists, resolve each app's `specDir` relative
 * to the repo root (matching the CLI's `resolveFromRoot` logic) and count from
 * all of those directories — even when they point outside the repo root.
 *
 * Falls back to counting `{absPath}/specs` for repos without a config or with
 * no apps defined.
 */
function inventoryForRepo(absPath: string): SpecInventory {
  const empty: SpecInventory = { capabilities: 0, hasSystem: false, livingFiles: 0, archivedFiles: 0 };
  const dirs: string[] = [];
  // The config may live in an overlay repo; its specDirs are relative to the folder that holds that `.specguard/`.
  const configPath = configFileFor(absPath);
  const base = configDirFor(absPath);
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        apps?: Array<{ specDir?: string }>;
      };
      const apps = config.apps ?? [];
      const seen = new Set<string>();
      for (const app of apps) {
        if (!app.specDir) continue;
        const resolved = path.normalize(path.resolve(base, app.specDir));
        if (!seen.has(resolved)) {
          seen.add(resolved);
          dirs.push(resolved);
        }
      }
    } catch { /* fall through to the default specs directory */ }
  }
  if (dirs.length === 0) dirs.push(path.join(absPath, 'specs'));
  return dirs.reduce((sum, dir) => {
    const inv = inventorySpecs(dir);
    return {
      capabilities: sum.capabilities + inv.capabilities,
      hasSystem: sum.hasSystem || inv.hasSystem,
      livingFiles: sum.livingFiles + inv.livingFiles,
      archivedFiles: sum.archivedFiles + inv.archivedFiles,
    };
  }, empty);
}

/**
 * Load workspace.json and augment each repo entry with disk-derived metadata:
 * - `absPath` resolved from manifestRoot + repo.path
 * - `hasConfig` — .specguard/config.json exists, or an overlay repo holds the repo's specs (as last resolved)
 * - `specCount` — capabilities when the repo has them, otherwise living spec files. Archived v1 specs are excluded.
 * Returns null when no workspace.json is found.
 */
export function loadWorkspaceManifest(): WorkspaceManifestData | null {
  const manifestRoot = getWorkspaceManifestRoot();
  if (!manifestRoot) return null;

  const manifestPath = path.join(manifestRoot, '.specguard', 'workspace.json');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    type Entry = { path?: string; role?: string; description?: string; ignore?: boolean; ignoreReason?: string; kind?: string };
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      name?: string;
      catalog?: string;
      repos?: Record<string, Entry>;
      units?: Record<string, Entry>;
      source?: { codeWorkspace?: string };
    };

    const name = raw.name ?? path.basename(manifestRoot);
    // Repos are the legacy `repos` map plus the `units` of kind repo; packages belong to a monorepo scan.
    const reposRaw: Record<string, Entry> = { ...(raw.repos ?? {}) };
    for (const [key, unit] of Object.entries(raw.units ?? {})) if (unit.kind === 'repo' && !reposRaw[key]) reposRaw[key] = unit;

    const rollup = loadRollup(manifestRoot);

    const repos: WorkspaceRepo[] = Object.entries(reposRaw).map(([key, entry]) => {
      const relPath = entry.path ?? key;
      const absPath = path.resolve(manifestRoot, relPath);
      const hasConfig = cachedProjectConfig(absPath).configured;
      const inventory = inventoryForRepo(absPath);
      const counted = specCountLabel(inventory);
      return {
        key,
        path: relPath,
        absPath,
        role: entry.role ?? 'unknown',
        description: entry.description ?? '',
        ignore: entry.ignore === true,
        ignoreReason: entry.ignoreReason ?? '',
        hasConfig,
        rollup: rollup.byKey[key],
        specCount: counted.specCount,
        specLabel: counted.specLabel,
        archivedSpecs: inventory.archivedFiles,
        hasSystemSpec: inventory.hasSystem,
      };
    });

    return {
      name,
      ...(typeof raw.catalog === 'string' ? { catalog: path.resolve(manifestRoot, raw.catalog) } : {}),
      repos,
      manifestRoot,
      ...(raw.source?.codeWorkspace ? { codeWorkspace: path.resolve(manifestRoot, raw.source.codeWorkspace) } : {}),
      ...(rollup.generated ? { rollupAt: rollup.generated } : {}),
    };
  } catch {
    return null;
  }
}

/** Read `.specguard/rollup.json`, which `specguard check --workspace` writes. */
function loadRollup(manifestRoot: string): { generated?: string; byKey: Record<string, RepoRollupSummary> } {
  const file = path.join(manifestRoot, '.specguard', 'rollup.json');
  const byKey: Record<string, RepoRollupSummary> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      generated?: string;
      repos?: Array<{
        key: string;
        state: string;
        coverage: { claims: number; proven: number; provenPct: number; failed: number; stale: number; incomplete: number };
        security: { total: number; open: Record<string, number> };
        docs: { stale: string[] };
        intentGaps: string[];
        freshness: { stale: boolean };
      }>;
    };
    for (const r of raw.repos ?? []) {
      byKey[r.key] = {
        state: r.state,
        claims: r.coverage.claims,
        proven: r.coverage.proven,
        provenPct: r.coverage.provenPct,
        failed: r.coverage.failed,
        stale: r.coverage.stale,
        incomplete: r.coverage.incomplete,
        securityTotal: r.security.total,
        securityCritical: r.security.open.critical ?? 0,
        securityHigh: r.security.open.high ?? 0,
        docsStale: r.docs.stale.length,
        intentGaps: r.intentGaps.length,
        lagging: r.freshness.stale,
      };
    }
    return { generated: raw.generated, byKey };
  } catch {
    return { byKey };
  }
}

/** Load and return the parsed contracts.json for the workspace, or null. */
export interface ContractsSummary {
  nodeCount: number;
  edgeCount: number;
  staleCount: number;
  generatedAt: string | null;
}

export function loadContractsSummary(): ContractsSummary | null {
  const manifestRoot = getWorkspaceManifestRoot();
  if (!manifestRoot) return null;
  const contractsPath = path.join(manifestRoot, '.specguard', 'contracts.json');
  if (!fs.existsSync(contractsPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(contractsPath, 'utf-8')) as {
      nodes?: unknown[];
      edges?: Array<{ lastVerified?: string | null }>;
      generatedAt?: string;
    };
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.length : 0;
    const edges = Array.isArray(raw.edges) ? raw.edges : [];
    const now = Date.now();
    const stale = edges.filter((e) => {
      if (!e.lastVerified) return true;
      return now - new Date(e.lastVerified).getTime() > 30 * 24 * 60 * 60 * 1000;
    }).length;
    return {
      nodeCount: nodes,
      edgeCount: edges.length,
      staleCount: stale,
      generatedAt: raw.generatedAt ?? null,
    };
  } catch {
    return null;
  }
}
