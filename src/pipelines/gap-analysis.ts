/**
 * Gap Analysis pipeline.
 *
 * Scans every spec in each app's specDir and checks whether a corresponding
 * source module exists. Specs with no matching source code are flagged as
 * UNIMPLEMENTED; specs whose acceptance criteria still contain unchecked
 * `- [ ]` items are flagged as PARTIAL.
 *
 * For each gap found, the LLM generates an actionable implementation plan
 * (suggested file structure, key components, API surface) written to
 * `.specguard/plans/<feature>.md`.
 *
 * Integration with analyze: runAnalyze calls this and surfaces the gap count
 * as a high-priority recommendation when unimplemented specs exist.
 *
 * CLI: specguard gap-analysis [--spec <key>] [--all]
 */
import path from 'node:path';
import fs from 'node:fs';

import { z } from 'zod';
import type { SpecGuardConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import { expandGlobs, fileExists } from '../core/reader.js';
import { llmGenerateObject } from '../core/llm.js';
import { writeFile } from '../core/writer.js';
import { resolveProfile, featureFromPath, type LanguageProfile } from '../core/language-profiles.js';
import { writePlan } from '../core/plan-writer.js';

export interface GapAnalysisOpts {
  /** Restrict to a single spec key (e.g. `app/team-sprint-board-mvp`). */
  spec?: string;
  /** Generate implementation plans via LLM (default: true). */
  plan?: boolean;
}

export type GapStatus = 'unimplemented' | 'partial' | 'implemented';

export interface SpecGap {
  specKey: string;
  title: string;
  appName: string;
  status: GapStatus;
  uncheckedCriteria: number;
  totalCriteria: number;
  /** Absolute path to the generated implementation plan, if produced. */
  planPath?: string;
}

export interface GapAnalysisResult extends PipelineResult {
  gaps: SpecGap[];
}

// ---------------------------------------------------------------------------
// LLM schema for implementation plan
// ---------------------------------------------------------------------------

/** Build the plan schema with a language-appropriate file-path example. */
function buildPlanSchema(profile: LanguageProfile) {
  return z.object({
    title: z.string().describe('Short plan title, e.g. "Implement Team Sprint Board API"'),
    summary: z.string().describe('2-4 sentence overview of what needs to be built'),
    suggestedFiles: z.array(z.object({
      path: z.string().describe(`Relative file path, e.g. ${profile.planFileHint}`),
      purpose: z.string().describe('What this file does'),
    })).max(12).describe('Key files to create or edit'),
    implementationSteps: z.array(z.string()).max(10).describe('Ordered steps to implement the spec'),
    testingApproach: z.string().describe('How to verify the implementation against the acceptance criteria'),
  });
}

const SYSTEM_PROMPT = [
  'You are SpecGuard, an automated QA system. A Living Specification exists but',
  'the feature has not been implemented yet (no matching source files found).',
  'Produce a concise, actionable implementation plan so a developer or AI agent',
  'can build it from scratch.',
  '',
  'Rules:',
  '- Base the plan ONLY on what the spec says — do not invent requirements.',
  '- Be concrete about file paths and component names.',
  '- Keep the plan short (≤10 steps, ≤12 suggested files).',
  '- Output ONLY the JSON object, no surrounding prose.',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function countCriteria(acceptanceCriteria: string): { total: number; unchecked: number } {
  const lines = acceptanceCriteria.split('\n');
  const total = lines.filter((l) => /^\s*-\s+\[[ x]\]/i.test(l)).length;
  const unchecked = lines.filter((l) => /^\s*-\s+\[ \]/i.test(l)).length;
  return { total, unchecked };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runGapAnalysis(
  config: SpecGuardConfig,
  opts: GapAnalysisOpts = {},
): Promise<GapAnalysisResult> {
  const result = emptyResult('gap-analysis') as GapAnalysisResult;
  result.gaps = [];

  const log = (line: string) => { result.messages.push(line); };
  const shouldPlan = opts.plan !== false; // default true

  for (const app of config.apps) {
    const repoDir = resolveFromRoot(config, app.repo);
    const specDirAbs = resolveFromRoot(config, app.specDir);

    // Collect all source file paths (for existence check).
    const patterns: string[] = [];
    for (const [group, globs] of Object.entries(app.sources)) {
      if (group === 'tests') continue;
      if (Array.isArray(globs)) patterns.push(...globs);
    }
    const sourceFiles = await expandGlobs(patterns, repoDir);
    // Build a set of feature keys that actually have source files.
    const profile = resolveProfile(app);
    const implementedFeatures = new Set<string>();
    for (const absFile of sourceFiles) {
      implementedFeatures.add(featureFromPath(absFile, repoDir, profile));
    }

    // Load all specs for this app.
    let specs = loadAllSpecs(specDirAbs);
    if (!specs.length) {
      // specDir may not exist yet — silently skip
      continue;
    }

    // Optional single-spec filter.
    if (opts.spec) {
      const filterKey = opts.spec.includes('/') ? opts.spec.split('/').slice(1).join('/') : opts.spec;
      specs = specs.filter((s) => s.specKey === filterKey || `${app.name}/${s.specKey}` === opts.spec);
    }

    const plansDir = path.join(config.rootDir ?? process.cwd(), '.specguard', 'plans');

    for (const spec of specs) {
      const fullKey = `${app.name}/${spec.specKey}`;
      const { total: totalCriteria, unchecked } = countCriteria(spec.acceptanceCriteria);

      const hasSource = implementedFeatures.has(spec.specKey);
      let status: GapStatus;
      if (!hasSource) {
        status = 'unimplemented';
      } else if (unchecked > 0) {
        status = 'partial';
      } else {
        status = 'implemented';
      }

      if (status === 'implemented') {
        log(`[gap] ${fullKey}: implemented`);
        continue;
      }

      log(`[gap] ${fullKey}: ${status} (${unchecked}/${totalCriteria} criteria unchecked, source: ${hasSource ? 'exists' : 'missing'})`);

      const gap: SpecGap = { specKey: fullKey, title: spec.title, appName: app.name, status, uncheckedCriteria: unchecked, totalCriteria };
      result.gaps.push(gap);

      // Generate an implementation plan via LLM for unimplemented specs.
      if (shouldPlan && status === 'unimplemented') {
        // If a plan already exists for this spec, skip the LLM call and reuse it.
        const existingPlanFile = path.join(plansDir, `${spec.specKey.replace(/\//g, '-')}.md`);
        if (fs.existsSync(existingPlanFile)) {
          gap.planPath = existingPlanFile;
          const rel = path.relative(config.rootDir ?? process.cwd(), existingPlanFile);
          log(`[gap] plan already exists at ${rel} — pass it to your coding agent to implement`);
          result.items.push({
            key: fullKey,
            status: 'skipped',
            message: `plan exists — implement using .specguard/plans/${path.basename(existingPlanFile)}`,
          });
          result.failed += 1;
          continue;
        }

        try {
          log(`[gap] generating implementation plan for ${fullKey}…`);
          const prompt = [
            `Spec: ${spec.title}`,
            '',
            `Overview:\n${spec.overview}`,
            '',
            `Acceptance Criteria:\n${spec.acceptanceCriteria}`,
            ...(spec.scenarios.length > 0
              ? ['', `Key Scenarios (${spec.scenarios.length} total):`,
                  ...spec.scenarios.slice(0, 5).map((s) => `- ${s.name}`)]
              : []),
            '',
            'Generate an implementation plan to build this feature from scratch.',
          ].join('\n');

          const plan = await llmGenerateObject({
            provider: config.llm.provider,
            model: config.llm.model,
            apiKeyEnv: config.llm.apiKeyEnv,
            system: SYSTEM_PROMPT,
            prompt,
            schema: buildPlanSchema(profile),
          });

          // Write plan to .specguard/plans/<feature>.md
          fs.mkdirSync(plansDir, { recursive: true });
          const planFile = path.join(plansDir, `${spec.specKey.replace(/\//g, '-')}.md`);
          const planMd = [
            '---',
            `pipeline: gap-analysis`,
            `generatedAt: ${new Date().toISOString()}`,
            `status: pending`,
            `specKey: ${fullKey}`,
            '---',
            '',
            `# Implementation Plan: ${plan.title}`,
            '',
            `> Generated by SpecGuard gap-analysis · ${new Date().toISOString()}`,
            `> Spec: \`${fullKey}\``,
            '',
            `## Summary`,
            '',
            plan.summary,
            '',
            `## Suggested Files`,
            '',
            plan.suggestedFiles.map((f) => `- \`${f.path}\` — ${f.purpose}`).join('\n'),
            '',
            `## Implementation Steps`,
            '',
            plan.implementationSteps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
            '',
            `## Testing Approach`,
            '',
            plan.testingApproach,
          ].join('\n');

          await writeFile(planFile, planMd);
          gap.planPath = planFile;
          log(`[gap] plan written to ${path.relative(config.rootDir ?? process.cwd(), planFile)}`);
          result.created += 1;
        } catch (err) {
          log(`[gap] plan generation failed for ${fullKey}: ${(err as Error).message}`);
        }
      }

      result.items.push({
        key: fullKey,
        status: status === 'unimplemented' ? 'failed' : 'skipped',
        message: status === 'unimplemented'
          ? `spec has no source implementation — plan written to .specguard/plans/`
          : `${unchecked} of ${totalCriteria} acceptance criteria still unchecked`,
      });
      result.failed += 1;
    }
  }

  // Persist gaps report
  try {
    const outDir = path.join(config.rootDir ?? process.cwd(), '.specguard');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'gaps.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), gaps: result.gaps }, null, 2),
    );
  } catch { /* best-effort */ }

  if (result.gaps.length === 0) {
    log('[gap-analysis] all specs appear to be implemented');
  } else {
    const unimpl = result.gaps.filter((g) => g.status === 'unimplemented');
    const partial = result.gaps.filter((g) => g.status === 'partial');
    log(`[gap-analysis] ${unimpl.length} unimplemented, ${partial.length} partial`);

    // Write a summary plan for the coding agent.
    try {
      writePlan({
        pipeline: 'gap-analysis',
        title: `Implement Missing Features — ${unimpl.length} unimplemented, ${partial.length} partial`,
        summary: `Gap analysis found ${unimpl.length} spec(s) with no source implementation and ` +
          `${partial.length} spec(s) that are only partially implemented. ` +
          `Per-spec implementation plans are available under \`.specguard/plans/\`.`,
        sections: [
          {
            heading: 'Unimplemented Specs',
            items: unimpl.map((g) => `\`${g.specKey}\` — "${g.title}"${g.planPath ? ` → see plan` : ''}`),
          },
          {
            heading: 'Partially Implemented Specs',
            items: partial.map((g) => `\`${g.specKey}\` — "${g.title}" (${g.uncheckedCriteria}/${g.totalCriteria} criteria pending)`),
          },
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'Review the per-spec plans under `.specguard/plans/` — each has suggested file structure and implementation steps.',
              'Implement each unimplemented spec following its plan.',
              'For partially implemented specs, check off each acceptance criterion as you implement it.',
              'Run `specguard gap-analysis` to verify implementation progress.',
              'Run `specguard generate --all` to generate tests once source code exists.',
            ],
          },
        ],
        rootDir: config.rootDir ?? process.cwd(),
      });
    } catch { /* best-effort */ }
  }

  result.exitCode = result.failed > 0 ? ExitCode.MissingSpecs : ExitCode.Success;
  return result;
}
