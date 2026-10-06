/**
 * Shared steps: install, build, typecheck, test jobs, environment fingerprint.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createHash } from 'node:crypto';

import { testId } from '../../core/behavior-verdict.js';
import { detectEcosystems, type EcosystemAdapter } from '../../core/ecosystems/index.js';
import type { CommandRunner } from '../../core/ecosystems/types.js';
import type { TestCaseResult } from '../../core/test-results.js';
import type { RemediateConfig, SpecGuardConfig } from '../../core/types.js';
import { runTests, type RunnerId, type TestRunReport } from '../../adapters/test-runners.js';
import { buildHealJobs, type HealJob } from '../heal.js';
import type { TestSummary } from './types.js';

export interface StepResult {
  ok: boolean;
  skipped?: boolean;
  command?: string;
  output: string;
}

const sh = (run: CommandRunner, cmd: string, cwd: string, timeoutMs: number) => run('sh', ['-c', cmd], { cwd, timeoutMs });

/** Install for a project dir: the configured command, or the ecosystem adapter's. */
export async function installProject(eco: EcosystemAdapter, dir: string, run: CommandRunner, cfg: RemediateConfig): Promise<StepResult> {
  if (cfg.installCommand) {
    const r = await sh(run, cfg.installCommand, dir, cfg.stepTimeoutMs ?? 600_000);
    return { ok: r.status === 0, command: cfg.installCommand, output: `${r.stdout}${r.stderr}` };
  }
  const r = await eco.install(dir);
  return { ok: r.ok, command: `${eco.id} install`, output: r.output };
}

function pkgScripts(dir: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

/** Default build and typecheck commands per ecosystem. Absent means the step is skipped. */
export function defaultCommands(eco: EcosystemAdapter, dir: string): { build?: string; typecheck?: string } {
  switch (eco.id) {
    case 'npm':
    case 'pnpm':
    case 'yarn': {
      const scripts = pkgScripts(dir);
      const runner = eco.id === 'npm' ? 'npm run' : `${eco.id} run`;
      const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
      return {
        build: scripts.build ? `${runner} build` : undefined,
        typecheck: scripts.typecheck ? `${runner} typecheck` : existsSync(path.join(dir, 'tsconfig.json')) && existsSync(tsc) ? 'node node_modules/typescript/bin/tsc --noEmit' : undefined,
      };
    }
    case 'go':
      return { build: 'go build ./...', typecheck: 'go vet ./...' };
    case 'cargo':
      return { build: 'cargo build', typecheck: 'cargo check' };
    case 'maven':
      return { build: 'mvn -q -B -DskipTests compile' };
    case 'gradle':
      return { build: `${existsSync(path.join(dir, 'gradlew')) ? './gradlew' : 'gradle'} --no-daemon -q classes` };
    default:
      return {};
  }
}

export async function runStep(run: CommandRunner, command: string | undefined, cwd: string, timeoutMs: number): Promise<StepResult> {
  if (!command) return { ok: true, skipped: true, output: '' };
  const r = await sh(run, command, cwd, timeoutMs);
  return { ok: r.status === 0, command, output: `${r.stdout}${r.stderr}`.slice(-4000) };
}

/** Build + typecheck across every project dir. */
export async function buildAndTypecheck(
  ecos: Array<{ dir: string; eco: EcosystemAdapter }>,
  run: CommandRunner,
  cfg: RemediateConfig,
): Promise<{ build: StepResult; typecheck: StepResult }> {
  const timeout = cfg.stepTimeoutMs ?? 600_000;
  let build: StepResult = { ok: true, skipped: true, output: '' };
  let typecheck: StepResult = { ok: true, skipped: true, output: '' };
  for (const { dir, eco } of ecos) {
    const d = defaultCommands(eco, dir);
    const b = await runStep(run, cfg.buildCommand ?? d.build, dir, timeout);
    if (!b.skipped) build = { ...b, ok: (build.skipped ? true : build.ok) && b.ok, skipped: false, output: `${build.output}${b.output}` };
    const t = await runStep(run, cfg.typecheckCommand ?? d.typecheck, dir, timeout);
    if (!t.skipped) typecheck = { ...t, ok: (typecheck.skipped ? true : typecheck.ok) && t.ok, skipped: false, output: `${typecheck.output}${t.output}` };
  }
  return { build, typecheck };
}

export function projectEcosystems(config: SpecGuardConfig, root: string, run: CommandRunner, app?: string): Array<{ dir: string; eco: EcosystemAdapter }> {
  const out: Array<{ dir: string; eco: EcosystemAdapter }> = [];
  const seen = new Set<string>();
  for (const a of config.apps) {
    if (app && a.name !== app) continue;
    const dir = path.resolve(root, a.repo || '.');
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const eco of detectEcosystems(dir, run)) out.push({ dir, eco });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test jobs
// ---------------------------------------------------------------------------

export type TestJob = HealJob;

/** Test jobs for the config as rooted at `root` (a worktree). Uses the per-app `test` config. */
export async function testJobs(config: SpecGuardConfig, root: string, cfg: RemediateConfig, app?: string): Promise<TestJob[]> {
  const rooted: SpecGuardConfig = {
    ...config,
    rootDir: root,
    runners: { ...config.runners, ...(cfg.sandbox ? { testRunner: cfg.sandbox } : {}) },
  };
  return buildHealJobs(rooted, app ? { app } : {});
}

export interface JobsRun {
  tests: TestCaseResult[];
  /** False when any job's report was missing/unparseable, or a job failed without a failing test. */
  parsed: boolean;
  reports: Array<{ job: string; command: string; exitCode: number; parsed: boolean; timedOut: boolean; parseError?: string }>;
  summary: TestSummary;
}

function normalize(report: TestRunReport, job: TestJob, root: string): TestCaseResult[] {
  const prefix = path.relative(root, job.cwd).split(path.sep).join('/');
  return report.tests.map((t) => (prefix ? { ...t, file: `${prefix}/${t.file}` } : t));
}

/** Run every job. Unparseable output, a timeout, or a non-zero exit without a failing test is "not parsed". */
export async function runJobs(jobs: TestJob[], root: string, selection?: Map<string, string[]>): Promise<JobsRun> {
  const tests = new Map<string, TestCaseResult>();
  const reports: JobsRun['reports'] = [];
  let parsed = true;
  for (const job of jobs) {
    const sel = selection?.get(job.key);
    if (selection && (!sel || sel.length === 0)) continue;
    const report = await runTests(job.runner as RunnerId, {
      cwd: job.cwd,
      command: job.command,
      resultsFile: job.resultsFile,
      timeoutMs: job.timeoutMs,
      sandbox: job.sandbox,
      image: job.image,
      selection: sel,
    });
    const rows = normalize(report, job, root);
    const failing = rows.some((t) => t.status === 'fail');
    const ok = report.parsed && !report.timedOut && (report.exitCode === 0 || failing);
    if (!ok) parsed = false;
    reports.push({ job: job.key, command: report.command, exitCode: report.exitCode, parsed: ok, timedOut: report.timedOut, parseError: report.parseError });
    for (const t of rows) tests.set(testId(t), t);
  }
  const list = [...tests.values()];
  return {
    tests: list,
    parsed,
    reports,
    summary: {
      total: list.length,
      passed: list.filter((t) => t.status === 'pass').length,
      failed: list.filter((t) => t.status === 'fail').length,
      skipped: list.filter((t) => t.status === 'skip').length,
      parsed,
      commands: reports.map((r) => r.command),
    },
  };
}

// ---------------------------------------------------------------------------
// Environment fingerprint
// ---------------------------------------------------------------------------

export interface EnvFingerprint {
  lockfiles: Record<string, string>;
  runtimes: Record<string, string>;
  hash: string;
}

const RUNTIME_PROBES: Record<string, Array<[string, string[]]>> = {
  npm: [['node', ['--version']], ['npm', ['--version']]],
  pnpm: [['node', ['--version']], ['pnpm', ['--version']]],
  yarn: [['node', ['--version']], ['yarn', ['--version']]],
  pip: [['python3', ['--version']]],
  poetry: [['python3', ['--version']]],
  uv: [['python3', ['--version']]],
  go: [['go', ['version']]],
  cargo: [['rustc', ['--version']]],
  maven: [['java', ['-version']]],
  gradle: [['java', ['-version']]],
};

export async function environmentFingerprint(ecos: Array<{ dir: string; eco: EcosystemAdapter }>, root: string, run: CommandRunner): Promise<EnvFingerprint> {
  const lockfiles: Record<string, string> = {};
  const runtimes: Record<string, string> = {};
  for (const { dir, eco } of ecos) {
    lockfiles[`${path.relative(root, dir) || '.'}:${eco.id}`] = eco.fingerprint(dir);
    for (const [cmd, args] of RUNTIME_PROBES[eco.id] ?? []) {
      if (runtimes[cmd]) continue;
      try {
        const r = await run(cmd, args, { cwd: dir, timeoutMs: 10_000 });
        const text = `${r.stdout}${r.stderr}`.trim().split('\n')[0];
        if (!r.error && text) runtimes[cmd] = text;
      } catch {
        /* optional */
      }
    }
  }
  const hash = createHash('sha256').update(JSON.stringify({ lockfiles, runtimes })).digest('hex');
  return { lockfiles, runtimes, hash };
}
