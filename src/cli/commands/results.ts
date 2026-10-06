/**
 * `specguard results ingest <file...>`.
 *
 * Spec: specs/pipelines/results.md
 */
import { ExitCode } from '../../core/exit-codes.js';
import { isResultFormat, runResultsIngest } from '../../pipelines/results.js';
import { emptyResult } from '../../core/types.js';
import { outputResult, type GlobalOpts } from './helpers.js';

export interface ResultsIngestCliOpts extends GlobalOpts {
  format?: string;
  runId?: string;
  unexercised?: boolean;
  sweep?: boolean;
  fullRun?: boolean;
  ledger?: string;
}

export async function resultsIngestCommand(files: string[], opts: ResultsIngestCliOpts): Promise<void> {
  const format = opts.format ?? 'auto';
  if (!isResultFormat(format)) {
    const bad = emptyResult('results-ingest');
    bad.failed = 1;
    bad.exitCode = ExitCode.ValidationFailed;
    bad.messages.push(`unknown --format '${format}'. Use auto, vitest, jest, playwright, junit, pytest, go, or cargo.`);
    outputResult(bad, opts);
  }
  const result = await runResultsIngest(files, process.cwd(), {
    format: format as never,
    runId: opts.runId,
    unexercised: opts.unexercised,
    sweep: opts.sweep,
    fullRun: opts.fullRun,
    ledger: opts.ledger,
  });
  outputResult(result, opts);
}
