/**
 * Knip adapter.
 *
 * Runs `npx knip --reporter json` in the target directory and normalises
 * results to typed `KnipFinding[]`. Follows the same thin-wrapper pattern
 * as npm-audit.ts: never throws, returns { ok: false } on any error.
 *
 * Knip detects: unused exports, unused files, unused dependencies,
 * unused devDependencies, and duplicate exports.
 *
 * Spec: specs/adapters/knip.md (to be created as needed)
 */
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnipFindingKind = 'unused-export' | 'unused-file' | 'unused-dep' | 'duplicate-export' | 'unlisted-dep';

export interface KnipFinding {
  file: string;
  name?: string;
  kind: KnipFindingKind;
  message: string;
  source: 'knip';
}

export interface KnipResult {
  findings: KnipFinding[];
  /** `true` when knip ran (even with findings). `false` when tool unavailable. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Runner seam
// ---------------------------------------------------------------------------

export const knipRunner = {
  run(cwd: string): { stdout: string | null; status: number | null; error?: Error } {
    const res = spawnSync(
      'npx',
      ['knip', '--reporter', 'json'],
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
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

/**
 * Knip JSON output shape (simplified — we only extract what we need).
 * The full schema is at https://knip.dev/reference/reporters
 */
interface KnipOutput {
  files?: string[];
  issues?: {
    file: string;
    dependencies?: Array<{ name: string }>;
    devDependencies?: Array<{ name: string }>;
    unlisted?: Array<{ name: string }>;
    exports?: Array<{ name: string; line?: number }>;
    duplicates?: Array<{ name: string }[]>;
  }[];
}

function parseKnipOutput(stdout: string): KnipResult {
  let doc: KnipOutput;
  try {
    doc = JSON.parse(stdout) as KnipOutput;
  } catch {
    return { findings: [], ok: false };
  }

  const findings: KnipFinding[] = [];

  // Unused files
  for (const f of doc.files ?? []) {
    findings.push({ file: f, kind: 'unused-file', message: 'File is unused (no imports)', source: 'knip' });
  }

  // Per-file issues
  for (const issue of doc.issues ?? []) {
    const file = issue.file ?? '(unknown)';

    for (const dep of issue.dependencies ?? []) {
      findings.push({ file, name: dep.name, kind: 'unused-dep', message: `Unused dependency: ${dep.name}`, source: 'knip' });
    }

    for (const dep of issue.devDependencies ?? []) {
      findings.push({ file, name: dep.name, kind: 'unused-dep', message: `Unused devDependency: ${dep.name}`, source: 'knip' });
    }

    for (const dep of issue.unlisted ?? []) {
      findings.push({ file, name: dep.name, kind: 'unlisted-dep', message: `Unlisted dependency (used but not declared): ${dep.name}`, source: 'knip' });
    }

    for (const exp of issue.exports ?? []) {
      findings.push({ file, name: exp.name, kind: 'unused-export', message: `Unused export: ${exp.name}`, source: 'knip' });
    }

    for (const group of issue.duplicates ?? []) {
      const names = group.map((d) => d.name).join(', ');
      findings.push({ file, name: names, kind: 'duplicate-export', message: `Duplicate exports: ${names}`, source: 'knip' });
    }
  }

  return { findings, ok: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `npx knip --reporter json` in `projectDir`.
 * Never throws; returns `{ ok: false }` when knip is not available.
 */
export async function runKnip(projectDir: string): Promise<KnipResult> {
  try {
    const res = knipRunner.run(projectDir);

    if (res.error || res.stdout === null) {
      return { findings: [], ok: false };
    }

    const stdout = res.stdout.trim();
    if (!stdout) return { findings: [], ok: true };

    return parseKnipOutput(stdout);
  } catch {
    return { findings: [], ok: false };
  }
}
