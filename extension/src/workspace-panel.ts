/**
 * Workspace dashboard panel — visual status and drift views for the whole workspace.
 *
 * Opens a dedicated WebviewPanel with two tabs:
 *   Status  — repo health grid (spec counts, roles, contract edges)
 *   Drift   — run specguard workspace drift and stream results
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  loadWorkspaceManifest,
  loadContractsSummary,
  getWorkspaceManifestRoot,
  getActiveWorkspaceRoot,
} from './workspace-state.js';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';
import { setRepoIgnored, syncCodeWorkspace } from './code-workspace.js';
import { configDirFor } from './project-config.js';
import { projectHealth } from './project-health.js';
import { warmProjectConfigs } from './workspace-state.js';

// ---------------------------------------------------------------------------
// Panel singleton
// ---------------------------------------------------------------------------

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;
let _refreshId = 0;
let _catalogFiles = new Map<string, string[]>();

type PanelMsg =
  | { type: 'settings' }
  | { type: 'journeys' }
  | { type: 'openDashboard'; key: string }
  | { type: 'ready' }
  | { type: 'runDrift' }
  | { type: 'runContracts' }
  | { type: 'refreshAll' }
  | { type: 'syncNow' }
  | { type: 'setIgnore'; key: string; ignore: boolean }
  | { type: 'openCatalog'; key: string; index: number }
  | { type: 'switchRepo'; absPath: string; key: string };

/** Commands other parts of the extension use to drive an open panel. */
export function registerWorkspacePanelCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.workspacePanel.refresh', () => {
      if (_panel) refreshStatus(_panel.webview);
    }),
    vscode.commands.registerCommand('specguard.workspacePanel.refreshAll', async () => {
      if (_panel) await handleMessage({ type: 'refreshAll' });
    }),
  );
}

export function openWorkspacePanel(context: vscode.ExtensionContext, initialTab: 'status' | 'drift' = 'status'): void {
  _context = context;

  if (_panel) {
    _panel.reveal();
    _panel.webview.postMessage({ type: 'navigate', tab: initialTab });
    if (initialTab === 'status') refreshStatus(_panel.webview);
    return;
  }

  _panel = vscode.window.createWebviewPanel(
    'specguard.workspace',
    'SpecGuard Workspace',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  _panel.webview.html = buildHtml(_panel.webview);
  _panel.onDidDispose(() => { _panel = undefined; }, null, context.subscriptions);

  context.subscriptions.push(
    _panel.webview.onDidReceiveMessage((msg: PanelMsg) => void handleMessage(msg)),
  );

  // Push initial data once the webview signals ready
  setTimeout(() => {
    if (_panel) {
      refreshStatus(_panel.webview);
      _panel.webview.postMessage({ type: 'navigate', tab: initialTab });
    }
  }, 150);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(msg: PanelMsg): Promise<void> {
  if (!_panel) return;
  if (msg.type === 'journeys') { await vscode.commands.executeCommand('specguard.businessJourneys'); return; }
  if (msg.type === 'settings') { await vscode.commands.executeCommand('specguard.workspaceSettings'); return; }

  if (msg.type === 'openCatalog') {
    const file = Number.isInteger(msg.index) ? _catalogFiles.get(msg.key)?.[msg.index] : undefined;
    if (file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    return;
  }

  if (msg.type === 'ready') {
    refreshStatus(_panel.webview);
    return;
  }

  if (msg.type === 'runDrift') {
    await streamCommand('workspace drift', ['workspace', 'drift'], 'drift');
    return;
  }

  if (msg.type === 'runContracts') {
    // --force so the button actually rebuilds rather than merging into stale data
    await streamCommand('contracts', ['contracts', '--force'], 'contracts');
    return;
  }

  if (msg.type === 'refreshAll') {
    const root = getWorkspaceManifestRoot();
    // Runs `check` in every active repo, then writes .specguard/rollup.json
    if (root) await streamCommand('workspace check', ['check', '--workspace', root, '--refresh'], 'refresh');
    if (_panel) refreshStatus(_panel.webview);
    return;
  }

  if (msg.type === 'syncNow') {
    if (_context) await syncCodeWorkspace(_context, { interactive: true });
    if (_panel) refreshStatus(_panel.webview);
    return;
  }

  if (msg.type === 'setIgnore') {
    const root = getWorkspaceManifestRoot();
    if (root && (await setRepoIgnored(root, msg.key, msg.ignore))) refreshStatus(_panel.webview);
    return;
  }

  if (msg.type === 'openDashboard') {
    const repo = loadWorkspaceManifest()?.repos.find(r => r.key === msg.key && !r.ignore);
    if (repo) await vscode.commands.executeCommand('specguard.repoDashboard', repo.absPath);
    return;
  }

  if (msg.type === 'switchRepo') {
    await vscode.commands.executeCommand('specguard.switchToRepo', msg.absPath, msg.key);
    refreshStatus(_panel.webview);
    return;
  }
}

async function refreshStatus(webview: vscode.Webview): Promise<void> {
  const id = ++_refreshId;
  await warmProjectConfigs();
  const manifest = loadWorkspaceManifest();
  const contracts = loadContractsSummary();
  const activeRoot = getActiveWorkspaceRoot();

  // Annotate which repo is currently active so the webview can highlight it
  const version = String(_context?.extension.packageJSON.version ?? 'unknown');
  const annotated = manifest
    ? {
        ...manifest,
        repos: await Promise.all(manifest.repos.map(async (r) => ({ ...r, _isActive: r.absPath === activeRoot, health: await projectHealth(r.absPath, configDirFor(r.absPath), version, manifest.catalog) }))),
      }
    : null;

  if (id !== _refreshId) return;
  _catalogFiles = new Map(annotated?.repos.map((r) => [r.key, r.health.catalog?.files.map((f) => f.path) ?? []]) ?? []);
  webview.postMessage({ type: 'statusData', manifest: annotated, contracts });
}

async function streamCommand(label: string, args: string[], streamTarget: string): Promise<void> {
  if (!_panel) return;
  const manifestRoot = getWorkspaceManifestRoot();
  if (!manifestRoot) return;

  const cli = await resolveCliPath(manifestRoot);
  const webview = _panel.webview;

  webview.postMessage({ type: 'streamStart', target: streamTarget, label });

  const lines: string[] = [];
  const handle = spawnCli(cli, args, manifestRoot, (line) => {
    lines.push(line);
    webview.postMessage({ type: 'streamLine', target: streamTarget, line });
  });

  const code = await handle.promise;
  webview.postMessage({ type: 'streamDone', target: streamTarget, exitCode: code });

  // If contracts were rebuilt, refresh status panel to show new edge counts
  if (streamTarget === 'contracts') refreshStatus(webview);
}

// ---------------------------------------------------------------------------
// HTML / CSS / JS
// ---------------------------------------------------------------------------

export function buildHtml(_webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --radius: 6px;
    --gap: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 24px;
  }
  h1 { font-size: 16px; font-weight: 600; margin-bottom: 16px; }

  /* ── Tabs ── */
  .tabs { display: flex; gap: 2px; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab-btn {
    padding: 7px 14px; cursor: pointer; border: none; background: none;
    color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
    font: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .tab-btn:hover { color: var(--vscode-foreground); }
  .tab-btn.active {
    color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
    border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background));
    font-weight: 600;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* ── Stats row ── */
  .stats { display: flex; gap: var(--gap); flex-wrap: wrap; margin-bottom: 20px; }
  .stat-card {
    flex: 1 1 130px; padding: 12px 16px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
  }
  .stat-card .label { font-size: 11px; opacity: .7; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
  .stat-card .value { font-size: 22px; font-weight: 700; }
  .stat-card .sub { font-size: 11px; opacity: .6; margin-top: 2px; }

  /* ── Repo grid ── */
  .section-title { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin-bottom: 8px; margin-top: 20px; }
  .repo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap); }
  .repo-card {
    padding: 12px 14px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
    cursor: pointer; transition: border-color .15s;
  }
  .repo-card:hover { border-color: var(--vscode-focusBorder); }
  .repo-card.active-repo { border-color: var(--vscode-button-background); }
  .repo-card.ignored { opacity: .45; cursor: default; }
  .repo-card .repo-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .repo-card .repo-name { font-weight: 600; flex: 1; }
  .badge {
    font-size: 10px; padding: 1px 6px; border-radius: 10px; font-weight: 500;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .badge.provider { background: #1e3a5f; color: #7eb8f7; }
  .badge.consumer { background: #1e3a1e; color: #7ecc7e; }
  .badge.test     { background: #3a2a1e; color: #e0a07e; }
  .badge.docs     { background: #2a1e3a; color: #b07ee0; }
  .repo-meta { font-size: 11px; display: flex; gap: 10px; }
  .spec-count { display: flex; align-items: center; gap: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.green  { background: var(--vscode-testing-iconPassed, #3fb950); }
  .dot.yellow { background: var(--vscode-testing-iconFailed, #d29922); }
  .dot.gray   { background: var(--vscode-disabledForeground, #6e7681); }
  .active-label { font-size: 10px; opacity: .6; font-style: italic; }
  .health-line { font-size: 12px; margin-top: 7px; line-height: 1.5; overflow-wrap: anywhere; }
  .health-line small { display: block; color: var(--vscode-descriptionForeground); }
  .catalog-table { width: 100%; border-collapse: collapse; margin: 12px 0 20px; }
  .catalog-table th,.catalog-table td { text-align: left; vertical-align: top; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
  .catalog-table small { display: block; margin-top: 5px; color: var(--vscode-descriptionForeground); }
  .catalog-table button { margin: 3px; }
  .table-wrap { overflow-x: auto; }

  #status-content > .contracts-bar:first-child { margin-bottom: 18px; }
  .repo-grid { max-width: 1280px; margin: 0 auto; gap: 18px; align-items: start; }
  .repo-card { min-width: 0; padding: 22px; border-radius: 10px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); cursor: default; border: 1px solid var(--vscode-panel-border); }
  .repo-card.active-repo { border-color: var(--vscode-focusBorder); box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
  .repo-card .repo-header { align-items: flex-start; gap: 16px; margin-bottom: 16px; }
  .repo-title { flex: 1; min-width: 0; }
  .repo-card .repo-name { display: block; font-size: 17px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .repo-subtitle { display: block; color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  .repo-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 20px; }
  .content-chip { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 2px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .repo-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 22px; }
  .repo-metrics strong { display: block; font-size: 23px; font-weight: 600; line-height: 1.3; }
  .repo-metrics strong small { font-size: 13px; color: var(--vscode-descriptionForeground); font-weight: 400; }
  .repo-metrics span { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .catalog-summary { border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); padding: 15px 0; margin-bottom: 14px; }
  .card-section-label { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .catalog-status { font-size: 13px; }
  .catalog-files { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 8px; }
  .catalog-link { background: transparent; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; text-align: left; overflow-wrap: anywhere; }
  .catalog-link:hover { text-decoration: underline; }
  .muted { color: var(--vscode-descriptionForeground); margin: 0; font-size: 12px; line-height: 1.5; }
  .small { font-size: 11px; }
  .card-context { display: flex; justify-content: space-between; gap: 18px; font-size: 12px; line-height: 1.6; margin: 6px 0; }
  .card-context > :first-child { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .card-context > :last-child { text-align: right; overflow-wrap: anywhere; }
  .repo-details { margin-top: 16px; font-size: 12px; }
  .repo-details summary { color: var(--vscode-textLink-foreground); cursor: pointer; width: fit-content; }
  .detail-path { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; margin-top: 12px; }
  .card-footer { border-top: 1px solid var(--vscode-panel-border); margin-top: 16px; padding-top: 12px; display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .activate { flex-shrink: 0; }
  .active-badge { color: var(--vscode-testing-iconPassed); background: transparent; border: 1px solid var(--vscode-testing-iconPassed); }
  @media (max-width: 940px) { .repo-grid { grid-template-columns: minmax(0, 1fr); } }


  /* ── Contracts bar ── */
  .contracts-bar {
    margin-top: 20px; padding: 12px 16px; border-radius: var(--radius);
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-inactiveSelectionBackground);
    display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  }
  .contracts-bar .c-stat { font-size: 13px; }
  .contracts-bar .c-stat strong { font-weight: 700; }
  .contracts-bar .stale { color: var(--vscode-testing-iconFailed, #d29922); font-size: 11px; }
  .btn {
    padding: 5px 14px; border: none; border-radius: var(--radius); cursor: pointer;
    font: inherit; font-size: 12px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn:disabled { opacity: .5; cursor: default; }
  .ml-auto { margin-left: auto; }

  /* ── Stream / Drift / Contracts log ── */
  .stream-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .stream-header h2 { font-size: 14px; font-weight: 600; }
  #contracts-log-wrap { display: none; margin-top: 16px; }
  #contracts-log-wrap.visible { display: block; }
  #drift-log, .stream-log {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    background: var(--vscode-terminal-background, var(--vscode-editor-background));
    color: var(--vscode-terminal-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
    padding: 12px;
    min-height: 200px;
    max-height: 60vh;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.5;
  }
  .stream-placeholder { opacity: .45; font-style: italic; }
  .exit-ok  { color: var(--vscode-testing-iconPassed, #3fb950); }
  .exit-err { color: var(--vscode-testing-iconFailed, #f85149); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--vscode-foreground);
    border-right-color: transparent; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<h1>⊕ Workspace Dashboard</h1>

<div class="tabs">
  <button class="tab-btn active" data-tab="status">Status</button>
  <button class="tab-btn" data-tab="drift">Cross-Repo Drift</button>
  <button class="tab-btn" data-act="settings">Settings</button>
</div>

<!-- ── Status Tab ── -->
<div id="tab-status" class="tab-panel active">
  <div id="status-content"><em style="opacity:.5">Loading…</em></div>
  <!-- contracts log appears inline when rebuild is running -->
  <div id="contracts-log-wrap">
    <div class="stream-header">
      <h2>Rebuilding Contracts</h2>
      <div id="contracts-spinner"><div class="spinner"></div></div>
    </div>
    <div id="contracts-log" class="stream-log"><span class="stream-placeholder">Starting…</span></div>
  </div>
</div>

<!-- ── Drift Tab ── -->
<div id="tab-drift" class="tab-panel">
  <div class="stream-header">
    <h2>Cross-Repo Drift Detection</h2>
    <button id="btn-drift" class="btn" data-act="runDrift">Run Workspace Drift</button>
    <div id="drift-spinner" style="display:none"><div class="spinner"></div></div>
  </div>
  <div id="drift-log" class="stream-log"><span class="stream-placeholder">Click "Run Workspace Drift" to check all repos for spec drift…</span></div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  function activateTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  // ── Status rendering ───────────────────────────────────────────────────────
  function renderStatus(manifest, contracts) {
    if (!manifest) {
      document.getElementById('status-content').innerHTML =
        '<p style="opacity:.5">No workspace.json found.</p>';
      return;
    }

    const repos = manifest.repos;
    const active = repos.filter(r => !r.ignore);
    const ignored = repos.filter(r => r.ignore);
    const projects = active.filter(r => !r.overlayFor?.length);
    const specced = projects.filter(r => r.specCount > 0).length;
    const edgeCount = contracts ? contracts.edgeCount : 0;
    const staleCount = contracts ? contracts.staleCount : 0;
    const nodeCount = contracts ? contracts.nodeCount : 0;

    // Stats cards
    const statsHtml = \`
      <div class="stats">
        <div class="stat-card">
          <div class="label">Repos Specced</div>
          <div class="value">\${specced}/<span style="opacity:.5">\${projects.length}</span></div>
          <div class="sub">\${projects.length - specced} projects need specs · \${active.length - projects.length} overlays</div>
        </div>
        <div class="stat-card">
          <div class="label">Current specs</div>
          <div class="value">\${active.reduce((s, r) => s + r.specCount, 0)}</div>
          <div class="sub">across \${active.length} repos, archived v1 excluded</div>
        </div>
        \${contracts ? \`
        <div class="stat-card">
          <div class="label">Contract Edges</div>
          <div class="value">\${edgeCount}</div>
          <div class="sub">\${nodeCount} nodes\${staleCount > 0 ? ' · <span style=\\"color:var(--vscode-testing-iconFailed)\\">' + staleCount + ' unverified &gt;30d</span>' : ''}</div>
        </div>\` : \`
        <div class="stat-card">
          <div class="label">Contracts</div>
          <div class="value" style="font-size:15px;opacity:.5">not built</div>
          <div class="sub"><a href="#" data-act="runContracts">build now</a></div>
        </div>\`}
        <div class="stat-card">
          <div class="label">Ignored</div>
          <div class="value" style="opacity:.5">\${ignored.length}</div>
          <div class="sub">repos excluded</div>
        </div>
      </div>
    \`;

    // Repo cards
    const activeCardsHtml = active.map(repo => repoCard(repo)).join('');
    const ignoredCardsHtml = ignored.length > 0 ? \`
      <div class="section-title">Ignored</div>
      <div class="repo-grid">\${ignored.map(repo => repoCard(repo, true)).join('')}</div>
    \` : '';

    // Contracts bar
    const contractsBarHtml = contracts ? \`
      <div class="contracts-bar">
        <div class="c-stat"><strong>\${edgeCount}</strong> contract edges</div>
        <div class="c-stat"><strong>\${nodeCount}</strong> nodes</div>
        \${staleCount > 0 ? \`<span class="stale">⚠ \${staleCount} unverified &gt;30d</span>\` : ''}
        <div class="ml-auto" style="display:flex;align-items:center;gap:8px">
          <div id="contracts-bar-spinner" style="display:none"><div class="spinner"></div></div>
          <button id="btn-contracts" class="btn secondary" data-act="runContracts">Rebuild Contracts</button>
        </div>
      </div>
    \` : \`
      <div class="contracts-bar">
        <div class="c-stat" style="opacity:.6">No contracts graph yet.</div>
        <div class="ml-auto" style="display:flex;align-items:center;gap:8px">
          <div id="contracts-bar-spinner" style="display:none"><div class="spinner"></div></div>
          <button id="btn-contracts" class="btn" data-act="runContracts">Build Contracts</button>
        </div>
      </div>
    \`;

    const toolbarHtml = \`
      <div class="contracts-bar">
        <div class="c-stat" style="opacity:.7">\${manifest.rollupAt ? 'Checked ' + new Date(manifest.rollupAt).toLocaleString() : 'Not checked yet'}\${manifest.codeWorkspace ? ' · follows ' + manifest.codeWorkspace.split('/').pop() : ''}</div>
        <div class="ml-auto" style="display:flex;align-items:center;gap:8px">
          \${manifest.codeWorkspace ? '<button class="btn secondary" data-act="syncNow">Sync folders</button>' : ''}
          <button class="btn secondary" data-act="journeys">Business journeys</button><button class="btn" data-act="refreshAll">Refresh all repos</button>
        </div>
      </div>
    \`;

    document.getElementById('status-content').innerHTML =
      toolbarHtml +
      statsHtml +

      \`<div class="section-title">Repos</div><div class="repo-grid">\${activeCardsHtml}</div>\` +
      ignoredCardsHtml +
      contractsBarHtml;
  }

  function repoCard(repo, ignored) {
    const h = repo.health;
    const catalog = h && h.catalog;
    const overlay = repo.overlayFor?.length > 0;
    const proof = h && h.counts;
    const roleClass = ['provider','consumer','test','docs'].includes(repo.role) ? repo.role : '';
    const files = catalog ? catalog.files.map((f,i) => '<button class="catalog-link" data-act="openCatalog" data-key="' + attr(repo.key) + '" data-index="' + i + '" title="Open ' + attr(f.name) + '">' + attr(f.name) + '</button>').join('') : '';
    const sourceNames = (repo.suppliedBy || []).map(p => p.split(/[\\/]/).filter(Boolean).pop()).join(', ');
    return \`
      <article class="repo-card \${repo._isActive ? 'active-repo' : ''} \${ignored ? 'ignored' : ''}">
        <div class="repo-header">
          <div class="repo-title"><span class="repo-name" title="\${attr(repo.absPath)}">\${attr(repo.key)}</span>
            <span class="repo-subtitle">\${overlay ? 'Shared evidence overlay' : attr(repo.description || 'Workspace project')}</span></div>
          \${repo._isActive ? '<span class="badge active-badge">Active</span>' : !ignored ? '<button class="btn secondary activate" data-act="switch" data-abs="' + attr(repo.absPath) + '" data-key="' + attr(repo.key) + '">Activate</button>' : ''}
        </div>
        <div class="repo-chips"><span class="badge \${roleClass}">\${overlay ? 'overlay' : attr(repo.role)}</span>\${(repo.contents || []).map(c => '<span class="content-chip">' + attr(c) + '</span>').join('')}</div>
        <div class="repo-metrics">
          <div><strong>\${overlay ? repo.overlayFor.length : repo.specCount}</strong><span>\${overlay ? 'Projects supported' : 'Capabilities'}</span></div>
          <div><strong>\${proof ? proof.proven + '<small> / ' + proof.claims + '</small>' : '—'}</strong><span>Claims proven</span></div>
          <div><strong>\${catalog ? catalog.features : '—'}</strong><span>Catalog features</span></div>
        </div>
        <div class="catalog-summary">
          <div class="card-section-label">Feature catalog</div>
          \${overlay ? '<p class="muted">Catalogs are shown on the supported project cards.</p>' : catalog ? '<div class="catalog-status">' + (catalog.error ? attr(catalog.error) : '<strong>' + catalog.linked + '/' + catalog.features + '</strong> features linked to specs') + '</div><div class="catalog-files">' + files + '</div><span class="muted small">Content alignment: not verified</span>' : '<p class="muted">No feature catalog configured</p>'}
        </div>
        <div class="card-context"><span>Team server</span><span>\${attr(repo.teamStatus || 'not checked')}</span></div>
        \${sourceNames ? '<div class="card-context"><span>Evidence</span><span title="' + attr(repo.suppliedBy.join(', ')) + '">' + attr(sourceNames) + '</span></div>' : ''}
        <details class="repo-details"><summary>Technical details</summary>
          <div class="detail-path">\${attr(repo.absPath)}</div>
          \${overlay ? '<p>Supplies specs, tests or docs to: ' + repo.overlayFor.map(attr).join(', ') + '</p>' : healthLines(h)}
          \${catalog ? '<div class="health-line">Catalog revision: <code>' + attr(catalog.revision || 'unavailable') + '</code><small>' + attr(catalog.directory) + '</small>' + catalog.files.map(f => '<small>schema ' + attr(f.version) + ' · ' + f.features + ' features</small>').join('') + (catalog.missing.length ? '<small>Missing: ' + attr(catalog.missing.join(', ')) + '</small>' : '') + '</div>' : ''}
        </details>
        <div class="card-footer"><button class="catalog-link" data-act="openDashboard" data-key="\${attr(repo.key)}">Open dashboard →</button><span>\${ignored ? attr(repo.ignoreReason || 'Ignored') : overlay ? 'Shared across repositories' : proof ? proof.failed + ' failed · ' + proof.stale + ' stale' : 'Run a check to collect proof'}</span><a href="#" data-act="ignore" data-key="\${attr(repo.key)}" data-ignore="\${ignored ? 'false' : 'true'}">\${ignored ? 'Include' : 'Ignore'}</a></div>
      </article>
    \`;
  }

  function healthLines(h) {
    if (!h) return '';
    const short = s => s ? attr(s.slice(0, 10)) : 'not recorded';
    const setup = h.setupVersion ? 'v' + attr(h.setupVersion) + (h.setupCurrent ? ' · current' : ' · differs from installed version') : 'not initialized';
    const check = h.checkedWith ? 'v' + attr(h.checkedWith) + (h.checkVersionCurrent ? ' · current' : ' · recheck with installed version') : 'not recorded · run Refresh all repos';
    return '<div class="health-line"><strong>SpecGuard setup:</strong> ' + setup + '<small>Installed extension v' + attr(h.extensionVersion) + '</small></div>' +
      '<div class="health-line"><strong>Spec check engine:</strong> ' + check + '</div>' +
      '<div class="health-line"><strong>Code:</strong> ' + short(h.codeRevision) + (h.dirty ? ' · working changes' : h.dirty === null ? ' · Git state unknown' : '') + '<small>Last spec check: ' + short(h.checkedRevision) + ' · ' + (h.codeCurrent ? 'same clean revision' : 'revision freshness needs checking') + '</small></div>' +
      '<div class="health-line"><strong>Spec format:</strong> ' + (h.specFormat === 'capability' ? 'v2 functional specs' : h.specFormat === 'legacy' ? 'v1 legacy per-file specs' : 'no current specs') + '</div>' +
      (h.counts ? '<div class="health-line">Last check: ' + h.counts.proven + '/' + h.counts.claims + ' claims proven · ' + h.counts.failed + ' failed · ' + h.counts.stale + ' stale</div>' : '') +
      (h.error ? '<div class="health-line">' + attr(h.error) + '</div>' : '');
  }

  /** One line of what the last workspace check recorded for the repo. */
  function rollupLine(repo) {
    const r = repo.rollup;
    if (!r) return '';
    if (r.state !== 'ok') return '<div class="repo-meta" style="opacity:.6">' + (r.state === 'no-trace' ? 'not checked yet' : r.state === 'no-config' ? 'no SpecGuard config' : 'unreadable state') + '</div>';
    const sec = r.securityTotal > 0
      ? ' · <span style="color:var(--vscode-testing-iconFailed)">' + r.securityCritical + 'c ' + r.securityHigh + 'h open</span>'
      : '';
    const warn = (r.failed ? ' · ' + r.failed + ' failed' : '') + (r.stale ? ' · ' + r.stale + ' stale' : '') + (r.incomplete ? ' · ' + r.incomplete + ' missing a layer' : '');
    return '<div class="repo-meta" title="' + (r.lagging ? 'proofs are newer than this check' : '') + '"><span>' + r.proven + '/' + r.claims + ' proven (' + r.provenPct + '%)' + warn + sec + (r.lagging ? ' ⟳' : '') + '</span></div>';
  }

  // The page's CSP allows only nonce'd scripts, which blocks inline click-handler attributes: clicks are
  // routed by data-act instead.
  function attr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    e.preventDefault();
    const d = el.dataset;
    if (d.act === 'ignore') setIgnore(d.key, d.ignore === 'true');
    else if (d.act === 'journeys') vscode.postMessage({ type: 'journeys' });
    else if (d.act === 'settings') vscode.postMessage({ type: 'settings' });
    else if (d.act === 'openDashboard') vscode.postMessage({ type: 'openDashboard', key: d.key });
    else if (d.act === 'switch') switchRepo(d.abs, d.key);
    else if (d.act === 'runDrift') runDrift();
    else if (d.act === 'runContracts') runContracts();
    else if (d.act === 'refreshAll') refreshAll();
    else if (d.act === 'syncNow') syncNow();
    else if (d.act === 'openCatalog') vscode.postMessage({type:'openCatalog',key:d.key,index:Number(d.index)});
  });

  // ── Drift streaming ────────────────────────────────────────────────────────
  function runDrift() { vscode.postMessage({ type: 'runDrift' }); }
  function runContracts() { vscode.postMessage({ type: 'runContracts' }); }
  function switchRepo(absPath, key) { vscode.postMessage({ type: 'switchRepo', absPath, key }); }
  function setIgnore(key, ignore) { vscode.postMessage({ type: 'setIgnore', key, ignore }); }
  function refreshAll() { vscode.postMessage({ type: 'refreshAll' }); }
  function syncNow() { vscode.postMessage({ type: 'syncNow' }); }

  // ── Message handler ────────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;

    if (msg.type === 'navigate') {
      activateTab(msg.tab);
    }

    if (msg.type === 'statusData') {
      renderStatus(msg.manifest, msg.contracts);
    }

    if (msg.type === 'streamStart') {
      if (msg.target === 'drift') {
        document.getElementById('drift-log').textContent = '';
        document.getElementById('btn-drift').disabled = true;
        document.getElementById('drift-spinner').style.display = 'inline-block';
      }
      if (msg.target === 'contracts') {
        const wrap = document.getElementById('contracts-log-wrap');
        const log = document.getElementById('contracts-log');
        const btn = document.getElementById('btn-contracts');
        const spinner = document.getElementById('contracts-bar-spinner');
        log.textContent = '';
        if (wrap) wrap.classList.add('visible');
        if (btn) btn.disabled = true;
        if (spinner) spinner.style.display = 'inline-block';
        if (document.getElementById('contracts-spinner'))
          document.getElementById('contracts-spinner').style.display = 'inline-block';
      }
    }

    if (msg.type === 'streamLine') {
      if (msg.target === 'drift') {
        const el = document.getElementById('drift-log');
        el.textContent += msg.line + '\\n';
        el.scrollTop = el.scrollHeight;
      }
      if (msg.target === 'contracts') {
        const el = document.getElementById('contracts-log');
        if (el) { el.textContent += msg.line + '\\n'; el.scrollTop = el.scrollHeight; }
      }
    }

    if (msg.type === 'streamDone') {
      if (msg.target === 'drift') {
        document.getElementById('btn-drift').disabled = false;
        document.getElementById('drift-spinner').style.display = 'none';
        const el = document.getElementById('drift-log');
        const tag = document.createElement('span');
        tag.className = msg.exitCode === 0 ? 'exit-ok' : 'exit-err';
        tag.textContent = msg.exitCode === 0 ? '\\n✓ No drift detected' : '\\n⚠ Drift detected (exit ' + msg.exitCode + ')';
        el.appendChild(tag);
        el.scrollTop = el.scrollHeight;
      }
      if (msg.target === 'contracts') {
        const btn = document.getElementById('btn-contracts');
        const spinner = document.getElementById('contracts-bar-spinner');
        const hdrSpinner = document.getElementById('contracts-spinner');
        if (btn) btn.disabled = false;
        if (spinner) spinner.style.display = 'none';
        if (hdrSpinner) hdrSpinner.style.display = 'none';
        const el = document.getElementById('contracts-log');
        if (el) {
          const tag = document.createElement('span');
          tag.className = msg.exitCode === 0 ? 'exit-ok' : 'exit-err';
          tag.textContent = msg.exitCode === 0 ? '\\n✓ Contracts rebuilt' : '\\n✗ Build failed (exit ' + msg.exitCode + ')';
          el.appendChild(tag);
          el.scrollTop = el.scrollHeight;
        }
      }
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
