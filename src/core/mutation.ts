/**
 * Mutation evidence: parse Stryker (mutation-testing-report-schema JSON) and PIT
 * (`mutations.xml`) reports, map the tests that killed mutants onto the claims
 * they are tagged to, and score a capability and each of its claims.
 *
 * Pure: text and values in, values out. The ingest pipeline reads the files and
 * stores the normalized report. A kill proves a test is sensitive to a piece of
 * code; it does not prove the claim's wording is what the test checks.
 *
 * Spec: specs/capabilities/coverage-and-mutation.md
 */
import { createHash } from 'node:crypto';

import { XMLParser } from 'fast-xml-parser';

import { mapCoveragePath, type PathContext } from './coverage.js';
import type { ChangedFile } from './diff-lines.js';
import type { MutationConfig } from './types.js';

export type MutantStatus = 'killed' | 'survived' | 'no-coverage' | 'timeout' | 'invalid' | 'ignored' | 'pending';

export interface Mutant {
  id: string;
  /** Repo-relative after mapping. */
  file: string;
  line: number;
  endLine: number;
  mutator: string;
  replacement?: string;
  status: MutantStatus;
  /** Test ids. */
  killedBy: string[];
  /** Undefined = the tool did not record coverage per test. */
  coveredBy?: string[];
}

export interface MutationTest {
  id: string;
  file?: string;
  name: string;
  className?: string;
  method?: string;
}

export type MutationTool = 'stryker' | 'pit';

export interface MutationReport {
  tool: MutationTool;
  mutants: Mutant[];
  tests: Record<string, MutationTest>;
  /** 'full' when every killing test is listed. */
  attribution: 'full' | 'first-kill';
  coverage: 'per-test' | 'none';
  /** Stryker: sha256 of the embedded `source`. PIT: empty here, hashed at ingest. */
  sourceHashes: Record<string, string>;
  unmapped: string[];
  warnings: string[];
}

export class MutationParseError extends Error {
  constructor(public readonly format: string, detail: string) {
    super(`cannot parse ${format} mutation report: ${detail}`);
    this.name = 'MutationParseError';
  }
}

export interface MutationParseOptions {
  /** The project ran Stryker with `disableBail: true` (config `mutation.attribution: "full"`). */
  attribution?: 'full' | 'first-kill';
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];
}

function compareMutants(a: Mutant, b: Mutant): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.endLine - b.endLine || a.mutator.localeCompare(b.mutator) || a.id.localeCompare(b.id, 'en', { numeric: true });
}

// ---------------------------------------------------------------------------
// Stryker
// ---------------------------------------------------------------------------

const STRYKER_STATUS: Record<string, MutantStatus> = {
  Killed: 'killed',
  Survived: 'survived',
  NoCoverage: 'no-coverage',
  Timeout: 'timeout',
  CompileError: 'invalid',
  RuntimeError: 'invalid',
  Ignored: 'ignored',
  Pending: 'pending',
};

export function parseStrykerReport(json: string, ctx: PathContext, opts: MutationParseOptions = {}): MutationReport {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    throw new MutationParseError('stryker', `invalid JSON (${(err as Error).message})`);
  }
  if (!isObject(doc) || !isObject(doc.files)) throw new MutationParseError('stryker', 'no "files" object');

  const tests: Record<string, MutationTest> = {};
  if (isObject(doc.testFiles)) {
    for (const [file, entry] of Object.entries(doc.testFiles)) {
      if (!isObject(entry) || !Array.isArray(entry.tests)) continue;
      for (const t of entry.tests) {
        if (!isObject(t)) continue;
        const id = str(t.id);
        if (id) tests[id] = { id, file, name: str(t.name, id) };
      }
    }
  }
  // Reports without `testFiles` name the killing test in `killedBy` itself.
  const known = (id: string): string => {
    tests[id] ??= { id, name: id };
    return id;
  };

  const mutants: Mutant[] = [];
  const sourceHashes: Record<string, string> = {};
  const unmapped: string[] = [];
  const warnings: string[] = [];
  let perTest = false;
  let multipleKillers = false;
  for (const [rawPath, entry] of Object.entries(doc.files)) {
    if (!isObject(entry) || !Array.isArray(entry.mutants)) continue;
    const mapped = mapCoveragePath(rawPath, ctx);
    if (!('file' in mapped)) {
      unmapped.push(rawPath);
      continue;
    }
    if (typeof entry.source === 'string') sourceHashes[mapped.file] = sha256(entry.source);
    for (const m of entry.mutants) {
      if (!isObject(m)) continue;
      const status = STRYKER_STATUS[str(m.status)];
      if (!status) {
        warnings.push(`${rawPath}: unknown mutant status "${str(m.status)}" skipped`);
        continue;
      }
      const loc = isObject(m.location) ? m.location : {};
      const start = isObject(loc.start) ? num(loc.start.line) : 0;
      const end = isObject(loc.end) ? num(loc.end.line) : start;
      const killedBy = strings(m.killedBy).map(known);
      if (killedBy.length > 1) multipleKillers = true;
      const coveredBy = Array.isArray(m.coveredBy) ? strings(m.coveredBy).map(known) : undefined;
      if (coveredBy) perTest = true;
      mutants.push({
        id: str(m.id, `${mapped.file}:${start}`),
        file: mapped.file,
        line: start,
        endLine: Math.max(start, end),
        mutator: str(m.mutatorName),
        ...(typeof m.replacement === 'string' ? { replacement: m.replacement } : {}),
        status,
        killedBy,
        ...(coveredBy ? { coveredBy } : {}),
      });
    }
  }
  if (mutants.length === 0 && unmapped.length === 0) throw new MutationParseError('stryker', 'no mutants');
  return {
    tool: 'stryker',
    mutants: mutants.sort(compareMutants),
    tests,
    attribution: opts.attribution === 'full' || multipleKillers ? 'full' : 'first-kill',
    coverage: perTest ? 'per-test' : 'none',
    sourceHashes,
    unmapped: unmapped.sort(),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// PIT
// ---------------------------------------------------------------------------

const PIT_STATUS: Record<string, MutantStatus> = {
  KILLED: 'killed',
  SURVIVED: 'survived',
  NO_COVERAGE: 'no-coverage',
  TIMED_OUT: 'timeout',
  MEMORY_ERROR: 'timeout',
  RUN_ERROR: 'invalid',
  NON_VIABLE: 'invalid',
  NOT_STARTED: 'pending',
  STARTED: 'pending',
};

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** A PIT test id as a test: JUnit 5 unique ids and JUnit 4 `pkg.Cls.name(pkg.Cls)` give a class and a method. */
export function parsePitTestName(raw: string): MutationTest {
  const jupiterMethod = /\[(?:method|test-template|test-factory):([^(\]/]+)/.exec(raw);
  const jupiterClass = [...raw.matchAll(/\[class:([^\]]+)\]/g)].pop();
  if (jupiterMethod || jupiterClass) {
    const method = jupiterMethod?.[1];
    return { id: raw, name: method ?? raw, ...(jupiterClass ? { className: jupiterClass[1] } : {}), ...(method ? { method } : {}) };
  }
  const junit4 = /^(.+)\.([^.()\s]+)\(([^)]+)\)$/.exec(raw);
  if (junit4) return { id: raw, name: junit4[2], className: junit4[3], method: junit4[2] };
  return { id: raw, name: raw };
}

const splitTests = (value: unknown): string[] =>
  str(value)
    .split('|')
    .map((t) => decodeXml(t.trim()))
    .filter(Boolean);

export function parsePitXml(xml: string, ctx: PathContext, opts: MutationParseOptions = {}): MutationReport {
  let doc: Record<string, unknown>;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, parseTagValue: false, parseAttributeValue: false, isArray: (n) => n === 'mutation' }).parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new MutationParseError('pit', `invalid XML (${(err as Error).message})`);
  }
  const root = doc.mutations;
  if (root === undefined) throw new MutationParseError('pit', 'no <mutations> element');
  const rows = isObject(root) && Array.isArray(root.mutation) ? (root.mutation as unknown[]) : [];

  const tests: Record<string, MutationTest> = {};
  const known = (raw: string): string => {
    tests[raw] ??= parsePitTestName(raw);
    return raw;
  };
  const mutants: Mutant[] = [];
  const unmapped = new Set<string>();
  const warnings: string[] = [];
  let perTest = false;
  let full = false;
  rows.forEach((row, index) => {
    if (!isObject(row)) return;
    const status = PIT_STATUS[str(row['@_status'])];
    if (!status) {
      warnings.push(`unknown mutation status "${str(row['@_status'])}" skipped`);
      return;
    }
    const mutatedClass = str(row.mutatedClass);
    const sourceFile = str(row.sourceFile);
    const outer = mutatedClass.split('$')[0];
    const pkgDir = outer.includes('.') ? outer.slice(0, outer.lastIndexOf('.')).replace(/\./g, '/') : '';
    const rawPath = pkgDir ? `${pkgDir}/${sourceFile}` : sourceFile;
    const mapped = mapCoveragePath(rawPath, ctx);
    if (!('file' in mapped)) {
      unmapped.add(rawPath);
      return;
    }
    const killing = [...splitTests(row.killingTest), ...splitTests(row.killingTests)];
    const killedBy = [...new Set(killing)].map(known);
    const hasMatrix = row.killingTests !== undefined || row.succeedingTests !== undefined;
    if (hasMatrix || killedBy.length > 1) full = true;
    let coveredBy: string[] | undefined;
    if (row.succeedingTests !== undefined) {
      coveredBy = [...new Set([...killing, ...splitTests(row.succeedingTests)])].map(known);
      perTest = true;
    }
    const line = num(row.lineNumber);
    const mutatorFull = str(row.mutator);
    const description = decodeXml(str(row.description));
    mutants.push({
      id: `pit-${index}`,
      file: mapped.file,
      line,
      endLine: line,
      mutator: mutatorFull.slice(mutatorFull.lastIndexOf('.') + 1),
      ...(description ? { replacement: description } : {}),
      status,
      killedBy,
      ...(coveredBy ? { coveredBy } : {}),
    });
  });
  if (mutants.length === 0 && unmapped.size === 0) throw new MutationParseError('pit', 'no <mutation> elements');
  return {
    tool: 'pit',
    mutants: mutants.sort(compareMutants),
    tests,
    attribution: opts.attribution === 'full' || full ? 'full' : 'first-kill',
    coverage: perTest ? 'per-test' : 'none',
    sourceHashes: {},
    unmapped: [...unmapped].sort(),
    warnings,
  };
}

export function detectMutationFormat(text: string): MutationTool | null {
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('{')) return /"files"\s*:/.test(head) ? 'stryker' : null;
  if (head.startsWith('<') && /<mutations[\s>]/.test(head)) return 'pit';
  return null;
}

export function parseMutationReport(text: string, ctx: PathContext, format: MutationTool | 'auto' = 'auto', opts: MutationParseOptions = {}): MutationReport {
  const fmt = format === 'auto' ? detectMutationFormat(text) : format;
  if (!fmt) throw new MutationParseError('auto', 'format not recognised (expected a Stryker JSON report or PIT mutations.xml)');
  return fmt === 'stryker' ? parseStrykerReport(text, ctx, opts) : parsePitXml(text, ctx, opts);
}

/** Combine reports of one tool (for example several packages). Mutant and test ids are prefixed when there is more than one. */
export function mergeMutationReports(reports: MutationReport[]): MutationReport {
  if (reports.length === 0) throw new MutationParseError('merge', 'no reports');
  if (reports.length === 1) return reports[0];
  if (new Set(reports.map((r) => r.tool)).size > 1) throw new MutationParseError('merge', 'cannot combine Stryker and PIT reports in one ingest');
  const tests: Record<string, MutationTest> = {};
  const mutants: Mutant[] = [];
  reports.forEach((r, i) => {
    const pre = (id: string): string => `${i}:${id}`;
    for (const t of Object.values(r.tests)) tests[pre(t.id)] = { ...t, id: pre(t.id) };
    for (const m of r.mutants) {
      mutants.push({ ...m, id: pre(m.id), killedBy: m.killedBy.map(pre), ...(m.coveredBy ? { coveredBy: m.coveredBy.map(pre) } : {}) });
    }
  });
  return {
    tool: reports[0].tool,
    mutants: mutants.sort(compareMutants),
    tests,
    attribution: reports.every((r) => r.attribution === 'full') ? 'full' : 'first-kill',
    coverage: reports.every((r) => r.coverage === 'per-test') ? 'per-test' : 'none',
    sourceHashes: Object.assign({}, ...reports.map((r) => r.sourceHashes)) as Record<string, string>,
    unmapped: [...new Set(reports.flatMap((r) => r.unmapped))].sort(),
    warnings: reports.flatMap((r) => r.warnings),
  };
}

// ---------------------------------------------------------------------------
// Mapping tests to claims
// ---------------------------------------------------------------------------

export interface TestKeyIndex {
  /** `file::title` of the declaration a mutation test is, or undefined when none or several match. */
  keyOf(t: MutationTest): string | undefined;
}

export interface TestDeclarationInput {
  file: string;
  title: string;
  method?: string;
  claims: string[];
}

export type ClaimedTestKeyIndex = TestKeyIndex & {
  claimsOf(key: string): string[];
  /** The tests that match no declaration. They are listed, never guessed. */
  unmatched(tests: Iterable<MutationTest>): MutationTest[];
};

/** Strip one trailing ` [param]` or ` (param)`. */
function stripParam(name: string): string {
  return name.replace(/\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/, '');
}

const sameFile = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

function classFileRe(className: string): RegExp {
  const base = className.split('$')[0].replace(/\./g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|/)${base}\\.(?:java|kt)$`);
}

function nameMatches(t: MutationTest, d: TestDeclarationInput): boolean {
  const candidates = [t.name, stripParam(t.name)];
  for (const n of candidates) if (n === d.title || n.endsWith(` ${d.title}`)) return true;
  if (t.method !== undefined && (t.method === d.method || t.method === d.title)) return true;
  return false;
}

export function buildTestKeyIndex(decls: TestDeclarationInput[]): ClaimedTestKeyIndex {
  const keyOfDecl = (d: TestDeclarationInput): string => `${d.file}::${d.title}`;
  const claims = new Map<string, Set<string>>();
  for (const d of decls) {
    const set = claims.get(keyOfDecl(d)) ?? new Set<string>();
    for (const c of d.claims) set.add(c);
    claims.set(keyOfDecl(d), set);
  }
  const keyOf = (t: MutationTest): string | undefined => {
    let pool = decls;
    if (t.file !== undefined) {
      const file = t.file;
      pool = decls.filter((d) => sameFile(d.file, file));
    } else if (t.className !== undefined) {
      const re = classFileRe(t.className);
      pool = decls.filter((d) => re.test(d.file));
    }
    const keys = new Set(pool.filter((d) => nameMatches(t, d)).map(keyOfDecl));
    return keys.size === 1 ? [...keys][0] : undefined;
  };
  return {
    keyOf,
    claimsOf: (key) => [...(claims.get(key) ?? [])].sort(),
    unmatched: (tests) => [...tests].filter((t) => keyOf(t) === undefined).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface MutationCounts {
  total: number;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  ignored: number;
  invalid: number;
  pending: number;
}

export interface CapabilityMutationScore extends MutationCounts {
  capability: string;
  scope: 'owned' | 'changed';
  /** (killed + timeouts counted as killed) / (those + survived + no-coverage), as a percentage; null when nothing is scorable. */
  score: number | null;
  staleFiles: string[];
  survivors: Array<{ file: string; line: number; mutator: string }>;
}

export interface ClaimMutationScore {
  ref: string;
  scope: 'owned' | 'changed';
  /** Valid in-scope mutants covered by the claim's tests (per-test coverage), else all valid in scope. */
  considered: number;
  /** A claim test is among the killers (a timeout counts when timeoutAsKilled and a claim test covered it). */
  killed: number;
  /** Covered by claim tests and killed by none of them. */
  survived: number;
  /** First-kill reports: covered by claim tests, killed by another test, so the claim's own kills may be undercounted. */
  unattributed: number;
  /** killed / (killed + survived) as a percentage; null without per-test coverage. */
  score: number | null;
  /** killed >= minKilled */
  sensitive: boolean;
  attribution: 'full' | 'first-kill';
  coverage: 'per-test' | 'none';
  stale: boolean;
  limits: string[];
}

export interface MutationPolicy {
  /** Percentage, default 70. */
  minScore: number;
  /** Default 1. */
  minKilled: number;
  /** Default true. */
  timeoutAsKilled: boolean;
}

export const DEFAULT_MUTATION_POLICY: MutationPolicy = { minScore: 70, minKilled: 1, timeoutAsKilled: true };

export function resolveMutationPolicy(cfg?: MutationConfig): MutationPolicy {
  return {
    minScore: cfg?.minScore ?? DEFAULT_MUTATION_POLICY.minScore,
    minKilled: cfg?.minKilled ?? DEFAULT_MUTATION_POLICY.minKilled,
    timeoutAsKilled: cfg?.timeoutAsKilled ?? DEFAULT_MUTATION_POLICY.timeoutAsKilled,
  };
}

const SURVIVOR_MAX = 20;
const pct1 = (num: number, den: number): number | null => (den === 0 ? null : Math.round((num / den) * 1000) / 10);

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function emptyCounts(): MutationCounts {
  return { total: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0, ignored: 0, invalid: 0, pending: 0 };
}

const COUNT_KEY: Record<MutantStatus, keyof MutationCounts> = {
  killed: 'killed',
  survived: 'survived',
  'no-coverage': 'noCoverage',
  timeout: 'timeout',
  ignored: 'ignored',
  invalid: 'invalid',
  pending: 'pending',
};

export function scoreMutation(input: {
  report: MutationReport;
  capability: string;
  ownedFiles: string[];
  changed?: ChangedFile[];
  /** Claim refs (including example rows) to the keys of the tests tagged to them. */
  claimTests: Map<string, Set<string>>;
  keys: TestKeyIndex;
  currentHashes: Record<string, string>;
  policy: MutationPolicy;
}): { capability: CapabilityMutationScore; claims: ClaimMutationScore[] } {
  const { report, policy } = input;
  const owned = new Set(input.ownedFiles);

  // Without a diff, or when the diff touches no owned code (a spec-only change), the scope is the owned files.
  const changedOwned = new Map<string, Set<number>>();
  for (const cf of input.changed ?? []) {
    if (owned.has(cf.file) && cf.status !== 'deleted' && !cf.binary) changedOwned.set(cf.file, new Set(cf.added));
  }
  const scope: 'owned' | 'changed' = input.changed !== undefined && changedOwned.size > 0 ? 'changed' : 'owned';
  const inScope = (m: Mutant): boolean => {
    if (!owned.has(m.file)) return false;
    if (scope === 'owned') return true;
    const added = changedOwned.get(m.file);
    if (!added) return false;
    for (let n = m.line; n <= m.endLine; n += 1) if (added.has(n)) return true;
    return false;
  };
  const isStale = (file: string): boolean => {
    const recorded = report.sourceHashes[file];
    return recorded !== undefined && input.currentHashes[file] !== recorded;
  };

  const scoped = report.mutants.filter(inScope);
  const staleFiles = [...new Set(scoped.filter((m) => isStale(m.file)).map((m) => m.file))].sort();
  const staleMutants = scoped.filter((m) => isStale(m.file));
  const fresh = scoped.filter((m) => !isStale(m.file));

  const counts = emptyCounts();
  for (const m of fresh) {
    counts.total += 1;
    counts[COUNT_KEY[m.status]] += 1;
  }
  const detected = counts.killed + (policy.timeoutAsKilled ? counts.timeout : 0);
  const survivors = fresh
    .filter((m) => m.status === 'survived')
    .map((m) => ({ file: m.file, line: m.line, mutator: m.mutator }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.mutator.localeCompare(b.mutator))
    .slice(0, SURVIVOR_MAX);
  const capability: CapabilityMutationScore = {
    capability: input.capability,
    scope,
    ...counts,
    score: pct1(detected, detected + counts.survived + counts.noCoverage),
    staleFiles,
    survivors,
  };

  const perTest = report.coverage === 'per-test';
  const keysOf = (ids: string[] | undefined): Set<string> => {
    const out = new Set<string>();
    for (const id of ids ?? []) {
      const t = report.tests[id];
      const k = t ? input.keys.keyOf(t) : undefined;
      if (k) out.add(k);
    }
    return out;
  };
  const killers = new Map<Mutant, Set<string>>();
  const covering = new Map<Mutant, Set<string>>();
  for (const m of [...fresh, ...staleMutants]) {
    killers.set(m, keysOf(m.killedBy));
    covering.set(m, new Set([...keysOf(m.coveredBy), ...(killers.get(m) ?? [])]));
  }

  const limits = ['A kill shows the test is sensitive to that code, not that the claim wording is what it checks.', 'Only the operators the tool applies are scored.'];
  if (report.attribution === 'first-kill') limits.push('The tool records one killing test per mutant, so kills per claim are undercounted; survivors stay sound.');
  if (!perTest) limits.push('No per-test coverage was recorded, so there is no per-claim score, only the mutants this claim\'s tests killed.');

  const claims: ClaimMutationScore[] = [];
  for (const ref of [...input.claimTests.keys()].sort()) {
    const mine = input.claimTests.get(ref) ?? new Set<string>();
    let considered = 0;
    let killed = 0;
    let survived = 0;
    let unattributed = 0;
    for (const m of fresh) {
      const scorable = m.status === 'killed' || m.status === 'survived' || (m.status === 'timeout' && policy.timeoutAsKilled);
      if (!scorable) continue;
      if (perTest && !intersects(covering.get(m) ?? new Set(), mine)) continue;
      considered += 1;
      if (m.status === 'survived') {
        if (perTest) survived += 1;
      } else if (m.status === 'timeout') {
        // A timeout names no killer; a claim test that covered the mutant is credited with it.
        if (perTest) killed += 1;
      } else if (intersects(killers.get(m) ?? new Set(), mine)) {
        killed += 1;
      } else if (perTest) {
        // Covered by a claim test and killed by some other test: undercounted under first-kill, a plain miss under full.
        if (report.attribution === 'first-kill') unattributed += 1;
        else survived += 1;
      }
    }
    const touchesStale = staleMutants.some((m) => {
      if (m.status === 'ignored' || m.status === 'invalid' || m.status === 'pending') return false;
      return !perTest || intersects(covering.get(m) ?? new Set(), mine);
    });
    claims.push({
      ref,
      scope,
      considered,
      killed,
      survived,
      unattributed,
      score: perTest ? pct1(killed, killed + survived) : null,
      sensitive: killed >= policy.minKilled,
      attribution: report.attribution,
      coverage: report.coverage,
      stale: touchesStale,
      limits,
    });
  }
  return { capability, claims };
}

export function meetsMutationPolicy(c: ClaimMutationScore, p: MutationPolicy): { ok: boolean; reason?: 'NOT_KILLED' | 'SCORE_LOW' | 'STALE' } {
  if (c.stale) return { ok: false, reason: 'STALE' };
  if (c.killed < p.minKilled) return { ok: false, reason: 'NOT_KILLED' };
  if (c.score !== null && c.score < p.minScore) return { ok: false, reason: 'SCORE_LOW' };
  return { ok: true };
}
