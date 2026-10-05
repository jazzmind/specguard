/**
 * `specguard features --state` — summary, channel state, and the agent gate.
 * Spec: specs/pipelines/feature-state.md
 */
import { loadCasesFile, runFeatureState } from '../../pipelines/feature-state.js';
import type { GlobalOpts } from './helpers.js';

export async function featureStateCommand(opts: GlobalOpts & { cases?: string }): Promise<void> {
  const extra = opts.cases ? loadCasesFile(opts.cases) : [];
  const result = await runFeatureState(process.cwd(), extra);
  process.stdout.write(`${result.messages[0] ?? '[]'}\n`);
}
