import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getActiveWorkspaceRoot, getWorkspaceManifestRoot } from './workspace-state.js';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';
import { prepareReportHtml, resolveReportLink } from './report-html.js';

const REPORT_REL = path.join('.specguard', 'report', 'workspace');
let panel: vscode.WebviewPanel | undefined;
let state: { root: string; reportDir: string; history: string[]; current: string } | undefined;

/** Where the workspace report lives: beside the workspace manifest when there is one, else in the active project. */
function reportTarget(): { root: string; reportDir: string; workspace: boolean } | undefined {
  const manifestRoot = getWorkspaceManifestRoot();
  if (manifestRoot) return { root: manifestRoot, reportDir: path.join(manifestRoot, REPORT_REL), workspace: true };
  const active = getActiveWorkspaceRoot();
  return active ? { root: active, reportDir: path.join(active, '.specguard', 'report'), workspace: false } : undefined;
}

export async function rebuildReport(context: vscode.ExtensionContext): Promise<boolean> {
  const target = reportTarget();
  if (!target) { void vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.'); return false; }
  const cli = await resolveCliPath(target.root);
  const args = target.workspace ? ['report', '--workspace', target.root] : ['report'];
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SpecGuard: building report', cancellable: false }, async () => {
    const lines: string[] = [];
    try {
      const code = await spawnCli(cli, args, target.root, (l) => lines.push(l)).promise;
      if (code !== 0) { void vscode.window.showErrorMessage(`SpecGuard report failed (exit ${code}): ${lines.slice(-3).join(' | ')}`); return false; }
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(`SpecGuard report failed: ${(err as Error).message}`);
      return false;
    }
  });
}

export async function openReportPanel(context: vscode.ExtensionContext, opts: { rebuild?: boolean } = {}): Promise<void> {
  const target = reportTarget();
  if (!target) { void vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.'); return; }
  const index = path.join(target.reportDir, 'index.html');
  if (opts.rebuild || !fs.existsSync(index)) {
    if (!(await rebuildReport(context))) return;
  }
  if (!fs.existsSync(index)) { void vscode.window.showWarningMessage('SpecGuard: no report was produced (record a run with `specguard results ingest`).'); return; }

  if (panel && state?.reportDir === target.reportDir) {
    state.history = [];
    show('index.html', false);
    panel.reveal();
    return;
  }
  panel?.dispose();
  panel = vscode.window.createWebviewPanel('specguard.report', 'SpecGuard Report', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(target.reportDir)],
  });
  state = { root: target.root, reportDir: target.reportDir, history: [], current: 'index.html' };
  panel.onDidDispose(() => { panel = undefined; state = undefined; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(async (msg: { type: string; href?: string }) => {
    if (!state || !panel) return;
    switch (msg.type) {
      case 'back': { const prev = state.history.pop(); if (prev) show(prev, false); break; }
      case 'home': show('index.html', true); break;
      case 'rebuild': if (await rebuildReport(context)) show(state.current, false); break;
      case 'browser': void vscode.env.openExternal(vscode.Uri.file(path.join(state.reportDir, state.current))); break;
      case 'open': if (msg.href) await openLink(msg.href); break;
    }
  }, undefined, context.subscriptions);
  show('index.html', false);
}

function show(rel: string, push: boolean): void {
  if (!panel || !state) return;
  const abs = path.join(state.reportDir, rel);
  if (!fs.existsSync(abs)) { void vscode.window.showWarningMessage(`SpecGuard: ${rel} is missing; rebuild the report.`); return; }
  if (push && state.current !== rel) state.history.push(state.current);
  state.current = rel;
  const nonce = crypto.randomBytes(16).toString('base64');
  const baseDir = vscode.Uri.file(path.dirname(abs));
  panel.title = rel === 'index.html' ? 'SpecGuard Report' : `SpecGuard Report: ${rel.replace(/\/index\.html$/, '')}`;
  panel.webview.html = prepareReportHtml(fs.readFileSync(abs, 'utf8'), {
    baseHref: panel.webview.asWebviewUri(baseDir).toString(),
    cspSource: panel.webview.cspSource,
    nonce,
    canGoBack: state.history.length > 0,
    isHome: rel === 'index.html',
  });
}

async function openLink(href: string): Promise<void> {
  if (!state) return;
  const target = resolveReportLink(href, state.current, state.reportDir);
  if (!target) return;
  if (target.kind === 'page') { show(target.rel, true); return; }
  if (target.kind === 'external') { void vscode.env.openExternal(vscode.Uri.parse(target.url)); return; }
  if (!fs.existsSync(target.abs)) { void vscode.window.showWarningMessage(`SpecGuard: file not found: ${target.abs}`); return; }
  if (target.ext === 'zip') {
    const pick = await vscode.window.showInformationMessage('Playwright trace', { modal: false }, 'Open in trace viewer', 'Reveal in Finder');
    if (pick === 'Open in trace viewer') {
      const term = vscode.window.createTerminal({ name: 'Playwright trace', cwd: state.root });
      term.show();
      term.sendText(`npx playwright show-trace ${JSON.stringify(target.abs)}`);
    } else if (pick) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target.abs));
    return;
  }
  if (target.ext === 'html' || target.ext === 'htm') { void vscode.env.openExternal(vscode.Uri.file(target.abs)); return; }
  void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.abs));
}
