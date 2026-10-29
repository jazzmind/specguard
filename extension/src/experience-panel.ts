import { refreshDashboard } from './dashboard/panel.js';
/** Business journeys and feature organization, backed by the same CLI contract. */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { queryCli } from './output-routing.js';
import { configDirFor } from './project-config.js';
import { getActiveWorkspaceRoot, getWorkspaceManifestRoot } from './workspace-state.js';

type Group = { id: string; title: string; order: number };
type Step = { id: string; title: string; summary: string; order: number; refs: string[] };
type Journey = { id: string; title: string; summary: string; group: string; order: number; status: string; steps: Step[] };
type Placement = { ref: string; group: string; order: number };
type Doc = { version: number; title: string; overview: string; groups: Group[]; journeys: Journey[]; placements: Placement[] };
type Entry = { ref: string; title: string; summary: string; app: string; kind: string; file: string; claims: string[] };
type View = { document: Doc; catalog: Entry[]; revision: string; file: string; proposalFile: string; warnings: string[]; proposal?: { document: Doc } };

export function registerExperiencePanel(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('specguard.businessJourneys', () => openExperiencePanel(context, true)),
    vscode.commands.registerCommand('specguard.organizeApplication', (root?: string) => openExperiencePanel(context, false, root)));
}

export async function openExperiencePanel(context: vscode.ExtensionContext, workspace: boolean, selectedRoot?: string): Promise<void> {
  const root = workspace ? getWorkspaceManifestRoot() : selectedRoot ?? getActiveWorkspaceRoot();
  if (!root) { void vscode.window.showInformationMessage('Open or initialize a SpecGuard workspace first.'); return; }
  const inheritedRoot = getWorkspaceManifestRoot();
  const base = ['experience', ...(workspace ? ['--workspace', root] : ['--config', configDirFor(root), ...(inheritedRoot ? ['--inherit-workspace', inheritedRoot] : [])])];
  const panel = vscode.window.createWebviewPanel('specguard.experience', workspace ? 'Business journeys' : 'Features & specs', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = buildExperienceHtml(workspace);
  let state: View | undefined;
  let busy = false;
  const refresh = async (): Promise<void> => { state = await queryCli<View>(root, base); await panel.webview.postMessage({ type: 'state', data: state }); };
  const text = async (title: string, value = '') => vscode.window.showInputBox({ title, value, ignoreFocusOut: true });
  const groupFor = async (doc: Doc) => (await vscode.window.showQuickPick([{ label: 'Ungrouped', id: '' }, ...doc.groups.map(g => ({ label: g.title, id: g.id }))], { title: 'Choose logical group' }))?.id;
  const newId = () => crypto.randomUUID();
  const order = <T extends { order: number }>(nodes: T[], id: (node: T) => string, selected: string, delta: number): void => {
    nodes.sort((a, b) => a.order - b.order);
    const from = nodes.findIndex(n => id(n) === selected);
    const to = Math.max(0, Math.min(nodes.length - 1, from + delta));
    if (from >= 0) { const [node] = nodes.splice(from, 1); nodes.splice(to, 0, node); nodes.forEach((n, i) => n.order = i); }
  };
  panel.webview.onDidReceiveMessage(async msg => {
    if (busy) return;
    busy = true;
    try {
      if (msg.type === 'ready' || msg.type === 'reload') { await refresh(); return; }
      if (!state) return;
      if (msg.type === 'draft') {
        await panel.webview.postMessage({ type: 'busy', message: 'Drafting from current specs and catalogs…' });
        await queryCli(root, [...base, '--action', 'draft']); await refresh(); return;
      }
      if (msg.type === 'review') {
        if (state.proposal) {
          const before = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(state.document, null, 2) });
          const after = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(state.proposal.document, null, 2) });
          await vscode.commands.executeCommand('vscode.diff', before.uri, after.uri, 'Current organization ↔ draft proposal');
        }
        return;
      }
      if (msg.type === 'apply') { await queryCli(root, [...base, '--action', 'apply']); await refresh(); return; }
      if (msg.type === 'open') {
        const entry = state.catalog.find(e => e.ref === msg.ref || e.claims.includes(msg.ref));
        if (entry) await vscode.window.showTextDocument(vscode.Uri.file(entry.file));
        return;
      }
      if (msg.type === 'dashboard') {
        // Application roots resolve from the workspace manifest, rather than from webview-supplied paths.
        await vscode.commands.executeCommand('specguard.workspaceStatus'); return;
      }
      const doc = structuredClone(state.document);
      if (msg.type === 'overview') {
        const title = await text('Application / workspace title', doc.title); if (!title?.trim()) return;
        const overview = await text('Business overview', doc.overview); if (overview === undefined) return;
        doc.title = title; doc.overview = overview;
      } else if (msg.type === 'addGroup' || msg.type === 'editGroup') {
        const prior = doc.groups.find(g => g.id === msg.id);
        const title = await text('Logical group name', prior?.title); if (!title?.trim()) return;
        if (prior) prior.title = title; else doc.groups.push({ id: newId(), title, order: doc.groups.length });
      } else if (msg.type === 'addJourney' || msg.type === 'editJourney') {
        const prior = doc.journeys.find(j => j.id === msg.id);
        const title = await text('Business journey name', prior?.title); if (!title?.trim()) return;
        const summary = await text('Journey purpose / outcome', prior?.summary); if (summary === undefined) return;
        const group = await groupFor(doc); if (group === undefined) return;
        if (prior) Object.assign(prior, { title, summary, group });
        else doc.journeys.push({ id: newId(), title, summary, group, order: doc.journeys.length, status: 'draft', steps: [] });
      } else if (msg.type === 'addStep' || msg.type === 'editStep') {
        const j = doc.journeys.find(j => j.id === msg.journey); if (!j) return;
        const prior = j.steps.find(s => s.id === msg.id);
        const title = await text('Journey step', prior?.title); if (!title?.trim()) return;
        const summary = await text('Expected outcome', prior?.summary); if (summary === undefined) return;
        const refs = await vscode.window.showQuickPick(state.catalog.flatMap(e => [
          { label: e.title, description: e.ref, ref: e.ref, picked: prior?.refs.includes(e.ref) },
          ...e.claims.map(ref => ({ label: ref.split('#')[1], description: ref, ref, picked: prior?.refs.includes(ref) })),
        ]), { title: 'Link features, specs or claims across participating applications', canPickMany: true, ignoreFocusOut: true });
        if (!refs) return;
        const next = { title, summary, refs: refs.map(r => r.ref) };
        if (prior) Object.assign(prior, next); else j.steps.push({ id: newId(), order: j.steps.length, ...next });
      } else if (msg.type === 'place') {
        if (!state.catalog.some(e => e.ref === msg.ref)) return;
        const group = await groupFor(doc); if (group === undefined) return;
        const prior = doc.placements.find(p => p.ref === msg.ref);
        if (prior) prior.group = group; else doc.placements.push({ ref: msg.ref, group, order: doc.placements.length });
      } else if (msg.type === 'move') {
        if (![1, -1].includes(msg.delta)) return;
        if (msg.kind === 'group') order(doc.groups, g => g.id, msg.id, msg.delta);
        else if (msg.kind === 'journey') { const selected = doc.journeys.find(j => j.id === msg.id); if (selected) order(doc.journeys.filter(j => j.group === selected.group), j => j.id, msg.id, msg.delta); }
        else if (msg.kind === 'step') { const j = doc.journeys.find(j => j.id === msg.journey); if (j) order(j.steps, s => s.id, msg.id, msg.delta); }
        else if (msg.kind === 'placement') {
          for (const e of state.catalog) if (!doc.placements.some(p => p.ref === e.ref)) doc.placements.push({ ref: e.ref, group: '', order: doc.placements.length });
          const selected = doc.placements.find(p => p.ref === msg.id);
          if (selected) { const grouped = doc.placements.filter(p => p.group === selected.group); order(grouped, p => p.ref, msg.id, msg.delta); }
        }
      } else if (msg.type === 'reviewed') {
        const j = doc.journeys.find(j => j.id === msg.id); if (j) j.status = j.status === 'reviewed' ? 'draft' : 'reviewed';
      } else if (msg.type === 'remove') {
        if (msg.kind === 'group') { doc.groups = doc.groups.filter(g => g.id !== msg.id); for (const n of [...doc.journeys, ...doc.placements]) if (n.group === msg.id) n.group = ''; }
        else if (msg.kind === 'journey') doc.journeys = doc.journeys.filter(j => j.id !== msg.id);
        else { const j = doc.journeys.find(j => j.id === msg.journey); if (j) j.steps = j.steps.filter(s => s.id !== msg.id); }
      } else return;
      await queryCli(root, [...base, '--action', 'save', '--revision', state.revision, '--data', JSON.stringify(doc)]);
      await refresh();
      refreshDashboard();
    } catch (err) {
      const message = (err as Error).message;
      await panel.webview.postMessage({ type: 'error', message });
      void vscode.window.showErrorMessage(`SpecGuard: ${message}`);
    } finally { busy = false; await panel.webview.postMessage({ type: 'idle' }); }
  }, undefined, context.subscriptions);
}

export function buildExperienceHtml(workspace: boolean): string {
  const nonce = crypto.randomBytes(18).toString('base64');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1200px;margin:auto}h1{font-size:24px}h2{margin-top:30px}p{line-height:1.6;white-space:pre-wrap}button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:4px;padding:7px 10px;cursor:pointer;margin:3px}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.toolbar{display:flex;flex-wrap:wrap;gap:6px;position:sticky;top:0;background:var(--vscode-editor-background);padding:12px 0}.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:16px;margin:12px 0}.step{border-left:3px solid var(--vscode-focusBorder);padding:8px 14px;margin:12px 0}.muted,small{color:var(--vscode-descriptionForeground)}.ref{font-family:var(--vscode-editor-font-family);font-size:11px}.row{display:flex;align-items:center;gap:8px;justify-content:space-between}.warn{color:var(--vscode-editorWarning-foreground)}input{padding:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-panel-border);width:96%}summary{cursor:pointer}#message{white-space:pre-wrap}button:disabled{opacity:.4;cursor:wait}
</style></head><body><div class="toolbar"><button class="primary" data-act="draft">Draft / update from specs</button><button data-act="review">Review draft diff</button><button data-act="apply">Apply draft</button><button data-act="overview">Edit overview</button><button data-act="addGroup">Add group</button><button data-act="addJourney">Add journey</button><button data-act="reload">Reload</button></div><p id="message" role="status">Loading…</p><div id="content"></div><script nonce="${nonce}">
const vscode=acquireVsCodeApi(); let state; const workspace=${JSON.stringify(workspace)};
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function button(label,type,attrs={}){return '<button data-act="'+type+'" '+Object.entries(attrs).map(([k,v])=>'data-'+k+'="'+esc(v)+'"').join(' ')+'>'+esc(label)+'</button>';}
function arrows(kind,id,journey){return button('↑','move',{kind,id,delta:-1,journey:journey||''})+button('↓','move',{kind,id,delta:1,journey:journey||''});}
function render(){const d=state.document;document.getElementById('message').textContent=state.warnings.join('\\n');
let html='<h1>'+esc(d.title)+'</h1><p>'+esc(d.overview||'Draft an overview from the current specs, or write one with Edit overview.')+'</p><p class="muted">'+(workspace?'Business journeys connect applications through ordered steps.':'Organize features and specs without renaming files or claim IDs.')+' Edits save immediately. Drafts need review; reviewed organization does not certify runtime proof.</p>';
if(state.proposal)html+='<p class="warn">A draft proposal is available. Review its diff before applying.</p>';
const groups=[...d.groups].sort((a,b)=>a.order-b.order).concat([{id:'',title:'Ungrouped',order:999999}]);
for(const g of groups){const journeys=d.journeys.filter(j=>j.group===g.id).sort((a,b)=>a.order-b.order);
const entries=state.catalog.filter(e=>(d.placements.find(p=>p.ref===e.ref)?.group||'')===g.id).sort((a,b)=>(d.placements.find(p=>p.ref===a.ref)?.order??999999)-(d.placements.find(p=>p.ref===b.ref)?.order??999999)||a.title.localeCompare(b.title));
if(!g.id&&!journeys.length&&!entries.length)continue;
html+='<section><div class="row"><h2>'+esc(g.title)+'</h2><div>'+(g.id?arrows('group',g.id)+button('Rename','editGroup',{id:g.id})+button('Remove group','remove',{kind:'group',id:g.id}):'')+'</div></div>';
for(const j of journeys){html+='<article class="card"><div class="row"><h3>'+esc(j.title)+' <small>'+esc(j.status)+'</small></h3><div>'+arrows('journey',j.id)+button('Edit','editJourney',{id:j.id})+button(j.status==='reviewed'?'Mark draft':'Mark reviewed','reviewed',{id:j.id})+button('Remove','remove',{kind:'journey',id:j.id})+'</div></div><p>'+esc(j.summary)+'</p>';
for(const s of [...j.steps].sort((a,b)=>a.order-b.order)){html+='<div class="step"><div class="row"><strong>'+esc(s.title)+'</strong><div>'+arrows('step',s.id,j.id)+button('Edit links / outcome','editStep',{journey:j.id,id:s.id})+button('Remove','remove',{kind:'step',journey:j.id,id:s.id})+'</div></div><p>'+esc(s.summary)+'</p>';
for(const ref of s.refs){const e=state.catalog.find(e=>e.ref===ref||e.claims.includes(ref));html+='<div>'+button(e?e.title:ref,'open',{ref})+' <span class="ref">'+esc(ref)+'</span>'+(e?'':' <span class="warn">Missing reference</span>')+'</div>';}
html+='</div>';}
html+=button('Add step','addStep',{journey:j.id})+'</article>';}
if(entries.length){html+='<details '+(!workspace?'open':'')+'><summary>'+entries.length+' features and specs</summary>';
for(const e of entries)html+='<div class="card"><div class="row"><div>'+button(e.title,'open',{ref:e.ref})+'<small>'+esc(e.app)+' · '+esc(e.kind)+'</small></div><div>'+arrows('placement',e.ref)+button('Change group','place',{ref:e.ref})+'</div></div><p>'+esc(e.summary.slice(0,300))+'</p><small class="ref">'+esc(e.ref)+'</small></div>';
html+='</details>';}
html+='</section>';}
if(!d.journeys.length)html+='<p class="muted">No journeys yet. Draft them from specs or add a journey and link its steps to the applications involved.</p>';
document.getElementById('content').innerHTML=html;}
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el)return;const {act,...rest}=el.dataset;vscode.postMessage({type:act,...rest,...(rest.delta?{delta:Number(rest.delta)}:{})});});
window.addEventListener('message',e=>{if(e.data.type==='state'){state=e.data.data;render();}else if(e.data.type==='busy'){document.getElementById('message').textContent=e.data.message;document.querySelectorAll('button').forEach(b=>b.disabled=true);}else if(e.data.type==='error')document.getElementById('message').textContent=e.data.message;else if(e.data.type==='idle')document.querySelectorAll('button').forEach(b=>b.disabled=false);});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}
