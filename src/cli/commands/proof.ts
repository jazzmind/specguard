/**
 * `specguard proof ingest` and `specguard proof status`.
 */
import { appendProofCoverage, runProofIngest } from '../../pipelines/proof.js';
import { loadEffectiveLedger, readOnlyStore } from '../../pipelines/proof-sources.js';
import { emptyResult } from '../../core/types.js';
import { ExitCode } from '../../core/exit-codes.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface ProofCliOpts extends GlobalOpts {
  ledger?: string;
}

export async function proofIngestCommand(
  verdictsPath: string,
  opts: ProofCliOpts,
): Promise<void> {
  const cwd = process.cwd();
  const result = await runProofIngest(verdictsPath, cwd, { ledger: opts.ledger });
  outputResult(result, opts);
}

export async function proofStatusCommand(opts: ProofCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = emptyResult('proof-status');
  // With CI proof notes the ledger file is only a cache, and a fresh CI checkout has none: read the effective ledger
  // (the nearest note and the local cache) so the `proof` gate sees what CI proved. An explicit --ledger is read as given.
  let store: ReturnType<typeof readOnlyStore> | undefined;
  if (!opts.ledger) {
    try {
      const eff = await loadEffectiveLedger(config);
      if (eff.note) store = readOnlyStore(eff);
    } catch {
      /* the local ledger is read as it always was */
    }
  }
  await appendProofCoverage(config, (line) => result.messages.push(line), { ledger: opts.ledger, ...(store ? { store } : {}) });
  // A claim missing a required layer fails only when the project asks for it (`proof.enforceLayers: fail`).
  const bad = (line: string): boolean =>
    line.includes('[proof-failed]') || line.includes('[proof-stale]') || (config.proof?.enforceLayers === 'fail' && line.includes('[proof-incomplete]'));
  const failed = result.messages.some(bad);
  result.exitCode = failed ? ExitCode.ValidationFailed : ExitCode.Success;
  result.failed = result.messages.filter(bad).length;
  outputResult(result, opts);
}
