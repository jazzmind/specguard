import { describe, expect, it } from 'vitest';

import { coverageFromApi, findingsFromApi, matrixFromApi } from './adapters.js';
import type { CoverageResponse, FindingsResponse, SpecsResponse, TraceResponse } from './types.js';

const counts = { claims: 4, proven: 1, failed: 0, stale: 0, unexercised: 0, error: 0, unproven: 3, withTests: 2 };

describe('coverage from the API [adapters-coverage]', () => {
  const cov: CoverageResponse = {
    generated: '2026-10-15T00:00:00Z',
    totals: { ...counts, capabilities: 2, ownedFiles: 8, sourceFiles: 10 },
    sourceCoverage: 80,
    provenCoverage: 25,
    unowned: ['src/orphan.ts'],
    capabilities: [
      { id: 'auth', title: 'Auth', status: 'active', files: 4, tests: 2, counts, provenPercent: 25, testedPercent: 50 },
      { id: 'shop', title: 'Shop', status: 'active', files: 4, tests: 0, counts, provenPercent: 0, testedPercent: 0 },
    ],
    units: [],
  };
  const specs: SpecsResponse = { specs: [{ id: 'auth', title: 'Auth', kind: 'capability', specKey: 'capabilities/auth', file: 'specs/capabilities/auth.md', claims: 4 }] };

  // [claims: capabilities/integration-surfaces#extension-overlay-workspace]
  it('resolves overlay API spec links from the config directory, including absolute paths', () => {
    const [app] = coverageFromApi(cov, specs, { name: 'portal', workspaceRoot: '/code/portal', configDir: '/evidence/apps/portal' });
    expect(app.items[0].specPath).toBe('/evidence/apps/portal/specs/capabilities/auth.md');
    expect(coverageFromApi(cov, { specs: [{ ...specs.specs[0], file: '/evidence/spec.md' }] }, { name: 'portal', workspaceRoot: '/code/portal' })[0].items[0].specPath).toBe('/evidence/spec.md');
  });

  it('makes one entry for the project, a capability per item, and a missing-spec item per unowned file', () => {
    const [app] = coverageFromApi(cov, specs, { name: 'portal', workspaceRoot: '/work/portal' });
    expect(app).toMatchObject({ name: 'portal', specCount: 2, sourceCount: 10, testCount: 1, percentage: 80, basis: 'capability' });
    expect(app.items).toEqual([
      { app: 'portal', key: 'auth', hasSpec: true, hasTest: true, specPath: '/work/portal/specs/capabilities/auth.md' },
      { app: 'portal', key: 'shop', hasSpec: true, hasTest: false },
      { app: 'portal', key: 'src/orphan.ts', hasSpec: false, hasTest: false },
    ]);
  });
});

describe('matrix from the API [adapters-matrix]', () => {
  it('has a row per capability, skipping the system spec', () => {
    const trace: TraceResponse = {
      generated: '2026-10-15T00:00:00Z',
      nodes: [
        { id: 'system', specKey: 'system', kind: 'system', title: 'S', unit: '', ownedFiles: [], tests: [], docs: [], counts },
        { id: 'auth', specKey: 'capabilities/auth', kind: 'capability', title: 'Auth', unit: 'web', ownedFiles: ['src/a.ts', 'src/b.ts'], tests: ['t.test.ts'], docs: [], counts },
      ],
    };
    expect(matrixFromApi(trace)).toEqual({
      generatedAt: '2026-10-15T00:00:00Z',
      rows: [{ specKey: 'auth', title: 'Auth', appName: 'web', sourceModule: 'src/a.ts', hasTests: true, testCount: 1, hasDocs: false }],
    });
  });
});

describe('findings from the API [adapters-findings]', () => {
  it('maps plan severities onto the view\'s, and keeps the tracker reference visible', () => {
    const res: FindingsResponse = {
      plan: 'scan-1',
      findings: [
        { id: 'a', severity: 'critical', type: 'dependency', title: 'lodash', status: 'open', version: 0, capability: 'auth', unit: null, files: ['package.json'], externalRef: 'SEC-1' },
        { id: 'b', severity: 'high', type: 'code', title: 'xss', status: 'open', version: 0, capability: null, unit: 'web', files: [], externalRef: null },
        { id: 'c', severity: 'moderate', type: 'spec', title: 'gap', status: 'open', version: 0, capability: null, unit: null, files: ['specs/x.md'], externalRef: null },
        { id: 'd', severity: 'low', type: 'code', title: 'nit', status: 'open', version: 0, capability: null, unit: null, files: [], externalRef: null },
      ],
    };
    const out = findingsFromApi(res);
    expect(out.map((f) => f.severity)).toEqual(['critical', 'error', 'warning', 'info']);
    expect(out[0]).toMatchObject({ file: 'package.json', message: 'lodash (auth) [SEC-1]', category: 'security', source: 'scan-1', rule: 'dependency' });
    expect(out[1].file).toBe('');
  });
});
