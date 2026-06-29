/**
 * VS Code command handlers for SpecGuard extension.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { CoverageProvider } from './sidebar.js';
import { registerMcpForCursor } from './mcp-registration.js';
import { openDashboardPanel } from './dashboard/panel.js';
import { getActiveWorkspaceRoot, pickWorkspaceRoot, setActiveWorkspaceRoot } from './workspace-state.js';

export function registerCommands(
  context: vscode.ExtensionContext,
  coverageProvider: CoverageProvider,
  statusBarItem: vscode.StatusBarItem | undefined,
): void {
  // --- specguard.switchProject ----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.switchProject', async () => {
      const picked = await pickWorkspaceRoot();
      if (!picked) return;
      await setActiveWorkspaceRoot(picked);
      void coverageProvider.refresh();
      const folderName = path.basename(picked);
      vscode.window.showInformationMessage(`SpecGuard: switched to project "${folderName}"`);
      // Reopen dashboard pointed at new root
      openDashboardPanel(context);
    }),
  );

  // --- specguard.init -------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.init', async () => {
      const ws = getActiveWorkspaceRoot();
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
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'drift', 'SpecGuard Drift');
    }),
  );

  // --- specguard.generateTests ----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.generateTests', async (uri?: vscode.Uri) => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;

      let specKey: string | undefined;
      if (uri) {
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

  // --- specguard.runTests ---------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.runTests', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'test --all', 'SpecGuard Run Tests');
    }),
  );

  // --- specguard.qualityCheck -----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.qualityCheck', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'quality --all', 'SpecGuard Quality');
    }),
  );

  // --- specguard.validateFunctional -----------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctional', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'validate --all', 'SpecGuard Validate');
    }),
  );

  // --- specguard.validateFunctionalAll --------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctionalAll', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'validate --all', 'SpecGuard Validate (All)');
    }),
  );

  // --- specguard.validateFunctionalIntegration ------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctionalIntegration', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'validate --type integration', 'SpecGuard Validate (Integration)');
    }),
  );

  // --- specguard.validateFunctionalE2E --------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctionalE2E', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'validate --type e2e', 'SpecGuard Validate (E2E)');
    }),
  );

  // --- specguard.importSpec -------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.importSpec', async () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;

      const source = await vscode.window.showInputBox({
        prompt: 'Import spec from URL, file path, or leave blank for interactive',
        placeHolder: 'https://docs.example.com/api or ./docs/PRD.md',
      });

      const args = source ? `import --source "${source}"` : 'import';
      runInTerminal(ws, args, 'SpecGuard Import');
    }),
  );

  // --- specguard.reverseGenerate --------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.reverseGenerate', async () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;

      const app = await vscode.window.showInputBox({
        prompt: 'App name (matches .specguard/config.json) or leave blank for --all',
        placeHolder: 'my-app',
      });

      const args = app ? `reverse --app ${app}` : 'reverse --all';
      runInTerminal(ws, args, 'SpecGuard Reverse');
    }),
  );

  // --- specguard.gapAnalysis ------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.gapAnalysis', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'gap-analysis', 'SpecGuard Gap Analysis');
    }),
  );

  // --- specguard.depsAudit --------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.depsAudit', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'deps', 'SpecGuard Deps Audit');
    }),
  );

  // --- specguard.runSast ----------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.runSast', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'security --with-sast --all', 'SpecGuard SAST');
    }),
  );

  // --- specguard.securityScan -----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.securityScan', async (uri?: vscode.Uri) => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;

      let specKey: string | undefined;
      if (uri) {
        specKey = deriveSpecKey(ws, uri.fsPath);
      }

      const args = specKey ? `security --spec ${specKey}` : 'security --all';
      runInTerminal(ws, args, 'SpecGuard Security');
    }),
  );

  // --- specguard.generateSecurityTests --------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.generateSecurityTests', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'generate --type security --all', 'SpecGuard Security Tests');
    }),
  );

  // --- specguard.matrix -----------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.matrix', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'matrix', 'SpecGuard Matrix');
    }),
  );

  // --- specguard.generateDocs -----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.generateDocs', () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) return;
      runInTerminal(ws, 'docs --all', 'SpecGuard Docs');
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

  // --- specguard.openDashboard ----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.openDashboard', () => openDashboardPanel(context)),
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
