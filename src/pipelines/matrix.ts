/**
 * Matrix pipeline — traceability.
 *
 * Cross-references specs with test files, doc files, and source modules.
 * Output: .specguard/traceability.json (default) or CSV.
 *
 * Spec: specs/pipelines/matrix.md
 */
import path from 'node:path';

import type { SpecGuardConfig, AppConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import { expandGlobs, fileExists } from '../core/reader.js';
import { writeFile } from '../core/writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatrixOpts {
  /** Restrict to a single app by name. */
  app?: string;
  /** Output format: 'json' (default) or 'csv'. */
  format?: 'json' | 'csv';
  /** Override the output file path. */
  out?: string;
}

export interface MatrixEntry {
  specKey: string;
  title: string;
  appName: string;
  /** Matched test file paths. */
  tests: string[];
  /** Matched doc file paths. */
  docs: string[];
  /** Source module declared in spec metadata (if any). */
  sourceModule: string | null;
}

export interface TraceabilityMatrix {
  generatedAt: string;
  entries: MatrixEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function slugFromKey(specKey: string): string {
  return path.basename(specKey);
}

/** Find test files matching a spec key by basename convention. */
async function findMatchingTests(
  config: SpecGuardConfig,
  app: AppConfig,
  specKey: string,
): Promise<string[]> {
  const slug = slugFromKey(specKey);
  const testBase = resolveFromRoot(config, app.testOutput);
  const patterns = [
    `${testBase}/**/${slug}.test.ts`,
    `${testBase}/**/${slug}.spec.ts`,
    `${testBase}/**/${slug}.test.js`,
  ];
  const found: string[] = [];
  for (const pat of patterns) {
    const matches = await expandGlobs([pat], path.dirname(pat)).catch(() => []);
    found.push(...matches);
  }
  // Also check security tests.
  const securityPat = resolveFromRoot(config, `tests/security/${slug}.test.ts`);
  if (await fileExists(securityPat)) found.push(securityPat);
  return [...new Set(found)];
}

/** Find doc files matching a spec key by basename convention. */
async function findMatchingDocs(
  config: SpecGuardConfig,
  app: AppConfig,
  specKey: string,
): Promise<string[]> {
  const slug = slugFromKey(specKey);
  const docsDir =
    typeof app.docs === 'string'
      ? resolveFromRoot(config, app.docs)
      : resolveFromRoot(config, 'docs/user');

  const patterns = [`${docsDir}/**/${slug}.md`, `${docsDir}/**/${slug}.mdx`];
  const found: string[] = [];
  for (const pat of patterns) {
    const matches = await expandGlobs([pat], path.dirname(pat)).catch(() => []);
    found.push(...matches);
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// CSV formatting
// ---------------------------------------------------------------------------

function toCsv(entries: MatrixEntry[]): string {
  const header = 'specKey,title,appName,testCount,docCount,sourceModule';
  const rows = entries.map((e) =>
    [
      e.specKey,
      `"${e.title.replace(/"/g, '""')}"`,
      e.appName,
      e.tests.length,
      e.docs.length,
      e.sourceModule ?? '',
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runMatrix(
  config: SpecGuardConfig,
  opts: MatrixOpts,
): Promise<PipelineResult> {
  const result = emptyResult('matrix');
  const log = (line: string) => result.messages.push(line);

  const appsInScope = opts.app
    ? config.apps.filter((a) => a.name === opts.app)
    : config.apps;

  if (opts.app && appsInScope.length === 0) {
    throw new SpecGuardError(
      `Unknown app: ${opts.app}. Known: ${config.apps.map((a) => a.name).join(', ')}`,
      ExitCode.InternalError,
    );
  }

  const entries: MatrixEntry[] = [];

  for (const app of appsInScope) {
    const specDirAbs = resolveFromRoot(config, app.specDir);
    let specs;
    try {
      specs = loadAllSpecs(specDirAbs);
    } catch {
      log(`[warn] Could not load specs from ${specDirAbs}`);
      continue;
    }

    for (const spec of specs) {
      const tests = await findMatchingTests(config, app, spec.specKey);
      const docs = await findMatchingDocs(config, app, spec.specKey);
      const entry: MatrixEntry = {
        specKey: spec.specKey,
        title: spec.title,
        appName: app.name,
        tests,
        docs,
        sourceModule: spec.meta.module ?? null,
      };
      entries.push(entry);
      log(
        `[matrix] ${spec.specKey} — tests:${tests.length} docs:${docs.length}${spec.meta.module ? ` src:${spec.meta.module}` : ''}`,
      );
    }
  }

  // Write output.
  const format = opts.format ?? config.matrix?.format ?? 'json';
  const defaultOut =
    format === 'csv'
      ? resolveFromRoot(config, '.specguard/traceability.csv')
      : resolveFromRoot(config, config.matrix?.output ?? '.specguard/traceability.json');
  const outPath = opts.out ? resolveFromRoot(config, opts.out) : defaultOut;

  const matrix: TraceabilityMatrix = {
    generatedAt: new Date().toISOString(),
    entries,
  };

  const content = format === 'csv' ? toCsv(entries) : JSON.stringify(matrix, null, 2) + '\n';
  await writeFile(outPath, content);
  log(`[matrix] written to ${outPath} (${entries.length} entries, format=${format})`);

  result.created = entries.length;
  result.exitCode = ExitCode.Success;

  // Write a plan if any specs are missing tests or docs.
  const noTest = entries.filter((e) => e.tests.length === 0);
  const noDoc = entries.filter((e) => e.docs.length === 0);
  if (noTest.length > 0 || noDoc.length > 0) {
    try {
      const { writePlan } = await import('../core/plan-writer.js');
      writePlan({
        pipeline: 'matrix',
        title: `Fill Traceability Gaps — ${noTest.length} spec(s) lack tests, ${noDoc.length} lack docs`,
        summary: `The matrix pipeline found ${noTest.length} spec(s) with no generated tests and ` +
          `${noDoc.length} spec(s) with no documentation. Run \`generate\` and \`docs\` to close the gaps.`,
        sections: [
          {
            heading: 'Specs Without Tests',
            items: noTest.slice(0, 20).map((e) => `\`${e.appName}/${e.specKey}\` — ${e.title}`),
          },
          {
            heading: 'Specs Without Docs',
            items: noDoc.slice(0, 20).map((e) => `\`${e.appName}/${e.specKey}\` — ${e.title}`),
          },
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'Run `specguard generate --all` to generate tests for untested specs.',
              'Run `specguard docs --all` to generate documentation for undocumented specs.',
              'Run `specguard matrix` again to verify full coverage.',
            ],
          },
        ],
        rootDir: config.rootDir ?? process.cwd(),
      });
    } catch { /* best-effort */ }
  }

  return result;
}
