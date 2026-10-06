/**
 * Baseline: in a worktree, install, build, typecheck, run the configured tests twice
 * (flake detection), fingerprint the environment, and snapshot the proof ledger.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { testId, type ClaimState } from '../../core/behavior-verdict.js';
import { dependencyFingerprint } from '../../core/dependency-fingerprint.js';
import type { EcosystemAdapter } from '../../core/ecosystems/index.js';
import type { CommandRunner } from '../../core/ecosystems/types.js';
import type { TestCaseResult } from '../../core/test-results.js';
import type { RemediateConfig, SpecGuardConfig } from '../../core/types.js';
import { ingestRun, readLedgerFile, seedLedger } from './ledger.js';
import {
  buildAndTypecheck,
  environmentFingerprint,
  installProject,
  runJobs,
  testJobs,
  type EnvFingerprint,
  type JobsRun,
  type StepResult,
  type TestJob,
} from './steps.js';
import type { TestSummary } from './types.js';

export interface BaselineResult {
  /** Tests, build and typecheck are green apart from quarantined tests. */
  green: boolean;
  /** Why it is not green (shown to the user, exit 11). */
  reasons: string[];
  tests: TestCaseResult[];
  parsed: boolean;
  quarantined: string[];
  failing: string[];
  summary: TestSummary;
  build: StepResult;
  typecheck: StepResult;
  env: EnvFingerprint;
  claims: Record<string, ClaimState>;
  claimFailures: string[];
  dependencyFingerprint?: string;
  jobs: TestJob[];
  snapshotPath: string;
  ledgerPath: string;
}

export interface BaselineArgs {
  config: SpecGuardConfig;
  /** Config root inside the worktree. */
  root: string;
  ecos: Array<{ dir: string; eco: EcosystemAdapter }>;
  run: CommandRunner;
  cfg: RemediateConfig;
  /** The user's ledger, copied as the seed. */
  userLedger: string;
  /** Evidence directory for this run. */
  evidenceDir: string;
  runId: string;
  app?: string;
}

/** Ids whose status differs between two runs, or that appear in only one. */
export function flakyIds(a: TestCaseResult[], b: TestCaseResult[]): string[] {
  const first = new Map(a.map((t) => [testId(t), t.status]));
  const second = new Map(b.map((t) => [testId(t), t.status]));
  const out = new Set<string>();
  for (const [id, s] of first) if (second.get(id) !== s) out.add(id);
  for (const id of second.keys()) if (!first.has(id)) out.add(id);
  return [...out].sort();
}

export async function runBaseline(args: BaselineArgs): Promise<BaselineResult> {
  const { config, root, ecos, run, cfg } = args;
  const reasons: string[] = [];

  // Install first: a worktree has no node_modules / venv.
  for (const { dir, eco } of ecos) {
    const inst = await installProject(eco, dir, run, cfg);
    if (!inst.ok) reasons.push(`install failed for ${eco.id} in ${path.relative(root, dir) || '.'}: ${inst.output.slice(-300).trim()}`);
  }
  const { build, typecheck } = await buildAndTypecheck(ecos, run, cfg);
  if (!build.ok) reasons.push(`baseline build is red (${build.command})`);
  if (!typecheck.ok) reasons.push(`baseline typecheck is red (${typecheck.command})`);

  const jobs = await testJobs(config, root, cfg, args.app);
  const first: JobsRun = await runJobs(jobs, root);
  const second: JobsRun = await runJobs(jobs, root);
  const quarantined = flakyIds(first.tests, second.tests);
  const q = new Set(quarantined);

  const parsed = first.parsed && second.parsed;
  const failing = first.tests.filter((t) => t.status === 'fail' && !q.has(testId(t))).map(testId);
  if (!parsed) reasons.push('baseline test output could not be parsed (an unparseable run counts as a failure): ' + [...first.reports, ...second.reports].filter((r) => !r.parsed).map((r) => `${r.job}: ${r.parseError ?? `exit ${r.exitCode}`}`).slice(0, 3).join('; '));
  if (failing.length) reasons.push(`${failing.length} test(s) fail on the unpatched baseline: ${failing.slice(0, 5).join('; ')}`);
  if (parsed && first.tests.length === 0) reasons.push('the baseline ran no tests, so there is nothing to compare against');

  // Ledger: seed from the user's ledger, ingest the baseline run, keep the snapshot.
  const snapshotPath = path.join(args.evidenceDir, 'baseline-proofs.json');
  seedLedger(args.userLedger, snapshotPath);
  const ing = await ingestRun(first.tests.filter((t) => !q.has(testId(t))), root, snapshotPath, `${args.runId}-baseline`);
  if (!readLedgerFile(snapshotPath)) writeFileSync(snapshotPath, JSON.stringify({ version: 1, proofs: {} }, null, 2) + '\n');

  const env = await environmentFingerprint(ecos, root, run);
  writeFileSync(path.join(args.evidenceDir, 'baseline-env.json'), JSON.stringify(env, null, 2) + '\n');

  return {
    green: reasons.length === 0,
    reasons,
    tests: first.tests,
    parsed,
    quarantined,
    failing,
    summary: first.summary,
    build,
    typecheck,
    env,
    claims: ing.claims,
    claimFailures: ing.failed,
    dependencyFingerprint: dependencyFingerprint(root),
    jobs,
    snapshotPath,
    ledgerPath: snapshotPath,
  };
}
