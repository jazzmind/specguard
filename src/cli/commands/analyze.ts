/**
 * `specguard analyze` — run all diagnostic pipelines and return recommendations.
 */
import { runAnalyze } from '../../pipelines/analyze.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface AnalyzeCliOpts extends GlobalOpts {
  autoFix?: boolean;
}

export async function analyzeCommand(opts: AnalyzeCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runAnalyze(config, { autoFix: opts.autoFix });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }

  const recs = result.analysisReport?.recommendations ?? [];
  if (recs.length === 0) {
    process.stdout.write('analyze: workspace is healthy — nothing to do\n');
  } else {
    process.stdout.write(`\nanalyze: ${recs.length} recommendation(s):\n`);
    for (const r of recs) {
      process.stdout.write(`  [${r.priority}] run specguard ${r.pipeline} — ${r.reason}\n`);
    }
  }

  process.exit(result.exitCode);
}
