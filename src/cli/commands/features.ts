/**
 * `specguard features` — spec key to catalog feature ids, as JSON.
 * Spec: specs/cli/commands/features.md
 */
import path from 'node:path';

import { loadAllSpecs } from '../../core/spec-parser.js';
import type { SpecGuardConfig } from '../../core/types.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

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

export async function featuresCommand(opts: GlobalOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  process.stdout.write(`${JSON.stringify(collectFeatures(config), null, 2)}\n`);
}
