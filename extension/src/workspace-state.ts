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
