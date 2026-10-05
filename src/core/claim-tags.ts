/**
 * Claim tags: the deterministic link between a test and an acceptance claim.
 *
 * Forms accepted anywhere in a test title, tag, annotation, or source line:
 *   @claim:core/awards#award-once
 *   [claim: core/awards#award-once]
 *   [claims: core/awards#award-once, core/awards#no-dupes]
 *
 * Spec: specs/core/claim-tags.md
 */
import { readFileSync } from 'node:fs';

import { parseClaimRef } from './claims.js';

const REF_BODY = String.raw`(?:[A-Za-z0-9_-]+:)?[A-Za-z0-9_./-]*[A-Za-z0-9_]#[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*`;
const AT_TAG = new RegExp(String.raw`@claim:(${REF_BODY})`, 'g');
const BRACKET = new RegExp(String.raw`\[claims?:\s*([^\]]+)\]`, 'gi');
const REF_ONLY = new RegExp(`^${REF_BODY}$`);

/** The exact tag string to place in a test title. */
export function claimTag(ref: string): string {
  return `@claim:${ref}`;
}

function normalize(ref: string): string | null {
  const trimmed = ref.trim().replace(/[.,;]+$/, '');
  if (!REF_ONLY.test(trimmed)) return null;
  const parsed = parseClaimRef(trimmed);
  if (!parsed) return null;
  const left = parsed.repo ? `${parsed.repo}:${parsed.specKey}` : parsed.specKey;
  return `${left}#${parsed.claimId}`;
}

/** Every claim ref named in `text`, de-duplicated, in order of appearance. */
export function extractClaimRefs(text: string): string[] {
  const found: Array<{ index: number; ref: string }> = [];
  for (const match of text.matchAll(AT_TAG)) {
    const ref = normalize(match[1]);
    if (ref) found.push({ index: match.index ?? 0, ref });
  }
  for (const match of text.matchAll(BRACKET)) {
    for (const part of match[1].split(',')) {
      const ref = normalize(part);
      if (ref) found.push({ index: match.index ?? 0, ref });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((row) => row.ref))];
}

export interface ClaimTagHit {
  ref: string;
  file: string;
  line: number;
  /** Test title on the same line, when one can be read. */
  title?: string;
}

const TITLE_ON_LINE = /\b(?:it|test|describe|specify|scenario)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
const PY_DEF = /^\s*(?:async\s+)?def\s+(test\w*)/;
const GO_FUNC = /^\s*func\s+(Test\w*)/;
const RUST_FN = /^\s*(?:async\s+)?fn\s+(\w+)/;

/** Scan one source file's text for claim tags. */
export function scanSourceForClaimTags(source: string, file: string): ClaimTagHit[] {
  const hits: ClaimTagHit[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const refs = extractClaimRefs(line);
    if (refs.length === 0) return;
    const title =
      line.match(TITLE_ON_LINE)?.[2] ??
      nextDeclaration(lines, index) ??
      undefined;
    for (const ref of refs) hits.push({ ref, file, line: index + 1, title });
  });
  return hits;
}

function nextDeclaration(lines: string[], from: number): string | undefined {
  for (let i = from; i < Math.min(lines.length, from + 4); i += 1) {
    const line = lines[i];
    const title = line.match(TITLE_ON_LINE)?.[2];
    if (title) return title;
    const decl = line.match(PY_DEF) ?? line.match(GO_FUNC) ?? line.match(RUST_FN);
    if (decl) return decl[1];
  }
  return undefined;
}

export interface ClaimTestEntry {
  file: string;
  line?: number;
  title?: string;
  /** `source` for a tag in a test file, `result` for a tag in a results file. */
  origin: 'source' | 'result';
  status?: 'pass' | 'fail' | 'skip';
}

export type ClaimTestIndex = Map<string, ClaimTestEntry[]>;

export interface IndexInput {
  /** Absolute paths of test source files. */
  testFiles?: string[];
  /** Normalized results (see test-results.ts) already parsed. */
  results?: Array<{ file: string; title: string; status: 'pass' | 'fail' | 'skip'; claims: string[] }>;
  /** Path made relative to this directory in the index. */
  rootDir?: string;
}

function relPosix(rootDir: string | undefined, abs: string): string {
  if (!rootDir) return abs.split('\\').join('/');
  const rel = abs.startsWith(rootDir) ? abs.slice(rootDir.length).replace(/^[\\/]+/, '') : abs;
  return rel.split('\\').join('/');
}

/** Build `claim ref -> tests` from test sources and parsed result rows. */
export function buildClaimTestIndex(input: IndexInput): ClaimTestIndex {
  const index: ClaimTestIndex = new Map();
  const push = (ref: string, entry: ClaimTestEntry) => {
    const list = index.get(ref) ?? [];
    list.push(entry);
    index.set(ref, list);
  };
  for (const abs of input.testFiles ?? []) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const hit of scanSourceForClaimTags(text, abs)) {
      push(hit.ref, { file: relPosix(input.rootDir, abs), line: hit.line, title: hit.title, origin: 'source' });
    }
  }
  for (const row of input.results ?? []) {
    for (const ref of row.claims) {
      push(ref, { file: row.file, title: row.title, origin: 'result', status: row.status });
    }
  }
  return index;
}
