/**
 * `specguard mutation ingest`: normalize a Stryker or PIT mutation report into
 * `.specguard/mutation/report.json`.
 *
 * The stored report keeps each mutant, the tests that killed or covered it, and the
 * content hash of every mutated file (Stryker embeds its source; PIT files are hashed
 * at ingest), so a later run can tell which results the code has outgrown.
 *
 * Spec: specs/capabilities/coverage-and-mutation.md
 */
import path from 'node:path';

import { loadConfig } from '../core/config.js';
import type { EvidenceOrigin } from '../core/coverage.js';
import { ExitCode } from '../core/exit-codes.js';
import {
  MutationParseError,
  mergeMutationReports,
  parseMutationReport,
  type MutantStatus,
  type MutationReport,
  type MutationTool,
} from '../core/mutation.js';
import { fileExists, readFile } from '../core/reader.js';
import { emptyResult, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { buildPathContext, expandInputs, gitHead, hashFiles } from './coverage-ingest.js';

export const MUTATION_DIR = '.specguard/mutation';

export interface MutationIngestOpts {
  format?: MutationTool | 'auto';
  runId?: string;
  origin?: EvidenceOrigin;
}

export interface MutationEvidence {
  version: 1;
  runId: string;
  repoSha?: string;
  origin: EvidenceOrigin;
  ingestedAt: string;
  report: MutationReport;
}

export function isMutationFormat(value: string): value is MutationTool | 'auto' {
  return value === 'auto' || value === 'stryker' || value === 'pit';
}

export function mutationEvidencePath(root: string): string {
  return path.join(root, MUTATION_DIR, 'report.json');
}

async function optionalConfig(cwd: string): Promise<SpecGuardConfig | undefined> {
  try {
    return await loadConfig(cwd);
  } catch {
    return undefined;
  }
}

export async function runMutationIngest(inputs: string[], cwd: string, opts: MutationIngestOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('mutation-ingest');
  const fail = (message: string): PipelineResult => {
    result.failed += 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(message);
    return result;
  };
  const config = await optionalConfig(cwd);
  const root = config?.rootDir ?? cwd;
  const files = await expandInputs(cwd, inputs);
  if (files.length === 0) return fail('no mutation report files matched');

  const ctx = await buildPathContext(root, config);
  const reports: MutationReport[] = [];
  let parseFailures = 0;
  for (const abs of files) {
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    try {
      const report = parseMutationReport(await readFile(abs), ctx, opts.format ?? 'auto', { attribution: config?.mutation?.attribution });
      reports.push(report);
      result.messages.push(`${rel}: ${report.tool}, ${report.mutants.length} mutant(s)`);
      for (const w of report.warnings.slice(0, 5)) result.messages.push(`  [warn] ${rel}: ${w}`);
    } catch (err) {
      parseFailures += 1;
      result.failed += 1;
      const message = err instanceof MutationParseError || err instanceof Error ? err.message : String(err);
      result.items.push({ key: rel, status: 'failed', message });
      result.messages.push(`${rel}: ${message}`);
    }
  }
  if (reports.length === 0) {
    result.exitCode = ExitCode.ValidationFailed;
    return result;
  }

  let report: MutationReport;
  try {
    report = mergeMutationReports(reports);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (report.mutants.length === 0) {
    return fail(`no mutated file maps onto a repo file (${report.unmapped.length} unmapped, e.g. ${report.unmapped.slice(0, 3).join(', ')}); set coverage.pathPrefixes or coverage.sourceRoots in the config`);
  }
  // PIT does not embed source: hash the mutated files as they are now. Stryker's embedded hashes are kept.
  const missing = [...new Set(report.mutants.map((m) => m.file))].filter((f) => report.sourceHashes[f] === undefined && report.tool === 'pit');
  report = { ...report, sourceHashes: { ...report.sourceHashes, ...hashFiles(root, missing) } };

  const evidence: MutationEvidence = {
    version: 1,
    runId: opts.runId ?? `mutation-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    repoSha: gitHead(root),
    origin: opts.origin ?? (process.env.CI ? 'ci' : 'local'),
    ingestedAt: new Date().toISOString(),
    report,
  };
  const target = mutationEvidencePath(root);
  await writeFile(target, JSON.stringify(evidence, null, 2) + '\n');

  const tally = new Map<MutantStatus, number>();
  for (const m of report.mutants) tally.set(m.status, (tally.get(m.status) ?? 0) + 1);
  const counts = [...tally].sort((a, b) => a[0].localeCompare(b[0])).map(([s, n]) => `${n} ${s}`).join(', ');
  result.created = reports.length;
  result.messages.push(`${report.tool}: ${report.mutants.length} mutant(s) in ${new Set(report.mutants.map((m) => m.file)).size} file(s) (${counts}) -> ${path.relative(root, target).split(path.sep).join('/')}`);
  if (report.unmapped.length > 0) result.messages.push(`[warn] ${report.unmapped.length} mutated path(s) map to no repo file, e.g. ${report.unmapped.slice(0, 5).join(', ')}`);
  if (report.coverage === 'none') result.messages.push('note: no per-test coverage in the report, so mutants cannot be scored per claim; only the killers of each mutant are known');
  if (report.attribution === 'first-kill') result.messages.push('note: the tool lists one killing test per mutant, so kills per claim are a lower bound (Stryker disableBail, PIT fullMutationMatrix list them all)');
  if (parseFailures > 0) result.exitCode = ExitCode.ValidationFailed;
  return result;
}

/** The stored mutation evidence, or undefined when none was ingested or the file is unreadable. */
export async function readMutationEvidence(root: string): Promise<MutationEvidence | undefined> {
  const file = mutationEvidencePath(root);
  if (!(await fileExists(file))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(file)) as MutationEvidence;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
