/**
 * The combined picture of a workspace: one row per repo with its coverage, claims, test layers,
 * security items, doc freshness and intent gaps, plus totals.
 *
 * It is built from what each repo has already recorded (`.specguard/trace.json`, the proof
 * ledger, the newest security plan) and never re-runs a pipeline, so it is cheap and the same
 * function serves the CLI, `serve` and the team server. The server passes snapshots in place of
 * files through `RollupInput`.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { SEVERITY_LEVELS, type PlanSeverity, type RemediationPlan } from './remediation-schema.js';
import { readPlanFile } from './state/plan-store.js';
import type { TraceModel } from './trace.js';
import { loadWorkspace, type WorkspaceManifest } from './workspace.js';
import { configDirOf } from './overlay.js';

export const ROLLUP_FILE = '.specguard/rollup.json';
const LAYER_NAMES = ['unit', 'integration', 'e2e', 'security', 'functional'] as const;

const Tally = z.object({ required: z.number(), proven: z.number(), failed: z.number(), stale: z.number(), missing: z.number() });
export type LayerTally = z.infer<typeof Tally>;

export const RepoRollupSchema = z.object({
  key: z.string(),
  path: z.string(),
  role: z.string(),
  ignored: z.boolean(),
  ignoreReason: z.string().optional(),
  /** `ok`; `no-config` (not a SpecGuard repo); `no-trace` (never checked); `unreadable` (a file would not parse). */
  state: z.enum(['ok', 'no-config', 'no-trace', 'unreadable']),
  freshness: z.object({
    trace: z.string().nullable(),
    ledger: z.string().nullable(),
    plan: z.string().nullable(),
    /** True when proofs were ingested after the trace was last computed, so the counts lag. */
    stale: z.boolean(),
  }),
  coverage: z.object({
    sourceFiles: z.number(),
    unowned: z.number(),
    sourcePct: z.number(),
    capabilities: z.number(),
    claims: z.number(),
    proven: z.number(),
    failed: z.number(),
    stale: z.number(),
    unproven: z.number(),
    incomplete: z.number(),
    provenPct: z.number(),
    testedPct: z.number(),
  }),
  layers: z.record(z.enum(LAYER_NAMES), Tally),
  security: z.object({
    planId: z.string().nullable(),
    open: z.record(z.enum(SEVERITY_LEVELS), z.number()),
    total: z.number(),
  }),
  docs: z.object({ withDocs: z.number(), stale: z.array(z.string()) }),
  intentGaps: z.array(z.string()),
  issues: z.object({ errors: z.number(), warnings: z.number() }),
});
export type RepoRollup = z.infer<typeof RepoRollupSchema>;

export const WorkspaceRollupSchema = z.object({
  version: z.literal(1),
  workspace: z.string(),
  generated: z.string(),
  repos: z.array(RepoRollupSchema),
  totals: z.object({
    repos: z.number(),
    ignored: z.number(),
    coverage: RepoRollupSchema.shape.coverage,
    layers: RepoRollupSchema.shape.layers,
    security: z.object({ open: z.record(z.enum(SEVERITY_LEVELS), z.number()), total: z.number() }),
  }),
});
export type WorkspaceRollup = z.infer<typeof WorkspaceRollupSchema>;

/** What `rollupRepo` reads about one repo. Files and server snapshots both fit. */
export interface RollupInput {
  key: string;
  path: string;
  role: string;
  ignored?: boolean;
  ignoreReason?: string;
  /** False for a folder with no SpecGuard config. */
  configured: boolean;
  trace?: Partial<TraceModel> | null;
  /** Newest proof `ingestedAt`, when the ledger is known. */
  ledgerNewest?: string | null;
  plan?: RemediationPlan | null;
  /** Set when a file existed but would not parse. */
  unreadable?: boolean;
}

const OPEN_STATUSES = new Set(['open', 'planned', 'in-progress']);
const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 100));

export function emptyLayerTallies(): Record<(typeof LAYER_NAMES)[number], LayerTally> {
  const t = () => ({ required: 0, proven: 0, failed: 0, stale: 0, missing: 0 });
  return { unit: t(), integration: t(), e2e: t(), security: t(), functional: t() };
}

function emptySeverity(): Record<PlanSeverity, number> {
  return { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
}

/** Roll one repo up from what it has recorded. Pure. */
export function rollupRepo(input: RollupInput): RepoRollup {
  const base = { key: input.key, path: input.path, role: input.role, ignored: input.ignored === true, ...(input.ignoreReason ? { ignoreReason: input.ignoreReason } : {}) };
  const trace = input.trace ?? null;
  const t = trace?.totals;
  const nodes = (trace?.nodes ?? []).filter((n) => n.kind === 'capability' || n.kind === 'component');

  const layers = emptyLayerTallies();
  let incomplete = 0;
  for (const n of nodes) {
    for (const c of n.claims) {
      const claim = c as typeof c & { required?: string[]; missing?: string[]; layers?: Record<string, string> };
      if (claim.missing && claim.missing.length > 0) incomplete++;
      for (const layer of claim.required ?? []) {
        const tally = layers[layer as keyof typeof layers];
        if (!tally) continue;
        tally.required++;
        const verdict = claim.layers?.[layer];
        if (verdict === 'proven') tally.proven++;
        else if (verdict === 'failed' || verdict === 'error') tally.failed++;
        else if (verdict === 'stale') tally.stale++;
        else tally.missing++;
      }
    }
  }

  const open = emptySeverity();
  let total = 0;
  for (const item of input.plan?.items ?? []) {
    if (!OPEN_STATUSES.has(item.status)) continue;
    open[item.severity]++;
    total++;
  }

  const traceAt = trace?.generated ?? null;
  const ledgerAt = input.ledgerNewest ?? null;
  const claims = t?.claims ?? 0;
  const sourceFiles = t?.sourceFiles ?? 0;
  const unowned = trace?.unowned?.length ?? 0;
  const state: RepoRollup['state'] = input.unreadable ? 'unreadable' : !input.configured ? 'no-config' : !trace ? 'no-trace' : 'ok';

  return {
    ...base,
    state,
    freshness: {
      trace: traceAt,
      ledger: ledgerAt,
      plan: input.plan?.createdAt ?? null,
      stale: traceAt !== null && ledgerAt !== null && ledgerAt > traceAt,
    },
    coverage: {
      sourceFiles,
      unowned,
      sourcePct: pct(sourceFiles - unowned, sourceFiles),
      capabilities: t?.capabilities ?? 0,
      claims,
      proven: t?.proven ?? 0,
      failed: t?.failed ?? 0,
      stale: t?.stale ?? 0,
      unproven: t?.unproven ?? 0,
      incomplete,
      provenPct: pct(t?.proven ?? 0, claims),
      testedPct: pct(t?.withTests ?? 0, claims),
    },
    layers,
    security: { planId: input.plan?.id ?? null, open, total },
    docs: { withDocs: nodes.filter((n) => n.docs.length > 0).length, stale: trace?.gaps?.docsStale ?? [] },
    intentGaps: (trace?.gaps?.intent ?? []).map((g) => g.id),
    issues: {
      errors: (trace?.issues ?? []).filter((i) => i.level === 'error').length,
      warnings: (trace?.issues ?? []).filter((i) => i.level !== 'error').length,
    },
  };
}

/** Combine repo rollups. Ignored repos are listed but add nothing to the totals. */
export function rollupWorkspace(name: string, repos: RepoRollup[], generated: string = new Date().toISOString()): WorkspaceRollup {
  const counted = repos.filter((r) => !r.ignored);
  const cov = { sourceFiles: 0, unowned: 0, capabilities: 0, claims: 0, proven: 0, failed: 0, stale: 0, unproven: 0, incomplete: 0 };
  const layers = emptyLayerTallies();
  const open = emptySeverity();
  let securityTotal = 0;
  let testedClaims = 0;
  for (const r of counted) {
    for (const k of Object.keys(cov) as Array<keyof typeof cov>) cov[k] += r.coverage[k];
    testedClaims += Math.round((r.coverage.testedPct / 100) * r.coverage.claims);
    for (const layer of LAYER_NAMES) for (const k of Object.keys(layers[layer]) as Array<keyof LayerTally>) layers[layer][k] += r.layers[layer]?.[k] ?? 0;
    for (const s of SEVERITY_LEVELS) open[s] += r.security.open[s] ?? 0;
    securityTotal += r.security.total;
  }
  return {
    version: 1,
    workspace: name,
    generated,
    repos,
    totals: {
      repos: counted.length,
      ignored: repos.length - counted.length,
      coverage: {
        ...cov,
        sourcePct: pct(cov.sourceFiles - cov.unowned, cov.sourceFiles),
        provenPct: pct(cov.proven, cov.claims),
        testedPct: pct(testedClaims, cov.claims),
      },
      layers,
      security: { open, total: securityTotal },
    },
  };
}

// ---------------------------------------------------------------------------
// Reading a repo from disk
// ---------------------------------------------------------------------------

function readJson<T>(file: string): { value: T | null; unreadable: boolean } {
  if (!existsSync(file)) return { value: null, unreadable: false };
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) as T, unreadable: false };
  } catch {
    return { value: null, unreadable: true };
  }
}

/** Newest `ingestedAt` in a ledger file, or null. */
function newestIngest(ledgerFile: string): { newest: string | null; unreadable: boolean } {
  const { value, unreadable } = readJson<{ proofs?: Record<string, { ingestedAt?: string }> }>(ledgerFile);
  let newest: string | null = null;
  for (const p of Object.values(value?.proofs ?? {})) if (p.ingestedAt && (!newest || p.ingestedAt > newest)) newest = p.ingestedAt;
  return { newest, unreadable };
}

/** Build the rollup input for a repo directory from the files it holds. */
export function readRepoInput(entry: { key: string; path: string; role: string; ignored?: boolean; ignoreReason?: string }, absPath: string): RollupInput {
  // A repo whose specs live in an overlay is configured: its trace and proofs sit in the overlay's `.specguard/`.
  const configDir = configDirOf(absPath);
  const configured = configDir !== null;
  if (configDir === null) return { ...entry, configured: false };
  const trace = readJson<TraceModel>(path.join(configDir, '.specguard', 'trace.json'));
  const ledgerFile = ['proofs.json', 'proof-ledger.json'].map((f) => path.join(configDir, '.specguard', f)).find((f) => existsSync(f));
  const ledger = ledgerFile ? newestIngest(ledgerFile) : { newest: null, unreadable: false };
  const plan = readPlanFile(path.join(configDir, '.specguard', 'security', 'plans'), 'latest');
  return {
    ...entry,
    configured,
    trace: trace.value,
    ledgerNewest: ledger.newest,
    plan,
    unreadable: trace.unreadable || ledger.unreadable,
  };
}

/** Roll every repo of a manifest up, ignored ones included but flagged. Reads files only. */
export function rollupManifest(manifest: WorkspaceManifest): WorkspaceRollup {
  const rows: RepoRollup[] = [];
  const add = (key: string, unit: { path: string; role?: string; ignoreReason?: string }, ignored: boolean): void => {
    rows.push(rollupRepo(readRepoInput({ key, path: unit.path, role: unit.role ?? 'consumer', ignored, ignoreReason: unit.ignoreReason }, path.resolve(manifest.rootDir, unit.path))));
  };
  for (const [key, repo] of Object.entries(manifest.repos)) add(key, repo, false);
  for (const [key, unit] of Object.entries(manifest.ignored)) if (unit.kind === 'repo') add(key, unit, true);
  rows.sort((a, b) => Number(a.ignored) - Number(b.ignored) || a.key.localeCompare(b.key));
  return rollupWorkspace(manifest.name, rows);
}

/** Load the manifest and roll it up. */
export async function loadWorkspaceRollup(cwd: string, explicit?: string): Promise<WorkspaceRollup> {
  return rollupManifest(await loadWorkspace(cwd, explicit));
}

/** Age of a file in ms, for "refresh if older than" decisions. */
export function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
