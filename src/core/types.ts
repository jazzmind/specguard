/**
 * Core type definitions for SpecGuard.
 *
 * These are the shared data shapes used across the parser, config loader,
 * pipelines, CLI, and MCP server. Zod schemas that validate external input
 * (config files, LLM output) live alongside their consumers; the types here
 * are the canonical TypeScript representations.
 */

// ---------------------------------------------------------------------------
// Spec model
// ---------------------------------------------------------------------------

/** Recognised module classifications in a spec's metadata block. */
export type SpecType = 'core' | 'pipeline' | 'adapter' | 'cli' | string;

/** Lifecycle status of a spec. */
export type SpecStatus = 'draft' | 'stable' | string;

/**
 * Parsed `<!-- key: value -->` metadata block from a spec file.
 * Known keys are typed; anything else lands in `extra`.
 */
export interface SpecMeta {
  module?: string;
  type?: SpecType;
  status?: SpecStatus;
  auth?: string;
  url?: string;
  framework?: string;
  /** Any metadata key not in the known set, preserved verbatim. */
  extra: Record<string, string>;
}

/** A single scenario within a spec's `## Scenarios` section. */
export interface SpecScenario {
  /** Scenario name with the `Scenario N:` prefix stripped. */
  name: string;
  /** Ordered steps from the `**Steps:**` numbered list. */
  steps: string[];
  /** Bullets from the `**Expected Results:**` list. */
  expectedResults: string[];
}

/** A fully parsed Living Specification file. */
export interface ParsedSpec {
  /** H1 title. */
  title: string;
  /** Stable key derived from path relative to specs root, e.g. `core/spec-parser`. */
  specKey: string;
  /** Absolute or repo-relative path the spec was loaded from. */
  filePath: string;
  /** Parsed metadata comment block. */
  meta: SpecMeta;
  /** Text under `## Overview`. */
  overview: string;
  /** Text under `## Acceptance Criteria`. */
  acceptanceCriteria: string;
  /** Parsed `## Scenarios`. */
  scenarios: SpecScenario[];
  /** Text under `## Security Notes`. */
  securityNotes: string;
  /** Text under `## Dependencies`. */
  dependencies: string;
  /** All H2 sections by name (raw text), for sections not otherwise typed. */
  sections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Config model
// ---------------------------------------------------------------------------

/** Source glob groups for an app. */
export interface AppSources {
  routes?: string[];
  pages?: string[];
  api?: string[];
  tests?: string[];
  [group: string]: string[] | undefined;
}

/** Per-app security configuration. */
export interface AppSecurityConfig {
  enabled: boolean;
  /** Optional glob patterns that, when changed, trigger security analysis. */
  paths?: string[];
}

/** A single application target within a SpecGuard config. */
export interface AppConfig {
  name: string;
  /** Repo root for this app, relative to the config location. */
  repo: string;
  /** Directory where specs for this app live. */
  specDir: string;
  /** Source glob groups. */
  sources: AppSources;
  /** Test framework for generated tests. */
  framework: 'vitest' | 'playwright' | 'jest' | string;
  /** Directory where generated tests are written. */
  testOutput: string;
  /** Security configuration. */
  security?: AppSecurityConfig;
  /** Whether docs generation is enabled (or an output dir). */
  docs?: boolean | string;
}

/** Runner placement: where each external tool executes. */
export interface RunnersConfig {
  playwright?: 'local' | 'docker' | string;
  semgrep?: 'local' | 'docker' | 'auto' | string;
  bandit?: 'local' | 'docker' | 'auto' | string;
  testRunner?: 'local' | 'docker' | string;
}

/** LLM provider configuration. */
export interface LlmConfig {
  provider: 'anthropic' | 'openai' | string;
  model: string;
  /** Name of the env var holding the API key. */
  apiKeyEnv: string;
}

/** Automation triggers. */
export interface TriggersConfig {
  onPlanPhase?: boolean;
  onSecurityFiles?: string[];
  onPR?: boolean;
  healAfterGenerate?: boolean;
}

/** Self-healing configuration. */
export interface HealConfig {
  maxRetries: number;
  testCommand: string;
}

/** Traceability matrix configuration. */
export interface MatrixConfig {
  format: 'json' | 'markdown' | string;
  output: string;
}

/** The fully parsed `.specguard/config.json`. */
export interface SpecGuardConfig {
  apps: AppConfig[];
  runners?: RunnersConfig;
  llm: LlmConfig;
  triggers?: TriggersConfig;
  heal?: HealConfig;
  matrix?: MatrixConfig;
  /** Directory the config was loaded from (the dir containing `.specguard/`). */
  rootDir?: string;
}

// ---------------------------------------------------------------------------
// Pipeline results
// ---------------------------------------------------------------------------

/** Severity for findings reported by pipelines (validate, security, etc.). */
export type Severity = 'critical' | 'major' | 'minor' | 'info';

/** A single item processed by a pipeline, with its outcome. */
export interface PipelineItem {
  /** Spec key or file the item refers to. */
  key: string;
  status: 'created' | 'updated' | 'skipped' | 'failed' | 'ok';
  /** Output path written, if any. */
  path?: string;
  /** Error or skip reason. */
  message?: string;
}

/**
 * Standard result shape returned by every pipeline.
 * Counts are convenience aggregates over `items`.
 */
export interface PipelineResult {
  /** Pipeline name, e.g. `reverse`. */
  pipeline: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Per-item detail. */
  items: PipelineItem[];
  /** Suggested process exit code (see exit-codes.ts). */
  exitCode: number;
  /** Free-form human-readable summary lines. */
  messages: string[];
}

/** Create an empty PipelineResult for a named pipeline. */
export function emptyResult(pipeline: string): PipelineResult {
  return {
    pipeline,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    items: [],
    exitCode: 0,
    messages: [],
  };
}
