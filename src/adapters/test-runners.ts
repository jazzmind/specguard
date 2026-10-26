/**
 * Test-runner adapters.
 *
 * Each adapter knows how to ask one runner for a machine-readable report in an
 * OUTPUT FILE and how to read it. Reports are never recovered from stdout.
 *
 * Spec: specs/capabilities/conformance-testing.md
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
import { getLlmRuntime } from '../core/llm-runtime.js';

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
  /** Credentials from `WITHHELD_ENV` (and the configured model key) the test command may see: the app's `test.passEnv`. */
  passEnv?: string[];
  /** Run only the tests with these titles, when the adapter can select by title (see `titleFlags`). Combined with `selection`. */
  titles?: string[];
  /** What the adapter needs besides titles (the file and method of a Java test); see {@link TitleContext}. */
  titleTests?: TitleTarget[];
  /** Extra arguments for the command, such as a coverage run's flags. Never quoted: they are the project's own configuration. */
  extraFlags?: string;
}

/**
 * How far a run was narrowed.
 * - `tests`: the runner was told which tests to run, by title.
 * - `files`: only files (or packages) were selected, because the runner cannot select by title or a title could not be
 *   expressed safely; the run holds other tests of those files too.
 * - `suite`: no selection at all.
 */
export type RunSelection = 'tests' | 'files' | 'suite';

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
  /** How far the run was narrowed. */
  selection: RunSelection;
}

interface PreparedRun {
  command: string;
  selection: RunSelection;
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
  /**
   * Flags that restrict the run to the tests with exactly these titles, quoted for the shell, or `undefined` when this
   * runner cannot do it safely: no title support, a title the runner cannot express (a name that is not an identifier),
   * a list longer than a command line allows, or an argument the shell cannot be given. Callers treat `undefined` as
   * unknown and fall back to files, never as a pass.
   */
  titleFlags(titles: string[], ctx?: TitleContext): string | undefined;
  parse(text: string): TestCaseResult[];
}

/** One test as the adapters that select by class and method need it. */
export interface TitleTarget {
  /** Root-relative or absolute path of the test file. */
  file: string;
  title: string;
  /** Java and Kotlin: the method name, which differs from `title` under `@DisplayName`. */
  method?: string;
}

/** What `titleFlags` may need besides the titles. */
export interface TitleContext {
  tests?: TitleTarget[];
  /** The configured test command, to tell Gradle from Maven. */
  command?: string;
}

/**
 * One argument that SpecGuard adds to a test command (a file to run, a report path), quoted for the shell the command
 * runs in: single quotes on POSIX; double quotes under cmd.exe, which does not treat single quotes as quoting. A
 * value cmd.exe cannot be given safely (a quote, `%`, a newline or NUL) is refused, never passed through.
 */
export function quoteArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.includes('\0')) throw new Error('refusing to put a NUL in a test command');
  if (platform === 'win32') {
    if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(value)) return value;
    if (/["%\r\n]/.test(value)) throw new Error(`refusing to pass ${JSON.stringify(value.slice(0, 60))} to cmd.exe: it contains a quote, a percent sign or a newline`);
    return `"${value.endsWith('\\') ? `${value}\\` : value}"`;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

const q = (value: string): string => quoteArg(value);

const fileArgs = (selection: string[]) => selection.map(q).join(' ');

/** The longest title flag SpecGuard will build: cmd.exe stops at 8191 characters, Linux at 128 KiB per argument. */
export function maxTitleFlagLength(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 6000 : 100_000;
}

/** Escape text for a regular expression (JavaScript, and Go's RE2, which accept the same punctuation escapes). */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function uniqueTitles(titles: string[]): string[] {
  return [...new Set(titles.filter((t) => t.length > 0))];
}

/** Quote every argument for the shell, or `undefined` when one cannot be quoted or the whole is too long. */
function titleFlag(parts: string[]): string | undefined {
  try {
    const flags = parts.map(q).join(' ');
    return flags.length > maxTitleFlagLength() ? undefined : flags;
  } catch {
    return undefined;
  }
}

/**
 * `-t`/`--grep` pattern: each title is matched at the end of the full name, which a runner builds from the describe
 * blocks and the title joined by spaces, and starts at the name or after a space. A title that is the tail of another
 * (`works` and `never works`) can select an extra test; callers judge the result rows by file and title, so extras are ignored.
 */
function fullNamePattern(titles: string[]): string | undefined {
  const unique = uniqueTitles(titles);
  if (unique.length === 0) return undefined;
  return `(?:^|\\s)(?:${unique.map(escapeRegex).join('|')})$`;
}

const jsTitleFlags = (flag: string) => (titles: string[]): string | undefined => {
  const pattern = fullNamePattern(titles);
  return pattern === undefined ? undefined : titleFlag([flag, pattern]);
};

const PY_IDENT = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const PY_KEYWORDS = new Set(['and', 'or', 'not']);
const GO_TEST_NAME = /^Test[\p{L}\p{N}_]*$/u;
const RUST_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;
const JAVA_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `className` of a Java or Kotlin file, fully qualified when it sits under `src/<set>/java|kotlin/`. */
function javaClass(file: string, qualified: boolean): string | undefined {
  const posix = file.split('\\').join('/');
  const base = posix.replace(/\.(?:java|kt)$/, '');
  if (base === posix) return undefined;
  const name = base.slice(base.lastIndexOf('/') + 1);
  if (!JAVA_IDENT.test(name)) return undefined;
  if (!qualified) return name;
  const root = /(?:^|\/)src\/[^/]+\/(?:java|kotlin)\/(.+)$/.exec(base);
  const full = root ? root[1].split('/').join('.') : undefined;
  return full && full.split('.').every((part) => JAVA_IDENT.test(part)) ? full : `*${name}`;
}

/** Group `titles` by class for JUnit selection; undefined when a title has no known file or method. */
function javaMethods(titles: string[], ctx: TitleContext | undefined, qualified: boolean): Map<string, string[]> | undefined {
  const unique = uniqueTitles(titles);
  if (unique.length === 0 || !ctx?.tests) return undefined;
  const byClass = new Map<string, string[]>();
  for (const title of unique) {
    const targets = ctx.tests.filter((t) => t.title === title);
    if (targets.length === 0) return undefined;
    for (const target of targets) {
      const cls = javaClass(target.file, qualified);
      if (!cls || !target.method || !JAVA_IDENT.test(target.method)) return undefined;
      const methods = byClass.get(cls) ?? [];
      if (!methods.includes(target.method)) methods.push(target.method);
      byClass.set(cls, methods);
    }
  }
  return byClass;
}

export const ADAPTERS: Record<RunnerId, TestRunnerAdapter> = {
  vitest: {
    id: 'vitest',
    defaultCommand: 'npx vitest run',
    extension: 'json',
    reporterFlags: (file) => ({ flags: `--reporter=json --outputFile=${q(file)}` }),
    selectionFlags: fileArgs,
    titleFlags: jsTitleFlags('-t'),
    parse: (text) => parseVitestResults(text, 'vitest'),
  },
  jest: {
    id: 'jest',
    defaultCommand: 'npx jest',
    extension: 'json',
    reporterFlags: (file) => ({ flags: `--json --outputFile=${q(file)}` }),
    selectionFlags: fileArgs,
    titleFlags: jsTitleFlags('-t'),
    parse: (text) => parseVitestResults(text, 'jest'),
  },
  playwright: {
    id: 'playwright',
    defaultCommand: 'npx playwright test',
    extension: 'json',
    reporterFlags: (file) => ({ flags: '--reporter=json', env: { PLAYWRIGHT_JSON_OUTPUT_NAME: file } }),
    selectionFlags: fileArgs,
    titleFlags: jsTitleFlags('--grep'),
    parse: parsePlaywrightResults,
  },
  pytest: {
    id: 'pytest',
    defaultCommand: 'pytest',
    extension: 'xml',
    reporterFlags: (file) => ({ flags: `--junitxml=${q(file)}` }),
    selectionFlags: fileArgs,
    // `-k` matches names by substring, so `test_a` can also select `test_ab`: callers judge rows by file and title.
    titleFlags: (titles) => {
      const unique = uniqueTitles(titles);
      if (unique.length === 0 || !unique.every((t) => PY_IDENT.test(t) && !PY_KEYWORDS.has(t))) return undefined;
      return titleFlag(['-k', unique.join(' or ')]);
    },
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
    // Maven (`-Dtest=Class#m1+m2`) or, when the command says gradle, `--tests`. Both need the class and method of each test.
    titleFlags: (titles, ctx) => {
      const gradle = /\bgradlew?\b/i.test(ctx?.command ?? '');
      const byClass = javaMethods(titles, ctx, gradle);
      if (!byClass) return undefined;
      if (gradle) {
        const parts: string[] = [];
        for (const [cls, methods] of byClass) for (const method of methods) parts.push('--tests', `${cls}.${method}`);
        return titleFlag(parts);
      }
      const selector = [...byClass].map(([cls, methods]) => `${cls}#${methods.join('+')}`).join(',');
      return titleFlag([`-Dtest=${selector}`, '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false']);
    },
    parse: parseJunitResults,
  },
  go: {
    id: 'go',
    defaultCommand: 'go test ./...',
    extension: 'jsonl',
    reporterFlags: () => ({ flags: '-json', redirectStdout: true }),
    selectionFlags: (selection) => selection.map(q).join(' '),
    titleFlags: (titles) => {
      const unique = uniqueTitles(titles);
      if (unique.length === 0 || !unique.every((t) => GO_TEST_NAME.test(t))) return undefined;
      return titleFlag(['-run', `^(${unique.join('|')})$`]);
    },
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
    // Name filters for the test binary (after `--`): a substring match, `a` also selects `ab`.
    titleFlags: (titles) => {
      const unique = uniqueTitles(titles);
      if (unique.length === 0 || !unique.every((t) => RUST_PATH.test(t))) return undefined;
      return titleFlag(unique);
    },
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

const LIBTEST_SEPARATOR = /\s--(\s|$)/;

/** Arguments for the Rust test binary: after the command's own ` -- `, or after one added here. */
function withLibtestArgs(command: string, args: string): string {
  if (!args) return command;
  return LIBTEST_SEPARATOR.test(command) ? `${command} ${args}` : `${command} -- ${args}`;
}

/** Build the command line, environment, and report file for one run. Pure. */
export function prepareRun(adapter: TestRunnerAdapter, opts: TestRunOpts, runDir: string): PreparedRun {
  const base = opts.command ?? adapter.defaultCommand;
  const files = opts.selection && opts.selection.length > 0 ? adapter.selectionFlags(opts.selection) : '';
  const wantsTitles = (opts.titles?.length ?? 0) > 0;
  const titles = wantsTitles ? adapter.titleFlags(opts.titles ?? [], { tests: opts.titleTests, command: opts.command }) : undefined;
  const extra = opts.extraFlags?.trim() ?? '';
  const selection: RunSelection = titles ? 'tests' : files ? 'files' : 'suite';
  if (opts.resultsFile) {
    // The configured command already writes the report: run it as written.
    const env = { SPECGUARD_RESULTS_FILE: path.resolve(opts.cwd, opts.resultsFile) };
    if (adapter.id === 'cargo') {
      return { command: withLibtestArgs(withFlags(base, [files, extra].filter(Boolean).join(' ')), titles ?? ''), env, selection };
    }
    return { command: withFlags(base, [extra, titles, files].filter(Boolean).join(' ')), env, selection };
  }
  const file = path.join(runDir, `results.${adapter.extension}`);
  const rep = adapter.reporterFlags(file);
  let command: string;
  if (adapter.id === 'cargo') {
    // cargo puts selection before `--`, reporter flags and test-binary filters after it.
    command = `${base}${files || extra ? ` ${[files, extra].filter(Boolean).join(' ')}` : ''} ${rep.flags}${titles ? ` ${titles}` : ''}`.trim();
  } else if (adapter.id === 'go') {
    command = `${base.replace(/\s+\.\/\.\.\.\s*$/, '')} ${[rep.flags, extra, titles].filter(Boolean).join(' ')} ${files || './...'}`.trim();
  } else {
    command = withFlags(base, [rep.flags, extra, titles, files].filter(Boolean).join(' '));
  }
  if (rep.redirectStdout) command = `${command} > ${q(file)}`;
  return { command, env: rep.env ?? {}, file, selection };
}

/**
 * Credentials that SpecGuard itself uses and a project's tests have no business with. They are taken out of the
 * environment of a test command (the command is project code, and so are the dependencies it loads) unless the app's
 * `test.passEnv` names them, for the project whose tests really do call a model.
 */
export const WITHHELD_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LITELLM_API_KEY', 'SPECGUARD_TOKEN', 'SPECGUARD_BOOTSTRAP_TOKEN'];

/** The environment a test command runs with: ours, minus the withheld credentials, plus what the adapter adds. */
export function testEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>, opts: { passEnv?: string[]; withholdEnv?: string[] } = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  const pass = new Set(opts.passEnv ?? []);
  for (const name of [...WITHHELD_ENV, ...(opts.withholdEnv ?? [])]) if (!pass.has(name)) delete out[name];
  return { ...out, ...extra };
}

/** Exec seam: tests replace `testRunnerSeam.exec` to avoid spawning real runners. */
export const testRunnerSeam = {
  exec(
    command: string,
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number; passEnv?: string[]; withholdEnv?: string[] },
  ): { output: string; exitCode: number; timedOut: boolean } {
    // The command is the project's own configured test command (a command line, like an npm script, which may use
    // pipes and `&&`), so it runs in a shell. Everything SpecGuard appends to it is quoted by `quoteArg`.
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
    const res = spawnSync(command, {
      cwd: opts.cwd,
      shell: true,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs,
      env: testEnv(process.env, opts.env, opts),
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
    const llm = getLlmRuntime()?.llm;
    const res = testRunnerSeam.exec(prepared.command, {
      cwd: opts.cwd,
      env: prepared.env,
      timeoutMs,
      passEnv: opts.passEnv,
      // the key the project configured for SpecGuard's own model calls, whatever it is called
      withholdEnv: [llm?.apiKeyEnv, ...(llm?.fallback ?? []).map((t) => t.apiKeyEnv), ...Object.values(llm?.models ?? {}).map((t) => t?.apiKeyEnv)].filter((n): n is string => Boolean(n)),
    });
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
    selection: prepared.selection,
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
  return { tests: [], exitCode: 1, raw: message, parsed: false, timedOut: false, parseError: message, reportFiles: [], command, selection: 'suite' };
}
