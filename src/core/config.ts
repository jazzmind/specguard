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
    specDir: z.string(),
    sources: appSourcesSchema,
    framework: z.string(),
    testOutput: z.string(),
    security: appSecuritySchema.optional(),
    docs: z.union([z.boolean(), z.string()]).optional(),
  })
  .passthrough();

const runnersSchema = z
  .object({
    playwright: z.string().optional(),
    semgrep: z.string().optional(),
    bandit: z.string().optional(),
    testRunner: z.string().optional(),
  })
  .passthrough();

const llmSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    apiKeyEnv: z.string(),
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

const configSchema = z
  .object({
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
 * Returns the directory containing `.specguard/`, or null if none found.
 */
async function findConfigDir(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  // Walk until the filesystem root (parent === dir).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fileExists(path.join(dir, CONFIG_REL))) {
      return dir;
    }
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

/**
 * Load and validate `.specguard/config.json`, searching from `cwd` upward.
 *
 * @throws {ConfigNotFoundError} when no config file is found in any ancestor.
 * @throws {ConfigInvalidError} when the file is not valid JSON or fails schema validation.
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

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigInvalidError(formatZodError(result.error), result.error);
  }

  // `_comment` and other unknown keys survive via passthrough; cast through the
  // canonical type and stamp the resolved root directory.
  const config = result.data as unknown as SpecGuardConfig;
  config.rootDir = rootDir;
  return config;
}
