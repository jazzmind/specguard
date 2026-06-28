/**
 * Depcheck adapter.
 *
 * Runs `npx depcheck --json` in the target directory and normalises results to
 * `DepcheckFinding[]`. Follows the same thin-wrapper pattern as npm-audit.ts:
 * never throws, returns { ok: false } on any error.
 *
 * Depcheck detects: unused dependencies, unused devDependencies, and missing
 * dependencies (imported but not declared in package.json).
 *
 * Spec: specs/adapters/depcheck.md (to be created as needed)
 */
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DepcheckFindingKind = 'unused-dep' | 'unused-dev-dep' | 'missing-dep';

export interface DepcheckFinding {
  name: string;
  kind: DepcheckFindingKind;
  message: string;
  /** Files that import this dep (for missing-dep findings). */
  usedIn?: string[];
  source: 'depcheck';
}

export interface DepcheckResult {
  findings: DepcheckFinding[];
  /** `true` when depcheck ran (even with findings). `false` when tool unavailable. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Runner seam
// ---------------------------------------------------------------------------

export const depcheckRunner = {
  run(cwd: string): { stdout: string | null; status: number | null; error?: Error } {
    const res = spawnSync(
      'npx',
      ['depcheck', '--json'],
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
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

interface DepcheckOutput {
  dependencies?: string[];
  devDependencies?: string[];
  missing?: Record<string, string[]>;
  using?: Record<string, string[]>;
  invalidFiles?: Record<string, string>;
  invalidDirs?: Record<string, string>;
}

function parseDepcheckOutput(stdout: string): DepcheckResult {
  let doc: DepcheckOutput;
  try {
    doc = JSON.parse(stdout) as DepcheckOutput;
  } catch {
    return { findings: [], ok: false };
  }

  const findings: DepcheckFinding[] = [];

  for (const name of doc.dependencies ?? []) {
    findings.push({
      name,
      kind: 'unused-dep',
      message: `Unused dependency: ${name}`,
      source: 'depcheck',
    });
  }

  for (const name of doc.devDependencies ?? []) {
    findings.push({
      name,
      kind: 'unused-dev-dep',
      message: `Unused devDependency: ${name}`,
      source: 'depcheck',
    });
  }

  for (const [name, files] of Object.entries(doc.missing ?? {})) {
    findings.push({
      name,
      kind: 'missing-dep',
      message: `Missing dependency (not in package.json): ${name}`,
      usedIn: Array.isArray(files) ? files : [],
      source: 'depcheck',
    });
  }

  return { findings, ok: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `npx depcheck --json` in `projectDir`.
 * Never throws; returns `{ ok: false }` when depcheck is not available.
 */
export async function runDepcheck(projectDir: string): Promise<DepcheckResult> {
  try {
    const res = depcheckRunner.run(projectDir);

    if (res.error || res.stdout === null) {
      return { findings: [], ok: false };
    }

    const stdout = res.stdout.trim();
    if (!stdout) return { findings: [], ok: true };

    return parseDepcheckOutput(stdout);
  } catch {
    return { findings: [], ok: false };
  }
}
