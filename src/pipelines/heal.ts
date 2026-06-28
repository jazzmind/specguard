/**
 * Self-Healing Test pipeline.
 *
 * Runs the project's test suite, and for each failing test asks the LLM to
 * attribute the failure to either the test (stale assertion / drifted selector)
 * or the application (a real bug the test correctly caught). Test bugs are
 * rewritten and the suite re-run, up to `maxRetries` times. Application bugs are
 * reported and application source is NEVER modified.
 *
 * Spec: specs/pipelines/heal.md
 *
 * Runner seam
 * -----------
 * The raw test-runner invocation lives behind the exported `healRunner` object.
 * Under ESM, spying on a bare function export does not intercept calls made from
 * inside this module — so all internal calls go through `healRunner.runTests`,
 * which tests replace with `vi.spyOn(healRunner, 'runTests')`.
 *
 * Exit code
 * ---------
 * Per spec, an app-bug means the test correctly caught a real defect: the suite
 * is still red, so the pipeline still exits with `HealFailed` (7). Exit 0 is
 * reserved for a suite that ends fully green.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import type { SpecGuardConfig, PipelineResult, ParsedSpec } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { readFile, fileExists } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import { llmGenerateObject } from '../core/llm.js';
import { z } from 'zod';

export interface HealOpts {
  /** Reserved: target a single spec's tests (best-effort; not required). */
  spec?: string;
  /** Reserved: heal across all apps (default behaviour already spans the run). */
  all?: boolean;
  /** Override the retry budget from config. */
  maxRetries?: number;
}

/** Result of one raw test-runner invocation. */
export interface TestRunResult {
  stdout: string;
  exitCode: number;
}

/**
 * Test-runner seam. Implemented with `spawnSync` so a non-zero exit (failing
 * tests) is captured rather than thrown. Tests stub this via `vi.spyOn`.
 */
export const healRunner = {
  runTests(cmd: string, cwd: string): TestRunResult {
    const res = spawnSync(cmd, {
      cwd,
      shell: true,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      stdout: (res.stdout ?? '') + (res.stderr ?? ''),
      exitCode: res.status ?? 1,
    };
  },
};

/** A single failing test extracted from the runner JSON. */
interface FailingTest {
  file: string;
  name: string;
  message: string;
}

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

/**
 * Extract the first balanced top-level `{...}` JSON object from arbitrary
 * stdout (which may carry non-JSON noise before/after the document).
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse vitest's Jest-compatible JSON reporter output into the list of failing
 * tests. Returns `null` when no JSON object can be located/parsed (malformed or
 * empty output) so the caller can report gracefully instead of crashing.
 */
export function parseVitestJson(stdout: string): FailingTest[] | null {
  const json = extractJsonObject(stdout);
  if (!json) return null;

  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const testResults = (doc as { testResults?: unknown }).testResults;
  if (!Array.isArray(testResults)) {
    // A valid JSON document with no testResults array: treat as zero failures.
    return [];
  }

  const failures: FailingTest[] = [];
  for (const tr of testResults) {
    if (!tr || typeof tr !== 'object') continue;
    const file = String((tr as { name?: unknown }).name ?? '');
    const assertions = (tr as { assertionResults?: unknown }).assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const a of assertions) {
      if (!a || typeof a !== 'object') continue;
      if ((a as { status?: unknown }).status !== 'failed') continue;
      const ar = a as { title?: unknown; fullName?: unknown; failureMessages?: unknown };
      const name = String(ar.title ?? ar.fullName ?? '(unnamed test)');
      const msgs = Array.isArray(ar.failureMessages)
        ? ar.failureMessages.map((m) => String(m)).join('\n')
        : '';
      failures.push({ file, name, message: msgs });
    }
  }
  return failures;
}

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/**
 * Best-effort: load all specs across the configured apps so a failing test file
 * can be matched to its spec for richer classification context. Never throws.
 */
function loadSpecsBestEffort(config: SpecGuardConfig): ParsedSpec[] {
  const specs: ParsedSpec[] = [];
  for (const app of config.apps) {
    try {
      specs.push(...loadAllSpecs(resolveFromRoot(config, app.specDir)));
    } catch {
      // Spec dir may not exist yet — ignore.
    }
  }
  return specs;
}

/** Match a test file to a spec by basename feature, best-effort. */
function findSpecForTest(testFile: string, specs: ParsedSpec[]): ParsedSpec | undefined {
  const base = path
    .basename(testFile)
    .replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '')
    .replace(/\.[cm]?[jt]sx?$/i, '')
    .toLowerCase();
  if (!base) return undefined;
  return specs.find((s) => path.basename(s.specKey).toLowerCase() === base);
}

/**
 * Run the test suite, classify failures, rewrite test bugs, and re-run up to
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
  const testCommand = config.heal?.testCommand ?? 'npm test';
  const cwd = config.rootDir ?? process.cwd();
  // Append vitest's JSON reporter so output is machine-readable.
  const fullCmd = `${testCommand} -- --reporter=json`;

  const specs = loadSpecsBestEffort(config);

  /** Test keys we attempted to fix (classified test-bug + rewrote). */
  const everFixed = new Set<string>();
  /** Test keys attributed to application bugs (key -> reason). */
  const appBugs = new Map<string, string>();

  let attempt = 0;
  let run = healRunner.runTests(fullCmd, cwd);
  let failures = parseVitestJson(run.stdout);

  // --- run -> classify -> rewrite loop ------------------------------------
  while (true) {
    if (failures === null) {
      // Could not parse runner output. If the runner also exited zero we have
      // no evidence of failure; otherwise the suite is not known-green.
      log('[warn] could not parse test output (malformed or empty JSON)');
      if (run.exitCode === 0) {
        log('all tests passing');
        result.exitCode = ExitCode.Success;
      } else {
        result.exitCode = ExitCode.HealFailed;
      }
      return finalizeNoCounts(result);
    }

    // Failures still needing a decision this round (skip known app-bugs).
    const pending = failures.filter((f) => !appBugs.has(testKey(f)));

    if (pending.length === 0) {
      // Either fully green, or only previously-recorded app-bugs remain.
      break;
    }

    let rewroteAny = false;
    for (const f of pending) {
      const key = testKey(f);
      let classification: Classification;
      try {
        const testCode = (await fileExists(f.file)) ? await readFile(f.file) : '';
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

      // test-bug: rewrite if we have replacement code and retries remain.
      if (classification.fixedTestCode && attempt < maxRetries) {
        await writeFile(f.file, classification.fixedTestCode);
        everFixed.add(key);
        rewroteAny = true;
        log(`[rewrite] ${f.name} (${f.file}) — ${classification.reason}`);
      } else {
        // No usable rewrite (model returned none) — nothing more we can do.
        log(`[test-bug] ${f.name} (${f.file}) — no rewrite available`);
      }
    }

    if (!rewroteAny) break; // no progress possible this round
    if (attempt >= maxRetries) break; // retry budget exhausted

    attempt += 1;
    run = healRunner.runTests(fullCmd, cwd);
    failures = parseVitestJson(run.stdout);
  }

  // --- build heal report ---------------------------------------------------
  const finalFailures = failures ?? [];
  const finalFailingKeys = new Set(finalFailures.map((f) => testKey(f)));

  let fixed = 0;
  for (const key of everFixed) {
    if (!finalFailingKeys.has(key)) fixed += 1;
  }

  // Record outcome items for tests that were rewritten and now pass.
  for (const key of everFixed) {
    if (!finalFailingKeys.has(key)) {
      result.items.push({ key, status: 'updated', message: 'test fixed and now passing' });
    }
  }

  const appBugCount = appBugs.size;
  let stillBroken = 0;
  for (const f of finalFailures) {
    const key = testKey(f);
    if (appBugs.has(key)) {
      // Already logged + item recorded below.
      continue;
    }
    stillBroken += 1;
    result.items.push({ key, status: 'failed', path: f.file, message: f.message || 'still failing' });
  }
  for (const [key, reason] of appBugs) {
    result.items.push({ key, status: 'failed', message: reason });
  }

  result.updated = fixed;
  result.failed = stillBroken + appBugCount;

  if (finalFailures.length === 0 && appBugCount === 0) {
    log('all tests passing');
    result.exitCode = ExitCode.Success;
  } else {
    result.exitCode = ExitCode.HealFailed;
  }

  log(`[heal] fixed: ${fixed} | still-broken: ${stillBroken} | app-bugs: ${appBugCount}`);
  return result;
}

/** Finalize a result that never produced failure counts (parse-failure path). */
function finalizeNoCounts(result: PipelineResult): PipelineResult {
  result.messages.push('[heal] fixed: 0 | still-broken: 0 | app-bugs: 0');
  return result;
}
