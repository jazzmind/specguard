/**
 * Normalized vulnerability advisory, remediation candidate, dedupe, and the
 * `.specguard/vuln-ignore.json` suppression file.
 *
 * Spec: specs/core/advisory.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { SpecGuardError } from './errors.js';
import { ExitCode } from './exit-codes.js';

export const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Advisory {
  /** Primary id (GHSA/CVE/OSV id, or a tool-specific id). */
  id: string;
  /** Other ids for the same vulnerability (CVE, GHSA, OSV). */
  aliases: string[];
  ecosystem: string;
  package: string;
  installedVersion: string;
  vulnerableRange: string;
  fixedVersions: string[];
  severity: Severity;
  cvss?: number;
  /** True when the package is a direct dependency of the project. */
  direct: boolean;
  /** Chain from the project down to the package, when known. */
  dependencyPath: string[];
  /** Tool that reported it: npm-audit, osv-scanner, pip-audit, ... */
  source: string;
  url?: string;
  title?: string;
  /** Project directory (relative to the config root) where it was found. Absent: the root. */
  repo?: string;
}

/** One concrete change that could fix an advisory. */
export interface Candidate {
  advisoryIds: string[];
  ecosystem: string;
  package: string;
  fromVersion: string;
  toVersion: string;
  bump: 'patch' | 'minor' | 'major' | 'unknown';
  /** `direct` edits a manifest range; `override` pins a transitive dependency. */
  mode: 'direct' | 'override';
}

export function normalizeSeverity(value: unknown): Severity {
  const s = String(value ?? '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high' || s === 'error') return 'high';
  if (s === 'moderate' || s === 'medium' || s === 'warning') return 'moderate';
  if (s === 'low' || s === 'info') return 'low';
  return 'unknown';
}

export function severityRank(s: Severity): number {
  return SEVERITIES.length - SEVERITIES.indexOf(s);
}

/**
 * True when `s` is at or above `threshold`. An advisory of unknown severity is
 * treated as `high` (fail closed): tools such as pip-audit and govulncheck report
 * no severity, and silently dropping them would hide real vulnerabilities.
 */
export function meetsThreshold(s: Severity, threshold: Severity): boolean {
  const eff: Severity = s === 'unknown' ? 'high' : s;
  return severityRank(eff) >= severityRank(threshold);
}

export function severityFromCvss(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'moderate';
  if (score > 0) return 'low';
  return 'unknown';
}

function ids(a: Advisory): string[] {
  return [a.id, ...a.aliases].map((s) => s.toUpperCase());
}

/** Merge advisories that share an id or alias for the same ecosystem and package. */
export function dedupeAdvisories(list: Advisory[]): Advisory[] {
  const out: Advisory[] = [];
  for (const adv of list) {
    const hit = out.find(
      (o) => o.ecosystem === adv.ecosystem && o.package === adv.package && (o.repo ?? '') === (adv.repo ?? '') && ids(o).some((i) => ids(adv).includes(i)),
    );
    if (!hit) {
      out.push({ ...adv, aliases: [...new Set(adv.aliases.filter((x) => x !== adv.id))], fixedVersions: [...adv.fixedVersions] });
      continue;
    }
    const all = new Set([...hit.aliases, hit.id, adv.id, ...adv.aliases]);
    all.delete(hit.id);
    hit.aliases = [...all];
    hit.fixedVersions = [...new Set([...hit.fixedVersions, ...adv.fixedVersions])];
    if (severityRank(adv.severity) > severityRank(hit.severity)) hit.severity = adv.severity;
    hit.cvss = Math.max(hit.cvss ?? 0, adv.cvss ?? 0) || undefined;
    hit.direct = hit.direct || adv.direct;
    if (hit.dependencyPath.length === 0) hit.dependencyPath = adv.dependencyPath;
    hit.url ??= adv.url;
    hit.title ??= adv.title;
    if (!hit.source.split(',').includes(adv.source)) hit.source = `${hit.source},${adv.source}`;
  }
  return out;
}

export function sortAdvisories(list: Advisory[]): Advisory[] {
  return [...list].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Suppression file
// ---------------------------------------------------------------------------

const IgnoreSchema = z.object({
  ignore: z.array(z.object({ id: z.string().min(1), reason: z.string().default(''), expires: z.string().optional() })),
});
export type IgnoreEntry = z.infer<typeof IgnoreSchema>['ignore'][number];

export const IGNORE_FILE = path.join('.specguard', 'vuln-ignore.json');

export function loadIgnoreFile(rootDir: string): IgnoreEntry[] {
  const file = path.join(rootDir, IGNORE_FILE);
  if (!existsSync(file)) return [];
  try {
    return IgnoreSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).ignore;
  } catch (err) {
    throw new SpecGuardError(`${IGNORE_FILE} is malformed: ${err instanceof Error ? err.message : String(err)}`, ExitCode.InternalError);
  }
}

/** An entry suppresses only while `expires` is a valid future date. */
export function isActiveIgnore(entry: IgnoreEntry, now: Date = new Date()): boolean {
  if (!entry.expires) return false;
  const t = Date.parse(entry.expires);
  return Number.isFinite(t) && t > now.getTime();
}

export function applyIgnore(
  list: Advisory[],
  entries: IgnoreEntry[],
  now: Date = new Date(),
): { kept: Advisory[]; suppressed: Array<{ advisory: Advisory; entry: IgnoreEntry }> } {
  const active = entries.filter((e) => isActiveIgnore(e, now));
  const kept: Advisory[] = [];
  const suppressed: Array<{ advisory: Advisory; entry: IgnoreEntry }> = [];
  for (const adv of list) {
    const set = ids(adv);
    const entry = active.find((e) => set.includes(e.id.toUpperCase()));
    if (entry) suppressed.push({ advisory: adv, entry });
    else kept.push(adv);
  }
  return { kept, suppressed };
}
