/**
 * `specguard test run`: run the configured tests and ingest the results.
 */
import { runTestRun, type TestRunPipelineOpts } from '../../pipelines/test-run.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export async function testRunCommand(opts: GlobalOpts & TestRunPipelineOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runTestRun(config, opts), opts);
}
