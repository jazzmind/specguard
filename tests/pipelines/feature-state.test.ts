import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  channelOf,
  discoverImplementations,
  featureStates,
  headingSummary,
  unitBelongs,
  type CatalogFeatureInput,
  type FeatureStateInput,
} from '../../src/pipelines/feature-state.js';

function feature(overrides: Partial<CatalogFeatureInput> = {}): CatalogFeatureInput {
  return {
    id: 'design.experience.create-scratch',
    title: 'Create from scratch',
    area: 'Experience lifecycle',
    summary: 'An institution admin starts a blank experience.',
    requires: ['ui', 'api'],
    specs: ['admin-app:core/experiences/index', 'graphql-api:mutations/experience'],
    tests: { unit: ['createExperience.spec.ts'], regression: ['CORE-T93'], integration: [], proof: [] },
    status: 'live',
    ...overrides,
  };
}

function input(overrides: Partial<FeatureStateInput> = {}): FeatureStateInput {
  return {
    features: [feature()],
    specs: [
      { ref: 'admin-app:core/experiences/index', featureIds: ['design.experience.create-scratch'], channel: 'ui', overview: 'The experiences page lists programs.' },
      { ref: 'graphql-api:mutations/experience', featureIds: ['design.experience.create-scratch'], channel: 'api', overview: 'Mutations that create an experience.' },
    ],
    cases: [],
    proofs: [],
    ...overrides,
  };
}

describe('featureStates', () => {
  it('marks required channels Passing when the unit test passed', () => {
    const [row] = featureStates(input({
      cases: [{ kind: 'unit', status: 'passed', file: 'createExperience.spec.ts' }],
    }));
    expect(row.summary).toBe('An institution admin starts a blank experience.');
    expect(row.channels.ui.state).toBe('passing');
    expect(row.channels.api.state).toBe('passing');
    expect(row.channels.mcp.state).toBe('no');
    expect(row.agentGate.allowed).toBe(true);
  });

  it('does not open the agent gate on a regression pass alone', () => {
    const [row] = featureStates(input({
      features: [feature({ tests: { unit: [], regression: ['CORE-T93'], integration: [], proof: [] } })],
      cases: [{ kind: 'regression', status: 'passed', zephyr: 'CORE-T93' }],
    }));
    expect(row.channels.ui.state).toBe('proven');
    expect(row.agentGate.allowed).toBe(false);
    expect(row.agentGate.reason).toBe('No unit or integration test linked');
  });

  it('marks a failed unit test Broken and keeps the gate closed', () => {
    const [row] = featureStates(input({
      cases: [{ kind: 'unit', status: 'failed', file: 'createExperience.spec.ts' }],
    }));
    expect(row.channels.ui.state).toBe('broken');
    expect(row.agentGate.reason).toBe('Unit or integration tests failed');
  });

  it('stays Stub until a linked unit test has a result', () => {
    const [row] = featureStates(input());
    expect(row.channels.ui.state).toBe('stub');
    expect(row.agentGate.reason).toBe('Unit or integration tests have not passed yet');
  });

  it('marks a required channel with nothing linked as No', () => {
    const [row] = featureStates(input({
      features: [feature({
        requires: ['mcp'],
        specs: [],
        tests: { unit: [], regression: [], integration: [], proof: [] },
      })],
      specs: [],
    }));
    expect(row.channels.mcp).toEqual({ state: 'no', required: true, evidence: [] });
    expect(row.channels.ui.required).toBe(false);
  });

  it('uses the single linked spec overview when the catalog has no summary', () => {
    const [row] = featureStates(input({
      features: [feature({ summary: '', specs: ['graphql-api:mutations/experience'], requires: ['api'] })],
      specs: [{
        ref: 'graphql-api:mutations/experience',
        featureIds: ['design.experience.create-scratch'],
        channel: 'api',
        overview: 'Creates an experience from a name. The rest is detail.',
      }],
    }));
    expect(row.summary).toBe('Creates an experience from a name.');
  });

  it('counts a non-stale proven claim as Proven for that channel', () => {
    const [row] = featureStates(input({
      proofs: [{ claim: 'graphql-api:mutations/experience#created', verdict: 'proven' }],
    }));
    expect(row.channels.api.state).toBe('proven');
    expect(row.channels.ui.state).toBe('stub');
  });
});

describe('experiences index', () => {
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
    const implementations = discoverImplementations([list, sibling], specs, [
      { key: 'admin-app', absPath: `${workspace}/practera-admin-app` },
      { key: 'graphql-api', absPath: `${workspace}/practera-graphql-api` },
      { key: 'mcp-server', absPath: `${workspace}/practera-mcp-server` },
    ]);
    const [row] = featureStates({ features: [list, sibling], specs, cases: [], proofs: [], implementations });
    expect(headingSummary(list.summary)).toBe(true);
    expect(unitBelongs(list, 'experiences/__tests__/switch.test.tsx', [list, sibling])).toBe(false);
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

describe('channelOf', () => {
  it('defaults page, mutation, and mcp tool paths', () => {
    expect(channelOf({ type: 'page' })).toBe('ui');
    expect(channelOf({ type: 'mutation' })).toBe('api');
    expect(channelOf({ type: 'core', module: 'src/tools/author/create.ts' })).toBe('mcp');
    expect(channelOf({ channel: 'api', type: 'page' })).toBe('api');
    expect(channelOf({ type: 'core', module: 'src/handler.ts' })).toBeNull();
  });
});
