/**
 * `specguard mutation ingest <file...>`.
 *
 * Spec: specs/capabilities/coverage-and-mutation.md
 */
import { ExitCode } from '../../core/exit-codes.js';
import { isMutationFormat, runMutationIngest } from '../../pipelines/mutation-ingest.js';
import { emptyResult } from '../../core/types.js';
import { outputResult, type GlobalOpts } from './helpers.js';

export interface MutationIngestCliOpts extends GlobalOpts {
  format?: string;
  runId?: string;
  origin?: string;
}

function bad(message: string, opts: GlobalOpts): never {
  const result = emptyResult('mutation-ingest');
  result.failed = 1;
  result.exitCode = ExitCode.ValidationFailed;
  result.messages.push(message);
  return outputResult(result, opts);
}

export async function mutationIngestCommand(files: string[], opts: MutationIngestCliOpts): Promise<void> {
  const format = opts.format ?? 'auto';
  if (!isMutationFormat(format)) bad(`unknown --format '${format}'. Use auto, stryker or pit.`, opts);
  if (opts.origin !== undefined && !['local', 'ci', 'server'].includes(opts.origin)) bad(`unknown --origin '${opts.origin}'. Use local, ci or server.`, opts);
  const result = await runMutationIngest(files, process.cwd(), { format: format as never, runId: opts.runId, origin: opts.origin as never });
  outputResult(result, opts);
}
