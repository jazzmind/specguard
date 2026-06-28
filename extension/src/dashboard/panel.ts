import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DashboardHost } from './host.js';
import type { DashboardEvent, DashboardCommand } from './protocol.js';

let panel: vscode.WebviewPanel | undefined;

export function openDashboardPanel(context: vscode.ExtensionContext): void {
  if (panel) { panel.reveal(); return; }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.'); return; }

  const mediaUri = vscode.Uri.file(path.join(context.extensionPath, 'media'));
  panel = vscode.window.createWebviewPanel('specguard.dashboard', 'SpecGuard Dashboard', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaUri],
  });

  const host = new DashboardHost((e: DashboardEvent) => panel?.webview.postMessage(e), workspaceRoot);
  panel.webview.html = renderHtml(panel.webview, context.extensionPath);
  panel.webview.onDidReceiveMessage((msg: DashboardCommand) => void host.handle(msg));
  host.start();

  panel.onDidDispose(() => { host.dispose(); panel = undefined; }, null, context.subscriptions);
}

function renderHtml(webview: vscode.Webview, extPath: string): string {
  const nonce = String(Date.now()) + Math.round(Math.abs(Math.sin(Date.now())) * 1e6);
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extPath, 'media', 'main.js')));
  const cssPath = path.join(extPath, 'media', 'main.css');
  const cssTag = fs.existsSync(cssPath)
    ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(cssPath))}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
${cssTag}</head><body><div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}
