/**
 * `specguard status` — spec coverage report (Phase 3 pipeline).
 */
import { runStatus } from '../../pipelines/status.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export async function statusCommand(opts: GlobalOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runStatus(config);

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.exit(result.exitCode);
}
