/**
 * `specguard coverage ingest`: normalize coverage reports (lcov, JaCoCo, Cobertura,
 * Go coverprofile) into per-file evidence under `.specguard/coverage/`.
 *
 * The evidence is a gitignored cache: one file per scope (the whole suite, or one
 * capability's tests), the latest ingest replacing the last. Each file records the
 * content hash of the source at ingest, which is what makes it stale later.
 *
 * Spec: specs/capabilities/coverage-and-mutation.md
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildClaimTestIndex } from '../core/claim-tags.js';
import { parseClaimRef } from '../core/claims.js';
import { loadConfig } from '../core/config.js';
import {
  CoverageParseError,
  enforceSizeCap,
  mappedCoverageFiles,
  normalizeCoverage,
  parseCoverage,
  selectCapabilityTests,
  type CapabilitySelection,
  type CoverageEvidence,
  type CoverageFormat,
  type CoverageScope,
  type EvidenceOrigin,
  type PathContext,
  type RawCoverage,
} from '../core/coverage.js';
import { hashFile } from '../core/drift-registry.js';
import { ExitCode } from '../core/exit-codes.js';
import { expandGlobs, fileExists, readFile } from '../core/reader.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import { emptyResult, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';

export const COVERAGE_DIR = '.specguard/coverage';

export interface CoverageIngestOpts {
  format?: CoverageFormat | 'auto';
  /** Store the evidence for one capability's tests instead of the whole suite. */
  capability?: string;
  /** What ran: the capability's tagged tests, or the test files that hold them. Default `tests`. */
  selection?: 'tests' | 'files';
  runId?: string;
  origin?: EvidenceOrigin;
}

export function coverageEvidencePath(root: string, capability?: string): string {
  return path.join(root, COVERAGE_DIR, capability ? path.join('cap', `${capability}.json`) : 'suite.json');
}

function relPosix(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join('/');
}

export async function expandInputs(cwd: string, inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    if (/[*?{}[\]]/.test(input)) files.push(...(await expandGlobs([input], cwd)));
    else files.push(path.resolve(cwd, input));
  }
  return [...new Set(files)];
}

export function gitHead(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Tracked and untracked-but-not-ignored files of the repo, root-relative POSIX. */
export async function listRepoFiles(root: string): Promise<Set<string>> {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
    const files = out.split('\0').filter(Boolean);
    if (files.length > 0) return new Set(files);
  } catch {
    /* not a git checkout: walk the tree */
  }
  return new Set((await expandGlobs(['**/*'], root)).map((abs) => relPosix(root, abs)));
}

async function optionalConfig(cwd: string): Promise<SpecGuardConfig | undefined> {
  try {
    return await loadConfig(cwd);
  } catch {
    return undefined;
  }
}

/** The path-mapping context of a repo: its files, configured prefixes and source roots, and Go modules. */
export async function buildPathContext(root: string, config?: SpecGuardConfig): Promise<PathContext> {
  const repoFiles = await listRepoFiles(root);
  const goModules: Array<{ module: string; dir: string }> = [];
  for (const f of repoFiles) {
    if (f !== 'go.mod' && !f.endsWith('/go.mod')) continue;
    try {
      const m = /^module\s+(\S+)/m.exec(readFileSync(path.join(root, f), 'utf8'));
      if (m) goModules.push({ module: m[1].replace(/^"|"$/g, ''), dir: f === 'go.mod' ? '.' : f.slice(0, -'/go.mod'.length) });
    } catch {
      /* unreadable go.mod: its packages stay unmapped */
    }
  }
  return {
    rootDir: root.split(path.sep).join('/'),
    repoFiles,
    ...(config?.coverage?.pathPrefixes ? { stripPrefixes: config.coverage.pathPrefixes } : {}),
    ...(config?.coverage?.sourceRoots ? { sourceRoots: config.coverage.sourceRoots } : {}),
    goModules,
  };
}

/** Content hashes of `files` now; a file that cannot be read is left out. */
export function hashFiles(root: string, files: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    const h = hashFile(path.join(root, f));
    if (h) out[f] = h;
  }
  return out;
}

/**
 * The tests tagged to a capability's claims, as the selection coverage evidence is scoped to.
 * Undefined when no spec has that id.
 */
export async function selectionForCapability(config: SpecGuardConfig, capability: string): Promise<CapabilitySelection | undefined> {
  const root = config.rootDir ?? process.cwd();
  const graph = await buildSpecGraph(config);
  const node = graph.nodes.get(capability);
  if (!node) return undefined;
  const globs = new Set<string>();
  for (const n of graph.nodes.values()) for (const t of n.spec.meta.tests ?? []) globs.add(t);
  for (const app of config.apps) for (const t of [...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])]) globs.add(t);
  const index = buildClaimTestIndex({ testFiles: await expandGlobs([...globs], root), rootDir: root });
  const ids = new Set(node.spec.claims.map((c) => c.id).filter((id): id is string => Boolean(id)));
  // A test may cite the claim with or without a repo prefix.
  const refs = [...index.keys()].filter((key) => {
    const parsed = parseClaimRef(key);
    return parsed !== null && parsed.specKey === node.specKey && ids.has(parsed.claimId);
  });
  return selectCapabilityTests(refs, index);
}

export async function runCoverageIngest(inputs: string[], cwd: string, opts: CoverageIngestOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('coverage-ingest');
  const fail = (message: string): PipelineResult => {
    result.failed += 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(message);
    return result;
  };
  const config = await optionalConfig(cwd);
  const root = config?.rootDir ?? cwd;
  const files = await expandInputs(cwd, inputs);
  if (files.length === 0) return fail('no coverage files matched');

  let scope: CoverageScope = { kind: 'suite' };
  if (opts.selection && !opts.capability) return fail('--selection needs --capability');
  if (opts.capability) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.capability)) return fail(`'${opts.capability}' is not a capability id`);
    if (!config) return fail('--capability needs a .specguard/config.json');
    const selection = await selectionForCapability(config, opts.capability);
    if (!selection) return fail(`no capability '${opts.capability}'`);
    const kind = opts.selection ?? 'tests';
    if (selection.tests.length === 0 && selection.files.length === 0) return fail(`capability '${opts.capability}' has no tests tagged to its claims`);
    scope = { kind: 'capability', capability: opts.capability, selection: kind, tests: selection.tests, testsHash: selection.testsHash };
  }

  const raws: RawCoverage[] = [];
  let parseFailures = 0;
  for (const abs of files) {
    const rel = relPosix(cwd, abs);
    try {
      const raw = parseCoverage(await readFile(abs), opts.format ?? 'auto');
      raws.push(raw);
      result.messages.push(`${rel}: ${raw.format}, ${raw.files.length} file(s)`);
      for (const w of raw.warnings) result.messages.push(`  [warn] ${rel}: ${w}`);
    } catch (err) {
      parseFailures += 1;
      result.failed += 1;
      const message = err instanceof CoverageParseError || err instanceof Error ? err.message : String(err);
      result.items.push({ key: rel, status: 'failed', message });
      result.messages.push(`${rel}: ${message}`);
    }
  }
  if (raws.length === 0) {
    result.exitCode = ExitCode.ValidationFailed;
    return result;
  }

  const ctx = await buildPathContext(root, config);
  const mapped = mappedCoverageFiles(raws, ctx);
  const evidence = enforceSizeCap(
    normalizeCoverage(raws, ctx, hashFiles(root, mapped), {
      scope,
      runId: opts.runId ?? `coverage-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      repoSha: gitHead(root),
      origin: opts.origin ?? (process.env.CI ? 'ci' : 'local'),
      ingestedAt: new Date().toISOString(),
    }),
  );
  if (Object.keys(evidence.files).length === 0) {
    result.exitCode = ExitCode.ValidationFailed;
    result.failed += 1;
    result.messages.push(`no report path maps onto a repo file (${evidence.unmapped.count} unmapped, e.g. ${evidence.unmapped.sample.slice(0, 3).join(', ')}); set coverage.pathPrefixes or coverage.sourceRoots in the config`);
    return result;
  }

  const target = coverageEvidencePath(root, scope.kind === 'capability' ? scope.capability : undefined);
  await writeFile(target, JSON.stringify(evidence, null, 2) + '\n');

  const totals = Object.values(evidence.summary).reduce((a, s) => ({ exec: a.exec + s.exec, hit: a.hit + s.hit }), { exec: 0, hit: 0 });
  const pct = totals.exec === 0 ? 'n/a' : `${Math.round((totals.hit / totals.exec) * 1000) / 10}%`;
  result.created = raws.length;
  result.messages.push(
    `${scope.kind === 'suite' ? 'suite' : `capability ${scope.capability} (${scope.selection})`}: ${Object.keys(evidence.files).length} file(s), ${totals.hit}/${totals.exec} executable lines hit (${pct}) -> ${relPosix(root, target)}`,
  );
  if (evidence.unmapped.count > 0) {
    result.messages.push(`[warn] ${evidence.unmapped.count} report path(s) map to no repo file, e.g. ${evidence.unmapped.sample.slice(0, 5).join(', ')}`);
  }
  if (evidence.granularity === 'summary') result.messages.push('[warn] evidence exceeded the size cap: line data dropped, only per-file totals kept');
  if (scope.kind === 'suite') result.messages.push('note: a whole-suite report shows what some test executed, not what a claim\'s tests execute');
  if (parseFailures > 0) result.exitCode = ExitCode.ValidationFailed;
  return result;
}

/** The stored evidence for a scope, or undefined when none was ingested or the file is unreadable. */
export async function readCoverageEvidence(root: string, capability?: string): Promise<CoverageEvidence | undefined> {
  const file = coverageEvidencePath(root, capability);
  if (!(await fileExists(file))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(file)) as CoverageEvidence;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
