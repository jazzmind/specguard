/**
 * `specguard plan-fix` — generate a structured fix plan from pipeline findings.
 */
import { runPlanFix } from '../../pipelines/plan-fix.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface PlanFixCliOpts extends GlobalOpts {
  pipeline: string;
  issues: string;
}

export async function planFixCommand(opts: PlanFixCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runPlanFix(config, {
    sourcePipeline: opts.pipeline,
    issuesSummary: opts.issues,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }

  if (result.plan) {
    process.stdout.write(`\nplan-fix: "${result.plan.title}"\n`);
    process.stdout.write(`${result.plan.summary}\n\n`);
    for (const s of result.plan.steps) {
      process.stdout.write(`  ${s.id}: ${s.description}\n`);
    }
    process.stdout.write('\nPlan written to .specguard/fix-plan.json\n');
  }

  process.exit(result.exitCode);
}
