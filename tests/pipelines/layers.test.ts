import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { loadTrace } from '../../src/pipelines/check.js';
import { appendProofCoverage, ingestVerdicts, walkClaimVerdicts } from '../../src/pipelines/proof.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import { runTestRun } from '../../src/pipelines/test-run.js';
import { AUTH_SPEC, makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';

/** The auth capability, requiring unit and e2e proof of login and unit proof of everything else. */
const LAYERED_AUTH = AUTH_SPEC.replace('tests:\n  - "tests/auth.test.ts"\n---', 'tests:\n  - "tests/auth.test.ts"\nlayers:\n  default: [unit]\n  claims:\n    login-valid-code: [unit, e2e]\n---');

function repoWithLayers(extra: Record<string, unknown> = {}): TmpRepo {
  const repo = makeV2Repo(extra);
  repo.write('specs/capabilities/auth.md', LAYERED_AUTH);
  return repo;
}

const junit = (...cases: string[]): string => `<testsuite name="s">${cases.join('')}</testsuite>`;
const pass = (name: string): string => `<testcase classname="c" name="${name}"/>`;
const failing = (name: string): string => `<testcase classname="c" name="${name}"><failure message="boom"/></testcase>`;

const ledger = (repo: TmpRepo) => JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs as Record<string, { verdict: string; layers?: Record<string, { verdict: string }> }>;

describe('layered ingest [layered-ingest]', () => {
  // [claims: capabilities/conformance-testing#layer-ingest]
  it('records one layer per test: an @layer tag, a --layer default, else unit', async () => {
    const repo = repoWithLayers();
    repo.write('r.xml', junit(pass(`login unit @claim:${LOGIN}`), pass(`login browser @claim:${LOGIN} @layer:e2e`), pass(`logout @claim:${LOGOUT}`)));
    const r = await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    expect(r.exitCode).toBe(0);
    expect(Object.keys(ledger(repo)[LOGIN].layers ?? {}).sort()).toEqual(['e2e', 'unit']);
    expect(Object.keys(ledger(repo)[LOGOUT].layers ?? {})).toEqual(['unit']);

    const forced = repoWithLayers();
    forced.write('r.xml', junit(pass(`logout @claim:${LOGOUT}`)));
    await runResultsIngest(['r.xml'], forced.dir, { format: 'junit', layer: 'integration' });
    expect(Object.keys(ledger(forced)[LOGOUT].layers ?? {})).toEqual(['integration']);
  });

  // [claims: capabilities/conformance-testing#layer-ingest]
  it('a later passing unit run does not hide a failing browser check', async () => {
    const repo = repoWithLayers();
    await ingestVerdicts({ runId: 'verify-1', verdicts: [{ claim: LOGIN, verdict: 'failed', exercised: 1, counterexamples: 1, evidence: 'agentic' }] }, repo.dir);
    expect(ledger(repo)[LOGIN].layers?.functional.verdict).toBe('failed');
    repo.write('r.xml', junit(pass(`login @claim:${LOGIN}`)));
    await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    expect(ledger(repo)[LOGIN]).toMatchObject({ verdict: 'failed', layers: { unit: { verdict: 'proven' }, functional: { verdict: 'failed' } } });
    const seen = new Map<string, string>();
    await walkClaimVerdicts(await loadConfig(repo.dir), (ref, v) => seen.set(ref, v));
    expect(seen.get(LOGIN)).toBe('failed');
    // the browser check passes later: proven
    await ingestVerdicts({ runId: 'verify-2', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1, counterexamples: 0, evidence: 'agentic' }] }, repo.dir);
    expect(ledger(repo)[LOGIN].verdict).toBe('proven');
  });

  // [claims: capabilities/conformance-testing#layer-ingest]
  it('a fixed test replaces an old unclassified failure rather than living beside it', async () => {
    const repo = repoWithLayers();
    await ingestVerdicts({ runId: 'old', verdicts: [{ claim: LOGOUT, verdict: 'failed', exercised: 0, counterexamples: 1 }] }, repo.dir);
    expect(ledger(repo)[LOGOUT].layers).toBeUndefined(); // raw ingest without a layer keeps the old row shape
    repo.write('r.xml', junit(pass(`logout @claim:${LOGOUT}`)));
    await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    expect(ledger(repo)[LOGOUT]).toMatchObject({ verdict: 'proven', layers: { unit: { verdict: 'proven' } } });
    expect(Object.keys(ledger(repo)[LOGOUT].layers ?? {})).toEqual(['unit']);
  });
});

describe('required layers in the reports [layer-reports]', () => {
  // [claims: capabilities/conformance-testing#layer-reports]
  it('says which required layer a proven claim is missing, and tallies per layer', async () => {
    const repo = repoWithLayers();
    repo.write('r.xml', junit(pass(`login @claim:${LOGIN}`), pass(`logout @claim:${LOGOUT}`)));
    await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    const lines: string[] = [];
    await appendProofCoverage(await loadConfig(repo.dir), (l) => lines.push(l));
    expect(lines).toContain(`  [proof-incomplete] ${LOGIN} (missing: e2e)`);
    expect(lines.some((l) => l.includes(LOGOUT) && l.includes('incomplete'))).toBe(false);
    expect(lines.find((l) => l.startsWith('PROOFS:'))).toBe('PROOFS: 2 proven, 0 failed, 0 error, 0 unexercised, 0 stale, 1 unproven');
    expect(lines.find((l) => l.startsWith('LAYERS:'))).toBe('LAYERS: unit 2/2  e2e 0/1; 1 claim(s) missing a required layer');
  });

  // [claims: capabilities/conformance-testing#layer-reports]
  it('prints nothing about layers when none are required, and can be silenced', async () => {
    const plain = makeV2Repo();
    plain.write('r.xml', junit(pass(`login @claim:${LOGIN}`)));
    await runResultsIngest(['r.xml'], plain.dir, { format: 'junit' });
    const plainLines: string[] = [];
    await appendProofCoverage(await loadConfig(plain.dir), (l) => plainLines.push(l));
    expect(plainLines.join('\n')).not.toMatch(/LAYERS|incomplete/);

    const quiet = repoWithLayers({ proof: { enforceLayers: 'off' } });
    quiet.write('r.xml', junit(pass(`login @claim:${LOGIN}`)));
    await runResultsIngest(['r.xml'], quiet.dir, { format: 'junit' });
    const quietLines: string[] = [];
    await appendProofCoverage(await loadConfig(quiet.dir), (l) => quietLines.push(l));
    expect(quietLines.join('\n')).not.toContain('[proof-incomplete]');
  });

  // [claims: capabilities/conformance-testing#layer-reports]
  it('uses the project default when a capability names no layers, and puts the detail in the trace', async () => {
    const repo = makeV2Repo({ proof: { requiredLayers: ['unit', 'security'] } });
    repo.write('r.xml', junit(pass(`login @claim:${LOGIN}`)));
    await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    const { model } = await loadTrace(await loadConfig(repo.dir));
    const auth = model.nodes.find((n) => n.id === 'auth');
    const login = auth?.claims.find((c) => c.id === 'login-valid-code');
    expect(login).toMatchObject({ required: ['unit', 'security'], missing: ['security'], layers: { unit: 'proven' } });
    expect(auth?.counts.incomplete).toBe(1);
    expect(auth?.layerCounts).toMatchObject({ unit: { required: 2, proven: 1, missing: 1 }, security: { required: 2, proven: 0, missing: 2 } });
    expect(model.totals.layerCounts?.security).toMatchObject({ required: 3 });
  });
});

describe('test suites with layers [layer-suites]', () => {
  // [claims: capabilities/conformance-testing#layer-suites]
  it('runs each suite and records its tests in the suite\'s layer', async () => {
    const repo = makeV2Repo({
      apps: [
        {
          name: 'app', repo: '.', specDir: 'specs', sources: { routes: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] }, framework: 'junit', testOutput: 'tests/',
          test: {
            reporter: 'junit',
            suites: [
              { name: 'unit', layer: 'unit', command: 'node unit.cjs', resultsFile: 'unit.xml' },
              { name: 'browser', layer: 'e2e', command: 'node browser.cjs', resultsFile: 'browser.xml' },
            ],
          },
        },
      ],
    });
    repo.write('unit.cjs', `require('fs').writeFileSync('unit.xml', ${JSON.stringify(junit(pass(`login @claim:${LOGIN}`)))});`);
    repo.write('browser.cjs', `require('fs').writeFileSync('browser.xml', ${JSON.stringify(junit(pass(`login @claim:${LOGIN}`)))});`);
    const r = await runTestRun(await loadConfig(repo.dir), { runId: 'suites' });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join('\n')).toContain('[run] app/unit:');
    expect(r.messages.join('\n')).toContain('[run] app/browser:');
    expect(ledger(repo)[LOGIN]).toMatchObject({ verdict: 'proven' });
    expect(Object.keys(ledger(repo)[LOGIN].layers ?? {}).sort()).toEqual(['e2e', 'unit']);
  });

  // [claims: capabilities/conformance-testing#layer-suites]
  it('a failing suite fails only its own layer', async () => {
    const repo = makeV2Repo({
      apps: [
        {
          name: 'app', repo: '.', specDir: 'specs', sources: { routes: ['src/**/*.ts'] }, framework: 'junit', testOutput: 'tests/',
          test: { reporter: 'junit', suites: [{ name: 'unit', layer: 'unit', command: 'node unit.cjs', resultsFile: 'unit.xml' }, { name: 'browser', layer: 'e2e', command: 'node browser.cjs', resultsFile: 'browser.xml' }] },
        },
      ],
    });
    repo.write('unit.cjs', `require('fs').writeFileSync('unit.xml', ${JSON.stringify(junit(pass(`login @claim:${LOGIN}`)))});`);
    repo.write('browser.cjs', `require('fs').writeFileSync('browser.xml', ${JSON.stringify(junit(failing(`login @claim:${LOGIN}`)))}); process.exit(1);`);
    const r = await runTestRun(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(2);
    expect(ledger(repo)[LOGIN]).toMatchObject({ verdict: 'failed', layers: { unit: { verdict: 'proven' }, e2e: { verdict: 'failed' } } });
  });
});

describe('where evidence may point [evidence-path]', () => {
  // [claims: capabilities/conformance-testing#evidence-path-inside-repo]
  it('records a path inside the repo normalised, and drops one outside it while keeping the verdict', async () => {
    const repo = repoWithLayers();
    const rows = [
      { claim: LOGIN, verdict: 'proven' as const, evidencePath: 'reports/./sub/../unit.json' },
      { claim: LOGOUT, verdict: 'proven' as const, evidencePath: '../../etc/passwd' },
    ];
    const res = await ingestVerdicts({ runId: 'e', verdicts: rows }, repo.dir);
    const proofs = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs as Record<string, { verdict: string; evidencePath?: string }>;
    expect(proofs[LOGIN]).toMatchObject({ verdict: 'proven', evidencePath: 'reports/unit.json' });
    expect(proofs[LOGOUT].verdict).toBe('proven');
    expect(proofs[LOGOUT].evidencePath).toBeUndefined();
    expect(res.messages.join('\n')).toContain('is outside the repository and was not recorded');
    for (const bad of ['/etc/passwd', '..', '../x', 'a/../../x']) {
      const r = await ingestVerdicts({ runId: 'e2', verdicts: [{ claim: LOGOUT, verdict: 'proven', evidencePath: bad }] }, repo.dir);
      expect(r.messages.join('\n'), bad).toContain('not recorded');
    }
  });
});

