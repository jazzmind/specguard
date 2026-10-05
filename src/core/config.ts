/**
 * Config loader for SpecGuard.
 *
 * Locates the nearest `.specguard/config.json` by walking up from a starting
 * directory, parses it, validates it against a Zod schema mirroring
 * `SpecGuardConfig`, and stamps `rootDir` onto the result. This is the only
 * module that reads the config file — pipelines receive a typed config.
 */
import path from 'node:path';
import { z } from 'zod';
import type { SpecGuardConfig } from './types.js';
import { ConfigNotFoundError, ConfigInvalidError } from './errors.js';
import { readFile, fileExists } from './reader.js';
import { configureLlm } from './llm-runtime.js';

// ---------------------------------------------------------------------------
// Zod schema — mirrors the types in ./types.ts, permissive on unknown keys so
// the real config (and forward-compatible additions) validate cleanly.
// ---------------------------------------------------------------------------

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

const llmSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    apiKeyEnv: z.string(),
    pipelines: z
      .record(
        z.string(),
        z
          .object({
            provider: z.string().optional(),
            model: z.string().optional(),
            apiKeyEnv: z.string().optional(),
            fallback: z.array(llmTargetSchema).optional(),
          })
          .passthrough(),
      )
      .optional(),
    fallback: z.array(llmTargetSchema).optional(),
    timeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().min(0).max(10).optional(),
    backoffMs: z.number().int().min(0).optional(),
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

const pathsSchema = z
  .object({
    specsRoot: z.string().optional(),
    docsOut: z.string().optional(),
    securityTests: z.string().optional(),
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
  })
  .passthrough();

const configSchema = z
  .object({
    plugins: z.array(z.string()).optional(),
    featureState: featureStateSchema.optional(),
    extends: z.string().optional(),
    paths: pathsSchema.optional(),
    apps: z.array(appConfigSchema).min(1),
    runners: runnersSchema.optional(),
    llm: llmSchema,
    triggers: triggersSchema.optional(),
    heal: healSchema.optional(),
    matrix: matrixSchema.optional(),
  })
  .passthrough();

/** Relative path from a repo root to the config file. */
const CONFIG_REL = path.join('.specguard', 'config.json');

/**
 * Walk up from `start` (inclusive) looking for `.specguard/config.json`.
 * The search stops at the repository boundary: the first directory that
 * contains `.git`. A repo with no config of its own therefore never picks up a
 * parent repo's config; use `extends` to inherit one on purpose.
 * Returns the directory containing `.specguard/`, or null if none found.
 */
async function findConfigDir(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  // Walk until the filesystem root (parent === dir).
  while (true) {
    if (await fileExists(path.join(dir, CONFIG_REL))) {
      return dir;
    }
    if (await fileExists(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
 * Load and validate `.specguard/config.json`, searching from `cwd` upward to the
 * repository boundary.
 *
 * @throws {ConfigNotFoundError} when no config file is found before the repo boundary.
 * @throws {ConfigInvalidError} when the file is not valid JSON, fails schema validation, or `extends` is broken.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<SpecGuardConfig> {
  const rootDir = await findConfigDir(cwd);
  if (rootDir === null) {
    throw new ConfigNotFoundError(path.resolve(cwd));
  }

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
    parsed = await resolveExtends(configPath, parsed, new Set([configPath]));
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigInvalidError(formatZodError(result.error), result.error);
  }

  // `_comment` and other unknown keys survive via passthrough; cast through the
  // canonical type and stamp the resolved root directory.
  const config = result.data as unknown as SpecGuardConfig;
  config.rootDir = rootDir;
  // The LLM layer is configured once per process from the config it was given.
  configureLlm({ rootDir, llm: config.llm });
  return config;
}
