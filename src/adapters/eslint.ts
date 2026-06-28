/**
 * ESLint adapter.
 *
 * Runs `npx eslint --format json .` in the target directory and normalises
 * results to a typed `EslintFinding[]`. Follows the same thin-wrapper pattern
 * as npm-audit.ts: never throws, returns { ok: false } on any error.
 *
 * Spec: specs/adapters/eslint.md (to be created as needed)
 */
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EslintFinding {
  file: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  ruleId: string;
  source: 'eslint';
}

export interface EslintResult {
  findings: EslintFinding[];
  /** `true` when eslint ran (even with findings). `false` when tool unavailable. */
  ok: boolean;
  /** Total errors reported by eslint. */
  errorCount: number;
  /** Total warnings reported by eslint. */
  warningCount: number;
}

// ---------------------------------------------------------------------------
// Runner seam (stubbed in tests)
// ---------------------------------------------------------------------------

export const eslintRunner = {
  run(cwd: string): { stdout: string | null; status: number | null; error?: Error } {
    const res = spawnSync(
      'npx',
      ['eslint', '--format', 'json', '--no-error-on-unmatched-pattern', '.'],
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    return {
      stdout: res.stdout as string | null,
      status: res.status,
      error: res.error,
    };
  },
};

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/** ESLint's JSON output per file. */
interface EslintFileResult {
  filePath?: string;
  messages?: Array<{
    ruleId?: string | null;
    severity?: number;
    message?: string;
    line?: number;
    column?: number;
  }>;
  errorCount?: number;
  warningCount?: number;
}

function severityLabel(n: number | undefined): 'error' | 'warning' | 'info' {
  if (n === 2) return 'error';
  if (n === 1) return 'warning';
  return 'info';
}

function parseEslintOutput(stdout: string, cwd: string): EslintResult {
  let docs: EslintFileResult[];
  try {
    docs = JSON.parse(stdout) as EslintFileResult[];
    if (!Array.isArray(docs)) return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
  } catch {
    return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
  }

  let errorCount = 0;
  let warningCount = 0;
  const findings: EslintFinding[] = [];

  for (const file of docs) {
    errorCount += file.errorCount ?? 0;
    warningCount += file.warningCount ?? 0;

    const relativePath = file.filePath
      ? file.filePath.replace(cwd, '').replace(/^[/\\]/, '')
      : '(unknown)';

    for (const msg of file.messages ?? []) {
      findings.push({
        file: relativePath,
        line: msg.line,
        column: msg.column,
        severity: severityLabel(msg.severity),
        message: msg.message ?? '',
        ruleId: msg.ruleId ?? '(no rule)',
        source: 'eslint',
      });
    }
  }

  return { findings, ok: true, errorCount, warningCount };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `npx eslint --format json .` in `projectDir`.
 * Never throws; returns `{ ok: false }` when eslint is not available.
 */
export async function runEslint(projectDir: string): Promise<EslintResult> {
  try {
    const res = eslintRunner.run(projectDir);

    if (res.error || res.stdout === null) {
      return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
    }

    // eslint exits non-zero when lint errors exist but stdout is still valid JSON
    const stdout = res.stdout.trim();
    if (!stdout) return { findings: [], ok: true, errorCount: 0, warningCount: 0 };

    return parseEslintOutput(stdout, projectDir);
  } catch {
    return { findings: [], ok: false, errorCount: 0, warningCount: 0 };
  }
}
