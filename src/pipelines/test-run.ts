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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { isRunnerId, runnerForFramework, runTests, type RunnerId, type RunSelection, type TitleTarget } from '../adapters/test-runners.js';
import { buildClaimTestIndex } from '../core/claim-tags.js';
import { parseClaimRef } from '../core/claims.js';
import { hashFile } from '../core/drift-registry.js';
import { ExitCode } from '../core/exit-codes.js';
import { expandGlobs } from '../core/reader.js';
import { buildSpecGraph, type SpecGraph } from '../core/spec-graph.js';
import { scanTestDeclarations } from '../core/test-declarations.js';
import type { AppCoverageConfig, PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';
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
  /**
   * Claim refs: run exactly the tests tagged to them (by title where the runner can select by title; otherwise the
   * files that hold them, reported as `selection: 'files'`). Cannot be combined with `selection`.
   */
  claims?: string[];
  /** Add each app's `test.coverage.flags` and record its report paths in the run record. Nothing is ingested here. */
  coverage?: boolean;
  /** Write `.specguard/runs/<id>.json`: what ran, per-test verdicts, the head commit and a hash of the owned source. */
  record?: string;
  /** Ingest the reports into the proof ledger. Default true; a red run against older code sets it false. */
  ingest?: boolean;
}

/** The run record `--record` writes. */
export interface RunRecord {
  version: 1;
  id: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  headSha?: string;
  claims: string[];
  /** `tests` when every suite selected by title; `files` when any suite could only select files; `suite` when nothing was selected. */
  selection: RunSelection;
  /** The tests the claims select, with the verdict the reports gave them (`missing` when no report row matched). */
  tests: Array<{ file: string; title: string; refs: string[]; verdict: 'pass' | 'fail' | 'skip' | 'missing' }>;
  suites: Array<{ label: string; runner: string; command: string; exitCode: number; parsed: boolean; selection: RunSelection; reports: string[] }>;
  /** sha256 over the content of the owned source files at the start of the run: equal later means no owned source changed since. */
  ownedSourceTreeHash: string;
  ownedFileCount: number;
  coverage?: Array<{ suite: string; configured: boolean; flags?: string; reports: string[]; format?: string }>;
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
  coverage?: AppCoverageConfig;
}

/** A test a claim selects: where it is and which of the requested refs it proves. */
interface SelectedTest {
  file: string;
  title: string;
  refs: Set<string>;
}

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A title as a runner reports it: escapes in the source literal are resolved. */
const plainTitle = (title: string): string => title.replace(/\\(['"`\\])/g, '$1').trim();

const RUNNER_FILES: Record<RunnerId, RegExp> = {
  vitest: /\.[cm]?[jt]sx?$/,
  jest: /\.[cm]?[jt]sx?$/,
  playwright: /\.[cm]?[jt]sx?$/,
  pytest: /\.py$/,
  junit: /\.(?:java|kt)$/,
  go: /_test\.go$/,
  cargo: /\.rs$/,
};

/** The tests tagged to the requested claim refs. `untitled` when a tagged test has no title the runner could be given. */
async function selectClaimTests(
  config: SpecGuardConfig,
  graph: SpecGraph,
  refs: string[],
): Promise<{ tests: SelectedTest[]; files: Set<string>; untitled: boolean; missing: string[] }> {
  const root = config.rootDir ?? process.cwd();
  const globs = new Set<string>();
  for (const n of graph.nodes.values()) for (const t of n.spec.meta.tests ?? []) globs.add(t);
  for (const app of config.apps) for (const t of [...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])]) globs.add(t);
  const index = buildClaimTestIndex({ testFiles: await expandGlobs([...globs], root), rootDir: root });
  const wanted = refs.map((ref) => ({ ref, parsed: parseClaimRef(ref)! }));
  const byTest = new Map<string, SelectedTest>();
  const files = new Set<string>();
  const found = new Set<string>();
  let untitled = false;
  for (const [key, entries] of index) {
    const parsed = parseClaimRef(key);
    if (!parsed) continue;
    // A test may cite the claim with or without a repo prefix; a ref without a row also selects the tests of its rows.
    const hits = wanted.filter((w) => w.parsed.specKey === parsed.specKey && w.parsed.claimId === parsed.claimId && (!w.parsed.exampleId || w.parsed.exampleId === parsed.exampleId));
    if (hits.length === 0) continue;
    for (const entry of entries) {
      if (entry.origin !== 'source') continue;
      files.add(entry.file);
      for (const hit of hits) found.add(hit.ref);
      const title = entry.title ? plainTitle(entry.title) : '';
      // A template literal interpolates at run time: its title is not known from the source.
      if (!title || title.includes('${')) {
        untitled = true;
        continue;
      }
      const id = `${entry.file}::${title}`;
      const test = byTest.get(id) ?? { file: entry.file, title, refs: new Set<string>() };
      for (const hit of hits) test.refs.add(hit.ref);
      byTest.set(id, test);
    }
  }
  return { tests: [...byTest.values()].sort((a, b) => `${a.file}::${a.title}`.localeCompare(`${b.file}::${b.title}`)), files, untitled, missing: refs.filter((r) => !found.has(r)) };
}

/** The Java/Kotlin method of each test title in a file, which JUnit selection needs. */
function javaMethod(root: string, file: string, title: string): string | undefined {
  try {
    return scanTestDeclarations(readFileSync(path.join(root, file), 'utf8'), file).find((d) => d.title === title)?.method;
  } catch {
    return undefined;
  }
}

/** A report row's file as a root-relative POSIX path. A root reached through a symlink (macOS `/var`) is tried by its real path too. */
function rowFile(root: string, file: string): string {
  const posix = (p: string): string => p.split(path.sep).join('/');
  if (!path.isAbsolute(file)) return file.split('\\').join('/');
  for (const base of [root, realpathOr(root)]) {
    const rel = path.relative(base, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return posix(rel);
  }
  return posix(file);
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The verdict the reports gave one selected test; `missing` when no row names its file and title. */
function verdictFor(verdicts: Map<string, 'pass' | 'fail' | 'skip'>, t: { file: string; title: string }): 'pass' | 'fail' | 'skip' | 'missing' {
  const exact = verdicts.get(`${t.file}::${t.title}`);
  if (exact) return exact;
  // a report that names the file by a longer path (a package prefix)
  for (const [id, verdict] of verdicts) if (id.endsWith(`/${t.file}::${t.title}`)) return verdict;
  return 'missing';
}

/** One hash over the content of `files`, so a later run can tell that none of them changed. */
export function ownedTreeHash(root: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of [...new Set(files)].sort()) h.update(`${f}\0${hashFile(path.join(root, f)) ?? 'absent'}\n`);
  return h.digest('hex');
}

function headSha(root: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
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

  // --claims: the tests tagged to the claims, and the owned source the run is about (hashed before anything runs).
  const claimRefs = [...new Set((opts.claims ?? []).map((r) => r.trim()).filter(Boolean))];
  const fail = (message: string, exitCode: number = ExitCode.InternalError): PipelineResult => {
    result.failed = 1;
    result.exitCode = exitCode;
    log(message);
    return result;
  };
  const badRef = claimRefs.find((r) => parseClaimRef(r) === null);
  if (badRef) return fail(`'${badRef}' is not a claim ref (<spec>#<claim-id>)`);
  if (claimRefs.length > 0 && opts.selection && opts.selection.length > 0) return fail('--claims selects the tests itself: do not also pass test files');
  const startedAt = new Date().toISOString();
  let claimTests: Awaited<ReturnType<typeof selectClaimTests>> | undefined;
  let ownedFiles: string[] = [];
  if (claimRefs.length > 0 || opts.record !== undefined) {
    if (opts.record !== undefined && !RECORD_ID.test(opts.record)) return fail(`'${opts.record}' is not a run record id (letters, digits, '.', '_' and '-')`);
    const graph = await buildSpecGraph(config);
    const specKeys = new Set(claimRefs.map((r) => parseClaimRef(r)!.specKey));
    ownedFiles = [...new Set([...graph.nodes.values()].filter((n) => specKeys.size === 0 || specKeys.has(n.specKey)).flatMap((n) => n.ownedFiles))].sort();
    if (claimRefs.length > 0) {
      claimTests = await selectClaimTests(config, graph, claimRefs);
      for (const ref of claimTests.missing) {
        result.items.push({ key: ref, status: 'skipped', message: 'no test is tagged to this claim' });
        log(`[claims] no test is tagged to ${ref}`);
      }
      if (claimTests.files.size === 0) {
        result.skipped += claimTests.missing.length;
        return fail('[claims] none of the claims has a tagged test: nothing was run', ExitCode.ValidationFailed);
      }
    }
  }
  const ownedHash = ownedTreeHash(root, ownedFiles);

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
            coverage: app.test?.coverage,
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
        coverage: app.test?.coverage,
      });
    }
  }

  // Reports are ingested per runner and layer, so each suite's tests carry its layer.
  const byRunner = new Map<string, { runner: RunnerId; layer?: TestLayer; files: string[] }>();
  const ran = new Set<string>();
  const suiteRuns: RunRecord['suites'] = [];
  const coverageRecord: NonNullable<RunRecord['coverage']> = [];
  const verdicts = new Map<string, 'pass' | 'fail' | 'skip'>();
  let suiteFailed = false;
  for (const suite of suites) {
    // Apps that share a repo and command are one suite.
    const key = `${suite.cwd}\0${suite.command ?? ''}\0${suite.runner}`;
    if (ran.has(key)) continue;
    ran.add(key);

    // --claims: this suite runs the selected tests that live in its directory and that its runner can run.
    let selection = opts.selection;
    let titles: string[] | undefined;
    let titleTests: TitleTarget[] | undefined;
    if (claimTests) {
      const mine = claimTests.tests.filter((t) => RUNNER_FILES[suite.runner].test(t.file) && !path.relative(suite.cwd, path.join(root, t.file)).startsWith('..'));
      const mineFiles = [...claimTests.files].filter((f) => RUNNER_FILES[suite.runner].test(f) && !path.relative(suite.cwd, path.join(root, f)).startsWith('..'));
      if (mineFiles.length === 0) {
        log(`[skip] ${suite.label}: none of the selected tests belongs to this suite`);
        continue;
      }
      const rel = (f: string): string => path.relative(suite.cwd, path.join(root, f)).split(path.sep).join('/');
      // Go selects packages, not files.
      selection = suite.runner === 'go' ? [...new Set(mineFiles.map((f) => `./${path.posix.dirname(rel(f))}`.replace(/^\.\/\.$/, '.')))] : mineFiles.map(rel);
      if (!claimTests.untitled && mine.length > 0) {
        titles = [...new Set(mine.map((t) => t.title))];
        titleTests = mine.map((t) => ({ file: t.file, title: t.title, method: suite.runner === 'junit' ? javaMethod(root, t.file, t.title) : undefined }));
      }
    }

    let extraFlags: string | undefined;
    if (opts.coverage) {
      if (suite.coverage) {
        extraFlags = suite.coverage.flags;
        coverageRecord.push({ suite: suite.label, configured: true, ...(suite.coverage.flags ? { flags: suite.coverage.flags } : {}), reports: suite.coverage.reports, ...(suite.coverage.format ? { format: suite.coverage.format } : {}) });
        log(`[coverage] ${suite.label}: reports ${suite.coverage.reports.join(', ')} (ingest them with \`specguard coverage ingest\`)`);
      } else {
        coverageRecord.push({ suite: suite.label, configured: false, reports: [] });
        log(`[coverage] ${suite.label}: no test.coverage configured; ran without coverage`);
      }
    }

    const report = await runTests(suite.runner, {
      cwd: suite.cwd,
      command: suite.command,
      resultsFile: suite.resultsFile,
      timeoutMs: suite.timeoutMs,
      selection,
      titles,
      titleTests,
      extraFlags,
      sandbox: config.runners?.testRunner === 'docker' ? 'docker' : 'local',
      passEnv: suite.passEnv,
      image: suite.image,
      keepReport: true,
    });
    suiteRuns.push({
      label: suite.label,
      runner: suite.runner,
      command: report.command,
      exitCode: report.exitCode,
      parsed: report.parsed,
      selection: report.selection,
      reports: report.reportFiles.map((f) => path.relative(root, f).split(path.sep).join('/')),
    });
    if (claimTests) {
      log(`[claims] ${suite.label}: selected ${report.selection === 'tests' ? 'by title' : report.selection === 'files' ? 'by file only (this runner cannot select by title here): other tests in those files ran too' : 'nothing'}`);
      for (const row of report.tests) {
        const id = `${rowFile(root, row.file)}::${plainTitle(row.title)}`;
        // pass, fail and skip are all the rows can say; a row seen twice (two projects) fails if either fails.
        const prior = verdicts.get(id);
        verdicts.set(id, row.status === 'fail' || prior === 'fail' ? 'fail' : row.status === 'pass' || prior === 'pass' ? 'pass' : 'skip');
      }
    }
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
    result.items.push({ key: suite.label, status: report.exitCode === 0 ? 'ok' : 'failed', message: `${report.tests.length} test(s), exit ${report.exitCode}${claimTests ? `, selection: ${report.selection}` : ''}` });
    const files = report.reportFiles.map((f) => path.relative(root, f).split(path.sep).join('/'));
    const groupKey = `${suite.runner}\0${suite.layer ?? ''}`;
    const group = byRunner.get(groupKey) ?? { runner: suite.runner, layer: suite.layer, files: [] };
    group.files.push(...files);
    byRunner.set(groupKey, group);
  }

  let ingestExit: number = ExitCode.Success;
  const runId = opts.runId ?? `test-run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const allAppsRan = !opts.app && !opts.selection && !claimTests && !(opts.units && opts.units.length > 0) && !opts.affected;
  for (const { runner, layer, files } of opts.ingest === false ? [] : byRunner.values()) {
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

  if (opts.record !== undefined) {
    const selected = claimTests?.tests ?? [];
    const kinds = suiteRuns.map((r) => r.selection);
    const record: RunRecord = {
      version: 1,
      id: opts.record,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(headSha(root) ? { headSha: headSha(root) } : {}),
      claims: claimRefs,
      selection: kinds.length > 0 && kinds.every((k) => k === 'tests') ? 'tests' : kinds.includes('files') ? 'files' : 'suite',
      tests: selected.map((t) => ({ file: t.file, title: t.title, refs: [...t.refs].sort(), verdict: verdictFor(verdicts, t) })),
      suites: suiteRuns,
      ownedSourceTreeHash: ownedHash,
      ownedFileCount: ownedFiles.length,
      ...(opts.coverage ? { coverage: coverageRecord } : {}),
    };
    const target = path.join(root, '.specguard', 'runs', `${opts.record}.json`);
    await writeFile(target, `${JSON.stringify(record, null, 2)}\n`);
    log(`[record] ${path.relative(root, target).split(path.sep).join('/')}`);
  }

  // A failing suite fails the run even when no failing test carries a claim tag.
  result.exitCode = ingestExit !== ExitCode.Success ? ingestExit : suiteFailed ? ExitCode.ValidationFailed : ExitCode.Success;
  return result;
}
