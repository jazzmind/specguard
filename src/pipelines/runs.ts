/**
 * `specguard runs list` and `runs prune`: the per-run indexes that `results ingest` writes.
 *
 * Nothing is rotated automatically; `prune` is the only thing that deletes run indexes or evidence files.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { readFileSync } from 'node:fs';

import { loadConfig } from '../core/config.js';
import { ledgerEvidencePaths, listRunIndexes, pruneRuns, type RunIndex } from '../core/evidence.js';
import { ExitCode } from '../core/exit-codes.js';
import { emptyResult, type PipelineResult } from '../core/types.js';
import { ledgerPath } from './proof.js';

export interface RunSummary {
  runId: string;
  label?: string;
  ingestedAt: string;
  layers: string[];
  tests: { total: number; pass: number; fail: number; skip: number };
  claims: number;
  attachments: number;
}

export function summarizeRun(run: RunIndex): RunSummary {
  const count = (status: string): number => run.tests.filter((t) => t.status === status).length;
  return {
    runId: run.runId,
    ...(run.label ? { label: run.label } : {}),
    ingestedAt: run.ingestedAt,
    layers: run.layers,
    tests: { total: run.tests.length, pass: count('pass'), fail: count('fail'), skip: count('skip') },
    claims: run.claims.length,
    attachments: run.tests.reduce((n, t) => n + t.attachments.length, 0),
  };
}

export function runsList(cwd: string): { result: PipelineResult; runs: RunSummary[] } {
  const result = emptyResult('runs-list');
  const runs = listRunIndexes(cwd).map(summarizeRun).reverse();
  if (runs.length === 0) result.messages.push('no runs recorded yet (run `specguard results ingest <report>`)');
  for (const r of runs) {
    result.messages.push(
      `${r.runId}${r.label ? ` [${r.label}]` : ''}  ${r.ingestedAt}  tests ${r.tests.pass} pass / ${r.tests.fail} fail / ${r.tests.skip} skip  claims ${r.claims}  attachments ${r.attachments}  layers ${r.layers.join(',') || '-'}`,
    );
  }
  result.created = runs.length;
  return { result, runs };
}

async function ledgerReferences(cwd: string): Promise<Set<string>> {
  let configured: string | undefined;
  try {
    configured = (await loadConfig(cwd)).paths?.proofLedger;
  } catch {
    /* default location */
  }
  try {
    return ledgerEvidencePaths(JSON.parse(readFileSync(ledgerPath(cwd, configured), 'utf8')));
  } catch {
    return new Set();
  }
}

export async function runsPrune(cwd: string, keep: number): Promise<PipelineResult> {
  const result = emptyResult('runs-prune');
  if (!Number.isInteger(keep) || keep < 0) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push('--keep must be a whole number, 0 or more');
    return result;
  }
  const pruned = await pruneRuns(cwd, keep, await ledgerReferences(cwd));
  for (const id of pruned.removedRuns) result.messages.push(`removed run ${id}`);
  result.messages.push(`kept ${pruned.keptRuns} run(s); removed ${pruned.removedRuns.length} run index(es) and ${pruned.removedFiles} evidence file(s)`);
  result.created = pruned.removedRuns.length;
  return result;
}
