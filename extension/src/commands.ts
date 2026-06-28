/**
 * VS Code command handlers for SpecGuard extension.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { CoverageProvider } from './sidebar.js';
import { registerMcpForCursor } from './mcp-registration.js';

export function registerCommands(
  context: vscode.ExtensionContext,
  coverageProvider: CoverageProvider,
  statusBarItem: vscode.StatusBarItem | undefined,
): void {
  // --- specguard.init -------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.init', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }

      const terminal = vscode.window.createTerminal('SpecGuard Init');
      const cli = await resolveCliPath(ws);
      terminal.sendText(`${cli} init`);
      terminal.show();

      // Watch for config to appear, then refresh
      const watcher = fs.watch(ws, { recursive: true }, (event, filename) => {
        if (filename?.endsWith('config.json') && filename.includes('.specguard')) {
          watcher.close();
          void coverageProvider.refresh();
          vscode.window.showInformationMessage('SpecGuard initialized! Coverage view updated.');
        }
      });
      setTimeout(() => watcher.close(), 30_000);
    }),
  );

  // --- specguard.status -----------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.status', async () => {
      await coverageProvider.refresh();
      const pct = coverageProvider.getCoveragePercent();
      if (statusBarItem) {
        statusBarItem.text = `$(shield) SpecGuard ${pct}%`;
      }
      vscode.window.showInformationMessage(`SpecGuard coverage: ${pct}%`);
    }),
  );

  // --- specguard.drift ------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.drift', () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;
      runInTerminal(ws, 'drift', 'SpecGuard Drift');
    }),
  );

  // --- specguard.generateTests ----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.generateTests', async (uri?: vscode.Uri) => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;

      let specKey: string | undefined;
      if (uri) {
        // Derive a spec key from the file path
        specKey = deriveSpecKey(ws, uri.fsPath);
      } else {
        specKey = await vscode.window.showInputBox({
          prompt: 'Enter spec key (e.g. core/parser) or leave blank for --all',
          placeHolder: 'core/parser',
        });
      }

      const args = specKey ? `generate --spec ${specKey}` : 'generate --all';
      runInTerminal(ws, args, 'SpecGuard Generate');
    }),
  );

  // --- specguard.securityScan -----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.securityScan', async (uri?: vscode.Uri) => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;

      let specKey: string | undefined;
      if (uri) {
        specKey = deriveSpecKey(ws, uri.fsPath);
      }

      const args = specKey ? `security --spec ${specKey}` : 'security --all';
      runInTerminal(ws, args, 'SpecGuard Security');
    }),
  );

  // --- specguard.registerMcp ------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.registerMcp', async () => {
      await registerMcpForCursor();
    }),
  );

  // --- specguard.refreshCoverage --------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.refreshCoverage', () => {
      void coverageProvider.refresh();
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveCliPath(workspaceRoot: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('specguard');
  const custom = config.get<string>('cliPath', '');
  if (custom) return custom;
  const local = path.join(workspaceRoot, 'node_modules', '.bin', 'specguard');
  return fs.existsSync(local) ? local : 'npx specguard';
}

function runInTerminal(ws: string, args: string, name: string): void {
  const terminal = vscode.window.createTerminal({ name, cwd: ws });
  terminal.sendText(`npx specguard ${args}`);
  terminal.show();
}

function deriveSpecKey(workspaceRoot: string, filePath: string): string | undefined {
  const rel = path.relative(workspaceRoot, filePath);
  const specsIdx = rel.indexOf('specs' + path.sep);
  if (specsIdx === -1) return undefined;
  return rel
    .slice(specsIdx + 'specs'.length + 1)
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/');
}
