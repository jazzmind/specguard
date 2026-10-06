/**
 * Planning: group advisories, choose the smallest fixing version, fetch release notes,
 * analyze breaking changes, score risk, name branches, and skip work that already exists.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { createHash } from 'node:crypto';

import type { Advisory, Candidate, Severity } from '../../core/advisory.js';
import { createEcosystems } from '../../core/ecosystems/index.js';
import { compareVer, parseVer } from '../../core/ecosystems/semver.js';
import type { CommandRunner } from '../../core/ecosystems/types.js';
import type { SpecGuardConfig } from '../../core/types.js';
import { analyzeBreaking, fetchChangelog } from './changelog.js';
import { branchExists, hasRemote, remoteBranchExists } from './git.js';
import type { BreakingAnalysis, DetectionReport, PlanItem, RemediateDeps, RiskScore, SastIssue } from './types.js';

export interface PlanOpts {
  allowMajor: boolean;
  branchPrefix: string;
  maxAdvisories: number;
  threshold: Severity;
  /** `--pr`: also look for an existing PR through gh. */
  checkPr: boolean;
  llm: boolean;
  repoRoot: string;
}

function slug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Does version `v` fix advisory `a`? It must reach a fixed version of its own major line. */
export function fixes(a: Advisory, v: string): boolean {
  if (a.fixedVersions.length === 0) return false;
  const major = parseVer(v)?.major;
  const sameLine = a.fixedVersions.filter((f) => parseVer(f)?.major === major);
  if (sameLine.length) return sameLine.some((f) => compareVer(v, f) >= 0);
  return a.fixedVersions.every((f) => compareVer(v, f) >= 0);
}

/**
 * One candidate per (repo, ecosystem, package): the smallest version that fixes every advisory
 * of the group, patch over minor over major. Returns the allowed candidate, the alternatives, and
 * a skip reason when none is allowed.
 */
export function chooseCandidate(
  group: Advisory[],
  resolve: (a: Advisory) => Candidate[],
  allowMajor: boolean,
): { candidate?: Candidate; alternatives: Candidate[]; skip?: string } {
  const all = group.flatMap(resolve);
  const versions = [...new Set(all.map((c) => c.toVersion))];
  const common = versions.filter((v) => group.every((a) => fixes(a, v)));
  const ranked = all.filter((c, i, arr) => common.includes(c.toVersion) && arr.findIndex((x) => x.toVersion === c.toVersion) === i);
  const order = { patch: 0, minor: 1, major: 2, unknown: 3 } as const;
  ranked.sort((a, b) => order[a.bump] - order[b.bump] || compareVer(a.toVersion, b.toVersion));
  if (ranked.length === 0) {
    return { alternatives: [], skip: group.every((a) => a.fixedVersions.length === 0) ? 'no fixed version is published yet' : 'no single version fixes all advisories of this package' };
  }
  const allowed = ranked.filter((c) => allowMajor || (c.bump !== 'major' && c.bump !== 'unknown'));
  if (allowed.length === 0) return { alternatives: ranked, skip: `the only fix is a ${ranked[0].bump} bump to ${ranked[0].toVersion}; re-run with --allow-major` };
  const [candidate, ...alternatives] = allowed;
  return { candidate: { ...candidate, advisoryIds: [...new Set(group.flatMap((a) => [a.id, ...a.aliases]))] }, alternatives };
}

export function scoreRisk(c: Candidate, breaking: BreakingAnalysis | undefined, hasChangelog: boolean, transitive: boolean): RiskScore {
  const factors: string[] = [];
  let score = 0;
  const base = { patch: 10, minor: 30, major: 60, unknown: 40 }[c.bump];
  score += base;
  factors.push(`${c.bump} bump (+${base})`);
  if (transitive) {
    score += 10;
    factors.push('transitive dependency pinned through overrides (+10)');
  }
  if (breaking?.breaking) {
    const add = breaking.source === 'llm' ? 30 : 20;
    score += add;
    factors.push(`${breaking.source === 'llm' ? 'LLM analysis' : 'keyword scan'} found possible breaking changes (+${add})`);
  }
  if (!hasChangelog) {
    score += 10;
    factors.push('no release notes found, confidence is lower (+10)');
  }
  score = Math.min(100, score);
  return { score, level: score < 30 ? 'low' : score < 60 ? 'medium' : 'high', factors };
}

function groupKey(a: Advisory): string {
  return `${a.repo ?? ''}|${a.ecosystem}|${a.package}`;
}

export function branchFor(prefix: string, group: Advisory[]): string {
  const ids = group.map((a) => a.id).sort();
  return `${prefix}${slug(ids[0])}`;
}

/** Existing branch (local or origin) or PR for `branch`. */
export function existingWork(deps: Pick<RemediateDeps, 'git' | 'gh'>, repoRoot: string, branch: string, checkPr: boolean): string | undefined {
  if (branchExists(deps.git, repoRoot, branch)) return `branch ${branch} already exists`;
  if (hasRemote(deps.git, repoRoot) && remoteBranchExists(deps.git, repoRoot, branch)) return `branch ${branch} already exists on origin`;
  if (checkPr) {
    const r = deps.gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--limit', '1'], repoRoot);
    if (r.status === 0) {
      try {
        const rows = JSON.parse(r.stdout || '[]') as Array<{ url?: string }>;
        if (rows.length) return `a PR already exists for ${branch}: ${rows[0].url ?? ''}`.trim();
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/** Build the dependency plan. SAST issues are planned by `code-fix.ts`. */
export async function planDependencies(
  config: SpecGuardConfig,
  detection: DetectionReport,
  deps: RemediateDeps,
  run: CommandRunner,
  opts: PlanOpts,
  warn: (m: string) => void,
): Promise<PlanItem[]> {
  const ecos = createEcosystems(run);
  const groups = new Map<string, Advisory[]>();
  for (const a of detection.advisories) {
    const k = groupKey(a);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const items: PlanItem[] = [];
  const emptyRisk: RiskScore = { score: 0, level: 'low', factors: [] };
  for (const group of [...groups.values()].slice(0, opts.maxAdvisories)) {
    const first = group[0];
    const eco = ecos.find((e) => e.osvEcosystem.toLowerCase() === first.ecosystem.toLowerCase() || e.id === first.ecosystem);
    const branch = branchFor(opts.branchPrefix, group);
    const placeholder: Candidate = { advisoryIds: group.map((a) => a.id), ecosystem: first.ecosystem, package: first.package, fromVersion: first.installedVersion, toVersion: '', bump: 'unknown', mode: first.direct ? 'direct' : 'override' };
    const base = { advisories: group, branch, changeType: 'dependency' as const, risk: emptyRisk };
    if (!eco) {
      items.push({ ...base, candidate: placeholder, alternatives: [], skip: `no ecosystem adapter for ${first.ecosystem}` });
      continue;
    }
    const picked = chooseCandidate(group, (a) => eco.resolveFix(a), opts.allowMajor);
    if (!picked.candidate) {
      items.push({ ...base, candidate: placeholder, alternatives: picked.alternatives, skip: picked.skip });
      continue;
    }
    const exists = existingWork(deps, opts.repoRoot, branch, opts.checkPr);
    if (exists) {
      items.push({ ...base, candidate: picked.candidate, alternatives: picked.alternatives, skip: `${exists}; skipped (idempotent re-run)` });
      continue;
    }
    const log = await fetchChangelog(picked.candidate, deps.http);
    const breaking = await analyzeBreaking(config, picked.candidate, log?.text, opts.llm, warn);
    items.push({
      ...base,
      candidate: picked.candidate,
      alternatives: picked.alternatives,
      risk: scoreRisk(picked.candidate, breaking, Boolean(log), picked.candidate.mode === 'override'),
      breaking,
      changelog: log?.text,
    });
  }
  return items;
}

/** Stable branch for a SAST finding: `<prefix>sast-<hash of rule+path+line>`. */
export function sastBranch(prefix: string, issue: SastIssue): string {
  const h = createHash('sha1').update(`${issue.ruleId}|${issue.path}|${issue.line ?? ''}`).digest('hex').slice(0, 8);
  return `${prefix}sast-${h}`;
}
