/**
 * Plan Fix pipeline.
 *
 * Takes pipeline findings (failures from validate, security, quality, deps) and
 * uses the LLM to produce a structured fix plan with discrete, human-approvable
 * steps. The plan is written to `.specguard/fix-plan.json` for the dashboard's
 * approval flow, and returned in the PipelineResult.
 *
 * This pipeline is intentionally read-only — it produces a plan but does NOT
 * execute any changes. Execution happens after human approval (via the
 * dashboard's "Approve & Execute" button or via `specguard analyze --auto-fix`).
 *
 * Spec: specs/pipelines/plan-fix.md (create after implementation)
 */
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

import type { SpecGuardConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';

export interface PlanFixOpts {
  /** The pipeline whose output we are planning fixes for. */
  sourcePipeline: string;
  /** Human-readable summary of the issues found. */
  issuesSummary: string;
  /** Optional raw log lines from the failing pipeline for more context. */
  logLines?: string[];
}

const FixStepSchema = z.object({
  id: z.string().describe('Short unique identifier for this step, e.g. "step-1"'),
  description: z.string().describe('Clear, human-readable description of what this step does'),
  action: z.enum(['run-pipeline', 'edit-file', 'run-command']).describe(
    '"run-pipeline" = call a SpecGuard pipeline; "edit-file" = the human or agent edits a file; "run-command" = run a shell command',
  ),
  pipeline: z.string().optional().describe('Pipeline id when action is "run-pipeline"'),
  file: z.string().optional().describe('File path when action is "edit-file"'),
  content: z.string().optional().describe('Content hint or patch description when action is "edit-file"'),
  command: z.string().optional().describe('Shell command when action is "run-command"'),
});

const FixPlanSchema = z.object({
  title: z.string().describe('Short title for this fix plan, e.g. "Fix validate failures"'),
  summary: z.string().describe('1-3 sentence summary of the issues and the overall approach'),
  steps: z.array(FixStepSchema).max(10).describe('Ordered list of concrete steps to fix the issues'),
});

const SYSTEM_PROMPT = [
  'You are SpecGuard, an automated QA system. A pipeline has reported failures.',
  'Produce a concise, actionable fix plan with discrete steps that a developer',
  '(or an AI agent with approval) can execute one at a time.',
  '',
  'Rules:',
  '- Prefer "run-pipeline" steps (e.g. run heal, run generate) for issues that',
  '  SpecGuard can auto-fix.',
  '- Use "edit-file" steps when the fix requires a human decision.',
  '- Use "run-command" steps for package installs, upgrades, or similar.',
  '- Keep steps minimal — do not over-engineer. 3-7 steps is ideal.',
  '- Do NOT invent issues that are not in the provided failure summary.',
  '- Output ONLY the JSON object — no surrounding prose.',
].join('\n');

export async function runPlanFix(
  config: SpecGuardConfig,
  opts: PlanFixOpts,
): Promise<PipelineResult & { plan: z.infer<typeof FixPlanSchema> | null }> {
  const result = emptyResult('plan-fix') as PipelineResult & { plan: z.infer<typeof FixPlanSchema> | null };
  result.plan = null;

  const prompt = [
    `Pipeline: ${opts.sourcePipeline}`,
    '',
    'Issues found:',
    opts.issuesSummary,
    ...(opts.logLines && opts.logLines.length > 0
      ? ['', 'Relevant log output:', ...opts.logLines.slice(-20)]
      : []),
    '',
    'Produce a fix plan following the provided schema.',
  ].join('\n');

  try {
    const plan = await llmGenerateObject({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      system: SYSTEM_PROMPT,
      prompt,
      schema: FixPlanSchema,
    });

    result.plan = plan;
    result.messages.push(`[plan-fix] created: ${plan.title}`);
    result.messages.push(`[plan-fix] ${plan.steps.length} step(s)`);
    for (const s of plan.steps) {
      result.messages.push(`  ${s.id}: ${s.description}`);
      result.items.push({ key: s.id, status: 'created', message: s.description });
    }
    result.created = plan.steps.length;

    // Persist plan for the dashboard to pick up
    try {
      const outDir = path.join(config.rootDir ?? process.cwd(), '.specguard');
      fs.mkdirSync(outDir, { recursive: true });
      const stored = {
        generatedAt: new Date().toISOString(),
        sourcePipeline: opts.sourcePipeline,
        title: plan.title,
        summary: plan.summary,
        steps: plan.steps,
      };
      fs.writeFileSync(path.join(outDir, 'fix-plan.json'), JSON.stringify(stored, null, 2));
    } catch { /* best-effort */ }

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    result.messages.push(`[plan-fix] failed: ${msg}`);
    result.items.push({ key: 'plan-fix', status: 'failed', message: msg });
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
  }

  return result;
}
