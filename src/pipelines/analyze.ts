/**
 * Analyze pipeline.
 *
 * Runs status, drift, quality, and dep-check internally and returns a
 * prioritised list of recommended pipelines to run next. This is the "smart
 * start" entry point — instead of knowing which pipeline to run, call analyze
 * and let SpecGuard decide.
 *
 * Spec: specs/pipelines/analyze.md (create after implementation)
 *
 * Output
 * ------
 * Returns a PipelineResult whose `items` entries carry recommendations as their
 * `key` (the pipeline id) and `message` (the human-readable reason). The
 * pipeline also writes a structured JSON report to
 * `.specguard/analysis.json` for consumption by the dashboard and MCP.
 *
 * Exit codes
 * ----------
 * 0 = nothing to do (workspace is healthy)
 * 1 = internal error
 * 4 = recommendations exist (same as MissingSpecs — "work to do")
 */
import path from 'node:path';
import fs from 'node:fs';

import type { SpecGuardConfig, PipelineResult, PipelineItem } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { runStatus } from './status.js';
import { runDrift } from './drift.js';
import { runCodeQuality } from './code-quality.js';
import { runDepCheck } from './dep-check.js';
import { runGapAnalysis } from './gap-analysis.js';

export interface AnalyzeOpts {
  /** Run the recommended pipelines automatically after analysis. */
  autoFix?: boolean;
}

export interface AnalysisRecommendation {
  pipeline: string;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}

export interface AnalysisReport {
  generatedAt: string;
  recommendations: AnalysisRecommendation[];
  summary: {
    missingSpecs: number;
    driftedSpecs: number;
    qualityFindings: number;
    depFindings: number;
    unimplementedSpecs: number;
  };
}

export async function runAnalyze(
  config: SpecGuardConfig,
  opts: AnalyzeOpts,
): Promise<PipelineResult & { analysisReport: AnalysisReport }> {
  const result = emptyResult('analyze') as PipelineResult & { analysisReport: AnalysisReport };
  const recs: AnalysisRecommendation[] = [];
  const summary = { missingSpecs: 0, driftedSpecs: 0, qualityFindings: 0, depFindings: 0, unimplementedSpecs: 0 };

  const log = (line: string) => { result.messages.push(line); };

  // --- Status (missing specs) ---
  log('[analyze] checking spec coverage...');
  try {
    const statusResult = await runStatus(config, {});
    const missing = statusResult.items.filter((i) => i.status === 'skipped' || i.message?.includes('missing'));
    summary.missingSpecs = missing.length;
    if (statusResult.exitCode === ExitCode.MissingSpecs) {
      const count = statusResult.items.filter((i) => !i.message?.includes('spec exists')).length;
      summary.missingSpecs = count;
      recs.push({
        pipeline: 'reverse',
        reason: `${count} source files lack Living Specs — run reverse to generate them`,
        priority: 'high',
      });
    }
  } catch (err) {
    log(`[analyze] status check failed: ${(err as Error).message}`);
  }

  // --- Drift (stale specs) ---
  log('[analyze] checking spec drift...');
  try {
    const driftResult = await runDrift(config, {});
    if (driftResult.exitCode === ExitCode.DriftDetected) {
      summary.driftedSpecs = driftResult.items.filter((i) => i.status === 'failed').length;
      recs.push({
        pipeline: 'drift',
        reason: `${summary.driftedSpecs} spec(s) are stale — source changed after last spec update`,
        priority: 'high',
      });
      // If there are stale specs, heal might fix generated tests
      recs.push({
        pipeline: 'heal',
        reason: 'spec drift may have broken generated tests — heal can auto-fix them',
        priority: 'medium',
      });
    }
  } catch (err) {
    log(`[analyze] drift check failed: ${(err as Error).message}`);
  }

  // Recommend standard regeneration pipelines based on what's available
  const totalSpecs = config.apps.reduce((s, _a) => s + 1, 0); // rough proxy
  if (totalSpecs > 0 && summary.missingSpecs === 0) {
    // We have specs — recommend running them through the loop if not recently run
    recs.push({
      pipeline: 'generate',
      reason: 'regenerate test code from latest specs',
      priority: 'medium',
    });
    recs.push({
      pipeline: 'security',
      reason: 'run SAST analysis and generate security tests',
      priority: 'medium',
    });
    recs.push({
      pipeline: 'docs',
      reason: 'regenerate user-facing documentation from latest specs',
      priority: 'low',
    });
    recs.push({
      pipeline: 'matrix',
      reason: 'refresh the traceability matrix linking specs to tests and docs',
      priority: 'low',
    });
  }

  // --- Gap analysis (unimplemented specs) ---
  log('[analyze] checking for unimplemented specs...');
  try {
    const gapResult = await runGapAnalysis(config, { plan: false }); // no LLM here — just detect
    const unimpl = gapResult.gaps.filter((g) => g.status === 'unimplemented').length;
    const partial = gapResult.gaps.filter((g) => g.status === 'partial').length;
    summary.unimplementedSpecs = unimpl;
    if (unimpl > 0) {
      recs.push({
        pipeline: 'gap-analysis',
        reason: `${unimpl} spec(s) have no matching source code — run gap-analysis to generate implementation plans`,
        priority: 'high',
      });
    }
    if (partial > 0) {
      recs.push({
        pipeline: 'gap-analysis',
        reason: `${partial} spec(s) are partially implemented (unchecked acceptance criteria)`,
        priority: 'medium',
      });
    }
  } catch (err) {
    log(`[analyze] gap check failed: ${(err as Error).message}`);
  }

  // --- Code quality ---
  log('[analyze] checking code quality...');
  try {
    const qualityResult = await runCodeQuality(config, {});
    summary.qualityFindings = qualityResult.failed;
    if (qualityResult.failed > 0) {
      recs.push({
        pipeline: 'quality',
        reason: `${qualityResult.failed} lint/dead-code issue(s) found`,
        priority: 'medium',
      });
    }
  } catch (err) {
    log(`[analyze] quality check failed: ${(err as Error).message}`);
  }

  // --- Dependency audit ---
  log('[analyze] checking dependencies...');
  try {
    const depResult = await runDepCheck(config, {});
    summary.depFindings = depResult.failed;
    if (depResult.failed > 0) {
      recs.push({
        pipeline: 'deps',
        reason: `${depResult.failed} vulnerable/unused dependency issue(s) found`,
        priority: depResult.failed >= 3 ? 'high' : 'medium',
      });
    }
  } catch (err) {
    log(`[analyze] dep check failed: ${(err as Error).message}`);
  }

  // Deduplicate recommendations by pipeline (keep highest priority).
  const seen = new Map<string, AnalysisRecommendation>();
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  for (const r of recs) {
    const prev = seen.get(r.pipeline);
    if (!prev || priorityRank[r.priority] < priorityRank[prev.priority]) {
      seen.set(r.pipeline, r);
    }
  }
  const dedupedRecs = [...seen.values()].sort(
    (a, b) => priorityRank[a.priority] - priorityRank[b.priority],
  );

  const report: AnalysisReport = {
    generatedAt: new Date().toISOString(),
    recommendations: dedupedRecs,
    summary,
  };

  // Persist report
  try {
    const outDir = path.join(config.rootDir ?? process.cwd(), '.specguard');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'analysis.json'), JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }

  // Log recommendations
  if (dedupedRecs.length === 0) {
    log('[analyze] workspace looks healthy — no recommendations');
  } else {
    log(`[analyze] ${dedupedRecs.length} recommendation(s):`);
    for (const r of dedupedRecs) {
      log(`  [${r.priority}] ${r.pipeline}: ${r.reason}`);
      result.items.push({ key: r.pipeline, status: 'created', message: r.reason });
    }
  }

  result.analysisReport = report;
  result.exitCode = dedupedRecs.length > 0 ? ExitCode.MissingSpecs : ExitCode.Success;

  return result;
}
