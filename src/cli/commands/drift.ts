/**
 * `specguard drift` — detect specs that have drifted from source (Phase 3).
 */
import { runDrift } from '../../pipelines/drift.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface DriftCliOpts extends GlobalOpts {
  since?: string;
  spec?: string;
}

export async function driftCommand(opts: DriftCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runDrift(config, { since: opts.since, spec: opts.spec });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    result.failed > 0
      ? `drift: ${result.failed} spec(s) drifted\n`
      : 'drift: no drift detected\n',
  );
  process.exit(result.exitCode);
}
