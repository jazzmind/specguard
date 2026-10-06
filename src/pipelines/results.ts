/**
 * `specguard results ingest`: turn reporter output files into proof verdicts.
 *
 * Parses Vitest/Jest/Playwright/JUnit/pytest/Go/Cargo reports, maps tests to
 * claims by claim tag, aggregates one verdict per claim, and writes through the
 * same ledger path as `proof ingest`.
 *
 * Spec: specs/pipelines/results.md
 */
import path from 'node:path';

import { formatClaimRef } from '../core/claims.js';
import { loadConfig } from '../core/config.js';
import { ExitCode } from '../core/exit-codes.js';
import { expandGlobs, fileExists, readFile } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import {
  aggregateClaims,
  parseResults,
  RESULT_FORMATS,
  type ClaimAggregate,
  type ResultFormat,
  type TestCaseResult,
} from '../core/test-results.js';
import { emptyResult, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { ingestVerdicts, type ProofOpts, type VerdictFile } from './proof.js';

export interface ResultsIngestOpts extends ProofOpts {
  format?: ResultFormat | 'auto';
  runId?: string;
  /** Also store `unexercised` for spec claims that no test tagged. */
  unexercised?: boolean;
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
      for (const spec of loadAllSpecs(dir)) {
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

  const all: TestCaseResult[] = [];
  const perFile = new Map<string, ClaimAggregate[]>();
  let parseFailures = 0;
  for (const abs of files) {
    const rel = relPosix(cwd, abs);
    try {
      const rows = parseResults(await readFile(abs), opts.format ?? 'auto');
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

  const aggregates = aggregateClaims(all);
  const verdicts: VerdictFile['verdicts'] = aggregates.map((agg) => ({
    claim: agg.claim,
    verdict: agg.verdict,
    exercised: agg.exercised,
    counterexamples: agg.counterexamples,
    evidencePath: evidenceFor(agg, perFile),
  }));

  if (opts.unexercised) {
    let config: SpecGuardConfig | undefined;
    try {
      config = await loadConfig(cwd);
    } catch {
      result.messages.push('--unexercised needs a .specguard/config.json; skipped');
    }
    if (config) {
      const tagged = new Set(aggregates.map((agg) => agg.claim));
      for (const ref of await specClaimRefs(config, cwd)) {
        if (!tagged.has(ref)) verdicts.push({ claim: ref, verdict: 'unexercised', exercised: 0, counterexamples: 0 });
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
