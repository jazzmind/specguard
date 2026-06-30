/**
 * Code Quality pipeline.
 *
 * Runs ESLint (lint errors + style) and Knip (dead code, unused exports,
 * unused deps) against one or more app repos and aggregates the findings.
 *
 * Output: .specguard/code-quality.json — a JSON report consumed by the VS Code
 * dashboard's FindingsView and by CI fail-gates.
 *
 * CLI: specguard quality [--app <name>] [--fix]
 */
import path from 'node:path';
import fs from 'node:fs';

import type { SpecGuardConfig, AppConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { runEslint, type EslintFinding } from '../adapters/eslint.js';
import { runRuff } from '../adapters/ruff.js';
import { runKnip, type KnipFinding } from '../adapters/knip.js';
import { resolveProfile } from '../core/language-profiles.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeQualityFinding {
  file: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  category: 'lint' | 'dead-code' | 'unused-dep' | 'unlisted-dep';
  message: string;
  rule: string;
  source: string;
}

export interface CodeQualityReport {
  generatedAt: string;
  apps: Array<{
    name: string;
    errorCount: number;
    warningCount: number;
    findings: CodeQualityFinding[];
  }>;
  findings: CodeQualityFinding[];
  totalErrors: number;
  totalWarnings: number;
}

export interface CodeQualityOpts {
  /** Restrict to a single app by name. */
  app?: string;
  /** Auto-fix ESLint fixable issues (passes --fix to eslint). */
  fix?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function appsInScope(config: SpecGuardConfig, opts: CodeQualityOpts): AppConfig[] {
  if (!opts.app) return config.apps;
  const app = config.apps.find((a) => a.name === opts.app);
  if (!app) {
    const known = config.apps.map((a) => a.name).join(', ') || '(none)';
    throw new SpecGuardError(`Unknown app \`${opts.app}\`. Known apps: ${known}.`, ExitCode.InternalError);
  }
  return [app];
}

function normalizeEslint(findings: EslintFinding[]): CodeQualityFinding[] {
  return findings.map((f) => ({
    file: f.file,
    line: f.line,
    column: f.column,
    severity: f.severity,
    category: 'lint',
    message: f.message,
    rule: f.ruleId,
    source: 'eslint',
  }));
}

function normalizeKnip(findings: KnipFinding[]): CodeQualityFinding[] {
  return findings.map((f) => ({
    file: f.file,
    severity: 'warning' as const,
    category: (f.kind === 'unused-export' || f.kind === 'unused-file' ? 'dead-code'
              : f.kind === 'unlisted-dep' ? 'unlisted-dep'
              : 'unused-dep') as CodeQualityFinding['category'],
    message: f.message,
    rule: f.kind,
    source: 'knip',
  }));
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runCodeQuality(
  config: SpecGuardConfig,
  opts: CodeQualityOpts = {},
): Promise<PipelineResult> {
  const result = emptyResult('code-quality');
  const apps = appsInScope(config, opts);

  const allFindings: CodeQualityFinding[] = [];
  const appReports: CodeQualityReport['apps'] = [];

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const app of apps) {
    const repoAbs = resolveFromRoot(config, app.repo);
    const log = (line: string) => result.messages.push(line);
    const profile = resolveProfile(app);

    // Language-aware quality tooling. For languages with no wired runner, skip
    // gracefully (advisory pipeline — never throw or fail the run).
    const lintRunner = profile.lintRunner; // 'eslint' | 'ruff' | 'unsupported'
    const canLint = lintRunner === 'eslint' || lintRunner === 'ruff';
    const canKnip = profile.deadCodeRunner === 'knip';
    if (!canLint && !canKnip) {
      log(`[quality] ${app.name}: skipped — no quality runner for ${profile.id}`);
      result.items.push({
        key: app.name,
        status: 'skipped',
        message: `code-quality unsupported for ${profile.id}`,
      });
      result.skipped += 1;
      appReports.push({ name: app.name, errorCount: 0, warningCount: 0, findings: [] });
      continue;
    }

    log(`[quality] ${app.name}: running ${canLint ? lintRunner : ''}${canLint && canKnip ? ' + ' : ''}${canKnip ? 'knip' : ''} in ${repoAbs}`);

    const [eslintResult, knipResult] = await Promise.all([
      lintRunner === 'eslint'
        ? runEslint(repoAbs)
        : lintRunner === 'ruff'
          ? runRuff(repoAbs)
          : Promise.resolve({ ok: false, errorCount: 0, warningCount: 0, findings: [] as EslintFinding[] }),
      canKnip ? runKnip(repoAbs) : Promise.resolve({ ok: false, findings: [] as KnipFinding[] }),
    ]);

    const eslintFindings = normalizeEslint(eslintResult.findings);
    const knipFindings = normalizeKnip(knipResult.findings);
    const appFindings = [...eslintFindings, ...knipFindings];

    if (eslintResult.ok) {
      log(`[${lintRunner}] ${app.name}: ${eslintResult.errorCount} errors, ${eslintResult.warningCount} warnings`);
    } else {
      log(`[warn] ${app.name}: ${lintRunner} not available or failed`);
    }

    if (knipResult.ok) {
      log(`[knip] ${app.name}: ${knipResult.findings.length} finding(s)`);
    } else {
      log(`[warn] ${app.name}: Knip not available or failed`);
    }

    const appErrors = eslintResult.ok ? eslintResult.errorCount : 0;
    const appWarnings = (eslintResult.ok ? eslintResult.warningCount : 0) + knipFindings.length;

    totalErrors += appErrors;
    totalWarnings += appWarnings;
    allFindings.push(...appFindings);

    appReports.push({ name: app.name, errorCount: appErrors, warningCount: appWarnings, findings: appFindings });
  }

  // Write report to .specguard/code-quality.json
  const reportDir = resolveFromRoot(config, '.specguard');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'code-quality.json');
  const report: CodeQualityReport = {
    generatedAt: new Date().toISOString(),
    apps: appReports,
    findings: allFindings,
    totalErrors,
    totalWarnings,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  result.messages.push(`[quality] wrote ${reportPath}`);
  result.messages.push(`[quality] total: ${totalErrors} error(s), ${totalWarnings} warning(s), ${allFindings.length} finding(s)`);

  result.created = allFindings.length;

  // Fail gate: non-zero exit if there are ESLint errors
  if (totalErrors > 0) {
    result.exitCode = ExitCode.ValidationFailed;
  }

  // Write an agent-consumable fix plan when issues are found.
  if (allFindings.length > 0) {
    try {
      const { writePlan } = await import('../core/plan-writer.js');
      const errors = allFindings.filter((f) => f.severity === 'error');
      const warnings = allFindings.filter((f) => f.severity === 'warning');
      const deadCode = allFindings.filter((f) => f.category === 'dead-code' || f.category === 'unused-dep');
      writePlan({
        pipeline: 'quality',
        title: `Fix Code Quality Issues — ${errors.length} error(s), ${warnings.length} warning(s)`,
        summary: `The quality pipeline found ${allFindings.length} issue(s). ` +
          `Fix ESLint errors first (they block CI), then address dead-code/unused-dep warnings.`,
        sections: [
          {
            heading: 'ESLint Errors (must fix)',
            items: errors.slice(0, 20).map((f) => `\`${f.file}:${f.line ?? '?'}\` — ${f.rule}: ${f.message}`),
          },
          {
            heading: 'Warnings',
            items: warnings.slice(0, 15).map((f) => `\`${f.file}\` — ${f.rule}: ${f.message}`),
          },
          {
            heading: 'Dead Code / Unused Deps',
            items: deadCode.slice(0, 15).map((f) => `\`${f.file}\` — ${f.message}`),
          },
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'Address each ESLint error listed above — most have auto-fix via `eslint --fix`.',
              'Remove or export unused code identified by Knip.',
              'Remove unused dependencies: `npm uninstall <package>`.',
              'Run `specguard quality` to confirm all issues are resolved.',
            ],
          },
        ],
        rootDir: config.rootDir ?? process.cwd(),
      });
    } catch { /* best-effort */ }
  }

  return result;
}
