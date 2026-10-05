/**
 * Feature state.
 *
 * One row per catalog feature: summary, required channels, UI/API/MCP state,
 * and whether an agent may run. `specguard align` is a different command.
 *
 * Spec: specs/pipelines/feature-state.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { dependencyFingerprint } from '../core/dependency-fingerprint.js';
import { hashString } from '../core/drift-registry.js';
import { effectiveVerdict, emptyLedger, type ProofLedger } from '../core/proof-ledger.js';
import { fileExists, readFile } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import { currentFileHashes } from './proof.js';
import type { ParsedSpec, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { loadWorkspaceWithConfigs } from '../core/workspace.js';

export const CHANNELS = ['ui', 'api', 'mcp'] as const;
export type ChannelName = (typeof CHANNELS)[number];
export type ChannelState = 'no' | 'stub' | 'built' | 'broken' | 'passing' | 'proven';

export interface CatalogTests {
  unit: string[];
  regression: string[];
  integration: string[];
  proof: string[];
}

export interface CatalogFeatureInput {
  id: string;
  title: string;
  area: string;
  summary: string;
  requires: ChannelName[];
  specs: string[];
  tests: CatalogTests;
  status: string;
}

export interface FeatureSpec {
  ref: string;
  featureIds: string[];
  channel: ChannelName | null;
  overview: string;
  filePath?: string;
  /** `module:` from the spec, used to find the source file. */
  module?: string;
}

/** What the repo actually contains for one feature. Learner MCP does not count as an admin tool. */
export interface ChannelImplementation {
  ui?: string;
  api?: string;
  mcpAdmin?: string;
  mcpLearner?: string;
}

export interface FeatureCase {
  kind: string;
  status: string;
  name?: string;
  file?: string;
  zephyr?: string;
  featureId?: string;
  channel?: ChannelName;
}

export interface FeatureProof {
  claim: string;
  verdict: string;
}

export interface ChannelReport {
  state: ChannelState;
  required: boolean;
  evidence: string[];
}

export interface FeatureStateRow {
  id: string;
  summary: string;
  requires: ChannelName[];
  legacy: boolean;
  channels: Record<ChannelName, ChannelReport>;
  agentGate: { allowed: boolean; reason: string };
  /** Unit files that belong to this feature. A sibling's test is left out. */
  tests: CatalogTests;
}

export interface FeatureStateInput {
  features: CatalogFeatureInput[];
  specs: FeatureSpec[];
  cases: FeatureCase[];
  proofs: FeatureProof[];
  implementations?: Record<string, ChannelImplementation>;
}

const UI_REPOS = new Set(['admin-app', 'app', 'login-app', 'project-hub']);
const API_REPOS = new Set(['graphql-api', 'login-api', 'services']);
const HIGHER = new Set(['integration', 'regression', 'e2e', 'agent', 'proof']);
const KIND_ORDER = ['unit', 'integration', 'regression', 'e2e', 'agent', 'proof'];

function splitList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((part) => part.trim()).filter(Boolean);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed) as string;
  return trimmed;
}

function isChannel(value: string): value is ChannelName {
  return (CHANNELS as readonly string[]).includes(value);
}

/** Read the restricted catalog YAML. Agent blocks are skipped. */
export function parseFeatureCatalog(text: string): CatalogFeatureInput[] {
  const features: CatalogFeatureInput[] = [];
  let current: CatalogFeatureInput | null = null;
  let inAgent = false;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (raw.startsWith('- id:')) {
      if (current) features.push(current);
      current = {
        id: raw.slice(5).trim(),
        title: '',
        area: '',
        summary: '',
        requires: [],
        specs: [],
        tests: { unit: [], regression: [], integration: [], proof: [] },
        status: 'planned',
      };
      inAgent = false;
      continue;
    }
    if (!current) continue;
    const test = raw.match(/^    (unit|regression|integration|proof): (.*)$/);
    if (test && !inAgent) {
      current.tests[test[1] as keyof CatalogTests] = splitList(test[2]);
      continue;
    }
    const field = raw.match(/^  (\w+): (.*)$/);
    if (!field) {
      if (raw.trim() === 'agent:') inAgent = true;
      if (raw.trim() === 'tests:') inAgent = false;
      continue;
    }
    inAgent = field[1] === 'agent';
    const value = unquote(field[2] ?? '');
    if (field[1] === 'title') current.title = value;
    else if (field[1] === 'area') current.area = value;
    else if (field[1] === 'summary') current.summary = value;
    else if (field[1] === 'requires') current.requires = splitList(value).filter(isChannel);
    else if (field[1] === 'specs') current.specs = splitList(value);
    else if (field[1] === 'status') current.status = value;
  }
  if (current) features.push(current);
  return features;
}

/** Channel a spec implements. An explicit channel wins over the type default. */
export function channelOf(meta: { channel?: string; type?: string; module?: string }, specKey = ''): ChannelName | null {
  if (meta.channel && isChannel(meta.channel)) return meta.channel;
  if (meta.type === 'page' || meta.type === 'ui') return 'ui';
  if (meta.type === 'mutation' || meta.type === 'query') return 'api';
  if (/\/mcp\/|\/tools\/|mcp-server/i.test(`${meta.module ?? ''} ${specKey}`)) return 'mcp';
  return null;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = flat.match(/^.*?[.!?](?:\s|$)/);
  return (match ? match[0] : flat).trim();
}

function repoOf(ref: string): string {
  return ref.split(':')[0] ?? '';
}

export function inferRequires(
  feature: CatalogFeatureInput,
  specs: FeatureSpec[],
  impl?: ChannelImplementation,
): ChannelName[] {
  const requires: ChannelName[] = [];
  const refs = new Set(feature.specs);
  for (const spec of specs) {
    if (spec.featureIds.includes(feature.id)) refs.add(spec.ref);
  }
  const repos = [...refs].map(repoOf);
  if (feature.requires.length > 0) requires.push(...feature.requires);
  else {
    if (repos.some((repo) => UI_REPOS.has(repo))) requires.push('ui');
    if (repos.some((repo) => API_REPOS.has(repo))) requires.push('api');
    const mcp = repos.includes('mcp') || specs.some((spec) => spec.featureIds.includes(feature.id) && spec.channel === 'mcp');
    if (mcp && requires.length === 0) requires.push('mcp');
  }
  if (impl?.ui && !requires.includes('ui')) requires.push('ui');
  if (impl?.api && !requires.includes('api')) requires.push('api');
  if (impl?.mcpAdmin && !requires.includes('mcp')) requires.push('mcp');
  return CHANNELS.filter((channel) => requires.includes(channel));
}

/** A drafted summary that is a scenario heading, not a sentence about the feature. */
export function headingSummary(summary: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+ — /.test(summary.trim());
}

function isIndexFeature(feature: CatalogFeatureInput): boolean {
  return /\.(list|index)$/.test(feature.id) || /\b(list|index)\b/i.test(feature.title);
}

function summaryFor(feature: CatalogFeatureInput, specs: FeatureSpec[]): string {
  const catalog = feature.summary.trim();
  const linked = specs.filter((spec) => spec.featureIds.includes(feature.id) || feature.specs.includes(spec.ref));
  const page = linked.find((spec) => spec.channel === 'ui') ?? linked[0];
  if ((!catalog || headingSummary(catalog)) && page && (isIndexFeature(feature) || linked.length === 1)) {
    return firstSentence(page.overview);
  }
  return catalog;
}

/** Drop a unit file when its name matches a sibling feature better than this one. */
export function unitBelongs(feature: CatalogFeatureInput, file: string, features: CatalogFeatureInput[]): boolean {
  const base = path.basename(file).replace(/\.(test|spec)\.[a-z]+$/i, '').toLowerCase();
  const tokens = (id: string) => id.split('.').slice(2).join('-').split(/[^a-z0-9]+/).filter((part) => part.length > 3);
  const fileTokens = base.split(/[^a-z0-9]+/).filter((part) => part.length > 3);
  const score = (id: string) => fileTokens.filter((token) => tokens(id).includes(token)).length;
  const mine = score(feature.id);
  const bestOther = features.reduce((best, other) => (other.id === feature.id ? best : Math.max(best, score(other.id))), 0);
  return bestOther <= mine;
}

function withOwnedUnits(feature: CatalogFeatureInput, features: CatalogFeatureInput[]): CatalogFeatureInput {
  return {
    ...feature,
    tests: { ...feature.tests, unit: feature.tests.unit.filter((file) => unitBelongs(feature, file, features)) },
  };
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

function caseMatches(feature: CatalogFeatureInput, row: FeatureCase): boolean {
  if (row.featureId === feature.id) return true;
  if (row.zephyr && feature.tests.regression.includes(row.zephyr)) return true;
  const file = row.file ?? '';
  const name = row.name ?? '';
  const linked = [...feature.tests.unit, ...feature.tests.integration, ...feature.tests.proof];
  return linked.some((test) => test.length > 0 && (file.includes(test) || name.includes(test)));
}

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

interface Scored {
  rank: number;
  index: number;
  status: 'passed' | 'failed';
  label: string;
  channel: ChannelName | null;
  higher: boolean;
}

function scoreCases(feature: CatalogFeatureInput, cases: FeatureCase[]): Scored[] {
  const scored: Scored[] = [];
  cases.forEach((row, index) => {
    if (!caseMatches(feature, row)) return;
    const failed = row.status === 'failed' || row.status === 'error' || row.status === 'timedOut' || row.status === 'unexpected';
    const status = row.status === 'passed' ? 'passed' : failed ? 'failed' : null;
    if (!status) return;
    const kind = row.kind || 'unit';
    scored.push({
      rank: kindRank(kind),
      index,
      status,
      label: `${kind} ${row.zephyr || row.file || row.name || 'test'} ${status}`,
      channel: row.channel && isChannel(row.channel) ? row.channel : null,
      higher: HIGHER.has(kind),
    });
  });
  return scored;
}

function latest(rows: Scored[]): Scored | undefined {
  return [...rows].sort((a, b) => a.rank - b.rank || a.index - b.index).at(-1);
}

function specsFor(feature: CatalogFeatureInput, specs: FeatureSpec[], channel: ChannelName): FeatureSpec[] {
  return specs.filter((spec) => (spec.featureIds.includes(feature.id) || feature.specs.includes(spec.ref)) && spec.channel === channel);
}

function channelReport(
  feature: CatalogFeatureInput,
  channel: ChannelName,
  required: boolean,
  specs: FeatureSpec[],
  cases: Scored[],
  proofs: FeatureProof[],
  built?: string,
): ChannelReport {
  const linkedSpecs = specsFor(feature, specs, channel);
  const evidence = [built, ...linkedSpecs.map((spec) => spec.ref)].filter((item): item is string => Boolean(item));
  const applicable = cases.filter((row) => row.channel === channel || (row.channel === null && required));
  const claimHits: Scored[] = [];
  for (const proof of proofs) {
    const specRef = proof.claim.split('#')[0] ?? '';
    if (!linkedSpecs.some((spec) => spec.ref === specRef)) continue;
    if (proof.verdict === 'proven') {
      claimHits.push({ rank: kindRank('proof'), index: 10000, status: 'passed', label: `${proof.claim} proven`, channel, higher: true });
    } else if (proof.verdict === 'failed' || proof.verdict === 'error') {
      claimHits.push({ rank: kindRank('proof'), index: 10000, status: 'failed', label: `${proof.claim} ${proof.verdict}`, channel, higher: true });
    }
  }
  const last = latest([...applicable, ...claimHits]);
  const testsLinked = feature.tests.unit.length + feature.tests.regression.length + feature.tests.integration.length + feature.tests.proof.length > 0;
  let state: ChannelState = 'no';
  if (last?.status === 'failed') state = 'broken';
  else if (last?.status === 'passed' && last.higher) state = 'proven';
  else if (last?.status === 'passed') state = 'passing';
  else if (built) state = 'built';
  else if (linkedSpecs.length > 0 || (required && testsLinked)) state = 'stub';
  if (last) evidence.push(last.label);
  return { state, required, evidence: evidence.slice(0, 4) };
}

function gate(feature: CatalogFeatureInput, cases: Scored[]): { allowed: boolean; reason: string } {
  const unit = cases.filter((row) => row.rank === kindRank('unit'));
  const integration = cases.filter((row) => row.rank === kindRank('integration'));
  const linked = feature.tests.unit.length + feature.tests.integration.length > 0;
  if (!linked) return { allowed: false, reason: 'No unit or integration test linked' };
  const lastUnit = latest(unit);
  const lastIntegration = latest(integration);
  if (lastUnit?.status === 'passed' || lastIntegration?.status === 'passed') return { allowed: true, reason: '' };
  if (lastUnit?.status === 'failed' || lastIntegration?.status === 'failed') {
    return { allowed: false, reason: 'Unit or integration tests failed' };
  }
  return { allowed: false, reason: 'Unit or integration tests have not passed yet' };
}

function builtEvidence(channel: ChannelName, impl?: ChannelImplementation): string | undefined {
  if (channel === 'ui') return impl?.ui;
  if (channel === 'api') return impl?.api;
  return impl?.mcpAdmin;
}

export function featureStates(input: FeatureStateInput): FeatureStateRow[] {
  return input.features.map((raw) => {
    const feature = withOwnedUnits(raw, input.features);
    const impl = input.implementations?.[feature.id];
    const requires = inferRequires(feature, input.specs, impl);
    const cases = scoreCases(feature, input.cases);
    const channels = {} as Record<ChannelName, ChannelReport>;
    for (const channel of CHANNELS) {
      const required = requires.includes(channel);
      const built = builtEvidence(channel, impl);
      const hasSpec = specsFor(feature, input.specs, channel).length > 0;
      if (!required && !hasSpec && !built) {
        channels[channel] = {
          state: 'no',
          required: false,
          evidence: channel === 'mcp' && impl?.mcpLearner ? [impl.mcpLearner] : [],
        };
      } else {
        channels[channel] = channelReport(feature, channel, required, input.specs, cases, input.proofs, built);
      }
    }
    return {
      id: feature.id,
      summary: summaryFor(feature, input.specs),
      requires,
      legacy: feature.status === 'legacy',
      channels,
      agentGate: gate(feature, cases),
      tests: feature.tests,
    };
  });
}

function loadCatalogDir(dir: string): CatalogFeatureInput[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .flatMap((name) => parseFeatureCatalog(readFileSync(path.join(dir, name), 'utf8')));
}

function specToFeature(repo: string, spec: ParsedSpec): FeatureSpec {
  const featureIds = (spec.meta.feature ?? '').split(',').map((part) => part.trim()).filter((part) => part && part !== 'platform');
  return {
    ref: `${repo}:${spec.specKey}`,
    featureIds,
    channel: channelOf(spec.meta, spec.specKey),
    overview: spec.overview,
    filePath: spec.filePath,
    module: spec.meta.module,
  };
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Turn a spec `module:` path into a source file, when one exists. */
export function resolveModuleFile(repoDir: string, modulePath: string): string | null {
  const cleaned = modulePath.replace(/\(.*\)/, '').trim();
  const rest = cleaned.replace(/^[a-z0-9-]+\//, '');
  const stems = [cleaned, rest, path.join('src/pages', rest), path.join('src', rest), path.join('src/components', rest), path.join('src/schema', rest)];
  for (const stem of stems) {
    const withExt = /\.[a-z]+$/i.test(stem) ? [stem] : [stem, `${stem}.tsx`, `${stem}.ts`, path.join(stem, 'index.tsx'), path.join(stem, 'index.ts')];
    for (const rel of withExt) {
      const abs = path.join(repoDir, rel);
      if (isFile(abs)) return abs;
    }
  }
  return null;
}

function bestApiSpec(specs: FeatureSpec[], field: string, kind: string): { spec: FeatureSpec; score: number } | undefined {
  const singular = field.endsWith('ies') ? `${field.slice(0, -3)}y` : field.replace(/s$/, '');
  let best: { spec: FeatureSpec; score: number } | undefined;
  for (const spec of specs) {
    if (!spec.ref.startsWith('graphql-api:') && spec.channel !== 'api') continue;
    const key = (spec.ref.split(':')[1] ?? '').toLowerCase();
    const last = key.split('/').pop() ?? '';
    let score = 0;
    if (last === field.toLowerCase() || last === singular) score += 5;
    if (key.includes(field.toLowerCase()) || (singular.length > 3 && key.includes(singular))) score += 2;
    if (spec.overview.toLowerCase().includes(field.toLowerCase())) score += 1;
    if (kind === 'query' && key.includes('queries/')) score += 4;
    if (kind === 'mutation' && key.includes('mutations/')) score += 4;
    if (score > 0 && (!best || score > best.score)) best = { spec, score };
  }
  return best;
}

interface McpToolHit {
  name: string;
  audience: 'admin' | 'learner';
  fields: string[];
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walkFiles(abs, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

function mcpTools(toolsDir: string): McpToolHit[] {
  const hits: McpToolHit[] = [];
  for (const file of walkFiles(toolsDir)) {
    const source = readFileSync(file, 'utf8');
    const name = source.match(/server\.tool\(\s*['"]([^'"]+)['"]/)?.[1];
    if (!name) continue;
    const audience = /\/student\/|\/learner\//.test(file) ? 'learner' : 'admin';
    hits.push({ name, audience, fields: graphqlOperations(source).map((op) => op.field) });
  }
  return hits;
}

function pageSources(pageFile: string): string {
  const dir = path.dirname(pageFile);
  const chunks = [readFileSync(pageFile, 'utf8')];
  for (const name of ['queries.ts', 'queries.tsx', 'query.ts']) {
    const sibling = path.join(dir, name);
    if (isFile(sibling)) chunks.push(readFileSync(sibling, 'utf8'));
  }
  return chunks.join('\n');
}

function linkedSpecs(feature: CatalogFeatureInput, specs: FeatureSpec[]): FeatureSpec[] {
  return specs.filter((spec) => spec.featureIds.includes(feature.id) || feature.specs.includes(spec.ref));
}

/**
 * Find the screen, the GraphQL query it calls, and any MCP tool on that same field.
 * A learner tool is recorded separately and does not make MCP built.
 */
export function discoverImplementations(
  features: CatalogFeatureInput[],
  specs: FeatureSpec[],
  repos: Array<{ key: string; absPath: string }>,
): Record<string, ChannelImplementation> {
  const repoDir = new Map(repos.map((repo) => [repo.key, repo.absPath]));
  const toolsDir = repoDir.get('mcp-server');
  const tools = toolsDir ? mcpTools(path.join(toolsDir, 'src', 'tools')) : [];
  const found: Record<string, ChannelImplementation> = {};
  for (const feature of features) {
    const impl: ChannelImplementation = {};
    const fields = new Map<string, string>();
    for (const spec of linkedSpecs(feature, specs)) {
      const repo = repoOf(spec.ref);
      const dir = repoDir.get(repo);
      if (!dir || !spec.module) continue;
      const file = resolveModuleFile(dir, spec.module);
      if (!file) continue;
      if (spec.channel === 'ui' || spec.channel === null) {
        impl.ui = path.relative(dir, file);
        const ops = graphqlOperations(pageSources(file));
        const queries = ops.filter((op) => op.kind === 'query');
        const relevant = isIndexFeature(feature) ? queries.slice(0, 1) : ops;
        for (const op of relevant) fields.set(op.field, op.kind);
      }
      if (spec.channel === 'api') impl.api = spec.ref;
    }
    let apiScore = 0;
    for (const [field, kind] of fields) {
      const match = bestApiSpec(specs, field, kind);
      if (match && match.score > apiScore) {
        apiScore = match.score;
        impl.api = match.spec.ref;
      }
    }
    const matched = tools.filter((tool) => tool.fields.some((field) => fields.has(field)));
    const admin = matched.find((tool) => tool.audience === 'admin');
    const learner = matched.find((tool) => tool.audience === 'learner');
    if (admin) impl.mcpAdmin = admin.name;
    else if (learner) impl.mcpLearner = `learner ${learner.name}; no admin tool`;
    if (impl.ui || impl.api || impl.mcpAdmin || impl.mcpLearner) found[feature.id] = impl;
  }
  return found;
}

async function loadProofs(
  rootDir: string,
  specs: FeatureSpec[],
  repoDirs: Map<string, string>,
): Promise<FeatureProof[]> {
  const file = path.join(rootDir, '.specguard', 'proofs.json');
  if (!(await fileExists(file))) return [];
  let ledger: ProofLedger = emptyLedger();
  try {
    ledger = JSON.parse(await readFile(file)) as ProofLedger;
  } catch {
    return [];
  }
  const byRef = new Map(specs.map((spec) => [spec.ref, spec]));
  const proofs: FeatureProof[] = [];
  for (const record of Object.values(ledger.proofs ?? {})) {
    const spec = byRef.get(record.claim.split('#')[0] ?? '');
    if (!spec?.filePath || !existsSync(spec.filePath)) continue;
    const currentHash = hashString(readFileSync(spec.filePath, 'utf8'));
    const repoDir = repoDirs.get(repoOf(spec.ref)) ?? rootDir;
    proofs.push({
      claim: record.claim,
      verdict: effectiveVerdict(record, {
        specHash: currentHash,
        // Hash the recorded files as they are now. Comparing a record with its own hashes can never be stale.
        fileHashes: currentFileHashes(repoDir, record.fileHashes ?? {}),
        dependencyFingerprint: dependencyFingerprint(repoDir),
      }),
    });
  }
  return proofs;
}

function readCaseFiles(dir: string): FeatureCase[] {
  if (!existsSync(dir)) return [];
  const rows: FeatureCase[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as FeatureCase[] | { cases?: FeatureCase[] };
      rows.push(...(Array.isArray(parsed) ? parsed : parsed.cases ?? []));
    } catch {
      /* a bad results file is not a pass */
    }
  }
  return rows;
}

export async function collectFeatureState(cwd: string, extraCases: FeatureCase[] = []): Promise<FeatureStateInput> {
  const { manifest, repos } = await loadWorkspaceWithConfigs(cwd);
  const features = loadCatalogDir(path.resolve(manifest.rootDir, manifest.catalog ?? 'practera-test-suite/catalog'));
  const specs: FeatureSpec[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    if (!repo.specGuardConfig) continue;
    for (const app of repo.specGuardConfig.apps ?? []) {
      const specDir = path.resolve(repo.absPath, app.specDir);
      if (seen.has(specDir) || !existsSync(specDir)) continue;
      seen.add(specDir);
      try {
        for (const spec of loadAllSpecs(specDir)) specs.push(specToFeature(repo.key, spec));
      } catch {
        /* a repo without readable specs still reports from the catalog */
      }
    }
  }
  const cases = [
    ...readCaseFiles(path.join(manifest.rootDir, '.results', 'cases')),
    ...readCaseFiles(path.join(manifest.rootDir, 'practera-test-suite', '.results', 'cases')),
    ...extraCases,
  ];
  return {
    features,
    specs,
    cases,
    proofs: await loadProofs(manifest.rootDir, specs, new Map(repos.map((repo) => [repo.key, repo.absPath]))),
    implementations: discoverImplementations(features, specs, repos),
  };
}

export async function runFeatureState(cwd: string, extraCases: FeatureCase[] = []): Promise<PipelineResult> {
  const rows = featureStates(await collectFeatureState(cwd, extraCases));
  const result = emptyResult('feature-state');
  result.updated = rows.length;
  result.messages = [JSON.stringify(rows)];
  return result;
}

export function loadCasesFile(file: string): FeatureCase[] {
  if (!file || !existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as FeatureCase[] | { cases?: FeatureCase[] };
  return Array.isArray(parsed) ? parsed : parsed.cases ?? [];
}
