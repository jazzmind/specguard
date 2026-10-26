/**
 * `specguard coverage ingest <file...>`.
 *
 * Spec: specs/capabilities/coverage-and-mutation.md
 */
import { ExitCode } from '../../core/exit-codes.js';
import { COVERAGE_FORMATS, isCoverageFormat } from '../../core/coverage.js';
import { runCoverageIngest } from '../../pipelines/coverage-ingest.js';
import { emptyResult } from '../../core/types.js';
import { outputResult, type GlobalOpts } from './helpers.js';

export interface CoverageIngestCliOpts extends GlobalOpts {
  format?: string;
  capability?: string;
  selection?: string;
  runId?: string;
  origin?: string;
}

function bad(message: string, opts: GlobalOpts): never {
  const result = emptyResult('coverage-ingest');
  result.failed = 1;
  result.exitCode = ExitCode.ValidationFailed;
  result.messages.push(message);
  return outputResult(result, opts);
}

export async function coverageIngestCommand(files: string[], opts: CoverageIngestCliOpts): Promise<void> {
  const format = opts.format ?? 'auto';
  if (format !== 'auto' && !isCoverageFormat(format)) bad(`unknown --format '${format}'. Use auto, ${COVERAGE_FORMATS.join(', ')}.`, opts);
  if (opts.selection !== undefined && opts.selection !== 'tests' && opts.selection !== 'files') bad(`unknown --selection '${opts.selection}'. Use tests or files.`, opts);
  if (opts.origin !== undefined && !['local', 'ci', 'server'].includes(opts.origin)) bad(`unknown --origin '${opts.origin}'. Use local, ci or server.`, opts);
  const result = await runCoverageIngest(files, process.cwd(), {
    format: format as never,
    capability: opts.capability,
    selection: opts.selection as never,
    runId: opts.runId,
    origin: opts.origin as never,
  });
  outputResult(result, opts);
}
