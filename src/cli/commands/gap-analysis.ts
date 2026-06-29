/**
 * `specguard gap-analysis` — detect unimplemented/partial specs and generate plans.
 */
import { runGapAnalysis } from '../../pipelines/gap-analysis.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface GapAnalysisCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  noPlan?: boolean;
}

export async function gapAnalysisCommand(opts: GapAnalysisCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runGapAnalysis(config, {
    spec: opts.spec,
    plan: !opts.noPlan,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }

  if (result.gaps.length === 0) {
    process.stdout.write('\ngap-analysis: all specs appear to be implemented ✓\n');
  } else {
    const unimpl = result.gaps.filter((g) => g.status === 'unimplemented');
    const partial = result.gaps.filter((g) => g.status === 'partial');
    if (unimpl.length > 0) {
      process.stdout.write(`\n${unimpl.length} UNIMPLEMENTED spec(s):\n`);
      for (const g of unimpl) {
        process.stdout.write(`  ✗ ${g.specKey} — "${g.title}"`);
        if (g.planPath) process.stdout.write(` (plan: ${g.planPath})`);
        process.stdout.write('\n');
      }
    }
    if (partial.length > 0) {
      process.stdout.write(`\n${partial.length} PARTIAL spec(s):\n`);
      for (const g of partial) {
        process.stdout.write(`  ~ ${g.specKey} — "${g.title}" (${g.uncheckedCriteria}/${g.totalCriteria} criteria pending)\n`);
      }
    }
  }

  process.exit(result.exitCode);
}
