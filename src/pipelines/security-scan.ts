/**
 * `specguard security scan`: one scan, one plan.
 *
 * Detectors (dependency advisories, Semgrep, gitleaks) share the remediate
 * pipeline's detection. A spec-level review then reads each capability's
 * requirements and the code findings under it, looking for flaws that are
 * missing or wrong requirements rather than bad code. Everything lands in one
 * `RemediationPlan`.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import path from 'node:path';
import { z } from 'zod';

import { SEVERITIES, type Severity } from '../core/advisory.js';
import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';
import { parseClaimRef } from '../core/claims.js';
import {
  severityRank,
  UNRESOLVED,
  type PlanItem,
  type PlanSeverity,
  type RemediationPlan,
} from '../core/remediation-schema.js';
import { buildSpecGraph, type SpecGraph, type SpecNode } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import { cliVersion } from '../core/version.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { walkClaimVerdicts } from './proof.js';
import { defaultDeps, parseSeverity } from './remediate/index.js';
import { detect } from './remediate/detect.js';
import type { DetectionReport, RemediateDeps } from './remediate/types.js';
import { PLAN_DIR, carryOver, fingerprintOf, listPlanIds, readPlan, writePlan } from './security-plan.js';

/** A detected item before it has a status. (`Omit` on a loose object collapses to an index signature, so pick the keys.) */
type NewItem = Pick<PlanItem, 'id' | 'title' | 'severity' | 'type' | 'change' | 'summary' | 'findings' | 'capability' | 'claims' | 'files' | 'verify' | 'fingerprint'>;

export interface SecurityScanOpts {
  /** Lowest severity that makes the plan: critical | high | moderate | low. Default `remediate.minSeverity` or high. */
  minSeverity?: Severity;
  app?: string;
  /** Skip the model-based spec review. */
  noSpecReview?: boolean;
  onLog?: (line: string) => void;
  /** Plan id override (tests). */
  planId?: string;
}

export interface SecurityScanResult extends PipelineResult {
  plan?: RemediationPlan;
  planFile?: string;
}

const MANIFESTS: Record<string, string> = {
  npm: 'package.json',
  pypi: 'requirements.txt',
  pip: 'requirements.txt',
  go: 'go.mod',
  cargo: 'Cargo.toml',
  crates: 'Cargo.toml',
  maven: 'pom.xml',
};

function planSeverity(s: string): PlanSeverity {
  return s === 'critical' || s === 'high' || s === 'moderate' || s === 'low' ? s : 'low';
}

const SPEC_FINDING_KINDS = [
  'missing-authorization',
  'missing-data-classification',
  'unspecified-abuse-case',
  'missing-rate-limit',
  'contradictory-requirements',
  'unowned-interface',
  'code-reveals-gap',
  'other',
] as const;

const SpecReviewSchema = z.object({
  findings: z.array(
    z.object({
      kind: z.enum(SPEC_FINDING_KINDS),
      severity: z.enum(['critical', 'high', 'moderate', 'low']),
      title: z.string().describe('One line naming the flaw.'),
      detail: z.string().describe('Why it is a security problem, grounded in the spec text.'),
      claims: z.array(z.string()).describe('Ids of the requirements involved. Empty when the flaw is a missing requirement.'),
      recommendation: z.string().describe('The requirement to add or change.'),
    }),
  ),
});

const SPEC_REVIEW_SYSTEM =
  'You review a software capability spec for security flaws that are missing or wrong REQUIREMENTS, not bugs in code. ' +
  'Look for: missing authorization or data-classification requirements; unspecified abuse cases or rate limits; requirements that contradict each other; ' +
  'interfaces that no requirement covers; and code findings that reveal a gap in the requirements. ' +
  'Only report flaws you can ground in the text. Do not invent requirements the capability does not imply. Report at most 8 findings, most serious first.';

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

export async function runSecurityScan(
  config: SpecGuardConfig,
  opts: SecurityScanOpts = {},
  depsIn: Partial<RemediateDeps> = {},
): Promise<SecurityScanResult> {
  const result: SecurityScanResult = emptyResult('security-scan');
  const log = (line: string): void => {
    result.messages.push(line);
    opts.onLog?.(line);
  };
  const root = config.rootDir ?? process.cwd();
  const deps: RemediateDeps = { ...defaultDeps(), ...depsIn };
  const cfg = config.remediate ?? {};
  const threshold = opts.minSeverity ?? parseSeverity(cfg.minSeverity) ?? 'high';
  if (!(SEVERITIES as readonly string[]).includes(threshold)) throw new Error(`invalid minimum severity "${threshold}"`);
  const floor = severityRank(planSeverity(threshold));

  let detection: DetectionReport;
  try {
    detection = await detect(config, root, deps, { threshold, useOsv: cfg.osv, useSemgrep: cfg.semgrep, useGitleaks: cfg.gitleaks, app: opts.app });
  } catch (err) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(`detection failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  for (const w of detection.warnings) log(`[warn] ${w}`);

  const graph = await buildSpecGraph(config);
  const owner = (file: string): SpecNode | undefined => {
    const ids = graph.specsForFile(file);
    const nodes = ids.map((id) => graph.nodes.get(id)).filter((n): n is SpecNode => Boolean(n));
    return nodes.find((n) => n.kind === 'capability') ?? nodes[0];
  };

  // Which claims are proven now: a fix must not lose any of them.
  const proven = new Map<string, string[]>();
  await walkClaimVerdicts(config, (ref, verdict) => {
    const parsed = parseClaimRef(ref);
    if (verdict !== 'proven' || !parsed) return;
    const key = `${parsed.specKey}#${parsed.claimId}`;
    const list = proven.get(parsed.specKey) ?? [];
    list.push(key);
    proven.set(parsed.specKey, list);
  });
  const provenOf = (n?: SpecNode): string[] => (n ? [...(proven.get(n.specKey) ?? [])].sort() : []);

  // Two findings of one rule in one file must not share an identity. The occurrence index is taken in
  // path/line order, so editing code above a finding (which moves its line) does not change its fingerprint.
  const occurrences = new Map<string, number>();
  const occurrence = (key: string): number => {
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    return n;
  };
  const byLocation = <T extends { path: string; line?: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));

  const fresh: PlanItem[] = [];
  const add = (item: NewItem): void => {
    if (severityRank(item.severity) < floor) return;
    fresh.push({ ...item, status: 'open', statusHistory: [] });
  };

  for (const a of detection.advisories) {
    const manifest = path.posix.join(a.repo ?? '', MANIFESTS[a.ecosystem.toLowerCase()] ?? 'package.json');
    const fp = fingerprintOf('advisory', a.ecosystem, a.package, a.id, a.repo);
    add({
      id: `sec-${fp}`,
      title: `${a.package}@${a.installedVersion || '?'}: ${a.title ?? a.id}`,
      severity: planSeverity(a.severity),
      type: 'dependency',
      change: 'dependency',
      summary: a.fixedVersions.length
        ? `Upgrade ${a.package} to ${a.fixedVersions.join(' or ')}${a.direct ? '' : ' (transitive: pin it with an override)'}.`
        : `No fixed version of ${a.package} is published; replace it or mitigate the exposure.`,
      findings: [{ id: a.id, detector: 'advisory', ruleId: a.source, message: a.title ?? a.id, file: manifest }],
      claims: [],
      files: [manifest],
      verify: { scope: 'all-proven', claims: [] },
      fingerprint: fp,
    });
  }
  for (const s of byLocation(detection.sast)) {
    const cap = owner(s.path);
    const fp = fingerprintOf('semgrep', s.ruleId, s.path, s.message, occurrence(`semgrep\0${s.ruleId}\0${s.path}\0${s.message}`));
    add({
      id: `sec-${fp}`,
      title: `${s.ruleId} in ${s.path}`,
      severity: planSeverity(s.severity),
      type: 'code',
      change: 'code',
      summary: s.message,
      findings: [{ id: `${s.ruleId}@${s.path}${s.line ? `:${s.line}` : ''}`, detector: 'semgrep', ruleId: s.ruleId, message: s.message, file: s.path, ...(s.line ? { line: s.line } : {}) }],
      ...(cap ? { capability: cap.id } : {}),
      claims: [],
      files: [s.path],
      verify: { scope: 'listed', claims: provenOf(cap) },
      fingerprint: fp,
    });
  }
  for (const s of byLocation(detection.secrets)) {
    const cap = owner(s.path);
    const fp = fingerprintOf('gitleaks', s.ruleId, s.path, occurrence(`gitleaks\0${s.ruleId}\0${s.path}`));
    add({
      id: `sec-${fp}`,
      title: `Secret (${s.ruleId}) in ${s.path}`,
      severity: 'high',
      type: 'secret',
      change: 'config',
      summary: 'Rotate the credential, remove it from the source and history, and load it from the environment.',
      // The detector's message can quote the secret, so it is never copied into a plan.
      findings: [{ id: `${s.ruleId}@${s.path}${s.line ? `:${s.line}` : ''}`, detector: 'gitleaks', ruleId: s.ruleId, message: `Secret detected by rule ${s.ruleId}`, file: s.path, ...(s.line ? { line: s.line } : {}) }],
      ...(cap ? { capability: cap.id } : {}),
      claims: [],
      files: [s.path],
      verify: { scope: 'all-proven', claims: [] },
      fingerprint: fp,
    });
  }

  if (!opts.noSpecReview) await reviewSpecs(config, graph, detection, owner, provenOf, add, occurrence, log);
  else log('[info] spec-level review skipped (--no-spec-review)');

  // The latest plan carries every status, wont-fix decision and external reference. If it exists but cannot be read,
  // carrying on would silently drop all of that, so stop and say why.
  const latestId = listPlanIds(config).pop();
  const previous = latestId ? readPlan(config, latestId) : null;
  if (latestId && !previous) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(`the latest plan (${latestId}) does not validate against the schema, so its statuses cannot be carried over. Fix or move ${PLAN_DIR}/${latestId}.json and scan again.`);
    return result;
  }
  const now = (deps.now?.() ?? new Date()).toISOString();
  // An item is only closed when this scan could have seen it. Spec findings are model judgements: silence is not evidence.
  const detectorRan = (name: 'semgrep' | 'gitleaks'): boolean => detection.sources.includes(name);
  const dependencyRan = detection.sources.some((s) => s !== 'semgrep' && s !== 'gitleaks');
  const canClose = (item: PlanItem): boolean => {
    if (opts.app) return false;
    if (severityRank(item.severity) < floor) return false;
    if (item.type === 'dependency') return dependencyRan;
    if (item.type === 'code') return detectorRan('semgrep');
    if (item.type === 'secret') return detectorRan('gitleaks');
    return false;
  };
  const items = carryOver(previous, fresh, now, canClose).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
  const plan: RemediationPlan = {
    version: 1,
    id: opts.planId ?? `scan-${now.replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    createdAt: now,
    tool: { name: 'specguard', version: cliVersion() },
    ...(previous ? { previous: previous.id } : {}),
    items,
  };
  result.plan = plan;
  result.planFile = await writePlan(config, plan);

  for (const i of items) log(`[${i.severity}] ${i.id} ${i.type}: ${i.title}${i.status !== 'open' ? ` (${i.status})` : ''}`);
  const unresolved = items.filter((i) => UNRESOLVED.includes(i.status));
  result.created = items.length;
  result.failed = unresolved.length;
  for (const i of items) result.items.push({ key: i.id, status: UNRESOLVED.includes(i.status) ? 'failed' : 'ok', message: i.title });
  log(`security scan: ${items.length} item(s), ${unresolved.length} unresolved at or above ${threshold}; plan ${plan.id}`);
  result.exitCode = unresolved.length > 0 ? ExitCode.SecurityIssues : ExitCode.Success;
  return result;
}

async function reviewSpecs(
  config: SpecGuardConfig,
  graph: SpecGraph,
  detection: DetectionReport,
  owner: (file: string) => SpecNode | undefined,
  provenOf: (n?: SpecNode) => string[],
  add: (item: NewItem) => void,
  occurrence: (key: string) => number,
  log: (line: string) => void,
): Promise<void> {
  const caps = [...graph.nodes.values()].filter((n) => n.kind === 'capability' || n.kind === 'component');
  if (caps.length === 0) {
    log('[info] no v2 specs: spec-level review needs capability specs (run `specguard spec draft`)');
    return;
  }
  if (config.llm.provider === 'none') {
    log('[info] spec-level review skipped: no model configured');
    return;
  }
  const root = config.rootDir ?? process.cwd();
  const section = (n: SpecNode, name: string): string => n.spec.sections[name]?.trim() ?? '';

  await mapLimit(caps, 3, async (node) => {
    const codeFindings = [
      ...detection.sast.filter((s) => owner(s.path)?.id === node.id).map((s) => `- ${s.ruleId} in ${s.path}: ${s.message}`),
      ...detection.secrets.filter((s) => owner(s.path)?.id === node.id).map((s) => `- secret (${s.ruleId}) in ${s.path}`),
    ];
    const known = new Set(node.spec.claims.map((c) => c.id).filter(Boolean) as string[]);
    try {
      const review = await llmGenerateObject({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        pipeline: 'spec-review',
        system: SPEC_REVIEW_SYSTEM,
        prompt: [
          `Capability: ${node.spec.title || node.id} (${node.id})`,
          `## Problem & Value\n${section(node, 'Problem & Value') || node.spec.overview}`,
          section(node, 'Users & Journeys') ? `## Users & Journeys\n${section(node, 'Users & Journeys')}` : '',
          `## Requirements\n${node.spec.claims.map((c) => `- ${c.id ?? '(no id)'}: ${c.text}`).join('\n')}`,
          section(node, 'Interfaces') ? `## Interfaces\n${section(node, 'Interfaces')}` : '',
          section(node, 'Security & Data Considerations') ? `## Security & Data Considerations\n${section(node, 'Security & Data Considerations')}` : '',
          section(node, 'Out of Scope') ? `## Out of Scope\n${section(node, 'Out of Scope')}` : '',
          codeFindings.length > 0 ? `## Code findings under this capability\n${codeFindings.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        schema: SpecReviewSchema,
      });
      const specFile = path.relative(root, path.join(specsRootDir(config), `${node.specKey}.md`)).split(path.sep).join('/');
      for (const f of review.findings.slice(0, 8)) {
        const claimIds = f.claims.filter((id) => known.has(id));
        // Identity is the capability, the kind of gap and the claims it touches. The model's wording changes every run,
        // so the title only matters when nothing else tells two findings apart.
        const claimKey = [...claimIds].sort().join(',');
        const base = `spec-review\0${node.id}\0${f.kind}\0${claimKey}${claimKey ? '' : `\0${f.title.toLowerCase().replace(/\s+/g, ' ').trim()}`}`;
        const fp = fingerprintOf('spec-review', node.id, f.kind, claimKey, claimKey ? '' : f.title.toLowerCase().replace(/\s+/g, ' ').trim(), occurrence(base));
        add({
          id: `sec-${fp}`,
          title: f.title,
          severity: planSeverity(f.severity),
          type: 'spec',
          change: 'spec',
          summary: f.recommendation,
          findings: [{ id: `${node.id}:${f.kind}`, detector: 'spec-review', ruleId: f.kind, message: f.detail, file: specFile }],
          capability: node.id,
          claims: claimIds.map((id) => `${node.specKey}#${id}`),
          files: [specFile],
          verify: { scope: 'listed', claims: provenOf(node) },
          fingerprint: fp,
        });
      }
    } catch (err) {
      log(`[warn] spec review of ${node.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
