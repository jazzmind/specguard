/**
 * `specguard report`: a static regression and gap report for a recorded run.
 *
 * Reads the spec trace (claims and their linked tests), the proof ledger and the run indexes that
 * `results ingest` wrote, and renders one self-contained folder: `index.html` (inline CSS and JS, no
 * network) with the evidence files copied beside it, and `report.json` with the same data.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { parseClaimRef } from '../core/claims.js';
import { EVIDENCE_DIR, listRunIndexes, type RunIndex, type RunIndexTest, type RunVerdict } from '../core/evidence.js';
import { ExitCode } from '../core/exit-codes.js';
import { readFile } from '../core/reader.js';
import { analyzeTestFile, resolveStrengthConfig, testLanguageOf } from '../core/test-strength.js';
import type { TraceClaim, TraceNode } from '../core/trace.js';
import { emptyResult, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { loadTrace } from './check.js';

export const REPORT_SCHEMA = 'specguard-report/1';

export type GapKind = 'untested' | 'linked-not-executed' | 'weak-only' | 'partial' | 'failed' | 'proven';
export const GAP_KINDS: GapKind[] = ['failed', 'untested', 'linked-not-executed', 'weak-only', 'partial', 'proven'];

export interface ReportOpts {
  /** Output directory, relative to the project root. Default `.specguard/report`. */
  out?: string;
  /** Run to report. Default: the latest. */
  run?: string;
  /** Run to diff against. Default: the previous run with the same label, else the previous run. */
  baseline?: string;
  format?: 'html' | 'json';
  /** Link back to a workspace report, shown at the top of the page (set by `report --workspace`). */
  backHref?: string;
}

export interface ReportAttachment {
  name: string;
  contentType?: string;
  kind: 'image' | 'video' | 'trace' | 'file';
  /** Path relative to `.specguard/evidence`. */
  path: string;
  /** Link relative to the report folder. */
  href: string;
}

export interface ReportTest {
  title: string;
  file: string;
  /** `not-run` for a test linked by a tag that the run did not report. */
  status: 'pass' | 'fail' | 'skip' | 'not-run';
  durationMs: number;
  layer?: string;
  attachments: ReportAttachment[];
}

export interface ReportClaim {
  ref: string;
  text: string;
  /** Verdict in the reported run; absent when the run did not exercise the claim. */
  verdict?: RunVerdict;
  /** Effective proof in the ledger (proven, stale, failed, unproven, ...). */
  proof: string;
  gap: GapKind;
  reason: string;
  tests: ReportTest[];
  /** Tests that are only partial evidence (verdict and media shown, never counted as proof). */
  partialTests: ReportTest[];
}

export interface ReportCapability {
  id: string;
  title: string;
  counts: Record<GapKind, number>;
  claims: ReportClaim[];
}

export interface RunMeta {
  runId: string;
  label?: string;
  ingestedAt: string;
  layers: string[];
  formats: string[];
}

export interface Tally {
  pass: number;
  fail: number;
  skip: number;
}

export interface ClaimChange {
  claim: string;
  from?: RunVerdict;
  to?: RunVerdict;
}

export interface TestChange {
  key: string;
  title: string;
  file: string;
  from?: string;
  to?: string;
}

export interface Regression {
  baseline: RunMeta | null;
  claims: { newlyFailing: ClaimChange[]; newlyProven: ClaimChange[]; newlyUnexercised: ClaimChange[]; removed: ClaimChange[] };
  tests: { newlyFailing: TestChange[]; newlyPassing: TestChange[]; added: TestChange[]; removed: TestChange[] };
  /** Tests whose outcome flipped at least twice over the recent runs with the same label (P = pass, F = fail). */
  flaky: Array<{ key: string; title: string; file: string; history: string }>;
}

export interface TopGap {
  claim: string;
  capability: string;
  gap: GapKind;
  reason: string;
  score: number;
}

export interface ReportData {
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  run: RunMeta | null;
  totals: {
    tests: Tally & { total: number; byLayer: Record<string, Tally> };
    claims: { proven: number; failed: number; unexercised: number; untested: number; byLayer: Record<string, { proven: number; failed: number; unexercised: number }> };
  };
  capabilities: ReportCapability[];
  regression: Regression;
  gaps: { counts: Record<GapKind, number>; top: TopGap[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `specKey#claim`, or undefined for a ref that is malformed or names an example row. */
export function normRef(ref: string): string | undefined {
  const p = parseClaimRef(ref);
  if (!p || p.exampleId) return undefined;
  return `${p.specKey}#${p.claimId}`;
}

const meta = (r: RunIndex): RunMeta => ({ runId: r.runId, ...(r.label ? { label: r.label } : {}), ingestedAt: r.ingestedAt, layers: r.layers, formats: r.formats });

const emptyGapCounts = (): Record<GapKind, number> => ({ failed: 0, untested: 0, 'linked-not-executed': 0, 'weak-only': 0, partial: 0, proven: 0 });

function attachmentKind(name: string, contentType: string | undefined): ReportAttachment['kind'] {
  const ct = (contentType ?? '').toLowerCase();
  const ext = path.extname(name).toLowerCase();
  if (ct.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (ct.startsWith('video/') || ['.webm', '.mp4', '.mov'].includes(ext)) return 'video';
  if (/trace/i.test(name) && (ext === '.zip' || ct === 'application/zip')) return 'trace';
  return 'file';
}

const hrefOf = (stored: string): string => `evidence/${stored.split('/').map(encodeURIComponent).join('/')}`;

/** The run to report and the one to diff against. */
export function chooseRuns(runs: RunIndex[], opts: { run?: string; baseline?: string }): { run?: RunIndex; baseline?: RunIndex; error?: string } {
  if (runs.length === 0) return {};
  let run: RunIndex | undefined;
  if (opts.run) {
    run = runs.find((r) => r.runId === opts.run);
    if (!run) return { error: `no run "${opts.run}"; known: ${runs.map((r) => r.runId).join(', ')}` };
  } else {
    run = runs[runs.length - 1];
  }
  let baseline: RunIndex | undefined;
  if (opts.baseline) {
    baseline = runs.find((r) => r.runId === opts.baseline);
    if (!baseline) return { error: `no baseline run "${opts.baseline}"; known: ${runs.map((r) => r.runId).join(', ')}` };
  } else {
    const earlier = runs.filter((r) => r !== run && r.ingestedAt <= run!.ingestedAt);
    baseline = [...earlier].reverse().find((r) => (r.label ?? '') === (run!.label ?? '')) ?? earlier[earlier.length - 1];
  }
  return { run, baseline };
}

type TestOutcome = 'pass' | 'fail' | 'skip';
const testKey = (t: { file: string; title: string }): string => `${t.file}::${t.title}`;

/** One outcome per test key: a failure wins, then a pass, then a skip. */
function outcomes(run: RunIndex): Map<string, { outcome: TestOutcome; test: RunIndexTest }> {
  const rank: Record<TestOutcome, number> = { fail: 2, pass: 1, skip: 0 };
  const m = new Map<string, { outcome: TestOutcome; test: RunIndexTest }>();
  for (const t of run.tests) {
    const k = testKey(t);
    const prev = m.get(k);
    if (!prev || rank[t.status] > rank[prev.outcome]) m.set(k, { outcome: t.status, test: t });
  }
  return m;
}

const FLAKY_WINDOW = 10;

/** Compare a run with a baseline, and look for flaky tests over the recent history. Pure: no I/O. */
export function diffRuns(run: RunIndex, baseline: RunIndex | undefined, history: RunIndex[] = []): Regression {
  const out: Regression = {
    baseline: baseline ? meta(baseline) : null,
    claims: { newlyFailing: [], newlyProven: [], newlyUnexercised: [], removed: [] },
    tests: { newlyFailing: [], newlyPassing: [], added: [], removed: [] },
    flaky: [],
  };
  const claimsOf = (r: RunIndex): Map<string, RunVerdict> => {
    const m = new Map<string, RunVerdict>();
    for (const c of r.claims) {
      const key = normRef(c.claim);
      if (key) m.set(key, c.verdict);
    }
    return m;
  };
  if (baseline) {
    const cur = claimsOf(run);
    const base = claimsOf(baseline);
    for (const [claim, to] of [...cur].sort(([a], [b]) => a.localeCompare(b))) {
      const from = base.get(claim);
      if (to === 'failed' && from !== 'failed') out.claims.newlyFailing.push({ claim, from, to });
      else if (to === 'proven' && from !== 'proven') out.claims.newlyProven.push({ claim, from, to });
      else if (to === 'unexercised' && (from === 'proven' || from === 'failed')) out.claims.newlyUnexercised.push({ claim, from, to });
    }
    for (const [claim, from] of [...base].sort(([a], [b]) => a.localeCompare(b))) if (!cur.has(claim)) out.claims.removed.push({ claim, from });

    const curT = outcomes(run);
    const baseT = outcomes(baseline);
    const change = (key: string, t: RunIndexTest, from?: string, to?: string): TestChange => ({ key, title: t.title, file: t.file, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    for (const [key, { outcome, test }] of curT) {
      const before = baseT.get(key)?.outcome;
      if (before === undefined) out.tests.added.push(change(key, test, undefined, outcome));
      else if (outcome === 'fail' && before !== 'fail') out.tests.newlyFailing.push(change(key, test, before, outcome));
      else if (outcome === 'pass' && before === 'fail') out.tests.newlyPassing.push(change(key, test, before, outcome));
    }
    for (const [key, { test, outcome }] of baseT) if (!curT.has(key)) out.tests.removed.push(change(key, test, outcome));
  }

  // Flaky: over the last runs with this label up to and including this one, the outcome flipped pass/fail at least twice.
  const window = [...history.filter((r) => r.runId !== run.runId && (r.label ?? '') === (run.label ?? '') && r.ingestedAt <= run.ingestedAt), run].slice(-FLAKY_WINDOW);
  if (window.length >= 3) {
    const perRun = window.map(outcomes);
    for (const [key, { test }] of perRun[perRun.length - 1]) {
      const seq = perRun.map((m) => m.get(key)?.outcome).filter((o): o is TestOutcome => o === 'pass' || o === 'fail');
      let flips = 0;
      for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips += 1;
      if (flips >= 2) out.flaky.push({ key, title: test.title, file: test.file, history: seq.map((o) => (o === 'pass' ? 'P' : 'F')).join('') });
    }
  }
  return out;
}

const GAP_SCORE: Record<GapKind, number> = { failed: 100, untested: 60, 'linked-not-executed': 50, 'weak-only': 40, partial: 30, proven: 0 };

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Strength class of each linked source test, by title. Best effort: an unreadable file yields nothing. */
async function weakOnly(config: SpecGuardConfig, root: string, claim: TraceClaim, cache: Map<string, Map<string, string>>): Promise<boolean> {
  const classes: string[] = [];
  const cfg = resolveStrengthConfig(config.testStrength);
  for (const entry of claim.tests) {
    if (entry.origin !== 'source' || !entry.title || !testLanguageOf(entry.file)) continue;
    let byTitle = cache.get(entry.file);
    if (!byTitle) {
      byTitle = new Map();
      try {
        for (const s of analyzeTestFile(await readFile(path.join(root, entry.file)), entry.file, cfg)) byTitle.set(s.test.title, s.class);
      } catch {
        /* unreadable test file */
      }
      cache.set(entry.file, byTitle);
    }
    const cls = byTitle.get(entry.title);
    if (cls) classes.push(cls);
  }
  return classes.length > 0 && classes.every((c) => c === 'weak');
}

export async function buildReport(
  config: SpecGuardConfig,
  runs: RunIndex[],
  chosen: { run?: RunIndex; baseline?: RunIndex },
): Promise<ReportData> {
  const root = config.rootDir ?? process.cwd();
  const { model } = await loadTrace(config);
  const run = chosen.run;
  const runClaims = new Map<string, RunIndex['claims'][number]>();
  for (const c of run?.claims ?? []) {
    const k = normRef(c.claim);
    if (k) runClaims.set(k, c);
  }
  const runTestsOf = (ref: string): RunIndexTest[] => (run?.tests ?? []).filter((t) => t.claims.some((c) => normRef(c) === ref));
  const partialTestsOf = (ref: string): RunIndexTest[] => (run?.tests ?? []).filter((t) => (t.partialClaims ?? []).some((c) => normRef(c) === ref));
  const strengthCache = new Map<string, Map<string, string>>();

  const capabilities: ReportCapability[] = [];
  const gapTotals = emptyGapCounts();
  const top: TopGap[] = [];
  const specNodes = model.nodes.filter((n: TraceNode) => n.kind === 'capability' || n.kind === 'component');
  for (const node of specNodes) {
    const cap: ReportCapability = { id: node.id, title: node.title, counts: emptyGapCounts(), claims: [] };
    for (const claim of node.claims) {
      const inRun = runClaims.get(claim.ref);
      const toReportTest = (t: RunIndexTest): ReportTest => ({
        title: t.title,
        file: t.file,
        status: t.status,
        durationMs: t.durationMs,
        ...(t.layer ? { layer: t.layer } : {}),
        attachments: t.attachments.map((a) => ({ name: a.name, ...(a.contentType ? { contentType: a.contentType } : {}), kind: attachmentKind(a.name || a.path, a.contentType), path: a.path, href: hrefOf(a.path) })),
      });
      const tests: ReportTest[] = runTestsOf(claim.ref).map(toReportTest);
      const partialTests: ReportTest[] = partialTestsOf(claim.ref).map(toReportTest);
      const seen = new Set(tests.map((t) => t.title));
      for (const linked of claim.tests) {
        if (linked.title && seen.has(linked.title)) continue;
        tests.push({ title: linked.title ?? '(tagged test)', file: linked.file, status: 'not-run', durationMs: 0, attachments: [] });
      }
      // Without a run the ledger's verdict stands in for the run's.
      const verdict: RunVerdict | undefined = inRun ? inRun.verdict : run ? undefined : claim.proof === 'proven' ? 'proven' : claim.proof === 'failed' ? 'failed' : undefined;
      let gap: GapKind;
      let reason: string;
      if (tests.length === 0) {
        gap = 'untested';
        reason = partialTests.length > 0 ? `no test proves this claim outright; ${partialTests.length} test(s) give partial evidence only` : 'no test is linked to this claim';
      } else if (verdict === 'failed') {
        gap = 'failed';
        reason = `${inRun?.counterexamples ?? 0} failing test(s)`;
      } else if (verdict === undefined || verdict === 'unexercised') {
        gap = 'linked-not-executed';
        reason = `${tests.length} linked test(s), none passed or failed in this run`;
      } else if (await weakOnly(config, root, claim, strengthCache)) {
        gap = 'weak-only';
        reason = 'every linked test asserts too little to prove the claim';
      } else if (claim.missing && claim.missing.length > 0) {
        gap = 'partial';
        reason = `required layer(s) without proof: ${claim.missing.join(', ')}`;
      } else {
        gap = 'proven';
        reason = 'passed with no failing test';
      }
      cap.claims.push({ ref: claim.ref, text: claim.text, ...(verdict ? { verdict } : {}), proof: claim.proof, gap, reason, tests, partialTests });
      cap.counts[gap] += 1;
      gapTotals[gap] += 1;
      if (gap !== 'proven') top.push({ claim: claim.ref, capability: node.id, gap, reason, score: GAP_SCORE[gap] });
    }
    capabilities.push(cap);
  }
  // A capability with more gaps comes first in the ranking of equal kinds.
  const gapsIn = new Map(capabilities.map((c) => [c.id, c.claims.length - c.counts.proven]));
  top.sort((a, b) => b.score - a.score || (gapsIn.get(b.capability) ?? 0) - (gapsIn.get(a.capability) ?? 0) || a.claim.localeCompare(b.claim));

  const tally = (rows: RunIndexTest[]): Tally => ({ pass: rows.filter((t) => t.status === 'pass').length, fail: rows.filter((t) => t.status === 'fail').length, skip: rows.filter((t) => t.status === 'skip').length });
  const layers = new Set((run?.tests ?? []).map((t) => t.layer ?? 'unclassified'));
  const byLayer: Record<string, Tally> = {};
  const claimsByLayer: Record<string, { proven: number; failed: number; unexercised: number }> = {};
  for (const layer of [...layers].sort()) {
    byLayer[layer] = tally((run?.tests ?? []).filter((t) => (t.layer ?? 'unclassified') === layer));
    const row = { proven: 0, failed: 0, unexercised: 0 };
    for (const c of run?.claims ?? []) {
      const v = normRef(c.claim) ? c.layers[layer] : undefined;
      if (v) row[v] += 1;
    }
    claimsByLayer[layer] = row;
  }

  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    run: run ? meta(run) : null,
    totals: {
      tests: { total: run?.tests.length ?? 0, ...tally(run?.tests ?? []), byLayer },
      claims: { proven: gapTotals.proven + gapTotals['weak-only'] + gapTotals.partial, failed: gapTotals.failed, unexercised: gapTotals['linked-not-executed'], untested: gapTotals.untested, byLayer: claimsByLayer },
    },
    capabilities,
    regression: run ? diffRuns(run, chosen.baseline, runs) : diffRuns({ runId: '', ingestedAt: '', layers: [], formats: [], tests: [], claims: [], kind: 'results-ingest', version: 1 }, undefined),
    gaps: { counts: gapTotals, top: top.slice(0, 50) },
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const REPORT_CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2330;--mut:#667085;--line:#d9dde5;--ok:#157f3c;--bad:#b42318;--warn:#a15c07;--chip:#eef1f6}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ef;--mut:#98a2b3;--line:#2c323c;--ok:#4cc27d;--bad:#ff7b72;--warn:#e3a008;--chip:#222831}}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.mut{color:var(--mut)}table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.cards{display:flex;flex-wrap:wrap;gap:10px}.card{border:1px solid var(--line);border-radius:6px;padding:8px 12px;min-width:110px}.card b{display:block;font-size:20px}
.badge{display:inline-block;border-radius:10px;padding:0 8px;font-size:12px;background:var(--chip)}
.s-pass,.g-proven,.v-proven{color:var(--ok)}.s-fail,.g-failed,.v-failed{color:var(--bad)}.g-untested,.g-linked-not-executed,.g-weak-only,.g-partial,.s-skip,.s-not-run{color:var(--warn)}
details.claim{border:1px solid var(--line);border-radius:6px;margin:6px 0;padding:4px 10px}details.claim>summary{cursor:pointer}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.bar input{padding:4px 8px;min-width:240px}
button.chip{border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:12px;padding:2px 10px;cursor:pointer}button.chip.on{background:var(--fg);color:var(--bg)}
.att{display:flex;flex-wrap:wrap;gap:6px}.att img{max-height:90px;max-width:160px;border:1px solid var(--line);border-radius:4px}.att video{max-height:110px}
.hidden{display:none}code{font-family:ui-monospace,monospace;font-size:12px}
`;

const JS = `
(function(){
  var q=document.getElementById('q'),chips=[].slice.call(document.querySelectorAll('button.chip')),on={};
  function apply(){
    var t=(q.value||'').toLowerCase(),any=Object.keys(on).length>0;
    [].forEach.call(document.querySelectorAll('details.claim'),function(el){
      var ok=(!t||el.getAttribute('data-text').indexOf(t)>=0)&&(!any||on[el.getAttribute('data-gap')]);
      el.classList.toggle('hidden',!ok);
    });
    [].forEach.call(document.querySelectorAll('section.cap'),function(s){
      s.classList.toggle('hidden',!s.querySelector('details.claim:not(.hidden)'));
    });
  }
  chips.forEach(function(c){c.addEventListener('click',function(){
    var g=c.getAttribute('data-gap');
    if(on[g]){delete on[g];c.classList.remove('on')}else{on[g]=1;c.classList.add('on')}
    apply();
  })});
  q.addEventListener('input',apply);
})();
`;

function attachmentHtml(a: ReportAttachment): string {
  const href = esc(a.href);
  const label = esc(a.name || a.path);
  if (a.kind === 'image') return `<a href="${href}"><img src="${href}" alt="${label}" loading="lazy"></a>`;
  if (a.kind === 'video') return `<span><video controls preload="none" src="${href}"></video><br><a href="${href}">${label}</a></span>`;
  return `<a href="${href}" download>${a.kind === 'trace' ? 'trace: ' : ''}${label}</a>`;
}

const dur = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

function changeList(title: string, rows: Array<{ label: string; detail: string }>): string {
  if (rows.length === 0) return `<h3>${esc(title)} <span class="badge">0</span></h3>`;
  return `<h3>${esc(title)} <span class="badge">${rows.length}</span></h3><table><tbody>${rows.map((r) => `<tr><td><code>${esc(r.label)}</code></td><td class="mut">${esc(r.detail)}</td></tr>`).join('')}</tbody></table>`;
}

export function renderReportHtml(data: ReportData, backHref?: string): string {
  const run = data.run;
  const t = data.totals;
  const reg = data.regression;
  const card = (label: string, value: number | string, cls = ''): string => `<div class="card"><b class="${cls}">${esc(value)}</b>${esc(label)}</div>`;
  const parts: string[] = [];
  if (backHref) parts.push(`<p><a href="${esc(backHref)}">&larr; Workspace report</a></p>`);
  parts.push(`<h1>SpecGuard test report</h1>`);
  parts.push(
    run
      ? `<p class="mut">Run <code>${esc(run.runId)}</code>${run.label ? ` &middot; ${esc(run.label)}` : ''} &middot; ${esc(run.ingestedAt)} &middot; layers: ${esc(run.layers.join(', ') || 'none')}</p>`
      : `<p class="mut">No run has been recorded; verdicts come from the proof ledger. Run <code>specguard results ingest &lt;report&gt;</code> first.</p>`,
  );

  parts.push(`<h2 id="totals">Totals</h2><div class="cards">${card('tests', t.tests.total)}${card('passed', t.tests.pass, 's-pass')}${card('failed', t.tests.fail, 's-fail')}${card('skipped', t.tests.skip, 's-skip')}${card('claims proven', t.claims.proven, 'g-proven')}${card('claims failed', t.claims.failed, 'g-failed')}${card('claims unexercised', t.claims.unexercised, 'g-linked-not-executed')}${card('claims untested', t.claims.untested, 'g-untested')}</div>`);
  const layerRows = Object.keys(t.tests.byLayer);
  if (layerRows.length > 0) {
    parts.push(`<table><thead><tr><th>Layer</th><th>Pass</th><th>Fail</th><th>Skip</th><th>Claims proven</th><th>Claims failed</th><th>Claims unexercised</th></tr></thead><tbody>${layerRows
      .map((l) => `<tr><td>${esc(l)}</td><td>${t.tests.byLayer[l].pass}</td><td>${t.tests.byLayer[l].fail}</td><td>${t.tests.byLayer[l].skip}</td><td>${t.claims.byLayer[l]?.proven ?? 0}</td><td>${t.claims.byLayer[l]?.failed ?? 0}</td><td>${t.claims.byLayer[l]?.unexercised ?? 0}</td></tr>`)
      .join('')}</tbody></table>`);
  }

  parts.push(`<h2 id="claims">Capabilities and claims</h2><div class="bar"><input id="q" type="search" placeholder="Filter by claim, test, file"> ${GAP_KINDS.map((g) => `<button type="button" class="chip" data-gap="${esc(g)}">${esc(g)} (${data.gaps.counts[g]})</button>`).join(' ')}</div>`);
  for (const cap of data.capabilities) {
    parts.push(`<section class="cap"><h3>${esc(cap.id)} <span class="mut">${esc(cap.title)}</span> ${GAP_KINDS.filter((g) => cap.counts[g] > 0).map((g) => `<span class="badge g-${g}">${esc(g)} ${cap.counts[g]}</span>`).join(' ')}</h3>`);
    for (const c of cap.claims) {
      const haystack = [c.ref, c.text, c.gap, ...[...c.tests, ...c.partialTests].flatMap((x) => [x.title, x.file])].join(' ').toLowerCase();
      parts.push(`<details class="claim" data-gap="${esc(c.gap)}" data-text="${esc(haystack)}"><summary><span class="badge g-${esc(c.gap)}">${esc(c.gap)}</span> <code>${esc(c.ref)}</code> ${esc(c.text)} <span class="mut">&middot; verdict ${esc(c.verdict ?? 'none')} &middot; proof ${esc(c.proof)} &middot; ${c.tests.length} test(s)</span></summary><p class="mut">${esc(c.reason)}</p>`);
      if (c.tests.length > 0) {
        parts.push(`<table><thead><tr><th>Status</th><th>Duration</th><th>Test</th><th>Evidence</th></tr></thead><tbody>${c.tests
          .map((x) => `<tr><td class="s-${esc(x.status)}">${esc(x.status)}</td><td>${x.status === 'not-run' ? '' : esc(dur(x.durationMs))}</td><td><code>${esc(x.file)}</code>: ${esc(x.title)}${x.layer ? ` <span class="badge">${esc(x.layer)}</span>` : ''}</td><td><div class="att">${x.attachments.map(attachmentHtml).join('')}</div></td></tr>`)
          .join('')}</tbody></table>`);
      }
      if (c.partialTests.length > 0) {
        parts.push(`<p class="mut">Partial evidence (verdict and media shown; does not count as proof)</p><table><thead><tr><th>Status</th><th>Duration</th><th>Test</th><th>Evidence</th></tr></thead><tbody>${c.partialTests
          .map((x) => `<tr><td class="s-${esc(x.status)}">${esc(x.status)}</td><td>${esc(dur(x.durationMs))}</td><td><code>${esc(x.file)}</code>: ${esc(x.title)}${x.layer ? ` <span class="badge">${esc(x.layer)}</span>` : ''}</td><td><div class="att">${x.attachments.map(attachmentHtml).join('')}</div></td></tr>`)
          .join('')}</tbody></table>`);
      }
      parts.push(`</details>`);
    }
    parts.push(`</section>`);
  }

  parts.push(`<h2 id="regression">Regression diff</h2>`);
  if (!reg.baseline) {
    parts.push(`<p class="mut">No baseline run to compare with (only one run is recorded, or none).</p>`);
  } else {
    parts.push(`<p class="mut">Baseline <code>${esc(reg.baseline.runId)}</code>${reg.baseline.label ? ` &middot; ${esc(reg.baseline.label)}` : ''} &middot; ${esc(reg.baseline.ingestedAt)}</p>`);
    const cl = (rows: ClaimChange[]) => rows.map((r) => ({ label: r.claim, detail: `${r.from ?? 'none'} -> ${r.to ?? 'absent'}` }));
    const tl = (rows: TestChange[]) => rows.map((r) => ({ label: `${r.file}: ${r.title}`, detail: `${r.from ?? 'none'} -> ${r.to ?? 'absent'}` }));
    parts.push(changeList('Newly failing claims', cl(reg.claims.newlyFailing)));
    parts.push(changeList('Newly proven claims', cl(reg.claims.newlyProven)));
    parts.push(changeList('Newly unexercised claims', cl(reg.claims.newlyUnexercised)));
    parts.push(changeList('Claims no longer in the run', cl(reg.claims.removed)));
    parts.push(changeList('Newly failing tests', tl(reg.tests.newlyFailing)));
    parts.push(changeList('Newly passing tests', tl(reg.tests.newlyPassing)));
    parts.push(changeList('Tests added', tl(reg.tests.added)));
    parts.push(changeList('Tests removed', tl(reg.tests.removed)));
  }
  parts.push(changeList('Flaky tests (outcome flipped at least twice over recent runs)', reg.flaky.map((f) => ({ label: `${f.file}: ${f.title}`, detail: f.history }))));

  parts.push(`<h2 id="gaps">Gap analysis</h2><table><thead><tr><th>Capability</th>${GAP_KINDS.map((g) => `<th>${esc(g)}</th>`).join('')}</tr></thead><tbody>${data.capabilities
    .map((c) => `<tr><td>${esc(c.id)}</td>${GAP_KINDS.map((g) => `<td>${c.counts[g]}</td>`).join('')}</tr>`)
    .join('')}<tr><th>Total</th>${GAP_KINDS.map((g) => `<th>${data.gaps.counts[g]}</th>`).join('')}</tr></tbody></table>`);
  parts.push(`<h3>Top gaps</h3>${data.gaps.top.length === 0 ? '<p class="mut">No gaps.</p>' : `<table><thead><tr><th>#</th><th>Claim</th><th>Gap</th><th>Why</th></tr></thead><tbody>${data.gaps.top.slice(0, 25).map((g, i) => `<tr><td>${i + 1}</td><td><code>${esc(g.claim)}</code></td><td class="g-${esc(g.gap)}">${esc(g.gap)}</td><td class="mut">${esc(g.reason)}</td></tr>`).join('')}</tbody></table>`}`);

  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>SpecGuard test report</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${REPORT_CSS}</style></head><body>${parts.join('\n')}<script>${JS}</script></body></html>\n`;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runReport(config: SpecGuardConfig, opts: ReportOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('report');
  const root = config.rootDir ?? process.cwd();
  const runs = listRunIndexes(root);
  const chosen = chooseRuns(runs, opts);
  if (chosen.error) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(chosen.error);
    return result;
  }
  if (!chosen.run) result.messages.push('[warn] no recorded runs: the report shows ledger verdicts only (see `specguard results ingest`)');
  const data = await buildReport(config, runs, chosen);
  const out = path.resolve(root, opts.out ?? '.specguard/report');
  await writeFile(path.join(out, 'report.json'), JSON.stringify(data, null, 2) + '\n');
  if ((opts.format ?? 'html') === 'html') {
    let copied = 0;
    const wanted = new Set(data.capabilities.flatMap((c) => c.claims.flatMap((cl) => [...cl.tests, ...cl.partialTests].flatMap((t) => t.attachments.map((a) => a.path)))));
    for (const rel of wanted) {
      const from = path.join(root, EVIDENCE_DIR, rel);
      if (!existsSync(from)) continue;
      const to = path.join(out, 'evidence', rel);
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      copied += 1;
    }
    await writeFile(path.join(out, 'index.html'), renderReportHtml(data, opts.backHref));
    result.messages.push(`report: ${path.relative(root, path.join(out, 'index.html')) || 'index.html'} (${copied} evidence file(s) copied)`);
  }
  result.messages.push(`report: ${path.relative(root, path.join(out, 'report.json'))}`);
  const g = data.gaps.counts;
  result.messages.push(`gaps: ${g.failed} failed, ${g.untested} untested, ${g['linked-not-executed']} linked-not-executed, ${g['weak-only']} weak-only, ${g.partial} partial, ${g.proven} proven`);
  result.created = 1;
  return result;
}
