/**
 * Test selection: package -> importing files -> specs (inverted drift registry) -> claim-tagged
 * tests. Selected tests run FIRST for fast failure; the full suite always runs afterwards.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Candidate } from '../../core/advisory.js';
import { testId } from '../../core/behavior-verdict.js';
import { parseClaimRef } from '../../core/claims.js';
import { loadRegistry, type DriftRegistry } from '../../core/drift-registry.js';
import type { TestCaseResult } from '../../core/test-results.js';
import { glob } from 'tinyglobby';
import { getRunnerAdapter, type RunnerId } from '../../adapters/test-runners.js';
import type { TestJob } from './steps.js';

const SOURCE_GLOBS = ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte}', '**/*.py', '**/*.go', '**/*.rs', '**/*.{java,kt,groovy}'];
const IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.venv/**', '**/venv/**', '**/target/**', '**/.specguard/**', '**/vendor/**'];

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A regex that matches an import of `pkg` in the source of its ecosystem. */
export function importPattern(c: Pick<Candidate, 'ecosystem' | 'package'>): RegExp {
  const pkg = c.package;
  switch (c.ecosystem.toLowerCase()) {
    case 'npm':
      return new RegExp(`(?:from\\s*|require\\s*\\(\\s*|import\\s*\\(\\s*|import\\s+)['"]${esc(pkg)}(?:/[^'"]*)?['"]`);
    case 'pypi': {
      const mod = esc(pkg.toLowerCase().replace(/[-.]/g, '_')).replace(/_/g, '[-_.]');
      return new RegExp(`^\\s*(?:from|import)\\s+${mod}(?:\\.|\\s|$)`, 'im');
    }
    case 'go':
      return new RegExp(`["\`]${esc(pkg)}(?:/[^"\`]*)?["\`]`);
    case 'crates.io':
      return new RegExp(`\\b(?:use|extern\\s+crate)\\s+${esc(pkg.replace(/-/g, '_'))}\\b`);
    default: {
      // Maven/Gradle: group:artifact -> imports under the group id.
      const group = pkg.split(':')[0];
      return new RegExp(`^\\s*import\\s+(?:static\\s+)?${esc(group)}\\.`, 'm');
    }
  }
}

/** Source files (repo-relative to `root`) under `projectDir` that import the candidate's package. */
export async function importingFiles(root: string, projectDir: string, c: Pick<Candidate, 'ecosystem' | 'package'>): Promise<string[]> {
  const pattern = importPattern(c);
  const files = await glob(SOURCE_GLOBS, { cwd: projectDir, absolute: true, ignore: IGNORE, onlyFiles: true }).catch(() => [] as string[]);
  const hits: string[] = [];
  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (pattern.test(text)) hits.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return hits.sort();
}

/** Spec keys whose drift-registry file lists include any of `files`. */
export function specsForFiles(registry: DriftRegistry, files: string[]): Set<string> {
  const set = new Set(files.map((f) => f.replace(/\\/g, '/')));
  const out = new Set<string>();
  for (const entry of Object.values(registry)) {
    for (const key of Object.keys(entry.files)) {
      const norm = key.replace(/\\/g, '/');
      if (set.has(norm) || [...set].some((f) => norm.endsWith(`/${f}`))) {
        out.add(entry.specKey);
        break;
      }
    }
  }
  return out;
}

export interface Selection {
  /** Selected test ids. */
  ids: string[];
  /** Test files to run first (repo-relative). */
  files: string[];
  claimTagged: number;
  importing: number;
  importingFiles: string[];
  specKeys: string[];
}

/** Choose tests from a full (baseline) run: claim-tagged tests of affected specs + tests in importing files. */
export function selectTests(tests: TestCaseResult[], imports: string[], specKeys: Set<string>): Selection {
  const importSet = new Set(imports);
  const ids = new Set<string>();
  const files = new Set<string>();
  let claimTagged = 0;
  let importing = 0;
  for (const t of tests) {
    const tagged = t.claims.some((c) => {
      const ref = parseClaimRef(c);
      return ref ? specKeys.has(ref.specKey) : false;
    });
    const imp = importSet.has(t.file);
    if (tagged) claimTagged += 1;
    if (imp) importing += 1;
    if (tagged || imp) {
      ids.add(testId(t));
      files.add(t.file);
    }
  }
  return { ids: [...ids].sort(), files: [...files].sort(), claimTagged, importing, importingFiles: imports, specKeys: [...specKeys].sort() };
}

/** Per-job selection (paths relative to the job's cwd). Jobs whose runner cannot take a selection are omitted. */
export function selectionByJob(jobs: TestJob[], root: string, files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const job of jobs) {
    const adapter = getRunnerAdapter(job.runner as RunnerId);
    if (adapter.selectionFlags(['probe']) === '') continue;
    const prefix = path.relative(root, job.cwd).split(path.sep).join('/');
    const mine = files
      .filter((f) => !prefix || f.startsWith(`${prefix}/`))
      .map((f) => (prefix ? f.slice(prefix.length + 1) : f));
    const list = job.runner === 'go' ? [...new Set(mine.map((f) => `./${path.posix.dirname(f)}`))] : mine;
    if (list.length) out.set(job.key, list);
  }
  return out;
}

export function loadRegistryAt(...roots: string[]): DriftRegistry {
  for (const r of roots) {
    const reg = loadRegistry(r);
    if (Object.keys(reg).length) return reg;
  }
  return {};
}
