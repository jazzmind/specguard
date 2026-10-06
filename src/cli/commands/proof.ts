/**
 * `specguard proof ingest` and `specguard proof status`.
 */
import { appendProofCoverage, runProofIngest } from '../../pipelines/proof.js';
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
  await appendProofCoverage(config, (line) => result.messages.push(line), { ledger: opts.ledger });
  const failed = result.messages.some((line) => line.includes('[proof-failed]') || line.includes('[proof-stale]'));
  result.exitCode = failed ? ExitCode.ValidationFailed : ExitCode.Success;
  result.failed = result.messages.filter(
    (line) => line.includes('[proof-failed]') || line.includes('[proof-stale]'),
  ).length;
  outputResult(result, opts);
}
