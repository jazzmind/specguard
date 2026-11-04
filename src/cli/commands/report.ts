/**
 * `specguard report`.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { runReport } from '../../pipelines/report.js';
import { emptyResult } from '../../core/types.js';
import { ExitCode } from '../../core/exit-codes.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface ReportCliOpts extends GlobalOpts {
  out?: string;
  run?: string;
  baseline?: string;
  format?: string;
}

export async function reportCommand(opts: ReportCliOpts): Promise<void> {
  const format = opts.format ?? 'html';
  if (format !== 'html' && format !== 'json') {
    const bad = emptyResult('report');
    bad.failed = 1;
    bad.exitCode = ExitCode.ValidationFailed;
    bad.messages.push(`unknown --format '${format}'. Use html or json.`);
    outputResult(bad, opts);
  }
  const config = await loadCliConfig(opts);
  outputResult(await runReport(config, { out: opts.out, run: opts.run, baseline: opts.baseline, format: format as 'html' | 'json' }), opts);
}
