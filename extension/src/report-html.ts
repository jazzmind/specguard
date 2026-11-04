/**
 * Prepares a static SpecGuard report page (written by `specguard report [--workspace]`) to run inside a VS Code webview.
 * Pure string work, no `vscode` import, so it can be unit tested.
 *
 *  - `<base href>` points at the page's folder as a webview URI, so the report's relative images, video and links resolve.
 *  - A CSP allows only the extension's resource origin, inline styles and nonce'd scripts (the report's own inline filter
 *    script gets the nonce; nothing else may run).
 *  - A bridge script turns every link click into a message to the extension (page navigation, files, traces) and keeps
 *    in-page `#anchors` working despite the `<base>`.
 *  - A small toolbar adds Back / Workspace / Rebuild / Open in browser.
 */
export interface PreparedReport {
  html: string;
}

export function prepareReportHtml(raw: string, opts: { baseHref: string; cspSource: string; nonce: string; canGoBack: boolean; isHome: boolean }): string {
  const { baseHref, cspSource, nonce } = opts;
  const csp = `default-src 'none'; img-src ${cspSource} data:; media-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`;
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${baseHref.endsWith('/') ? baseHref : `${baseHref}/`}">`;
  // Drop any CSP/base the page brought; ours must be the only ones.
  let html = raw.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '');
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : `<head>${head}</head>${html}`;
  html = html.replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
  const bar = `<div id="sg-bar" style="position:sticky;top:0;z-index:9;display:flex;gap:8px;align-items:center;padding:6px 12px;margin:-24px -24px 16px;background:var(--chip,#eef1f6);border-bottom:1px solid var(--line,#d9dde5)">
<button data-sg="back"${opts.canGoBack ? '' : ' disabled'}>&larr; Back</button><button data-sg="home"${opts.isHome ? ' disabled' : ''}>Workspace</button><button data-sg="rebuild">Rebuild report</button><button data-sg="browser">Open in browser</button></div>`;
  const bridge = `<script nonce="${nonce}">(function(){var vs=acquireVsCodeApi();
document.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('button[data-sg]'); if(b){vs.postMessage({type:b.getAttribute('data-sg')});return;}
  var a=e.target.closest&&e.target.closest('a'); if(!a)return; var h=a.getAttribute('href'); if(!h)return; e.preventDefault();
  if(h.charAt(0)==='#'){var el=document.getElementById(h.slice(1)); if(el)el.scrollIntoView(); return;}
  vs.postMessage({type:'open',href:h});
});})();</script>`;
  html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => `${m}${bar}`) : `${bar}${html}`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${bridge}</body>`) : `${html}${bridge}`;
}

export type LinkTarget = { kind: 'page'; rel: string } | { kind: 'file'; abs: string; ext: string } | { kind: 'external'; url: string };

/**
 * Where a clicked link goes. `currentRel` is the open page relative to the report root (posix). Relative links resolve
 * against that page; anything that would leave the report root is refused (null).
 */
export function resolveReportLink(href: string, currentRel: string, rootAbs: string): LinkTarget | null {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href };
  if (/^file:\/\//i.test(href)) {
    let p: string;
    try { p = decodeURIComponent(new URL(href).pathname); } catch { return null; }
    return { kind: 'file', abs: p, ext: p.slice(p.lastIndexOf('.') + 1).toLowerCase() };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const clean = href.split('#')[0].split('?')[0];
  if (!clean) return null;
  const stack = currentRel.split('/').slice(0, -1);
  for (const part of decodeURIComponent(clean).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (stack.length === 0) return null; stack.pop(); } else stack.push(part);
  }
  const rel = stack.join('/');
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'html' || ext === 'htm') return { kind: 'page', rel };
  const root = rootAbs.replace(/\/+$/, '');
  return { kind: 'file', abs: `${root}/${rel}`, ext };
}
