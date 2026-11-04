/**
 * `specguard runs list|prune`.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { runsList, runsPrune } from '../../pipelines/runs.js';
import { outputResult, type GlobalOpts } from './helpers.js';

export async function runsListCommand(opts: GlobalOpts): Promise<void> {
  const { result, runs } = runsList(process.cwd());
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...result, runs }) + '\n');
    process.exit(result.exitCode);
  }
  for (const line of result.messages) process.stdout.write(`${line}\n`);
  process.exit(result.exitCode);
}

export async function runsPruneCommand(opts: GlobalOpts & { keep?: string }): Promise<void> {
  const keep = opts.keep === undefined ? Number.NaN : Number(opts.keep);
  outputResult(await runsPrune(process.cwd(), keep), opts);
}
