/**
 * Normalized test results and the per-claim aggregation rule.
 *
 * Parsers read reporter OUTPUT FILES (never stdout scraping) and cover every
 * test, not only failures.
 *
 * Spec: specs/core/test-results.md
 */
import { XMLParser } from 'fast-xml-parser';

import { extractClaimRefs } from './claim-tags.js';

export type TestStatus = 'pass' | 'fail' | 'skip';

export interface TestCaseResult {
  file: string;
  title: string;
  fullTitle: string;
  status: TestStatus;
  durationMs: number;
  tags: string[];
  claims: string[];
  externalIds: string[];
  /** Failure message when status is fail. Not part of the identity of a test. */
  message?: string;
}

export const RESULT_FORMATS = ['vitest', 'jest', 'playwright', 'junit', 'pytest', 'go', 'cargo'] as const;
export type ResultFormat = (typeof RESULT_FORMATS)[number];

export class ResultParseError extends Error {
  constructor(public readonly format: string, detail: string) {
    super(`cannot parse ${format} results: ${detail}`);
    this.name = 'ResultParseError';
  }
}

// ---------------------------------------------------------------------------
// Tag, claim, and external-id extraction shared by every parser
// ---------------------------------------------------------------------------

const EXT_TAG = /@(?:ext|id|externalId):([A-Za-z0-9_.:/-]+)/g;
const AT_TAG = /(?:^|\s)(@[A-Za-z0-9_][A-Za-z0-9_.:/#-]*)/g;

interface RawTest {
  file: string;
  title: string;
  fullTitle: string;
  status: TestStatus;
  durationMs: number;
  tags?: string[];
  annotations?: Array<{ type?: string; description?: string }>;
  properties?: Array<{ name: string; value: string }>;
  message?: string;
}

function finish(raw: RawTest): TestCaseResult {
  const tags = new Set<string>();
  for (const tag of raw.tags ?? []) tags.add(tag.startsWith('@') ? tag : `@${tag}`);
  const text = `${raw.fullTitle} ${raw.title}`;
  for (const match of text.matchAll(AT_TAG)) tags.add(match[1].replace(/[.,;]+$/, ''));

  const claimSources = [text, ...[...tags]];
  const externalIds = new Set<string>();
  for (const source of [text, ...tags]) {
    for (const match of source.matchAll(EXT_TAG)) externalIds.add(match[1]);
  }
  for (const note of raw.annotations ?? []) {
    const type = (note.type ?? '').toLowerCase();
    const value = (note.description ?? '').trim();
    if (!value) continue;
    if (type === 'claim' || type === 'specguard-claim') claimSources.push(`@claim:${value}`);
    else if (['externalid', 'external-id', 'zephyr', 'jira', 'testcase', 'issue'].includes(type)) externalIds.add(value);
    else if (type === 'tag') tags.add(value.startsWith('@') ? value : `@${value}`);
  }
  for (const prop of raw.properties ?? []) {
    const name = prop.name.toLowerCase();
    if (name === 'claim' || name === 'specguard-claim') claimSources.push(`@claim:${prop.value}`);
    else if (name === 'externalid' || name === 'external-id') externalIds.add(prop.value);
    else if (name === 'tag') tags.add(prop.value.startsWith('@') ? prop.value : `@${prop.value}`);
  }
  const claims = new Set<string>();
  for (const source of claimSources) for (const ref of extractClaimRefs(source)) claims.add(ref);
  return {
    file: raw.file,
    title: raw.title,
    fullTitle: raw.fullTitle,
    status: raw.status,
    durationMs: Math.max(0, Math.round(raw.durationMs || 0)),
    tags: [...tags],
    claims: [...claims],
    externalIds: [...externalIds],
    ...(raw.status === 'fail' && raw.message ? { message: raw.message } : {}),
  };
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(format: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ResultParseError(format, `invalid JSON (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// Vitest / Jest
// ---------------------------------------------------------------------------

export function parseVitestResults(text: string, format: 'vitest' | 'jest' = 'vitest'): TestCaseResult[] {
  const doc = parseJson(format, text);
  if (!isObject(doc) || !Array.isArray(doc.testResults)) {
    throw new ResultParseError(format, 'no testResults array');
  }
  const out: TestCaseResult[] = [];
  for (const suite of doc.testResults) {
    if (!isObject(suite)) continue;
    const file = str(suite.name ?? suite.testFilePath);
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    for (const a of assertions) {
      if (!isObject(a)) continue;
      const status = str(a.status);
      const mapped: TestStatus = status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'skip';
      const title = str(a.title ?? a.fullName, '(unnamed test)');
      const ancestors = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(String) : [];
      const fullTitle = str(a.fullName) || [...ancestors, title].join(' ');
      out.push(
        finish({
          file,
          title,
          fullTitle,
          status: mapped,
          durationMs: num(a.duration),
          message: Array.isArray(a.failureMessages) ? a.failureMessages.map(String).join('\n') : undefined,
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Playwright
// ---------------------------------------------------------------------------

export function parsePlaywrightResults(text: string): TestCaseResult[] {
  const doc = parseJson('playwright', text);
  if (!isObject(doc) || !Array.isArray(doc.suites)) throw new ResultParseError('playwright', 'no suites array');
  const out: TestCaseResult[] = [];

  const walk = (suite: Record<string, unknown>, trail: string[], inheritedFile: string) => {
    const file = str(suite.file, inheritedFile);
    const title = str(suite.title);
    // A file-level suite is titled with the file name; it is not part of the test name.
    const next = title && title !== file && title !== inheritedFile ? [...trail, title] : trail;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObject(spec)) continue;
      const specTitle = str(spec.title, '(unnamed test)');
      const specFile = str(spec.file, file);
      const specTags = Array.isArray(spec.tags) ? spec.tags.map(String) : [];
      for (const t of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isObject(t)) continue;
        const results = Array.isArray(t.results) ? t.results.filter(isObject) : [];
        const outcome = str(t.status);
        const expected = str(t.expectedStatus, 'passed');
        let status: TestStatus;
        if (outcome === 'unexpected') status = 'fail';
        else if (outcome === 'skipped' || expected === 'skipped') status = 'skip';
        else if (outcome === 'expected' || outcome === 'flaky') status = 'pass';
        else status = results.every((r) => str(r.status) === 'passed') && results.length > 0 ? 'pass' : 'fail';
        const duration = results.reduce((sum, r) => sum + num(r.duration), 0);
        const lastError = [...results].reverse().find((r) => isObject(r.error));
        const project = str(t.projectName);
        const annotations = Array.isArray(t.annotations)
          ? t.annotations.filter(isObject).map((n) => ({ type: str(n.type), description: str(n.description) }))
          : [];
        const tagList = [...specTags];
        if (outcome === 'flaky') tagList.push('@flaky');
        out.push(
          finish({
            file: specFile,
            title: specTitle,
            fullTitle: [...next, specTitle].join(' '),
            status,
            durationMs: duration,
            tags: tagList,
            annotations: project ? [...annotations, { type: 'tag', description: `project-${project}` }] : annotations,
            message: lastError && isObject(lastError.error) ? str(lastError.error.message) : undefined,
          }),
        );
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
      if (isObject(child)) walk(child, next, file);
    }
  };
  for (const suite of doc.suites) if (isObject(suite)) walk(suite, [], '');
  return out;
}

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseJunitResults(text: string): TestCaseResult[] {
  let doc: Record<string, unknown>;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      isArray: (name) => ['testsuite', 'testcase', 'property'].includes(name),
    }).parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ResultParseError('junit', (err as Error).message);
  }
  if (!doc || (!doc.testsuites && !doc.testsuite)) throw new ResultParseError('junit', 'no testsuite element');
  const out: TestCaseResult[] = [];

  const walkSuite = (suite: Record<string, unknown>) => {
    const suiteName = str(suite['@_name']);
    for (const tc of asArray(suite.testcase as Record<string, unknown>[] | undefined)) {
      const name = str(tc['@_name'], '(unnamed test)');
      const classname = str(tc['@_classname']);
      const file = str(tc['@_file']) || str(suite['@_file']) || classname.replace(/\./g, '/') || suiteName;
      let status: TestStatus = 'pass';
      let message: string | undefined;
      if (tc.failure !== undefined || tc.error !== undefined) {
        status = 'fail';
        const node = asArray((tc.failure ?? tc.error) as unknown)[0];
        message = isObject(node) ? str(node['@_message']) || str(node['#text']) : str(node);
      } else if (tc.skipped !== undefined) {
        status = 'skip';
      }
      const props = isObject(tc.properties)
        ? asArray(tc.properties.property as Array<Record<string, unknown>> | undefined).map((p) => ({
            name: str(p['@_name']),
            value: str(p['@_value'] ?? p['#text']),
          }))
        : [];
      out.push(
        finish({
          file,
          title: name,
          fullTitle: classname ? `${classname} ${name}` : name,
          status,
          durationMs: num(tc['@_time']) * 1000,
          properties: props,
          message,
        }),
      );
    }
    for (const child of asArray(suite.testsuite as Record<string, unknown>[] | undefined)) walkSuite(child);
  };

  const roots: Record<string, unknown>[] = [];
  if (isObject(doc.testsuites)) {
    roots.push(...asArray((doc.testsuites as Record<string, unknown>).testsuite as Record<string, unknown>[] | undefined));
  } else if (doc.testsuites === '' || doc.testsuites === undefined) {
    roots.push(...asArray(doc.testsuite as Record<string, unknown>[] | undefined));
  }
  for (const suite of roots) walkSuite(suite);
  return out;
}

// ---------------------------------------------------------------------------
// pytest-json-report
// ---------------------------------------------------------------------------

export function parsePytestResults(text: string): TestCaseResult[] {
  const doc = parseJson('pytest', text);
  if (!isObject(doc) || !Array.isArray(doc.tests)) throw new ResultParseError('pytest', 'no tests array');
  const out: TestCaseResult[] = [];
  for (const t of doc.tests) {
    if (!isObject(t)) continue;
    const nodeid = str(t.nodeid);
    const sep = nodeid.indexOf('::');
    const file = sep === -1 ? nodeid : nodeid.slice(0, sep);
    const name = sep === -1 ? nodeid || '(unnamed test)' : nodeid.slice(sep + 2);
    const outcome = str(t.outcome);
    const status: TestStatus =
      outcome === 'passed' || outcome === 'xpassed' ? 'pass' : outcome === 'skipped' || outcome === 'xfailed' ? 'skip' : 'fail';
    const phases = ['setup', 'call', 'teardown'].map((p) => t[p]).filter(isObject);
    const duration = phases.reduce((sum, p) => sum + num(p.duration), 0) * 1000;
    const call = isObject(t.call) ? t.call : undefined;
    const message = call ? str(call.longrepr) || (isObject(call.crash) ? str(call.crash.message) : '') : '';
    const keywords = Array.isArray(t.keywords) ? t.keywords.map(String).filter((k) => k.startsWith('@')) : [];
    const meta = isObject(t.metadata) ? t.metadata : {};
    const annotations: Array<{ type: string; description: string }> = [];
    for (const [key, value] of Object.entries(meta)) {
      for (const v of asArray(value as unknown)) annotations.push({ type: key, description: str(v) });
    }
    out.push(
      finish({
        file,
        title: name,
        fullTitle: nodeid,
        status,
        durationMs: duration,
        tags: keywords,
        annotations,
        message: message || undefined,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// go test -json and cargo test JSON
// ---------------------------------------------------------------------------

function jsonLines(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isObject(parsed)) rows.push(parsed);
    } catch {
      /* non-JSON noise between events */
    }
  }
  return rows;
}

export function parseGoResults(text: string): TestCaseResult[] {
  const rows = jsonLines(text).filter((row) => 'Action' in row);
  if (rows.length === 0) throw new ResultParseError('go', 'no go test -json events');
  const out = new Map<string, RawTest & { output: string[] }>();
  for (const row of rows) {
    const test = str(row.Test);
    if (!test) continue;
    const pkg = str(row.Package);
    const key = `${pkg}::${test}`;
    const entry = out.get(key) ?? {
      file: pkg,
      title: test,
      fullTitle: test.replace(/\//g, ' '),
      status: 'skip' as TestStatus,
      durationMs: 0,
      output: [],
    };
    const action = str(row.Action);
    if (action === 'output') entry.output.push(str(row.Output));
    else if (action === 'pass') entry.status = 'pass';
    else if (action === 'fail') entry.status = 'fail';
    else if (action === 'skip') entry.status = 'skip';
    if (action === 'pass' || action === 'fail' || action === 'skip') entry.durationMs = num(row.Elapsed) * 1000;
    out.set(key, entry);
  }
  // A parent test passes or fails with its subtests; keep both rows, they are distinct tests.
  return [...out.values()].map((entry) => finish({ ...entry, message: entry.output.join('').trim() || undefined }));
}

export function parseCargoResults(text: string): TestCaseResult[] {
  const rows = jsonLines(text).filter((row) => row.type === 'test' && typeof row.name === 'string');
  if (rows.length === 0) throw new ResultParseError('cargo', 'no cargo test json events');
  const out: TestCaseResult[] = [];
  for (const row of rows) {
    const event = str(row.event);
    if (event === 'started') continue;
    const name = str(row.name);
    const sep = name.lastIndexOf('::');
    out.push(
      finish({
        file: sep === -1 ? '' : name.slice(0, sep),
        title: sep === -1 ? name : name.slice(sep + 2),
        fullTitle: name,
        status: event === 'ok' ? 'pass' : event === 'ignored' ? 'skip' : 'fail',
        durationMs: num(row.exec_time) * 1000,
        message: str(row.stdout) || undefined,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detection and dispatch
// ---------------------------------------------------------------------------

/** Recognise the reporter format from file content. Returns null when unknown. */
export function detectResultFormat(text: string): ResultFormat | null {
  const head = text.trimStart();
  if (head.startsWith('<')) return /<testsuites?\b/.test(head.slice(0, 4000)) ? 'junit' : null;
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      const doc = JSON.parse(head);
      if (isObject(doc)) {
        if (Array.isArray(doc.testResults)) return 'vitest';
        if (Array.isArray(doc.suites) && ('config' in doc || 'stats' in doc || doc.suites.some((s) => isObject(s) && ('specs' in s || 'suites' in s)))) return 'playwright';
        if (Array.isArray(doc.tests) && doc.tests.some((t) => isObject(t) && 'nodeid' in t)) return 'pytest';
      }
      return null;
    } catch {
      /* fall through to JSON lines */
    }
    const rows = jsonLines(head);
    if (rows.some((r) => 'Action' in r)) return 'go';
    if (rows.some((r) => r.type === 'test')) return 'cargo';
  }
  return null;
}

export function parseResults(text: string, format: ResultFormat | 'auto' = 'auto'): TestCaseResult[] {
  const resolved = format === 'auto' ? detectResultFormat(text) : format;
  if (!resolved) throw new ResultParseError('auto', 'unrecognised results format');
  switch (resolved) {
    case 'vitest':
    case 'jest':
      return parseVitestResults(text, resolved);
    case 'playwright':
      return parsePlaywrightResults(text);
    case 'junit':
      return parseJunitResults(text);
    case 'pytest':
      return parsePytestResults(text);
    case 'go':
      return parseGoResults(text);
    case 'cargo':
      return parseCargoResults(text);
  }
}

// ---------------------------------------------------------------------------
// Per-claim aggregation
// ---------------------------------------------------------------------------

export type ClaimVerdict = 'proven' | 'failed' | 'unexercised';

export interface ClaimAggregate {
  claim: string;
  verdict: ClaimVerdict;
  exercised: number;
  counterexamples: number;
  /** Titles of failing tests. */
  failures: string[];
  tests: Array<{ file: string; title: string; status: TestStatus }>;
}

/** Fold test results into one verdict per claim ref. */
export function aggregateClaims(results: TestCaseResult[]): ClaimAggregate[] {
  const byClaim = new Map<string, ClaimAggregate>();
  for (const result of results) {
    for (const claim of result.claims) {
      const agg =
        byClaim.get(claim) ??
        ({ claim, verdict: 'unexercised', exercised: 0, counterexamples: 0, failures: [], tests: [] } as ClaimAggregate);
      agg.tests.push({ file: result.file, title: result.title, status: result.status });
      if (result.status === 'pass') agg.exercised += 1;
      else if (result.status === 'fail') {
        agg.counterexamples += 1;
        agg.failures.push(result.fullTitle || result.title);
      }
      byClaim.set(claim, agg);
    }
  }
  for (const agg of byClaim.values()) {
    agg.verdict = agg.counterexamples > 0 ? 'failed' : agg.exercised > 0 ? 'proven' : 'unexercised';
  }
  return [...byClaim.values()].sort((a, b) => a.claim.localeCompare(b.claim));
}
