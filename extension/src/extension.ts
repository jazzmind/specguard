/**
 * SpecGuard VS Code / Cursor extension entry point.
 *
 * Registers all commands, the coverage tree view, drift file decorations,
 * and the status bar item. MCP registration for Cursor is also wired here.
 */
import * as vscode from 'vscode';
import { CoverageProvider, WorkspaceProvider } from './sidebar.js';
import { PipelinesProvider } from './pipelines-view.js';
import { registerCommands } from './commands.js';
import { registerMcpForCursor } from './mcp-registration.js';
import { initWorkspaceState } from './workspace-state.js';
import { resolveCliPath, setExtensionPath, spawnCli } from './dashboard/cli.js';
import { detectProjectConfig, setConfigRunner, type CliRunner } from './project-config.js';
import * as fs from 'fs';
import { expectedCliVersion, mismatchMessage, queryCliVersion } from './cli-version.js';
import { ApiHub } from './api/hub.js';
import { setHub } from './api/shared.js';
import { getActiveWorkspaceRoot } from './workspace-state.js';
import { watchCodeWorkspace } from './code-workspace.js';
import { registerPluginViews } from './plugins-view.js';
import { getPlugins, onDidChangePlugins } from './plugins-state.js';
import * as path from 'path';

let statusBarItem: vscode.StatusBarItem | undefined;
let coverageProvider: CoverageProvider | undefined;

/** Runs the CLI the extension resolves (setting, local install, dev checkout or bundled) and collects what it printed. */
const cliRunner: CliRunner = async (args, cwd) => {
  try {
    const cli = await resolveCliPath(cwd);
    if (!cli) return { stdout: '', code: null };
    const lines: string[] = [];
    const code = await spawnCli(cli, args, cwd, (line) => lines.push(line)).promise;
    return { stdout: lines.join('\n'), code };
  } catch {
    return { stdout: '', code: null };
  }
};

/**
 * Whether this window has a SpecGuard project: a folder with its own config or workspace manifest, or one whose specs
 * live in an overlay repo (the CLI says so; asked only for folders without their own config, and only when an overlay
 * may apply). The extension also starts on `onStartupFinished`, so a window with no SpecGuard project must stay quiet.
 */
async function windowHasProject(): Promise<boolean> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.some((f) => fs.existsSync(path.join(f, '.specguard', 'workspace.json')))) return true;
  for (const f of folders) if ((await detectProjectConfig(f)).configured) return true;
  return false;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initWorkspaceState(context);
  setExtensionPath(context.extensionPath);
  setConfigRunner(cliRunner);
  const relevant = await windowHasProject();

  // One connection to SpecGuard's API: the team server when configured and reachable, else a local `serve`.
  const hub = new ApiHub(context.secrets);
  setHub(hub);
  context.subscriptions.push(
    hub,
    { dispose: () => setHub(undefined) },
    hub.onDidChange(() => void coverageProvider?.refresh()),
    vscode.commands.registerCommand('specguard.signIn', async () => {
      const root = getActiveWorkspaceRoot();
      if (root) await hub.signIn(root);
      else void vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.');
    }),
    vscode.commands.registerCommand('specguard.signOut', async () => {
      const root = getActiveWorkspaceRoot();
      if (root) await hub.signOut(root);
    }),
  );

  // Coverage tree view
  coverageProvider = new CoverageProvider();
  context.subscriptions.push(vscode.window.createTreeView('specguard.workspaceView', {
    treeDataProvider: new WorkspaceProvider(coverageProvider),
    showCollapseAll: true,
  }));
  const treeView = vscode.window.createTreeView('specguard.coverageView', {
    treeDataProvider: coverageProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Pipelines tree view
  const pipelinesProvider = new PipelinesProvider();
  const pipelinesView = vscode.window.createTreeView('specguard.pipelinesView', {
    treeDataProvider: pipelinesProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(pipelinesView);

  // Plugins view; the Pipelines view follows which plugins are on.
  const syncPipelines = async (): Promise<void> => {
    const root = getActiveWorkspaceRoot();
    pipelinesProvider.setPluginRows(root ? (await getPlugins(root)).rows : undefined);
  };
  registerPluginViews(context, hub, () => void coverageProvider?.refresh());
  context.subscriptions.push(onDidChangePlugins(() => void syncPipelines()));
  void syncPipelines();

  // Status bar: shows "SpecGuard: 82%" or similar
  const config = vscode.workspace.getConfiguration('specguard');
  if (relevant && config.get<boolean>('showStatusBar', true)) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBarItem.command = 'specguard.status';
    statusBarItem.text = '$(shield) SpecGuard';
    statusBarItem.tooltip = 'SpecGuard — click to view spec coverage';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
  }

  // Commands (includes specguard.updateProject)
  registerCommands(context, coverageProvider, statusBarItem);

  // Auto-refresh on spec file changes
  if (relevant && config.get<boolean>('autoRefresh', true)) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/specs/**/*.md');
    watcher.onDidChange(() => coverageProvider?.refresh());
    watcher.onDidCreate(() => coverageProvider?.refresh());
    watcher.onDidDelete(() => coverageProvider?.refresh());
    context.subscriptions.push(watcher);
  }

  // Initial coverage load (non-blocking)
  void coverageProvider.refresh();

  // Keep the workspace manifest in step with the open .code-workspace file.
  watchCodeWorkspace(context, () => void coverageProvider?.refresh());

  // Nothing below is for a window that has no SpecGuard project (the extension also starts on `onStartupFinished`).
  if (!relevant) return;

  // Warn (once per session) when an installed CLI is not the version this extension was built for.
  void warnOnCliMismatch(context);

  // Offer MCP registration to new users
  await maybeOfferMcpRegistration(context);
}

async function warnOnCliMismatch(context: vscode.ExtensionContext): Promise<void> {
  try {
    const ws = getActiveWorkspaceRoot();
    const expected = expectedCliVersion();
    if (!ws || !expected) return;
    const cliPath = await resolveCliPath(ws);
    if (!cliPath || cliPath.endsWith('.ts')) return; // nothing found, or a dev checkout
    const bundled = path.join(context.extensionPath, 'dist', 'cli.js');
    if (path.resolve(cliPath) === path.resolve(bundled)) return; // the bundled CLI matches by construction
    const message = mismatchMessage(await queryCliVersion(cliPath, ws), expected);
    if (message) void vscode.window.showWarningMessage(message);
  } catch {
    /* a version check must never break activation */
  }
}

export function deactivate(): void {
  statusBarItem?.dispose();
}

async function maybeOfferMcpRegistration(context: vscode.ExtensionContext): Promise<void> {
  const offered = context.globalState.get<boolean>('specguard.mcpOfferShown', false);
  if (offered) return;

  const isCursor = vscode.env.appName.toLowerCase().includes('cursor');
  if (!isCursor) return;

  await context.globalState.update('specguard.mcpOfferShown', true);

  const action = await vscode.window.showInformationMessage(
    'SpecGuard: Register the MCP server with Cursor so AI agents can use specguard tools directly?',
    'Register',
    'Not now',
  );
  if (action === 'Register') {
    await registerMcpForCursor();
  }
}
