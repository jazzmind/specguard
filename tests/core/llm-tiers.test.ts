import { afterEach, describe, expect, it } from 'vitest';

import { resolveTargets } from '../../src/core/llm.js';
import { configureLlm, resetLlmRuntime } from '../../src/core/llm-runtime.js';
import type { LlmConfig } from '../../src/core/types.js';

const base: LlmConfig = { provider: 'anthropic', model: 'big', apiKeyEnv: 'K' };
const call = (pipeline: string) => resolveTargets({ provider: 'anthropic', model: 'big', apiKeyEnv: 'K', pipeline })[0];

afterEach(() => resetLlmRuntime());

describe('model tiers [llm-tiers]', () => {
  // [claims: capabilities/platform-foundation#llm-model-tiers]
  it('routes the docs pipeline to the fast tier by default [default-tier]', () => {
    configureLlm({ rootDir: '/r', llm: { ...base, models: { fast: { provider: 'litellm', model: 'fast' }, frontier: { provider: 'anthropic', model: 'frontier' } } } });
    expect(call('docs')).toMatchObject({ provider: 'litellm', model: 'fast' });
    expect(call('cluster')).toMatchObject({ model: 'frontier' });
    expect(call('heal')).toMatchObject({ model: 'big' });
  });

  // [claims: capabilities/platform-foundation#llm-model-tiers]
  it('keeps the call-site model when no tiers are configured [no-tiers]', () => {
    configureLlm({ rootDir: '/r', llm: base });
    expect(call('docs')).toMatchObject({ model: 'big' });
  });

  // [claims: capabilities/platform-foundation#llm-model-tiers, capabilities/platform-foundation#llm-pipeline-overrides]
  it('lets a pipeline pick a tier and lets an explicit model beat it [override-order]', () => {
    configureLlm({
      rootDir: '/r',
      llm: {
        ...base,
        models: { fast: { provider: 'litellm', model: 'fast' } },
        pipelines: { heal: { tier: 'fast' }, docs: { tier: 'fast', model: 'pinned' } },
      },
    });
    expect(call('heal')).toMatchObject({ model: 'fast' });
    expect(call('docs')).toMatchObject({ provider: 'litellm', model: 'pinned' });
  });
});
