/**
 * Deterministic claim-tag prepass shared by `matrix` and `align`.
 *
 * Spec: specs/core/claim-prepass.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildClaimTestIndex,
  scanTestTitles,
  type ClaimTestEntry,
  type ClaimTestIndex,
  type TestTitle,
} from './claim-tags.js';
import { expandGlobs } from './reader.js';
import type { ParsedSpec } from './types.js';
import type { AppConfig, SpecGuardConfig } from './types.js';

const TEST_SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt}';
const IGNORED = ['**/node_modules/**', '**/__snapshots__/**', '**/*.d.ts'];

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(config.rootDir ?? process.cwd(), p);
}

/**
 * Test files for an app: `testOutput` tree, `sources.tests`, `extraTestSources`,
 * and any extra globs (resolved from the config root). Absolute, sorted, unique.
 */
export async function collectTestFiles(
  config: SpecGuardConfig,
  app: AppConfig,
  extraTests: string[] = [],
): Promise<string[]> {
  const rootDir = config.rootDir ?? process.cwd();
  const repoDir = resolveFromRoot(config, app.repo);
  const found: string[] = [];

  const testOut = resolveFromRoot(config, app.testOutput);
  found.push(...(await expandGlobs([TEST_SOURCE_GLOB, ...IGNORED.map((g) => `!${g}`)], testOut).catch(() => [])));

  const testSrc = app.sources.tests ?? [];
  if (testSrc.length > 0) found.push(...(await expandGlobs(testSrc, repoDir).catch(() => [])));

  if (app.extraTestSources?.length) found.push(...(await expandGlobs(app.extraTestSources, rootDir).catch(() => [])));
  if (extraTests.length > 0) found.push(...(await expandGlobs(extraTests, rootDir).catch(() => [])));

  return [...new Set(found)].sort();
}

export interface AppPrepass {
  index: ClaimTestIndex;
  titles: TestTitle[];
  rootDir: string;
}

export interface ResultRow {
  file: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  claims: string[];
}

/** Scan an app's test files once; callers then ask per spec. */
export function buildAppPrepass(
  config: SpecGuardConfig,
  testFiles: string[],
  results: ResultRow[] = [],
): AppPrepass {
  const rootDir = config.rootDir ?? process.cwd();
  const index = buildClaimTestIndex({ testFiles, results, rootDir });
  const titles: TestTitle[] = [];
  for (const abs of testFiles) {
    try {
      titles.push(...scanTestTitles(readFileSync(abs, 'utf8'), path.relative(rootDir, abs).split(path.sep).join('/')));
    } catch {
      /* unreadable file: contributes nothing */
    }
  }
  return { index, titles, rootDir };
}

export interface SpecPrepass {
  coveredClaims: Array<{ id: string; text: string; tests: ClaimTestEntry[] }>;
  uncoveredClaims: Array<{ id: string; text: string }>;
  coveredScenarios: Array<{ scenario: string; testFile: string; testName: string }>;
  uncoveredScenarios: string[];
  /** Repo-relative POSIX paths of files carrying a tag for this spec. */
  taggedFiles: string[];
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The spec key a tag points at, without an optional `repo:` prefix. */
function tagSpecKey(ref: string): string {
  const left = ref.slice(0, ref.lastIndexOf('#'));
  const colon = left.indexOf(':');
  return colon === -1 ? left : left.slice(colon + 1);
}

export function prepassSpec(spec: ParsedSpec, pre: AppPrepass): SpecPrepass {
  const coveredClaims: SpecPrepass['coveredClaims'] = [];
  const uncoveredClaims: SpecPrepass['uncoveredClaims'] = [];
  const taggedFiles = new Set<string>();
  for (const claim of spec.claims) {
    if (!claim.id) continue;
    const tests: ClaimTestEntry[] = [];
    for (const [ref, entries] of pre.index) {
      if (tagSpecKey(ref) !== spec.specKey) continue;
      if (ref.slice(ref.lastIndexOf('#') + 1) !== claim.id) continue;
      tests.push(...entries);
    }
    for (const t of tests) if (t.origin === 'source') taggedFiles.add(t.file);
    if (tests.length > 0) coveredClaims.push({ id: claim.id, text: claim.text, tests });
    else uncoveredClaims.push({ id: claim.id, text: claim.text });
  }

  const coveredScenarios: SpecPrepass['coveredScenarios'] = [];
  const uncoveredScenarios: string[] = [];
  for (const scenario of spec.scenarios) {
    const needle = norm(scenario.name);
    const hit = needle ? pre.titles.find((t) => norm(t.title).includes(needle)) : undefined;
    if (hit) coveredScenarios.push({ scenario: scenario.name, testFile: hit.file, testName: hit.title });
    else uncoveredScenarios.push(scenario.name);
  }
  return { coveredClaims, uncoveredClaims, coveredScenarios, uncoveredScenarios, taggedFiles: [...taggedFiles].sort() };
}
