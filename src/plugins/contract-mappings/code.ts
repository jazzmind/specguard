/**
 * The code half of `contracts-map`: find client calls and endpoint definitions with the extractors, map the
 * files to the specs that own them, and match calls to definitions.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BUILTIN_EXTRACTORS } from '../../core/endpoints/extractors/index.js';
import { DEFAULT_BASE_PREFIXES, matchScore, normalizePath } from '../../core/endpoints/normalize.js';
import type { EndpointCall, EndpointDef, EndpointExtractor } from '../../core/endpoints/types.js';
import { expandGlobs, readFile } from '../../core/reader.js';
import { buildSpecGraph } from '../../core/spec-graph.js';
import type { WorkspaceRepoWithConfig } from '../../core/workspace.js';
import type { CatalogueSpec } from './catalogue.js';
import type { Suggestion } from './merge.js';

const MAX_FILE_CHARS = 400_000;
const MAX_FILES_PER_EXTRACTOR = 6000;

/** Patterns that suggest a source file holds a secret: such a file is never sent to a model. */
export const SECRET_FILE_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/,
  /process\.env\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
];

export const looksSecret = (text: string): boolean => SECRET_FILE_PATTERNS.some((re) => re.test(text));

export interface RepoCode {
  calls: EndpointCall[];
  defs: EndpointDef[];
}

/** Reads one repo with the extractors. `wantCalls` / `wantDefs` skip work the caller will not use. */
export async function scanRepo(
  repo: WorkspaceRepoWithConfig,
  extractors: readonly EndpointExtractor[],
  want: { calls: boolean; defs: boolean },
): Promise<RepoCode> {
  const seen = new Set<string>();
  const out: RepoCode = { calls: [], defs: [] };
  for (const extractor of extractors) {
    const useCalls = want.calls && extractor.calls;
    const useDefs = want.defs && extractor.defs;
    if (!useCalls && !useDefs) continue;
    const files = (await expandGlobs(extractor.globs, codeRootOf(repo))).slice(0, MAX_FILES_PER_EXTRACTOR);
    for (const abs of files) {
      let text: string;
      try {
        text = (await readFile(abs)).slice(0, MAX_FILE_CHARS);
      } catch {
        continue;
      }
      const file = path.relative(repo.absPath, abs).split(path.sep).join('/');
      for (const hit of useCalls ? extractor.calls!(text, file) : []) {
        const key = `c|${file}|${hit.line}|${hit.method}|${hit.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.calls.push({ ...hit, file });
      }
      for (const hit of useDefs ? extractor.defs!(text, file) : []) {
        const key = `d|${file}|${hit.line}|${hit.method}|${hit.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.defs.push({ ...hit, file, source: extractor.id });
      }
    }
  }
  return out;
}

/**
 * Where a repo's code lives. An overlay keeps specs in one folder and names the code with the app's `repo`
 * (resolved from the config's root); otherwise the code is the repo itself. Scanned file paths stay relative
 * to the workspace repo, so they line up with owned files (which may lead outside it, `../code/src/x.ts`).
 */
export function codeRootOf(repo: WorkspaceRepoWithConfig): string {
  const appRepo = repo.specGuardConfig?.apps[0]?.repo;
  if (!appRepo) return repo.absPath;
  return path.isAbsolute(appRepo) ? appRepo : path.resolve(repo.specGuardConfig?.rootDir ?? repo.absPath, appRepo);
}

export const allExtractors = (fromPlugins: EndpointExtractor[]): EndpointExtractor[] => [...BUILTIN_EXTRACTORS, ...fromPlugins];

/** Which specs own a file: spec-graph owned files, then the repo's trace, then a v1 spec's `module:` paths. */
export interface Ownership {
  /** Repo-relative paths of the specs owning a file (repo-relative POSIX). */
  specsFor(file: string): string[];
}

export async function ownershipOf(repo: WorkspaceRepoWithConfig, specs: CatalogueSpec[]): Promise<Ownership> {
  const byKey = new Map<string, string>();
  for (const s of specs) {
    byKey.set(s.key, s.relPath);
    if (s.id) byKey.set(s.id, s.relPath);
  }
  const owners = new Map<string, Set<string>>();
  const add = (file: string, spec: string): void => {
    const set = owners.get(file) ?? new Set<string>();
    set.add(spec);
    owners.set(file, set);
  };
  const root = repo.specGuardConfig?.rootDir ?? repo.absPath;
  // Owned files are relative to the config's root, which may be a folder above or below the repo.
  const toRepo = (rootRel: string): string => path.relative(repo.absPath, path.resolve(root, rootRel)).split(path.sep).join('/');
  if (repo.specGuardConfig) {
    try {
      const graph = await buildSpecGraph(repo.specGuardConfig);
      for (const node of graph.nodes.values()) {
        const spec = byKey.get(node.id) ?? byKey.get(node.specKey);
        if (!spec) continue;
        for (const file of node.ownedFiles) add(toRepo(file), spec);
      }
    } catch {
      /* fall through to the trace */
    }
  }
  const tracePath = path.join(root, '.specguard/trace.json');
  if (existsSync(tracePath)) {
    try {
      const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as { nodes?: Array<{ id?: string; specKey?: string; ownedFiles?: string[] }> };
      for (const node of trace.nodes ?? []) {
        const spec = byKey.get(node.id ?? '') ?? byKey.get(node.specKey ?? '');
        if (spec) for (const file of node.ownedFiles ?? []) add(toRepo(file), spec);
      }
    } catch {
      /* a broken trace owns nothing */
    }
  }
  // A v1 spec names its source in free text (`module: src/orders/list.ts`); a file or folder it names owns the files below it.
  const modules: Array<{ spec: string; tokens: string[] }> = [];
  for (const s of specs) {
    try {
      const head = readFileSync(s.abs, 'utf8').match(/<!--([\s\S]*?)-->/)?.[1] ?? '';
      const mod = head.match(/\bmodule:\s*([^\n/]*(?:\/[^\n]*)?)/)?.[1];
      const tokens = (mod ?? '').split(/[\s,]+/).filter((t) => t.includes('/') || /\.\w+$/.test(t));
      const codeRoot = codeRootOf(repo);
      const toRepoFromCode = (t: string): string => path.relative(repo.absPath, path.resolve(codeRoot, t)).split(path.sep).join('/');
      if (tokens.length > 0) modules.push({ spec: s.relPath, tokens: tokens.map((t) => toRepoFromCode(t.replace(/^\.\//, '').replace(/\/+$/, ''))) });
    } catch {
      /* skip */
    }
  }
  return {
    specsFor(file) {
      const found = new Set(owners.get(file) ?? []);
      for (const m of modules) {
        if (m.tokens.some((t) => file === t || file.startsWith(`${t}/`))) found.add(m.spec);
      }
      return [...found].sort();
    },
  };
}

export interface CodeMatch {
  call: EndpointCall;
  def: EndpointDef;
  score: number;
  /** Other provider repos that define the same endpoint, when nothing settles which one the call reaches. */
  ambiguousWith?: string[];
}

/** Ceiling for a call whose endpoint more than one provider repo defines: kept at the default minimum, flagged. */
export const AMBIGUOUS_CODE_SCORE = 0.6;

const lastSegment = (p: string, prefixes: string[]): string => normalizePath(p, prefixes).at(-1) ?? '';

/** Every call matched to its best definition in each provider repo. */
export function matchCode(
  calls: EndpointCall[],
  defsByRepo: Map<string, EndpointDef[]>,
  basePrefixes: string[] = DEFAULT_BASE_PREFIXES,
  baseRepos: Record<string, string> = {},
): Map<string, CodeMatch[]> {
  const out = new Map<string, CodeMatch[]>();
  for (const [repo, defs] of defsByRepo) {
    const buckets = new Map<string, EndpointDef[]>();
    for (const def of defs) {
      const key = lastSegment(def.path, basePrefixes);
      buckets.set(key, [...(buckets.get(key) ?? []), def]);
    }
    const matches: CodeMatch[] = [];
    for (const call of calls) {
      let best: CodeMatch | null = null;
      for (const def of buckets.get(lastSegment(call.path, basePrefixes)) ?? []) {
        const score = matchScore(call, def, basePrefixes);
        if (score > 0 && (!best || score > best.score)) best = { call, def, score };
      }
      if (best) matches.push(best);
    }
    out.set(repo, matches);
  }
  // The same endpoint in several provider repos (a fork, a shared API): the call's base settles it when
  // `baseRepos` names its repo; otherwise every match is kept but flagged and capped.
  const reposByCall = new Map<EndpointCall, string[]>();
  for (const [repo, ms] of out) for (const m of ms) reposByCall.set(m.call, [...(reposByCall.get(m.call) ?? []), repo]);
  for (const [repo, ms] of out) {
    out.set(
      repo,
      ms.flatMap((m) => {
        const all = reposByCall.get(m.call) ?? [];
        if (all.length < 2) return [m];
        const settled = m.call.baseKey ? baseRepos[m.call.baseKey] : undefined;
        if (settled && all.includes(settled)) return settled === repo ? [m] : [];
        return [{ ...m, score: Math.min(m.score, AMBIGUOUS_CODE_SCORE), ambiguousWith: all.filter((r) => r !== repo).sort() }];
      }),
    );
  }
  return out;
}

export const evidenceOf = (call: EndpointCall): string => `${call.file}:${call.line} ${call.method ?? 'ANY'} ${call.path}`;

/** Suggestions from code matches: consumer file's owning specs to provider file's owning specs. */
export function suggestionsFromCode(
  matches: CodeMatch[],
  consumerOwn: Ownership,
  providerOwn: Ownership,
  providerRepoAbs: string,
  consumerRepoAbs: string,
): Map<string, Suggestion[]> {
  const best = new Map<string, Suggestion>();
  for (const m of matches) {
    const consumers = consumerOwn.specsFor(m.call.file);
    const providers = providerOwn.specsFor(m.def.file);
    for (const consumer of consumers) {
      for (const provider of providers) {
        const rel = path.relative(consumerRepoAbs, path.join(providerRepoAbs, provider)).split(path.sep).join('/');
        const key = `${consumer}|${rel}`;
        const prev = best.get(key);
        if (prev && prev.confidence >= m.score) continue;
        best.set(key, {
          provider: rel,
          source: 'code',
          confidence: m.score,
          reason: `calls ${m.def.method ?? 'ANY'} ${m.def.path}, defined in ${m.def.file}${
            m.ambiguousWith ? `; also defined in ${m.ambiguousWith.join(', ')} (set contractMappings.baseRepos to settle it)` : ''
          }`,
          evidence: evidenceOf(m.call),
        });
      }
    }
  }
  const bySpec = new Map<string, Suggestion[]>();
  for (const [key, s] of best) {
    const spec = key.slice(0, key.indexOf('|'));
    bySpec.set(spec, [...(bySpec.get(spec) ?? []), s]);
  }
  return bySpec;
}
