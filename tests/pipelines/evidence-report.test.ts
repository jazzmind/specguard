import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { listRunIndexes } from '../../src/core/evidence.js';
import { parseJunitResults, parsePlaywrightResults } from '../../src/core/test-results.js';
import { loadConfig } from '../../src/core/config.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import { runsList, runsPrune } from '../../src/pipelines/runs.js';
import { chooseRuns, diffRuns, renderReportHtml, runReport } from '../../src/pipelines/report.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const AUTH = 'capabilities/auth#login-valid-code';
const OUT = 'capabilities/auth#logout-clears-session';

function playwright(tests: Array<{ title: string; status?: string; attachments?: unknown[] }>): string {
  return JSON.stringify({
    config: {},
    suites: [
      {
        title: 'auth.spec.ts',
        file: 'auth.spec.ts',
        specs: tests.map((t) => ({
          title: t.title,
          file: 'auth.spec.ts',
          tests: [
            {
              projectName: 'chromium',
              status: t.status === 'failed' ? 'unexpected' : 'expected',
              expectedStatus: 'passed',
              results: [{ status: t.status ?? 'passed', duration: 12, attachments: t.attachments ?? [] }],
            },
          ],
        })),
      },
    ],
  });
}

describe('attachment parsing', () => {
  // [claims: capabilities/conformance-testing#test-attachments]
  it('reads Playwright attachments with a path and ignores entries without one', () => {
    const rows = parsePlaywrightResults(
      playwright([
        {
          title: `logs in @claim:${AUTH}`,
          attachments: [
            { name: 'screenshot', contentType: 'image/png', path: 'shots/a.png' },
            { name: 'video', contentType: 'video/webm', path: 'vid/a.webm' },
            { name: 'trace', contentType: 'application/zip', path: 'trace.zip' },
            { name: 'inline', contentType: 'text/plain', body: 'abc' },
          ],
        },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments?.map((a) => [a.name, a.contentType, a.path])).toEqual([
      ['screenshot', 'image/png', 'shots/a.png'],
      ['video', 'video/webm', 'vid/a.webm'],
      ['trace', 'application/zip', 'trace.zip'],
    ]);
  });

  // [claims: capabilities/conformance-testing#test-attachments]
  it('reads JUnit ATTACHMENT markers and attachment properties', () => {
    const xml = `<testsuites><testsuite name="s">
      <testcase classname="c" name="t1 @claim:${AUTH}" time="0.1">
        <properties><property name="attachment" value="out/one.png"/></properties>
        <system-out><![CDATA[log line
[[ATTACHMENT|out/two.png]]
[[ATTACHMENT|out/three.log]]]]></system-out>
      </testcase>
      <testcase classname="c" name="t2" time="0.1"/>
    </testsuite></testsuites>`;
    const rows = parseJunitResults(xml);
    expect(rows[0].attachments?.map((a) => a.path)).toEqual(['out/one.png', 'out/two.png', 'out/three.log']);
    expect(rows[1].attachments).toBeUndefined();
  });
});

describe('ingest evidence', () => {
  function setup() {
    const repo = makeV2Repo();
    repo.write('reports/shots/a.png', 'PNGDATA');
    repo.write('reports/shots/copy.png', 'PNGDATA');
    repo.write('reports/shots/b.png', 'OTHER');
    repo.write(
      'reports/pw.json',
      playwright([
        { title: `logs in @claim:${AUTH}`, attachments: [{ name: 'shot', contentType: 'image/png', path: 'shots/a.png' }, { name: 'gone', contentType: 'image/png', path: 'shots/missing.png' }] },
        { title: `logs out @claim:${OUT}`, status: 'failed', attachments: [{ name: 'shot2', contentType: 'image/png', path: 'shots/copy.png' }, { name: 'shot3', contentType: 'image/png', path: 'shots/b.png' }] },
      ]),
    );
    return repo;
  }

  // [claims: capabilities/conformance-testing#test-attachments]
  it('copies attachments content-addressed, dedups, counts missing, and records them on the ledger and run index', async () => {
    const repo = setup();
    const r = await runResultsIngest(['reports/pw.json'], repo.dir, { runId: 'run-a', runLabel: 'staging' });
    const dir = path.join(repo.dir, '.specguard', 'evidence', 'run-a');
    const names = readdirSync(dir).sort();
    // a.png and copy.png have equal content but different names: two files; the missing one is skipped.
    expect(names).toHaveLength(3);
    expect(names.every((n) => /^[0-9a-f]{16}-/.test(n))).toBe(true);
    expect(r.messages.join('\n')).toMatch(/1 attachment\(s\).*not found/);

    const ledger = JSON.parse(readFileSync(path.join(repo.dir, '.specguard', 'proofs.json'), 'utf8')).proofs;
    const row = ledger[AUTH];
    expect(row).toMatchObject({ verdict: 'proven', runId: 'run-a', runLabel: 'staging' });
    expect(row.tests[0]).toMatchObject({ title: expect.stringContaining('logs in'), status: 'pass', file: 'auth.spec.ts' });
    expect(row.tests[0].attachments[0]).toMatch(/^run-a\/[0-9a-f]{16}-a\.png$/);
    expect(existsSync(path.join(repo.dir, '.specguard', 'evidence', row.tests[0].attachments[0]))).toBe(true);

    const [index] = listRunIndexes(repo.dir);
    expect(index).toMatchObject({ runId: 'run-a', label: 'staging', kind: 'results-ingest' });
    expect(index.tests).toHaveLength(2);
    expect(index.claims.find((c) => c.claim === OUT)?.verdict).toBe('failed');

    // Ingesting again under the same run id stores nothing twice.
    await runResultsIngest(['reports/pw.json'], repo.dir, { runId: 'run-a' });
    expect(readdirSync(dir)).toHaveLength(3);
  });

  // [claims: capabilities/conformance-testing#test-attachments]
  it('honours --no-attachments and the size cap', async () => {
    const repo = setup();
    await runResultsIngest(['reports/pw.json'], repo.dir, { runId: 'none', attachments: false });
    expect(existsSync(path.join(repo.dir, '.specguard', 'evidence', 'none'))).toBe(false);
    const big = await runResultsIngest(['reports/pw.json'], repo.dir, { runId: 'cap', maxAttachmentMb: 0 });
    expect(big.messages.join('\n')).toMatch(/exceeded --max-attachment-mb/);
  });

  // [claims: capabilities/conformance-testing#test-attachments]
  it('loads a ledger written before attachments existed and keeps its rows', async () => {
    const repo = setup();
    const old = {
      version: 1,
      proofs: {
        'capabilities/shop#cart-totals': { claim: 'capabilities/shop#cart-totals', verdict: 'proven', runId: 'old', specHash: 'x', fileHashes: {}, exercised: 1, counterexamples: 0, ingestedAt: '2020-01-01T00:00:00.000Z' },
      },
    };
    writeFileSync(path.join(repo.dir, '.specguard', 'proofs.json'), JSON.stringify(old));
    const r = await runResultsIngest(['reports/pw.json'], repo.dir, { runId: 'new' });
    expect(r.messages.join('\n')).toContain('proof ingest');
    const ledger = JSON.parse(readFileSync(path.join(repo.dir, '.specguard', 'proofs.json'), 'utf8')).proofs;
    expect(ledger['capabilities/shop#cart-totals']).toMatchObject({ runId: 'old', verdict: 'proven' });
    expect(ledger['capabilities/shop#cart-totals'].tests).toBeUndefined();
    expect(ledger[AUTH].runId).toBe('new');
  });

  // [claims: capabilities/conformance-testing#run-index]
  it('lists runs and prunes older ones with their unreferenced evidence', async () => {
    const repo = setup();
    await runResultsIngest(['reports/pw.json'], repo.dir, { runId: 'r1' });
    repo.write('reports/shots/c.png', 'THIRD');
    repo.write('reports/pw2.json', playwright([{ title: `logs in @claim:${AUTH}`, attachments: [{ name: 'c', contentType: 'image/png', path: 'shots/c.png' }] }]));
    await runResultsIngest(['reports/pw2.json'], repo.dir, { runId: 'r2' });
    expect(runsList(repo.dir).runs.map((r) => r.runId)).toEqual(['r2', 'r1']);
    const pruned = await runsPrune(repo.dir, 1);
    expect(pruned.exitCode).toBe(0);
    expect(runsList(repo.dir).runs.map((r) => r.runId)).toEqual(['r2']);
    // r1's evidence is still named by the ledger rows r1 wrote that r2 did not replace (logout), so only unreferenced files go.
    const left = existsSync(path.join(repo.dir, '.specguard', 'evidence', 'r1')) ? readdirSync(path.join(repo.dir, '.specguard', 'evidence', 'r1')) : [];
    expect(left.length).toBeLessThan(3);
    expect(readdirSync(path.join(repo.dir, '.specguard', 'evidence', 'r2'))).toHaveLength(1);
  });
});

describe('regression diff', () => {
  const mk = (runId: string, at: string, rows: Array<[string, 'pass' | 'fail' | 'skip', string]>, label?: string) => {
    const tests = rows.map(([title, status, claim]) => ({ title, file: 'a.spec.ts', claims: [claim], status, durationMs: 1, attachments: [] }));
    return {
      kind: 'results-ingest' as const,
      version: 1 as const,
      runId,
      label,
      ingestedAt: at,
      layers: ['e2e'],
      formats: [],
      tests,
      claims: rows.map(([, status, claim]) => ({ claim, verdict: status === 'pass' ? ('proven' as const) : status === 'fail' ? ('failed' as const) : ('unexercised' as const), exercised: status === 'pass' ? 1 : 0, counterexamples: status === 'fail' ? 1 : 0, layers: { e2e: status === 'pass' ? ('proven' as const) : status === 'fail' ? ('failed' as const) : ('unexercised' as const) } })),
    };
  };

  // [claims: capabilities/traceability-and-drift#regression-report]
  it('classifies newly failing, newly proven, newly unexercised, removed and flaky', () => {
    const r1 = mk('r1', '2026-01-01T00:00:00Z', [['t1', 'pass', 'cap#one'], ['t2', 'fail', 'cap#two'], ['t3', 'pass', 'cap#three'], ['t4', 'pass', 'cap#four']]);
    const r2 = mk('r2', '2026-01-02T00:00:00Z', [['t1', 'fail', 'cap#one'], ['t2', 'pass', 'cap#two'], ['t3', 'skip', 'cap#three']]);
    const r3 = mk('r3', '2026-01-03T00:00:00Z', [['t1', 'pass', 'cap#one'], ['t2', 'pass', 'cap#two'], ['t3', 'skip', 'cap#three']]);
    const d = diffRuns(r2, r1, [r1, r2, r3]);
    expect(d.claims.newlyFailing.map((c) => c.claim)).toEqual(['cap#one']);
    expect(d.claims.newlyProven.map((c) => c.claim)).toEqual(['cap#two']);
    expect(d.claims.newlyUnexercised.map((c) => c.claim)).toEqual(['cap#three']);
    expect(d.claims.removed.map((c) => c.claim)).toEqual(['cap#four']);
    expect(d.tests.newlyFailing.map((t) => t.title)).toEqual(['t1']);
    expect(d.tests.newlyPassing.map((t) => t.title)).toEqual(['t2']);
    // t1 went pass, fail, pass over the window ending at r3.
    const d3 = diffRuns(r3, r2, [r1, r2, r3]);
    expect(d3.flaky.map((f) => [f.title, f.history])).toEqual([['t1', 'PFP']]);
    expect(d3.claims.newlyProven.map((c) => c.claim)).toEqual(['cap#one']);
  });

  // [claims: capabilities/traceability-and-drift#regression-report]
  it('picks the previous run with the same label, else the previous run', () => {
    const a = mk('a', '2026-01-01T00:00:00Z', [], 'prod');
    const b = mk('b', '2026-01-02T00:00:00Z', [], 'stage');
    const c = mk('c', '2026-01-03T00:00:00Z', [], 'prod');
    expect(chooseRuns([a, b, c], {}).baseline?.runId).toBe('a');
    expect(chooseRuns([a, b, c], { run: 'b' }).baseline?.runId).toBe('a');
    expect(chooseRuns([a, b, c], { baseline: 'b' }).baseline?.runId).toBe('b');
    expect(chooseRuns([a, b, c], { run: 'zz' }).error).toMatch(/no run/);
  });
});

describe('report', () => {
  // [claims: capabilities/traceability-and-drift#regression-report]
  it('renders sections, evidence and escapes markup in titles; writes report.json', async () => {
    const repo = makeV2Repo();
    repo.write('reports/shots/a.png', 'PNGDATA');
    repo.write('reports/pw1.json', playwright([{ title: `logs in @claim:${AUTH}` }, { title: `logs out @claim:${OUT}` }]));
    repo.write(
      'reports/pw2.json',
      playwright([
        { title: `logs in <script>alert(1)</script> @claim:${AUTH}`, status: 'failed', attachments: [{ name: 'shot', contentType: 'image/png', path: 'shots/a.png' }] },
        { title: `logs out @claim:${OUT}` },
      ]),
    );
    await runResultsIngest(['reports/pw1.json'], repo.dir, { runId: 'base' });
    await new Promise((r) => setTimeout(r, 15));
    await runResultsIngest(['reports/pw2.json'], repo.dir, { runId: 'head' });

    const config = await loadConfig(repo.dir);
    const res = await runReport(config, {});
    expect(res.exitCode).toBe(0);
    const out = path.join(repo.dir, '.specguard', 'report');
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    for (const id of ['id="totals"', 'id="claims"', 'id="regression"', 'id="gaps"', 'Newly failing claims', 'Top gaps']) expect(html).toContain(id);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toMatch(/<img src="evidence\/head\/[0-9a-f]{16}-a\.png"/);
    expect(html).not.toMatch(/https?:\/\/[^"' ]*\.(js|css)/);

    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(json.schema).toBe('specguard-report/1');
    expect(json.run.runId).toBe('head');
    expect(json.regression.baseline.runId).toBe('base');
    expect(json.regression.claims.newlyFailing.map((c: { claim: string }) => c.claim)).toContain(AUTH);
    const shop = json.capabilities.find((c: { id: string }) => c.id === 'shop');
    expect(shop.claims[0].gap).toBe('untested');
    const auth = json.capabilities.find((c: { id: string }) => c.id === 'auth');
    expect(auth.claims.find((c: { ref: string }) => c.ref === AUTH).gap).toBe('failed');
    expect(json.gaps.top[0].gap).toBe('failed');
    expect(existsSync(path.join(out, 'evidence', 'head'))).toBe(true);
  });

  // [claims: capabilities/conformance-testing#partial-claim-evidence]
  it('parses partial-claim annotations/properties without making them proof', () => {
    const pw = JSON.stringify({
      suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'flow', file: 'a.spec.ts', tests: [{ projectName: 'c', status: 'expected', expectedStatus: 'passed',
        annotations: [{ type: 'claim', description: AUTH }, { type: 'partial-claim', description: OUT }, { type: 'partial-claim', description: AUTH }], results: [{ status: 'passed', duration: 1 }] }] }] }],
    });
    const rows = parsePlaywrightResults(pw);
    expect(rows[0].claims).toEqual([AUTH]);
    expect(rows[0].partialClaims).toEqual([OUT]); // AUTH is proven outright, so it is not also partial
    const xml = `<testsuite><testcase name="t" classname="C"><properties><property name="partial-claim" value="${OUT}"/></properties></testcase></testsuite>`;
    const j = parseJunitResults(xml);
    expect(j[0].claims).toEqual([]);
    expect(j[0].partialClaims).toEqual([OUT]);
  });

  // [claims: capabilities/conformance-testing#partial-claim-evidence, capabilities/traceability-and-drift#regression-report]
  it('shows partial evidence with its media separately and never as proof', async () => {
    const repo = makeV2Repo();
    repo.write('reports/shots/p.png', 'PARTIALPNG');
    const pw = JSON.stringify({
      suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'long journey', file: 'a.spec.ts', tests: [{ projectName: 'c', status: 'expected', expectedStatus: 'passed',
        annotations: [{ type: 'partial-claim', description: OUT }],
        results: [{ status: 'passed', duration: 5, attachments: [{ name: 'shot', contentType: 'image/png', path: 'shots/p.png' }] }] }] }] }],
    });
    repo.write('reports/pw.json', pw);
    await runResultsIngest(['reports/pw.json'], repo.dir, { runId: 'only' });
    const res = await runReport(await loadConfig(repo.dir), { format: 'json' });
    expect(res.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(path.join(repo.dir, '.specguard', 'report', 'report.json'), 'utf8'));
    const claim = json.capabilities.find((c: { id: string }) => c.id === 'auth').claims.find((c: { ref: string }) => c.ref === OUT);
    expect(claim.gap).toBe('untested');
    expect(claim.reason).toContain('partial evidence');
    expect(claim.partialTests).toHaveLength(1);
    expect(claim.partialTests[0].attachments[0].kind).toBe('image');
    expect(claim.verdict).toBeUndefined();
  });

  // [claims: capabilities/traceability-and-drift#regression-report]
  it('renders with no recorded runs', async () => {
    const repo = makeV2Repo();
    const res = await runReport(await loadConfig(repo.dir), { format: 'json' });
    expect(res.exitCode).toBe(0);
    expect(existsSync(path.join(repo.dir, '.specguard', 'report', 'index.html'))).toBe(false);
    const json = JSON.parse(readFileSync(path.join(repo.dir, '.specguard', 'report', 'report.json'), 'utf8'));
    expect(json.run).toBeNull();
    expect(renderReportHtml(json)).toContain('No run has been recorded');
  });
});

describe('workspace report', () => {
  // [claims: capabilities/traceability-and-drift#workspace-report]
  it('builds one report per repo and a landing page that links to them, with totals, evidence counts and extra links', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { runWorkspaceReport } = await import('../../src/pipelines/workspace-report.js');

    const a = makeV2Repo();
    a.write('reports/shots/a.png', 'PNGDATA');
    a.write('reports/pw.json', playwright([{ title: `logs in @claim:${AUTH}`, attachments: [{ name: 'shot', contentType: 'image/png', path: 'shots/a.png' }] }]));
    await runResultsIngest(['reports/pw.json'], a.dir, { runId: 'r1', runLabel: 'hermetic' });
    const b = makeV2Repo(); // a repo that has never recorded a run

    const ws = mkdtempSync(path.join(tmpdir(), 'sg-ws-'));
    mkdirSync(path.join(ws, '.specguard'), { recursive: true });
    writeFileSync(path.join(ws, '.specguard', 'workspace.json'), JSON.stringify({ version: '1.0', name: 'demo', repos: { alpha: { path: a.dir, role: 'consumer' }, beta: { path: b.dir, role: 'provider' } } }));
    writeFileSync(path.join(ws, '.specguard', 'report-links.json'), JSON.stringify([{ title: 'Playwright <report>', href: 'pw/index.html', note: 'videos' }]));

    const res = await runWorkspaceReport(ws, {});
    expect(res.exitCode).toBe(0);
    const out = path.join(ws, '.specguard', 'report', 'workspace');
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).toContain('href="repos/alpha/index.html"');
    expect(html).toContain('href="repos/beta/index.html"');
    expect(html).toContain('Playwright &lt;report&gt;');
    expect(html).toContain('file://');
    expect(existsSync(path.join(out, 'repos', 'alpha', 'index.html'))).toBe(true);
    expect(readFileSync(path.join(out, 'repos', 'alpha', 'index.html'), 'utf8')).toContain('href="../../index.html"');

    const json = JSON.parse(readFileSync(path.join(out, 'workspace-report.json'), 'utf8'));
    expect(json.schema).toBe('specguard-workspace-report/1');
    const alpha = json.repos.find((r: { key: string }) => r.key === 'alpha');
    expect(alpha.tests.pass).toBe(1);
    expect(alpha.evidence.screenshots).toBe(1);
    expect(alpha.history).toHaveLength(1);
    expect(json.totals.repos).toBe(2);
    expect(json.totals.tests).toBe(1);
    expect(json.totals.claimsProven).toBeGreaterThanOrEqual(1);
  });
});
