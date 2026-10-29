/**
 * The web UI served at `/`: one self-contained page, no build step. It renders
 * from the API only, so any other viewer can do the same.
 *
 * Docs come from a model, so the markdown renderer escapes all HTML first and
 * only emits tags it builds itself. The embedded script avoids backticks and
 * template placeholders so it can live in a raw template string.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
const UI_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="sg-base" content="__BASE__">
<title>SpecGuard</title>
<style>
  :root { --fg:#1d2733; --muted:#5b6b7c; --line:#dde3ea; --bg:#f6f8fa; --card:#fff; --accent:#1f5fbf; --ok:#1a7f4b; --warn:#a15c00; --bad:#b3261e; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  header { background:var(--card); border-bottom:1px solid var(--line); padding:10px 20px; display:flex; gap:20px; align-items:center; }
  header h1 { font-size:16px; margin:0; } header a { color:var(--muted); text-decoration:none; } header a.on { color:var(--accent); font-weight:600; }
  #layout { display:flex; min-height:calc(100vh - 47px); }
  nav { width:270px; flex:none; border-right:1px solid var(--line); background:var(--card); padding:12px 0; overflow:auto; }
  nav a { display:block; padding:6px 20px; color:var(--fg); text-decoration:none; font-size:14px; } nav a:hover { background:var(--bg); } nav a.on { background:#e8f0fb; color:var(--accent); font-weight:600; }
  nav .sub { padding:10px 20px 4px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
  main { flex:1; padding:24px 32px; max-width:1100px; min-width:0; }
  h2 { margin:0 0 4px; font-size:24px; } .value { color:var(--muted); margin:0 0 16px; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin:16px 0; flex-wrap:wrap; }
  .tabs button { border:0; background:none; padding:8px 14px; cursor:pointer; font:inherit; color:var(--muted); border-bottom:2px solid transparent; }
  .tabs button.on { color:var(--accent); border-bottom-color:var(--accent); font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px 20px; margin:12px 0; }
  .badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; background:#eef1f5; color:var(--muted); margin-right:6px; }
  .proven { background:#e3f4ea; color:var(--ok); } .failed,.error { background:#fbe7e5; color:var(--bad); } .stale,.unexercised { background:#fff1dc; color:var(--warn); }
  table { border-collapse:collapse; width:100%; font-size:14px; background:var(--card); } th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; }
  code { background:#eef1f5; padding:1px 5px; border-radius:4px; font-size:13px; } pre { background:#1d2733; color:#eaf0f6; padding:12px 14px; border-radius:6px; overflow:auto; } pre code { background:none; padding:0; color:inherit; }
  .doc h1 { font-size:22px; } .doc h2 { font-size:18px; margin-top:22px; } .doc h3 { font-size:16px; } .doc blockquote { border-left:3px solid var(--line); margin:8px 0; padding:0 12px; color:var(--muted); }
  .meta { color:var(--muted); font-size:13px; margin-bottom:8px; } .warn { color:var(--warn); } .err { color:var(--bad); }
  ul.plain { padding-left:18px; margin:6px 0; }
</style>
</head>
<body>
<header><h1>SpecGuard</h1><a href="#/matrix" id="t-matrix">Traceability</a><a href="#/audit" id="t-audit">Audit</a><a href="#/tokens" id="t-tokens">Tokens</a><span id="project-slot" style="margin-left:auto"></span></header>
<div id="layout"><nav id="nav">Loading…</nav><main id="main"></main></div>
<script>
var BASE = document.querySelector('meta[name="sg-base"]').getAttribute('content');
var API = BASE + '/api/v1';
var FENCE = '\x60\x60\x60';
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function get(p) {
  return fetch(API + p).then(function (r) {
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
  });
}
function badge(text, cls) { return '<span class="badge ' + (cls || '') + '">' + esc(text) + '</span>'; }

/* ---- markdown: escape first, then build only our own tags ---- */
function inline(s) {
  s = esc(s);
  s = s.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (all, text, url) {
    return /^(https?:\/\/|\/|#)/.test(url) ? '<a href="' + url + '">' + text + '</a>' : all;
  });
  return s;
}
function md(src) {
  var lines = String(src).split(/\r?\n/), out = [], i = 0;
  while (i < lines.length) {
    var line = lines[i], m;
    if (line.indexOf(FENCE) === 0) {
      var code = []; i++;
      while (i < lines.length && lines[i].indexOf(FENCE) !== 0) { code.push(lines[i]); i++; }
      i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      var ul = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { ul.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; }
      out.push('<ul>' + ul.join('') + '</ul>'); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      var ol = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { ol.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; }
      out.push('<ol>' + ol.join('') + '</ol>'); continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      var cells = function (l) { return l.replace(/^\||\|\s*$/g, '').split('|').map(function (c) { return inline(c.trim()); }); };
      var head = cells(line); i += 2; var rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table><tr>' + head.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>' +
        rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>');
      continue;
    }
    if (/^>\s?/.test(line)) { out.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>'); i++; continue; }
    if (/^\s*$/.test(line)) { i++; continue; }
    var para = [line]; i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|>|\|)/.test(lines[i]) && lines[i].indexOf(FENCE) !== 0) { para.push(lines[i]); i++; }
    out.push('<p>' + inline(para.join(' ')) + '</p>');
  }
  return out.join('\n');
}

/* ---- views ---- */
var main = document.getElementById('main'), nav = document.getElementById('nav');
function show(html) { main.innerHTML = html; }
function fail(e) { show('<p class="err">' + esc(e.message) + '</p>'); }

function buildNav(caps, current) {
  var h = '<a href="#/system"' + (current === 'system' ? ' class="on"' : '') + '>Overview</a><div class="sub">Capabilities</div>';
  caps.forEach(function (c) {
    h += '<a href="#/cap/' + encodeURIComponent(c.id) + '"' + (current === c.id ? ' class="on"' : '') + '>' + esc(c.title) + '</a>';
  });
  nav.innerHTML = h;
  document.getElementById('t-matrix').className = current === '#matrix' ? 'on' : '';
  document.getElementById('t-audit').className = current === '#audit' ? 'on' : '';
  document.getElementById('t-tokens').className = current === '#tokens' ? 'on' : '';
}

function countsLine(c) {
  return badge(c.claims + ' requirements') + badge(c.proven + ' proven', c.proven ? 'proven' : '') +
    (c.stale ? badge(c.stale + ' stale', 'stale') : '') + (c.failed ? badge(c.failed + ' failed', 'failed') : '') + badge(c.unproven + ' unproven');
}

function docPane(audience, id, target) {
  target.innerHTML = '<p class="meta">Generating…</p>';
  get('/docs/' + audience + '/' + encodeURIComponent(id)).then(function (d) {
    var note = d.cached ? 'cached' : d.generated ? 'generated just now' : 'rendered from the spec';
    target.innerHTML = '<div class="meta">' + esc(note) + (d.warning ? ' · <span class="warn">' + esc(d.warning) + '</span>' : '') + '</div><div class="doc">' + md(d.markdown) + '</div>';
  }).catch(function (e) { target.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
}

function tabs(id, labels, render) {
  var bar = '<div class="tabs">' + labels.map(function (l, n) { return '<button data-n="' + n + '"' + (n === 0 ? ' class="on"' : '') + '>' + esc(l[1]) + '</button>'; }).join('') + '</div><div id="pane"></div>';
  main.insertAdjacentHTML('beforeend', bar);
  var pane = document.getElementById('pane');
  function pick(n) {
    Array.prototype.forEach.call(main.querySelectorAll('.tabs button'), function (b) { b.className = Number(b.getAttribute('data-n')) === n ? 'on' : ''; });
    render(labels[n][0], pane);
  }
  Array.prototype.forEach.call(main.querySelectorAll('.tabs button'), function (b) { b.onclick = function () { pick(Number(b.getAttribute('data-n'))); }; });
  pick(0);
}

function viewSystem(caps) {
  get('/system').then(function (s) {
    buildNav(caps, 'system');
    var sys = s.system || { title: 'System', value: '' };
    show('<h2>' + esc(sys.title) + '</h2><p class="value">' + esc(sys.value) + '</p>' + countsLine(s.totals));
    tabs('system', [['guide-user', 'User guide'], ['guide-dev', 'Developer guide'], ['capabilities', 'Capabilities']], function (which, pane) {
      if (which === 'guide-user') return docPane('user', 'system', pane);
      if (which === 'guide-dev') return docPane('dev', 'system', pane);
      pane.innerHTML = '<table><tr><th>Capability</th><th>Value</th><th>Status</th><th>Proof</th></tr>' + s.capabilities.map(function (c) {
        return '<tr><td><a href="#/cap/' + encodeURIComponent(c.id) + '">' + esc(c.title) + '</a></td><td>' + esc(c.value) + '</td><td>' + badge(c.status) + '</td><td>' + countsLine(c.counts) + '</td></tr>';
      }).join('') + '</table>';
    });
  }).catch(fail);
}

function viewCapability(id, caps) {
  get('/capabilities/' + encodeURIComponent(id)).then(function (c) {
    buildNav(caps, id);
    show('<h2>' + esc(c.title) + '</h2><p class="value">' + esc(c.value) + '</p>' + badge(c.kind) + badge(c.status) + countsLine(c.counts) +
      '<div class="meta">' + c.files + ' source files · ' + c.tests + ' test files</div>');
    tabs(id, [['user', 'User docs'], ['dev', 'Developer docs'], ['agent', 'Agent brief'], ['reqs', 'Requirements'], ['history', 'History']], function (which, pane) {
      if (which === 'user' || which === 'dev' || which === 'agent') return docPane(which, id, pane);
      if (which === 'history') {
        pane.innerHTML = '<p class="meta">Loading…</p>';
        return get('/capabilities/' + encodeURIComponent(id) + '/history').then(function (h) {
          pane.innerHTML = h.entries.length === 0 ? '<p class="meta">No recorded history.</p>' : h.entries.map(function (e) {
            return '<div class="card"><strong>' + esc(e.title || e.id) + '</strong><div class="meta">' + esc(e.date) + ' · ' + esc(e.kind) + (e.author ? ' · ' + esc(e.author) : '') + '</div></div>';
          }).join('');
        }).catch(function (e) { pane.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
      }
      pane.innerHTML = '<table><tr><th>Requirement</th><th>Proof</th><th>Tests</th></tr>' + c.claims.map(function (q) {
        return '<tr><td><code>' + esc(q.id) + '</code><br>' + esc(q.text) + '</td><td>' + badge(q.proof, q.proof) + '</td><td>' +
          (q.tests.length ? q.tests.map(function (t) { return '<code>' + esc(t.file) + '</code>'; }).join('<br>') : '<span class="meta">none</span>') + '</td></tr>';
      }).join('') + '</table>';
    });
  }).catch(fail);
}

function viewMatrix(caps) {
  get('/trace').then(function (t) {
    buildNav(caps, '#matrix');
    var rows = [];
    t.nodes.forEach(function (n) { n.claims.forEach(function (q) { rows.push('<tr><td>' + esc(n.title) + '</td><td><code>' + esc(q.id) + '</code> ' + esc(q.text) + '</td><td>' + badge(q.proof, q.proof) + '</td><td>' + esc(q.tests.map(function (x) { return x.file; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ')) + '</td><td>' + esc(n.docs.join(', ')) + '</td></tr>'); }); });
    show('<h2>Traceability</h2><p class="value">Every requirement, the tests that cite it, its proof, and the docs of its capability.</p><table><tr><th>Capability</th><th>Requirement</th><th>Proof</th><th>Tests</th><th>Docs</th></tr>' + rows.join('') + '</table>');
  }).catch(fail);
}

function list(title, items, cls) {
  return '<div class="card"><strong>' + esc(title) + '</strong> ' + badge(String(items.length), items.length ? cls : '') +
    (items.length ? '<ul class="plain">' + items.slice(0, 60).map(function (x) { return '<li><code>' + esc(typeof x === 'string' ? x : (x.code ? x.code + ': ' + x.message : JSON.stringify(x))) + '</code></li>'; }).join('') + '</ul>' : '') + '</div>';
}
function viewAudit(caps) {
  get('/audit').then(function (a) {
    buildNav(caps, '#audit');
    show('<h2>Audit</h2><p class="value">Where the system and its specs disagree.</p>' + countsLine(a.totals) +
      list('Source files no spec owns', a.unowned, 'failed') + list('Spec rule violations', a.issues, 'failed') +
      list('Stale proofs', a.stale, 'stale') + list('Failed proofs', a.failed, 'failed') + list('Requirements no test cites', a.untestedClaims, 'stale') +
      list('Capabilities without tests', a.noTests, 'stale') + list('Capabilities whose sources match no files', a.noSources, 'stale') +
      list('Code changed without recorded intent', a.intentGaps.map(function (g) { return g.id + ' (code ' + g.codeDate + ', intent ' + (g.intentDate || 'none') + ')'; }), 'stale'));
  }).catch(fail);
}

/* ---- tokens: the team server's own, never project-prefixed ---- */
function send(method, path, body) {
  var init = { method: method, headers: { 'X-Requested-With': 'specguard' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return fetch(BASE + '/api/v1' + path, init).then(function (r) {
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
  });
}
function viewTokens(caps) {
  buildNav(caps, '#tokens');
  fetch(BASE + '/api/v1/tokens').then(function (r) {
    if (r.status === 404 || r.status === 405) { show('<h2>Tokens</h2><p class="value">Tokens are issued by a team server. This server only shows one project from a working tree.</p>'); return null; }
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
  }).then(function (j) {
    if (!j) return;
    var rows = j.tokens.map(function (t) {
      return '<tr><td>' + esc(t.name) + '</td><td>' + badge(t.role) + (t.project ? badge(t.project) : '') + '</td><td>' + esc(t.createdAt) + '</td><td>' + esc(t.lastUsedAt || 'never') + '</td><td>' +
        (t.revokedAt ? badge('revoked', 'failed') : '<button data-revoke="' + esc(t.id) + '">Revoke</button>') + '</td></tr>';
    }).join('');
    show('<h2>Tokens</h2><p class="value">A token lets the command line, the editor extension or an agent act as you. Give it to <code>specguard login</code>. It is shown once.</p>' +
      '<div class="card"><strong>Create a token</strong><p><input id="tk-name" placeholder="name, for example laptop" maxlength="64"> ' +
      '<select id="tk-role"><option value="viewer">viewer (read)</option><option value="maintainer" selected>maintainer (read and change plans)</option></select> ' +
      '<input id="tk-project" placeholder="limit to one project (optional)"> <button id="tk-create">Create</button></p><div id="tk-out"></div></div>' +
      '<table><tr><th>Name</th><th>Access</th><th>Created</th><th>Last used</th><th></th></tr>' + (rows || '<tr><td colspan="5" class="meta">No tokens yet.</td></tr>') + '</table>');
    document.getElementById('tk-project').value = new URLSearchParams(location.search).get('project') || '';
    document.getElementById('tk-role').value = 'viewer';
    document.getElementById('tk-create').onclick = function () {
      var body = { name: document.getElementById('tk-name').value, role: document.getElementById('tk-role').value };
      var proj = document.getElementById('tk-project').value.trim();
      if (proj) body.project = proj;
      send('POST', '/tokens', body).then(function (t) {
        document.getElementById('tk-out').innerHTML = '<p>Copy this now; it will not be shown again:</p><pre><code>' + esc(t.token) + '</code></pre>';
      }).catch(function (e) { document.getElementById('tk-out').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
    };
    Array.prototype.forEach.call(main.querySelectorAll('button[data-revoke]'), function (b) {
      b.onclick = function () { send('DELETE', '/tokens/' + encodeURIComponent(b.getAttribute('data-revoke'))).then(function () { viewTokens(caps); }).catch(fail); };
    });
  }).catch(fail);
}

var capsCache = null;
function route() {
  var h = location.hash || '#/system';
  if (h === '#/tokens') return viewTokens([]);
  if (!new URLSearchParams(location.search).get('project') && !localDefault) return viewProjects();
  var go = function (caps) {
    var m;
    if ((m = h.match(/^#\/cap\/(.+)$/))) return viewCapability(decodeURIComponent(m[1]), caps);
    if (h === '#/matrix') return viewMatrix(caps);
    if (h === '#/audit') return viewAudit(caps);
    if (h === '#/tokens') return viewTokens(caps);
    return viewSystem(caps);
  };
  if (capsCache) return go(capsCache);
  get('/capabilities').then(function (r) { capsCache = r.capabilities.filter(function (c) { return c.kind === 'capability'; }); go(capsCache); }).catch(fail);
}
window.onhashchange = route;
/* A server with several projects has no unprefixed routes: pick a project (?project=name, else the first) and offer a switcher. */
var localDefault = false;
function viewProjects() {
  fetch(BASE + '/api/v1/projects').then(function(r) { if (!r.ok) throw new Error('Sign in to view projects.'); return r.json(); }).then(function(p) {
    buildNav([], '#projects');
    show('<h2>Projects</h2><p>Select a project, then create a token to connect SpecGuard.</p>' +
      (p.projects.length ? p.projects.map(function(x) { return '<p><a href="?project=' + encodeURIComponent(x.name) + '#/tokens">' + esc(x.name) + '</a> · ' + (x.kind === 'pending' ? 'Awaiting first publish' : esc(x.commit || x.kind)) + '</p>'; }).join('') : '<p>No projects yet. Create your first project below.</p>') +
      '<p><label>Project name <input id="new-project" maxlength="64" placeholder="my-project"></label> <button id="create-project">Create project</button></p><p>Creating projects requires maintainer access.</p>');
    document.getElementById('create-project').onclick = function() {
      send('POST', '/projects', {name: document.getElementById('new-project').value.trim()}).then(function(p) { location.href = BASE + '/?project=' + encodeURIComponent(p.name) + '#/tokens'; }).catch(fail);
    };
  }).catch(fail);
}
function boot() {
  var wanted = new URLSearchParams(location.search).get('project');
  fetch(BASE + '/api/v1/projects').then(function (r) { return r.ok ? r.json() : { projects: [], default: null }; }).then(function (p) {
    var names = (p.projects || []).map(function (x) { return x.name; });
    localDefault = !!p['default'];
    var use = wanted && names.indexOf(wanted) >= 0 ? wanted : null;
    if (use) API = BASE + '/api/v1/projects/' + encodeURIComponent(use);
    if (names.length || !localDefault) {
      document.getElementById('project-slot').innerHTML = '<a href="' + BASE + '/">Projects</a>';
    }
    if (names.length > 1) {
      var sel = '<select id="project" aria-label="Project">' + names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === use ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>';
      document.getElementById('project-slot').innerHTML = '<a href="' + BASE + '/">Projects</a> ' + sel;
      document.getElementById('project').onchange = function (e) { location.search = '?project=' + encodeURIComponent(e.target.value); };
    }
    route();
  }).catch(function () { route(); });
}
boot();
</script>
</body>
</html>
`;

/** The page, with the path prefix the server is mounted under (empty at the root). The prefix must be a plain path. */
export function renderUi(basePath = ''): string {
  if (!/^(\/[A-Za-z0-9._-]+)*$/.test(basePath) || basePath.split('/').some((part) => part === '.' || part === '..')) throw new Error(`invalid base path "${basePath}"`);
  return UI_TEMPLATE.replace('__BASE__', basePath);
}

export const UI_HTML = renderUi('');
