import { applyOutputLocations } from './output-locations.js';
/**
 * Config loader for SpecGuard.
 *
 * Locates the nearest `.specguard/config.json` by walking up from a starting
 * directory, parses it, validates it against a Zod schema mirroring
 * `SpecGuardConfig`, and stamps `rootDir` onto the result. This is the only
 * module that reads the config file — pipelines receive a typed config.
 */
import { TEST_LAYERS } from './test-layers.js';
import path from 'node:path';
import { z } from 'zod';
import {
  APPROVALS_CI_DEFAULTS,
  APPROVAL_REQUIRE_REVIEW,
  CHANGE_DEFAULTS,
  CI_DEFAULTS,
  ENFORCE_DEFAULTS,
  ENFORCE_LEVELS,
  HOOKS_DEFAULTS,
  HOOK_ON_ERROR,
  PROOF_STORE_AUTOFETCH,
  PROOF_STORE_DEFAULTS,
  PROOF_STORE_VERIFY,
  RED_ACCEPTS_ERRORS,
  UNREQUESTED_DEFAULTS,
  UNREQUESTED_SEVERITY,
  type SpecGuardConfig,
} from './types.js';
import { COVERAGE_FORMATS } from './coverage.js';
import { ConfigNotFoundError, ConfigInvalidError } from './errors.js';
import { readFile, fileExists } from './reader.js';
import { configureLlm } from './llm-runtime.js';
import { isTestabilityRuleId } from './testability.js';
import { overlayMissHint, resolveConfigDirDetailed } from './overlay.js';

// ---------------------------------------------------------------------------
// Zod schema — mirrors the types in ./types.ts, permissive on unknown keys so
// the real config (and forward-compatible additions) validate cleanly.
// ---------------------------------------------------------------------------

/** A string that must compile as a regular expression (test-strength gate patterns). */
const regexSource = z.string().refine(
  (v) => {
    try {
      new RegExp(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a valid regular expression' },
);

/** A git ref name or remote name that cannot be read as an option (same rule as `resolveBase`). */
const gitRefName = z.string().regex(/^[\w][\w./@^~{}:+-]*$/, { message: 'not a usable git ref name' });
const gitRemoteName = z.string().regex(/^[\w][\w.-]*$/, { message: 'not a usable git remote name' });
const notesRefName = z
  .string()
  .regex(/^refs\/notes\/[\w][\w./-]*$/, { message: 'a notes ref starts with refs/notes/' });
/** A relative path with no `..` segment: it names something inside the repository. */
const insidePath = z.string().min(1).refine((v) => !v.startsWith('/') && !/^[A-Za-z]:/.test(v) && !v.split(/[\\/]/).includes('..'), {
  message: 'must be a relative path inside the repository',
});

const appSourcesSchema = z
  .object({
    routes: z.array(z.string()).optional(),
    pages: z.array(z.string()).optional(),
    api: z.array(z.string()).optional(),
    tests: z.array(z.string()).optional(),
  })
  .catchall(z.array(z.string()).optional());

const appSecuritySchema = z
  .object({
    enabled: z.boolean(),
    paths: z.array(z.string()).optional(),
  })
  .passthrough();

const appConfigSchema = z
  .object({
    name: z.string(),
    repo: z.string(),
    language: z.string().optional(),
    specDir: z.string(),
    sources: appSourcesSchema,
    framework: z.string(),
    testOutput: z.string(),
    security: appSecuritySchema.optional(),
    docs: z.union([z.boolean(), z.string()]).optional(),
    extraTestSources: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    collapse: z.array(z.string()).optional(),
    test: z
      .object({
        command: z.string().optional(),
        cwd: z.string().optional(),
        reporter: z.string().optional(),
        resultsFile: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        image: z.string().optional(),
        passEnv: z.array(z.string()).optional(),
        layers: z.record(z.enum(TEST_LAYERS), z.array(z.string())).optional(),
        conditional: z.array(regexSource).optional(),
        coverage: z
          .object({
            flags: z.string().optional(),
            reports: z.array(z.string().min(1)).min(1),
            format: z.enum(['auto', ...COVERAGE_FORMATS]).optional(),
          })
          .passthrough()
          .optional(),
        suites: z
          .array(
            z
              .object({
                name: z.string(),
                layer: z.enum(TEST_LAYERS).optional(),
                command: z.string().optional(),
                cwd: z.string().optional(),
                reporter: z.string().optional(),
                resultsFile: z.string().optional(),
                timeoutMs: z.number().int().positive().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    stripPrefix: z.union([z.string(), z.array(z.string())]).optional(),
    entryPoints: z.array(z.string()).optional(),
  })
  .passthrough();

const runnersSchema = z
  .object({
    playwright: z.string().optional(),
    semgrep: z.string().optional(),
    testRunner: z.string().optional(),
  })
  .passthrough();

const llmTargetSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    apiKeyEnv: z.string().optional(),
  })
  .passthrough();

/** Key variable for a provider when the config does not name one. */
const DEFAULT_KEY_ENV: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', litellm: 'LITELLM_API_KEY' };

/**
 * The whole `llm` block is optional. Without it a project uses Anthropic with `ANTHROPIC_API_KEY`, and inside a
 * coding agent with no key set the host agent does the model work (provider `host`, see core/agent-work.ts).
 */
const llmObjectSchema = z
  .object({
    provider: z.string().default('anthropic'),
    model: z.string().default('claude-sonnet-4-6'),
    apiKeyEnv: z.string().optional(),
    baseUrl: z.string().optional(),
    models: z.object({ fast: llmTargetSchema.optional(), frontier: llmTargetSchema.optional() }).optional(),
    pipelines: z
      .record(
        z.string(),
        z
          .object({
            provider: z.string().optional(),
            model: z.string().optional(),
            apiKeyEnv: z.string().optional(),
            tier: z.enum(['fast', 'frontier']).optional(),
            fallback: z.array(llmTargetSchema).optional(),
          })
          .passthrough(),
      )
      .optional(),
    fallback: z.array(llmTargetSchema).optional(),
    timeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().min(0).max(10).optional(),
    backoffMs: z.number().int().min(0).optional(),
    redactPrompts: z.boolean().optional(),
    redactPatterns: z.array(z.string()).optional(),
    budget: z
      .object({
        maxUsd: z.number().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        maxCalls: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    pricing: z.record(z.string(), z.object({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) })).optional(),
    allowImages: z.boolean().optional(),
    replay: z.object({ dir: z.string().optional(), record: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const llmSchema = llmObjectSchema
  .transform((l) => ({ ...l, apiKeyEnv: l.apiKeyEnv ?? DEFAULT_KEY_ENV[l.provider] ?? 'ANTHROPIC_API_KEY' }))
  .default({});

const triggersSchema = z
  .object({
    onPlanPhase: z.boolean().optional(),
    onSecurityFiles: z.array(z.string()).optional(),
    onPR: z.boolean().optional(),
    healAfterGenerate: z.boolean().optional(),
  })
  .passthrough();

const healSchema = z
  .object({
    maxRetries: z.number(),
    testCommand: z.string(),
  })
  .passthrough();

const matrixSchema = z
  .object({
    format: z.string(),
    output: z.string(),
  })
  .passthrough();

const authProfileSchema = z
  .object({
    name: z.string().min(1),
    strategy: z.enum(['form', 'storageState', 'header', 'token', 'script']).optional(),
    loginUrl: z.string().optional(),
    usernameEnvVar: z.string().optional(),
    passwordEnvVar: z.string().optional(),
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
    successUrl: z.string().optional(),
    successSelector: z.string().optional(),
    storageStatePath: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    tokenEnvVar: z.string().optional(),
    tokenHeader: z.string().optional(),
    tokenPrefix: z.string().optional(),
    scriptPath: z.string().optional(),
  })
  .passthrough()
  .superRefine((profile, ctx) => {
    const strategy = profile.strategy ?? 'form';
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `auth profile '${profile.name}': ${message}` });
    };
    if (strategy === 'form') {
      need(Boolean(profile.loginUrl && profile.usernameEnvVar && profile.passwordEnvVar), 'strategy form needs loginUrl, usernameEnvVar and passwordEnvVar');
    } else if (strategy === 'storageState') {
      // A saved state file is enough; a form login is optional and creates the file when it is missing.
    } else if (strategy === 'header') {
      need(Boolean(profile.headers && Object.keys(profile.headers).length > 0), 'strategy header needs headers (header name -> env var name)');
    } else if (strategy === 'token') {
      need(Boolean(profile.tokenEnvVar), 'strategy token needs tokenEnvVar');
    } else if (strategy === 'script') {
      need(Boolean(profile.scriptPath), 'strategy script needs scriptPath');
    }
  });

const validateSchema = z
  .object({
    headless: z.boolean().optional(),
    maxRounds: z.number().int().min(1).max(10).optional(),
    timeoutMs: z.number().int().positive().optional(),
    evidenceRetentionDays: z.number().positive().optional(),
    allowedHosts: z.array(z.string()).optional(),
    emitTests: z.boolean().optional(),
    guardrails: z
      .object({
        deny: z.array(z.string()).optional(),
        allow: z.array(z.string()).optional(),
        allowOutbound: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    redaction: z
      .object({
        builtin: z.boolean().optional(),
        patterns: z.array(z.string()).optional(),
        blankSelectors: z.array(z.string()).optional(),
        hookPath: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const pathsSchema = z
  .object({
    specsRoot: z.string().optional(),
    docsOut: z.string().optional(),
    securityTests: z.string().optional(),
    e2eTests: z.string().optional(),
    proofLedger: z.string().optional(),
  })
  .passthrough();

const featureStateSchema = z
  .object({
    catalog: z.string().optional(),
    resultsDirs: z.array(z.string()).optional(),
    reporters: z
      .array(z.object({ path: z.string(), kind: z.string().optional(), format: z.string().optional() }))
      .optional(),
    channelByType: z.record(z.string(), z.string()).optional(),
    repoChannels: z.record(z.string(), z.string()).optional(),
    externalIds: z.array(z.string()).optional(),
    catalogFormat: z.enum(['document', 'list']).optional(),
    catalogExclude: z.array(z.string()).optional(),
    moduleStems: z.array(z.string()).optional(),
    idSkipSegments: z.number().int().min(0).optional(),
    placeholderSummaryPattern: z.string().optional(),
    mcpModulePattern: z.string().optional(),
    agentTools: z
      .object({
        repo: z.string(),
        dir: z.string().optional(),
        namePattern: z.string().optional(),
        excludedPathPattern: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

const remediateSchema = z
  .object({
    minSeverity: z.enum(['critical', 'high', 'moderate', 'low']).optional(),
    allowMajor: z.boolean().optional(),
    maxAdvisories: z.number().int().positive().optional(),
    maxFilesChanged: z.number().int().positive().optional(),
    maxLinesChanged: z.number().int().positive().optional(),
    buildCommand: z.string().optional(),
    typecheckCommand: z.string().optional(),
    installCommand: z.string().optional(),
    stepTimeoutMs: z.number().int().positive().optional(),
    baseBranch: z.string().optional(),
    branchPrefix: z.string().optional(),
    sandbox: z.enum(['local', 'docker']).optional(),
    osv: z.boolean().optional(),
    semgrep: z.boolean().optional(),
    gitleaks: z.boolean().optional(),
    strictUnexercised: z.boolean().optional(),
    autoMerge: z
      .object({ enabled: z.boolean().optional(), denyPackages: z.array(z.string()).optional(), allowMinor: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const granularitySchema = z
  .object({
    target: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
    maxCapabilities: z.number().int().min(1).optional(),
  })
  .passthrough();

const testStrengthSchema = z
  .object({
    conditional: z.array(regexSource).optional(),
    assertHelpers: z.array(z.string().min(1)).optional(),
    snapshotIsWeak: z.boolean().optional(),
  })
  .passthrough();

const ruleSeverity = z.enum(['off', 'warn', 'error']);
const testabilityRuleId = z.string().refine(isTestabilityRuleId, { message: 'not a testability rule id' });

const testabilitySchema = z
  .object({
    rules: z.record(testabilityRuleId, ruleSeverity).optional(),
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
    maxClauses: z.number().int().min(1).optional(),
    maxWords: z.number().int().min(1).optional(),
    waive: z.record(z.string(), z.array(testabilityRuleId)).optional(),
  })
  .passthrough();

const coverageSchema = z
  .object({
    pathPrefixes: z.array(z.string().min(1)).optional(),
    sourceRoots: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

const mutationSchema = z
  .object({
    minScore: z.number().min(0).max(100).optional(),
    minKilled: z.number().int().min(0).optional(),
    timeoutAsKilled: z.boolean().optional(),
    attribution: z.enum(['full', 'first-kill']).optional(),
    command: z.string().min(1).optional(),
  })
  .passthrough();

// Phase 3 blocks. Each block is optional, so a config without it parses to exactly what it did before; inside a block,
// every field has its default (the same constants the consumers fall back to when the block is absent).
// Unknown keys inside a block are kept, like the other blocks, so a newer config still loads on an older SpecGuard.

const proofStoreSchema = z
  .object({
    notesRef: notesRefName.default(PROOF_STORE_DEFAULTS.notesRef),
    remote: gitRemoteName.default(PROOF_STORE_DEFAULTS.remote),
    maxWalk: z.number().int().min(1).max(100_000).default(PROOF_STORE_DEFAULTS.maxWalk),
    verify: z.enum(PROOF_STORE_VERIFY).default(PROOF_STORE_DEFAULTS.verify),
    autoFetch: z.enum(PROOF_STORE_AUTOFETCH).default(PROOF_STORE_DEFAULTS.autoFetch),
    pruneDays: z.number().int().min(1).default(PROOF_STORE_DEFAULTS.pruneDays),
  })
  .passthrough();

const changeSchema = z
  .object({
    baseRef: gitRefName.optional(),
    redAcceptsErrors: z.enum(RED_ACCEPTS_ERRORS).default(CHANGE_DEFAULTS.redAcceptsErrors),
    requireChangeRecord: z.boolean().default(CHANGE_DEFAULTS.requireChangeRecord),
    worktreeLinks: z.array(insidePath).optional(),
  })
  .passthrough();

const enforceSchema = z
  .object({
    default: z.enum(ENFORCE_LEVELS).default(ENFORCE_DEFAULTS.default),
    newCapabilities: z.enum(ENFORCE_LEVELS).optional(),
  })
  .passthrough();

const hooksSchema = z
  .object({
    onError: z.enum(HOOK_ON_ERROR).default(HOOKS_DEFAULTS.onError),
    bashGuard: z.boolean().default(HOOKS_DEFAULTS.bashGuard),
  })
  .passthrough();

const approvalsSchema = z
  .object({
    ci: z
      .object({
        requireReview: z.enum(APPROVAL_REQUIRE_REVIEW).default(APPROVALS_CI_DEFAULTS.requireReview),
        allowSelf: z.boolean().default(APPROVALS_CI_DEFAULTS.allowSelf),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const unrequestedSchema = z.object({ severity: z.enum(UNREQUESTED_SEVERITY).default(UNREQUESTED_DEFAULTS.severity) }).passthrough();

const ciSchema = z.object({ capabilityCoverage: z.boolean().default(CI_DEFAULTS.capabilityCoverage) }).passthrough();

const configSchema = z
  .object({
    granularity: granularitySchema.optional(),
    history: z.object({ failOnIntentGap: z.boolean().optional() }).passthrough().optional(),
    contractMappings: z
      .object({
        file: z.string().optional(),
        list: z.string().optional(),
        spec: z.string().optional(),
        providers: z.array(z.string()).optional(),
        docs: z.string().optional(),
        edgeType: z.string().optional(),
      })
      .optional(),
    server: z
      .object({
        url: z.string().optional(),
        project: z.string().optional(),
        tokenEnv: z.string().optional(),
        mode: z.enum(['auto', 'off', 'required']).optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    plugins: z.array(z.union([z.string(), z.object({ name: z.string(), package: z.string() })])).optional(),
    disabledPlugins: z.array(z.string()).optional(),
    proof: z
      .object({
        requiredLayers: z.array(z.enum(TEST_LAYERS)).optional(),
        enforceLayers: z.enum(['off', 'warn', 'fail']).optional(),
        requireApproval: z.boolean().optional(),
        requireTestable: z.boolean().optional(),
        requireStrength: z.boolean().optional(),
        requireSensitivity: z.boolean().optional(),
        requireConforms: z.boolean().optional(),
        requireAlignment: z.boolean().optional(),
        requireCi: z.boolean().optional(),
        strict: z.boolean().optional(),
        minDiffCoverage: z.number().min(0).max(100).optional(),
      })
      .passthrough()
      .optional(),
    testStrength: testStrengthSchema.optional(),
    testability: testabilitySchema.optional(),
    coverage: coverageSchema.optional(),
    mutation: mutationSchema.optional(),
    proofStore: proofStoreSchema.optional(),
    change: changeSchema.optional(),
    enforce: enforceSchema.optional(),
    hooks: hooksSchema.optional(),
    approvals: approvalsSchema.optional(),
    unrequested: unrequestedSchema.optional(),
    ci: ciSchema.optional(),
    featureState: featureStateSchema.optional(),
    auth: z.object({ profiles: z.array(authProfileSchema) }).passthrough().optional(),
    validate: validateSchema.optional(),
    extends: z.string().optional(),
    paths: pathsSchema.optional(),
    apps: z.array(appConfigSchema).min(1),
    runners: runnersSchema.optional(),
    llm: llmSchema,
    triggers: triggersSchema.optional(),
    heal: healSchema.optional(),
    matrix: matrixSchema.optional(),
    remediate: remediateSchema.optional(),
  })
  .passthrough();

/** Relative path from a repo root to the config file. */
const CONFIG_REL = path.join('.specguard', 'config.json');

/** Format a ZodError into a readable single-line message. */
function formatZodError(err: z.ZodError): string {
  return err.errors
    .map((e) => {
      const where = e.path.length > 0 ? e.path.join('.') : '(root)';
      return `${where}: ${e.message}`;
    })
    .join('; ');
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge a child over a parent: objects merge one level deep, everything else (arrays, apps, scalars) is replaced. */
function mergeConfigs(parent: Json, child: Json): Json {
  const out: Json = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    if (key === 'extends') continue;
    const base = out[key];
    out[key] = isPlainObject(value) && isPlainObject(base) ? { ...base, ...value } : value;
  }
  return out;
}

async function resolveExtends(configPath: string, raw: Json, seen: Set<string>): Promise<Json> {
  const target = raw.extends;
  if (target === undefined) return raw;
  if (typeof target !== 'string' || target.length === 0) {
    throw new ConfigInvalidError('extends must be a path to a config file or a directory containing .specguard/config.json');
  }
  let parentPath = path.resolve(path.dirname(path.dirname(configPath)), target);
  if (!parentPath.endsWith('.json')) parentPath = path.join(parentPath, CONFIG_REL);
  if (seen.has(parentPath)) throw new ConfigInvalidError(`extends cycle through ${parentPath}`);
  seen.add(parentPath);
  if (!(await fileExists(parentPath))) throw new ConfigInvalidError(`extends target not found: ${parentPath}`);
  let parentRaw: unknown;
  try {
    parentRaw = JSON.parse(await readFile(parentPath));
  } catch (err) {
    throw new ConfigInvalidError(`extended config ${parentPath} is not valid JSON (${(err as Error).message})`, err);
  }
  if (!isPlainObject(parentRaw)) throw new ConfigInvalidError(`extended config ${parentPath} is not an object`);
  const resolvedParent = await resolveExtends(parentPath, parentRaw, seen);
  return mergeConfigs(resolvedParent, raw);
}

/**
 * Load and validate `.specguard/config.json` for `cwd`. The repository's own config is found by walking up from `cwd`
 * to the repository boundary; failing that, `SPECGUARD_CONFIG` and then the overlay entries (see `./overlay.ts`) say where
 * the specs for this directory live. In overlay mode the config is loaded exactly as if the command ran from the
 * overlay app's directory (`rootDir` is the directory holding that `.specguard/`) and `resolvedVia` records how.
 *
 * @throws {ConfigNotFoundError} when no config is found.
 * @throws {ConfigAmbiguousError} when two overlay configs name the same repository.
 * @throws {ConfigInvalidError} when the file is not valid JSON, fails schema validation, or `extends` is broken.
 */
export async function loadConfig(cwd: string = process.cwd(), opts: { env?: NodeJS.ProcessEnv } = {}): Promise<SpecGuardConfig> {
  const detail = resolveConfigDirDetailed(cwd, opts.env ?? process.env);
  if (detail.resolved === null) {
    throw new ConfigNotFoundError(path.resolve(cwd), overlayMissHint(detail));
  }
  const rootDir = detail.resolved.dir;

  const configPath = path.join(rootDir, CONFIG_REL);
  const raw = await readFile(configPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigInvalidError(
      `config.json is not valid JSON (${(err as Error).message})`,
      err,
    );
  }
  if (isPlainObject(parsed)) {
    const resolved = await resolveExtends(configPath, parsed, new Set([configPath]));
    parsed = resolved;
    // The editor passes non-secret workspace defaults to its child processes only.
    // Validate through the same schema, preserving budgets, tiers and project paths.
    const override = (opts.env ?? process.env).SPECGUARD_IDE_LLM;
    if (override) {
      let llm: unknown;
      try { llm = JSON.parse(override); } catch { throw new ConfigInvalidError('SPECGUARD_IDE_LLM must be valid JSON.'); }
      if (!isPlainObject(llm)) throw new ConfigInvalidError('SPECGUARD_IDE_LLM must be an object.');
      const allowed = ['provider', 'model', 'apiKeyEnv', 'baseUrl'];
      const fields = Object.fromEntries(Object.entries(llm).filter(([key]) => allowed.includes(key)));
      resolved.llm = { ...(isPlainObject(resolved.llm) ? resolved.llm : {}), ...fields };
      // An empty endpoint explicitly returns to the provider's default.
      if (!('baseUrl' in fields)) delete (resolved.llm as Record<string, unknown>).baseUrl;
    }
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigInvalidError(formatZodError(result.error), result.error);
  }

  // `_comment` and other unknown keys survive via passthrough; cast through the
  // canonical type and stamp the resolved root directory.
  const config = result.data as unknown as SpecGuardConfig;
  config.rootDir = rootDir;
  if (detail.resolved.via !== 'repo') config.resolvedVia = detail.resolved;
  // A plugin the repo disabled stays off even when an extended config enables it.
  if (config.disabledPlugins?.length && config.plugins) {
    const off = new Set(config.disabledPlugins);
    config.plugins = config.plugins.filter((e) => !off.has(typeof e === 'string' ? e : e.name));
  }
  applyOutputLocations(config);
  // The LLM layer is configured once per process from the config it was given.
  configureLlm({ rootDir, llm: config.llm });
  return config;
}
