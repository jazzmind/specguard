/**
 * `specguard drift` — detect specs that have drifted from source (Phase 3).
 */
import { runDrift } from '../../pipelines/drift.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface DriftCliOpts extends GlobalOpts {
  since?: string;
  spec?: string;
  force?: boolean;
  mtime?: boolean;
}

export async function driftCommand(opts: DriftCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runDrift(config, {
    since: opts.since,
    spec: opts.spec,
    force: opts.force,
    mtime: opts.mtime,
  });

  outputResult(result, opts);
}
