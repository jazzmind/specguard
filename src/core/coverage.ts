/**
 * Coverage evidence: parse lcov, JaCoCo, Cobertura and Go coverage reports, map
 * their paths onto repo files, attribute executable and hit lines to capabilities
 * by file ownership, and compute line and changed-line (diff) coverage.
 *
 * Pure: text and values in, values out. The ingest pipeline reads the files and
 * writes the evidence. A whole-suite report proves that some test executed a line;
 * it cannot prove that a claim's tests did, or that the line is specified behaviour.
 *
 * Spec: specs/capabilities/coverage-and-mutation.md
 */
import { createHash } from 'node:crypto';

import { XMLParser } from 'fast-xml-parser';

import type { ClaimTestIndex } from './claim-tags.js';
import type { ChangedFile } from './diff-lines.js';

export type CoverageFormat = 'lcov' | 'jacoco' | 'cobertura' | 'go';
export const COVERAGE_FORMATS: readonly CoverageFormat[] = ['lcov', 'jacoco', 'cobertura', 'go'];

export interface RawFileCoverage {
  /** As written in the report. */
  path: string;
  /** Other candidate paths for the same file (Cobertura: each `source` joined with the filename). */
  alternatives?: string[];
  /** line -> hit count */
  lines: Map<number, number>;
  branches: Map<number, { total: number; covered: number }>;
}

export interface RawCoverage {
  format: CoverageFormat;
  files: RawFileCoverage[];
  warnings: string[];
}

export class CoverageParseError extends Error {
  constructor(public readonly format: string, detail: string) {
    super(`cannot parse ${format} coverage: ${detail}`);
    this.name = 'CoverageParseError';
  }
}

export function isCoverageFormat(value: string): value is CoverageFormat {
  return (COVERAGE_FORMATS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function addLine(file: RawFileCoverage, line: number, hits: number): void {
  if (!Number.isInteger(line) || line < 1) return;
  file.lines.set(line, Math.max(file.lines.get(line) ?? 0, hits));
}

function addBranch(file: RawFileCoverage, line: number, total: number, covered: number): void {
  if (!Number.isInteger(line) || line < 1 || total <= 0) return;
  const prev = file.branches.get(line);
  file.branches.set(line, { total: Math.max(prev?.total ?? 0, total), covered: Math.max(prev?.covered ?? 0, Math.min(covered, total)) });
}

function newFile(filePath: string): RawFileCoverage {
  return { path: filePath, lines: new Map(), branches: new Map() };
}

/** Merge another record of the same path into `into` (a path repeated in one report). */
function mergeInto(into: RawFileCoverage, from: RawFileCoverage): void {
  for (const [line, hits] of from.lines) addLine(into, line, hits);
  for (const [line, b] of from.branches) addBranch(into, line, b.total, b.covered);
}

function dedupeFiles(files: RawFileCoverage[]): RawFileCoverage[] {
  const byPath = new Map<string, RawFileCoverage>();
  for (const f of files) {
    const prev = byPath.get(f.path);
    if (prev) {
      mergeInto(prev, f);
      if (f.alternatives) prev.alternatives = [...new Set([...(prev.alternatives ?? []), ...f.alternatives])];
    } else byPath.set(f.path, f);
  }
  return [...byPath.values()];
}

export function parseLcov(text: string): RawCoverage {
  const files: RawFileCoverage[] = [];
  const warnings: string[] = [];
  let current: RawFileCoverage | undefined;
  // BRDA is per branch; aggregate per line after the record.
  let brda = new Map<number, { total: number; covered: number }>();
  const flush = (): void => {
    if (!current) return;
    for (const [line, b] of brda) addBranch(current, line, b.total, b.covered);
    files.push(current);
    current = undefined;
    brda = new Map();
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      flush();
      current = newFile(line.slice(3).trim());
    } else if (line === 'end_of_record') {
      flush();
    } else if (!current) {
      continue;
    } else if (line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',');
      addLine(current, Number(ln), num(hits));
    } else if (line.startsWith('BRDA:')) {
      const [ln, , , taken] = line.slice(5).split(',');
      const lineNo = Number(ln);
      if (!Number.isInteger(lineNo)) continue;
      const prev = brda.get(lineNo) ?? { total: 0, covered: 0 };
      prev.total += 1;
      if (taken !== undefined && taken !== '-' && num(taken) > 0) prev.covered += 1;
      brda.set(lineNo, prev);
    }
    // TN, FN, FNDA, FNF, FNH, LF, LH, BRF, BRH carry nothing the lines do not.
  }
  if (current) {
    warnings.push('missing final end_of_record');
    flush();
  }
  if (files.length === 0) throw new CoverageParseError('lcov', 'no SF: records');
  return { format: 'lcov', files: dedupeFiles(files), warnings };
}

type XmlNode = Record<string, unknown>;

function asArray(value: unknown): XmlNode[] {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is XmlNode => typeof v === 'object' && v !== null);
}

function xmlParser(arrays: string[]): XMLParser {
  // No entity expansion: a DOCTYPE (JaCoCo writes one) is skipped, never evaluated.
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: false,
    parseAttributeValue: false,
    parseTagValue: false,
    isArray: (name) => arrays.includes(name),
  });
}

function parseXml(format: CoverageFormat, text: string, arrays: string[]): XmlNode {
  try {
    return xmlParser(arrays).parse(text) as XmlNode;
  } catch (err) {
    throw new CoverageParseError(format, `invalid XML (${(err as Error).message})`);
  }
}

export function parseJacoco(xml: string): RawCoverage {
  const doc = parseXml('jacoco', xml, ['package', 'sourcefile', 'line', 'group']);
  const report = doc.report as XmlNode | undefined;
  if (!report || typeof report !== 'object') throw new CoverageParseError('jacoco', 'no <report> element');
  const packages: XmlNode[] = [];
  const collect = (node: XmlNode): void => {
    packages.push(...asArray(node.package));
    for (const g of asArray(node.group)) collect(g);
  };
  collect(report);
  const files: RawFileCoverage[] = [];
  for (const pkg of packages) {
    const dir = String(pkg['@_name'] ?? '');
    for (const sf of asArray(pkg.sourcefile)) {
      const name = String(sf['@_name'] ?? '');
      if (!name) continue;
      const file = newFile(dir ? `${dir}/${name}` : name);
      for (const ln of asArray(sf.line)) {
        const mi = num(ln['@_mi']);
        const ci = num(ln['@_ci']);
        if (mi + ci > 0) addLine(file, num(ln['@_nr']), ci > 0 ? ci : 0);
        const mb = num(ln['@_mb']);
        const cb = num(ln['@_cb']);
        addBranch(file, num(ln['@_nr']), mb + cb, cb);
      }
      files.push(file);
    }
  }
  if (files.length === 0) throw new CoverageParseError('jacoco', 'no <sourcefile> elements');
  return { format: 'jacoco', files: dedupeFiles(files), warnings: [] };
}

export function parseCobertura(xml: string): RawCoverage {
  const doc = parseXml('cobertura', xml, ['source', 'package', 'class', 'line']);
  const root = doc.coverage as XmlNode | undefined;
  if (!root || typeof root !== 'object') throw new CoverageParseError('cobertura', 'no <coverage> element');
  const rawSources = (root.sources as XmlNode | undefined)?.source;
  const sources = (Array.isArray(rawSources) ? rawSources : [rawSources]).filter((s): s is string => typeof s === 'string' && s !== '');
  const uniqueSources = [...new Set(sources)];
  const files: RawFileCoverage[] = [];
  const packages = asArray((root.packages as XmlNode | undefined)?.package);
  for (const pkg of packages) {
    for (const cls of asArray((pkg.classes as XmlNode | undefined)?.class)) {
      const filename = String(cls['@_filename'] ?? '').trim();
      if (!filename) continue;
      const file = newFile(filename);
      if (uniqueSources.length > 0) file.alternatives = uniqueSources.map((s) => `${s.replace(/[\\/]+$/, '')}/${filename}`);
      // Only the class-level <lines>: each <method> repeats a subset of them.
      for (const ln of asArray((cls.lines as XmlNode | undefined)?.line)) {
        const lineNo = num(ln['@_number']);
        addLine(file, lineNo, num(ln['@_hits']));
        const cond = String(ln['@_condition-coverage'] ?? '').match(/\((\d+)\/(\d+)\)/);
        if (cond) addBranch(file, lineNo, Number(cond[2]), Number(cond[1]));
      }
      files.push(file);
    }
  }
  if (files.length === 0) throw new CoverageParseError('cobertura', 'no <class> elements');
  return { format: 'cobertura', files: dedupeFiles(files), warnings: [] };
}

const GO_BLOCK = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/;

export function parseGoCoverprofile(text: string): RawCoverage {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (rows.length === 0 || !/^mode:\s*(set|count|atomic)\b/.test(rows[0])) throw new CoverageParseError('go', 'first line is not "mode: set|count|atomic"');
  const byFile = new Map<string, RawFileCoverage>();
  const warnings: string[] = [];
  for (const row of rows.slice(1)) {
    const m = GO_BLOCK.exec(row.trim());
    if (!m) {
      warnings.push(`skipped unreadable line: ${row.slice(0, 80)}`);
      continue;
    }
    const [, filePath, sl, el, stmts, count] = m;
    if (Number(stmts) <= 0) continue;
    let file = byFile.get(filePath);
    if (!file) {
      file = newFile(filePath);
      byFile.set(filePath, file);
    }
    // A line shared by adjacent blocks counts as hit if either is hit; duplicate blocks take the maximum.
    for (let line = Number(sl); line <= Number(el); line += 1) addLine(file, line, Number(count));
  }
  if (byFile.size === 0) throw new CoverageParseError('go', 'no coverage blocks');
  return { format: 'go', files: [...byFile.values()], warnings };
}

export function detectCoverageFormat(text: string): CoverageFormat | null {
  const head = text.replace(/^\uFEFF/, '').trimStart();
  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  if (/^mode:\s*(set|count|atomic)\b/.test(firstLine)) return 'go';
  if (head.split(/\r?\n/, 20).some((l) => l.startsWith('SF:'))) return 'lcov';
  if (head.startsWith('<') || head.startsWith('<?xml')) {
    if (/<report[\s>]/.test(head) && (/<sessioninfo/.test(head) || (/<package[\s>]/.test(head) && /<sourcefile[\s>]/.test(head)))) return 'jacoco';
    if (/<coverage[\s>]/.test(head) && /line-rate/.test(head)) return 'cobertura';
  }
  return null;
}

export function parseCoverage(text: string, format: CoverageFormat | 'auto' = 'auto'): RawCoverage {
  const fmt = format === 'auto' ? detectCoverageFormat(text) : format;
  if (!fmt) throw new CoverageParseError('auto', 'format not recognised (expected lcov, JaCoCo XML, Cobertura XML or a Go coverprofile)');
  switch (fmt) {
    case 'lcov':
      return parseLcov(text);
    case 'jacoco':
      return parseJacoco(text);
    case 'cobertura':
      return parseCobertura(text);
    case 'go':
      return parseGoCoverprofile(text);
  }
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

export interface PathContext {
  /** Absolute, forward slashes, no trailing slash. */
  rootDir: string;
  /** Repo-relative POSIX paths of tracked/source files. */
  repoFiles: ReadonlySet<string>;
  /** e.g. "/home/runner/work/app/app/", "C:/a/app/" (config coverage.pathPrefixes). */
  stripPrefixes?: string[];
  /** JaCoCo/PIT: e.g. "src/main/java" (config coverage.sourceRoots). */
  sourceRoots?: string[];
  /** From each go.mod: module path and its dir relative to root. */
  goModules?: Array<{ module: string; dir: string }>;
}

export type PathMapping = { file: string } | { reason: 'outside-root' | 'not-found' | 'ambiguous'; candidates?: string[] };

export const DEFAULT_SOURCE_ROOTS: readonly string[] = ['src/main/java', 'src/main/kotlin', 'src/main/scala'];

function slashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function upperDrive(p: string): string {
  return /^[a-zA-Z]:\//.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

const isAbsolutePath = (p: string): boolean => p.startsWith('/') || /^[A-Z]:\//.test(p);

/** basename -> repo files, built once per file set. */
const BASENAME_INDEX = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();

function basenameIndex(files: ReadonlySet<string>): Map<string, string[]> {
  let index = BASENAME_INDEX.get(files);
  if (index) return index;
  index = new Map();
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const list = index.get(base);
    if (list) list.push(f);
    else index.set(base, [f]);
  }
  BASENAME_INDEX.set(files, index);
  return index;
}

function prefixOf(prefix: string): string {
  return upperDrive(slashes(prefix)).replace(/\/+$/, '') + '/';
}

export function mapCoveragePath(raw: string, ctx: PathContext): PathMapping {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    // file:///C:/x -> C:/x, file:///abs -> /abs
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep the undecoded path */
    }
  }
  p = upperDrive(slashes(p));
  if (p.startsWith('./')) p = p.slice(2);
  if (p === '') return { reason: 'not-found' };

  const root = upperDrive(slashes(ctx.rootDir)).replace(/\/+$/, '');
  let stripped = false;
  if (p.startsWith(`${root}/`)) {
    p = p.slice(root.length + 1);
    stripped = true;
  } else {
    for (const prefix of ctx.stripPrefixes ?? []) {
      const pre = prefixOf(prefix);
      if (p.startsWith(pre)) {
        p = p.slice(pre.length);
        stripped = true;
        break;
      }
    }
  }
  if (!stripped && isAbsolutePath(p)) return { reason: 'outside-root' };

  const candidates: string[] = [p];
  // Longest module path first, so a nested module wins over its parent.
  for (const mod of [...(ctx.goModules ?? [])].sort((a, b) => b.module.length - a.module.length)) {
    if (p.startsWith(`${mod.module}/`)) {
      const rest = p.slice(mod.module.length + 1);
      candidates.unshift(mod.dir === '.' || mod.dir === '' ? rest : `${mod.dir.replace(/\/+$/, '')}/${rest}`);
      break;
    }
  }
  for (const sr of ctx.sourceRoots ?? DEFAULT_SOURCE_ROOTS) candidates.push(`${slashes(sr).replace(/\/+$/, '')}/${p}`);
  for (const c of candidates) if (ctx.repoFiles.has(c)) return { file: c };

  const base = p.slice(p.lastIndexOf('/') + 1);
  const hits = (basenameIndex(ctx.repoFiles).get(base) ?? []).filter((f) => f === p || f.endsWith(`/${p}`));
  if (hits.length === 1) return { file: hits[0] };
  if (hits.length > 1) return { reason: 'ambiguous', candidates: hits.slice(0, 5).sort() };
  return { reason: 'not-found' };
}

// ---------------------------------------------------------------------------
// Normalized evidence
// ---------------------------------------------------------------------------

/** Inclusive, sorted, non-overlapping. */
export type LineRanges = Array<[number, number]>;

export interface FileEvidence {
  /** sha256 of the file's content at ingest (same as the drift registry's hashFile). */
  hash: string;
  exec: LineRanges;
  hit: LineRanges;
  /** [line, total, covered] */
  br?: Array<[number, number, number]>;
}

export type CoverageScope =
  | { kind: 'suite' }
  | { kind: 'capability'; capability: string; selection: 'tests' | 'files'; tests: string[]; testsHash: string };

export type EvidenceOrigin = 'local' | 'ci' | 'server';

export interface CoverageEvidence {
  version: 1;
  scope: CoverageScope;
  runId: string;
  repoSha?: string;
  origin: EvidenceOrigin;
  ingestedAt: string;
  formats: CoverageFormat[];
  /** 'summary' when the size cap forced dropping line data. */
  granularity: 'lines' | 'summary';
  files: Record<string, FileEvidence>;
  summary: Record<string, { exec: number; hit: number }>;
  unmapped: { count: number; sample: string[] };
}

export const COVERAGE_MAX_BYTES = 10 * 1024 * 1024;
const UNMAPPED_SAMPLE = 50;

export function toRanges(lines: Iterable<number>): LineRanges {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: LineRanges = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

export function fromRanges(r: LineRanges): number[] {
  const out: number[] = [];
  for (const [a, b] of r) for (let n = a; n <= b; n += 1) out.push(n);
  return out;
}

/** The repo file a raw record maps to, trying its alternatives first, else why it did not map. */
function mapRaw(f: RawFileCoverage, ctx: PathContext): PathMapping {
  let first: PathMapping | undefined;
  for (const candidate of [...(f.alternatives ?? []), f.path]) {
    const m = mapCoveragePath(candidate, ctx);
    if ('file' in m) return m;
    first ??= m;
  }
  return first ?? { reason: 'not-found' };
}

/** Repo files the records of `raws` map to: what the ingest hashes before normalizing. */
export function mappedCoverageFiles(raws: RawCoverage[], ctx: PathContext): string[] {
  const out = new Set<string>();
  for (const raw of raws) for (const f of raw.files) {
    const m = mapRaw(f, ctx);
    if ('file' in m) out.add(m.file);
  }
  return [...out].sort();
}

export function normalizeCoverage(
  raws: RawCoverage[],
  ctx: PathContext,
  hashes: Record<string, string>,
  meta: Omit<CoverageEvidence, 'files' | 'summary' | 'unmapped' | 'granularity' | 'formats' | 'version'>,
): CoverageEvidence {
  interface Acc {
    exec: Set<number>;
    hit: Set<number>;
    br: Map<number, { total: number; covered: number }>;
  }
  const merged = new Map<string, Acc>();
  const unmapped = new Set<string>();
  for (const raw of raws) {
    for (const f of raw.files) {
      const m = mapRaw(f, ctx);
      if (!('file' in m)) {
        unmapped.add(f.path);
        continue;
      }
      const acc = merged.get(m.file) ?? { exec: new Set<number>(), hit: new Set<number>(), br: new Map() };
      for (const [line, hits] of f.lines) {
        acc.exec.add(line);
        if (hits > 0) acc.hit.add(line);
      }
      for (const [line, b] of f.branches) {
        const prev = acc.br.get(line);
        acc.br.set(line, { total: Math.max(prev?.total ?? 0, b.total), covered: Math.max(prev?.covered ?? 0, b.covered) });
      }
      merged.set(m.file, acc);
    }
  }
  const files: Record<string, FileEvidence> = {};
  const summary: Record<string, { exec: number; hit: number }> = {};
  for (const file of [...merged.keys()].sort()) {
    const acc = merged.get(file)!;
    const br = [...acc.br].sort((a, b) => a[0] - b[0]).map(([line, b]): [number, number, number] => [line, b.total, b.covered]);
    files[file] = { hash: hashes[file] ?? '', exec: toRanges(acc.exec), hit: toRanges(acc.hit), ...(br.length > 0 ? { br } : {}) };
    summary[file] = { exec: acc.exec.size, hit: acc.hit.size };
  }
  const sortedUnmapped = [...unmapped].sort();
  return {
    version: 1,
    ...meta,
    formats: [...new Set(raws.map((r) => r.format))].sort(),
    granularity: 'lines',
    files,
    summary,
    unmapped: { count: sortedUnmapped.length, sample: sortedUnmapped.slice(0, UNMAPPED_SAMPLE) },
  };
}

const sizeOf = (e: CoverageEvidence): number => Buffer.byteLength(JSON.stringify(e));

/** Drops branch data first, then line data (granularity 'summary'), until the evidence fits. */
export function enforceSizeCap(e: CoverageEvidence, maxBytes: number = COVERAGE_MAX_BYTES): CoverageEvidence {
  if (sizeOf(e) <= maxBytes) return e;
  const noBranches: CoverageEvidence = {
    ...e,
    files: Object.fromEntries(Object.entries(e.files).map(([f, v]) => [f, { hash: v.hash, exec: v.exec, hit: v.hit }])),
  };
  if (sizeOf(noBranches) <= maxBytes) return noBranches;
  return {
    ...noBranches,
    granularity: 'summary',
    files: Object.fromEntries(Object.entries(e.files).map(([f, v]) => [f, { hash: v.hash, exec: [], hit: [] }])),
  };
}

// ---------------------------------------------------------------------------
// Capability selection
// ---------------------------------------------------------------------------

export interface CapabilitySelection {
  /** `file::title`, sorted */
  tests: string[];
  files: string[];
  testsHash: string;
}

/** The tests tagged to a capability's claims, in a form that does not depend on the order they were found. */
export function selectCapabilityTests(claimRefs: string[], index: ClaimTestIndex): CapabilitySelection {
  const tests = new Set<string>();
  const files = new Set<string>();
  for (const ref of new Set(claimRefs)) {
    for (const entry of index.get(ref) ?? []) {
      if (entry.origin !== 'source') continue;
      files.add(entry.file);
      if (entry.title) tests.add(`${entry.file}::${entry.title}`);
    }
  }
  const sortedTests = [...tests].sort();
  const sortedFiles = [...files].sort();
  const testsHash = createHash('sha256').update(JSON.stringify([sortedTests, sortedFiles])).digest('hex');
  return { tests: sortedTests, files: sortedFiles, testsHash };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface CapabilityCoverage {
  capability: string;
  source: 'capability' | 'suite';
  selection?: 'tests' | 'files';
  evidence: { runId: string; origin: EvidenceOrigin; repoSha?: string };
  /** Owned source files (documents and data files are not counted). */
  owned: number;
  /** Owned files present and fresh. */
  reported: number;
  stale: string[];
  /** Owned source files absent from the report (at most 20 listed). */
  unreported: string[];
  unreportedCount: number;
  lines: { executable: number; hit: number; pct: number | null };
  diff?: {
    changedExecutable: number;
    hit: number;
    pct: number | null;
    missed: Array<{ file: string; lines: LineRanges }>;
    /** Changed owned files with no fresh coverage. */
    unknownFiles: string[];
  };
  unreached: { lines: number; files: Array<{ file: string; lines: LineRanges }> };
  /** What this evidence can prove. */
  claimable: { reach: boolean; unspecified: boolean };
  testsStale: boolean;
}

const NON_CODE = /\.(?:md|mdx|txt|json|ya?ml|toml|lock|svg|png|jpe?g|gif|ico|css|scss|html|csv)$/i;
const LIST_MAX = 20;

const pct = (hit: number, total: number): number | null => (total === 0 ? null : Math.round((hit / total) * 1000) / 10);

function subtract(exec: LineRanges, hit: LineRanges): LineRanges {
  const hitSet = new Set(fromRanges(hit));
  return toRanges(fromRanges(exec).filter((n) => !hitSet.has(n)));
}

export function capabilityCoverage(input: {
  capability: string;
  ownedFiles: string[];
  evidence: CoverageEvidence;
  currentHashes: Record<string, string>;
  changed?: ChangedFile[];
  currentTestsHash?: string;
}): CapabilityCoverage {
  const { evidence, currentHashes } = input;
  const owned = [...new Set(input.ownedFiles)].filter((f) => !NON_CODE.test(f)).sort();
  const isFresh = (f: string): boolean => {
    const ev = evidence.files[f];
    return ev !== undefined && currentHashes[f] !== undefined && currentHashes[f] === ev.hash;
  };
  const present = owned.filter((f) => evidence.files[f] !== undefined);
  const fresh = present.filter(isFresh);
  const stale = present.filter((f) => !isFresh(f));
  const absent = owned.filter((f) => evidence.files[f] === undefined);

  let executable = 0;
  let hit = 0;
  for (const f of fresh) {
    const s = evidence.summary[f];
    executable += s?.exec ?? 0;
    hit += s?.hit ?? 0;
  }
  const unreachedFiles: Array<{ file: string; lines: LineRanges }> = [];
  if (evidence.granularity === 'lines') {
    for (const f of fresh) {
      const missed = subtract(evidence.files[f].exec, evidence.files[f].hit);
      if (missed.length > 0) unreachedFiles.push({ file: f, lines: missed });
    }
  }

  const testsStale =
    evidence.scope.kind === 'capability' && input.currentTestsHash !== undefined && evidence.scope.testsHash !== input.currentTestsHash;
  const tested = evidence.scope.kind === 'capability' && evidence.scope.selection === 'tests' && !testsStale;

  const out: CapabilityCoverage = {
    capability: input.capability,
    source: evidence.scope.kind === 'suite' ? 'suite' : 'capability',
    ...(evidence.scope.kind === 'capability' ? { selection: evidence.scope.selection } : {}),
    evidence: { runId: evidence.runId, origin: evidence.origin, ...(evidence.repoSha ? { repoSha: evidence.repoSha } : {}) },
    owned: owned.length,
    reported: fresh.length,
    stale,
    unreported: absent.slice(0, LIST_MAX),
    unreportedCount: absent.length,
    lines: { executable, hit, pct: pct(hit, executable) },
    unreached: { lines: executable - hit, files: unreachedFiles.slice(0, LIST_MAX) },
    claimable: { reach: tested, unspecified: tested },
    testsStale,
  };

  if (input.changed) {
    const ownedSet = new Set(owned);
    let changedExecutable = 0;
    let changedHit = 0;
    const missed: Array<{ file: string; lines: LineRanges }> = [];
    const unknownFiles: string[] = [];
    for (const cf of [...input.changed].sort((a, b) => a.file.localeCompare(b.file))) {
      if (!ownedSet.has(cf.file) || cf.status === 'deleted' || cf.binary) continue;
      // With the line data dropped to a summary no changed line can be judged.
      if (!isFresh(cf.file) || evidence.granularity === 'summary') {
        unknownFiles.push(cf.file);
        continue;
      }
      const ev = evidence.files[cf.file];
      const exec = new Set(fromRanges(ev.exec));
      const hitSet = new Set(fromRanges(ev.hit));
      const executableChanged = cf.added.filter((n) => exec.has(n));
      const miss = executableChanged.filter((n) => !hitSet.has(n));
      changedExecutable += executableChanged.length;
      changedHit += executableChanged.length - miss.length;
      if (miss.length > 0) missed.push({ file: cf.file, lines: toRanges(miss) });
    }
    out.diff = { changedExecutable, hit: changedHit, pct: pct(changedHit, changedExecutable), missed, unknownFiles };
  }
  return out;
}

/** Number of lines a range list covers (for reports). */
export function countRangeLines(r: LineRanges): number {
  return r.reduce((n, [a, b]) => n + (b - a + 1), 0);
}
