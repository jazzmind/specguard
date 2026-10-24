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
import { codeWorkspaceFile, getActiveWorkspaceRoot, getWorkspaceManifestRoot, manifestRootForCodeWorkspace } from './workspace-state.js';

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

/**
 * "SpecGuard: Initialize Workspace": create the workspace manifest by hand, whether or not the automatic offer was
 * dismissed. With a `.code-workspace` open it registers that file's folders and links the manifest to it (an existing
 * manifest is synced instead). Otherwise the user picks a folder and its tree is scanned for repos.
 * Returns true when a manifest was created or changed.
 */
export async function initWorkspace(context: vscode.ExtensionContext): Promise<boolean> {
  const file = codeWorkspaceFile();
  let res: { code: number; lines: string[] };
  let where: string;
  if (file) {
    const root = manifestRootForCodeWorkspace(file);
    if (fs.existsSync(path.join(root, '.specguard', 'workspace.json'))) return syncCodeWorkspace(context, { interactive: true });
    where = path.basename(file);
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SpecGuard: creating a workspace from ${where}…` }, () =>
      runCli(['workspace', 'init', '--from', file, '--link'], path.dirname(file)),
    );
  } else {
    const start = vscode.workspace.workspaceFolders?.[0]?.uri;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Scan this folder for repos',
      title: 'SpecGuard: the folder that holds your repos',
      ...(start ? { defaultUri: vscode.Uri.file(path.dirname(start.fsPath)) } : {}),
    });
    if (!picked?.[0]) return false;
    const dir = picked[0].fsPath;
    if (fs.existsSync(path.join(dir, '.specguard', 'workspace.json'))) {
      void vscode.window.showInformationMessage(`SpecGuard: ${dir} already has a workspace manifest.`);
      return false;
    }
    where = path.basename(dir);
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SpecGuard: scanning ${where} for repos…` }, () =>
      runCli(['workspace', 'init', '--recursive'], dir),
    );
  }
  if (res.code !== 0) {
    void vscode.window.showErrorMessage(`SpecGuard: could not create the workspace: ${res.lines.slice(-2).join(' ')}`);
    return false;
  }
  void vscode.window.showInformationMessage(`SpecGuard: workspace ${where} created with ${changeLines(res.lines).length || 'its'} repos. Ignore any you do not want analysed.`);
  return true;
}

/**
 * "SpecGuard: Set API Key": save the key SpecGuard's model calls use. It is typed into a masked box and handed to
 * `specguard key set` through the environment of that one process (never on a command line), which writes it to a
 * git-ignored, owner-only `.env`: the user's own (every workspace), the workspace's, or the project's.
 */
export async function setApiKey(): Promise<boolean> {
  const root = getActiveWorkspaceRoot();
  const manifestRoot = getWorkspaceManifestRoot();
  if (!root) {
    void vscode.window.showErrorMessage('SpecGuard: open a folder first.');
    return false;
  }
  const options: Array<vscode.QuickPickItem & { scope: 'user' | 'workspace' | 'repo' }> = [
    { label: 'All my workspaces', description: '~/.config/specguard/.env', scope: 'user' },
    ...(manifestRoot ? [{ label: 'This workspace', description: path.join(manifestRoot, '.specguard', '.env'), scope: 'workspace' as const }] : []),
    { label: 'This project only', description: path.join(root, '.specguard', '.env'), scope: 'repo' },
  ];
  const where = await vscode.window.showQuickPick(options, { title: 'SpecGuard API key (1/2): where should it be available?', placeHolder: 'The key is stored in a git-ignored file, never in config.json' });
  if (!where) return false;
  const key = await vscode.window.showInputBox({ title: 'SpecGuard API key (2/2)', prompt: 'The key for SpecGuard\'s model calls (Anthropic, or your proxy\'s virtual key)', password: true, ignoreFocusOut: true, validateInput: (v) => (v.trim() === '' || /[\r\n]/.test(v) ? 'Enter the key on one line' : undefined) });
  if (!key) return false;
  const cli = await resolveCliPath(root);
  const lines: string[] = [];
  const args = ['key', 'set', '--scope', where.scope, '--from-env', 'SPECGUARD_NEW_KEY', ...(where.scope === 'workspace' && manifestRoot ? ['--workspace', manifestRoot] : [])];
  const handle = spawnCli(cli, args, root, (l) => lines.push(l), { SPECGUARD_NEW_KEY: key.trim() });
  let code = 1;
  try {
    code = await handle.promise;
  } catch (err) {
    lines.push((err as Error).message);
  }
  if (code !== 0) {
    void vscode.window.showErrorMessage(`SpecGuard: could not save the key: ${lines.slice(-1).join(' ')}`);
    return false;
  }
  void vscode.window.showInformationMessage(`SpecGuard: key saved (${where.label.toLowerCase()}). New runs pick it up now; restart the MCP server for agents to see it.`);
  return true;
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
