/**
 * `specguard report --workspace`: one landing page over every repo in the workspace manifest.
 *
 * Each non-ignored repo gets its own per-repo report (the same `runReport` output, evidence included) under
 * `<out>/repos/<key>/`; `<out>/index.html` rolls them up (tests, claims, gaps, regressions, evidence counts, a short
 * run history) and drills down into those reports. Extra artifacts a team wants linked from the landing page (a Playwright
 * HTML report, raw logs) go in `<workspace>/.specguard/report-links.json` as `[{ "title", "href", "note"? }]`.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../core/config.js';
import { readOverlayRegistry, realPathLoose } from '../core/overlay.js';
import { listRunIndexes, type RunIndex } from '../core/evidence.js';
import { ExitCode } from '../core/exit-codes.js';
import { emptyResult, type PipelineResult } from '../core/types.js';
import { loadWorkspace } from '../core/workspace.js';
import { writeFile } from '../core/writer.js';
import { GAP_KINDS, REPORT_CSS, esc, runReport, type ReportData, type GapKind } from './report.js';

export const WORKSPACE_REPORT_SCHEMA = 'specguard-workspace-report/1';
const HISTORY_RUNS = 8;

export interface WorkspaceReportOpts {
  /** Output directory; absolute, or relative to the workspace root. Default `.specguard/report/workspace`. */
  out?: string;
  /** Workspace root or manifest path (as for the other workspace commands). */
  workspace?: string;
}

export interface WorkspaceRepoReport {
  key: string;
  role: string;
  /** Link to the repo's own report, relative to the workspace report folder; absent when it could not be built. */
  href?: string;
  error?: string;
  run: ReportData['run'];
  tests: ReportData['totals']['tests'] | null;
  claims: ReportData['totals']['claims'] | null;
  gaps: Record<GapKind, number> | null;
  regression: { baseline: string | null; claimsNewlyFailing: number; claimsNewlyProven: number; testsNewlyFailing: number; testsNewlyPassing: number } | null;
  evidence: { screenshots: number; videos: number; traces: number; other: number };
  history: Array<{ runId: string; label?: string; ingestedAt: string; pass: number; fail: number; skip: number; claimsProven: number; claimsFailed: number }>;
  topGaps: Array<{ claim: string; gap: GapKind; reason: string }>;
}

export interface WorkspaceReportData {
  schema: typeof WORKSPACE_REPORT_SCHEMA;
  generatedAt: string;
  workspace: string;
  repos: WorkspaceRepoReport[];
  totals: { repos: number; tests: number; pass: number; fail: number; skip: number; claimsProven: number; claimsFailed: number; claimsUnexercised: number; claimsUntested: number; claimsTotal: number };
  links: Array<{ title: string; href: string; note?: string }>;
}

function evidenceCounts(data: ReportData): WorkspaceRepoReport['evidence'] {
  const seen = new Set<string>();
  const out = { screenshots: 0, videos: 0, traces: 0, other: 0 };
  for (const cap of data.capabilities) {
    for (const claim of cap.claims) {
      for (const t of [...claim.tests, ...claim.partialTests]) {
        for (const a of t.attachments) {
          if (seen.has(a.path)) continue;
          seen.add(a.path);
          if (a.kind === 'image') out.screenshots += 1;
          else if (a.kind === 'video') out.videos += 1;
          else if (a.kind === 'trace') out.traces += 1;
          else out.other += 1;
        }
      }
    }
  }
  return out;
}

/**
 * The workspace-report row for one repo, from its report data and its recorded runs. Pure (no disk): a team server builds the
 * same rows from the report data a client published.
 */
export function repoEntryFromData(key: string, role: string, data: ReportData, runs: Array<Pick<RunIndex, 'runId' | 'label' | 'ingestedAt' | 'tests' | 'claims'>>, href: string): WorkspaceRepoReport {
  return {
    key,
    role,
    href,
    run: data.run,
    tests: data.totals.tests,
    claims: data.totals.claims,
    gaps: data.gaps.counts,
    regression: {
      baseline: data.regression.baseline?.runId ?? null,
      claimsNewlyFailing: data.regression.claims.newlyFailing.length,
      claimsNewlyProven: data.regression.claims.newlyProven.length,
      testsNewlyFailing: data.regression.tests.newlyFailing.length,
      testsNewlyPassing: data.regression.tests.newlyPassing.length,
    },
    evidence: evidenceCounts(data),
    topGaps: data.gaps.top.slice(0, 5).map((g) => ({ claim: g.claim, gap: g.gap, reason: g.reason })),
    history: historyOf(runs),
  };
}

/** The last few runs as the sparkline rows. */
export function historyOf(runs: Array<Pick<RunIndex, 'runId' | 'label' | 'ingestedAt' | 'tests' | 'claims'>>): WorkspaceRepoReport['history'] {
  return runs.slice(-HISTORY_RUNS).map((r) => ({
    runId: r.runId,
    ...(r.label ? { label: r.label } : {}),
    ingestedAt: r.ingestedAt,
    pass: r.tests.filter((t) => t.status === 'pass').length,
    fail: r.tests.filter((t) => t.status === 'fail').length,
    skip: r.tests.filter((t) => t.status === 'skip').length,
    claimsProven: r.claims.filter((c) => c.verdict === 'proven').length,
    claimsFailed: r.claims.filter((c) => c.verdict === 'failed').length,
  }));
}

/** Totals across repo rows: the whole workspace report data. Pure. */
export function rollupWorkspace(workspace: string, repos: WorkspaceRepoReport[], links: WorkspaceReportData['links'] = [], generatedAt: string = new Date().toISOString()): WorkspaceReportData {
  const sum = (f: (r: WorkspaceRepoReport) => number): number => repos.reduce((s, r) => s + f(r), 0);
  return {
    schema: WORKSPACE_REPORT_SCHEMA,
    generatedAt,
    workspace,
    repos,
    totals: {
      repos: repos.length,
      tests: sum((r) => r.tests?.total ?? 0),
      pass: sum((r) => r.tests?.pass ?? 0),
      fail: sum((r) => r.tests?.fail ?? 0),
      skip: sum((r) => r.tests?.skip ?? 0),
      claimsProven: sum((r) => r.claims?.proven ?? 0),
      claimsFailed: sum((r) => r.claims?.failed ?? 0),
      claimsUnexercised: sum((r) => r.claims?.unexercised ?? 0),
      claimsUntested: sum((r) => r.claims?.untested ?? 0),
      claimsTotal: sum((r) => (r.gaps ? Object.values(r.gaps).reduce((a, b) => a + b, 0) : 0)),
    },
    links,
  };
}

function readLinks(root: string): WorkspaceReportData['links'] {
  const file = path.join(root, '.specguard', 'report-links.json');
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<{ title?: string; href?: string; note?: string }>;
    return raw
      .filter((l) => l.title && l.href)
      .map((l) => ({
        title: String(l.title),
        // Local paths become file URLs (relative ones resolve against the workspace root); URLs pass through.
        href: /^[a-z][a-z0-9+.-]*:\/\//i.test(String(l.href)) ? String(l.href) : pathToFileURL(path.resolve(root, String(l.href))).href,
        ...(l.note ? { note: l.note } : {}),
      }));
  } catch {
    return [];
  }
}

export async function runWorkspaceReport(cwd: string, opts: WorkspaceReportOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('report');
  const ws = await loadWorkspace(cwd, opts.workspace);
  const out = path.resolve(ws.rootDir, opts.out ?? '.specguard/report/workspace');
  await mkdir(out, { recursive: true });

  const repos: WorkspaceRepoReport[] = [];
  // An overlay repository only holds specs, tests and evidence FOR other projects; it is not a project and has no config of its own.
  const overlayRoots = new Set(readOverlayRegistry().registry.overlays.map((o) => realPathLoose(o.root)));
  for (const [key, repo] of Object.entries(ws.repos).sort(([a], [b]) => a.localeCompare(b))) {
    const dir = path.resolve(ws.rootDir, repo.path);
    if (overlayRoots.has(realPathLoose(dir)) && !existsSync(path.join(dir, '.specguard', 'config.json'))) {
      result.messages.push(`[info] ${key}: overlay repository, left out of the rollup (its projects are reported individually)`);
      continue;
    }
    const entry: WorkspaceRepoReport = { key, role: repo.role, run: null, tests: null, claims: null, gaps: null, regression: null, evidence: { screenshots: 0, videos: 0, traces: 0, other: 0 }, history: [], topGaps: [] };
    try {
      const config = await loadConfig(dir);
      const repoOut = path.join(out, 'repos', key);
      const res = await runReport(config, { out: repoOut, format: 'html', backHref: '../../index.html' });
      if (res.failed > 0) throw new Error(res.messages.join('; '));
      const data = JSON.parse(readFileSync(path.join(repoOut, 'report.json'), 'utf8')) as ReportData;
      Object.assign(entry, repoEntryFromData(key, repo.role, data, listRunIndexes(dir), `repos/${key}/index.html`));
    } catch (err) {
      entry.error = (err as Error).message;
      result.messages.push(`[warn] ${key}: ${entry.error}`);
    }
    repos.push(entry);
  }

  const data = rollupWorkspace(ws.name, repos, readLinks(ws.rootDir));
  await writeFile(path.join(out, 'workspace-report.json'), JSON.stringify(data, null, 2) + '\n');
  await writeFile(path.join(out, 'index.html'), renderWorkspaceReportHtml(data));
  result.created = repos.filter((r) => r.href).length;
  result.failed = repos.length > 0 && result.created === 0 ? 1 : 0;
  if (result.failed) result.exitCode = ExitCode.ValidationFailed;
  result.messages.push(`workspace report: ${path.relative(ws.rootDir, path.join(out, 'index.html'))} (${result.created} of ${repos.length} repo report(s))`);
  return result;
}

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((100 * n) / d)}%` : '-');

function gapBar(gaps: Record<GapKind, number>): string {
  const total = Object.values(gaps).reduce((a, b) => a + b, 0) || 1;
  const colour: Record<GapKind, string> = { proven: 'var(--ok)', failed: 'var(--bad)', untested: '#98a2b3', 'linked-not-executed': 'var(--warn)', 'weak-only': '#d0a15c', partial: '#7aa2f7' };
  const segs = (['proven', 'failed', 'partial', 'weak-only', 'linked-not-executed', 'untested'] as GapKind[])
    .filter((g) => gaps[g] > 0)
    .map((g) => `<i title="${esc(g)}: ${gaps[g]}" style="width:${((100 * gaps[g]) / total).toFixed(2)}%;background:${colour[g]}"></i>`)
    .join('');
  return `<div class="gapbar">${segs}</div>`;
}

function spark(history: WorkspaceRepoReport['history']): string {
  if (history.length < 2) return '<span class="mut">first run</span>';
  const maxv = Math.max(1, ...history.map((h) => h.pass + h.fail + h.skip));
  return `<span class="spark">${history
    .map((h) => `<i title="${esc(h.runId)}${h.label ? ` [${esc(h.label)}]` : ''}: ${h.pass} pass / ${h.fail} fail / ${h.skip} skip" style="height:${Math.max(2, Math.round((24 * (h.pass + h.fail + h.skip)) / maxv))}px;background:${h.fail > 0 ? 'var(--bad)' : 'var(--ok)'}"></i>`)
    .join('')}</span>`;
}

export function renderWorkspaceReportHtml(d: WorkspaceReportData): string {
  const t = d.totals;
  const card = (label: string, value: string | number, cls = ''): string => `<div class="card ${cls}"><b>${esc(value)}</b>${esc(label)}</div>`;
  const rows = d.repos
    .map((r) => {
      const name = r.href ? `<a href="${esc(r.href)}">${esc(r.key)}</a>` : esc(r.key);
      if (!r.tests || !r.claims || !r.gaps) return `<tr><td>${name} <span class="badge">${esc(r.role)}</span></td><td colspan="7" class="s-fail">${esc(r.error ?? 'no report')}</td></tr>`;
      const ev = r.evidence;
      const regr = r.regression;
      const regrCell = regr
        ? `${regr.claimsNewlyFailing > 0 ? `<span class="g-failed">${regr.claimsNewlyFailing} claim(s) newly failing</span><br>` : ''}${regr.testsNewlyFailing > 0 ? `<span class="g-failed">${regr.testsNewlyFailing} test(s) newly failing</span><br>` : ''}${regr.claimsNewlyProven > 0 ? `<span class="g-proven">${regr.claimsNewlyProven} newly proven</span>` : ''}${regr.baseline === null ? '<span class="mut">no baseline</span>' : regr.claimsNewlyFailing + regr.testsNewlyFailing + regr.claimsNewlyProven === 0 ? '<span class="mut">no change</span>' : ''}`
        : '';
      const total = Object.values(r.gaps).reduce((a, b) => a + b, 0);
      return `<tr><td>${name} <span class="badge">${esc(r.role)}</span><br><span class="mut">${esc(r.run?.label ?? r.run?.runId ?? 'no run')}</span></td>
<td>${r.tests.total}<br><span class="mut"><span class="s-pass">${r.tests.pass}</span> / <span class="s-fail">${r.tests.fail}</span> / ${r.tests.skip}</span></td>
<td>${r.claims.proven}<span class="mut"> / ${total} (${pct(r.claims.proven, total)})</span><br><span class="${r.claims.failed > 0 ? 's-fail' : 'mut'}">${r.claims.failed} failed</span></td>
<td>${gapBar(r.gaps)}</td>
<td>${regrCell}</td>
<td>${ev.screenshots} img &middot; ${ev.videos} video &middot; ${ev.traces} trace</td>
<td>${spark(r.history)}</td></tr>`;
    })
    .join('');
  const gapDetail = d.repos
    .filter((r) => r.topGaps.length > 0)
    .map((r) => `<h3>${esc(r.key)}</h3><ul>${r.topGaps.map((g) => `<li><span class="badge g-${esc(g.gap)}">${esc(g.gap)}</span> <code>${esc(g.claim)}</code> <span class="mut">${esc(g.reason)}</span></li>`).join('')}</ul>`)
    .join('');
  const links = d.links.length > 0 ? `<h2>More</h2><ul>${d.links.map((l) => `<li><a href="${esc(l.href)}">${esc(l.title)}</a>${l.note ? ` <span class="mut">&mdash; ${esc(l.note)}</span>` : ''}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.workspace)} - workspace report</title>
<style>${REPORT_CSS}
.gapbar{display:flex;height:12px;min-width:160px;border-radius:3px;overflow:hidden;background:var(--chip)}.gapbar i{display:block;height:100%}
.spark{display:inline-flex;gap:2px;align-items:flex-end;height:26px}.spark i{display:block;width:6px;border-radius:1px}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin:4px 0}.legend span::before{content:"";display:inline-block;width:10px;height:10px;margin-right:4px;border-radius:2px;background:var(--c)}
</style></head><body>
<h1>${esc(d.workspace)} &mdash; workspace report</h1>
<p class="mut">Generated ${esc(d.generatedAt)} &middot; ${t.repos} repos &middot; each repo name opens its full report (claims, tests, screenshots, video, traces).</p>
<div class="cards">${card('tests', t.tests)}${card('passed', t.pass, 's-pass')}${card('failed', t.fail, 's-fail')}${card('skipped', t.skip, 's-skip')}${card('claims proven', `${t.claimsProven}/${t.claimsTotal}`, 'g-proven')}${card('claims failed', t.claimsFailed, 'g-failed')}${card('claims untested', t.claimsUntested, 'g-untested')}</div>
<h2>Repos</h2>
<div class="legend">${GAP_KINDS.map((g) => `<span style="--c:${g === 'proven' ? 'var(--ok)' : g === 'failed' ? 'var(--bad)' : g === 'untested' ? '#98a2b3' : g === 'linked-not-executed' ? 'var(--warn)' : g === 'weak-only' ? '#d0a15c' : '#7aa2f7'}">${esc(g)}</span>`).join('')}</div>
<table><thead><tr><th>Repo</th><th>Tests<br><span class="mut">pass / fail / skip</span></th><th>Claims proven</th><th>Claim status</th><th>Since baseline</th><th>Evidence</th><th>Recent runs</th></tr></thead><tbody>${rows}</tbody></table>
${links}
<h2>Top gaps per repo</h2>${gapDetail || '<p class="mut">none</p>'}
</body></html>`;
}
