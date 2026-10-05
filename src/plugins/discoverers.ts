/**
 * Built-in implementation discoverers: GraphQL, REST/OpenAPI, tRPC.
 *
 * Each reads source files and reports, per feature, which UI file and which API
 * spec the feature is built from. None of them assumes a repo naming scheme:
 * they use spec `module:` paths, spec channels, and the code itself.
 *
 * Spec: specs/plugins/plugins.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type {
  CatalogFeatureInput,
  ChannelImplementation,
  DiscoveryContext,
  FeatureSpec,
  ImplementationDiscoverer,
} from './types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function repoOf(ref: string): string {
  return ref.split(':')[0] ?? '';
}

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.py', '.go', '.rb', '.java'];

/**
 * Turn a spec `module:` path into a source file, when one exists. Tries the path
 * as written, with a leading repo-name segment removed, under `src/`, and under
 * each extra stem, with extension and `index` probing.
 */
export function resolveModuleFile(repoDir: string, modulePath: string, extraStems: string[] = []): string | null {
  const cleaned = modulePath.replace(/\(.*\)/, '').trim();
  if (!cleaned) return null;
  const rest = cleaned.replace(/^[A-Za-z0-9_-]+\//, '');
  const stems = [cleaned, rest, path.join('src', rest), ...extraStems.map((stem) => path.join(stem, rest))];
  for (const stem of stems) {
    const candidates = /\.[a-z]+$/i.test(stem)
      ? [stem]
      : [stem, ...EXTENSIONS.map((ext) => `${stem}${ext}`), ...EXTENSIONS.map((ext) => path.join(stem, `index${ext}`))];
    for (const rel of candidates) {
      const abs = path.join(repoDir, rel);
      if (isFile(abs)) return abs;
    }
  }
  return null;
}

/** Root field of each GraphQL operation in a source file. */
export function graphqlOperations(source: string): Array<{ kind: string; field: string }> {
  const ops: Array<{ kind: string; field: string }> = [];
  const re = /\b(query|mutation|subscription)\b[^{]*\{/g;
  for (const match of source.matchAll(re)) {
    const name = source.slice((match.index ?? 0) + match[0].length).match(/^\s*([A-Za-z_][\w]*)/);
    if (name && !['query', 'mutation', 'subscription', 'fragment'].includes(name[1])) {
      ops.push({ kind: match[1], field: name[1] });
    }
  }
  return ops;
}

/** The module file plus the sibling files that usually hold its data access. */
export function moduleSources(file: string): string {
  const dir = path.dirname(file);
  const chunks = [readFileSync(file, 'utf8')];
  for (const name of ['queries.ts', 'queries.tsx', 'query.ts', 'api.ts', 'api.tsx', 'client.ts']) {
    const sibling = path.join(dir, name);
    if (sibling !== file && isFile(sibling)) chunks.push(readFileSync(sibling, 'utf8'));
  }
  return chunks.join('\n');
}

export function linkedSpecs(feature: CatalogFeatureInput, specs: FeatureSpec[]): FeatureSpec[] {
  return specs.filter((spec) => spec.featureIds.includes(feature.id) || feature.specs.includes(spec.ref));
}

export function isIndexFeature(feature: CatalogFeatureInput): boolean {
  return /[.\-_](list|index)$/i.test(feature.id) || /\b(list|index)\b/i.test(feature.title);
}

function singularOf(field: string): string {
  return field.endsWith('ies') ? `${field.slice(0, -3)}y` : field.replace(/s$/, '');
}

interface ApiMatch {
  spec: FeatureSpec;
  score: number;
}

/** Best API-channel spec for an operation name, by key, overview, and kind folder. */
function bestApiSpec(specs: FeatureSpec[], field: string, kind: string): ApiMatch | undefined {
  const lower = field.toLowerCase();
  const singular = singularOf(field).toLowerCase();
  let best: ApiMatch | undefined;
  for (const spec of specs) {
    if (spec.channel !== 'api') continue;
    const key = (spec.ref.split(':')[1] ?? '').toLowerCase();
    const last = key.split('/').pop() ?? '';
    let score = 0;
    if (last === lower || last === singular) score += 5;
    if (key.includes(lower) || (singular.length > 3 && key.includes(singular))) score += 2;
    if (spec.overview.toLowerCase().includes(lower)) score += 1;
    if (kind === 'query' && key.includes('queries/')) score += 4;
    if (kind === 'mutation' && key.includes('mutations/')) score += 4;
    if (score > 0 && (!best || score > best.score)) best = { spec, score };
  }
  return best;
}

export function repoDirMap(ctx: DiscoveryContext): Map<string, string> {
  return new Map(ctx.repos.map((repo) => [repo.key, repo.absPath]));
}

/** For each feature, the UI-channel module files (absolute) and their repo-relative paths. */
export function uiModules(feature: CatalogFeatureInput, ctx: DiscoveryContext, dirs: Map<string, string>): Array<{ abs: string; rel: string; spec: FeatureSpec }> {
  const out: Array<{ abs: string; rel: string; spec: FeatureSpec }> = [];
  for (const spec of linkedSpecs(feature, ctx.specs)) {
    const dir = dirs.get(repoOf(spec.ref));
    if (!dir || !spec.module) continue;
    if (spec.channel !== 'ui' && spec.channel !== null) continue;
    const abs = resolveModuleFile(dir, spec.module, ctx.moduleStems);
    if (abs) out.push({ abs, rel: path.relative(dir, abs), spec });
  }
  return out;
}

function merge(into: Record<string, ChannelImplementation>, featureId: string, impl: ChannelImplementation): void {
  if (!impl.ui && !impl.api && !impl.mcpAdmin && !impl.mcpLearner) return;
  into[featureId] = { ...impl, ...into[featureId] };
}

/** API specs linked to a feature whose module file exists count as built API. */
function linkedApiModule(feature: CatalogFeatureInput, ctx: DiscoveryContext, dirs: Map<string, string>): string | undefined {
  for (const spec of linkedSpecs(feature, ctx.specs)) {
    if (spec.channel !== 'api' || !spec.module) continue;
    const dir = dirs.get(repoOf(spec.ref));
    if (dir && resolveModuleFile(dir, spec.module, ctx.moduleStems)) return spec.ref;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

export const graphqlDiscoverer: ImplementationDiscoverer = {
  id: 'graphql',
  discover(ctx) {
    const dirs = repoDirMap(ctx);
    const found: Record<string, ChannelImplementation> = {};
    for (const feature of ctx.features) {
      const impl: ChannelImplementation = {};
      const fields = new Map<string, string>();
      for (const mod of uiModules(feature, ctx, dirs)) {
        impl.ui = mod.rel;
        const ops = graphqlOperations(moduleSources(mod.abs));
        const queries = ops.filter((op) => op.kind === 'query');
        for (const op of isIndexFeature(feature) ? queries.slice(0, 1) : ops) fields.set(op.field, op.kind);
      }
      impl.api = linkedApiModule(feature, ctx, dirs);
      let apiScore = 0;
      for (const [field, kind] of fields) {
        const match = bestApiSpec(ctx.specs, field, kind);
        if (match && match.score > apiScore) {
          apiScore = match.score;
          impl.api = match.spec.ref;
        }
      }
      if (impl.api === undefined) delete impl.api;
      merge(found, feature.id, impl);
    }
    return found;
  },
};

// ---------------------------------------------------------------------------
// REST / OpenAPI
// ---------------------------------------------------------------------------

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  tags: string[];
}

const OPENAPI_NAMES = ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml', 'swagger.yml'];
const OPENAPI_DIRS = ['', 'docs', 'api', 'spec', 'specs', 'openapi'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Operations from an OpenAPI 3 / Swagger 2 document (JSON or YAML text). */
export function parseOpenApi(text: string): OpenApiOperation[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const paths = doc && typeof doc === 'object' ? (doc as { paths?: Record<string, Record<string, unknown>> }).paths : undefined;
  if (!paths || typeof paths !== 'object') return [];
  const ops: OpenApiOperation[] = [];
  for (const [route, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (!op || typeof op !== 'object') continue;
      const rec = op as { operationId?: unknown; tags?: unknown };
      ops.push({
        method: method.toUpperCase(),
        path: route,
        operationId: typeof rec.operationId === 'string' ? rec.operationId : undefined,
        tags: Array.isArray(rec.tags) ? rec.tags.map(String) : [],
      });
    }
  }
  return ops;
}

function findOpenApiDocs(repos: Array<{ key: string; absPath: string }>): Array<{ repo: string; ops: OpenApiOperation[] }> {
  const docs: Array<{ repo: string; ops: OpenApiOperation[] }> = [];
  for (const repo of repos) {
    for (const dir of OPENAPI_DIRS) {
      for (const name of OPENAPI_NAMES) {
        const file = path.join(repo.absPath, dir, name);
        if (!isFile(file)) continue;
        const ops = parseOpenApi(readFileSync(file, 'utf8'));
        if (ops.length > 0) docs.push({ repo: repo.key, ops });
      }
    }
  }
  return docs;
}

function routeRegex(route: string): RegExp {
  const body = route
    .split('/')
    .map((seg) => (/^\{.+\}$/.test(seg) || /^:/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}/?$`);
}

/** Request URLs found in client code. Template holes become `{}`; origin and query are dropped. */
export function clientRequestPaths(source: string): Array<{ method: string | null; path: string }> {
  const out: Array<{ method: string | null; path: string }> = [];
  const re = /\b(fetch|axios(?:\.(get|post|put|patch|delete))?|ky(?:\.(get|post|put|patch|delete))?|\$http\.(get|post|put|patch|delete)|http\.(get|post|put|patch|delete))\(\s*([`'"])([^`'"]+)\6/g;
  for (const match of source.matchAll(re)) {
    const method = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? null)?.toUpperCase() ?? null;
    let url = match[7].replace(/\$\{[^}]*\}/g, '{}');
    url = url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
    if (url.startsWith('/')) out.push({ method, path: url });
  }
  return out;
}

export const restDiscoverer: ImplementationDiscoverer = {
  id: 'rest',
  discover(ctx) {
    const dirs = repoDirMap(ctx);
    const docs = findOpenApiDocs(ctx.repos);
    const found: Record<string, ChannelImplementation> = {};
    for (const feature of ctx.features) {
      const impl: ChannelImplementation = {};
      impl.api = linkedApiModule(feature, ctx, dirs);
      const matched: string[] = [];
      for (const mod of uiModules(feature, ctx, dirs)) {
        impl.ui = mod.rel;
        for (const call of clientRequestPaths(moduleSources(mod.abs))) {
          for (const doc of docs) {
            for (const op of doc.ops) {
              if (call.method && call.method !== op.method) continue;
              if (routeRegex(op.path).test(call.path.replace(/\{\}/g, 'x')) || routeRegex(op.path.replace(/\{[^}]+\}/g, '{}')).test(call.path)) {
                matched.push(`${op.method} ${op.path}`);
              }
            }
          }
        }
      }
      // An API-channel spec that names a documented operation is built even without a module file.
      for (const spec of linkedSpecs(feature, ctx.specs)) {
        if (spec.channel !== 'api') continue;
        const mention = `${spec.module ?? ''} ${spec.overview}`;
        for (const doc of docs) {
          for (const op of doc.ops) {
            if (mention.includes(`${op.method} ${op.path}`) || (op.operationId && mention.includes(op.operationId))) {
              impl.api ??= spec.ref;
            }
          }
        }
      }
      if (!impl.api && matched.length > 0) {
        const spec = linkedSpecs(feature, ctx.specs).find((s) => s.channel === 'api');
        impl.api = spec ? spec.ref : `openapi:${matched[0]}`;
      }
      if (impl.api === undefined) delete impl.api;
      merge(found, feature.id, impl);
    }
    return found;
  },
};

// ---------------------------------------------------------------------------
// tRPC
// ---------------------------------------------------------------------------

/** `router.procedure` paths called from client code. */
export function trpcCalls(source: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:trpc|api|client)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.(?:useQuery|useSuspenseQuery|useInfiniteQuery|useMutation|query|mutate|mutateAsync|fetch|prefetch)\b/g;
  for (const match of source.matchAll(re)) out.add(match[1]);
  return [...out];
}

function walkSources(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkSources(abs, out, depth + 1);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

/** Procedure paths defined by router files, mapped to the defining file. */
export function trpcProcedures(repoDir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walkSources(repoDir)) {
    if (!/(router|trpc)/i.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (!/[pP]rocedure/.test(text)) continue;
    const base = path.basename(file).replace(/\.(router|route|routes)?\.?(ts|tsx|js|mjs)$/i, '');
    const exported = text.match(/export const (\w+?)(?:Router)?\s*=\s*(?:createTRPCRouter|router|t\.router)\(/)?.[1];
    const router = exported && exported !== 'app' ? exported : base;
    for (const match of text.matchAll(/(?:^|[{,])\s*(\w+):\s*\w*[pP]rocedure\b/gm)) {
      found.set(`${router}.${match[1]}`, path.relative(repoDir, file));
    }
  }
  return found;
}

export const trpcDiscoverer: ImplementationDiscoverer = {
  id: 'trpc',
  discover(ctx) {
    const dirs = repoDirMap(ctx);
    const procedures = new Map<string, string>();
    for (const repo of ctx.repos) for (const [name, file] of trpcProcedures(repo.absPath)) procedures.set(name, `${repo.key}:${file}`);
    const found: Record<string, ChannelImplementation> = {};
    for (const feature of ctx.features) {
      const impl: ChannelImplementation = {};
      const calls = new Set<string>();
      for (const mod of uiModules(feature, ctx, dirs)) {
        impl.ui = mod.rel;
        for (const call of trpcCalls(moduleSources(mod.abs))) calls.add(call);
      }
      impl.api = linkedApiModule(feature, ctx, dirs);
      let best = 0;
      for (const call of calls) {
        const proc = call.split('.').pop() ?? call;
        const router = call.split('.').slice(0, -1).join('.');
        const kind = /create|update|delete|set|add|remove|mutate/i.test(proc) ? 'mutation' : 'query';
        const match = bestApiSpec(ctx.specs, router || proc, kind) ?? bestApiSpec(ctx.specs, proc, kind);
        if (match && match.score > best) {
          best = match.score;
          impl.api = match.spec.ref;
        }
        if (!impl.api && procedures.has(call)) impl.api = `trpc:${call}`;
      }
      if (impl.api === undefined) delete impl.api;
      merge(found, feature.id, impl);
    }
    return found;
  },
};

export const BUILTIN_DISCOVERERS: ImplementationDiscoverer[] = [graphqlDiscoverer, restDiscoverer, trpcDiscoverer];
