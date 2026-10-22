/**
 * Which remediation pull requests may be merged without a person: a narrow, conservative rule.
 *
 * Every condition must hold. The policy is pure: `remediate` gathers the facts, this decides, and the
 * decision with every reason is written to the report and the pull request body.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import path from 'node:path';

import type { Verdict } from './behavior-verdict.js';

/** Files a dependency fix may change and still be auto-merged: manifests and lockfiles, nothing else. */
const MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
]);

export const isManifestFile = (file: string): boolean => {
  const base = path.posix.basename(file.replace(/\\/g, '/'));
  return MANIFESTS.has(base) || /^requirements[\w.-]*\.txt$/.test(base);
};

export interface AutoMergeInput {
  /** `remediate.autoMerge.enabled` in the config. */
  configEnabled: boolean;
  /** `--auto-merge` on the command line. */
  flag: boolean;
  changeType: 'dependency' | 'code';
  /** Repo-relative paths the change touches. */
  changedFiles: string[];
  candidate: { package: string; fromVersion: string; toVersion: string; bump: 'patch' | 'minor' | 'major' | 'unknown' };
  /** Packages that are never auto-merged. */
  denyPackages?: string[];
  /** Allow minor bumps at version 1.0 or later. Default true; patch is always allowed. */
  allowMinor?: boolean;
  verdict: Verdict;
  /** Reasons the verdict was not clean (empty for PRESERVED). */
  verdictReasons: string[];
  /** Tests selected for the affected package. */
  selectedTests: number;
  /** Claims whose evidence in some layer was proven before the change and was not proven again after it. */
  layersNotReproven: Array<{ claim: string; layers: string[] }>;
  risk: 'low' | 'medium' | 'high';
  /** The breaking-change analysis said the update breaks something. */
  breaking: boolean;
}

export interface AutoMergeDecision {
  eligible: boolean;
  /** Each rule that failed, as a sentence. Empty when eligible. */
  failed: string[];
}

/** The major component of a version like `1.2.3`, `v2.0.0-beta.1` or `3`. Undefined when unreadable. */
export function majorOf(version: string): number | undefined {
  const m = /^v?(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

export function autoMergeDecision(i: AutoMergeInput): AutoMergeDecision {
  const failed: string[] = [];
  const no = (why: string): void => void failed.push(why);

  if (!i.configEnabled) no('auto-merge is not enabled in .specguard/config.json (remediate.autoMerge.enabled)');
  if (!i.flag) no('--auto-merge was not given');
  if (i.changeType !== 'dependency') no('only dependency fixes are auto-merged; a code fix always goes to a person');

  const outside = i.changedFiles.filter((f) => !isManifestFile(f));
  if (i.changedFiles.length === 0) no('the change touches no files');
  if (outside.length > 0) no(`the change touches files other than manifests and lockfiles: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', ...' : ''}`);

  const { bump, package: pkg, toVersion } = i.candidate;
  if (bump === 'major' || bump === 'unknown') no(`a ${bump} version bump is not auto-merged`);
  if (bump === 'minor') {
    if (i.allowMinor === false) no('minor bumps are turned off (remediate.autoMerge.allowMinor)');
    const major = majorOf(toVersion);
    if (major === undefined || major < 1) no(`a minor bump to ${toVersion} is not auto-merged below version 1.0 (0.x minors may break)`);
  }
  if ((i.denyPackages ?? []).includes(pkg)) no(`${pkg} is on remediate.autoMerge.denyPackages`);

  if (i.verdict !== 'PRESERVED') no(`the behaviour verdict is ${i.verdict}, not PRESERVED`);
  for (const r of i.verdictReasons) no(`verdict reason: ${r}`);
  if (i.selectedTests < 1) no('no test was selected for the affected package');
  for (const l of i.layersNotReproven.slice(0, 5)) no(`${l.claim} was proven in ${l.layers.join(', ')} before the change and not after it`);
  if (i.layersNotReproven.length > 5) no(`${i.layersNotReproven.length - 5} more claim(s) were not re-proven in a layer`);

  if (i.risk !== 'low') no(`risk is ${i.risk}, not low`);
  if (i.breaking) no('the breaking-change analysis flagged this update');

  return { eligible: failed.length === 0, failed };
}

/**
 * Whether a protection answer from `gh api .../protection/required_status_checks` means the base branch makes
 * checks mandatory. Auto-merge on a branch with no required checks merges the moment the PR exists.
 */
export function hasRequiredChecks(json: string): boolean {
  try {
    const o = JSON.parse(json) as { contexts?: unknown[]; checks?: unknown[] };
    return (Array.isArray(o.contexts) && o.contexts.length > 0) || (Array.isArray(o.checks) && o.checks.length > 0);
  } catch {
    return false;
  }
}
