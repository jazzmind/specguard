import { describe, it, expect } from 'vitest';

import { collectFeatureState, runFeatureState, featureStates } from '../../src/pipelines/feature-state.js';
import { makeRepo } from '../helpers/repo.js';

const CATALOG = `version: 1
features:
  - id: awards.once
    title: Award once
    requires: [api]
    specs: ["repo:core/awards"]
    tests:
      unit: [awards.test.ts]
    externalIds: [QA-T1]
`;

const REPORT = JSON.stringify({
  testResults: [
    { name: 'tests/awards.test.ts', assertionResults: [{ title: 'awards once', fullName: 'awards once', status: 'passed', duration: 1 }] },
  ],
});

describe('collectFeatureState (single repo, no plugins)', () => {
  it('reads a versioned catalog and reporter output named in config', async () => {
    const repo = makeRepo({
      featureState: { catalog: 'catalog', reporters: [{ path: 'reports/vitest.json' }] },
    });
    repo.write('catalog/awards.yaml', CATALOG);
    repo.write('reports/vitest.json', REPORT);
    const input = await collectFeatureState(repo.dir);
    expect(input.features.map((f) => f.id)).toEqual(['awards.once']);
    expect(input.cases).toHaveLength(1);
    const [row] = featureStates(input);
    expect(row.requires).toEqual(['api']);
    expect(row.channels.api.state).toBe('passing');
    expect(row.agentGate.allowed).toBe(true);
  });

  it('matches external ids from normalized cases via configured adapters', async () => {
    const repo = makeRepo({
      featureState: { catalog: 'catalog', resultsDirs: ['cases'], externalIds: ['zephyr'] },
    });
    repo.write('catalog/awards.yaml', CATALOG.replace('unit: [awards.test.ts]', 'unit: []').replace('requires: [api]', 'requires: [api]'));
    repo.write('cases/run.json', JSON.stringify([{ kind: 'regression', status: 'passed', name: 'x', zephyr: 'QA-T1' }]));
    const [row] = featureStates(await collectFeatureState(repo.dir));
    expect(row.channels.api.state).toBe('proven');
  });

  it('reports a note, not an error, when no catalog is configured', async () => {
    const repo = makeRepo();
    const result = await runFeatureState(repo.dir);
    expect(JSON.parse(result.messages[0])).toEqual([]);
    expect(result.messages[1]).toMatch(/no feature catalog/);
  });

  it('rejects an unknown plugin name', async () => {
    const repo = makeRepo({ plugins: ['nope'] });
    await expect(collectFeatureState(repo.dir)).rejects.toThrow(/unknown plugin/);
  });

  it('the practera plugin supplies its default catalog and results directories', async () => {
    const repo = makeRepo({ plugins: ['practera'] });
    repo.write('practera-test-suite/catalog/a.yaml', '- id: a.b.c\n  requires: [ui]\n  tests:\n    regression: [CORE-T1]\n');
    repo.write('practera-test-suite/.results/cases/r.json', JSON.stringify([{ kind: 'regression', status: 'passed', zephyr: 'CORE-T1' }]));
    const [row] = featureStates(await collectFeatureState(repo.dir));
    expect(row.id).toBe('a.b.c');
    expect(row.channels.ui.state).toBe('proven');
  });
});
