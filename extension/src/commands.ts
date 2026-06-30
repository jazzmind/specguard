/**
 * VS Code command handlers for SpecGuard extension.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { CoverageProvider } from './sidebar.js';
import { registerMcpForCursor } from './mcp-registration.js';
import { openDashboardPanel, openAndRun } from './dashboard/panel.js';
import { getActiveWorkspaceRoot, pickWorkspaceRoot, setActiveWorkspaceRoot } from './workspace-state.js';
import { forceUpdateProjectFiles } from './project-updater.js';

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
      const lang = detectWorkspaceLanguage(ws);
      terminal.sendText(`${cli} init --language ${lang} --harness both`);
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
      void openAndRun(context, 'drift');
    }),
  );

  // --- specguard.generateTests ----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.generateTests', async (uri?: vscode.Uri) => {
      const ws = getActiveWorkspaceRoot();
      let specArgs: string[] | undefined;
      if (uri && ws) {
        const key = deriveSpecKey(ws, uri.fsPath);
        if (key) specArgs = ['--spec', key];
      }
      void openAndRun(context, 'generate', specArgs);
    }),
  );

  // --- specguard.runTests ---------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.runTests', () => {
      void openAndRun(context, 'validate');
    }),
  );

  // --- specguard.qualityCheck -----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.qualityCheck', () => {
      void openAndRun(context, 'quality');
    }),
  );

  // --- specguard.validateFunctional -----------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctional', () => {
      void openAndRun(context, 'validate');
    }),
  );

  // --- specguard.validateFunctionalAll --------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctionalAll', () => {
      void openAndRun(context, 'validate');
    }),
  );

  // --- specguard.validateFunctionalIntegration ------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctionalIntegration', () => {
      void openAndRun(context, 'validate');
    }),
  );

  // --- specguard.validateFunctionalE2E --------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.validateFunctionalE2E', () => {
      void openAndRun(context, 'validate');
    }),
  );

  // --- specguard.importSpec -------------------------------------------------
  // import uses the host's file-picker path — just open the dashboard and
  // trigger the import pipeline (host handles the file dialog).
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.importSpec', () => {
      void openAndRun(context, 'import');
    }),
  );

  // --- specguard.reverseGenerate --------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.reverseGenerate', () => {
      void openAndRun(context, 'reverse');
    }),
  );

  // --- specguard.gapAnalysis ------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.gapAnalysis', () => {
      void openAndRun(context, 'gap-analysis');
    }),
  );

  // --- specguard.depsAudit --------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.depsAudit', () => {
      void openAndRun(context, 'deps');
    }),
  );

  // --- specguard.runSast ----------------------------------------------------
  // SAST is a sub-mode of the security pipeline — run security with sast flag.
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.runSast', () => {
      void openAndRun(context, 'security', ['--with-sast', '--all']);
    }),
  );

  // --- specguard.securityScan -----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.securityScan', async (uri?: vscode.Uri) => {
      const ws = getActiveWorkspaceRoot();
      let specArgs: string[] | undefined;
      if (uri && ws) {
        const key = deriveSpecKey(ws, uri.fsPath);
        if (key) specArgs = ['--spec', key];
      }
      void openAndRun(context, 'security', specArgs);
    }),
  );

  // --- specguard.generateSecurityTests --------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.generateSecurityTests', () => {
      void openAndRun(context, 'security');
    }),
  );

  // --- specguard.matrix -----------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.matrix', () => {
      void openAndRun(context, 'matrix');
    }),
  );

  // --- specguard.generateDocs -----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.generateDocs', () => {
      void openAndRun(context, 'docs');
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

  // --- specguard.updateProject ----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.updateProject', async () => {
      const ws = getActiveWorkspaceRoot();
      if (!ws) {
        vscode.window.showErrorMessage('SpecGuard: no workspace folder open.');
        return;
      }
      await forceUpdateProjectFiles(context, ws);
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight language detection for the init command.
 * Checks the existing SpecGuard config first (preserves user's choice), then
 * falls back to marker-file detection. Returns 'typescript' as the default so
 * the CLI's own detectLanguage (which also checks plan-file heuristics) can
 * refine further if needed.
 */
function detectWorkspaceLanguage(workspaceRoot: string): string {
  // 1. Respect an existing config's language declaration
  const configPath = path.join(workspaceRoot, '.specguard', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        apps?: Array<{ language?: string }>;
      };
      const lang = cfg.apps?.[0]?.language;
      if (lang) return lang;
    } catch { /* fall through */ }
  }
  // 2. Marker files — mirrors the CLI's DETECTION_PRIORITY order
  if (['pyproject.toml', 'setup.py', 'requirements.txt'].some((f) => fs.existsSync(path.join(workspaceRoot, f)))) return 'python';
  if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) return 'rust';
  if (['pom.xml', 'build.gradle', 'build.gradle.kts'].some((f) => fs.existsSync(path.join(workspaceRoot, f)))) return 'java';
  return 'typescript';
}

async function resolveCliPath(workspaceRoot: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('specguard');
  const custom = config.get<string>('cliPath', '');
  if (custom) return custom;
  const local = path.join(workspaceRoot, 'node_modules', '.bin', 'specguard');
  return fs.existsSync(local) ? local : 'npx specguard';
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
