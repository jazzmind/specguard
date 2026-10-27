import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { collectOutputs, type OutputKind } from './output-inventory.js';
import { configDirFor } from './project-config.js';
import { getHub } from './api/shared.js';
import type { ApiClient } from './api/client.js';

interface Entry { title: string; detail: string; path?: string; remote?: { client: ApiClient; route: string }; }
const names = { specs: 'Specs', tests: 'Tests', docs: 'Docs' };
const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** A searchable inventory, with editor links rather than Finder folder links. */
export async function openOutputs(root: string, kind: OutputKind): Promise<void> {
  const panel = vscode.window.createWebviewPanel('specguard.outputs', `${names[kind]} — ${path.basename(root)}`, vscode.ViewColumn.Active, { enableScripts: true });
  const entries: Entry[] = [];
  panel.webview.html = outputHtml(names[kind], [], 'Loading…');
  try {
    entries.push(...(await collectOutputs(kind, root, configDirFor(root))).map((f) => ({ title: f.title, detail: f.relativePath, path: f.path })));
    let notice = '';
    if (kind !== 'tests') try {
      const live = await getHub()?.get(root);
      if (live?.source === 'server') {
        if (kind === 'docs') {
          const data = await live.client.get<{ documents: Array<{ id: string; title: string; audiences: string[] }> }>('/docs');
          for (const doc of data.documents) for (const audience of doc.audiences) entries.push({ title: `${doc.title} · ${audience}`, detail: `Team server · ${live.project ?? path.basename(root)}`, remote: { client: live.client, route: `/docs/${encodeURIComponent(audience)}/${encodeURIComponent(doc.id)}` } });
        } else {
          const data = await live.client.get<{ specs: Array<{ id: string; title: string }> }>('/specs');
          for (const spec of data.specs) entries.push({ title: spec.title, detail: 'Team server', remote: { client: live.client, route: `/specs/${encodeURIComponent(spec.id)}` } });
        }
      } else if (live?.notice) notice = live.notice;
    } catch {
      notice = 'Team-server documents could not be loaded. Local files are shown.';
    }
    panel.webview.html = outputHtml(names[kind], entries, notice);
  } catch (error) {
    panel.webview.html = outputHtml(names[kind], entries, `Could not read outputs: ${(error as Error).message}`);
  }
  panel.webview.onDidReceiveMessage(async (msg: { type?: string; index?: number }) => {
    if (msg.type !== 'open' || !Number.isInteger(msg.index)) return;
    const entry = entries[msg.index!];
    if (!entry) return;
    try {
      if (entry.path) await vscode.window.showTextDocument(vscode.Uri.file(entry.path), { preview: true });
      else if (entry.remote) {
        const result = await entry.remote.client.get<{ markdown: string }>(entry.remote.route);
        if (typeof result.markdown !== 'string') throw new Error('the server returned no Markdown content');
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: result.markdown });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    } catch (error) { void vscode.window.showErrorMessage(`Could not open ${entry.title}: ${(error as Error).message}`); }
  });
}

export function outputHtml(title: string, entries: Array<{ title: string; detail: string }>, notice = ''): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
body{font:var(--vscode-font-size,13px) var(--vscode-font-family,sans-serif);background:var(--vscode-editor-background);color:var(--vscode-foreground);padding:20px;max-width:1000px;margin:auto}input{width:100%;padding:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);margin:10px 0 20px}button{display:block;text-align:left;width:100%;font:inherit;padding:12px;margin-bottom:6px;cursor:pointer;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);color:var(--vscode-foreground)}button:hover,button:focus{border-color:var(--vscode-focusBorder)}small{display:block;margin-top:5px;color:var(--vscode-descriptionForeground)}[hidden]{display:none}</style></head><body><h1>${escape(title)} <small>${entries.length} entries</small></h1>${notice ? `<p role="status">${escape(notice)}</p>` : ''}<label for="filter">Filter by title or path</label><input id="filter" type="search" placeholder="Search ${escape(title.toLowerCase())}"><div id="entries">${entries.map((e, i) => `<button data-index="${i}">${escape(e.title)}<small>${escape(e.detail)}</small></button>`).join('')}</div><p id="empty" ${entries.length ? 'hidden' : ''}>No matching ${escape(title.toLowerCase())} found.</p><script nonce="${nonce}">const api=acquireVsCodeApi();const rows=[...document.querySelectorAll('button[data-index]')];document.getElementById('filter').addEventListener('input',e=>{const q=e.target.value.toLowerCase();rows.forEach(r=>r.hidden=!r.textContent.toLowerCase().includes(q));document.getElementById('empty').hidden=rows.some(r=>!r.hidden)});document.getElementById('entries').addEventListener('click',e=>{const b=e.target.closest('button[data-index]');if(b)api.postMessage({type:'open',index:Number(b.dataset.index)})});</script></body></html>`;
}
