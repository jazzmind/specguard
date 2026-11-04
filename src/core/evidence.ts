/**
 * Test-evidence attachments and per-run indexes.
 *
 * Attachments named by a reporter (screenshots, videos, traces) are copied into
 * `.specguard/evidence/<runId>/<sha256-16>-<basename>`, content-addressed so a file that
 * appears twice is stored once. Each ingest also writes `.specguard/runs/<runId>.json`, an
 * index of the run's tests and per-claim verdicts, so reports can diff one run against another.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { aggregateClaims, type TestAttachment, type TestCaseResult, type TestStatus } from './test-results.js';
import { writeFile } from './writer.js';

export const EVIDENCE_DIR = '.specguard/evidence';
export const RUNS_DIR = '.specguard/runs';
export const DEFAULT_MAX_ATTACHMENT_MB = 200;

/** A default run id: an ISO timestamp (filesystem-safe) and a short random suffix. */
export function newRunId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
}

/** The form of a run id used in file names. */
export function runFileId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
}

const safeBase = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'file';

/** Resolve a reporter-written attachment path: absolute as is, else against the report's directory, then the cwd. */
export function resolveAttachmentPath(raw: string, reportDir: string, cwd: string): string | undefined {
  const candidates = path.isAbsolute(raw) ? [raw] : [path.resolve(reportDir, raw), path.resolve(cwd, raw)];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

export interface AttachmentStats {
  copied: number;
  deduped: number;
  missing: number;
  tooLarge: number;
}

export interface StoreAttachmentsOpts {
  root: string;
  cwd: string;
  runId: string;
  /** Directory of the report file each row came from. */
  reportDirOf: (row: TestCaseResult) => string;
  maxBytes: number;
}

/**
 * Copy every existing attachment of `rows` into the evidence store and rewrite each row's attachments to the stored
 * path (relative to `.specguard/evidence`). Files that are missing or over the cap are dropped and counted.
 */
export async function storeAttachments(rows: TestCaseResult[], opts: StoreAttachmentsOpts): Promise<AttachmentStats> {
  const stats: AttachmentStats = { copied: 0, deduped: 0, missing: 0, tooLarge: 0 };
  const dir = runFileId(opts.runId);
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (!row.attachments || row.attachments.length === 0) continue;
    const kept: TestAttachment[] = [];
    for (const att of row.attachments) {
      const abs = resolveAttachmentPath(att.path, opts.reportDirOf(row), opts.cwd);
      if (!abs) {
        stats.missing += 1;
        continue;
      }
      let rel = seen.get(abs);
      if (rel) {
        stats.deduped += 1;
      } else {
        if (statSync(abs).size > opts.maxBytes) {
          stats.tooLarge += 1;
          continue;
        }
        const hash = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
        rel = `${dir}/${hash}-${safeBase(path.basename(abs))}`;
        const dest = path.join(opts.root, EVIDENCE_DIR, rel);
        if (existsSync(dest)) {
          stats.deduped += 1;
        } else {
          await mkdir(path.dirname(dest), { recursive: true });
          await copyFile(abs, dest);
          stats.copied += 1;
        }
        seen.set(abs, rel);
      }
      kept.push({ name: att.name, ...(att.contentType ? { contentType: att.contentType } : {}), path: rel });
    }
    row.attachments = kept.length > 0 ? kept : undefined;
    if (!row.attachments) delete row.attachments;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Run index
// ---------------------------------------------------------------------------

export type RunVerdict = 'proven' | 'failed' | 'unexercised';

export interface RunIndexTest {
  title: string;
  file: string;
  claims: string[];
  /** Claims this test is only partial evidence for; not part of any verdict. */
  partialClaims?: string[];
  status: TestStatus;
  durationMs: number;
  layer?: string;
  attachments: TestAttachment[];
}

export interface RunIndexClaim {
  claim: string;
  verdict: RunVerdict;
  exercised: number;
  counterexamples: number;
  /** Verdict per test layer that exercised the claim. */
  layers: Record<string, RunVerdict>;
}

export interface RunIndex {
  /** Distinguishes these from the run records `test run --record` writes into the same folder. */
  kind: 'results-ingest';
  version: 1;
  runId: string;
  label?: string;
  ingestedAt: string;
  /** Distinct test layers present. */
  layers: string[];
  formats: string[];
  tests: RunIndexTest[];
  claims: RunIndexClaim[];
}

/** Per-claim verdicts (combined and per layer) from a run's tests. */
export function claimsOfTests(tests: RunIndexTest[]): RunIndexClaim[] {
  const stub = (t: RunIndexTest): TestCaseResult => ({
    file: t.file,
    title: t.title,
    fullTitle: t.title,
    status: t.status,
    durationMs: t.durationMs,
    tags: [],
    claims: t.claims,
    externalIds: [],
  });
  const layersOf = new Map<string, Set<string>>();
  const all = aggregateClaims(tests.map(stub));
  const byLayer = new Map<string, Map<string, RunVerdict>>();
  for (const layer of new Set(tests.map((t) => t.layer ?? 'unclassified'))) {
    const rows = tests.filter((t) => (t.layer ?? 'unclassified') === layer).map(stub);
    for (const agg of aggregateClaims(rows)) {
      const m = byLayer.get(agg.claim) ?? new Map<string, RunVerdict>();
      m.set(layer, agg.verdict);
      byLayer.set(agg.claim, m);
      layersOf.set(agg.claim, new Set([...(layersOf.get(agg.claim) ?? []), layer]));
    }
  }
  return all.map((agg) => ({
    claim: agg.claim,
    verdict: agg.verdict,
    exercised: agg.exercised,
    counterexamples: agg.counterexamples,
    layers: Object.fromEntries(byLayer.get(agg.claim) ?? []),
  }));
}

export function runIndexPath(root: string, runId: string): string {
  return path.join(root, RUNS_DIR, `${runFileId(runId)}.json`);
}

export function readRunIndex(file: string): RunIndex | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RunIndex>;
    if (raw && raw.kind === 'results-ingest' && typeof raw.runId === 'string' && Array.isArray(raw.tests)) return raw as RunIndex;
  } catch {
    /* not an index */
  }
  return undefined;
}

/**
 * Write (or extend) the index of a run. A second ingest under the same run id (one per suite of a `test run`) adds its
 * tests to the first, and the claim verdicts are recomputed over all of them.
 */
export async function writeRunIndex(
  root: string,
  entry: { runId: string; label?: string; format?: string; tests: RunIndexTest[]; ingestedAt?: string },
): Promise<RunIndex> {
  const file = runIndexPath(root, entry.runId);
  const previous = existsSync(file) ? readRunIndex(file) : undefined;
  const tests = [...(previous?.tests ?? []), ...entry.tests];
  const formats = [...new Set([...(previous?.formats ?? []), ...(entry.format ? [entry.format] : [])])];
  const index: RunIndex = {
    kind: 'results-ingest',
    version: 1,
    runId: entry.runId,
    ...((entry.label ?? previous?.label) ? { label: entry.label ?? previous?.label } : {}),
    ingestedAt: previous?.ingestedAt ?? entry.ingestedAt ?? new Date().toISOString(),
    layers: [...new Set(tests.map((t) => t.layer ?? 'unclassified'))].sort(),
    formats,
    tests,
    claims: claimsOfTests(tests),
  };
  await writeFile(file, JSON.stringify(index, null, 2) + '\n');
  return index;
}

/** Every results-ingest run index under the root, oldest first. */
export function listRunIndexes(root: string): RunIndex[] {
  const dir = path.join(root, RUNS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RunIndex[] = [];
  for (const n of names) {
    const idx = readRunIndex(path.join(dir, n));
    if (idx) out.push(idx);
  }
  return out.sort((a, b) => a.ingestedAt.localeCompare(b.ingestedAt) || a.runId.localeCompare(b.runId));
}

/** Evidence paths (relative to `.specguard/evidence`) that a ledger refers to. */
export function ledgerEvidencePaths(ledger: unknown): Set<string> {
  const out = new Set<string>();
  const proofs = (ledger as { proofs?: Record<string, { tests?: Array<{ attachments?: string[] }>; layers?: Record<string, { tests?: Array<{ attachments?: string[] }> }> }> })?.proofs ?? {};
  const add = (tests?: Array<{ attachments?: string[] }>): void => {
    for (const t of tests ?? []) for (const a of t.attachments ?? []) out.add(a);
  };
  for (const rec of Object.values(proofs)) {
    add(rec.tests);
    for (const l of Object.values(rec.layers ?? {})) add(l?.tests);
  }
  return out;
}

export interface PruneResult {
  removedRuns: string[];
  removedFiles: number;
  keptRuns: number;
}

/** Remove all but the newest `keep` run indexes and the evidence files nothing else refers to. */
export async function pruneRuns(root: string, keep: number, ledgerReferenced: Set<string> = new Set()): Promise<PruneResult> {
  const runs = listRunIndexes(root);
  const drop = keep >= runs.length ? [] : runs.slice(0, runs.length - Math.max(0, keep));
  const kept = runs.filter((r) => !drop.includes(r));
  const referenced = new Set(ledgerReferenced);
  for (const r of kept) for (const t of r.tests) for (const a of t.attachments) referenced.add(a.path);
  let removedFiles = 0;
  for (const r of drop) {
    for (const t of r.tests) {
      for (const a of t.attachments) {
        if (referenced.has(a.path)) continue;
        const abs = path.join(root, EVIDENCE_DIR, a.path);
        if (existsSync(abs)) {
          await rm(abs, { force: true });
          removedFiles += 1;
        }
      }
    }
    await rm(runIndexPath(root, r.runId), { force: true });
    const dir = path.join(root, EVIDENCE_DIR, runFileId(r.runId));
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      /* leave a non-empty directory */
    }
  }
  return { removedRuns: drop.map((r) => r.runId), removedFiles, keptRuns: kept.length };
}
