/**
 * pip-audit adapter (Python dependency vulnerabilities).
 *
 * Runs `pip-audit -f json` in the target directory and parses the output into
 * the same `SastFinding[]` shape used by the security / dep-check pipelines,
 * mirroring the npm-audit adapter. Degrades gracefully when pip-audit is not
 * installed.
 */
import { spawnSync } from 'node:child_process';

import type { SastFinding } from '../pipelines/security.js';

export interface PipAuditResult {
  findings: SastFinding[];
  /** `true` when pip-audit ran successfully (even with findings). */
  ok: boolean;
}

/** Seam for test stubbing. */
export const pipAuditRunner = {
  run(cwd: string): { stdout: string | null; status: number | null; error?: Error } {
    const res = spawnSync('pip-audit', ['-f', 'json'], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      stdout: res.stdout as string | null,
      status: res.status,
      error: res.error,
    };
  },
};

interface PipAuditVuln {
  id?: string;
  description?: string;
  fix_versions?: string[];
}
interface PipAuditDep {
  name?: string;
  version?: string;
  vulns?: PipAuditVuln[];
}

/**
 * Run `pip-audit -f json` in `projectDir` and return normalised findings.
 * Never throws; returns `{ ok: false, findings: [] }` on any error.
 */
export async function runPipAudit(projectDir: string): Promise<PipAuditResult> {
  try {
    const res = pipAuditRunner.run(projectDir);
    if (res.error || !res.stdout) {
      return { ok: false, findings: [] };
    }

    let doc: unknown;
    try {
      doc = JSON.parse(res.stdout);
    } catch {
      return { ok: false, findings: [] };
    }

    // pip-audit JSON: either an array of deps, or { dependencies: [...] }.
    const deps: PipAuditDep[] = Array.isArray(doc)
      ? (doc as PipAuditDep[])
      : Array.isArray((doc as { dependencies?: unknown }).dependencies)
        ? ((doc as { dependencies: PipAuditDep[] }).dependencies)
        : [];

    const findings: SastFinding[] = [];
    for (const dep of deps) {
      for (const v of dep.vulns ?? []) {
        findings.push({
          ruleId: `pip-audit/${dep.name ?? 'unknown'}`,
          path: 'requirements.txt',
          message: `${v.id ?? 'vulnerability'} in ${dep.name}@${dep.version ?? '?'}: ${v.description ?? ''}`.trim(),
          severity: 'HIGH',
        });
      }
    }
    return { ok: true, findings };
  } catch {
    return { ok: false, findings: [] };
  }
}
