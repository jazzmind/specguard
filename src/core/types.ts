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
 * Role of a v2 spec in the hierarchy. `system` is the single master spec,
 * `capability` a functional area that delivers user or business value,
 * `component` an optional sub-spec (for example frontend or backend) of a
 * capability, and `journey` a cross-spec journey with invariants.
 */
export type SpecKind = 'system' | 'capability' | 'component' | 'journey';

export const SPEC_KINDS: readonly SpecKind[] = ['system', 'capability', 'component', 'journey'];

/**
 * Parsed `<!-- key: value -->` metadata block from a spec file.
 * Known keys are typed; anything else lands in `extra`.
 */
import type { ExampleIssue, ExampleTable } from './examples.js';
import type { LayerRequirements, TestLayer } from './test-layers.js';
import type { SystemStatement } from './proof-statement.js';
import type { CoverageFormat } from './coverage.js';

/** How strongly a claim is assured, weakest first. */
export const ASSURANCE_LEVELS = ['tested', 'property', 'bounded', 'proved-model', 'proved-code'] as const;
export type Assurance = (typeof ASSURANCE_LEVELS)[number];

/**
 * How strictly a capability's proof statement gates a change, weakest first: `observe` only reports, `warn` annotates
 * and allows, `enforce` blocks (in the hooks and in CI). Per-capability policy, so a repo can ratchet one capability at a time.
 */
export const ENFORCE_LEVELS = ['observe', 'warn', 'enforce'] as const;
export type EnforceLevel = (typeof ENFORCE_LEVELS)[number];

/** A capability's `assurance:` frontmatter. Values off the ladder are returned in `unknown`, not dropped. */
export interface AssuranceRequirements {
  default?: Assurance;
  claims: Record<string, Assurance>;
  unknown: string[];
}

/** A claim proven by a person or an agentic check instead of an automated layer. An empty `verifier` is kept so the lint can report it. */
export interface EvidenceDeclaration {
  kind: 'agentic' | 'manual';
  verifier: string;
}

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
  /** v2 frontmatter: stable id, equal to the file's basename. Absent on v1 specs. */
  id?: string;
  /** v2 frontmatter: role in the hierarchy. Its presence marks a spec as v2. */
  kind?: SpecKind;
  /** v2 frontmatter: id of the parent spec (a capability's parent is the system spec). */
  parent?: string;
  /** v2 frontmatter: one-line statement of the user or business value delivered. */
  value?: string;
  /** v2 frontmatter: globs of the code files this spec owns, relative to the repo. */
  sources?: string[];
  /** v2 frontmatter: globs of the tests that prove this spec. */
  tests?: string[];
  /** v2 frontmatter: globs of the docs that describe this spec. */
  docs?: string[];
  /** v2 frontmatter: ids of the requirement-history entries behind this spec. */
  history?: string[];
  /** v2 frontmatter: the test layers the claims need as proof (`layers: [unit, e2e]` or a default plus per-claim lists). */
  layers?: LayerRequirements;
  /** v2 frontmatter: the assurance level the claims need (`assurance: tested` or a default plus per-claim levels). Not part of any claim hash. */
  assurance?: AssuranceRequirements;
  /** v2 frontmatter: claims that cannot be automated, each with the kind of evidence and who or what verifies it. Not part of any claim hash. */
  evidence?: Record<string, EvidenceDeclaration>;
  /** v2 frontmatter: the ratchet level (`enforce: warn`). Absent means the config's `enforce.default`. Policy, not intent: not part of any claim hash. */
  enforce?: EnforceLevel;
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
  /** The examples table under the bullet (v2 specs only). It never enters `text`, so it never changes the claim hash. */
  examples?: ExampleTable;
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
  /** Key relative to the owning app's `specDir`; set by `loadCanonicalSpecs` (equals `specKey` in single-app layouts). */
  localKey?: string;
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
  /** Problems found in the examples tables of a v2 spec. Empty for v1 specs and specs without tables. */
  exampleIssues: ExampleIssue[];
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
  /** How to run this app's tests. Absent: the shared `heal.testCommand` or the language default. */
  test?: AppTestConfig;
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

/** Per-app test invocation. */
export interface AppTestConfig {
  /** Shell command, e.g. `npx vitest run` or `pnpm test`. */
  command?: string;
  /** Working directory, relative to the config root. Default: the config root. */
  cwd?: string;
  /** Test-runner adapter: vitest | jest | playwright | pytest | junit | go | cargo. Default: from the language profile. */
  reporter?: string;
  /** Reporter output file or glob (relative to `cwd`). When set the command runs verbatim. */
  resultsFile?: string;
  /** Kill the run after this many milliseconds. Default 600000. */
  timeoutMs?: number;
  /** Docker image for `runners.testRunner: "docker"`. */
  image?: string;
  /**
   * Environment variables holding credentials SpecGuard withholds from test commands (the model keys, `SPECGUARD_TOKEN`)
   * that this app's tests do need. Everything else in the environment is passed as usual.
   */
  passEnv?: string[];
  /** Globs (relative to the config root) that put test files in a layer. Beats the path conventions. */
  layers?: Partial<Record<TestLayer, string[]>>;
  /** Regexes (source text) marking this app's tests as flag- or environment-gated; added to `testStrength.conditional` for its files. */
  conditional?: string[];
  /**
   * How this app's test run emits coverage. `test run --coverage` appends `flags` to the command and ingests `reports`
   * with the run's scope. Absent: no coverage is requested, and changed lines no claim test reaches read as unknown.
   */
  coverage?: AppCoverageConfig;
  /**
   * Several suites for one app, each with its own command and layer (for example vitest for unit and Playwright
   * for e2e). When set they replace the app's single `command`; a suite inherits `cwd`, `reporter` and
   * `timeoutMs` from the app unless it sets its own.
   */
  suites?: TestSuiteConfig[];
}

/** The `apps[].test.coverage` block. */
export interface AppCoverageConfig {
  /** Extra arguments that make the runner write a coverage report, appended to the test command (for example `--coverage`). */
  flags?: string;
  /** Report files or globs the run writes, relative to the config root. */
  reports: string[];
  /** Report format. Default: detected from each file. */
  format?: CoverageFormat | 'auto';
}

/** One suite of an app: a command that writes a report, and the layer its tests belong to. */
export interface TestSuiteConfig {
  name: string;
  layer?: TestLayer;
  command?: string;
  cwd?: string;
  reporter?: string;
  resultsFile?: string;
  timeoutMs?: number;
}

export type TestabilityRuleId =
  | 'T-NO-ANCHOR'
  | 'T-EMPTY'
  | 'T-PLACEHOLDER'
  | 'T-VAGUE'
  | 'T-OPEN-LIST'
  | 'T-DENY'
  | 'T-HEDGE'
  | 'T-SUBJECTIVE'
  | 'T-PASSIVE'
  | 'T-NO-OUTCOME'
  | 'T-COMPOUND'
  | 'T-LONG'
  | 'T-VARIES-NO-EXAMPLES'
  | 'T-SUCH-AS'
  | 'T-EVIDENCE-VERIFIER'
  | 'T-EVIDENCE-LAYER-CONFLICT'
  | 'T-ASSURANCE-UNKNOWN'
  | 'T-LAYER-UNKNOWN'
  | `T-EX-${string}`;
export type RuleSeverity = 'off' | 'warn' | 'error';

/** The top-level `testability` config block. Config is code, so every change to it is reviewed. */
export interface TestabilityConfig {
  /** Per-rule severity override. */
  rules?: Partial<Record<TestabilityRuleId, RuleSeverity>>;
  /** Terms or phrases never flagged by any word-list rule (case-insensitive, whole tokens), such as "fast tier". */
  allow?: string[];
  /** Extra terms flagged as T-DENY (error). */
  deny?: string[];
  /** Clauses a claim may have before T-COMPOUND fires. Default 3. */
  maxClauses?: number;
  /** Words a claim may have before T-LONG fires. Default 80. */
  maxWords?: number;
  /** Claim ref -> rules downgraded from error to warn for that claim only, never to off. */
  waive?: Record<string, TestabilityRuleId[]>;
}

/** The top-level `coverage` config block: how report paths map onto repo files. */
export interface CoverageConfig {
  /** Checkout prefixes to strip from report paths, e.g. `/home/runner/work/app/app/` or `C:/a/app/`. */
  pathPrefixes?: string[];
  /** JaCoCo and PIT source roots tried under a package path. Default `src/main/java`, `src/main/kotlin`, `src/main/scala`. */
  sourceRoots?: string[];
}

/** The top-level `mutation` config block: when mutation evidence counts. */
export interface MutationConfig {
  /** Percentage of detected mutants a claim (or, without per-test coverage, a capability) needs. Default 70. */
  minScore?: number;
  /** Mutants a claim's tests must kill at least. Default 1. */
  minKilled?: number;
  /** Count a timed-out mutant as killed. Default true. */
  timeoutAsKilled?: boolean;
  /** `full` when the tool lists every killing test (Stryker `disableBail`, PIT full matrix). Default: detected from the report. */
  attribution?: 'full' | 'first-kill';
  /** Command CI runs to produce mutation evidence, scoped to the changed owned files: `{files}` is replaced by them. Absent: sensitivity relies on red-to-green. */
  command?: string;
}

/** How layers of evidence are required and enforced. */
export interface ProofConfig {
  /** Layers every claim needs unless its capability says otherwise. Default: none. */
  requiredLayers?: TestLayer[];
  /** `warn` (default) reports claims missing a required layer; `fail` makes `proof status` fail on them; `off` does not report. */
  enforceLayers?: 'off' | 'warn' | 'fail';
  /** When true, a claim whose current wording a person has not approved blocks `check` (exit 13). Approval stays its own pillar of the proof statement and never changes a claim's proof verdict. Default: false. */
  requireApproval?: boolean;
  /** When true, a claim or spec that fails the testability lint (the Testable pillar) blocks `check`. Default: false. */
  requireTestable?: boolean;
  /** When true, tests that cannot fail (skipped, conditional or weak) block `check`. Default: false. */
  requireStrength?: boolean;
  /** When true, a changed claim with no evidence that its tests detect a change (mutation or red-green) blocks `check`. Default: false. */
  requireSensitivity?: boolean;
  /** When true, a claim whose proof is failed, stale, unproven or missing a required layer blocks `check`. Default: false. */
  requireConforms?: boolean;
  /** When true, coverage evidence that shows the code is not the specified behaviour (the Aligned pillar) blocks `check`. Default: false. */
  requireAlignment?: boolean;
  /** When true, proof earned on a local or server run does not count for Conforms; only CI evidence does. Default: false. */
  requireCi?: boolean;
  /** Turns every `require*` gate on and `enforceLayers` to `fail`, whatever else is set. Default: false. */
  strict?: boolean;
  /** Minimum percentage of changed executable lines that tests must reach. Default: 80. */
  minDiffCoverage?: number;
}

/** How test sources are judged for strength (skipped, conditional, weak). All fields optional; see `resolveStrengthConfig`. */
export interface TestStrengthSettings {
  /** Regexes (source text) marking a test as flag/env-gated. List exactly the gates normal CI does not open. */
  conditional?: string[];
  /** Function names (exact, or ending in `*` as a prefix wildcard) that assert; their calls count as strong. */
  assertHelpers?: string[];
  /** Default true: a test whose only assertions are snapshots is weak. */
  snapshotIsWeak?: boolean;
}

/** Runner placement: where each external tool executes. */
export interface RunnersConfig {
  playwright?: 'local' | 'docker' | string;
  semgrep?: 'local' | 'docker' | 'auto' | string;
  testRunner?: 'local' | 'docker' | string;
}

/** One place a call can go: provider, model, and the env var holding its key. */
export interface LlmTarget {
  provider: string;
  model: string;
  apiKeyEnv?: string;
}

/** Hard cap on LLM spend for one process run. Any field that is set is enforced. */
export interface LlmBudget {
  maxUsd?: number;
  maxTokens?: number;
  maxCalls?: number;
}

/** Per-million-token prices used for the cost estimate. */
export interface LlmPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Model tier names accepted by `llm.models` and `llm.pipelines.<name>.tier`. */
export type LlmTier = 'fast' | 'frontier';

/** How coarse generated specs are. */
export interface GranularityConfig {
  /** Capability count `spec draft` aims for, `[min, max]`. Default `[8, 15]`. */
  target?: [number, number];
  /** `spec graph` validation warns above this many capability specs. Default 20. */
  maxCapabilities?: number;
}

/** LLM provider configuration. */
export interface LlmConfig {
  /** anthropic | openai | litellm | replay (serve recordings) | none (deterministic only). */
  provider: 'anthropic' | 'openai' | 'litellm' | 'replay' | 'none' | string;
  model: string;
  /** Name of the env var holding the API key. */
  apiKeyEnv: string;
  /**
   * Endpoint for the `openai` and `litellm` providers (an OpenAI-compatible gateway). Overrides the
   * `OPENAI_BASE_URL` / `LITELLM_BASE_URL` environment variables, so one server process can serve projects
   * that use different gateways.
   */
  baseUrl?: string;
  /**
   * Named model tiers. `fast` serves high-volume, latency-sensitive calls
   * (file summaries, on-demand docs, history proposals); `frontier` serves
   * clustering and spec-level review. Unset tiers fall back to the top-level model.
   */
  models?: Partial<Record<LlmTier, LlmTarget>>;
  /**
   * Per-pipeline overrides keyed by pipeline name (reverse, align, drift, heal, ...).
   * `tier` picks one of `models`; an explicit `provider`/`model` wins over it.
   */
  pipelines?: Record<string, Partial<LlmTarget> & { fallback?: LlmTarget[]; tier?: LlmTier }>;
  /** Tried in order after the primary target has failed all its attempts. */
  fallback?: LlmTarget[];
  /** Per-attempt timeout. Default 120000. */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable failures. Default 2. */
  retries?: number;
  /** First backoff delay; doubles per retry with jitter. Default 1000. */
  backoffMs?: number;
  budget?: LlmBudget;
  /** Overrides for the built-in price table, keyed by model name. */
  pricing?: Record<string, LlmPrice>;
  /** When false, a call that carries images is rejected and `validate` sends none. Default true. */
  allowImages?: boolean;
  /**
   * Mask credentials (API keys, bearer tokens, JWTs, private keys, `password=` style values) in every prompt and system
   * message before it leaves the machine. Default true; false is an explicit opt-out.
   */
  redactPrompts?: boolean;
  /** Extra regular expressions masked as `[REDACTED]` in every prompt, on top of the built-in credential masks. */
  redactPatterns?: string[];
  replay?: {
    /** Directory for recordings, relative to the config root. Default `.specguard/replay`. */
    dir?: string;
    /** Record every real response (also set by `--record`). */
    record?: boolean;
  };
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

/** How a profile gets the browser logged in. */
export type AuthStrategy = 'form' | 'storageState' | 'header' | 'token' | 'script';

/**
 * A named authentication profile for the validate pipeline. Each profile gets
 * its own browser context. Credentials are only ever read from environment
 * variables named here, never stored in config and never sent to the LLM.
 */
export interface AuthProfile {
  /** Profile name, referenced by spec `auth:` metadata. */
  name: string;
  /** Default `form`. */
  strategy?: AuthStrategy;

  // --- form (also used by storageState to create the state file) -----------
  /** URL of the login page. */
  loginUrl?: string;
  /** Name of env var holding the username. */
  usernameEnvVar?: string;
  /** Name of env var holding the password. */
  passwordEnvVar?: string;
  /** Optional selector for the username input (default: [name="username"], [type="email"]). */
  usernameSelector?: string;
  /** Optional selector for the password input (default: [type="password"]). */
  passwordSelector?: string;
  /** Optional selector for the submit button (default: [type="submit"]). */
  submitSelector?: string;
  /** URL (or `/regex/`) the browser must reach after login. Default: any URL other than the login page. */
  successUrl?: string;
  /** Selector that must be visible after login. */
  successSelector?: string;

  // --- storageState ----------------------------------------------------------
  /** Saved browser state. Default `.specguard/auth/<name>.json`. */
  storageStatePath?: string;

  // --- header / token --------------------------------------------------------
  /** Header name -> name of the env var that holds its value. */
  headers?: Record<string, string>;
  /** Env var holding a bearer token (sent as `Authorization: Bearer <token>`). */
  tokenEnvVar?: string;
  /** Header for the token. Default `Authorization`. */
  tokenHeader?: string;
  /** Prefix before the token. Default `Bearer `. Use an empty string for a bare token. */
  tokenPrefix?: string;

  // --- script ----------------------------------------------------------------
  /** Module (relative to the config root) whose default export is `async ({ page, context, profile }) => void`. */
  scriptPath?: string;
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
  /** Where `verify --emit-tests` writes generated Playwright tests. Default `tests/e2e`. */
  e2eTests?: string;
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
  /** `list`: catalog files are bare feature lists (no `version:` wrapper). Default `document`. */
  catalogFormat?: 'document' | 'list';
  /** File-name globs in the catalog directory that are not features (`*` and `?`). */
  catalogExclude?: string[];
  /** Extra directory stems tried when resolving a spec `module:` to a source file. */
  moduleStems?: string[];
  /** Ignore the first N dot-separated segments of a feature id when deciding which sibling a test file belongs to. */
  idSkipSegments?: number;
  /** Regex source: a catalog summary matching it is a placeholder to replace with the spec overview. */
  placeholderSummaryPattern?: string;
  /** Regex source (case-insensitive): a spec module or key matching it implements the MCP channel. */
  mcpModulePattern?: string;
  /** Where agent tools (for example MCP tools) are declared, so a feature's MCP channel can be found. */
  agentTools?: {
    /** Key of the repo that holds the tools. */
    repo: string;
    /** Directory of tool declarations inside it. Default `src/tools`. */
    dir?: string;
    /** Regex source with one capture group: the tool's name. Default matches `server.tool('name'`. */
    namePattern?: string;
    /** Regex source: files whose path matches declare tools that do not count as the feature's MCP channel. */
    excludedPathPattern?: string;
  };
}

/** Settings for `specguard validate`. */
export interface ValidateConfig {
  /** Run the browser headless. Default true. `--headed` overrides. */
  headless?: boolean;
  /** v2 specs: plan-act rounds per capability, so one run can walk a multi-page journey. Default 3. */
  maxRounds?: number;
  /** Wall-clock limit for one spec's check, in milliseconds. The check stops planning further steps when it passes. Default 600000. */
  timeoutMs?: number;
  /** Delete evidence (screenshots, DOM) older than this many days at the start of a run. Default: keep it. */
  evidenceRetentionDays?: number;
  /** Hosts an agent-started check (the MCP tool) may target besides loopback: `host`, `host:port` or `*.domain`. */
  allowedHosts?: string[];
  /**
   * Write a Playwright test from each passing capability check (`tests/e2e/<capability>.verify.spec.ts` or `paths.e2eTests`).
   * Off by default; `verify --emit-tests` turns it on for one run.
   */
  emitTests?: boolean;
  guardrails?: {
    /** Words or phrases that always block. */
    deny?: string[];
    /** Words or phrases that are always safe. */
    allow?: string[];
    /** Let outbound actions run (staging). `--allow-outbound` overrides. */
    allowOutbound?: boolean;
  };
  redaction?: {
    builtin?: boolean;
    patterns?: string[];
    blankSelectors?: string[];
    hookPath?: string;
  };
}

/** Settings for `specguard remediate`. Every field is optional. */
export interface RemediateConfig {
  /** Lowest severity to remediate: critical | high | moderate | low. Default high. */
  minSeverity?: string;
  allowMajor?: boolean;
  /** Most advisories handled in one run. Default 5. */
  maxAdvisories?: number;
  /** Abort when a change touches more files than this. Default 20. */
  maxFilesChanged?: number;
  /** Abort when a change touches more lines than this. Default 2000 (lockfiles included). */
  maxLinesChanged?: number;
  /** Command run after install. Absent: the `build` script of package.json when there is one. */
  buildCommand?: string;
  typecheckCommand?: string;
  /** Overrides the ecosystem install command. */
  installCommand?: string;
  /** Per-step timeout in milliseconds. Default 600000. */
  stepTimeoutMs?: number;
  /** Branch the PR targets. Default: the current branch. */
  baseBranch?: string;
  /** Branch name prefix. Default `specguard/remediate/`. */
  branchPrefix?: string;
  /** Run tests in docker (uses each app's test.image). Default: follows `runners.testRunner`. */
  sandbox?: 'local' | 'docker';
  /** Use OSV-Scanner when available. Default true. */
  osv?: boolean;
  semgrep?: boolean;
  gitleaks?: boolean;
  /** Treat claims with no exercising test in the baseline as INCONCLUSIVE. Default true. */
  strictUnexercised?: boolean;
  /**
   * Auto-merge of dependency fixes that provably keep every proof. Off unless `enabled` and `--auto-merge` are
   * both set; it only arms GitHub auto-merge on a base branch that requires status checks.
   */
  autoMerge?: {
    enabled?: boolean;
    /** Packages never auto-merged. */
    denyPackages?: string[];
    /** Allow minor bumps at 1.0 or later. Default true. */
    allowMinor?: boolean;
  };
}

/** Values of `proofStore.verify`: `check-run` trusts a note only when the CI check run carries its digest; `off` (default) does not check. */
export const PROOF_STORE_VERIFY = ['off', 'check-run'] as const;
export const PROOF_STORE_AUTOFETCH = ['session', 'off'] as const;

/** The `proofStore` block: where CI proof notes live in git and how they are read. */
export interface ProofStoreConfig {
  /** Notes ref. Default `refs/notes/specguard`. */
  notesRef?: string;
  /** Remote notes are fetched from and pushed to. Default `origin`. */
  remote?: string;
  /** Commits walked looking for the nearest noted ancestor. Default 500. */
  maxWalk?: number;
  /** Authenticate notes against a CI check run. Default `off` (opt-in). */
  verify?: (typeof PROOF_STORE_VERIFY)[number];
  /** `session`: the agent plugin fetches notes in the background at session start. Default `session`. */
  autoFetch?: (typeof PROOF_STORE_AUTOFETCH)[number];
  /** `proof prune` removes notes of unreachable commits older than this many days. Default 90. */
  pruneDays?: number;
}

export const PROOF_STORE_DEFAULTS = {
  notesRef: 'refs/notes/specguard',
  remote: 'origin',
  maxWalk: 500,
  verify: 'off',
  autoFetch: 'session',
  pruneDays: 90,
} as const satisfies Required<ProofStoreConfig>;

export const RED_ACCEPTS_ERRORS = ['never', 'added-only', 'always'] as const;

/** The `change` block: the spec-first change protocol. */
export interface ChangeConfig {
  /** Ref the base of a change is computed from, after `--base` and the change record's own `baseRef`. */
  baseRef?: string;
  /** When a test that errors (does not compile or import) counts as red. Default `added-only`: only for an added claim. */
  redAcceptsErrors?: (typeof RED_ACCEPTS_ERRORS)[number];
  /** Owned code changed with no open change covering its capability fails at `enforce`. Default true. */
  requireChangeRecord?: boolean;
  /** Dependency directories symlinked into the constructed red worktree. Default: by ecosystem (`node_modules`, `.venv`, `vendor`). */
  worktreeLinks?: string[];
}

export const CHANGE_DEFAULTS = { redAcceptsErrors: 'added-only', requireChangeRecord: true } as const;

/** The `enforce` block: defaults for the per-capability `enforce:` frontmatter. */
export interface EnforceConfig {
  /** Level of a capability that sets none. Default `observe`. */
  default?: EnforceLevel;
  /** Level written into a new capability's frontmatter by `change start`. Default: `enforce.default`. */
  newCapabilities?: EnforceLevel;
}

export const ENFORCE_DEFAULTS = { default: 'observe' } as const satisfies { default: EnforceLevel };

export const HOOK_ON_ERROR = ['allow', 'deny'] as const;

/** The `hooks` block: the agent edit guards. */
export interface HooksConfig {
  /** What a hook that errors, times out or cannot read its index does. `allow` (default) fails open and CI stays the gate; `deny` fails closed in a repo with an `enforce` capability. */
  onError?: (typeof HOOK_ON_ERROR)[number];
  /** After a Bash command, report owned files of an `enforce` capability it changed with no qualifying change. Default false. */
  bashGuard?: boolean;
}

export const HOOKS_DEFAULTS = { onError: 'allow', bashGuard: false } as const;

export const APPROVAL_REQUIRE_REVIEW = ['enforce', 'always', 'never'] as const;

/** The `approvals` block. */
export interface ApprovalsConfig {
  /** How CI trusts approvals. */
  ci?: {
    /** When a recorded approval added in a PR needs an approving review from someone other than the author: for capabilities at `enforce` (default), `always`, or `never`. */
    requireReview?: (typeof APPROVAL_REQUIRE_REVIEW)[number];
    /** A solo maintainer's recorded approvals count, labelled self-approved, without a second reviewer. Default false. */
    allowSelf?: boolean;
  };
}

export const APPROVALS_CI_DEFAULTS = { requireReview: 'enforce', allowSelf: false } as const;

export const UNREQUESTED_SEVERITY = ['error', 'warn'] as const;

/** The `unrequested` block: code no requirement asked for. */
export interface UnrequestedConfig {
  /** Whether changed owned lines that no claim test reaches count as an error (default; it then blocks at `enforce`) or a warning. */
  severity?: (typeof UNREQUESTED_SEVERITY)[number];
}

export const UNREQUESTED_DEFAULTS = { severity: 'error' } as const;

/** The `ci` block. */
export interface CiConfig {
  /** On pull requests, also run the touched capabilities' full claim tests with coverage to classify incidental lines. Default true. */
  capabilityCoverage?: boolean;
}

export const CI_DEFAULTS = { capabilityCoverage: true } as const;

/** The fully parsed `.specguard/config.json`. */
/**
 * A SpecGuard team server this project can use. The CLI works fully without one: with `mode: auto` (the default)
 * it uses the server when it answers and falls back to local files when it does not.
 */
export interface ServerConfig {
  /** Base URL of the server, for example `https://specguard.example.com`. `SPECGUARD_SERVER` overrides it. */
  url?: string;
  /** The project's name on the server. Default: the repository directory name. */
  project?: string;
  /** Environment variable holding the access token. Default `SPECGUARD_TOKEN`. */
  tokenEnv?: string;
  /** `auto`: use the server if it answers. `off`: never. `required`: an unreachable server is an error (for CI). */
  mode?: 'auto' | 'off' | 'required';
  /** How long to wait for the server's health check, in milliseconds. Default 800. */
  timeoutMs?: number;
}

/** An npm plugin. Importing a package runs its code, so it loads only when named explicitly in config. */
export interface NpmPluginRef {
  /** The id the package's plugin declares. */
  name: string;
  /** npm package name, resolved from the project's own `node_modules`. */
  package: string;
}

export type PluginEntry = string | NpmPluginRef;

export interface SpecGuardConfig {
  /**
   * Plugins to enable. A string names a built-in plugin (a directory under `src/plugins/`);
   * `{ name, package }` names an npm package, which is imported only because it is listed here.
   * Empty means none.
   */
  plugins?: PluginEntry[];
  /**
   * Plugin ids to leave out even though a config this one extends enables them. `extends` replaces arrays
   * wholesale, so this is how a repo turns off one inherited plugin without restating the rest.
   */
  disabledPlugins?: string[];
  /** Optional team server; see {@link ServerConfig}. */
  server?: ServerConfig;
  featureState?: FeatureStateConfig;
  /** Optional path to a parent config this one extends. Without it, no parent config is inherited. */
  extends?: string;
  paths?: PathsConfig;
  /** Required test layers and how strictly they are enforced. */
  proof?: ProofConfig;
  /** How strongly tests must assert; see {@link TestStrengthSettings}. */
  testStrength?: TestStrengthSettings;
  /** How strictly claims are linted for testability; see {@link TestabilityConfig}. */
  testability?: TestabilityConfig;
  /** How coverage report paths are mapped onto repo files; see {@link CoverageConfig}. */
  coverage?: CoverageConfig;
  /** When mutation evidence counts; see {@link MutationConfig}. */
  mutation?: MutationConfig;
  /** Proof notes in git; see {@link ProofStoreConfig}. */
  proofStore?: ProofStoreConfig;
  /** The change protocol; see {@link ChangeConfig}. */
  change?: ChangeConfig;
  /** Defaults for the per-capability ratchet; see {@link EnforceConfig}. */
  enforce?: EnforceConfig;
  /** The agent edit guards; see {@link HooksConfig}. */
  hooks?: HooksConfig;
  /** How CI trusts approvals; see {@link ApprovalsConfig}. */
  approvals?: ApprovalsConfig;
  /** Code no requirement asked for; see {@link UnrequestedConfig}. */
  unrequested?: UnrequestedConfig;
  /** CI behaviour; see {@link CiConfig}. */
  ci?: CiConfig;
  granularity?: GranularityConfig;
  /** Requirement-history settings. */
  history?: { failOnIntentGap?: boolean };
  /** The `contract-mappings` plugin: where its mappings file is and what its keys are called. */
  contractMappings?: {
    /** File relative to the repo. Default `.specguard/contract-mappings.json`. */
    file?: string;
    /** Key of the list of mappings. Default `mappings`. */
    list?: string;
    /** Key of the consuming spec in each mapping. Default `spec`. */
    spec?: string;
    /** Keys whose values are the files a spec depends on. Default `['providers']`. */
    providers?: string[];
    /** Key of the documentation page a spec is described by. Default `docs`. */
    docs?: string;
    /** Contract type for provider edges. Default `dependency`. */
    edgeType?: string;
  };
  apps: AppConfig[];
  runners?: RunnersConfig;
  llm: LlmConfig;
  triggers?: TriggersConfig;
  heal?: HealConfig;
  matrix?: MatrixConfig;
  auth?: AuthConfig;
  validate?: ValidateConfig;
  remediate?: RemediateConfig;
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
  /** The proof statement, set by `check` (see `src/core/proof-statement.ts`). */
  statement?: SystemStatement;
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
