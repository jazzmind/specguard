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
  aliases?: string[];
  severity?: string | { severity?: string; score?: number } | Array<{ type?: string; score?: string | number }>;
  cvss?: number;
  link?: string;
}
interface PipAuditDep {
  name?: string;
  version?: string;
  vulns?: PipAuditVuln[];
}

/** CVSS base score to the severity bands NVD uses. */
function bandFromScore(score: number): string {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'UNKNOWN';
}

/**
 * The vulnerability's real severity when pip-audit (or the OSV service behind it)
 * reports one: a `severity` label or object, a CVSS score, or a CVSS vector entry.
 * Otherwise `UNKNOWN`. The caller decides how to treat an unknown severity; it is
 * never guessed here.
 */
export function pipSeverity(v: PipAuditVuln): string {
  const sev = v.severity;
  if (typeof sev === 'string' && sev) {
    const upper = sev.toUpperCase();
    if (['CRITICAL', 'HIGH', 'MEDIUM', 'MODERATE', 'LOW'].includes(upper)) return upper === 'MODERATE' ? 'MEDIUM' : upper;
    const score = Number(sev);
    if (Number.isFinite(score)) return bandFromScore(score);
  }
  if (sev && !Array.isArray(sev) && typeof sev === 'object') {
    if (typeof sev.severity === 'string') return sev.severity.toUpperCase();
    if (typeof sev.score === 'number') return bandFromScore(sev.score);
  }
  if (Array.isArray(sev)) {
    for (const entry of sev) {
      const score = Number(entry?.score);
      if (Number.isFinite(score)) return bandFromScore(score);
    }
  }
  if (typeof v.cvss === 'number') return bandFromScore(v.cvss);
  return 'UNKNOWN';
}

function advisoryUrl(v: PipAuditVuln): string | undefined {
  const id = [v.id, ...(v.aliases ?? [])].find((x) => x && /^(CVE|GHSA|PYSEC)-/.test(x));
  if (!id) return undefined;
  if (id.startsWith('CVE-')) return `https://nvd.nist.gov/vuln/detail/${id}`;
  if (id.startsWith('GHSA-')) return `https://github.com/advisories/${id}`;
  return `https://osv.dev/vulnerability/${id}`;
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
          severity: pipSeverity(v),
          source: 'pip-audit',
          package: dep.name,
          range: dep.version,
          fixVersions: v.fix_versions ?? [],
          via: [{ title: v.id, url: v.link ?? advisoryUrl(v) }],
        });
      }
    }
    return { ok: true, findings };
  } catch {
    return { ok: false, findings: [] };
  }
}
