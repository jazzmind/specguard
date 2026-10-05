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
 * Output: `.specguard/alignment.json`, rewritten after every finished spec so a
 * killed run can resume. Status lines are flushed as each spec completes.
 *
 * CLI: specguard align [--app <name>] [--spec <key>] [--all]
 *        [--concurrency <n>] [--fresh] [--extra-tests <glob>] [--json]
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
import { emitStatus } from '../core/status.js';
import { buildAppPrepass, collectTestFiles, prepassSpec } from '../core/claim-prepass.js';

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
  /** How many specs to send to the LLM at once. Defaults to 4. */
  concurrency?: number;
  /** Ignore a saved checkpoint and align every spec again. */
  fresh?: boolean;
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
  /** Claims settled by a claim tag or by the LLM, with the test that covers each. */
  coveredClaims?: Array<{ claim: string; testFile: string; testName?: string; source: 'tag' | 'llm' }>;
  /** Anchored claims no test covers. */
  uncoveredClaims?: string[];
  /** Percentage (0–100) of spec scenarios with at least one test mapping. */
  alignmentScore: number;
}

export interface AlignmentCheckpoint {
  /** True once every spec in this scope has an entry (LLM failures are absent). */
  complete: boolean;
  scope: { app: string | null; spec: string | null };
  model: string;
  updatedAt: string;
}

export interface AlignmentReport {
  generatedAt: string;
  entries: AlignmentEntry[];
  checkpoint?: AlignmentCheckpoint;
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

const CoveredClaimSchema = z.object({
  claim: z.string().describe('Claim id from the list, e.g. award-once'),
  testFile: z.string().describe('Relative path to the test file'),
  testName: z.string().describe('Name of the matching test'),
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
  coveredClaims: z.array(CoveredClaimSchema).default([]).describe(
    'Listed claims that at least one test verifies',
  ),
  uncoveredClaims: z.array(z.string()).default([]).describe(
    'Claim ids from the list that no test verifies',
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
  uncovered: { scenarios: string[]; claims: Array<{ id: string; text: string }> },
  testFiles: Array<{ relPath: string; content: string }>,
): string {
  // Only scenarios the deterministic prepass could not settle are sent.
  const wanted = new Set(uncovered.scenarios);
  const scenarioBlock = specContent.scenarios
    .filter((s) => wanted.has(s.name))
    .map((s, i) => [
      `### Scenario ${i + 1}: ${s.name}`,
      s.steps.length > 0 ? `Steps:\n${s.steps.map((step) => `  - ${step}`).join('\n')}` : '',
      s.expectedResults.length > 0
        ? `Expected Results:\n${s.expectedResults.map((r) => `  - ${r}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');

  const claimBlock = uncovered.claims.map((c) => `- ${c.id}: ${c.text}`).join('\n');

  const testBlock = testFiles
    .map((f) => `--- TEST FILE: ${f.relPath} ---\n${f.content}\n--- END: ${f.relPath} ---`)
    .join('\n\n');

  return [
    `SPEC KEY: ${specKey}`,
    `SPEC TITLE: ${specContent.title}`,
    '',
    '## SPEC SCENARIOS NOT YET MATCHED TO A TEST',
    '',
    scenarioBlock || '(none)',
    '',
    '## SPEC CLAIMS NOT YET MATCHED TO A TEST',
    '',
    claimBlock || '(none)',
    '',
    '## TEST FILES',
    '',
    testBlock || '(No test files found for this spec)',
    '',
    'Classify each listed scenario and claim as covered or uncovered by the test files above.',
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
 * Select which test files to send to the LLM for a given spec: files whose name
 * matches the spec slug and files that carry one of the spec's claim tags. Nothing
 * else is sent, so unrelated tests never pad the prompt.
 */
const MAX_TEST_FILES = 12;

function selectTestFiles(
  allTestFiles: string[],
  specKey: string,
  rootDir: string,
  taggedRel: string[],
): string[] {
  const slug = path.basename(specKey).toLowerCase();
  const dotted = slug.replace(/-/g, '.');
  const tagged = new Set(taggedRel.map((rel) => path.resolve(rootDir, rel)));
  const wanted = allTestFiles.filter((f) => {
    const base = path.basename(f).toLowerCase();
    return base.includes(slug) || base.includes(dotted) || tagged.has(f);
  });
  return wanted.slice(0, MAX_TEST_FILES);
}

const ALIGNMENT_FILE = 'alignment.json';

interface AlignScope {
  app: string | null;
  spec: string | null;
}

function alignmentPath(rootDir: string): string {
  return path.join(rootDir, '.specguard', ALIGNMENT_FILE);
}

function sameScope(a: AlignScope, b: AlignScope): boolean {
  return a.app === b.app && a.spec === b.spec;
}

function loadCachedEntries(
  rootDir: string,
  scope: AlignScope,
  model: string,
  fresh: boolean,
): { entries: AlignmentEntry[]; generatedAt?: string } {
  if (fresh) return { entries: [] };
  const file = alignmentPath(rootDir);
  if (!fs.existsSync(file)) return { entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AlignmentReport;
    const checkpoint = parsed.checkpoint;
    if (!checkpoint || checkpoint.model !== model || !sameScope(checkpoint.scope, scope)) {
      return { entries: [] };
    }
    if (!Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries, generatedAt: parsed.generatedAt };
  } catch {
    return { entries: [] };
  }
}

function writeAlignment(rootDir: string, report: AlignmentReport): void {
  const outDir = path.join(rootDir, '.specguard');
  fs.mkdirSync(outDir, { recursive: true });
  const file = alignmentPath(rootDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({
    ...report,
    entries: [...report.entries].sort((a, b) => a.specKey.localeCompare(b.specKey)),
  }, null, 2) + '\n';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function parseConcurrency(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 1) return 4;
  return Math.floor(value);
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main pipeline function
// ---------------------------------------------------------------------------

export async function runAlign(
  config: SpecGuardConfig,
  opts: AlignOpts = {},
): Promise<AlignResult> {
  const result = emptyResult('align') as AlignResult;
  const rootDir = config.rootDir ?? process.cwd();
  const scope: AlignScope = { app: opts.app ?? null, spec: opts.spec ?? null };
  const model = config.llm.model;
  const cached = loadCachedEntries(rootDir, scope, model, opts.fresh === true);
  const cachedByKey = new Map(cached.entries.map((entry) => [entry.specKey, entry]));
  result.report = {
    generatedAt: cached.generatedAt ?? new Date().toISOString(),
    entries: [],
  };

  const log = (line: string) => {
    result.messages.push(line);
    emitStatus(line);
  };
  const concurrency = parseConcurrency(opts.concurrency);

  let writeChain: Promise<void> = Promise.resolve();
  let llmFailures = 0;

  const checkpoint = (complete: boolean): void => {
    result.report.checkpoint = {
      complete,
      scope,
      model,
      updatedAt: new Date().toISOString(),
    };
    writeAlignment(rootDir, result.report);
  };

  const enqueueCheckpoint = (): Promise<void> => {
    const job = writeChain.then(() => checkpoint(false));
    writeChain = job.catch(() => undefined);
    return job;
  };

  const account = (entry: AlignmentEntry, fromCache: boolean): void => {
    const prefix = fromCache ? 'cached ' : '';
    if (entry.alignmentScore < 80 || entry.uncoveredScenarios.length > 0) {
      result.items.push({
        key: entry.specKey,
        status: entry.alignmentScore === 0 ? 'failed' : 'skipped',
        message: `${prefix}${entry.alignmentScore}% alignment — ${entry.uncoveredScenarios.length} uncovered scenario(s)`,
      });
      result.failed += 1;
    } else {
      result.items.push({ key: entry.specKey, status: 'ok', message: `${prefix}${entry.alignmentScore}% alignment` });
      result.created += 1;
    }
  };

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
    const prepass = buildAppPrepass(config, allTestFiles);
    const hasWork = (spec: (typeof specs)[number]) => spec.scenarios.length > 0 || spec.claims.some((c) => c.id);
    const withScenarios = specs.filter(hasWork);
    const pending = withScenarios.filter((spec) => !cachedByKey.has(`${app.name}/${spec.specKey}`));
    const resumed = withScenarios.length - pending.length;
    log(`[align] ${app.name}: ${allTestFiles.length} test file(s), ${specs.length} spec(s), ${resumed} cached, ${pending.length} to analyse, concurrency ${concurrency}`);

    for (const spec of specs) {
      const fullKey = `${app.name}/${spec.specKey}`;
      if (!hasWork(spec)) {
        log(`[align] ${fullKey}: no scenarios defined — skipping`);
        result.items.push({ key: fullKey, status: 'skipped', message: 'no scenarios' });
        result.skipped += 1;
        continue;
      }
      const saved = cachedByKey.get(fullKey);
      if (saved) {
        result.report.entries.push(saved);
        account(saved, true);
        log(`[align] ${fullKey}: cached ${saved.alignmentScore}% — skipped`);
      }
    }

    let finished = resumed;
    const total = specs.filter(hasWork).length;

    await mapPool(pending, concurrency, async (spec) => {
      const fullKey = `${app.name}/${spec.specKey}`;
      const settled = prepassSpec(spec, prepass);
      const selectedPaths = selectTestFiles(allTestFiles, spec.specKey, rootDir, settled.taggedFiles);

      const entryFrom = (
        llm: {
          coveredScenarios: CoveredScenario[];
          uncoveredScenarios: string[];
          unmappedTests: UnmappedTest[];
          coveredClaims: Array<{ claim: string; testFile: string; testName?: string }>;
          uncoveredClaims: string[];
        } | null,
      ): AlignmentEntry => {
        const covered: CoveredScenario[] = [
          ...settled.coveredScenarios.map((c) => ({ ...c, confidence: 'high' as const })),
          ...(llm?.coveredScenarios ?? []),
        ];
        const stillUncovered = llm ? llm.uncoveredScenarios : settled.uncoveredScenarios;
        const claimsCovered: NonNullable<AlignmentEntry['coveredClaims']> = [
          ...settled.coveredClaims.map((c) => ({
            claim: c.id,
            testFile: c.tests[0].file,
            testName: c.tests[0].title,
            source: 'tag' as const,
          })),
          ...(llm?.coveredClaims ?? []).map((c) => ({ ...c, source: 'llm' as const })),
        ];
        const coveredIds = new Set(claimsCovered.map((c) => c.claim));
        const claimIds = spec.claims.filter((c) => c.id).map((c) => c.id as string);
        const total = spec.scenarios.length > 0 ? spec.scenarios.length : claimIds.length;
        const done = spec.scenarios.length > 0 ? covered.length : coveredIds.size;
        return {
          specKey: fullKey,
          specTitle: spec.title,
          appName: app.name,
          scenarioCount: spec.scenarios.length,
          coveredScenarios: covered,
          uncoveredScenarios: stillUncovered,
          unmappedTests: llm?.unmappedTests ?? [],
          coveredClaims: claimsCovered,
          uncoveredClaims: claimIds.filter((id) => !coveredIds.has(id)),
          alignmentScore: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100,
        };
      };

      const needsLlm = settled.uncoveredScenarios.length > 0 || settled.uncoveredClaims.length > 0;
      const llmOff = config.llm.provider === 'none';
      if (!needsLlm || selectedPaths.length === 0 || llmOff) {
        const entry = entryFrom(null);
        result.report.entries.push(entry);
        account(entry, false);
        finished += 1;
        log(
          `[align] ${finished}/${total} ${fullKey}: ${!needsLlm ? 'fully settled by claim tags and titles' : llmOff ? 'deterministic only (llm.provider is none)' : 'no candidate test files'} — ${entry.alignmentScore}%`,
        );
        await enqueueCheckpoint();
        return;
      }

      const testFiles = selectedPaths.map((absPath) => ({
        relPath: path.relative(rootDir, absPath),
        content: readFileCapped(absPath),
      }));

      try {
        log(`[align] ${fullKey}: asking the LLM about ${settled.uncoveredScenarios.length} scenario(s) and ${settled.uncoveredClaims.length} claim(s) against ${testFiles.length} test file(s)…`);
        const analysis = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          system: SYSTEM_PROMPT,
          prompt: buildPrompt(
            spec.specKey,
            spec,
            { scenarios: settled.uncoveredScenarios, claims: settled.uncoveredClaims },
            testFiles,
          ),
          schema: AlignmentLlmSchema,
          maxTokens: 8192,
          temperature: 0,
        });

        const llmCovered = analysis.coveredScenarios ?? [];
        // Anything the LLM did not cover is uncovered, even if it forgot to list it.
        const coveredNames = new Set(llmCovered.map((c) => c.scenario));
        const entry = entryFrom({
          coveredScenarios: llmCovered,
          uncoveredScenarios: settled.uncoveredScenarios.filter((n) => !coveredNames.has(n)),
          unmappedTests: analysis.unmappedTests ?? [],
          coveredClaims: analysis.coveredClaims ?? [],
          uncoveredClaims: analysis.uncoveredClaims ?? [],
        });
        const score = entry.alignmentScore;
        const covered = entry.coveredScenarios;
        const unmapped = entry.unmappedTests;
        result.report.entries.push(entry);
        account(entry, false);
        finished += 1;
        const icon = score >= 80 ? '✓' : score >= 50 ? '~' : '✗';
        log(`[align] ${finished}/${total} ${icon} ${fullKey}: ${score}% (${covered.length}/${spec.scenarios.length} scenarios, ${unmapped.length} unmapped tests)`);
        await enqueueCheckpoint();
      } catch (err) {
        llmFailures += 1;
        finished += 1;
        log(`[align] ${finished}/${total} ${fullKey}: LLM error — ${(err as Error).message}`);
        result.items.push({ key: fullKey, status: 'failed', message: (err as Error).message });
        result.failed += 1;
      }
    });
  }

  await writeChain;
  try {
    checkpoint(llmFailures === 0);
    log(`[align] report written to .specguard/alignment.json${llmFailures > 0 ? ' (incomplete — re-run to retry failed specs)' : ''}`);
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
