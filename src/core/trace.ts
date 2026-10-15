/**
 * The trace model: one structure answering "what proves this requirement,
 * which code and docs does it cover, and is that still true?" for every
 * level of a system: system -> capability (-> component) -> claim.
 *
 * `check` renders it; `serve` will expose it. It is written to
 * `.specguard/trace.json`.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { buildClaimTestIndex, type ClaimTestEntry } from './claim-tags.js';
import { formatClaimRef, parseClaimRef } from './claims.js';
import { expandGlobs } from './reader.js';
import { buildSpecGraph, type GraphIssue, type SpecNode } from './spec-graph.js';
import type { EffectiveVerdict } from './proof-ledger.js';
import type { SpecGuardConfig, SpecKind } from './types.js';
import { loadWorkspace, unitOfFile } from './workspace.js';

export interface TraceClaim {
  id: string;
  /** `specKey#id`, the form tests and proofs cite. */
  ref: string;
  text: string;
  proof: EffectiveVerdict;
  tests: ClaimTestEntry[];
}

export interface TraceCounts {
  claims: number;
  proven: number;
  failed: number;
  stale: number;
  unexercised: number;
  error: number;
  unproven: number;
  /** Claims cited by at least one test. */
  withTests: number;
}

export interface TraceNode {
  id: string;
  specKey: string;
  kind: SpecKind;
  title: string;
  status: string;
  value: string;
  parent?: string;
  unit: string;
  ownedFiles: string[];
  tests: string[];
  docs: string[];
  history: string[];
  claims: TraceClaim[];
  counts: TraceCounts;
}

/** One unit of a workspace (a repo or a package) rolled up from the capabilities that touch it. */
export interface TraceUnit {
  unit: string;
  kind: 'repo' | 'package';
  path: string;
  sourceFiles: number;
  /** Source files in this unit that no spec owns. */
  unowned: string[];
  /** Capabilities with code in this unit; one that spans several units appears in each. */
  capabilities: string[];
  counts: TraceCounts;
}

export interface TraceModel {
  version: 1;
  generated: string;
  system?: { id: string; title: string; value: string };
  nodes: TraceNode[];
  /** Source files no spec owns. */
  unowned: string[];
  /** Present when `.specguard/workspace.json` sits at the repo root. */
  units?: TraceUnit[];
  issues: GraphIssue[];
  totals: TraceCounts & { capabilities: number; ownedFiles: number; sourceFiles: number };
}

export const TRACE_FILE = '.specguard/trace.json';

const posix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

function emptyCounts(): TraceCounts {
  return { claims: 0, proven: 0, failed: 0, stale: 0, unexercised: 0, error: 0, unproven: 0, withTests: 0 };
}

/**
 * Roll the model up per unit. The manifest is read only when it is at `root`
 * itself: a repo that happens to sit inside someone else's workspace is not
 * reported against it.
 */
async function unitRollup(root: string, nodes: TraceNode[], sourceFiles: string[], unowned: string[]): Promise<TraceUnit[] | undefined> {
  if (!existsSync(path.join(root, '.specguard', 'workspace.json'))) return undefined;
  let manifest;
  try {
    manifest = await loadWorkspace(root);
  } catch {
    return undefined;
  }
  if (path.resolve(manifest.rootDir) !== path.resolve(root)) return undefined;
  const out: TraceUnit[] = [];
  for (const [key, unit] of Object.entries(manifest.units)) {
    const inUnit = (f: string): boolean => unitOfFile(manifest, f) === key;
    const caps = nodes.filter((n) => (n.kind === 'capability' || n.kind === 'component') && n.ownedFiles.some(inUnit));
    const counts = emptyCounts();
    for (const n of caps) for (const k of Object.keys(counts) as Array<keyof TraceCounts>) counts[k] += n.counts[k];
    out.push({
      unit: key,
      kind: unit.kind,
      path: unit.path,
      sourceFiles: sourceFiles.filter(inUnit).length,
      unowned: unowned.filter(inUnit),
      capabilities: caps.map((n) => n.id).sort(),
      counts,
    });
  }
  return out.sort((a, b) => a.unit.localeCompare(b.unit));
}

export interface BuildTraceOptions {
  /** Verdict per `specKey#claimId`, from the proof ledger. Omit for none. */
  verdicts?: Map<string, EffectiveVerdict>;
  /** Source files of the repo (root-relative), for the unowned list. */
  sourceFiles?: string[];
  warn?: (msg: string) => void;
}

export async function buildTraceModel(config: SpecGuardConfig, opts: BuildTraceOptions = {}): Promise<TraceModel> {
  const root = config.rootDir ?? process.cwd();
  const graph = await buildSpecGraph(config, { warn: opts.warn });
  const v2 = [...graph.nodes.values()].filter((n): n is SpecNode & { kind: SpecKind } => n.kind !== undefined);

  const globFiles = async (globs: string[]): Promise<string[]> =>
    (await expandGlobs(globs, root)).map((abs) => posix(root, abs));

  // Test sources: each spec's declared tests, plus every test file that cites one of its claims.
  const allTestGlobs = new Set<string>();
  for (const n of v2) for (const t of n.spec.meta.tests ?? []) allTestGlobs.add(t);
  for (const app of config.apps) for (const t of [...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])]) allTestGlobs.add(t);
  const testAbs = [...new Set(await expandGlobs([...allTestGlobs], root))];
  const claimTests = buildClaimTestIndex({ testFiles: testAbs, rootDir: root });

  const nodes: TraceNode[] = [];
  for (const n of v2) {
    const claims: TraceClaim[] = n.spec.claims
      .filter((c) => c.id)
      .map((c) => {
        const ref = formatClaimRef(undefined, n.specKey, c.id as string);
        // A test may cite the claim with or without a repo prefix.
        const tests = [...claimTests.entries()]
          .filter(([key]) => {
            const parsed = parseClaimRef(key);
            return parsed?.specKey === n.specKey && parsed.claimId === c.id;
          })
          .flatMap(([, entries]) => entries);
        return { id: c.id as string, ref, text: c.text, proof: opts.verdicts?.get(ref) ?? 'unproven', tests };
      });

    const counts = emptyCounts();
    for (const c of claims) {
      counts.claims += 1;
      counts[c.proof] += 1;
      if (c.tests.length > 0) counts.withTests += 1;
    }
    const declaredTests = await globFiles(n.spec.meta.tests ?? []);
    const citing = claims.flatMap((c) => c.tests.map((t) => t.file));
    nodes.push({
      id: n.id,
      specKey: n.specKey,
      kind: n.kind,
      title: n.spec.title || n.id,
      status: n.spec.meta.status ?? 'draft',
      value: n.spec.meta.value ?? '',
      parent: n.parent,
      unit: n.unit,
      ownedFiles: n.ownedFiles,
      tests: [...new Set([...declaredTests, ...citing])].sort(),
      docs: await globFiles(n.spec.meta.docs ?? []),
      history: n.spec.meta.history ?? [],
      claims,
      counts,
    });
  }
  nodes.sort((a, b) => (a.kind === 'system' ? -1 : b.kind === 'system' ? 1 : a.id.localeCompare(b.id)));

  const totals = { ...emptyCounts(), capabilities: 0, ownedFiles: 0, sourceFiles: opts.sourceFiles?.length ?? 0 };
  const owned = new Set<string>();
  for (const n of nodes) {
    if (n.kind === 'capability') totals.capabilities += 1;
    for (const k of Object.keys(n.counts) as Array<keyof TraceCounts>) totals[k] += n.counts[k];
    for (const f of n.ownedFiles) owned.add(f);
  }
  totals.ownedFiles = owned.size;
  const sys = graph.system;
  const units = await unitRollup(root, nodes, opts.sourceFiles ?? [], graph.unowned(opts.sourceFiles ?? []));
  return {
    version: 1,
    generated: new Date().toISOString(),
    system: sys ? { id: sys.id, title: sys.spec.title || sys.id, value: sys.spec.meta.value ?? '' } : undefined,
    nodes,
    unowned: graph.unowned(opts.sourceFiles ?? []),
    ...(units ? { units } : {}),
    issues: graph.issues,
    totals,
  };
}
