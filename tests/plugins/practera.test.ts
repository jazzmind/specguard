import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadPlugins } from '../../src/plugins/index.js';
import { zephyrAdapter } from '../../src/plugins/external-id.js';
import { normalizeCases } from '../../src/plugins/external-id.js';
import { headingSummary, practeraPlugin } from '../../src/plugins/practera/index.js';
import { channelOf, discoverImplementations, featureStates, unitBelongs, type CatalogFeatureInput } from '../../src/pipelines/feature-state.js';
import { BUILTIN_DISCOVERERS } from '../../src/plugins/discoverers.js';

describe('practera plugin: experiences index', () => {
  // A throwaway workspace: no checkout outside the repo is needed.
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'sg-fs-'));
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    writeFileSync(path.join(workspace, rel), body);
  };
  put('practera-admin-app/src/pages/experiences/index.tsx', 'export default function Page() { return null; }\n');
  put('practera-admin-app/src/pages/experiences/queries.ts', 'export const Q = gql`query { experiences { id } }`;\n');
  put('practera-mcp-server/src/tools/learner/list.ts', "server.tool('list_experiences', {}, async () => { const q = `query { experiences { id } }`; });\n");
  const list: CatalogFeatureInput = {
    id: 'design.experience.list',
    title: 'Experiences index',
    area: 'Experience lifecycle',
    summary: 'experiences-list — Every experience in this institution.',
    requires: ['ui'],
    specs: ['admin-app:core/experiences/index'],
    tests: { unit: ['experiences/__tests__/switch.test.tsx'], regression: ['CORE-T28', 'CORE-T360'], integration: [], proof: [] },
    status: 'partial',
  };
  const sibling: CatalogFeatureInput = {
    ...list,
    id: 'design.experience.switch',
    title: 'Switch into experience context',
    summary: 'Switch into an experience.',
    tests: { unit: [], regression: ['CORE-T361'], integration: [], proof: [] },
  };

  it('reads the page, the experiences query, and the learner tool', () => {
    const specs = [
      {
        ref: 'admin-app:core/experiences/index',
        featureIds: ['design.experience.list', 'design.experience.switch'],
        channel: 'ui' as const,
        overview: 'The Experiences Index page is the primary listing view for all learning experiences within the admin application. Users can filter the list.',
        module: 'admin-app/experiences/index',
      },
      {
        ref: 'graphql-api:queries/experience',
        featureIds: [],
        channel: 'api' as const,
        overview: 'The experiences query returns the experiences in an institution.',
        module: 'graphql-api/queries/experience',
      },
    ];
    const implementations = discoverImplementations(
      [list, sibling],
      specs,
      [
        { key: 'admin-app', absPath: `${workspace}/practera-admin-app` },
        { key: 'graphql-api', absPath: `${workspace}/practera-graphql-api` },
        { key: 'mcp-server', absPath: `${workspace}/practera-mcp-server` },
      ],
      [...BUILTIN_DISCOVERERS, ...(practeraPlugin.discoverers ?? [])],
      practeraPlugin.moduleStems,
    );
    const tuning = practeraPlugin.featureState;
    const [row] = featureStates({ features: [list, sibling], specs, cases: [], proofs: [], implementations, tuning });
    expect(headingSummary(list.summary)).toBe(true);
    expect(unitBelongs(list, 'experiences/__tests__/switch.test.tsx', [list, sibling], tuning?.idTokens)).toBe(false);
    expect(row.summary).toBe('The Experiences Index page is the primary listing view for all learning experiences within the admin application.');
    expect(row.requires).toEqual(['ui', 'api']);
    expect(row.channels.ui.state).toBe('built');
    expect(row.channels.ui.evidence[0]).toContain('experiences/index.tsx');
    expect(row.channels.api.state).toBe('built');
    expect(row.channels.api.evidence).toContain('graphql-api:queries/experience');
    expect(row.channels.mcp.state).toBe('no');
    expect(row.channels.mcp.evidence).toEqual(['learner list_experiences; no admin tool']);
    expect(row.agentGate.allowed).toBe(false);
    expect(row.agentGate.reason).toBe('No unit or integration test linked');
    expect(row.tests.unit).toEqual([]);
    expect(row.tests.regression).toEqual(['CORE-T28', 'CORE-T360']);
  });
});

describe('practera plugin: layout rules', () => {
  const tuning = practeraPlugin.featureState!;

  it('maps page, mutation, query and mcp tool paths to channels', () => {
    expect(channelOf({ type: 'page' }, '', tuning)).toBe('ui');
    expect(channelOf({ type: 'mutation' }, '', tuning)).toBe('api');
    expect(channelOf({ type: 'query' }, '', tuning)).toBe('api');
    expect(channelOf({ type: 'core', module: 'src/tools/author/create.ts' }, '', tuning)).toBe('mcp');
    expect(channelOf({ channel: 'api', type: 'page' }, '', tuning)).toBe('api');
    expect(channelOf({ type: 'core', module: 'src/handler.ts' }, '', tuning)).toBeNull();
    expect(channelOf({ type: 'core' }, '', tuning, 'graphql-api')).toBe('api');
  });

  it('recognises heading summaries', () => {
    expect(headingSummary('experiences-list — Every experience.')).toBe(true);
    expect(headingSummary('Every experience.')).toBe(false);
  });

  it('reads Zephyr ids from the zephyr field and titles', () => {
    const [row] = normalizeCases([{ kind: 'regression', status: 'passed', zephyr: 'CORE-T93' }], [zephyrAdapter]);
    expect(row.externalId).toBe('CORE-T93');
    const [titled] = normalizeCases([{ kind: 'regression', status: 'passed', name: 'checks CORE-T7 once' }], [zephyrAdapter]);
    expect(titled.externalIds).toEqual(['CORE-T7']);
  });

  it('is enabled by name and unknown or malformed plugin names are rejected', async () => {
    expect((await loadPlugins(['practera']))[0].id).toBe('practera');
    await expect(loadPlugins(['nope'])).rejects.toThrow(/unknown plugin/);
    await expect(loadPlugins(['../core'])).rejects.toThrow(/invalid plugin name/);
  });
});
