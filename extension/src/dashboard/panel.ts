import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DashboardHost } from './host.js';
import type { DashboardEvent, DashboardCommand } from './protocol.js';
import { getActiveWorkspaceRoot } from '../workspace-state.js';
import { checkAndOfferUpdate } from '../project-updater.js';

let panel: vscode.WebviewPanel | undefined;
let currentHost: DashboardHost | undefined;
/** Stored context so openAndRun can open the panel if needed. */
let _context: vscode.ExtensionContext | undefined;

export function openDashboardPanel(context: vscode.ExtensionContext): void {
  _context = context;
  const workspaceRoot = getActiveWorkspaceRoot();
  if (!workspaceRoot) { vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.'); return; }

  // If the panel is already open for a different root, close and reopen
  if (panel) {
    if (currentHost?.workspaceRoot === workspaceRoot) {
      panel.reveal();
      return;
    }
    // Different project — dispose the old one
    panel.dispose();
  }

  const mediaUri = vscode.Uri.file(path.join(context.extensionPath, 'media'));
  panel = vscode.window.createWebviewPanel('specguard.dashboard', 'SpecGuard Dashboard', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaUri],
  });

  const host = new DashboardHost((e: DashboardEvent) => panel?.webview.postMessage(e), workspaceRoot);
  currentHost = host;
  panel.webview.html = renderHtml(panel.webview, context.extensionPath);
  context.subscriptions.push(
    panel.webview.onDidReceiveMessage((msg: DashboardCommand) => void host.handle(msg)),
  );
  host.start();

  // Run project file check (AGENTS.md, Cursor skill) whenever a new workspace is loaded.
  // Non-blocking; checkAndOfferUpdate is idempotent — it skips if already up-to-date.
  setTimeout(() => void checkAndOfferUpdate(context, workspaceRoot), 1_500);

  panel.onDidDispose(() => { host.dispose(); panel = undefined; currentHost = undefined; }, null, context.subscriptions);
}

/**
 * Open the dashboard (creating it if needed), navigate to the Pipelines tab,
 * scroll to the given pipeline card, and trigger a run.
 *
 * Called from sidebar pipeline commands so the run is visible in the dashboard
 * rather than buried in a terminal.
 */
export async function openAndRun(
  context: vscode.ExtensionContext,
  pipeline: string,
  args?: string[],
): Promise<void> {
  _context = context;
  const workspaceRoot = getActiveWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.');
    return;
  }

  // Open or reveal the panel.
  if (!panel || currentHost?.workspaceRoot !== workspaceRoot) {
    openDashboardPanel(context);
  } else {
    panel?.reveal();
  }

  // Small delay so the webview has time to mount before we post messages.
  await new Promise<void>((r) => setTimeout(r, 200));

  // Navigate to the Pipelines tab and scroll to the card.
  panel?.webview.postMessage({ type: 'navigate', tab: 'flow', scrollTo: pipeline });

  // Trigger the run via the host (same path as clicking Run in the UI).
  await currentHost?.handle({ type: 'run', pipeline, args });
}

function renderHtml(webview: vscode.Webview, extPath: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extPath, 'media', 'main.js')));
  const cssPath = path.join(extPath, 'media', 'main.css');
  const cssTag = fs.existsSync(cssPath)
    ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(cssPath))}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
${cssTag}</head><body><div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}
