/**
 * `specguard status` — spec coverage report (Phase 3 pipeline).
 */
import { runStatus } from '../../pipelines/status.js';
import { describeResolution } from '../../core/overlay.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export async function statusCommand(opts: GlobalOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runStatus(config);
  const via = describeResolution(config.resolvedVia);
  if (via) result.messages.unshift(via);
  outputResult(result, opts);
}
