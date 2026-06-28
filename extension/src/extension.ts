/**
 * SpecGuard VS Code / Cursor extension entry point.
 *
 * Registers all commands, the coverage tree view, drift file decorations,
 * and the status bar item. MCP registration for Cursor is also wired here.
 */
import * as vscode from 'vscode';
import { CoverageProvider } from './sidebar.js';
import { registerCommands } from './commands.js';
import { registerMcpForCursor } from './mcp-registration.js';
import { initWorkspaceState, getActiveWorkspaceRoot } from './workspace-state.js';
import { setExtensionPath } from './dashboard/cli.js';

let statusBarItem: vscode.StatusBarItem | undefined;
let coverageProvider: CoverageProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initWorkspaceState(context);
  setExtensionPath(context.extensionPath);

  // Coverage tree view
  coverageProvider = new CoverageProvider();
  const treeView = vscode.window.createTreeView('specguard.coverageView', {
    treeDataProvider: coverageProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Status bar: shows "SpecGuard: 82%" or similar
  const config = vscode.workspace.getConfiguration('specguard');
  if (config.get<boolean>('showStatusBar', true)) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBarItem.command = 'specguard.status';
    statusBarItem.text = '$(shield) SpecGuard';
    statusBarItem.tooltip = 'SpecGuard — click to view spec coverage';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
  }

  // Commands
  registerCommands(context, coverageProvider, statusBarItem);

  // Auto-refresh on spec file changes
  if (config.get<boolean>('autoRefresh', true)) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/specs/**/*.md');
    watcher.onDidChange(() => coverageProvider?.refresh());
    watcher.onDidCreate(() => coverageProvider?.refresh());
    watcher.onDidDelete(() => coverageProvider?.refresh());
    context.subscriptions.push(watcher);
  }

  // Initial coverage load (non-blocking)
  void coverageProvider.refresh();

  // Offer MCP registration to new users
  await maybeOfferMcpRegistration(context);
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
