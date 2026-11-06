/**
 * Pure helpers for the workspace panel's "Team server" section: reading the CLI's output, deciding what each repo's row says,
 * building the publish command lines and rendering the section as HTML. No `vscode` import, so it can be unit tested.
 *
 * The shapes mirror `src/core/publish-contract.ts` (PublishCheck, WorkspacePublishCheck, PublishProgress); they are declared
 * structurally here because the extension bundle does not import from the CLI's source tree.
 * Every string that came from the CLI or the server is HTML-escaped before it reaches the page.
 *
 * Spec: specs/capabilities/integration-surfaces.md (extension-team-publish)
 */

export interface TeamServerInfo { url: string; reachable: boolean; signedIn: boolean; role?: string; features: string[] }
export interface TeamRepoCheck {
  schema?: string;
  project: string;
  key?: string;
  server?: TeamServerInfo;
  local?: { commit?: string; branch?: string; latestRun?: { runId: string; files: number; bytes: number } };
  remote?: { snapshotId: string; createdAt: string; commit?: string; latestRun?: { runId: string; status: string; files: number; bytes: number } } | null;
  needsPublish: boolean;
  exact?: boolean;
  reasons: string[];
  specFiles?: { added: string[]; removed: string[]; modified: string[] };
  commitDiffers?: boolean;
  error?: string;
}
export interface TeamRepoError { key: string; error: string }
export interface TeamCheck {
  schema?: string;
  workspace: string;
  server: TeamServerInfo;
  definition: { needsPublish: boolean; reasons: string[] };
  repos: Array<TeamRepoCheck | TeamRepoError>;
}
export interface TeamProgress { sg: 'progress'; key?: string; phase: 'hash' | 'upload' | 'commit'; done: number; total: number; bytes: number }

export const WORKSPACE_CHECK_SCHEMA = 'specguard-workspace-publish-check/1';

export type CliLine = { kind: 'progress'; progress: TeamProgress } | { kind: 'text'; text: string };

/** One line of CLI output: an NDJSON progress record (`--progress-json`) or plain text. */
export function parseCliLine(line: string): CliLine {
  const trimmed = line.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const v = JSON.parse(trimmed) as Partial<TeamProgress>;
      if (v && v.sg === 'progress' && (v.phase === 'hash' || v.phase === 'upload' || v.phase === 'commit')) {
        const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
        return { kind: 'progress', progress: { sg: 'progress', ...(typeof v.key === 'string' ? { key: v.key } : {}), phase: v.phase, done: n(v.done), total: n(v.total), bytes: n(v.bytes) } };
      }
    } catch { /* not JSON: plain text */ }
  }
  return { kind: 'text', text: line };
}

/** Find the workspace check in the CLI's output lines (stdout and stderr arrive mixed); progress lines and logs are skipped. */
export function parseCheckOutput(lines: string[]): { check?: TeamCheck; text: string[] } {
  const text = lines.filter((l) => parseCliLine(l).kind === 'text' && l.trim() !== '');
  const isCheck = (v: unknown): v is TeamCheck => !!v && typeof v === 'object' && (v as TeamCheck).schema === WORKSPACE_CHECK_SCHEMA && Array.isArray((v as TeamCheck).repos);
  // The CLI prints the pipeline result, which carries the check under `publish`; older builds printed the check itself.
  const unwrap = (v: unknown): TeamCheck | undefined => (isCheck(v) ? v : v && typeof v === 'object' && isCheck((v as { publish?: unknown }).publish) ? (v as { publish: TeamCheck }).publish : undefined);
  const joined = text.join('\n');
  const from = joined.indexOf('{');
  const to = joined.lastIndexOf('}');
  if (from >= 0 && to > from) {
    try { const v = unwrap(JSON.parse(joined.slice(from, to + 1))); if (v) return { check: v, text }; } catch { /* try line by line */ }
  }
  for (const l of text) {
    try { const v = unwrap(JSON.parse(l)); if (v) return { check: v, text }; } catch { /* next */ }
  }
  return { text };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

export type RepoStatus = 'up-to-date' | 'needs-publish' | 'never-published' | 'error';

const isError = (e: TeamRepoCheck | TeamRepoError): e is TeamRepoError | (TeamRepoCheck & { error: string }) => typeof (e as { error?: unknown }).error === 'string' && (e as { error: string }).error !== '';
export const repoKey = (e: TeamRepoCheck | TeamRepoError): string => e.key ?? ('project' in e ? e.project : '');

export function repoStatus(e: TeamRepoCheck | TeamRepoError): RepoStatus {
  if (isError(e)) return 'error';
  if (!(e as TeamRepoCheck).needsPublish) return 'up-to-date';
  return (e as TeamRepoCheck).reasons.includes('never-published') ? 'never-published' : 'needs-publish';
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The reasons of a repo as one short line, e.g. "3 specs changed · proofs changed · new run (412 MB)". */
export function reasonsText(c: TeamRepoCheck): string {
  const parts: string[] = [];
  for (const r of c.reasons) {
    if (r === 'never-published') continue;
    if (r === 'specs-changed') {
      const f = c.specFiles;
      const n = f ? f.added.length + f.removed.length + f.modified.length : 0;
      parts.push(n > 0 ? `${count(n, 'spec')} changed` : 'specs changed');
    } else if (r === 'trace-changed') parts.push('test trace changed');
    else if (r === 'proofs-changed') parts.push('proofs changed');
    else if (r === 'plans-changed') parts.push('plans changed');
    else if (r === 'contracts-changed') parts.push('contracts changed');
    else if (r === 'new-run') parts.push(c.local?.latestRun ? `new run (${formatBytes(c.local.latestRun.bytes)})` : 'new run');
    else if (r === 'run-evidence-incomplete') parts.push('run evidence incomplete');
    else if (r === 'server-cannot-compare') parts.push('server cannot compare, commits only');
    else parts.push(r);
  }
  return parts.join(' · ');
}

/** Bytes of test evidence a publish with evidence would still upload: the local latest run, unless the server already holds it complete. */
export function evidenceBytes(e: TeamRepoCheck | TeamRepoError): number {
  if (isError(e)) return 0;
  const c = e as TeamRepoCheck;
  const local = c.local?.latestRun;
  if (!local) return 0;
  const remote = c.remote?.latestRun;
  if (remote && remote.runId === local.runId && remote.status === 'complete') return 0;
  return local.bytes;
}

export const totalEvidenceBytes = (check: TeamCheck): number => check.repos.reduce((s, e) => s + evidenceBytes(e), 0);

export type PublishAction = 'check' | 'publish' | 'definition';

/** Command line for an action. The token is never part of it (it travels in the environment). `key` is validated: it must not look like a flag. */
export function publishArgs(action: PublishAction, key?: string, evidence = false): string[] {
  // The check counts an unpublished run only when evidence is being published, so the toggle is part of the check too.
  if (action === 'check') return ['workspace', 'publish', '--check', '--json', ...(evidence ? ['--evidence'] : [])];
  if (action === 'definition') return ['workspace', 'publish'];
  const args = ['workspace', 'publish', '--repos'];
  if (key !== undefined) {
    if (!key || key.startsWith('-') || /[,\s]/.test(key)) throw new Error(`Invalid repository key: ${JSON.stringify(key)}`);
    args.push('--only', key);
  }
  args.push('--progress-json');
  if (evidence) args.push('--evidence');
  return args;
}

/** The server's report page for the workspace or one repo, or undefined when the key is not in the check. */
export function reportUrl(check: TeamCheck, key?: string): string | undefined {
  const base = check.server.url.replace(/\/+$/, '');
  if (!base || !/^https?:\/\//i.test(base)) return undefined;
  const ws = `${base}/api/v1/workspaces/${encodeURIComponent(check.workspace)}/report`;
  if (key === undefined) return `${ws}/index.html`;
  return check.repos.some((r) => repoKey(r) === key) ? `${ws}/repos/${encodeURIComponent(key)}/index.html` : undefined;
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface TeamModel {
  /** checking: a check is running; publishing: a publish is running; idle otherwise. */
  phase: 'idle' | 'checking' | 'publishing';
  /** Nothing configured: no check was run. */
  noServer?: boolean;
  check?: TeamCheck;
  /** The check or publish failed; shown with whatever the CLI said. */
  error?: string;
  evidence: boolean;
  progress?: TeamProgress;
  /** The last plain lines the CLI printed during a publish. */
  log?: string[];
  /** Set while publishing one repo, or empty string for all. */
  busyKey?: string;
}

const PHASE: Record<TeamProgress['phase'], string> = { hash: 'Hashing files', upload: 'Uploading', commit: 'Finishing' };

function progressHtml(p: TeamProgress): string {
  const label = `${esc(p.key ?? 'workspace')}: ${PHASE[p.phase]} ${p.done}/${p.total}${p.bytes ? ` (${esc(formatBytes(p.bytes))})` : ''}`;
  return `<div class="team-progress"><progress max="${p.total || 1}" value="${Math.min(p.done, p.total || 1)}"></progress> <span>${label}</span></div>`;
}

const BADGE: Record<RepoStatus, { cls: string; label: string }> = {
  'up-to-date': { cls: 'ok', label: 'Up to date' },
  'needs-publish': { cls: 'warn', label: 'Needs publish' },
  'never-published': { cls: 'warn', label: 'Never published' },
  error: { cls: 'bad', label: 'Error' },
};

/** The whole Team server section. Everything that is not a literal below is escaped. */
export function teamSectionHtml(m: TeamModel): string {
  const busy = m.phase !== 'idle';
  const dis = busy ? ' disabled' : '';
  const head = '<div class="section-title">Team server<button class="help-btn" data-act="help" data-help="workspace.teamServer" aria-label="Help: Team server in the workspace">?</button></div>';
  if (m.noServer) {
    return `<section id="team" class="team">${head}<div class="team-card"><p>No team server is configured. Set the server in Workspace Settings to publish specs and test reports.</p><button class="btn" data-act="settings">Open Workspace Settings</button></div></section>`;
  }
  const c = m.check;
  const server = c?.server;
  const signed = !server ? '' : !server.reachable ? 'Server not reachable' : server.signedIn ? `Signed in${server.role ? ` as ${esc(server.role)}` : ''}` : 'Not signed in';
  const info = server ? `<div class="team-info"><span class="team-url">${esc(server.url)}</span><span class="badge ${server.reachable && server.signedIn ? 'ok' : 'bad'}">${signed}</span>${server.reachable && !server.signedIn ? '<button class="btn secondary" data-act="teamSignIn">Sign in</button>' : ''}</div>` : '';
  const err = m.error ? `<p class="team-error" role="alert">${esc(m.error)}</p>` : '';
  const canPublish = !!server && server.reachable && server.signedIn && server.role !== 'viewer';
  const roleNote = server && server.reachable && server.signedIn && server.role === 'viewer' ? '<p class="muted">Publishing needs the maintainer role; your role is viewer.</p>' : '';
  const rows = (c?.repos ?? []).map((e) => {
    const key = repoKey(e);
    const st = repoStatus(e);
    const b = BADGE[st];
    const detail = isError(e) ? esc(e.error) : st === 'up-to-date' ? '' : st === 'never-published' ? esc(reasonsText(e as TeamRepoCheck) || 'No snapshot on the server yet') : esc(reasonsText(e as TeamRepoCheck));
    const bytes = evidenceBytes(e);
    const can = canPublish && !busy && st !== 'error' && st !== 'up-to-date';
    const mine = m.phase === 'publishing' && (m.busyKey === '' || m.busyKey === key);
    return `<tr><td class="team-key">${esc(key)}</td><td><span class="badge ${b.cls}">${b.label}</span></td><td class="team-detail">${detail}${bytes && st !== 'up-to-date' ? ` <small>test evidence ${esc(formatBytes(bytes))}</small>` : ''}${mine && m.progress && (m.progress.key === key || m.progress.key === undefined) ? progressHtml(m.progress) : ''}</td><td><button class="btn secondary" data-act="teamPublish" data-key="${esc(key)}"${can ? '' : ' disabled'}>Publish</button></td></tr>`;
  }).join('');
  const table = c ? (rows ? `<div class="table-wrap"><table class="catalog-table team-table"><tbody>${rows}</tbody></table></div>` : '<p class="muted">The workspace has no repositories to publish.</p>') : m.phase === 'checking' ? '<p class="muted">Checking the server…</p>' : '';
  const anyNeeds = !!c && c.repos.some((e) => repoStatus(e) === 'needs-publish' || repoStatus(e) === 'never-published');
  const total = c ? totalEvidenceBytes(c) : 0;
  const defNeeds = !!c?.definition.needsPublish;
  const toolbar = `<div class="contracts-bar team-bar">
<button class="btn secondary" data-act="teamCheck"${dis}>Check</button>
<button class="btn" data-act="teamPublishAll"${canPublish && !busy && anyNeeds ? '' : ' disabled'}>Publish all</button>
<label class="team-evidence"><input type="checkbox" data-team-evidence${m.evidence ? ' checked' : ''}${dis}> Include test evidence${c ? ` <small>(${total > 0 ? `${esc(formatBytes(total))} still to upload` : 'nothing to upload'})</small>` : ''}</label>
<span class="ml-auto"></span>
<button class="btn secondary" data-act="teamPublishDef"${canPublish && !busy ? '' : ' disabled'}>Publish workspace definition${defNeeds ? ' (changed)' : ''}</button>
<button class="btn secondary" data-act="teamOpenReport"${c && server?.reachable ? '' : ' disabled'}>Open server report</button>
</div>`;
  const note = '<p class="muted small">Screenshots, videos and traces are uploaded only when "Include test evidence" is on. They can show data from your test environments.</p>';
  const overall = m.phase === 'publishing' && m.progress && !(m.busyKey ?? '') && !m.progress.key ? progressHtml(m.progress) : '';
  const log = m.log && m.log.length ? `<pre class="team-log">${esc(m.log.slice(-6).join('\n'))}</pre>` : '';
  return `<section id="team" class="team">${head}<div class="team-card">${info}${err}${roleNote}${table}${overall}${toolbar}${note}${log}</div></section>`;
}
