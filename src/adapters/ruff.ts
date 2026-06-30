/**
 * Ruff adapter (Python linting).
 *
 * Runs `ruff check --output-format json .` in the target directory and
 * normalises results to the same shape as the ESLint adapter so the
 * code-quality pipeline can consume either uniformly. Never throws; returns
 * `{ ok: false }` when ruff is unavailable.
 *
 * Spec: specs/adapters/ruff.md (to be created as needed)
 */
import { spawnSync } from 'node:child_process';

import type { EslintFinding, EslintResult } from './eslint.js';

export const ruffRunner = {
  run(cwd: string): { stdout: string | null; status: number | null; error?: Error } {
    const res = spawnSync('ruff', ['check', '--output-format', 'json', '.'], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    return {
      stdout: res.stdout as string | null,
      status: res.status,
      error: res.error,
    };
  },
};

/** One entry from ruff's JSON output. */
interface RuffMessage {
  filename?: string;
  code?: string | null;
  message?: string;
  location?: { row?: number; column?: number };
}

function parseRuffOutput(stdout: string, cwd: string): EslintResult {
  let docs: RuffMessage[];
  try {
    docs = JSON.parse(stdout) as RuffMessage[];
    if (!Array.isArray(docs)) return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
  } catch {
    return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
  }

  const findings: EslintFinding[] = [];
  for (const m of docs) {
    const relativePath = m.filename
      ? m.filename.replace(cwd, '').replace(/^[/\\]/, '')
      : '(unknown)';
    findings.push({
      file: relativePath,
      line: m.location?.row,
      column: m.location?.column,
      severity: 'error',
      message: m.message ?? '',
      ruleId: m.code ?? '(no rule)',
      source: 'eslint', // shape-compatible; the pipeline labels by app/runner
    });
  }
  // Ruff findings are lint errors; count them all as errors.
  return { findings, ok: true, errorCount: findings.length, warningCount: 0 };
}

/**
 * Run `ruff check --output-format json .` in `projectDir`.
 * Never throws; returns `{ ok: false }` when ruff is not available.
 */
export async function runRuff(projectDir: string): Promise<EslintResult> {
  try {
    const res = ruffRunner.run(projectDir);
    if (res.error || res.stdout === null) {
      return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
    }
    const stdout = res.stdout.trim();
    if (!stdout) return { findings: [], ok: true, errorCount: 0, warningCount: 0 };
    return parseRuffOutput(stdout, projectDir);
  } catch {
    return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
  }
}
