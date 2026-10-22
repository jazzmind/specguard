/**
 * `specguard test run`: run each app's configured tests and ingest the reports
 * into the proof ledger in one step.
 *
 * Reports are read from files the runner writes, never from stdout. The same
 * ingest path as `results ingest` records the verdicts, so tests run here and
 * results produced by CI end up in one ledger.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { isRunnerId, runnerForFramework, runTests, type RunnerId } from '../adapters/test-runners.js';
import { ExitCode } from '../core/exit-codes.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { loadWorkspace, type WorkspaceManifest } from '../core/workspace.js';
import type { TestLayer } from '../core/test-layers.js';
import { affectedUnits, unitDependencies, unitsToTest } from '../core/workspace-units.js';
import { runResultsIngest } from './results.js';

export interface TestRunPipelineOpts {
  /** Only this app. */
  app?: string;
  /** Run only these files (or Go package directories). */
  selection?: string[];
  runId?: string;
  /** Proof ledger file. */
  ledger?: string;
  /** Also store `unexercised` for claims no test cited; honoured only when every app ran. */
  unexercised?: boolean;
  /** Workspaces: run only these units. */
  units?: string[];
  /** Workspaces: run only the units whose files changed, and the units that depend on them. */
  affected?: boolean;
  /** With `affected`: git ref to compare against. Default: the working tree against HEAD. */
  since?: string;
}

/** One suite to run: an app's configured tests, or one workspace unit's. */
interface Suite {
  label: string;
  runner: RunnerId;
  cwd: string;
  command?: string;
  resultsFile?: string;
  timeoutMs?: number;
  image?: string;
  /** The layer its tests belong to, from `test.suites`. */
  layer?: TestLayer;
  passEnv?: string[];
}

/** Throws when git fails: an unknown ref must not look like "nothing changed". */
function gitLines(root: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Files changed since `since` (or in the working tree), including new untracked files. Repo-relative, POSIX. */
function changedFiles(root: string, since?: string): string[] {
  return [...new Set([...gitLines(root, ['diff', '--name-only', '--relative', since ?? 'HEAD']), ...gitLines(root, ['ls-files', '--others', '--exclude-standard'])])];
}

/** The workspace manifest when it sits at the repo root and has package units that say how to run their tests. */
async function unitManifest(root: string): Promise<WorkspaceManifest | null> {
  if (!existsSync(path.join(root, '.specguard', 'workspace.json'))) return null;
  try {
    const m = await loadWorkspace(root);
    return path.resolve(m.rootDir) === path.resolve(root) && Object.values(m.units).some((u) => u.kind === 'package' && u.test?.command) ? m : null;
  } catch {
    return null;
  }
}

export async function runTestRun(config: SpecGuardConfig, opts: TestRunPipelineOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('test-run');
  const log = (line: string): void => void result.messages.push(line);
  const root = config.rootDir ?? process.cwd();
  const apps = opts.app ? config.apps.filter((a) => a.name === opts.app) : config.apps;
  if (apps.length === 0) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(opts.app ? `no app named "${opts.app}"` : 'no apps configured');
    return result;
  }

  const suites: Suite[] = [];
  const manifest = opts.app ? null : await unitManifest(root);
  if (manifest) {
    let chosen = Object.keys(manifest.units).filter((k) => manifest.units[k].kind === 'package' && manifest.units[k].test?.command);
    if (opts.units && opts.units.length > 0) {
      const unknown = opts.units.filter((u) => !chosen.includes(u));
      if (unknown.length > 0) {
        result.failed = 1;
        result.exitCode = ExitCode.InternalError;
        log(`unknown unit(s): ${unknown.join(', ')}. Units with tests: ${chosen.join(', ')}`);
        return result;
      }
      chosen = opts.units;
    } else if (opts.affected) {
      let changed: string[];
      try {
        changed = changedFiles(root, opts.since);
      } catch {
        result.failed = 1;
        result.exitCode = ExitCode.InternalError;
        log(`--affected needs git to list changed files${opts.since ? ` since "${opts.since}"` : ''}, and git failed (bad ref, no commits, or not a repository). Nothing was run.`);
        return result;
      }
      const { units: touched, outside } = affectedUnits(manifest, changed);
      if (outside.length > 0) {
        // A root-level file (lockfile, shared config) can affect any unit.
        log(`[affected] ${outside.length} changed file(s) are outside every unit (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', ...' : ''}); running every unit`);
      } else {
        chosen = unitsToTest(unitDependencies(manifest), touched).filter((u) => chosen.includes(u));
        log(`[affected] ${touched.length} changed unit(s); testing ${chosen.length}: ${chosen.join(', ') || '(none)'}`);
        if (chosen.length === 0) return result;
      }
    }
    for (const key of chosen) {
      const unit = manifest.units[key];
      const framework = unit.test?.framework;
      const runner = framework && isRunnerId(framework) ? framework : runnerForFramework(framework);
      if (!runner) {
        result.skipped += 1;
        result.items.push({ key, status: 'skipped', message: `no test runner for framework "${framework}"` });
        log(`[skip] ${key}: no test runner for framework "${framework}"`);
        continue;
      }
      suites.push({ label: key, runner, cwd: root, command: unit.test?.command });
    }
  } else {
    const apps = opts.app ? config.apps.filter((a) => a.name === opts.app) : config.apps;
    if (apps.length === 0) {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      log(opts.app ? `no app named "${opts.app}"` : 'no apps configured');
      return result;
    }
    for (const app of apps) {
      // An app with `test.suites` runs each of them (a command and a layer) instead of its single command.
      const appSuites = app.test?.suites ?? [];
      if (appSuites.length > 0) {
        for (const suite of appSuites) {
          const reporter = suite.reporter ?? app.test?.reporter;
          const suiteRunner: RunnerId | undefined = reporter && isRunnerId(reporter) ? reporter : runnerForFramework(app.framework);
          if (!suiteRunner) {
            result.skipped += 1;
            result.items.push({ key: `${app.name}/${suite.name}`, status: 'skipped', message: `no test runner for suite "${suite.name}"` });
            log(`[skip] ${app.name}/${suite.name}: no test runner`);
            continue;
          }
          suites.push({
            label: `${app.name}/${suite.name}`,
            runner: suiteRunner,
            cwd: path.resolve(root, suite.cwd ?? app.test?.cwd ?? app.repo),
            command: suite.command,
            resultsFile: suite.resultsFile,
            timeoutMs: suite.timeoutMs ?? app.test?.timeoutMs,
            image: app.test?.image,
            layer: suite.layer,
            passEnv: app.test?.passEnv,
          });
        }
        continue;
      }
      const configured = app.test?.reporter;
      const runner: RunnerId | undefined = configured && isRunnerId(configured) ? configured : runnerForFramework(app.framework);
      if (!runner) {
        result.skipped += 1;
        result.items.push({ key: app.name, status: 'skipped', message: `no test runner for framework "${app.framework}"` });
        log(`[skip] ${app.name}: no test runner for framework "${app.framework}"`);
        continue;
      }
      suites.push({
        label: app.name,
        runner,
        cwd: path.resolve(root, app.test?.cwd ?? app.repo),
        command: app.test?.command,
        resultsFile: app.test?.resultsFile,
        timeoutMs: app.test?.timeoutMs,
        image: app.test?.image,
        passEnv: app.test?.passEnv,
      });
    }
  }

  // Reports are ingested per runner and layer, so each suite's tests carry its layer.
  const byRunner = new Map<string, { runner: RunnerId; layer?: TestLayer; files: string[] }>();
  const ran = new Set<string>();
  let suiteFailed = false;
  for (const suite of suites) {
    // Apps that share a repo and command are one suite.
    const key = `${suite.cwd}\0${suite.command ?? ''}\0${suite.runner}`;
    if (ran.has(key)) continue;
    ran.add(key);

    const report = await runTests(suite.runner, {
      cwd: suite.cwd,
      command: suite.command,
      resultsFile: suite.resultsFile,
      timeoutMs: suite.timeoutMs,
      selection: opts.selection,
      sandbox: config.runners?.testRunner === 'docker' ? 'docker' : 'local',
      passEnv: suite.passEnv,
      image: suite.image,
      keepReport: true,
    });
    log(`[run] ${suite.label}: ${report.command} → ${report.parsed ? `${report.tests.length} test(s)` : 'no report'}, exit ${report.exitCode}${report.timedOut ? ' (timed out)' : ''}`);
    if (!report.parsed) {
      suiteFailed = true;
      result.failed += 1;
      result.items.push({ key: suite.label, status: 'failed', message: report.parseError ?? 'no report was produced' });
      log(`[fail] ${suite.label}: ${report.parseError ?? 'no report was produced'}`);
      continue;
    }
    if (report.exitCode !== 0) suiteFailed = true;
    result.created += 1;
    result.items.push({ key: suite.label, status: report.exitCode === 0 ? 'ok' : 'failed', message: `${report.tests.length} test(s), exit ${report.exitCode}` });
    const files = report.reportFiles.map((f) => path.relative(root, f).split(path.sep).join('/'));
    const groupKey = `${suite.runner}\0${suite.layer ?? ''}`;
    const group = byRunner.get(groupKey) ?? { runner: suite.runner, layer: suite.layer, files: [] };
    group.files.push(...files);
    byRunner.set(groupKey, group);
  }

  let ingestExit: number = ExitCode.Success;
  const runId = opts.runId ?? `test-run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const allAppsRan = !opts.app && !opts.selection && !(opts.units && opts.units.length > 0) && !opts.affected;
  for (const { runner, layer, files } of byRunner.values()) {
    const ingest = await runResultsIngest(files, root, {
      suiteLayer: layer,
      // The pytest adapter writes JUnit XML; the `pytest` result format is pytest-json-report's JSON.
      format: runner === 'pytest' ? 'junit' : runner,
      runId,
      ledger: opts.ledger,
      unexercised: opts.unexercised && allAppsRan,
      fullRun: allAppsRan && byRunner.size === 1,
    });
    for (const m of ingest.messages) log(m);
    result.items.push(...ingest.items);
    if (ingest.exitCode !== ExitCode.Success) ingestExit = ingest.exitCode;
    result.updated += ingest.updated;
    result.failed += ingest.failed;
  }

  // A failing suite fails the run even when no failing test carries a claim tag.
  result.exitCode = ingestExit !== ExitCode.Success ? ingestExit : suiteFailed ? ExitCode.ValidationFailed : ExitCode.Success;
  return result;
}
