/**
 * Plugin contracts and the shared feature-state data model.
 *
 * Core SpecGuard knows nothing about any particular platform. Anything that
 * depends on a platform's repo layout, id scheme, or tooling is supplied by a
 * plugin through one of these interfaces and enabled by `config.plugins`.
 *
 * Spec: specs/plugins/plugins.md
 */
import type { ParsedSpec } from '../core/types.js';

export const CHANNELS = ['ui', 'api', 'mcp'] as const;
export type ChannelName = (typeof CHANNELS)[number];
export type ChannelState = 'no' | 'stub' | 'built' | 'broken' | 'passing' | 'proven';

export interface CatalogTests {
  unit: string[];
  regression: string[];
  integration: string[];
  proof: string[];
}

/** One feature in a catalog. Ids are opaque strings: no structure is assumed. */
export interface CatalogFeatureInput {
  id: string;
  title: string;
  area: string;
  summary: string;
  requires: ChannelName[];
  /** Spec refs, `<repo>:<specKey>`. */
  specs: string[];
  tests: CatalogTests;
  status: string;
  /** Ids in an external system (test-management tool, tracker). Matched against results. */
  externalIds?: string[];
  tags?: string[];
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

/** What the repo actually contains for one feature. */
export interface ChannelImplementation {
  ui?: string;
  api?: string;
  /** An MCP tool (or equivalent agent surface) that counts as the feature's MCP channel. */
  mcpAdmin?: string;
  /** A tool that exists but does not count (kept as evidence only). */
  mcpLearner?: string;
}

/** Normalized test result used by feature-state. */
export interface FeatureCase {
  kind: string;
  status: string;
  name?: string;
  file?: string;
  featureId?: string;
  channel?: ChannelName;
  /** Id in an external system; matched against catalog `tests.regression` and feature `externalIds`. */
  externalId?: string;
  externalIds?: string[];
  tags?: string[];
  /** Legacy alias normalized by an external-id adapter. */
  [extra: string]: unknown;
}

export interface FeatureProof {
  claim: string;
  verdict: string;
}

export interface RepoRef {
  key: string;
  absPath: string;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CatalogContext {
  /** Workspace or repo root the catalog path is relative to. */
  rootDir: string;
  /** Catalog directory from config or the workspace manifest, when set. */
  dir?: string;
}

/** Loads the feature catalog. The generic provider reads versioned YAML. */
export interface CatalogProvider {
  id: string;
  /** Directory used when the config does not name one. Undefined means "no catalog". */
  defaultDir?: string;
  load(ctx: CatalogContext): Promise<CatalogFeatureInput[]>;
}

export interface DiscoveryContext {
  features: CatalogFeatureInput[];
  specs: FeatureSpec[];
  repos: RepoRef[];
  /** Extra directory stems tried when resolving a spec `module:` to a file. */
  moduleStems: string[];
}

/** Finds the code that implements a feature, per channel. Results from several discoverers merge. */
export interface ImplementationDiscoverer {
  id: string;
  discover(ctx: DiscoveryContext): Record<string, ChannelImplementation>;
}

/** Maps external-system ids (Jira keys, Zephyr test keys, ...) onto normalized results. */
export interface ExternalIdAdapter {
  id: string;
  /** Ids this adapter can read from one raw result row, tags, or free text. */
  extract(input: { tags?: string[]; text?: string; row?: Record<string, unknown> }): string[];
}

export interface ResultSourceContext {
  rootDir: string;
}

/** Supplies normalized results for feature-state. */
export interface ResultSource {
  id: string;
  load(ctx: ResultSourceContext): FeatureCase[];
}

/** Tunables the feature-state engine reads. A plugin supplies defaults; config overrides them. */
export interface FeatureStateTuning {
  /** Spec `type:` -> channel. */
  channelByType: Record<string, ChannelName>;
  /** Repo key -> channel the repo's specs implement, used when a catalog omits `requires`. */
  repoChannels: Record<string, ChannelName>;
  /** Tokens of a feature id used to decide which sibling a test file belongs to. */
  idTokens?: (id: string) => string[];
  /** True for a catalog summary that is a placeholder and should be replaced by the spec overview. */
  isPlaceholderSummary?: (summary: string) => boolean;
  /** Spec module/spec-key patterns that mean the MCP channel. */
  mcpModulePattern?: RegExp;
}

/** A plugin bundles any of the interfaces. */
export interface SpecGuardPlugin {
  id: string;
  catalogProviders?: CatalogProvider[];
  discoverers?: ImplementationDiscoverer[];
  externalIdAdapters?: ExternalIdAdapter[];
  resultSources?: ResultSource[];
  featureState?: Partial<FeatureStateTuning>;
  /** Extra stems for resolving a spec `module:` to a source file. */
  moduleStems?: string[];
  /** Importers that add edges to the contract graph from legacy files. */
  contractImporters?: ContractImporter[];
}

/** An edge a contract importer contributes. Provider is a node id `<repo>::<path>`. */
export interface ImportedContractEdge {
  consumerSpec: string;
  providerPath: string;
  docPage: string | null;
}

export interface ContractImporter {
  id: string;
  /** Edges from one repo. Never throws; returns [] when its input does not exist. */
  read(repo: { key: string; absPath: string }, manifest: { rootDir: string; repos: Record<string, { path: string }> }): ImportedContractEdge[];
}

export type { ParsedSpec };
