/**
 * Verification of a patched worktree: build + typecheck, selected tests first, the full suite
 * always, ingestion into a PATCHED proof ledger, and the behavior verdict.
 *
 * `heal` is never involved: nothing here rewrites a test.
 *
 * Spec: specs/pipelines/remediate.md
 */
import path from 'node:path';

import type { Advisory, Severity } from '../../core/advisory.js';
import { computeVerdict, testId, type ProofReprove, type VerdictResult } from '../../core/behavior-verdict.js';
import { dependencyFingerprint } from '../../core/dependency-fingerprint.js';
import type { EcosystemAdapter } from '../../core/ecosystems/index.js';
import type { CommandRunner } from '../../core/ecosystems/types.js';
import type { RemediateConfig, SpecGuardConfig } from '../../core/types.js';
import type { BaselineResult } from './baseline.js';
import { ingestRun, readLedgerFile, reprovenClaims, seedLedger, staleClaims, type IngestOutcome } from './ledger.js';
import { selectionByJob, type Selection } from './select-tests.js';
import { buildAndTypecheck, runJobs, testJobs, type JobsRun, type StepResult } from './steps.js';
import type { ChangeType, TestSummary } from './types.js';

export interface VerifyArgs {
  config: SpecGuardConfig;
  root: string;
  ecos: Array<{ dir: string; eco: EcosystemAdapter }>;
  run: CommandRunner;
  cfg: RemediateConfig;
  baseline: BaselineResult;
  changeType: ChangeType;
  targetAdvisoryIds: string[];
  advisoriesBefore: Advisory[];
  /** Re-run the detector on the patched tree. */
  redetect: () => Promise<Advisory[]>;
  selection: Selection;
  threshold: Severity;
  evidenceDir: string;
  runId: string;
  /** Called between the build and the tests, to check the write allowlist before the long step. */
  afterBuild?: () => void;
}

export interface VerifyOutcome {
  build: StepResult;
  typecheck: StepResult;
  selectedRun?: JobsRun;
  fullRun: JobsRun;
  patchedSummary: TestSummary;
  ingest: IngestOutcome;
  patchedLedgerPath: string;
  advisoriesAfter: Advisory[];
  proofs: ProofReprove;
  verdict: VerdictResult;
}

export async function verifyPatched(a: VerifyArgs): Promise<VerifyOutcome> {
  const { build, typecheck } = await buildAndTypecheck(a.ecos, a.run, a.cfg);
  a.afterBuild?.();

  // 1. Selected tests first, for a fast signal. Runners that cannot take a selection are skipped here.
  let selectedRun: JobsRun | undefined;
  // Jobs are rebuilt for THIS worktree: the baseline jobs point at the baseline worktree.
  const jobs = await testJobs(a.config, a.root, a.cfg);
  const sel = selectionByJob(jobs, a.root, a.selection.files);
  if (sel.size > 0) selectedRun = await runJobs(jobs, a.root, sel);

  // 2. Then ALWAYS the full suite.
  const fullRun = await runJobs(jobs, a.root);

  // 3. Patched ledger: start from the baseline snapshot, ingest the patched run.
  const patchedLedgerPath = path.join(a.evidenceDir, 'patched-proofs.json');
  seedLedger(a.baseline.snapshotPath, patchedLedgerPath);
  const quarantined = new Set(a.baseline.quarantined);
  const ingest = await ingestRun(
    fullRun.tests.filter((t) => !quarantined.has(testId(t))),
    a.root,
    patchedLedgerPath,
    `${a.runId}-patched`,
  );

  const provenBaseline = Object.entries(a.baseline.claims).filter(([, s]) => s === 'proven').map(([c]) => c);
  const baseLedger = readLedgerFile(a.baseline.snapshotPath);
  const patchedLedger = readLedgerFile(patchedLedgerPath);
  const proofs: ProofReprove = {
    baselineFingerprint: a.baseline.dependencyFingerprint,
    patchedFingerprint: dependencyFingerprint(a.root),
    staleBeforeIngest: baseLedger ? staleClaims(baseLedger, a.root, provenBaseline) : [],
    reprovenWithNewFingerprint: patchedLedger ? reprovenClaims(patchedLedger, a.root, provenBaseline) : [],
  };

  const advisoriesAfter = await a.redetect();

  const verdict = computeVerdict({
    threshold: a.threshold,
    changeType: a.changeType,
    targetAdvisoryIds: a.targetAdvisoryIds,
    baseline: { tests: a.baseline.tests, parsed: a.baseline.parsed, claims: a.baseline.claims },
    patched: { tests: fullRun.tests, parsed: fullRun.parsed, claims: ingest.claims },
    quarantined: a.baseline.quarantined,
    advisoriesBefore: a.advisoriesBefore,
    advisoriesAfter,
    build: { ok: build.ok },
    typecheck: { ok: typecheck.ok },
    proofs,
    selectedForPackage: a.selection.ids.length,
    selectedTestIds: a.selection.ids,
    strictUnexercised: a.cfg.strictUnexercised,
  });

  return { build, typecheck, selectedRun, fullRun, patchedSummary: fullRun.summary, ingest, patchedLedgerPath, advisoriesAfter, proofs, verdict };
}
