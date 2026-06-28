/**
 * Shared CLI helpers — config loading and error translation.
 *
 * Keeps the per-command handlers thin: the CLI is pure wiring, business logic
 * lives in the pipelines.
 */
import type { SpecGuardConfig } from '../../core/types.js';
import { loadConfig } from '../../core/config.js';
import { ConfigNotFoundError } from '../../core/errors.js';
import { ExitCode } from '../../core/exit-codes.js';

/** Options shared by every subcommand (sourced from the global `--config`). */
export interface GlobalOpts {
  /** Explicit path to a `.specguard/config.json` (or its containing dir). */
  config?: string;
}

/**
 * Load config for a command, honoring the global `--config <path>` option.
 *
 * On `ConfigNotFoundError` prints the actionable message to stderr and exits
 * with {@link ExitCode.InternalError}. Other config errors propagate to the
 * top-level handler.
 */
export async function loadCliConfig(opts: GlobalOpts): Promise<SpecGuardConfig> {
  try {
    // If `--config` points at a file, search from its directory; loadConfig
    // walks up from the given cwd looking for `.specguard/config.json`.
    const cwd = resolveSearchDir(opts.config);
    return await loadConfig(cwd);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      process.stderr.write('No config found. Run `specguard init` to create one.\n');
      process.exit(ExitCode.InternalError);
    }
    throw err;
  }
}

/**
 * Translate a `--config` value into a directory to search from.
 * Accepts either the containing directory, or a path ending in
 * `.specguard/config.json` / `config.json`, in which case we hand back the
 * directory two levels up so `loadConfig` finds it.
 */
function resolveSearchDir(configPath?: string): string {
  if (!configPath) return process.cwd();
  // Normalize separators; strip a trailing config file reference if present.
  const norm = configPath.replace(/\\/g, '/');
  const idx = norm.indexOf('/.specguard/');
  if (idx >= 0) return norm.slice(0, idx) || '/';
  if (norm.endsWith('/.specguard')) return norm.slice(0, -'/.specguard'.length) || '/';
  // Otherwise treat it as a directory to start the search from.
  return configPath;
}
