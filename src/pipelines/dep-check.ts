/**
 * Dep-check pipeline.
 *
 * Runs npm-audit (security vulnerabilities) and depcheck (unused / missing
 * dependencies) against one or more app repos and aggregates the findings.
 *
 * Output: .specguard/dep-check.json — a JSON report consumed by the VS Code
 * dashboard's FindingsView and by CI fail-gates.
 *
 * CLI: specguard deps [--app <name>]
 */
import path from 'node:path';
import fs from 'node:fs';

import type { SpecGuardConfig, AppConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { runNpmAudit } from '../adapters/npm-audit.js';
import { runDepcheck, type DepcheckFinding } from '../adapters/depcheck.js';
import type { SastFinding } from './security.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DepFinding {
  name: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'vulnerability' | 'unused-dep' | 'unused-dev-dep' | 'missing-dep';
  message: string;
  rule: string;
  source: string;
  /** Files using this dep (for missing-dep findings). */
  usedIn?: string[];
}

export interface DepCheckReport {
  generatedAt: string;
  apps: Array<{
    name: string;
    vulnerabilityCount: number;
    unusedCount: number;
    missingCount: number;
    findings: DepFinding[];
  }>;
  findings: DepFinding[];
  totalVulnerabilities: number;
  totalUnused: number;
  totalMissing: number;
}

export interface DepCheckOpts {
  /** Restrict to a single app by name. */
  app?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function appsInScope(config: SpecGuardConfig, opts: DepCheckOpts): AppConfig[] {
  if (!opts.app) return config.apps;
  const app = config.apps.find((a) => a.name === opts.app);
  if (!app) {
    const known = config.apps.map((a) => a.name).join(', ') || '(none)';
    throw new SpecGuardError(`Unknown app \`${opts.app}\`. Known apps: ${known}.`, ExitCode.InternalError);
  }
  return [app];
}

function vulnerabilitySeverity(sev?: string): DepFinding['severity'] {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'moderate' || s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return 'info';
}

function normalizeAudit(findings: SastFinding[]): DepFinding[] {
  return findings.map((f) => ({
    name: f.ruleId,
    severity: vulnerabilitySeverity(f.severity),
    category: 'vulnerability' as const,
    message: f.message,
    rule: f.ruleId,
    source: 'npm-audit',
  }));
}

function normalizeDepcheck(findings: DepcheckFinding[]): DepFinding[] {
  return findings.map((f) => ({
    name: f.name,
    severity: 'info' as const,
    category: f.kind === 'missing-dep' ? 'missing-dep'
             : f.kind === 'unused-dev-dep' ? 'unused-dev-dep'
             : 'unused-dep' as DepFinding['category'],
    message: f.message,
    rule: f.kind,
    source: 'depcheck',
    usedIn: f.usedIn,
  }));
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runDepCheck(
  config: SpecGuardConfig,
  opts: DepCheckOpts = {},
): Promise<PipelineResult> {
  const result = emptyResult('dep-check');
  const apps = appsInScope(config, opts);

  const allFindings: DepFinding[] = [];
  const appReports: DepCheckReport['apps'] = [];
  let totalVulnerabilities = 0;
  let totalUnused = 0;
  let totalMissing = 0;

  for (const app of apps) {
    const repoAbs = resolveFromRoot(config, app.repo);
    const log = (line: string) => result.messages.push(line);

    log(`[deps] ${app.name}: running npm-audit + depcheck in ${repoAbs}`);

    const [auditResult, depcheckResult] = await Promise.all([
      runNpmAudit(repoAbs),
      runDepcheck(repoAbs),
    ]);

    const vulnFindings = normalizeAudit(auditResult.findings);
    const depFindings = normalizeDepcheck(depcheckResult.findings);
    const appFindings = [...vulnFindings, ...depFindings];

    const vulnCount = vulnFindings.length;
    const unusedCount = depFindings.filter((f) => f.category !== 'missing-dep').length;
    const missingCount = depFindings.filter((f) => f.category === 'missing-dep').length;

    if (auditResult.ok) {
      log(`[npm-audit] ${app.name}: ${vulnCount} vulnerability(ies)`);
    } else {
      log(`[warn] ${app.name}: npm audit not available`);
    }

    if (depcheckResult.ok) {
      log(`[depcheck] ${app.name}: ${unusedCount} unused, ${missingCount} missing dep(s)`);
    } else {
      log(`[warn] ${app.name}: depcheck not available`);
    }

    totalVulnerabilities += vulnCount;
    totalUnused += unusedCount;
    totalMissing += missingCount;
    allFindings.push(...appFindings);

    appReports.push({ name: app.name, vulnerabilityCount: vulnCount, unusedCount, missingCount, findings: appFindings });
  }

  // Write report
  const reportDir = resolveFromRoot(config, '.specguard');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'dep-check.json');
  const report: DepCheckReport = {
    generatedAt: new Date().toISOString(),
    apps: appReports,
    findings: allFindings,
    totalVulnerabilities,
    totalUnused,
    totalMissing,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  result.messages.push(`[deps] wrote ${reportPath}`);
  result.messages.push(`[deps] ${totalVulnerabilities} vulnerability(ies), ${totalUnused} unused dep(s), ${totalMissing} missing dep(s)`);

  result.created = allFindings.length;

  // Fail gate: non-zero exit if critical/high vulnerabilities found
  const criticalOrHigh = allFindings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
  if (criticalOrHigh > 0) {
    result.exitCode = ExitCode.SecurityIssues;
  }

  return result;
}
