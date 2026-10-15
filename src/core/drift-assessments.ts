/**
 * Drift assessments: what a drift run concluded about one version of one file.
 *
 * A v2 capability owns many files, so a proof cannot go stale just because
 * any of them changed. Instead `drift` reads each change against the
 * capability's requirements and records which claims it affects, keyed by
 * `file@hash`. A proof then goes stale for a changed file only when no
 * assessment covers that exact file version, or the assessment names the claim.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Assessment {
  /** Claim ids affected by the change; `*` means every claim in the spec. */
  affectedClaims: string[];
  at: string;
  reason?: string;
}

/** specKey -> `file@hash` -> assessment. */
export type Assessments = Record<string, Record<string, Assessment>>;

export type FileChange = 'affects' | 'unaffected' | 'unassessed';

export const ASSESSMENTS_FILE = '.specguard/drift-assessments.json';

export function loadAssessments(rootDir: string): Assessments {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, ASSESSMENTS_FILE), 'utf8')) as Assessments;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveAssessments(rootDir: string, assessments: Assessments): void {
  const file = path.join(rootDir, ASSESSMENTS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(assessments, null, 2) + '\n');
}

export const assessmentKey = (file: string, hash: string): string => `${file}@${hash}`;

/** How a changed file bears on one claim of one spec, for `effectiveVerdict`. */
export function fileChangeResolver(
  assessments: Assessments,
  specKey: string,
  claimId: string,
): (file: string, nowHash: string, since?: string) => FileChange {
  const forSpec = assessments[specKey] ?? {};
  const affects = (a: Assessment): boolean => a.affectedClaims.includes('*') || a.affectedClaims.includes(claimId);
  return (file, nowHash, since) => {
    // A change after the proof that affected the claim keeps it stale even when a later version of the
    // file was judged unaffected: the proof was taken before the change and has not been repeated since.
    if (since) {
      for (const [key, a] of Object.entries(forSpec)) {
        if (key.startsWith(`${file}@`) && a.at > since && affects(a)) return 'affects';
      }
    }
    const hit = forSpec[assessmentKey(file, nowHash)];
    if (!hit) return 'unassessed';
    return affects(hit) ? 'affects' : 'unaffected';
  };
}
