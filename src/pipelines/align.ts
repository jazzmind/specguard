/**
 * Align pipeline — semantic spec-to-test alignment.
 *
 * Compares each Living Specification's scenarios against the actual test files
 * for that app using an LLM. For every spec the pipeline identifies:
 *
 *   - Which scenarios are covered by which tests (with confidence)
 *   - Which scenarios have NO test coverage (gaps)
 *   - Which tests exist but don't map to any spec scenario (unmapped)
 *
 * Output: `.specguard/alignment.json`
 *
 * CLI: specguard align [--app <name>] [--spec <key>] [--all] [--extra-tests <glob>] [--json]
 */
import path from 'node:path';
import fs from 'node:fs';

import { z } from 'zod';
import type { SpecGuardConfig, AppConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import { expandGlobs } from '../core/reader.js';
import { llmGenerateObject } from '../core/llm.js';
import { resolveProfile } from '../core/language-profiles.js';
import { writePlan } from '../core/plan-writer.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface AlignOpts {
  /** Restrict to a single app by name. */
  app?: string;
  /** Restrict to a single spec key, e.g. `auth/login`. */
  spec?: string;
  /**
   * Additional glob patterns for test files outside the app's `testOutput`
   * directory (e.g. cross-repo regression tests).
   * Resolved relative to `config.rootDir`.
   */
  extraTests?: string[];
}

export interface CoveredScenario {
  /** Scenario name as it appears in the spec. */
  scenario: string;
  /** Relative path to the test file. */
  testFile: string;
  /** Name / description of the matching test case. */
  testName: string;
  /** LLM confidence in the mapping. */
  confidence?: 'high' | 'medium' | 'low';
}

export interface UnmappedTest {
  /** Relative path to the test file. */
  testFile: string;
  /** Name / description of the test case. */
  testName: string;
  /** Brief description of what the test actually covers. */
  description?: string;
}

export interface AlignmentEntry {
  specKey: string;
  specTitle: string;
  appName: string;
  scenarioCount: number;
  coveredScenarios: CoveredScenario[];
  uncoveredScenarios: string[];
  unmappedTests: UnmappedTest[];
  /** Percentage (0–100) of spec scenarios with at least one test mapping. */
  alignmentScore: number;
}

export interface AlignmentReport {
  generatedAt: string;
  entries: AlignmentEntry[];
}

export interface AlignResult extends PipelineResult {
  report: AlignmentReport;
}

// ---------------------------------------------------------------------------
// Zod schema for LLM structured output
// ---------------------------------------------------------------------------

const CoveredScenarioSchema = z.object({
  scenario: z.string().describe('Exact scenario name from the spec'),
  testFile: z.string().describe('Relative path to the test file'),
  testName: z.string().describe('Name or describe block + test name of the matching test'),
  confidence: z.enum(['high', 'medium', 'low']).default('medium').describe(
    'high = test directly exercises this scenario; medium = partial coverage; low = tangential mention',
  ),
});

const UnmappedTestSchema = z.object({
  testFile: z.string().describe('Relative path to the test file'),
  testName: z.string().describe('Test name or it() label'),
  description: z.string().optional().default('').describe('One sentence summary of what this test covers'),
});

const AlignmentLlmSchema = z.object({
  coveredScenarios: z.array(CoveredScenarioSchema).default([]).describe(
    'Spec scenarios that have at least one corresponding test',
  ),
  uncoveredScenarios: z.array(z.string()).default([]).describe(
    'Scenario names from the spec with NO test coverage',
  ),
  unmappedTests: z.array(UnmappedTestSchema).default([]).describe(
    'Tests that exist but do not correspond to any spec scenario',
  ),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are SpecGuard, a QA alignment system.',
  'Your job is to compare a Living Specification\'s scenarios against a set of',
  'test files and determine semantic coverage.',
  '',
  'Rules:',
  '- A scenario is "covered" if a test exercises the described behaviour,',
  '  even if the test name differs from the scenario name.',
  '- Use "high" confidence when a test clearly targets the scenario end-to-end.',
  '- Use "medium" confidence when a test partially covers the scenario or covers',
  '  it as a side-effect of another primary test goal.',
  '- Use "low" confidence when a test mentions related concepts but does not',
  '  directly verify the scenario\'s expected results.',
  '- A test is "unmapped" if it covers behaviour NOT described in any scenario.',
  '  These may represent undocumented features or obsolete tests.',
  '- Output ONLY the JSON object matching the schema — no prose.',
].join('\n');

function buildPrompt(
  specKey: string,
  specContent: { title: string; scenarios: Array<{ name: string; steps: string[]; expectedResults: string[] }> },
  testFiles: Array<{ relPath: string; content: string }>,
): string {
  const scenarioBlock = specContent.scenarios
    .map((s, i) => [
      `### Scenario ${i + 1}: ${s.name}`,
      s.steps.length > 0 ? `Steps:\n${s.steps.map((step) => `  - ${step}`).join('\n')}` : '',
      s.expectedResults.length > 0
        ? `Expected Results:\n${s.expectedResults.map((r) => `  - ${r}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');

  const testBlock = testFiles
    .map((f) => `--- TEST FILE: ${f.relPath} ---\n${f.content}\n--- END: ${f.relPath} ---`)
    .join('\n\n');

  return [
    `SPEC KEY: ${specKey}`,
    `SPEC TITLE: ${specContent.title}`,
    '',
    '## SPEC SCENARIOS',
    '',
    scenarioBlock || '(No scenarios defined in this spec)',
    '',
    '## TEST FILES',
    '',
    testBlock || '(No test files found for this spec)',
    '',
    'Analyse the test files above and classify each scenario as covered or uncovered.',
    'Also identify any tests that are not mapped to any scenario.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/**
 * Collect test files for an app from its `testOutput` directory,
 * the `tests` source group, any `extraTestSources` in config,
 * and any extra globs passed at the CLI.
 */
async function collectTestFiles(
  config: SpecGuardConfig,
  app: AppConfig,
  extraTests: string[],
): Promise<string[]> {
  const rootDir = config.rootDir ?? process.cwd();
  const repoDir = resolveFromRoot(config, app.repo);
  const found: string[] = [];

  // testOutput directory
  const testOutDir = resolveFromRoot(config, app.testOutput);
  const profile = resolveProfile(app);
  const testGlob = `${testOutDir}/**/*${profile.testExt}`;
  const fromTestOut = await expandGlobs([testGlob], path.dirname(testOutDir)).catch(() => []);
  found.push(...fromTestOut);

  // sources.tests group
  const testSrcGlobs = app.sources.tests ?? [];
  if (testSrcGlobs.length > 0) {
    const fromSrc = await expandGlobs(testSrcGlobs, repoDir).catch(() => []);
    found.push(...fromSrc);
  }

  // extraTestSources from config (if the field exists via passthrough)
  const configExtra = (app as unknown as Record<string, unknown>)['extraTestSources'];
  if (Array.isArray(configExtra) && configExtra.length > 0) {
    const fromConfigExtra = await expandGlobs(
      configExtra as string[],
      rootDir,
    ).catch(() => []);
    found.push(...fromConfigExtra);
  }

  // Extra globs from CLI --extra-tests
  if (extraTests.length > 0) {
    const fromCliExtra = await expandGlobs(extraTests, rootDir).catch(() => []);
    found.push(...fromCliExtra);
  }

  return [...new Set(found)].sort();
}

/** Read a file, cap at maxChars. */
function readFileCapped(absPath: string, maxChars = 8_000): string {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    return raw.length > maxChars
      ? raw.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`
      : raw;
  } catch {
    return `(could not read ${absPath})`;
  }
}

/**
 * Select which test files to send to the LLM for a given spec.
 *
 * Strategy:
 *  1. Always include slug-matched files (naming convention).
 *  2. Fill up to MAX_TEST_FILES total from the full pool.
 */
const MAX_TEST_FILES = 12;

function selectTestFiles(
  allTestFiles: string[],
  specKey: string,
  rootDir: string,
): string[] {
  const slug = path.basename(specKey);
  // Slug-matched files first (by filename substring)
  const slugMatched = allTestFiles.filter((f) =>
    path.basename(f).toLowerCase().includes(slug.toLowerCase()) ||
    path.basename(f).toLowerCase().includes(slug.replace(/-/g, '.').toLowerCase()),
  );
  // Fill with remaining files up to MAX
  const remaining = allTestFiles.filter((f) => !slugMatched.includes(f));
  const selected = [...slugMatched, ...remaining].slice(0, MAX_TEST_FILES);
  return selected;
}

// ---------------------------------------------------------------------------
// Main pipeline function
// ---------------------------------------------------------------------------

export async function runAlign(
  config: SpecGuardConfig,
  opts: AlignOpts = {},
): Promise<AlignResult> {
  const result = emptyResult('align') as AlignResult;
  result.report = { generatedAt: new Date().toISOString(), entries: [] };

  const log = (line: string) => { result.messages.push(line); };
  const rootDir = config.rootDir ?? process.cwd();

  const appsInScope = opts.app
    ? config.apps.filter((a) => a.name === opts.app)
    : config.apps;

  for (const app of appsInScope) {
    const specDirAbs = resolveFromRoot(config, app.specDir);

    // Load specs
    let specs;
    try {
      specs = loadAllSpecs(specDirAbs);
    } catch {
      log(`[warn] Could not load specs from ${specDirAbs}`);
      continue;
    }

    if (specs.length === 0) {
      log(`[align] ${app.name}: no specs found in ${specDirAbs}`);
      continue;
    }

    // Filter to single spec if requested.
    // Accepted formats for --spec:
    //   "auth/login"           → filterKey = "auth/login"
    //   "login-app/auth/login" → filterKey = "auth/login" (strip app name prefix)
    if (opts.spec) {
      const appPrefix = `${app.name}/`;
      const filterKey = opts.spec.startsWith(appPrefix)
        ? opts.spec.slice(appPrefix.length)
        : opts.spec;
      specs = specs.filter((s) => s.specKey === filterKey || `${app.name}/${s.specKey}` === opts.spec);
    }

    // Collect all test files for this app
    const allTestFiles = await collectTestFiles(config, app, opts.extraTests ?? []);
    log(`[align] ${app.name}: ${allTestFiles.length} test file(s) found`);

    for (const spec of specs) {
      const fullKey = `${app.name}/${spec.specKey}`;

      // Skip specs with no scenarios — there's nothing to align
      if (spec.scenarios.length === 0) {
        log(`[align] ${fullKey}: no scenarios defined — skipping`);
        result.items.push({ key: fullKey, status: 'skipped', message: 'no scenarios' });
        result.skipped += 1;
        continue;
      }

      // Select the test files most likely relevant to this spec
      const selectedPaths = selectTestFiles(allTestFiles, spec.specKey, rootDir);

      if (selectedPaths.length === 0) {
        log(`[align] ${fullKey}: no test files found`);
        const entry: AlignmentEntry = {
          specKey: fullKey,
          specTitle: spec.title,
          appName: app.name,
          scenarioCount: spec.scenarios.length,
          coveredScenarios: [],
          uncoveredScenarios: spec.scenarios.map((s) => s.name),
          unmappedTests: [],
          alignmentScore: 0,
        };
        result.report.entries.push(entry);
        result.items.push({ key: fullKey, status: 'failed', message: 'no test files — 0% alignment' });
        result.failed += 1;
        continue;
      }

      // Build test file content array
      const testFiles = selectedPaths.map((absPath) => ({
        relPath: path.relative(rootDir, absPath),
        content: readFileCapped(absPath),
      }));

      // Call LLM
      try {
        log(`[align] ${fullKey}: analysing ${spec.scenarios.length} scenario(s) against ${testFiles.length} test file(s)…`);

        const prompt = buildPrompt(spec.specKey, spec, testFiles);

        const analysis = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          system: SYSTEM_PROMPT,
          prompt,
          schema: AlignmentLlmSchema,
          maxTokens: 8192,
          temperature: 0,
        });

        const covered = analysis.coveredScenarios ?? [];
        const uncovered = analysis.uncoveredScenarios ?? [];
        const unmapped = analysis.unmappedTests ?? [];

        // Compute alignment score = covered scenarios / total scenarios * 100
        const score = spec.scenarios.length > 0
          ? Math.round((covered.length / spec.scenarios.length) * 100)
          : 100;

        const entry: AlignmentEntry = {
          specKey: fullKey,
          specTitle: spec.title,
          appName: app.name,
          scenarioCount: spec.scenarios.length,
          coveredScenarios: covered,
          uncoveredScenarios: uncovered,
          unmappedTests: unmapped,
          alignmentScore: score,
        };
        result.report.entries.push(entry);

        const icon = score >= 80 ? '✓' : score >= 50 ? '~' : '✗';
        log(`[align] ${icon} ${fullKey}: ${score}% aligned (${covered.length}/${spec.scenarios.length} scenarios covered, ${unmapped.length} unmapped tests)`);

        if (score < 80 || uncovered.length > 0) {
          result.items.push({
            key: fullKey,
            status: score === 0 ? 'failed' : 'skipped',
            message: `${score}% alignment — ${uncovered.length} uncovered scenario(s)`,
          });
          result.failed += 1;
        } else {
          result.items.push({ key: fullKey, status: 'ok', message: `${score}% alignment` });
          result.created += 1;
        }
      } catch (err) {
        log(`[align] ${fullKey}: LLM error — ${(err as Error).message}`);
        result.items.push({ key: fullKey, status: 'failed', message: (err as Error).message });
        result.failed += 1;
      }
    }
  }

  // Persist report
  try {
    const outDir = path.join(rootDir, '.specguard');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'alignment.json'),
      JSON.stringify(result.report, null, 2) + '\n',
    );
    log(`[align] report written to .specguard/alignment.json`);
  } catch { /* best-effort */ }

  // Summary log
  const total = result.report.entries.length;
  if (total === 0) {
    log('[align] no specs with scenarios found');
  } else {
    const avgScore = total > 0
      ? Math.round(result.report.entries.reduce((s, e) => s + e.alignmentScore, 0) / total)
      : 0;
    const low = result.report.entries.filter((e) => e.alignmentScore < 50);
    const med = result.report.entries.filter((e) => e.alignmentScore >= 50 && e.alignmentScore < 80);
    const high = result.report.entries.filter((e) => e.alignmentScore >= 80);
    log(`[align] ${total} spec(s) analysed — avg score: ${avgScore}% (${high.length} high, ${med.length} medium, ${low.length} low)`);
  }

  // Write a plan for specs with low alignment
  const lowAlignment = result.report.entries.filter((e) => e.alignmentScore < 80 && e.uncoveredScenarios.length > 0);
  if (lowAlignment.length > 0) {
    try {
      writePlan({
        pipeline: 'align',
        title: `Test Coverage Gaps — ${lowAlignment.length} spec(s) under 80% alignment`,
        summary: `The alignment pipeline found ${lowAlignment.length} spec(s) where test coverage ` +
          `does not semantically match the documented scenarios. Review and either write new tests or ` +
          `correct the specs.`,
        sections: [
          {
            heading: 'Specs Needing Tests',
            items: lowAlignment.map((e) =>
              `\`${e.specKey}\` (${e.alignmentScore}%) — uncovered: ${e.uncoveredScenarios.slice(0, 3).join(', ')}${e.uncoveredScenarios.length > 3 ? '…' : ''}`,
            ),
          },
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'Review .specguard/alignment.json for full per-scenario detail.',
              'For each uncovered scenario: write a Playwright test (or run `specguard generate --spec <key>`).',
              'If a scenario describes unintended behaviour, edit the spec file.',
              'Re-run `specguard align` to verify alignment improved.',
              'Run `specguard matrix` to update the traceability report.',
            ],
          },
        ],
        rootDir,
      });
    } catch { /* best-effort */ }
  }

  result.exitCode = result.failed > 0 ? ExitCode.MissingSpecs : ExitCode.Success;
  return result;
}
