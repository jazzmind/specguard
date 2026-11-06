/**
 * Finds the commands of the plugins a config enables. Shared by the CLI and the
 * MCP server, which both register them.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { loadConfig } from '../core/config.js';
import type { PluginEntry } from '../core/types.js';
import { loadWorkspaceWithConfigs, workspaceHint } from '../core/workspace.js';
import { loadPlugins } from './index.js';
import type { PluginCommand } from './types.js';

/** The union of the plugins the repos of a workspace enable, in first-seen order (the rule `contracts` uses). */
export function workspacePlugins(repos: Array<{ specGuardConfig?: { plugins?: PluginEntry[] } | null }>): PluginEntry[] {
  return [...new Map(repos.flatMap((r) => r.specGuardConfig?.plugins ?? []).map((p) => [JSON.stringify(p), p] as const)).values()];
}

/**
 * The commands of the enabled plugins, from the config found at or above `cwd`. With no config there but a
 * workspace manifest (at or above `cwd`, or named by `workspace` or `SPECGUARD_WORKSPACE`), the plugins the
 * workspace's repos enable. Empty when there is neither.
 */
export async function enabledPluginCommands(
  cwd: string,
  warn: (msg: string) => void = () => undefined,
  workspace?: string,
): Promise<PluginCommand[]> {
  let plugins: PluginEntry[] | undefined;
  let rootDir: string;
  try {
    const config = await loadConfig(cwd);
    plugins = config.plugins;
    rootDir = config.rootDir ?? cwd;
  } catch {
    try {
      const { manifest, repos } = await loadWorkspaceWithConfigs(cwd, workspaceHint(workspace));
      plugins = workspacePlugins(repos);
      rootDir = manifest.rootDir;
    } catch {
      return [];
    }
  }
  try {
    return (await loadPlugins(plugins, rootDir)).flatMap((p) => p.commands ?? []);
  } catch (err) {
    warn(`[warn] plugins not loaded: ${(err as Error).message}`);
    return [];
  }
}
