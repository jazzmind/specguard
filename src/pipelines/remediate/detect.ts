/**
 * Detection: dependency advisories (ecosystem audit + OSV), Semgrep findings, gitleaks secrets.
 * Dedupes, applies the ignore file, sorts by severity and applies the threshold.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyIgnore,
  dedupeAdvisories,
  loadIgnoreFile,
  meetsThreshold,
  normalizeSeverity,
  sortAdvisories,
  type Advisory,
  type Severity,
} from '../../core/advisory.js';
import { detectDependencyAdvisories } from '../../core/ecosystems/index.js';
import type { SpecGuardConfig } from '../../core/types.js';
import { sast } from '../security.js';
import type { DetectionReport, RemediateDeps, SastIssue, SecretIssue } from './types.js';

export interface DetectOpts {
  threshold: Severity;
  /** Only this advisory id/alias. */
  advisory?: string;
  useOsv?: boolean;
  useSemgrep?: boolean;
  useGitleaks?: boolean;
  app?: string;
}

/** Distinct project directories to audit: each app's repo, relative to the config root. */
export function projectDirs(config: SpecGuardConfig, root: string, app?: string): string[] {
  const dirs = new Set<string>();
  for (const a of config.apps) {
    if (app && a.name !== app) continue;
    dirs.add(path.resolve(root, a.repo || '.'));
  }
  return [...dirs];
}

function semgrepSeverity(s: string | undefined): Severity {
  const v = (s ?? '').toUpperCase();
  if (v === 'ERROR') return 'high';
  if (v === 'WARNING') return 'moderate';
  if (v === 'INFO') return 'low';
  return normalizeSeverity(s);
}

function relSrc(p: string): string {
  return p.replace(/^\/src\//, '').replace(/^\.\//, '');
}

export async function detectSecrets(dir: string, deps: Pick<RemediateDeps, 'run'>): Promise<{ issues: SecretIssue[]; warning?: string }> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sg-gitleaks-'));
  const report = path.join(tmp, 'report.json');
  try {
    const res = await deps.run('gitleaks', ['detect', '--no-git', '--redact', '--source', '.', '--report-format', 'json', '--report-path', report, '--exit-code', '0'], { cwd: dir, timeoutMs: 180_000 });
    if (res.error === 'ENOENT') return { issues: [], warning: 'gitleaks is not installed; secret scan skipped (install from https://github.com/gitleaks/gitleaks).' };
    let rows: Array<{ RuleID?: string; Description?: string; File?: string; StartLine?: number }> = [];
    try {
      rows = JSON.parse(readFileSync(report, 'utf8')) as typeof rows;
    } catch {
      rows = [];
    }
    // The matched secret is never copied into the report.
    return { issues: rows.map((r) => ({ kind: 'secret' as const, ruleId: r.RuleID ?? 'secret', path: r.File ?? '', line: r.StartLine, message: `${r.Description ?? 'Possible secret'} (needs rotation; not auto-fixed)` })) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function detect(config: SpecGuardConfig, root: string, deps: RemediateDeps, opts: DetectOpts): Promise<DetectionReport> {
  const warnings: string[] = [];
  const sources: string[] = [];
  let all: Advisory[] = [];
  const dirs = projectDirs(config, root, opts.app);

  for (const dir of dirs) {
    const det = await detectDependencyAdvisories(dir, { run: deps.run, useOsv: opts.useOsv });
    const rel = path.relative(root, dir).split(path.sep).join('/');
    all.push(...det.advisories.map((a) => ({ ...a, repo: rel || undefined })));
    warnings.push(...det.warnings.map((w) => (dirs.length > 1 ? `[${rel || '.'}] ${w}` : w)));
    for (const s of det.sources) if (!sources.includes(s)) sources.push(s);
  }
  all = dedupeAdvisories(all);

  if (opts.advisory) {
    const want = opts.advisory.toUpperCase();
    all = all.filter((a) => [a.id, ...a.aliases].some((i) => i.toUpperCase() === want));
  }

  const ignored = applyIgnore(all, loadIgnoreFile(root), deps.now());
  const sorted = sortAdvisories(ignored.kept);
  const advisories = sorted.filter((a) => meetsThreshold(a.severity, opts.threshold));
  const belowThreshold = sorted.filter((a) => !meetsThreshold(a.severity, opts.threshold));

  const sastIssues: SastIssue[] = [];
  if (opts.useSemgrep !== false && !opts.advisory) {
    for (const dir of dirs) {
      const res = await (deps.sast ?? ((d: string) => sast.run(d)))(dir);
      if (!res.ok) {
        warnings.push('semgrep did not run (Docker/Semgrep unavailable); SAST findings skipped.');
        break;
      }
      sources.includes('semgrep') || sources.push('semgrep');
      for (const f of res.findings) {
        const sev = semgrepSeverity(f.severity);
        if (!meetsThreshold(sev, opts.threshold)) continue;
        const rel = path.relative(root, path.resolve(dir, relSrc(f.path))).split(path.sep).join('/');
        sastIssues.push({ kind: 'sast', ruleId: f.ruleId, path: rel, line: f.line, message: f.message, severity: sev });
      }
    }
  }

  const secrets: SecretIssue[] = [];
  if (opts.useGitleaks !== false && !opts.advisory) {
    const seen = new Set<string>();
    for (const dir of dirs) {
      const g = await detectSecrets(dir, deps);
      if (g.warning) {
        if (!seen.has(g.warning)) warnings.push(g.warning);
        seen.add(g.warning);
        break;
      }
      sources.includes('gitleaks') || sources.push('gitleaks');
      secrets.push(...g.issues.map((i) => ({ ...i, path: path.relative(root, path.resolve(dir, i.path)).split(path.sep).join('/') })));
    }
  }

  return {
    advisories,
    suppressed: ignored.suppressed.map((s) => ({ id: s.advisory.id, reason: s.entry.reason, expires: s.entry.expires })),
    belowThreshold,
    sast: sastIssues,
    secrets,
    warnings,
    sources,
    threshold: opts.threshold,
  };
}
