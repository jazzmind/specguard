/**
 * `specguard results ingest`: turn reporter output files into proof verdicts.
 *
 * Parses Vitest/Jest/Playwright/JUnit/pytest/Go/Cargo reports, maps tests to
 * claims by claim tag, aggregates one verdict per claim, and writes through the
 * same ledger path as `proof ingest`.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { attachSourceClaimTags } from '../core/claim-tags.js';
import { formatClaimRef } from '../core/claims.js';
import { loadConfig } from '../core/config.js';
import { aliasRef, loadClaimMigration } from '../core/claim-migration.js';
import { ExitCode } from '../core/exit-codes.js';
import { expandGlobs, fileExists, readFile } from '../core/reader.js';
import { loadCanonicalSpecs } from '../core/spec-key.js';
import {
  aggregateClaims,
  detectResultFormat,
  parseResults,
  RESULT_FORMATS,
  type ClaimAggregate,
  type ResultFormat,
  type TestCaseResult,
} from '../core/test-results.js';
import { emptyResult, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { classifyTest, layerGlobIndex, readFileLayer, type EvidenceLayer, type TestLayer } from '../core/test-layers.js';
import { loadWorkspace } from '../core/workspace.js';
import { canonicalClaimRef } from '../core/workspace-units.js';
import { ingestVerdicts, walkClaimVerdicts, type ProofOpts, type VerdictFile } from './proof.js';

export interface ResultsIngestOpts extends ProofOpts {
  format?: ResultFormat | 'auto';
  runId?: string;
  /**
   * Also store `unexercised` for spec claims absent from every ingested file.
   * Honoured only on a full run (`fullRun`, or the files cover every configured
   * app); otherwise ignored with a warning. Alias: `sweep`.
   */
  unexercised?: boolean;
  sweep?: boolean;
  /** Declares that the ingested files are the complete run, enabling the sweep. */
  fullRun?: boolean;
  /** `--layer`: the layer of tests that no tag, config glob or suite places. */
  layer?: TestLayer;
  /** The layer of the suite that produced these files (`test run` sets it from `test.suites`). */
  suiteLayer?: TestLayer;
}

export function isResultFormat(value: string): value is ResultFormat | 'auto' {
  return value === 'auto' || (RESULT_FORMATS as readonly string[]).includes(value);
}

function relPosix(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join('/');
}

async function expandInputs(cwd: string, inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    if (/[*?{}[\]]/.test(input)) files.push(...(await expandGlobs([input], cwd)));
    else files.push(path.resolve(cwd, input));
  }
  return [...new Set(files)];
}

/** Evidence file for a claim: a file that failed it, else one that passed it, else the first that named it. */
function evidenceFor(agg: ClaimAggregate, perFile: Map<string, ClaimAggregate[]>): string | undefined {
  const want = agg.verdict === 'failed' ? 'failed' : agg.verdict === 'proven' ? 'proven' : 'unexercised';
  let first: string | undefined;
  for (const [file, rows] of perFile) {
    const row = rows.find((r) => r.claim === agg.claim);
    if (!row) continue;
    first ??= file;
    if (row.verdict === want) return file;
  }
  return first;
}

export async function specClaimRefs(config: SpecGuardConfig, cwd: string): Promise<string[]> {
  const refs: string[] = [];
  const root = config.rootDir ?? cwd;
  const specsRoot = path.resolve(root, config.paths?.specsRoot ?? 'specs');
  const dirs = (await fileExists(specsRoot))
    ? [specsRoot]
    : config.apps.map((app) => path.resolve(root, app.specDir));
  for (const dir of dirs) {
    try {
      for (const spec of loadCanonicalSpecs(config, dir)) {
        for (const claim of spec.claims) {
          if (claim.id) refs.push(formatClaimRef(undefined, spec.specKey, claim.id));
        }
      }
    } catch {
      /* unreadable spec dir: nothing to enumerate */
    }
  }
  return refs;
}

/** Apps with at least one anchored claim, and which of them the ingested claim refs touch. */
async function appCoverage(config: SpecGuardConfig, tagged: Set<string>): Promise<{ all: string[]; covered: string[] }> {
  const root = config.rootDir ?? process.cwd();
  const all: string[] = [];
  const covered: string[] = [];
  for (const app of config.apps) {
    let hasClaims = false;
    let touched = false;
    try {
      for (const spec of loadCanonicalSpecs(config, path.resolve(root, app.specDir))) {
        for (const claim of spec.claims) {
          if (!claim.id) continue;
          hasClaims = true;
          if (tagged.has(formatClaimRef(undefined, spec.specKey, claim.id))) touched = true;
        }
      }
    } catch {
      /* unreadable spec dir */
    }
    if (hasClaims) all.push(app.name);
    if (touched) covered.push(app.name);
  }
  return { all, covered };
}

export interface LayeredVerdictsOpts {
  /** The report format when it is known; else `rowFormats` says it per row. */
  format?: string;
  rowFormats?: Map<TestCaseResult, string>;
  suiteLayer?: TestLayer;
  forced?: TestLayer;
  evidence?: (agg: ClaimAggregate) => string | undefined;
}

/**
 * Give each test a layer and write one verdict per claim and layer. Shared by `results ingest` and by
 * `remediate`, so both record the same evidence from the same tests.
 */
export async function layeredVerdicts(
  all: TestCaseResult[],
  cwd: string,
  o: LayeredVerdictsOpts = {},
): Promise<{ aggregates: ClaimAggregate[]; verdicts: VerdictFile['verdicts'] }> {
  let configured: Map<string, TestLayer> = new Map();
  try {
    const cfg = await loadConfig(cwd);
    const merged: Partial<Record<TestLayer, string[]>> = {};
    for (const app of cfg.apps) for (const [layer, globs] of Object.entries(app.test?.layers ?? {})) merged[layer as TestLayer] = [...(merged[layer as TestLayer] ?? []), ...(globs ?? [])];
    configured = await layerGlobIndex(merged, cfg.rootDir ?? cwd);
  } catch {
    /* no config: path conventions and tags still classify */
  }
  const fileComments = new Map<string, TestLayer | undefined>();
  const layerOfRow = (row: TestCaseResult): TestLayer => {
    if (!fileComments.has(row.file)) fileComments.set(row.file, readFileLayer(cwd, row.file));
    return classifyTest({
      file: row.file,
      title: row.title,
      fullTitle: row.fullTitle,
      tags: row.tags,
      fileComment: fileComments.get(row.file),
      configured: configured.get(row.file),
      suite: o.suiteLayer,
      forced: o.forced,
      format: o.format ?? o.rowFormats?.get(row),
    });
  };
  const aggregates = aggregateClaims(all);
  const layerOf = new Map<TestCaseResult, TestLayer>(all.map((row) => [row, layerOfRow(row)]));
  const verdicts: VerdictFile['verdicts'] = [];
  for (const layer of new Set(layerOf.values())) {
    for (const agg of aggregateClaims(all.filter((row) => layerOf.get(row) === layer))) {
      verdicts.push({
        claim: agg.claim,
        verdict: agg.verdict,
        exercised: agg.exercised,
        counterexamples: agg.counterexamples,
        evidencePath: o.evidence?.(agg),
        layer: layer as EvidenceLayer,
      });
    }
  }
  return { aggregates, verdicts };
}

export async function runResultsIngest(
  inputs: string[],
  cwd: string,
  opts: ResultsIngestOpts = {},
): Promise<PipelineResult> {
  const result = emptyResult('results-ingest');
  const files = await expandInputs(cwd, inputs);
  if (files.length === 0) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push('no results files matched');
    return result;
  }

  // Results from before a consolidation still carry the old claim tags; accept them for one release.
  const migration = await loadClaimMigration(cwd);
  // A tag naming a package unit (`web:capabilities/auth#login`) is a tag of the workspace root's claim.
  const packageUnits = await (async () => {
    if (!existsSync(path.join(cwd, '.specguard', 'workspace.json'))) return undefined;
    try {
      const m = await loadWorkspace(cwd);
      return path.resolve(m.rootDir) === path.resolve(cwd) ? m.units : undefined;
    } catch {
      return undefined;
    }
  })();
  const all: TestCaseResult[] = [];
  const rowFormats = new Map<TestCaseResult, string>();
  const perFile = new Map<string, ClaimAggregate[]>();
  let parseFailures = 0;
  for (const abs of files) {
    const rel = relPosix(cwd, abs);
    try {
      const text = await readFile(abs);
      const rows = parseResults(text, opts.format ?? 'auto');
      if (!opts.format || opts.format === 'auto') {
        const detected = detectResultFormat(text);
        if (detected) for (const row of rows) rowFormats.set(row, detected);
      }
      // A tag in a comment above a test is not in the report: join it back by file and title.
      attachSourceClaimTags(rows, cwd);
      if (migration || packageUnits) {
        for (const row of rows) {
          row.claims = [...new Set(row.claims.map((ref) => canonicalClaimRef(migration ? (aliasRef(ref, migration, [path.basename(cwd)]) ?? ref) : ref, packageUnits)))];
        }
      }
      all.push(...rows);
      perFile.set(rel, aggregateClaims(rows));
      result.messages.push(`${rel}: ${rows.length} test(s), ${rows.filter((r) => r.claims.length > 0).length} tagged`);
    } catch (err) {
      parseFailures += 1;
      result.failed += 1;
      result.items.push({ key: rel, status: 'failed', message: err instanceof Error ? err.message : String(err) });
      result.messages.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (parseFailures === files.length) {
    result.exitCode = ExitCode.ValidationFailed;
    return result;
  }

  const { aggregates, verdicts } = await layeredVerdicts(all, cwd, {
    format: opts.format && opts.format !== 'auto' ? opts.format : undefined,
    rowFormats,
    suiteLayer: opts.suiteLayer,
    forced: opts.layer,
    evidence: (agg) => evidenceFor(agg, perFile),
  });

  if (opts.unexercised || opts.sweep) {
    let config: SpecGuardConfig | undefined;
    try {
      config = await loadConfig(cwd);
    } catch {
      result.messages.push('--unexercised needs a .specguard/config.json; skipped');
    }
    if (config) {
      const tagged = new Set(aggregates.map((agg) => agg.claim));
      const { all, covered } = await appCoverage(config, tagged);
      const missingApps = all.filter((name) => !covered.includes(name));
      if (!opts.fullRun && missingApps.length > 0) {
        result.messages.push(
          `[warn] --unexercised ignored: this is a partial ingest (no results for app(s): ${missingApps.join(', ')}). ` +
            'Pass --full-run to sweep anyway. Only claims present in the results were updated.',
        );
      } else {
        // Never downgrade a proven claim whose spec and source hashes still match.
        const stillProven = new Set<string>();
        await walkClaimVerdicts(config, (ref, verdict) => {
          if (verdict === 'proven') stillProven.add(ref);
        }, { ledger: opts.ledger });
        let kept = 0;
        for (const ref of await specClaimRefs(config, cwd)) {
          if (tagged.has(ref)) continue;
          if (stillProven.has(ref)) {
            kept += 1;
            continue;
          }
          verdicts.push({ claim: ref, verdict: 'unexercised', exercised: 0, counterexamples: 0 });
        }
        if (kept > 0) result.messages.push(`sweep kept ${kept} proven claim(s) whose spec and sources are unchanged`);
      }
    }
  }

  const runId = opts.runId ?? `results-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const ingest = emptyResult('results-ingest');
  ingest.failed = result.failed;
  ingest.items = [...result.items];
  ingest.messages = [...result.messages];
  await ingestVerdicts({ runId, verdicts }, cwd, { ledger: opts.ledger }, ingest);
  for (const agg of aggregates.filter((a) => a.verdict === 'failed')) {
    ingest.messages.push(`  counterexamples for ${agg.claim}: ${agg.failures.join(' | ')}`);
  }
  ingest.pipeline = 'results-ingest';
  if (parseFailures > 0) ingest.exitCode = ExitCode.ValidationFailed;
  else if (aggregates.some((a) => a.verdict === 'failed') && ingest.exitCode === ExitCode.Success) {
    ingest.exitCode = ExitCode.ValidationFailed;
  }
  return ingest;
}
