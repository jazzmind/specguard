/**
 * Finds the commands of the plugins a config enables. Shared by the CLI and the
 * MCP server, which both register them.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { loadConfig } from '../core/config.js';
import type { SpecGuardConfig } from '../core/types.js';
import { loadPlugins } from './index.js';
import type { PluginCommand } from './types.js';

/** The commands of the enabled plugins, from the config found at or above `cwd`. Empty when there is none. */
export async function enabledPluginCommands(cwd: string, warn: (msg: string) => void = () => undefined): Promise<PluginCommand[]> {
  let config: SpecGuardConfig;
  try {
    config = await loadConfig(cwd);
  } catch {
    return [];
  }
  try {
    return (await loadPlugins(config.plugins, config.rootDir)).flatMap((p) => p.commands ?? []);
  } catch (err) {
    warn(`[warn] plugins not loaded: ${(err as Error).message}`);
    return [];
  }
}
