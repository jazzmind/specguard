/**
 * Test-runner adapters.
 *
 * Each adapter knows how to ask one runner for a machine-readable report in an
 * OUTPUT FILE and how to read it. Reports are never recovered from stdout.
 *
 * Spec: specs/adapters/test-runners.md
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { expandGlobsSync } from '../plugins/glob.js';
import {
  parseCargoResults,
  parseGoResults,
  parseJunitResults,
  parsePlaywrightResults,
  parseVitestResults,
  type TestCaseResult,
} from '../core/test-results.js';
import { isDockerAvailable, runContainer } from './docker.js';

export const RUNNER_IDS = ['vitest', 'jest', 'playwright', 'pytest', 'junit', 'go', 'cargo'] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

export interface TestRunOpts {
  /** Working directory the command runs in (absolute). */
  cwd: string;
  /** Command override. Default: the adapter's own. */
  command?: string;
  /** Files (or, for Go, package directories) to run instead of the whole suite. */
  selection?: string[];
  timeoutMs?: number;
  sandbox?: 'local' | 'docker';
  /** Docker image when sandbox is docker. */
  image?: string;
  /** Reporter output file or glob, relative to `cwd`. When set, the command runs verbatim. */
  resultsFile?: string;
  /** Directory for generated report files. Default `<cwd>/.specguard/runs`. */
  runDir?: string;
  /** Keep the generated report file after reading it (for `results ingest` evidence). */
  keepReport?: boolean;
}

export interface TestRunReport {
  tests: TestCaseResult[];
  exitCode: number;
  /** Captured stdout and stderr, for humans. Never parsed. */
  raw: string;
  /** True when a report file was found and read. */
  parsed: boolean;
  timedOut: boolean;
  /** Why parsed is false. */
  parseError?: string;
  reportFiles: string[];
  /** The command that ran. */
  command: string;
}

interface PreparedRun {
  command: string;
  env: Record<string, string>;
  /** The generated report file, when the adapter injected flags. */
  file?: string;
}

export interface TestRunnerAdapter {
  id: RunnerId;
  /** Command used when none is configured. */
  defaultCommand: string;
  extension: string;
  /** Flags (and env) that make the runner write a report to `file`. */
  reporterFlags(file: string): { flags: string; env?: Record<string, string>; redirectStdout?: boolean };
  /** Flags that restrict the run to files or packages. */
  selectionFlags(selection: string[]): string;
  parse(text: string): TestCaseResult[];
}

function q(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

const fileArgs = (selection: string[]) => selection.map(q).join(' ');

export const ADAPTERS: Record<RunnerId, TestRunnerAdapter> = {
  vitest: {
    id: 'vitest',
    defaultCommand: 'npx vitest run',
    extension: 'json',
    reporterFlags: (file) => ({ flags: `--reporter=json --outputFile=${q(file)}` }),
    selectionFlags: fileArgs,
    parse: (text) => parseVitestResults(text, 'vitest'),
  },
  jest: {
    id: 'jest',
    defaultCommand: 'npx jest',
    extension: 'json',
    reporterFlags: (file) => ({ flags: `--json --outputFile=${q(file)}` }),
    selectionFlags: fileArgs,
    parse: (text) => parseVitestResults(text, 'jest'),
  },
  playwright: {
    id: 'playwright',
    defaultCommand: 'npx playwright test',
    extension: 'json',
    reporterFlags: (file) => ({ flags: '--reporter=json', env: { PLAYWRIGHT_JSON_OUTPUT_NAME: file } }),
    selectionFlags: fileArgs,
    parse: parsePlaywrightResults,
  },
  pytest: {
    id: 'pytest',
    defaultCommand: 'pytest',
    extension: 'xml',
    reporterFlags: (file) => ({ flags: `--junitxml=${q(file)}` }),
    selectionFlags: fileArgs,
    parse: parseJunitResults,
  },
  junit: {
    id: 'junit',
    defaultCommand: 'mvn test',
    extension: 'xml',
    // A JUnit-producing runner (Maven Surefire, go-junit-report, ...) writes its own files;
    // configure `resultsFile` (a glob such as target/surefire-reports/TEST-*.xml).
    reporterFlags: () => ({ flags: '' }),
    selectionFlags: () => '',
    parse: parseJunitResults,
  },
  go: {
    id: 'go',
    defaultCommand: 'go test ./...',
    extension: 'jsonl',
    reporterFlags: () => ({ flags: '-json', redirectStdout: true }),
    selectionFlags: (selection) => selection.map(q).join(' '),
    parse: parseGoResults,
  },
  cargo: {
    id: 'cargo',
    defaultCommand: 'cargo test',
    extension: 'jsonl',
    // `-Z unstable-options --format json` needs a nightly toolchain; RUSTC_BOOTSTRAP=1 allows it on stable.
    reporterFlags: () => ({
      flags: '-- -Z unstable-options --format json',
      env: { RUSTC_BOOTSTRAP: '1' },
      redirectStdout: true,
    }),
    selectionFlags: () => '',
    parse: parseCargoResults,
  },
};

export function isRunnerId(value: string): value is RunnerId {
  return (RUNNER_IDS as readonly string[]).includes(value);
}

/** Map a language profile's test framework name onto an adapter. */
export function runnerForFramework(framework: string | undefined): RunnerId | undefined {
  switch ((framework ?? '').toLowerCase()) {
    case 'vitest':
      return 'vitest';
    case 'jest':
      return 'jest';
    case 'playwright':
      return 'playwright';
    case 'pytest':
      return 'pytest';
    case 'junit':
      return 'junit';
    case 'go-test':
    case 'go':
      return 'go';
    case 'cargo-test':
    case 'cargo':
      return 'cargo';
    default:
      return undefined;
  }
}

export function getRunnerAdapter(id: string): TestRunnerAdapter {
  if (!isRunnerId(id)) {
    throw new Error(`Unknown test runner '${id}'. Supported: ${RUNNER_IDS.join(', ')}.`);
  }
  return ADAPTERS[id];
}

const NPM_SCRIPT = /^\s*npm\s+(?:run(?:-script)?\s+\S+|test|t|tst)\b/;

/** Where the reporter flags go: after ` -- ` for an npm script, appended otherwise. */
export function withFlags(command: string, flags: string): string {
  if (!flags) return command;
  if (NPM_SCRIPT.test(command) && !/\s--(\s|$)/.test(command)) return `${command} -- ${flags}`;
  return `${command} ${flags}`;
}

/** Build the command line, environment, and report file for one run. Pure. */
export function prepareRun(adapter: TestRunnerAdapter, opts: TestRunOpts, runDir: string): PreparedRun {
  const base = opts.command ?? adapter.defaultCommand;
  const selection = opts.selection && opts.selection.length > 0 ? adapter.selectionFlags(opts.selection) : '';
  if (opts.resultsFile) {
    // The configured command already writes the report: run it as written.
    return {
      command: selection ? withFlags(base, selection) : base,
      env: { SPECGUARD_RESULTS_FILE: path.resolve(opts.cwd, opts.resultsFile) },
    };
  }
  const file = path.join(runDir, `results.${adapter.extension}`);
  const rep = adapter.reporterFlags(file);
  let command: string;
  if (adapter.id === 'cargo') {
    // cargo puts selection before `--`, reporter flags after it.
    command = `${base}${selection ? ` ${selection}` : ''} ${rep.flags}`.trim();
  } else if (adapter.id === 'go') {
    command = `${base.replace(/\s+\.\/\.\.\.\s*$/, '')} ${rep.flags} ${selection || './...'}`.trim();
  } else {
    command = withFlags(base, [rep.flags, selection].filter(Boolean).join(' '));
  }
  if (rep.redirectStdout) command = `${command} > ${q(file)}`;
  return { command, env: rep.env ?? {}, file };
}

/** Exec seam: tests replace `testRunnerSeam.exec` to avoid spawning real runners. */
export const testRunnerSeam = {
  exec(
    command: string,
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): { output: string; exitCode: number; timedOut: boolean } {
    const res = spawnSync(command, {
      cwd: opts.cwd,
      shell: true,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs,
      env: { ...process.env, ...opts.env },
    });
    const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return {
      output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
      exitCode: timedOut ? 124 : (res.status ?? 1),
      timedOut,
    };
  },
};

function readReports(adapter: TestRunnerAdapter, files: string[]): { tests: TestCaseResult[]; read: string[]; error?: string } {
  const tests: TestCaseResult[] = [];
  const read: string[] = [];
  let error: string | undefined;
  for (const file of files) {
    try {
      tests.push(...adapter.parse(readFileSync(file, 'utf8')));
      read.push(file);
    } catch (err) {
      error = `${path.basename(file)}: ${(err as Error).message}`;
    }
  }
  return { tests, read, error };
}

/** Run tests through an adapter and read the report file(s). Never throws on a failing suite. */
export async function runTests(adapterId: RunnerId, opts: TestRunOpts): Promise<TestRunReport> {
  const adapter = getRunnerAdapter(adapterId);
  const runDir = path.join(opts.runDir ?? path.join(opts.cwd, '.specguard', 'runs'), randomBytes(4).toString('hex'));
  mkdirSync(runDir, { recursive: true });
  const prepared = prepareRun(adapter, opts, runDir);
  const timeoutMs = opts.timeoutMs ?? 600_000;

  let output = '';
  let exitCode: number;
  let timedOut = false;
  if (opts.sandbox === 'docker') {
    if (!opts.image) {
      return failedReport(prepared.command, 'sandbox "docker" needs test.image (or app.test.image) in the config');
    }
    if (!(await isDockerAvailable())) {
      return failedReport(prepared.command, 'sandbox "docker" requested but Docker is not available; not falling back to the host');
    }
    const env = Object.entries(prepared.env).map(([name, value]) => ({ name, value: toContainerPath(value, opts.cwd) }));
    const containerCommand = toContainerPath(prepared.command, opts.cwd);
    const res = await runContainer({
      image: opts.image.split(':')[0],
      tag: opts.image.includes(':') ? opts.image.split(':').slice(1).join(':') : 'latest',
      volumes: [{ host: opts.cwd, container: '/work', mode: 'rw' }],
      env,
      args: ['sh', '-c', `cd /work && ${containerCommand}`],
      timeoutMs,
    });
    output = `${res.stdout}${res.stderr}`;
    exitCode = res.exitCode;
    timedOut = res.exitCode === -1 && /ETIMEDOUT|timed out/i.test(res.stderr);
  } else {
    const res = testRunnerSeam.exec(prepared.command, { cwd: opts.cwd, env: prepared.env, timeoutMs });
    output = res.output;
    exitCode = res.exitCode;
    timedOut = res.timedOut;
  }

  const candidates = prepared.file
    ? [prepared.file]
    : expandGlobsSync(opts.resultsFile ?? '', opts.cwd);
  const existing = candidates.filter((file) => {
    try {
      readFileSync(file);
      return true;
    } catch {
      return false;
    }
  });
  const { tests, read, error } = readReports(adapter, existing);
  const parsed = read.length > 0 && !error;
  const report: TestRunReport = {
    tests,
    exitCode,
    raw: output,
    parsed,
    timedOut,
    reportFiles: read,
    command: prepared.command,
    ...(parsed ? {} : { parseError: error ?? (candidates.length === 0 ? 'no results file matched' : 'results file was not written') }),
  };
  try {
    if (prepared.file && !opts.keepReport) rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  return report;
}

/** Inside the container the repo is mounted at /work: rewrite host cwd prefixes. */
function toContainerPath(text: string, cwd: string): string {
  return text.split(cwd).join('/work');
}

function failedReport(command: string, message: string): TestRunReport {
  return { tests: [], exitCode: 1, raw: message, parsed: false, timedOut: false, parseError: message, reportFiles: [], command };
}
