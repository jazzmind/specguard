/**
 * Feature state.
 *
 * One row per catalog feature: summary, required channels, UI/API/MCP state,
 * and whether an agent may run. `specguard align` is a different command.
 *
 * Spec: specs/pipelines/feature-state.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../core/config.js';
import { dependencyFingerprint } from '../core/dependency-fingerprint.js';
import { hashString } from '../core/drift-registry.js';
import { effectiveVerdict, emptyLedger, type ProofLedger } from '../core/proof-ledger.js';
import { fileExists, readFile } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import type { ParsedSpec, PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { loadWorkspaceWithConfigs } from '../core/workspace.js';
import { yamlCatalogProvider } from '../plugins/catalog.js';
import {
  BUILTIN_DISCOVERERS,
  graphqlOperations,
  repoOf,
  resolveModuleFile,
} from '../plugins/discoverers.js';
import { normalizeCases } from '../plugins/external-id.js';
import { loadPlugins, resolveExternalIdAdapters } from '../plugins/index.js';
import { caseDirSource, readCaseFiles, reporterSource } from '../plugins/result-sources.js';
import {
  CHANNELS,
  type CatalogFeatureInput,
  type CatalogProvider,
  type CatalogTests,
  type ChannelImplementation,
  type ChannelName,
  type ChannelState,
  type FeatureCase,
  type FeatureProof,
  type FeatureSpec,
  type FeatureStateTuning,
  type ImplementationDiscoverer,
  type ResultSource,
  type SpecGuardPlugin,
} from '../plugins/types.js';
import { currentFileHashes, ledgerPath } from './proof.js';

export { CHANNELS, graphqlOperations, resolveModuleFile };
export type {
  CatalogFeatureInput,
  CatalogTests,
  ChannelImplementation,
  ChannelName,
  ChannelState,
  FeatureCase,
  FeatureProof,
  FeatureSpec,
};

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
  tuning?: Partial<FeatureStateTuning>;
}

const DEFAULT_TUNING: FeatureStateTuning = {
  channelByType: { ui: 'ui', api: 'api', mcp: 'mcp' },
  repoChannels: {},
};

function tuned(partial?: Partial<FeatureStateTuning>): FeatureStateTuning {
  return {
    ...DEFAULT_TUNING,
    ...partial,
    channelByType: { ...DEFAULT_TUNING.channelByType, ...partial?.channelByType },
    repoChannels: { ...DEFAULT_TUNING.repoChannels, ...partial?.repoChannels },
  };
}

const HIGHER = new Set(['integration', 'regression', 'e2e', 'agent', 'proof']);
const KIND_ORDER = ['unit', 'integration', 'regression', 'e2e', 'agent', 'proof'];

function isChannel(value: string): value is ChannelName {
  return (CHANNELS as readonly string[]).includes(value);
}

/**
 * Channel a spec implements. Order: explicit `channel:`, then the spec `type:`
 * through `channelByType`, then the module path pattern, then the repo's channel.
 */
export function channelOf(
  meta: { channel?: string; type?: string; module?: string },
  specKey = '',
  tuning?: Partial<FeatureStateTuning>,
  repoKey?: string,
): ChannelName | null {
  const t = tuned(tuning);
  if (meta.channel && isChannel(meta.channel)) return meta.channel;
  const byType = meta.type ? t.channelByType[meta.type] : undefined;
  if (byType && isChannel(byType)) return byType;
  if (t.mcpModulePattern?.test(`${meta.module ?? ''} ${specKey}`)) return 'mcp';
  const byRepo = repoKey ? t.repoChannels[repoKey] : undefined;
  if (byRepo && isChannel(byRepo)) return byRepo;
  return null;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = flat.match(/^.*?[.!?](?:\s|$)/);
  return (match ? match[0] : flat).trim();
}

export function inferRequires(
  feature: CatalogFeatureInput,
  specs: FeatureSpec[],
  impl?: ChannelImplementation,
  tuning?: Partial<FeatureStateTuning>,
): ChannelName[] {
  const t = tuned(tuning);
  const requires: ChannelName[] = [];
  const refs = new Set(feature.specs);
  for (const spec of specs) {
    if (spec.featureIds.includes(feature.id)) refs.add(spec.ref);
  }
  const repoChannels = [...refs].map((ref) => t.repoChannels[repoOf(ref)]).filter((c): c is ChannelName => Boolean(c) && isChannel(c));
  if (feature.requires.length > 0) requires.push(...feature.requires);
  else {
    for (const channel of repoChannels) if (channel !== 'mcp' && !requires.includes(channel)) requires.push(channel);
    const mcp = repoChannels.includes('mcp') || specs.some((spec) => spec.featureIds.includes(feature.id) && spec.channel === 'mcp');
    if (mcp && requires.length === 0) requires.push('mcp');
  }
  if (impl?.ui && !requires.includes('ui')) requires.push('ui');
  if (impl?.api && !requires.includes('api')) requires.push('api');
  if (impl?.mcpAdmin && !requires.includes('mcp')) requires.push('mcp');
  return CHANNELS.filter((channel) => requires.includes(channel));
}

function isIndexFeature(feature: CatalogFeatureInput): boolean {
  return /[.\-_](list|index)$/i.test(feature.id) || /\b(list|index)\b/i.test(feature.title);
}

function summaryFor(feature: CatalogFeatureInput, specs: FeatureSpec[], t: FeatureStateTuning): string {
  const catalog = feature.summary.trim();
  const linked = specs.filter((spec) => spec.featureIds.includes(feature.id) || feature.specs.includes(spec.ref));
  const page = linked.find((spec) => spec.channel === 'ui') ?? linked[0];
  const placeholder = t.isPlaceholderSummary?.(catalog) ?? false;
  if ((!catalog || placeholder) && page && (isIndexFeature(feature) || linked.length === 1)) {
    return firstSentence(page.overview);
  }
  return catalog;
}

/** Default tokens of a feature id: every alphanumeric run longer than three characters. No id structure is assumed. */
function defaultIdTokens(id: string): string[] {
  return id.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 3);
}

/** Drop a unit file when its name matches a sibling feature better than this one. */
export function unitBelongs(
  feature: CatalogFeatureInput,
  file: string,
  features: CatalogFeatureInput[],
  idTokens: (id: string) => string[] = defaultIdTokens,
): boolean {
  const base = path.basename(file).replace(/\.(test|spec)\.[a-z]+$/i, '').toLowerCase();
  const fileTokens = base.split(/[^a-z0-9]+/).filter((part) => part.length > 3);
  const score = (id: string) => fileTokens.filter((token) => idTokens(id).includes(token)).length;
  const mine = score(feature.id);
  const bestOther = features.reduce((best, other) => (other.id === feature.id ? best : Math.max(best, score(other.id))), 0);
  return bestOther <= mine;
}

function withOwnedUnits(
  feature: CatalogFeatureInput,
  features: CatalogFeatureInput[],
  idTokens?: (id: string) => string[],
): CatalogFeatureInput {
  return {
    ...feature,
    tests: { ...feature.tests, unit: feature.tests.unit.filter((file) => unitBelongs(feature, file, features, idTokens)) },
  };
}

function caseIds(row: FeatureCase): string[] {
  return [row.externalId, ...(Array.isArray(row.externalIds) ? row.externalIds : [])].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function caseMatches(feature: CatalogFeatureInput, row: FeatureCase): boolean {
  if (row.featureId === feature.id) return true;
  if (Array.isArray(row.tags) && row.tags.includes(`@feature:${feature.id}`)) return true;
  const featureIds = [...feature.tests.regression, ...(feature.externalIds ?? [])];
  if (caseIds(row).some((id) => featureIds.includes(id))) return true;
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
      label: `${kind} ${row.externalId || row.file || row.name || 'test'} ${status}`,
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
  const t = tuned(input.tuning);
  return input.features.map((raw) => {
    const feature = withOwnedUnits(raw, input.features, t.idTokens);
    const impl = input.implementations?.[feature.id];
    const requires = inferRequires(feature, input.specs, impl, t);
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
      summary: summaryFor(feature, input.specs, t),
      requires,
      legacy: feature.status === 'legacy',
      channels,
      agentGate: gate(feature, cases),
      tests: feature.tests,
    };
  });
}

function specToFeature(repo: string, spec: ParsedSpec, tuning: Partial<FeatureStateTuning>): FeatureSpec {
  const featureIds = (spec.meta.feature ?? '').split(',').map((part) => part.trim()).filter((part) => part && part !== 'platform');
  return {
    ref: `${repo}:${spec.specKey}`,
    featureIds,
    channel: channelOf(spec.meta, spec.specKey, tuning, repo),
    overview: spec.overview,
    filePath: spec.filePath,
    module: spec.meta.module,
  };
}

/**
 * Run every discoverer and merge. The first discoverer to report a channel for a
 * feature wins that channel; later ones fill the channels still missing.
 */
export function discoverImplementations(
  features: CatalogFeatureInput[],
  specs: FeatureSpec[],
  repos: Array<{ key: string; absPath: string }>,
  discoverers: ImplementationDiscoverer[] = BUILTIN_DISCOVERERS,
  moduleStems: string[] = [],
): Record<string, ChannelImplementation> {
  const merged: Record<string, ChannelImplementation> = {};
  for (const discoverer of discoverers) {
    const found = discoverer.discover({ features, specs, repos, moduleStems });
    for (const [id, impl] of Object.entries(found)) merged[id] = { ...impl, ...merged[id] };
  }
  return merged;
}

async function loadProofs(
  rootDir: string,
  specs: FeatureSpec[],
  repoDirs: Map<string, string>,
  ledgerOverride?: string,
): Promise<FeatureProof[]> {
  const file = ledgerPath(rootDir, ledgerOverride);
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

export interface FeatureStateOptions {
  /** Override the plugin list (default: `config.plugins`). */
  plugins?: string[];
}

interface Resolved {
  rootDir: string;
  repos: Array<{ key: string; absPath: string; specGuardConfig: SpecGuardConfig | null }>;
  config: SpecGuardConfig | null;
  manifestCatalog?: string;
  manifestPlugins?: string[];
}

async function resolveWorkspace(cwd: string): Promise<Resolved> {
  let config: SpecGuardConfig | null = null;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = null;
  }
  try {
    const { manifest, repos } = await loadWorkspaceWithConfigs(cwd);
    const raw = manifest as unknown as { plugins?: string[] };
    return { rootDir: manifest.rootDir, repos, config, manifestCatalog: manifest.catalog, manifestPlugins: raw.plugins };
  } catch {
    if (!config) throw new Error('No .specguard/workspace.json or .specguard/config.json found.');
    const rootDir = config.rootDir ?? cwd;
    return {
      rootDir,
      repos: [{ key: path.basename(rootDir), absPath: rootDir, specGuardConfig: config }],
      config,
    };
  }
}

export async function collectFeatureState(
  cwd: string,
  extraCases: FeatureCase[] = [],
  opts: FeatureStateOptions = {},
): Promise<FeatureStateInput & { notes: string[] }> {
  const resolved = await resolveWorkspace(cwd);
  const { rootDir, repos, config } = resolved;
  const plugins: SpecGuardPlugin[] = await loadPlugins(opts.plugins ?? config?.plugins ?? resolved.manifestPlugins);
  const fs = config?.featureState ?? {};
  const notes: string[] = [];

  const tuning: Partial<FeatureStateTuning> = {};
  for (const plugin of plugins) Object.assign(tuning, plugin.featureState, {
    channelByType: { ...tuning.channelByType, ...plugin.featureState?.channelByType },
    repoChannels: { ...tuning.repoChannels, ...plugin.featureState?.repoChannels },
  });
  tuning.channelByType = { ...tuning.channelByType, ...(fs.channelByType as FeatureStateTuning['channelByType'] | undefined) };
  tuning.repoChannels = { ...tuning.repoChannels, ...(fs.repoChannels as FeatureStateTuning['repoChannels'] | undefined) };

  // Catalog: config, then workspace manifest, then a plugin's default directory.
  const configured = fs.catalog ?? resolved.manifestCatalog;
  const providers: CatalogProvider[] = [...plugins.flatMap((p) => p.catalogProviders ?? []), yamlCatalogProvider];
  const features: CatalogFeatureInput[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    const dir = configured ?? provider.defaultDir;
    if (!dir) continue;
    for (const feature of await provider.load({ rootDir, dir })) {
      if (seen.has(feature.id)) continue;
      seen.add(feature.id);
      features.push(feature);
    }
  }
  if (features.length === 0) {
    notes.push('no feature catalog found: set featureState.catalog (versioned YAML) or enable a plugin that provides one');
  }

  const specs: FeatureSpec[] = [];
  const seenDirs = new Set<string>();
  for (const repo of repos) {
    if (!repo.specGuardConfig) continue;
    for (const app of repo.specGuardConfig.apps ?? []) {
      const specDir = path.resolve(repo.absPath, app.specDir);
      if (seenDirs.has(specDir) || !existsSync(specDir)) continue;
      seenDirs.add(specDir);
      try {
        for (const spec of loadAllSpecs(specDir)) specs.push(specToFeature(repo.key, spec, tuning));
      } catch {
        /* a repo without readable specs still reports from the catalog */
      }
    }
  }

  const sources: ResultSource[] = [
    ...plugins.flatMap((p) => p.resultSources ?? []),
    caseDirSource('config-results', fs.resultsDirs ?? []),
    reporterSource((fs.reporters ?? []).map((r) => ({ path: r.path, kind: r.kind, format: r.format as never }))),
  ];
  const adapters = resolveExternalIdAdapters(fs.externalIds, plugins);
  const cases = normalizeCases([...sources.flatMap((source) => source.load({ rootDir })), ...extraCases], adapters);

  const discoverers = [...BUILTIN_DISCOVERERS, ...plugins.flatMap((p) => p.discoverers ?? [])];
  const moduleStems = plugins.flatMap((p) => p.moduleStems ?? []);
  return {
    features,
    specs,
    cases,
    proofs: await loadProofs(rootDir, specs, new Map(repos.map((repo) => [repo.key, repo.absPath])), config?.paths?.proofLedger),
    implementations: discoverImplementations(features, specs, repos, discoverers, moduleStems),
    tuning,
    notes,
  };
}

export async function runFeatureState(
  cwd: string,
  extraCases: FeatureCase[] = [],
  opts: FeatureStateOptions = {},
): Promise<PipelineResult> {
  const input = await collectFeatureState(cwd, extraCases, opts);
  const rows = featureStates(input);
  const result = emptyResult('feature-state');
  result.updated = rows.length;
  result.messages = [JSON.stringify(rows), ...input.notes];
  return result;
}

export function loadCasesFile(file: string): FeatureCase[] {
  if (!file || !existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as FeatureCase[] | { cases?: FeatureCase[] };
  return Array.isArray(parsed) ? parsed : parsed.cases ?? [];
}

export { readCaseFiles };
