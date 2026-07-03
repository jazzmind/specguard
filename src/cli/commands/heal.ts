/**
 * `specguard heal` — self-heal failing generated tests (Phase 4 heal pipeline).
 */
import { runHeal } from '../../pipelines/heal.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface HealCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  maxRetries?: string;
}

export async function healCommand(opts: HealCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const maxRetries =
    opts.maxRetries !== undefined ? Number.parseInt(opts.maxRetries, 10) : undefined;
  const result = await runHeal(config, {
    spec: opts.spec,
    all: opts.all,
    maxRetries: Number.isNaN(maxRetries as number) ? undefined : maxRetries,
  });

  outputResult(result, opts);
}
