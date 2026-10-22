/**
 * Keeps the SpecGuard workspace manifest in step with the open `.code-workspace` file.
 *
 * The manifest (`workspace.json`) stays the source of truth. When VS Code has a `.code-workspace`
 * open, adding or removing a folder runs `specguard workspace sync`, which adds new repos (ignored
 * when they have no SpecGuard config) and never overwrites a hand edit. The first time, the user is
 * asked before anything is created.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';
import { codeWorkspaceFile, manifestRootForCodeWorkspace } from './workspace-state.js';

const ASKED_KEY = 'specguard.codeWorkspaceOffered';
const DEBOUNCE_MS = 1500;

async function runCli(args: string[], cwd: string): Promise<{ code: number; lines: string[] }> {
  const cli = await resolveCliPath(cwd);
  const lines: string[] = [];
  const handle = spawnCli(cli, args, cwd, (l) => lines.push(l));
  try {
    return { code: await handle.promise, lines };
  } catch (err) {
    lines.push((err as Error).message);
    return { code: 1, lines };
  }
}

/** The `workspace sync` lines that describe a change, without the header and trailer. */
function changeLines(lines: string[]): string[] {
  return lines.filter((l) => /^\s+(added|removed|ignored|unignored|updated|missing)\s/.test(l));
}

/**
 * Bring the manifest up to date with the open `.code-workspace`. With no manifest yet, offer to
 * create one (once per file). Returns true when the manifest changed.
 */
export async function syncCodeWorkspace(context: vscode.ExtensionContext, opts: { interactive: boolean }): Promise<boolean> {
  const file = codeWorkspaceFile();
  if (!file) {
    if (opts.interactive) void vscode.window.showInformationMessage('SpecGuard: open a .code-workspace file to keep a workspace manifest in step with it.');
    return false;
  }
  const root = manifestRootForCodeWorkspace(file);
  const manifest = path.join(root, '.specguard', 'workspace.json');

  if (!fs.existsSync(manifest)) {
    const offered = context.workspaceState.get<string[]>(ASKED_KEY, []);
    if (!opts.interactive && offered.includes(file)) return false;
    await context.workspaceState.update(ASKED_KEY, [...new Set([...offered, file])]);
    const pick = await vscode.window.showInformationMessage(
      `SpecGuard: create a workspace for ${path.basename(file)}? It lists each folder, ignores the ones without SpecGuard, and stays in step when you add or remove folders.`,
      'Create',
      'Not now',
    );
    if (pick !== 'Create') return false;
    const res = await runCli(['workspace', 'init', '--from', file, '--link'], path.dirname(file));
    if (res.code !== 0) {
      void vscode.window.showErrorMessage(`SpecGuard: could not create the workspace: ${res.lines.slice(-2).join(' ')}`);
      return false;
    }
    void vscode.window.showInformationMessage(`SpecGuard: workspace created with ${changeLines(res.lines).length} repos. Ignore any you do not want analysed.`);
    return true;
  }

  const res = await runCli(['workspace', 'sync', '--from', file, '--workspace', root], root);
  if (res.code !== 0) {
    void vscode.window.showWarningMessage(`SpecGuard: workspace sync failed: ${res.lines.slice(-2).join(' ')}`);
    return false;
  }
  const changes = changeLines(res.lines).filter((l) => !/\smissing\s/.test(l));
  if (changes.length > 0 && !opts.interactive) {
    void vscode.window.showInformationMessage(`SpecGuard: workspace updated (${changes.length} change${changes.length === 1 ? '' : 's'}).`);
  } else if (opts.interactive) {
    void vscode.window.showInformationMessage(changes.length === 0 ? 'SpecGuard: the workspace is already in step.' : `SpecGuard: workspace updated (${changes.length} change${changes.length === 1 ? '' : 's'}).`);
  }
  return changes.length > 0;
}

/** Sync on activation and whenever folders are added or removed. */
export function watchCodeWorkspace(context: vscode.ExtensionContext, onChanged: () => void): void {
  const run = (interactive: boolean): void => {
    void syncCodeWorkspace(context, { interactive }).then((changed) => {
      if (changed) onChanged();
    });
  };
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!codeWorkspaceFile()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => run(false), DEBOUNCE_MS);
    }),
    { dispose: () => timer && clearTimeout(timer) },
  );
  if (codeWorkspaceFile()) run(false);
}

/** Ignore or include a repo of the workspace. Returns true when the manifest changed. */
export async function setRepoIgnored(manifestRoot: string, key: string, ignore: boolean, reason?: string): Promise<boolean> {
  const args = ['workspace', ignore ? 'ignore' : 'unignore', key, '--workspace', manifestRoot, ...(ignore && reason ? ['--reason', reason] : [])];
  const res = await runCli(args, manifestRoot);
  if (res.code !== 0) void vscode.window.showErrorMessage(`SpecGuard: ${res.lines.slice(-1).join(' ') || 'could not change the repo'}`);
  return res.code === 0;
}
