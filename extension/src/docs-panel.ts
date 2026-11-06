/**
 * The "SpecGuard Docs" panel: the shipped documentation rendered in a webview, with a table of contents,
 * in-panel navigation and external links opened through the host.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  groupPages, initDocs, INDEX_FILE, loadManifest, readPage, renderMarkdown, resolveTopic, type DocTarget,
} from './docs-content.js';

let panel: vscode.WebviewPanel | undefined;
let currentFile = INDEX_FILE;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page HTML for a target: TOC from the manifest and the rendered page. Exported for tests. */
export function buildDocsHtml(target: DocTarget, cspSource: string, nonce: string): string {
  const manifest = loadManifest();
  const source = readPage(target.file, manifest);
  const file = source === undefined ? INDEX_FILE : target.file;
  const body = source === undefined
    ? renderMarkdown(readPage(INDEX_FILE, manifest) ?? '# SpecGuard documentation\n\nThe documentation is not available in this build.', INDEX_FILE)
    : renderMarkdown(source, target.file);
  const toc = groupPages(manifest).map((g) => `<div class="grp">${esc(g.group)}</div>` +
    g.pages.map((p) => `<a href="#" data-kind="page" data-file="${esc(p.file)}" class="${p.file === file ? 'cur' : ''}">${esc(p.title)}</a>`).join('')).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; display: flex; height: 100vh; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  nav { width: 260px; flex: none; overflow-y: auto; padding: 12px; border-right: 1px solid var(--vscode-panel-border); box-sizing: border-box; }
  nav a { display: block; padding: 3px 6px; border-radius: 3px; color: var(--vscode-foreground); text-decoration: none; font-size: 12px; }
  nav a:hover { background: var(--vscode-list-hoverBackground); }
  nav a.cur { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  nav .grp { margin: 12px 0 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  nav .home { font-weight: 600; }
  main { flex: 1; overflow-y: auto; padding: 8px 32px 48px; max-width: 880px; line-height: 1.55; }
  main a { color: var(--vscode-textLink-foreground); }
  main pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow-x: auto; border-radius: 4px; }
  main code { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; }
  main table { border-collapse: collapse; } main th, main td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .nav-btns { display: flex; gap: 4px; margin-bottom: 8px; }
  .nav-btns button { background: none; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); border-radius: 3px; cursor: pointer; }
</style></head><body>
<nav><div class="nav-btns"><button data-nav="back" title="Back" aria-label="Back">&larr;</button><button data-nav="forward" title="Forward" aria-label="Forward">&rarr;</button></div>
<a href="#" data-kind="page" data-file="${INDEX_FILE}" class="home${file === INDEX_FILE ? ' cur' : ''}">Documentation home</a>${toc}</nav>
<main id="content">${body}</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const anchor = ${JSON.stringify(target.anchor ?? '')};
  function scrollToAnchor(id) {
    const el = id && document.getElementById(id);
    if (el) el.scrollIntoView(); else document.getElementById('content').scrollTop = 0;
  }
  scrollToAnchor(anchor);
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { vscode.postMessage({ type: 'history', direction: nav.dataset.nav }); return; }
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const d = a.dataset;
    if (d.kind === 'external') vscode.postMessage({ type: 'external', url: d.url });
    else if (d.kind === 'page') vscode.postMessage({ type: 'open', file: d.file, anchor: d.anchor || '' });
    else if (d.kind === 'anchor') scrollToAnchor(d.anchor);
  });
</script></body></html>`;
}

const back: DocTarget[] = [];
const forward: DocTarget[] = [];
let shown: DocTarget | undefined;

function show(target: DocTarget, record = true): void {
  if (!panel) return;
  if (record && shown) { back.push(shown); forward.length = 0; }
  shown = target;
  currentFile = target.file;
  panel.webview.html = buildDocsHtml(target, panel.webview.cspSource, crypto.randomBytes(16).toString('base64'));
}

/** Open the docs panel at a topic: a help key, `page.md#anchor`, or nothing / unknown for the index. */
export function openDocs(context: vscode.ExtensionContext, topic?: string): void {
  const target = resolveTopic(topic);
  if (panel) {
    panel.reveal();
    show(target);
    return;
  }
  initDocs(context.extensionPath);
  panel = vscode.window.createWebviewPanel('specguard.docs', 'SpecGuard Docs', vscode.ViewColumn.Active, { enableScripts: true });
  panel.onDidDispose(() => { panel = undefined; shown = undefined; back.length = 0; forward.length = 0; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage((msg: { type?: string; file?: string; anchor?: string; url?: string; direction?: string }) => {
    if (msg.type === 'external' && typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
      void vscode.env.openExternal(vscode.Uri.parse(msg.url));
    } else if (msg.type === 'open' && typeof msg.file === 'string') {
      show(resolveTopic(msg.anchor ? `${msg.file}#${msg.anchor}` : msg.file));
    } else if (msg.type === 'history') {
      const to = msg.direction === 'back' ? back.pop() : forward.pop();
      if (to && shown) { (msg.direction === 'back' ? forward : back).push(shown); show(to, false); }
    }
  }, null, context.subscriptions);
  show(target);
}

export function registerDocsCommands(context: vscode.ExtensionContext): void {
  initDocs(context.extensionPath);
  context.subscriptions.push(vscode.commands.registerCommand('specguard.openDocs', (topic?: unknown) => openDocs(context, typeof topic === 'string' ? topic : undefined)));
}

/** The file currently shown, for tests and status. */
export function currentDocsFile(): string { return currentFile; }
