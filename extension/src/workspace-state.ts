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
  return fs.existsSync(path.join(root, '.specguard', 'config.json'));
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

/**
 * Return the workspace manifest root for the active VS Code workspace.
 *
 * Strategy:
 * 1. Walk up from the currently active workspace folder looking for workspace.json.
 * 2. If not found there, try the common parent of all open folders.
 * 3. Returns undefined when no manifest exists anywhere.
 */
export function getWorkspaceManifestRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

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
  hasConfig: boolean;
  specCount: number;
}

export interface WorkspaceManifestData {
  name: string;
  repos: WorkspaceRepo[];
  manifestRoot: string;
}

/** Recursively count *.md files under `dir`, excluding README.md at any depth. */
function countSpecFiles(dir: string): number {
  let count = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += countSpecFiles(path.join(dir, entry.name));
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.md') &&
        entry.name.toLowerCase() !== 'readme.md'
      ) {
        count++;
      }
    }
  } catch { /* ignore permission errors */ }
  return count;
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
function countSpecsForRepo(absPath: string): number {
  const configPath = path.join(absPath, '.specguard', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        apps?: Array<{ specDir?: string }>;
      };
      const apps = config.apps ?? [];
      if (apps.length > 0) {
        const seen = new Set<string>();
        let total = 0;
        for (const app of apps) {
          if (!app.specDir) continue;
          // Resolve specDir the same way the CLI does: path.resolve(rootDir, specDir)
          const resolved = path.normalize(path.resolve(absPath, app.specDir));
          if (!seen.has(resolved)) {
            seen.add(resolved);
            total += countSpecFiles(resolved);
          }
        }
        // Return config-derived count (may be 0 if specs haven't been generated yet,
        // but that's accurate — don't fall back to avoid double-counting).
        return total;
      }
    } catch { /* fall through to default */ }
  }
  // Default for repos without a config: look for a top-level specs/ directory.
  return countSpecFiles(path.join(absPath, 'specs'));
}

/**
 * Load workspace.json and augment each repo entry with disk-derived metadata:
 * - `absPath` resolved from manifestRoot + repo.path
 * - `hasConfig` — .specguard/config.json exists
 * - `specCount` — fast recursive count of non-README *.md files under specs/
 * Returns null when no workspace.json is found.
 */
export function loadWorkspaceManifest(): WorkspaceManifestData | null {
  const manifestRoot = getWorkspaceManifestRoot();
  if (!manifestRoot) return null;

  const manifestPath = path.join(manifestRoot, '.specguard', 'workspace.json');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      name?: string;
      repos?: Record<string, {
        path?: string;
        role?: string;
        description?: string;
        ignore?: boolean;
      }>;
    };

    const name = raw.name ?? path.basename(manifestRoot);
    const reposRaw = raw.repos ?? {};

    const repos: WorkspaceRepo[] = Object.entries(reposRaw).map(([key, entry]) => {
      const relPath = entry.path ?? key;
      const absPath = path.resolve(manifestRoot, relPath);
      const hasConfig = fs.existsSync(path.join(absPath, '.specguard', 'config.json'));
      const specCount = countSpecsForRepo(absPath);
      return {
        key,
        path: relPath,
        absPath,
        role: entry.role ?? 'unknown',
        description: entry.description ?? '',
        ignore: entry.ignore === true,
        hasConfig,
        specCount,
      };
    });

    return { name, repos, manifestRoot };
  } catch {
    return null;
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
