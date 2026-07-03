/**
 * `specguard align` — semantic spec-to-test alignment check.
 *
 * Sends each spec's scenarios + matched test files to the LLM and reports
 * which scenarios are covered, which are not, and which tests are unmapped.
 */
import { runAlign } from '../../pipelines/align.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface AlignCliOpts extends GlobalOpts {
  app?: string;
  spec?: string;
  all?: boolean;
  extraTests?: string[];
}

export async function alignCommand(opts: AlignCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runAlign(config, {
    app: opts.app,
    spec: opts.spec,
    extraTests: opts.extraTests,
  });

  // Print a human-readable summary in addition to the standard output.
  if (!opts.json) {
    const { report } = result;
    for (const entry of report.entries) {
      const icon = entry.alignmentScore >= 80 ? '✓' : entry.alignmentScore >= 50 ? '~' : '✗';
      process.stdout.write(`\n${icon} ${entry.specKey} — ${entry.alignmentScore}% aligned\n`);

      if (entry.uncoveredScenarios.length > 0) {
        process.stdout.write(`  Uncovered scenarios (${entry.uncoveredScenarios.length}):\n`);
        for (const s of entry.uncoveredScenarios) {
          process.stdout.write(`    - ${s}\n`);
        }
      }

      if (entry.unmappedTests.length > 0) {
        process.stdout.write(`  Unmapped tests (${entry.unmappedTests.length}):\n`);
        for (const t of entry.unmappedTests) {
          process.stdout.write(`    - [${t.testFile}] ${t.testName}\n`);
        }
      }
    }

    if (report.entries.length > 0) {
      const avg = Math.round(
        report.entries.reduce((s, e) => s + e.alignmentScore, 0) / report.entries.length,
      );
      process.stdout.write(`\nOverall: ${avg}% average alignment across ${report.entries.length} spec(s)\n`);
      process.stdout.write('Full report: .specguard/alignment.json\n');
    }
  }

  outputResult(result, { json: opts.json });
}
