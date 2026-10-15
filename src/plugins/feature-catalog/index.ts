/**
 * The `feature-catalog` plugin: a catalog of product features, and the state of
 * each across the channels that implement it (UI, API, agent tools).
 *
 * Enabled with `"plugins": ["feature-catalog"]`. It adds `specguard features`
 * (spec key to catalog feature ids) and `specguard features --state` (channel
 * state and the agent gate), and the `specguard_features` MCP tool.
 *
 * Nothing about a repo's layout is built in. Where the catalog lives, how
 * feature ids are structured, which repo implements which channel, and where
 * agent tools are declared are all `featureState` config.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import path from 'node:path';
import { z } from 'zod';

import { loadAllSpecs } from '../../core/spec-parser.js';
import { emptyResult, type SpecGuardConfig } from '../../core/types.js';
import type { SpecGuardPlugin } from '../types.js';
import { loadCasesFile, runFeatureState } from './feature-state.js';

export interface FeatureRow {
  spec: string;
  features: string[];
}

/** Every spec that carries a `feature:` meta value, keyed `<app>:<specKey>`. */
export function collectFeatures(config: SpecGuardConfig): FeatureRow[] {
  const root = config.rootDir ?? process.cwd();
  const rows: FeatureRow[] = [];
  for (const app of config.apps) {
    const specDir = path.isAbsolute(app.specDir) ? app.specDir : path.resolve(root, app.specDir);
    let specs;
    try {
      specs = loadAllSpecs(specDir);
    } catch {
      continue;
    }
    for (const spec of specs) {
      const features = (spec.meta.feature ?? '').split(',').map((part) => part.trim()).filter(Boolean);
      if (features.length === 0) continue;
      rows.push({ spec: `${app.name}:${spec.specKey}`, features });
    }
  }
  return rows;
}

export const plugin: SpecGuardPlugin = {
  id: 'feature-catalog',
  commands: [
    {
      name: 'features',
      description: 'spec key to catalog feature ids, as JSON; with --state, each feature\'s channel state and the agent gate',
      options: [
        { flags: '--state', description: 'summary, channel state and the agent gate per feature' },
        { flags: '--cases <file>', description: 'with --state: extra normalized test cases (JSON)' },
      ],
      output: 'messages',
      mcpParams: {
        state: z.boolean().optional().describe('Include channel state and the agent gate per feature.'),
        cases: z.string().optional().describe('Path to extra normalized test cases (JSON).'),
      },
      async run({ config, opts }) {
        if (opts.state) {
          const extra = typeof opts.cases === 'string' ? loadCasesFile(opts.cases) : [];
          const result = await runFeatureState(config?.rootDir ?? process.cwd(), extra);
          return { ...result, messages: [result.messages[0] ?? '[]'] };
        }
        if (!config) throw new Error('features needs a SpecGuard config');
        const result = emptyResult('features');
        result.messages.push(JSON.stringify(collectFeatures(config), null, 2));
        return result;
      },
    },
  ],
};
