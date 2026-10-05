/**
 * npm-audit adapter.
 *
 * Runs `npm audit --json` in the target directory and parses the output into
 * the same `SastFinding[]` shape used by the security pipeline. This enables
 * the security pipeline to treat npm vulnerabilities alongside Semgrep findings.
 *
 * No spec file is required — this adapter is a thin wrapper and is tested
 * alongside security.ts. It degrades gracefully when npm is unavailable.
 */
import { spawnSync } from 'node:child_process';

import type { SastFinding } from '../pipelines/security.js';

export interface NpmAuditResult {
  findings: SastFinding[];
  /** `true` when npm audit ran successfully (even with findings). */
  ok: boolean;
}

/** Seam for test stubbing. */
export const npmAuditRunner = {
  run(cwd: string): { stdout: string | null; status: number | null; error?: Error } {
    const res = spawnSync('npm', ['audit', '--json'], {
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

/**
 * Run `npm audit --json` in `projectDir` and return normalised findings.
 * Never throws; returns `{ ok: false, findings: [] }` on any error.
 */
export async function runNpmAudit(projectDir: string): Promise<NpmAuditResult> {
  try {
    const res = npmAuditRunner.run(projectDir);

    if (res.error || !res.stdout) {
      return { ok: false, findings: [] };
    }

    let doc: unknown;
    try {
      doc = JSON.parse(res.stdout);
    } catch {
      return { ok: false, findings: [] };
    }

    // npm audit v2 JSON format: { vulnerabilities: { [pkgName]: { ... advisories } } }
    // npm audit v1 JSON format: { advisories: { [id]: { ... } } }
    const findings: SastFinding[] = [];

    const v2 = (doc as { vulnerabilities?: unknown }).vulnerabilities;
    if (v2 && typeof v2 === 'object') {
      for (const [pkg, info] of Object.entries(v2 as Record<string, unknown>)) {
        const vuln = info as {
          severity?: string;
          isDirect?: boolean;
          range?: string;
          fixAvailable?: boolean | { name?: string; version?: string; isSemVerMajor?: boolean };
          via?: Array<string | { title?: string; url?: string }>;
        };
        const via = (Array.isArray(vuln.via) ? vuln.via : [])
          .filter((v): v is { title?: string; url?: string } => typeof v === 'object' && v !== null)
          .map((v) => ({ title: v.title, url: v.url }));
        findings.push({
          ruleId: `npm-audit/${pkg}`,
          path: `package.json`,
          message: via[0]?.title ?? pkg,
          severity: vuln.severity?.toUpperCase(),
          source: 'npm-audit',
          package: pkg,
          range: vuln.range,
          isDirect: vuln.isDirect,
          fixAvailable: vuln.fixAvailable,
          via,
        });
      }
      return { ok: true, findings };
    }

    const v1 = (doc as { advisories?: unknown }).advisories;
    if (v1 && typeof v1 === 'object') {
      for (const advisory of Object.values(v1 as Record<string, unknown>)) {
        const a = advisory as {
          module_name?: string;
          title?: string;
          severity?: string;
          url?: string;
          vulnerable_versions?: string;
          patched_versions?: string;
        };
        findings.push({
          ruleId: `npm-audit/${a.module_name ?? 'unknown'}`,
          path: 'package.json',
          message: a.title ?? `Vulnerability in ${a.module_name}`,
          severity: a.severity?.toUpperCase(),
          source: 'npm-audit',
          package: a.module_name,
          range: a.vulnerable_versions,
          fixVersions: a.patched_versions && a.patched_versions !== '<0.0.0' ? [a.patched_versions] : undefined,
          via: a.url ? [{ title: a.title, url: a.url }] : undefined,
        });
      }
      return { ok: true, findings };
    }

    return { ok: true, findings: [] };
  } catch {
    return { ok: false, findings: [] };
  }
}
