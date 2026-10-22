/**
 * `specguard results ingest <file...>`.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { ExitCode } from '../../core/exit-codes.js';
import { isResultFormat, runResultsIngest } from '../../pipelines/results.js';
import { emptyResult } from '../../core/types.js';
import { isTestLayer, TEST_LAYERS } from '../../core/test-layers.js';
import { outputResult, type GlobalOpts } from './helpers.js';

export interface ResultsIngestCliOpts extends GlobalOpts {
  format?: string;
  runId?: string;
  unexercised?: boolean;
  sweep?: boolean;
  fullRun?: boolean;
  ledger?: string;
  layer?: string;
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
  if (opts.layer !== undefined && !isTestLayer(opts.layer)) {
    const bad = emptyResult('results-ingest');
    bad.failed = 1;
    bad.exitCode = ExitCode.ValidationFailed;
    bad.messages.push(`unknown --layer '${opts.layer}'. Use ${TEST_LAYERS.join(', ')}.`);
    outputResult(bad, opts);
  }
  const result = await runResultsIngest(files, process.cwd(), {
    layer: opts.layer as never,
    format: format as never,
    runId: opts.runId,
    unexercised: opts.unexercised,
    sweep: opts.sweep,
    fullRun: opts.fullRun,
    ledger: opts.ledger,
  });
  outputResult(result, opts);
}
