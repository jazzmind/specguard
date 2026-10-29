import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getActiveWorkspaceRoot, loadWorkspaceManifest, warmProjectConfigs } from './workspace-state.js';
import { saveSettings, settingsSnapshot, setAiCredential, setServerToken, testConnection, resetRepoSettings } from './settings.js';
import { validateLayer } from './settings-model.js';

let panel: vscode.WebviewPanel | undefined;
let selectedRoot: string | undefined;

export function registerSettingsPanel(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('specguard.workspaceSettings', (root?: string) => {
    selectedRoot = root;
    if (panel) { panel.reveal(); void push(); return; }
    panel = vscode.window.createWebviewPanel('specguard.settings', 'SpecGuard Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = settingsHtml();
    panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'ready') { await warmProjectConfigs(); await push(); return; }
        if (msg.type === 'scope') {
          if (msg.root && !roots().some(r => r.root === msg.root)) throw new Error('Unknown repository.');
          selectedRoot = msg.root || undefined;
          await push(); return;
        }
        if (msg.type === 'workspace') { await vscode.commands.executeCommand('specguard.workspaceStatus'); return; }
        if (msg.type === 'dashboard' && selectedRoot) { await vscode.commands.executeCommand('specguard.repoDashboard', selectedRoot); return; }
        if (msg.type === 'connectServer') { await vscode.commands.executeCommand('specguard.signIn', selectedRoot ?? getActiveWorkspaceRoot()); await push(); return; }
        const layer = validateLayer(msg.layer);
        const root = selectedRoot ?? getActiveWorkspaceRoot();
        if (!root) throw new Error('Open a workspace first.');
        if (msg.type === 'save') {
          await saveSettings(selectedRoot, layer);
          await push('Settings saved.');
          await vscode.commands.executeCommand('specguard.refreshCoverage');
          await vscode.commands.executeCommand('specguard.workspacePanel.refresh');
        } else if (msg.type === 'reset' && selectedRoot) {
          await resetRepoSettings(selectedRoot);
          await push('Repo overrides removed. Workspace defaults now apply.');
          await vscode.commands.executeCommand('specguard.refreshCoverage');
        } else if (msg.type === 'key' || msg.type === 'removeKey') {
          // Validate the draft provider and endpoint before associating a credential.
          const llm = layer.llm ?? (await settingsSnapshot(root, !selectedRoot)).llm;
          await setAiCredential(selectedRoot, llm, msg.type === 'removeKey');
          await push();
        } else if (msg.type === 'token' || msg.type === 'removeToken') {
          const server = layer.server ?? (await settingsSnapshot(root, !selectedRoot)).server;
          await setServerToken(server.url, msg.type === 'removeToken');
          await push();
        } else if (msg.type === 'testAI' || msg.type === 'testServer') {
          const result = await testConnection(root, msg.type === 'testAI' ? 'ai' : 'server', layer, !selectedRoot);
          panel?.webview.postMessage({ type: 'notice', text: result });
        }
      } catch {
        // Do not forward provider responses or credentials to a webview.
        const text = ['save', 'reset', 'scope'].includes(msg.type) ? 'Could not update settings. Check field values and workspace write access.' : 'Could not complete the action. Check settings and try again.';
        panel?.webview.postMessage({ type: 'notice', text });
      }
    }, null, context.subscriptions);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('specguard')) void push(); }));
  }));
}
function roots() {
  const all = new Map((vscode.workspace.workspaceFolders ?? []).map(f => [f.uri.fsPath, { root: f.uri.fsPath, name: f.name }]));
  for (const repo of loadWorkspaceManifest()?.repos ?? []) if (!repo.ignore) all.set(repo.absPath, { root: repo.absPath, name: repo.key });
  return [...all.values()];
}
async function push(notice?: string): Promise<void> {
  const root = selectedRoot ?? getActiveWorkspaceRoot();
  if (!root) return;
  const target = panel;
  const selection = selectedRoot;
  const snapshot = await settingsSnapshot(root, !selection);
  if (target !== panel || selection !== selectedRoot) return;
  target?.webview.postMessage({ type: 'settings', selectedRoot: selection ?? '', roots: roots(), snapshot, notice });
}

export function settingsHtml(): string {
  const nonce = randomBytes(16).toString('hex');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
*{box-sizing:border-box}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px 32px}main{max-width:960px;margin:auto}nav{display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:16px;margin-bottom:24px}h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:0}p{color:var(--vscode-descriptionForeground);line-height:1.6}section{border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:24px;border-radius:10px;margin:20px 0}header{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:20px}.badge{font-size:12px;color:var(--vscode-descriptionForeground)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.field{display:flex;flex-direction:column;gap:8px}label{font-size:12px}input,select{font:inherit;width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:9px;border-radius:4px}input[type=checkbox]{width:auto}button{font:inherit;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:4px;padding:8px 12px;cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.link{padding:0;background:transparent;color:var(--vscode-textLink-foreground)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:20px}.override{display:flex;gap:8px;align-items:center;margin:0 0 16px}.hint{font-size:12px;margin:12px 0 0}.credential{border-top:1px solid var(--vscode-panel-border);margin-top:20px;padding-top:16px}.notice{position:sticky;bottom:0;padding:14px 16px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);margin-top:20px;min-height:45px}.hidden{display:none!important}fieldset{border:0;padding:0;margin:0}fieldset:disabled{opacity:.6}#scope{max-width:320px;margin-left:auto}@media(max-width:650px){body{padding:16px}.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}nav{flex-wrap:wrap}#scope{margin:0}section{padding:18px}}
</style></head><body><main>
<nav aria-label="Settings navigation"><button class="link" data-act="workspace">← Workspace</button><button class="link hidden" id="dashboard" data-act="dashboard">Repo dashboard</button><label for="scope">Settings for</label><select id="scope" aria-label="Settings scope"><option value="">Workspace defaults</option></select></nav>
<h1 id="title">Workspace Settings</h1><p id="subtitle">Shared defaults for repositories in this VS Code workspace. Credentials are stored securely on this machine.</p>
<section><header><h2>AI provider</h2><span class="badge" id="aiSource"></span></header>
<label class="override hidden" id="aiOverrideLabel"><input type="checkbox" id="aiOverride">Override workspace AI settings for this repo</label>
<fieldset id="aiFields"><div class="grid"><div class="field"><label for="provider">Provider</label><select id="provider"><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="litellm">LiteLLM / compatible endpoint</option></select></div><div class="field"><label for="model">Model</label><input id="model"></div><div class="field"><label for="endpoint">Base URL (optional)</label><input id="endpoint" placeholder="Provider default"></div><div class="field"><label for="keyEnv">API key environment variable</label><input id="keyEnv"></div></div></fieldset>
<div class="credential"><strong>API key</strong><p class="hint" id="keyStatus"></p><div class="actions"><button data-act="key">Set / replace key</button><button data-act="removeKey">Remove stored key</button><button data-act="testAI">Test AI connection</button></div><p class="hint">Keys use VS Code secure storage. An empty key falls back to an existing environment variable or project .env file. Save provider changes before setting a key.</p></div></section>
<section><header><h2>Team server</h2><span class="badge" id="serverSource"></span></header><label class="override hidden" id="serverOverrideLabel"><input type="checkbox" id="serverOverride">Override workspace server settings for this repo</label>
<fieldset id="serverFields"><div class="grid"><div class="field"><label for="serverUrl">Server URL</label><input id="serverUrl" placeholder="https://specguard.example.com"></div><div class="field"><label for="mode">Connection mode</label><select id="mode"><option value="auto">Use server when available; fall back to local</option><option value="off">Local only</option></select></div><div class="field"><label for="project">Project name (optional)</label><input id="project" placeholder="Use each repo's project mapping or folder name"></div></div></fieldset>
<div class="credential"><strong>Server token</strong><p class="hint" id="tokenStatus"></p><div class="actions"><button data-act="connectServer">Connect / select or create project</button><button data-act="token">Set / replace token</button><button data-act="removeToken">Remove stored token</button><button data-act="testServer">Test server &amp; project access</button></div><p class="hint">Tokens are stored securely per server address and shared with SpecGuard's sign-in commands.</p></div></section>
<section><header><h2>Repository relationships</h2></header><p>Overlay suppliers, repository content and ignored repositories are managed in the workspace dashboard.</p><button data-act="workspace">Manage repositories →</button></section>
<div class="actions"><button class="primary" data-act="save">Save settings</button><button class="hidden" id="reset" data-act="reset">Reset repo to workspace defaults</button></div><div role="status" aria-live="polite" class="notice" id="notice">Loading settings…</div>
</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);let repo=false;
function draft(){const layer={};if(!repo||$('aiOverride').checked)layer.llm={provider:$('provider').value,model:$('model').value,apiKeyEnv:$('keyEnv').value,baseUrl:$('endpoint').value};if(!repo||$('serverOverride').checked)layer.server={url:$('serverUrl').value,project:$('project').value,mode:$('mode').value};return layer;}
function toggles(){$('aiFields').disabled=repo&&!$('aiOverride').checked;$('serverFields').disabled=repo&&!$('serverOverride').checked;}
window.addEventListener('message',e=>{const m=e.data;if(m.type==='notice'){$('notice').textContent=m.text;return;}if(m.type!=='settings')return;const s=m.snapshot;repo=!!m.selectedRoot;$('scope').replaceChildren(new Option('Workspace defaults',''),...m.roots.map(r=>new Option(r.name,r.root)));$('scope').value=m.selectedRoot;$('title').textContent=repo?'Repository Settings':'Workspace Settings';$('subtitle').textContent=repo?'Workspace defaults apply unless you enable a repo override. API keys may be shared or set separately for this repo.':'Shared defaults for repositories in this VS Code workspace. Credentials are stored securely on this machine.';for(const id of ['aiOverrideLabel','serverOverrideLabel','dashboard','reset'])$(id).classList.toggle('hidden',!repo);$('aiOverride').checked=!!s.layer.llm;$('serverOverride').checked=!!s.layer.server;$('provider').value=s.llm.provider;$('model').value=s.llm.model;$('endpoint').value=s.llm.baseUrl||'';$('keyEnv').value=s.llm.apiKeyEnv;$('serverUrl').value=s.server.url;$('project').value=s.server.project||'';$('mode').value=s.server.mode;$('aiSource').textContent=repo?s.llmSource:'Workspace default';$('serverSource').textContent=repo?s.serverSource:'Workspace default';$('keyStatus').textContent=(s.hasKey?'Configured · ':'')+s.keySource;$('tokenStatus').textContent=s.hasToken?'Token available for this server':'No token found for this server';$('notice').textContent=m.notice||'Ready. Secrets are never written to workspace files.';toggles();});
$('scope').addEventListener('change',()=>vscode.postMessage({type:'scope',root:$('scope').value}));for(const id of ['aiOverride','serverOverride'])$(id).addEventListener('change',toggles);
$('provider').addEventListener('change',()=>{const p=$('provider').value;$('keyEnv').value=p==='anthropic'?'ANTHROPIC_API_KEY':'OPENAI_API_KEY';$('model').value=p==='anthropic'?'claude-sonnet-4-6':p==='openai'?'gpt-4o':'gpt-4';$('endpoint').value=p==='litellm'?'http://localhost:4000':'';});
document.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!b)return;$('notice').textContent='Working…';vscode.postMessage({type:b.dataset.act,layer:draft()});});vscode.postMessage({type:'ready'});
</script></body></html>`;
}
