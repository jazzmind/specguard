import { describe, expect, it } from 'vitest';

import {
  channelOf,
  featureStates,
  inferRequires,
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
      cases: [{ kind: 'regression', status: 'passed', externalId: 'CORE-T93' }],
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

describe('generic engine rules', () => {
  it('matches cases by external id, feature externalIds, and @feature tags', () => {
    const f = feature({ tests: { unit: [], regression: [], integration: [], proof: [] }, externalIds: ['QA-9'] });
    const [byId] = featureStates(input({ features: [f], cases: [{ kind: 'integration', status: 'passed', externalIds: ['QA-9'] }] }));
    expect(byId.channels.ui.state).toBe('proven');
    const [byTag] = featureStates(input({ features: [f], cases: [{ kind: 'e2e', status: 'passed', tags: [`@feature:${f.id}`] }] }));
    expect(byTag.channels.api.state).toBe('proven');
    const [none] = featureStates(input({ features: [f], cases: [{ kind: 'e2e', status: 'passed', externalId: 'OTHER-1' }] }));
    expect(none.channels.ui.state).toBe('stub');
  });

  it('assumes no id structure when deciding which sibling owns a unit file', () => {
    const a = feature({ id: 'checkout', tests: { unit: ['refund-flow.test.ts'], regression: [], integration: [], proof: [] } });
    const b = feature({ id: 'refund-flow', tests: { unit: [], regression: [], integration: [], proof: [] } });
    expect(unitBelongs(a, 'refund-flow.test.ts', [a, b])).toBe(false);
    expect(unitBelongs(b, 'refund-flow.test.ts', [a, b])).toBe(true);
    // a custom tokenizer replaces the default
    expect(unitBelongs(a, 'refund-flow.test.ts', [a, b], () => [])).toBe(true);
  });

  it('infers required channels from repo channels only when configured', () => {
    const f = feature({ requires: [], specs: ['web:orders'] });
    expect(inferRequires(f, [])).toEqual([]);
    expect(inferRequires(f, [], undefined, { repoChannels: { web: 'ui' } })).toEqual(['ui']);
  });

  it('does not treat a heading-shaped summary as a placeholder unless told to', () => {
    const f = feature({ summary: 'orders-list — Every order.', requires: ['ui'], specs: ['web:orders'], id: 'orders.list' });
    const specs = [{ ref: 'web:orders', featureIds: ['orders.list'], channel: 'ui' as const, overview: 'Lists orders. More.' }];
    expect(featureStates(input({ features: [f], specs }))[0].summary).toBe('orders-list — Every order.');
    const tuned = featureStates(input({ features: [f], specs, tuning: { isPlaceholderSummary: (x) => x.includes(' — ') } }));
    expect(tuned[0].summary).toBe('Lists orders.');
  });
});

describe('channelOf', () => {
  it('uses explicit channel, then the configured type map, module pattern, and repo channel', () => {
    expect(channelOf({ type: 'page' })).toBeNull();
    expect(channelOf({ type: 'ui' })).toBe('ui');
    expect(channelOf({ type: 'page' }, '', { channelByType: { page: 'ui' } })).toBe('ui');
    expect(channelOf({ channel: 'api', type: 'page' }, '', { channelByType: { page: 'ui' } })).toBe('api');
    expect(channelOf({ type: 'core', module: 'src/tools/x.ts' }, '', { mcpModulePattern: /\/tools\// })).toBe('mcp');
    expect(channelOf({ type: 'core' }, '', { repoChannels: { svc: 'api' } }, 'svc')).toBe('api');
    expect(channelOf({ type: 'core', module: 'src/handler.ts' })).toBeNull();
  });
});
