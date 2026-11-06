/**
 * `specguard contracts-map`: propose the consumer-to-provider spec mappings that `contracts` turns into
 * edges, so nobody writes them by hand. Spec text first (no model), then optionally a model for the specs
 * the text did not settle, and optionally the code (client calls matched to endpoint definitions).
 *
 * Writes `.specguard/contract-mappings.json` in each consumer repo, merged with what is there: hand-written
 * entries are never touched (see merge.ts).
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import path from 'node:path';

import { DEFAULT_BASE_PREFIXES, normalizePath } from '../../core/endpoints/normalize.js';
import type { EndpointCall, EndpointDef } from '../../core/endpoints/types.js';
import { ExitCode } from '../../core/exit-codes.js';
import { fileExists, readFile } from '../../core/reader.js';
import type { PipelineResult, SpecGuardConfig } from '../../core/types.js';
import { emptyResult } from '../../core/types.js';
import { loadWorkspaceWithConfigs, workspaceHint, type WorkspaceRepoWithConfig } from '../../core/workspace.js';
import { writeFile } from '../../core/writer.js';
import { loadPlugins } from '../index.js';
import { workspacePlugins } from '../commands.js';
import { DEFAULT_MAX_LLM_SPECS } from '../../pipelines/contracts.js';
import {
  allExtractors,
  looksSecret,
  matchCode,
  ownershipOf,
  scanRepo,
  suggestionsFromCode,
  type Ownership,
  type RepoCode,
} from './code.js';
import { loadRepoCatalogue, matchSpecText, type ConsumerSpec } from './catalogue.js';
import { DEFAULT_MAPPINGS_FILE } from './index.js';
import { askCatalogue, buildPrompt, egressNotice, redact } from './llm-pass.js';
import { mergeMappings, type MappingKeys, type Proposal, type Suggestion } from './merge.js';

export interface MapOpts {
  workspace?: string;
  repo?: string;
  dryRun?: boolean;
  minConfidence?: number | string;
  withLlm?: boolean;
  maxLlmSpecs?: number | string;
  allSpecs?: boolean;
  withCode?: boolean;
  sendCode?: boolean;
  assess?: boolean;
}

export const DEFAULT_MIN_CONFIDENCE = 0.6;

const num = (v: number | string | undefined, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Repos a consumer may depend on: the consumer's `contractMappings.providerRepos` when set, else those with role `provider` when any repo has that role (sibling
 * consumers often share titles without depending on each other), otherwise every other repo.
 */
export function providerRepos(repos: WorkspaceRepoWithConfig[], self: string): WorkspaceRepoWithConfig[] {
  const named = repos.find((r) => r.key === self)?.specGuardConfig?.contractMappings?.providerRepos;
  if (named && named.length > 0) return repos.filter((r) => r.key !== self && named.includes(r.key));
  const marked = repos.some((r) => r.role === 'provider');
  return repos.filter((r) => r.key !== self && (!marked || r.role === 'provider'));
}

/** Consumer repos: those with role `consumer`, or every repo when none has that role. */
export function consumerRepos(repos: WorkspaceRepoWithConfig[], only?: string): WorkspaceRepoWithConfig[] {
  const marked = repos.filter((r) => r.role === 'consumer');
  const pool = marked.length > 0 ? marked : repos;
  return only ? pool.filter((r) => r.key === only) : pool;
}

const keysOf = (config: SpecGuardConfig | null): MappingKeys => {
  const m = config?.contractMappings ?? {};
  return { list: m.list ?? 'mappings', spec: m.spec ?? 'spec', providers: m.providers?.[0] ?? 'providers' };
};

const mappingsFile = (repo: WorkspaceRepoWithConfig): string =>
  path.join(repo.absPath, repo.specGuardConfig?.contractMappings?.file ?? DEFAULT_MAPPINGS_FILE);

async function readExisting(file: string): Promise<{ data: Record<string, unknown> | null; broken: boolean }> {
  if (!(await fileExists(file))) return { data: null, broken: false };
  try {
    const parsed: unknown = JSON.parse(await readFile(file));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { data: parsed as Record<string, unknown>, broken: false }
      : { data: null, broken: true };
  } catch {
    return { data: null, broken: true };
  }
}

/** A path as a regular expression over text: literal segments as written, parameters as any word. */
function pathPattern(p: string, prefixes: string[]): RegExp | null {
  const segs = normalizePath(p, prefixes);
  if (segs.length === 0 || segs.every((s) => s === '{}')) return null;
  const body = segs.map((s) => (s === '{}' ? '[^/\\s]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`/${body}`, 'i');
}

interface Assessment {
  specs: number;
  unmatched: number;
  calls: number;
  named: number;
  unowned: number;
  /** Calls in a file some spec owns, not named in that spec's text: what code could add. */
  notReflected: number;
  defsByRepo: Record<string, number>;
}

export function recommend(a: Assessment): string {
  const defs = Object.values(a.defsByRepo).reduce((x, y) => x + y, 0);
  if (defs === 0) return "code won't help: no provider endpoint definitions found";
  const pct = a.specs === 0 ? 0 : (a.unmatched / a.specs) * 100;
  if (pct >= 30 && a.notReflected >= 5) return 'code likely helps';
  return 'spec text is sufficient';
}

export async function runContractsMap(opts: MapOpts, cwd: string = process.cwd()): Promise<PipelineResult> {
  const result = emptyResult('contracts-map');
  const log = (line: string): void => void result.messages.push(line);
  const fail = (line: string): PipelineResult => {
    log(line);
    result.exitCode = ExitCode.InternalError;
    return result;
  };
  if (opts.sendCode && !opts.withLlm) return fail('--send-code requires --with-llm: code is sent to a model only when you ask for both.');
  if (opts.assess && (opts.withLlm || opts.sendCode)) return fail('--assess uses no model and writes nothing: drop --with-llm and --send-code.');

  let loaded: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>;
  try {
    loaded = await loadWorkspaceWithConfigs(cwd, workspaceHint(opts.workspace));
  } catch {
    return fail('No workspace.json found. Run `specguard workspace init` first, or pass --workspace.');
  }
  const { manifest, repos } = loaded;
  const consumers = consumerRepos(repos, opts.repo);
  if (consumers.length === 0) return fail(opts.repo ? `No consumer repo named ${opts.repo}.` : 'The workspace has no repos.');

  const minRaw = typeof opts.minConfidence === 'string' ? Number(opts.minConfidence) : opts.minConfidence;
  // 0 is a real choice here (show everything), unlike the cap.
  const minConfidence = typeof minRaw === 'number' && Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : DEFAULT_MIN_CONFIDENCE;
  const cap = Math.floor(num(opts.maxLlmSpecs, DEFAULT_MAX_LLM_SPECS));
  const withCode = Boolean(opts.withCode || opts.assess);

  const catalogues = new Map<string, ConsumerSpec[]>(repos.map((r) => [r.key, loadRepoCatalogue(r)]));
  const extractors = withCode
    ? allExtractors(
        (await loadPlugins(workspacePlugins(repos), manifest.rootDir).catch(() => [])).flatMap((p) => p.endpointExtractors ?? []),
      )
    : [];
  const codeCache = new Map<string, RepoCode>();
  const scan = async (repo: WorkspaceRepoWithConfig): Promise<RepoCode> => {
    const hit = codeCache.get(repo.key);
    if (hit) return hit;
    const found = await scanRepo(repo, extractors, { calls: true, defs: true });
    codeCache.set(repo.key, found);
    return found;
  };
  const ownerCache = new Map<string, Ownership>();
  const ownerOf = async (repo: WorkspaceRepoWithConfig): Promise<Ownership> => {
    const hit = ownerCache.get(repo.key);
    if (hit) return hit;
    const own = await ownershipOf(repo, catalogues.get(repo.key) ?? []);
    ownerCache.set(repo.key, own);
    return own;
  };

  const totals: Assessment = { specs: 0, unmatched: 0, calls: 0, named: 0, unowned: 0, notReflected: 0, defsByRepo: {} };
  let unmatchedAll = 0;

  for (const repo of consumers) {
    // The system spec summarises every capability, so its text would name every provider.
    const specs = (catalogues.get(repo.key) ?? []).filter((sp) => sp.kind !== 'system');
    const providers = providerRepos(repos, repo.key).flatMap((r) => (catalogues.get(r.key) ?? []).filter((sp) => sp.kind !== 'system'));
    const keys = keysOf(repo.specGuardConfig);
    const prefixes = repo.specGuardConfig?.contractMappings?.basePrefixes ?? DEFAULT_BASE_PREFIXES;
    const file = mappingsFile(repo);
    const rel = path.relative(repo.absPath, file).split(path.sep).join('/');
    const existing = await readExisting(file);
    if (existing.broken && !opts.assess) {
      log(`${repo.key}: ${rel} is not a JSON object, left untouched. Fix or remove it first.`);
      result.skipped += 1;
      continue;
    }
    const manual = new Set(
      (Array.isArray(existing.data?.[keys.list]) ? (existing.data![keys.list] as Array<Record<string, unknown>>) : [])
        .filter((e) => e && e.generated !== true && typeof e[keys.spec] === 'string')
        .map((e) => e[keys.spec] as string),
    );

    // Pass 1: spec text, no model.
    const found = new Map<string, Suggestion[]>();
    const textMatched = new Set<string>();
    for (const spec of specs) {
      const s = matchSpecText(spec, providers, repo.absPath).filter((x) => x.confidence >= minConfidence);
      if (s.length > 0) {
        found.set(spec.relPath, s);
        textMatched.add(spec.relPath);
      }
    }

    // Code: client calls matched to endpoint definitions.
    let calls: EndpointCall[] = [];
    const defsByRepo = new Map<string, EndpointDef[]>();
    let consumerOwn: Ownership | null = null;
    if (withCode) {
      calls = (await scan(repo)).calls;
      for (const other of providerRepos(repos, repo.key)) defsByRepo.set(other.key, (await scan(other)).defs);
      consumerOwn = await ownerOf(repo);
      const matches = matchCode(calls, defsByRepo, prefixes, repo.specGuardConfig?.contractMappings?.baseRepos);
      for (const [providerKey, ms] of matches) {
        const provider = repos.find((r) => r.key === providerKey)!;
        const bySpec = suggestionsFromCode(ms.filter((m) => m.score >= minConfidence), consumerOwn, await ownerOf(provider), provider.absPath, repo.absPath);
        if (opts.assess) continue;
        for (const [spec, suggestions] of bySpec) found.set(spec, [...(found.get(spec) ?? []), ...suggestions]);
      }
    }

    if (opts.assess) {
      const a = assessRepo(specs, textMatched, calls, consumerOwn, prefixes);
      for (const [k, defs] of defsByRepo) a.defsByRepo[k] = defs.length;
      totals.specs += a.specs;
      totals.unmatched += a.unmatched;
      totals.calls += a.calls;
      totals.named += a.named;
      totals.unowned += a.unowned;
      totals.notReflected += a.notReflected;
      for (const [k, n] of Object.entries(a.defsByRepo)) totals.defsByRepo[k] = (totals.defsByRepo[k] ?? 0) + n;
      log(`${repo.key}: ${a.specs} consumer spec(s), ${a.unmatched} (${pct(a.unmatched, a.specs)}) with no spec-text match`);
      log(`  call sites found: ${a.calls}; named in spec text: ${a.named}; in files no spec owns: ${a.unowned}; in owned files but not named in spec text: ${a.notReflected}`);
      continue;
    }

    // Pass 2: the model, only where the text (and code) did not settle a spec.
    if (opts.withLlm) {
      const llm = repo.specGuardConfig?.llm;
      if (!llm) {
        log(`${repo.key}: --with-llm needs a SpecGuard config with an llm section in this repo; skipped.`);
      } else {
        const candidates = specs.filter((s) => !manual.has(s.relPath) && (opts.allSpecs || !found.has(s.relPath)));
        if (candidates.length > 0) {
          const { lines, sending } = egressNotice(
            `${repo.key}: model pass`,
            'the text of each listed spec (front matter removed, secrets redacted) with the titles and summaries of the other repos\' specs',
            llm,
            candidates,
            cap,
            (s) => `${repo.key}::${s.relPath}`,
          );
          lines.forEach(log);
          for (const spec of sending) {
            const prompt = buildPrompt(`Consumer spec ${spec.title} (${repo.key}::${spec.relPath}):\n---\n${redact(spec.text)}\n---`, providers);
            const picks = await askCatalogue({ llm, prompt, catalogue: providers, consumerRepoAbs: repo.absPath, evidence: '', minConfidence, log, label: `${repo.key}::${spec.relPath}` });
            if (picks.length > 0) found.set(spec.relPath, [...(found.get(spec.relPath) ?? []), ...picks]);
          }
        }
        if (opts.sendCode && withCode) {
          await sendCodePass({ repo, llm, calls, defsByRepo, consumerOwn: consumerOwn!, repos, providers, minConfidence, cap, prefixes, found, log, ownerOf });
        }
      }
    }
    if (opts.sendCode && !withCode) {
      log(`${repo.key}: --send-code needs --with-code to find call sites; skipped.`);
    }

    // Merge and write.
    const proposals: Proposal[] = [...found.entries()].map(([spec, suggestions]) => ({ spec, suggestions: dedupe(suggestions) }));
    const merged = mergeMappings(existing.data, proposals, keys);
    const unmatched = specs.filter((s) => !found.has(s.relPath) && !manual.has(s.relPath)).length;
    unmatchedAll += unmatched;
    const changed = merged.added.length + merged.removed.length + merged.updated.length + merged.flipped.length > 0;
    log(`${repo.key}: ${merged.added.length} added, ${merged.kept.length} kept, ${merged.removed.length} removed; ${unmatched} of ${specs.length} spec(s) had no match`);
    for (const p of proposals.filter((p) => merged.added.includes(p.spec) || merged.updated.includes(p.spec))) {
      for (const s of dedupe(p.suggestions)) log(`  + ${p.spec} -> ${s.provider} (${s.source} ${s.confidence}) ${s.evidence}`.trimEnd());
    }
    if (merged.flipped.length > 0) log(`  Edited by hand, now manual: ${merged.flipped.join(', ')}`);
    if (merged.removed.length > 0) {
      log('  Removed:');
      merged.removed.forEach((s) => log(`    ${s}`));
    }
    result.created += merged.added.length;
    result.updated += merged.updated.length;
    if (opts.dryRun) {
      log(`  [dry-run] ${rel} not written`);
    } else if (changed) {
      await writeFile(file, `${JSON.stringify(merged.file, null, 2)}\n`);
      log(`  wrote ${rel}`);
    }
  }

  if (opts.assess) {
    log('');
    log(`Provider endpoint definitions: ${Object.entries(totals.defsByRepo).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
    log(`Recommendation: ${recommend(totals)}`);
    result.exitCode = ExitCode.Success;
    return result;
  }
  if (!opts.withLlm && !opts.withCode) {
    const total = consumers.reduce((n, r) => n + (catalogues.get(r.key)?.length ?? 0), 0);
    log(
      unmatchedAll > 0 && total > 0 && (unmatchedAll / total) * 100 >= 30
        ? `Hint: ${unmatchedAll} of ${total} spec(s) (${pct(unmatchedAll, total)}) have no spec-text match. Run \`specguard contracts-map --assess\` to see whether reading code would help.`
        : `Hint: spec text matched ${total - unmatchedAll} of ${total} spec(s); \`--assess\` shows whether reading code would add more.`,
    );
  }
  if (!opts.dryRun && result.created + result.updated > 0) log('Next: run `specguard contracts --force` to rebuild the graph.');
  result.exitCode = ExitCode.Success;
  return result;
}

const pct = (n: number, d: number): string => `${d === 0 ? 0 : Math.round((n / d) * 100)}%`;

/** One suggestion per provider and source, the most confident. */
function dedupe(list: Suggestion[]): Suggestion[] {
  const best = new Map<string, Suggestion>();
  for (const s of list) {
    const k = `${s.provider}|${s.source}`;
    if (!best.has(k) || best.get(k)!.confidence < s.confidence) best.set(k, s);
  }
  return [...best.values()];
}

function assessRepo(
  specs: ConsumerSpec[],
  textMatched: Set<string>,
  calls: EndpointCall[],
  own: Ownership | null,
  prefixes: string[],
): Assessment {
  const textOf = new Map(specs.map((s) => [s.relPath, s.text]));
  const a: Assessment = { specs: specs.length, unmatched: specs.filter((s) => !textMatched.has(s.relPath)).length, calls: calls.length, named: 0, unowned: 0, notReflected: 0, defsByRepo: {} };
  for (const call of calls) {
    const owners = own?.specsFor(call.file) ?? [];
    if (owners.length === 0) {
      a.unowned += 1;
      continue;
    }
    const re = pathPattern(call.path, prefixes);
    const named = re !== null && owners.some((o) => re.test(textOf.get(o) ?? ''));
    if (named) a.named += 1;
    else a.notReflected += 1;
  }
  return a;
}

async function sendCodePass(ctx: {
  repo: WorkspaceRepoWithConfig;
  llm: SpecGuardConfig['llm'];
  calls: EndpointCall[];
  defsByRepo: Map<string, EndpointDef[]>;
  consumerOwn: Ownership;
  repos: WorkspaceRepoWithConfig[];
  providers: ConsumerSpec[];
  minConfidence: number;
  cap: number;
  prefixes: string[];
  found: Map<string, Suggestion[]>;
  log: (line: string) => void;
  ownerOf: (r: WorkspaceRepoWithConfig) => Promise<Ownership>;
}): Promise<void> {
  const { repo, log } = ctx;
  const matches = matchCode(ctx.calls, ctx.defsByRepo, ctx.prefixes);
  const matchedCalls = new Set([...matches.values()].flat().filter((m) => m.score >= ctx.minConfidence).map((m) => m.call));
  const byFile = new Map<string, EndpointCall[]>();
  for (const call of ctx.calls) {
    if (matchedCalls.has(call) || ctx.consumerOwn.specsFor(call.file).length === 0) continue;
    byFile.set(call.file, [...(byFile.get(call.file) ?? []), call]);
  }
  if (byFile.size === 0) return;
  const files = [...byFile.keys()].sort();
  const endpointList: string[] = [];
  for (const other of ctx.repos.filter((r) => r.key !== repo.key)) {
    const own = await ctx.ownerOf(other);
    for (const def of ctx.defsByRepo.get(other.key) ?? []) {
      const owners = own.specsFor(def.file);
      if (owners.length > 0 && endpointList.length < 400) endpointList.push(`${def.method ?? 'ANY'} ${def.path} (${other.key}::${owners[0]})`);
    }
  }
  const { lines, sending } = egressNotice(
    `${repo.key}: code pass`,
    'about 31 lines of code around each listed file\'s unmatched call sites (secrets redacted; files that look like they hold a secret are skipped), with the list of provider endpoints and the titles of the other repos\' specs',
    ctx.llm,
    files,
    ctx.cap,
    (f) => `${repo.key}::${f}`,
  );
  lines.forEach(log);
  for (const f of sending) {
    let text: string;
    try {
      text = await readFile(path.join(repo.absPath, f));
    } catch {
      continue;
    }
    if (looksSecret(text)) {
      log(`  [skip] ${repo.key}::${f}: looks like it holds a secret, not sent`);
      continue;
    }
    const src = text.split('\n');
    const keep = new Set<number>();
    for (const call of byFile.get(f)!) for (let i = Math.max(1, call.line - 15); i <= Math.min(src.length, call.line + 15); i += 1) keep.add(i);
    const excerpt = [...keep].sort((a, b) => a - b).map((i) => `${i}: ${src[i - 1]}`).join('\n');
    const prompt = buildPrompt(
      `Consumer code ${f} calls HTTP endpoints. Excerpts around the calls:\n---\n${redact(excerpt)}\n---`,
      ctx.providers,
      `\nKnown provider endpoints:\n${endpointList.join('\n')}\n`,
    );
    const picks = await askCatalogue({
      llm: ctx.llm,
      prompt,
      catalogue: ctx.providers,
      consumerRepoAbs: repo.absPath,
      evidence: `${f}:${byFile.get(f)![0]!.line}`,
      minConfidence: ctx.minConfidence,
      log,
      label: `${repo.key}::${f}`,
    });
    for (const spec of ctx.consumerOwn.specsFor(f)) if (picks.length > 0) ctx.found.set(spec, [...(ctx.found.get(spec) ?? []), ...picks]);
  }
}
