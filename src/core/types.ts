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
  /** Comma-separated catalog feature ids. `platform` marks foundation and UI specs. */
  feature?: string;
  /** Surface this spec implements: ui, api, or mcp. */
  channel?: string;
  /** Any metadata key not in the known set, preserved verbatim. */
  extra: Record<string, string>;
}

/**
 * One acceptance-criteria bullet. `id` is the stable `<!-- claim: slug -->`
 * anchor when present. Bullets without an anchor stay in the list so callers
 * can see which criteria are not yet addressable by a proof.
 */
export interface SpecClaim {
  id?: string;
  /** Bullet text with the checkbox and the claim comment removed. */
  text: string;
  /** Set when the bullet uses a `- [ ]` / `- [x]` checkbox. */
  checked?: boolean;
}

/** One invariant inside a `type: journey` spec. */
export interface JourneyInvariant {
  /** Heading slug, stable within the journey file. */
  id: string;
  description: string;
  /** Full claim refs, `repo:specKey#claimId` or `specKey#claimId`. */
  verifies: string[];
}

/** Sections required on a journey spec. Empty strings when a section is absent. */
export interface JourneySpec {
  world: string;
  actorsAndGoals: string;
  invariants: JourneyInvariant[];
  budget: string;
  evidence: string;
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
  /** Acceptance-criteria bullets, with claim anchors when present. */
  claims: SpecClaim[];
  /**
   * Populated when `meta.type` is `journey` or the spec has an Invariants section.
   * Absent for ordinary module specs.
   */
  journey?: JourneySpec;
  /** Parsed `## Scenarios`. */
  scenarios: SpecScenario[];
  /** Text under `## Security Notes`. */
  securityNotes: string;
  /** Text under `## Dependencies`. */
  dependencies: string;
  /**
   * Text under `## Visual Expectations`.
   * Describes layout, colour, typography, and visual design requirements for UI specs.
   * Empty string for non-UI / module specs.
   */
  visualExpectations: string;
  /**
   * Text under `## Accessibility Requirements`.
   * WCAG criteria, keyboard navigation, ARIA requirements, and colour contrast rules.
   * Empty string when the section is absent.
   */
  accessibilityRequirements: string;
  /**
   * Text under `## UX Guidelines`.
   * Interaction patterns, micro-copy, loading states, and error handling UX expectations.
   * Empty string when the section is absent.
   */
  uxGuidelines: string;
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
  /**
   * Target programming language for this app. Drives language-specific
   * behavior via `src/core/language-profiles.ts`. Absent ⇒ `'typescript'`.
   */
  language?: 'typescript' | 'python' | 'go' | 'rust' | 'java' | string;
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
  /**
   * Additional glob patterns for test files outside this app's `testOutput`
   * directory — e.g. cross-repo regression suites. Resolved relative to the
   * directory containing `.specguard/config.json`. Used by `align` and `matrix`.
   *
   * Example: `["../e2e-suite/specs/auth/*.spec.ts"]`
   */
  extraTestSources?: string[];
  /**
   * Glob patterns for source files to exclude from spec generation.
   * Files matching any pattern are filtered out before `reverse` processes them.
   * Useful for skipping index/barrel files that contain no meaningful logic.
   *
   * Example: `["**\/index.ts", "**\/index.tsx"]`
   */
  exclude?: string[];
  /**
   * Glob patterns identifying source files whose parent directory should be
   * treated as a single feature. All matching files in the same directory are
   * concatenated and sent to the LLM as one prompt, producing one spec per
   * directory rather than one per file.
   *
   * Useful for GraphQL field-resolver directories, Angular component directories,
   * and React feature directories where multiple files implement one feature.
   *
   * Example (GraphQL): `["src/resolvers/!(mutations|queries)/**\/*.ts"]`
   * Example (Angular): `["src/app/pages/**\/*.ts"]`
   */
  collapse?: string[];
  /**
   * Repo-relative POSIX prefix (or prefixes) removed from a source path when it
   * is turned into a feature key, e.g. `src/features/`. When set, it replaces
   * the legacy heuristic that drops a leading `src/`/`tests/` segment and the
   * next (area) segment. The first matching prefix wins.
   */
  stripPrefix?: string | string[];
  /**
   * Files (paths or globs relative to `repo`) that declare the app's routes or
   * endpoints. Used by `index`. Absent: the framework profile's defaults.
   */
  entryPoints?: string[];
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

/** A named authentication profile for the validate pipeline. */
export interface AuthProfile {
  /** Profile name, referenced by spec `auth:` metadata. */
  name: string;
  /** URL of the login page. */
  loginUrl: string;
  /** Name of env var holding the username. */
  usernameEnvVar: string;
  /** Name of env var holding the password. */
  passwordEnvVar: string;
  /** Optional selector for the username input (default: [name="username"], [type="email"]). */
  usernameSelector?: string;
  /** Optional selector for the password input (default: [type="password"]). */
  passwordSelector?: string;
  /** Optional selector for the submit button (default: [type="submit"]). */
  submitSelector?: string;
}

/** Authentication configuration block. */
export interface AuthConfig {
  profiles: AuthProfile[];
}

/**
 * Locations that used to be hard-coded. Every path is relative to the
 * directory containing `.specguard/` unless absolute.
 */
export interface PathsConfig {
  /** Root of the spec tree for single-repo layouts. Default `specs`. */
  specsRoot?: string;
  /** Where `docs` writes user documentation. Default `docs/user`. */
  docsOut?: string;
  /** Where `security` writes generated tests. Default `tests/security`. */
  securityTests?: string;
  /** Proof ledger file. Default `.specguard/proofs.json`. */
  proofLedger?: string;
}

/** Feature-state (`specguard features --state`) settings. */
export interface FeatureStateConfig {
  /** Feature catalog directory (versioned YAML), relative to the config/workspace root. */
  catalog?: string;
  /** Directories of normalized FeatureCase JSON. */
  resultsDirs?: string[];
  /** Reporter output files (or globs) read as test results. */
  reporters?: Array<{ path: string; kind?: string; format?: string }>;
  /** Spec `type:` -> channel (ui | api | mcp). */
  channelByType?: Record<string, string>;
  /** Repo key -> channel its specs implement. */
  repoChannels?: Record<string, string>;
  /** External-id adapters to apply: generic, zephyr, jira. */
  externalIds?: string[];
}

/** The fully parsed `.specguard/config.json`. */
export interface SpecGuardConfig {
  /** Built-in plugins to enable: directory names under `src/plugins/`. Empty means none. */
  plugins?: string[];
  featureState?: FeatureStateConfig;
  /** Optional path to a parent config this one extends. Without it, no parent config is inherited. */
  extends?: string;
  paths?: PathsConfig;
  apps: AppConfig[];
  runners?: RunnersConfig;
  llm: LlmConfig;
  triggers?: TriggersConfig;
  heal?: HealConfig;
  matrix?: MatrixConfig;
  auth?: AuthConfig;
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
