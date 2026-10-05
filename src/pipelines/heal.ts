/**
 * Self-Healing Test pipeline.
 *
 * Runs the project's tests, and for each failing test asks the LLM to attribute
 * the failure to either the test (stale assertion / drifted selector) or the
 * application (a real bug the test correctly caught). Test bugs are rewritten
 * and the suite re-run, up to `maxRetries` times. Application bugs are reported
 * and application source is NEVER modified.
 *
 * Spec: specs/pipelines/heal.md
 *
 * Jobs
 * ----
 * One job per distinct (adapter, command, cwd, resultsFile): each app's `test`
 * block, plus a shared job for apps without one. Every job runs through a
 * test-runner adapter (src/adapters/test-runners.ts) that reads the reporter's
 * output file. Output that cannot be read is a failure, never a pass.
 *
 * Runner seam
 * -----------
 * The invocation lives behind the exported `healRunner` object so tests replace
 * it with `vi.spyOn(healRunner, 'run')`.
 *
 * Exit code
 * ---------
 * An app-bug means the test correctly caught a real defect: the suite is still
 * red, so the pipeline still exits with `HealFailed` (7). Exit 0 is reserved for
 * a suite that ends fully green.
 */
import path from 'node:path';

import { z } from 'zod';

import {
  getRunnerAdapter,
  isRunnerId,
  runnerForFramework,
  runTests,
  type RunnerId,
  type TestRunReport,
} from '../adapters/test-runners.js';
import { buildAppPrepass, collectTestFiles } from '../core/claim-prepass.js';
import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';
import {
  parseVitestJson,
  resolveProfile,
  type FailingTest,
  type LanguageProfile,
} from '../core/language-profiles.js';
import { fileExists, readFile } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import type { AppConfig, ParsedSpec, PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';

// Re-export so existing importers (and tests) keep working unchanged.
export { parseVitestJson };
export type { FailingTest };

export interface HealOpts {
  /** A spec key (`core/reader`, or `<app>/core/reader`): run only its app and its tests. */
  spec?: string;
  /** Heal every app. This is the default; the flag makes the intent explicit. */
  all?: boolean;
  /** Heal one app by name. */
  app?: string;
  /** Override the retry budget from config. */
  maxRetries?: number;
  /** Classify failures and report them. Never rewrite a test and never re-run. */
  classifyOnly?: boolean;
  /** Treat an unreadable report as passing when the runner exited zero (the old fail-open behaviour). */
  lenient?: boolean;
}

/** One test invocation. */
export interface HealJob {
  key: string;
  runner: RunnerId;
  command?: string;
  /** Absolute working directory. */
  cwd: string;
  resultsFile?: string;
  timeoutMs?: number;
  image?: string;
  sandbox: 'local' | 'docker';
  /** Test files relative to `cwd`; empty means the whole suite. */
  selection: string[];
  profile: LanguageProfile;
  apps: AppConfig[];
}

/**
 * Test-runner seam. Tests stub this via `vi.spyOn(healRunner, 'run')`.
 */
export const healRunner = {
  run(job: HealJob): Promise<TestRunReport> {
    return runTests(job.runner, {
      cwd: job.cwd,
      command: job.command,
      selection: job.selection,
      timeoutMs: job.timeoutMs,
      sandbox: job.sandbox,
      image: job.image,
      resultsFile: job.resultsFile,
    });
  },
};

/** Stable key for a failing test across runs. */
function testKey(f: { file: string; name: string }): string {
  return `${f.file}::${f.name}`;
}

/**
 * Classification schema for the LLM. `fixedTestCode` is only meaningful for
 * `test-bug` classifications.
 */
const ClassificationSchema = z.object({
  classification: z.enum(['test-bug', 'app-bug']),
  reason: z.string(),
  fixedTestCode: z.string().optional(),
});
type Classification = z.infer<typeof ClassificationSchema>;

const CLASSIFY_SYSTEM = [
  'You are SpecGuard, triaging a failing automated test.',
  'Decide whether the failure is a TEST bug or an APPLICATION bug:',
  '- "test-bug": the test itself is wrong — a stale assertion, drifted selector,',
  '  outdated fixture, or bad setup. The application behaviour is correct.',
  '  In this case ALSO return the full corrected test file content in `fixedTestCode`.',
  '- "app-bug": the test is correct and has caught a real defect in the application.',
  '  Do NOT return fixedTestCode; the application code must be fixed by a human.',
  'Never echo raw secret values (API keys, tokens) into your reason.',
  'When you return fixedTestCode, return the ENTIRE file, not a diff or a fragment.',
].join('\n');

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/**
 * Best-effort: load all specs across the configured apps so a failing test file
 * can be matched to its spec for richer classification context. Never throws.
 */
function loadSpecsBestEffort(config: SpecGuardConfig): Array<{ spec: ParsedSpec; profile: LanguageProfile }> {
  const specs: Array<{ spec: ParsedSpec; profile: LanguageProfile }> = [];
  for (const app of config.apps) {
    const profile = resolveProfile(app);
    try {
      for (const spec of loadAllSpecs(resolveFromRoot(config, app.specDir))) specs.push({ spec, profile });
    } catch {
      // Spec dir may not exist yet — ignore.
    }
  }
  return specs;
}

/** Strip the test and source extensions the way the language profile does. */
export function featureOfTestFile(testFile: string, profile: LanguageProfile): string {
  let base = path.basename(testFile);
  for (const re of profile.featureExtRegex) base = base.replace(re, '');
  return base.replace(/^test_/i, '').toLowerCase();
}

/** Match a test file to a spec by basename feature, best-effort. */
function findSpecForTest(
  testFile: string,
  specs: Array<{ spec: ParsedSpec; profile: LanguageProfile }>,
): ParsedSpec | undefined {
  for (const { spec, profile } of specs) {
    const base = featureOfTestFile(testFile, profile);
    if (base && path.basename(spec.specKey).toLowerCase() === base) return spec;
  }
  return undefined;
}

function appsInScope(config: SpecGuardConfig, opts: HealOpts): AppConfig[] {
  if (opts.app) return config.apps.filter((a) => a.name === opts.app);
  if (opts.spec) {
    const key = opts.spec.replace(/\.md$/, '');
    const owners = config.apps.filter((app) => {
      const prefix = `${app.name}/`;
      const specKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      try {
        return loadAllSpecs(resolveFromRoot(config, app.specDir)).some((s) => s.specKey === specKey);
      } catch {
        return false;
      }
    });
    return owners;
  }
  return config.apps;
}

/** Test files (relative to the job's cwd) that belong to a spec: name-matched or claim-tagged. */
async function selectionForSpec(config: SpecGuardConfig, app: AppConfig, specKey: string, cwd: string): Promise<string[]> {
  const profile = resolveProfile(app);
  const pool = await collectTestFiles(config, app);
  const names = new Set(profile.testFileCandidates(path.basename(specKey)));
  const chosen = new Set(pool.filter((file) => names.has(path.basename(file))));
  // Any test that carries a claim tag for this spec belongs to it, even a tag whose claim id is stale.
  const root = config.rootDir ?? process.cwd();
  for (const [ref, entries] of buildAppPrepass(config, pool).index) {
    const left = ref.slice(0, ref.lastIndexOf('#'));
    const tagged = left.includes(':') ? left.slice(left.indexOf(':') + 1) : left;
    if (tagged !== specKey) continue;
    for (const entry of entries) if (entry.origin === 'source') chosen.add(path.resolve(root, entry.file));
  }
  return [...chosen].map((abs) => path.relative(cwd, abs).split(path.sep).join('/')).sort();
}

/** Build the distinct jobs for this run. Apps that would run the same thing share one job. */
export async function buildHealJobs(config: SpecGuardConfig, opts: HealOpts): Promise<HealJob[]> {
  const root = config.rootDir ?? process.cwd();
  const sandbox = config.runners?.testRunner === 'docker' ? 'docker' : 'local';
  const jobs = new Map<string, HealJob>();
  const specKey = opts.spec
    ? (() => {
        const key = opts.spec.replace(/\.md$/, '');
        return config.apps.reduce((found, app) => (key.startsWith(`${app.name}/`) ? key.slice(app.name.length + 1) : found), key);
      })()
    : undefined;

  for (const app of appsInScope(config, opts)) {
    const profile = resolveProfile(app);
    const test = app.test ?? {};
    const runnerName = test.reporter ?? runnerForFramework(app.framework) ?? runnerForFramework(profile.testFramework);
    if (!runnerName || !isRunnerId(runnerName)) {
      throw new Error(`App '${app.name}': no test-runner adapter for reporter '${test.reporter ?? app.framework}'. Set app.test.reporter to one of vitest, jest, playwright, pytest, junit, go, cargo.`);
    }
    const command = test.command ?? config.heal?.testCommand ?? profile.testCommand;
    const cwd = test.cwd ? resolveFromRoot(config, test.cwd) : root;
    const selection = specKey ? await selectionForSpec(config, app, specKey, cwd) : [];
    const id = [runnerName, command, cwd, test.resultsFile ?? '', selection.join(',')].join('|');
    const existing = jobs.get(id);
    if (existing) {
      existing.apps.push(app);
      continue;
    }
    jobs.set(id, {
      key: app.name,
      runner: runnerName,
      command,
      cwd,
      resultsFile: test.resultsFile,
      timeoutMs: test.timeoutMs,
      image: test.image,
      sandbox,
      selection,
      profile,
      apps: [app],
    });
  }
  return [...jobs.values()];
}

function toFailing(report: TestRunReport, cwd: string): FailingTest[] {
  return report.tests
    .filter((t) => t.status === 'fail')
    .map((t) => ({
      file: t.file && !path.isAbsolute(t.file) ? path.resolve(cwd, t.file) : t.file,
      name: t.title,
      message: t.message ?? '',
    }));
}

/**
 * Run the tests, classify failures, rewrite test bugs, and re-run up to
 * `maxRetries` times. Returns a heal report.
 */
export async function runHeal(
  config: SpecGuardConfig,
  opts: HealOpts,
): Promise<PipelineResult> {
  const result = emptyResult('heal');
  const log = (line: string): void => {
    result.messages.push(line);
  };

  const maxRetries = opts.maxRetries ?? config.heal?.maxRetries ?? 2;
  const specs = loadSpecsBestEffort(config);

  let jobs: HealJob[];
  try {
    jobs = await buildHealJobs(config, opts);
  } catch (err) {
    log(`[fail] ${(err as Error).message}`);
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    return result;
  }
  if (jobs.length === 0) {
    log(opts.spec ? `[heal] no app owns spec ${opts.spec}` : '[heal] nothing to run');
    result.exitCode = opts.spec ? ExitCode.MissingSpecs : ExitCode.Success;
    return result;
  }

  let totalFixed = 0;
  let totalStillBroken = 0;
  let totalAppBugs = 0;
  let unreadable = 0;

  for (const job of jobs) {
    if (opts.spec && job.selection.length === 0) {
      log(`[heal] ${job.key}: no tests found for spec ${opts.spec}`);
      result.skipped += 1;
      continue;
    }
    log(`[heal] ${job.key}: ${job.runner} in ${path.relative(config.rootDir ?? process.cwd(), job.cwd) || '.'}`);

    /** Test keys we attempted to fix (classified test-bug + rewrote). */
    const everFixed = new Set<string>();
    /** Test keys attributed to application bugs (key -> reason). */
    const appBugs = new Map<string, string>();
    /** classify-only: test bugs found (key -> reason). */
    const testBugs = new Map<string, string>();

    let attempt = 0;
    let report = await healRunner.run(job);

    const reportUnreadable = (r: TestRunReport): boolean => {
      if (r.parsed) return false;
      log(`[warn] could not parse test output (${r.parseError ?? 'no report'}) for ${job.key}`);
      if (r.timedOut) log(`[timeout] ${job.key} exceeded ${job.timeoutMs ?? 600000}ms`);
      if (opts.lenient && r.exitCode === 0) {
        log(`[heal] ${job.key}: --lenient: runner exited 0, treating as passing`);
        return false;
      }
      return true;
    };

    if (reportUnreadable(report)) {
      unreadable += 1;
      result.failed += 1;
      result.items.push({ key: job.key, status: 'failed', message: `unreadable test output: ${report.parseError ?? 'no report'}` });
      continue;
    }
    let failures = toFailing(report, job.cwd);

    // --- run -> classify -> rewrite loop ----------------------------------
    while (true) {
      const pending = failures.filter((f) => !appBugs.has(testKey(f)) && !testBugs.has(testKey(f)));
      if (pending.length === 0) break;

      let rewroteAny = false;
      for (const f of pending) {
        const key = testKey(f);
        let classification: Classification;
        const readable = f.file ? await fileExists(f.file) : false;
        try {
          const testCode = readable ? await readFile(f.file) : '';
          const spec = findSpecForTest(f.file, specs);
          const prompt = [
            `A test is failing. Decide if it is a test bug or an application bug.`,
            `Test file: ${f.file}`,
            `Test name: ${f.name}`,
            '',
            'Failure message:',
            f.message || '(no message)',
            '',
            'Test source:',
            '--- TEST START ---',
            testCode || '(could not read test file)',
            '--- TEST END ---',
            spec
              ? ['', 'Relevant specification:', '--- SPEC START ---', `# ${spec.title}`, spec.overview, spec.acceptanceCriteria, '--- SPEC END ---'].join('\n')
              : '',
          ].join('\n');

          classification = await llmGenerateObject({
            provider: config.llm.provider,
            model: config.llm.model,
            apiKeyEnv: config.llm.apiKeyEnv,
            system: CLASSIFY_SYSTEM,
            prompt,
            schema: ClassificationSchema,
          });
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          log(`[fail] ${key} — classification error: ${message}`);
          result.items.push({ key, status: 'failed', path: f.file, message });
          continue;
        }

        if (classification.classification === 'app-bug') {
          appBugs.set(key, classification.reason);
          log(`[app-bug] ${f.name} (${f.file}) — ${classification.reason}`);
          continue;
        }

        if (opts.classifyOnly) {
          testBugs.set(key, classification.reason);
          log(`[test-bug] ${f.name} (${f.file}) — ${classification.reason} (classify-only: not rewritten)`);
          continue;
        }

        // test-bug: rewrite if we have replacement code, a real file, and retries remain.
        if (classification.fixedTestCode && readable && attempt < maxRetries) {
          await writeFile(f.file, classification.fixedTestCode);
          everFixed.add(key);
          rewroteAny = true;
          log(`[rewrite] ${f.name} (${f.file}) — ${classification.reason}`);
        } else {
          log(`[test-bug] ${f.name} (${f.file}) — no rewrite available`);
        }
      }

      if (opts.classifyOnly) break; // classification only: never rewrite, never re-run
      if (!rewroteAny) break; // no progress possible this round
      if (attempt >= maxRetries) break; // retry budget exhausted

      attempt += 1;
      report = await healRunner.run(job);
      if (reportUnreadable(report)) {
        unreadable += 1;
        failures = [];
        result.failed += 1;
        result.items.push({ key: job.key, status: 'failed', message: `unreadable test output after rewrite: ${report.parseError ?? 'no report'}` });
        break;
      }
      failures = toFailing(report, job.cwd);
    }

    // --- per-job report -----------------------------------------------------
    const finalFailingKeys = new Set(failures.map((f) => testKey(f)));
    let fixed = 0;
    for (const key of everFixed) {
      if (!finalFailingKeys.has(key)) {
        fixed += 1;
        result.items.push({ key, status: 'updated', message: 'test fixed and now passing' });
      }
    }
    let stillBroken = 0;
    for (const f of failures) {
      const key = testKey(f);
      if (appBugs.has(key)) continue;
      stillBroken += 1;
      const reason = testBugs.get(key);
      result.items.push({
        key,
        status: 'failed',
        path: f.file,
        message: reason ? `test-bug: ${reason}` : f.message || 'still failing',
      });
    }
    for (const [key, reason] of appBugs) {
      result.items.push({ key, status: 'failed', message: reason });
    }
    totalFixed += fixed;
    totalStillBroken += stillBroken;
    totalAppBugs += appBugs.size;
  }

  result.updated = totalFixed;
  result.failed += totalStillBroken + totalAppBugs;

  if (result.failed === 0 && unreadable === 0) {
    log('all tests passing');
    result.exitCode = ExitCode.Success;
  } else {
    result.exitCode = ExitCode.HealFailed;
  }

  log(`[heal] fixed: ${totalFixed} | still-broken: ${totalStillBroken} | app-bugs: ${totalAppBugs}${unreadable > 0 ? ` | unreadable: ${unreadable}` : ''}`);
  return result;
}

// Keep the adapter lookup reachable for callers that validate a reporter name up front.
export { getRunnerAdapter };
