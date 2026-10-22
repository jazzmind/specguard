/**
 * The plugin list as the extension models it: parsed from `specguard plugin list --json`, with
 * no VS Code dependency so it is unit-testable.
 */

export interface PluginRow {
  id: string;
  source: 'builtin' | 'npm';
  package?: string;
  title: string;
  description: string;
  provides: string[];
  commands: string[];
  enabled: boolean;
  inherited: boolean;
  disabledHere: boolean;
  error?: string;
  defaultOn?: boolean;
  configKey?: string;
}

/** Pipelines the extension offers that exist only while a plugin is on, and which plugin that is. */
export const PLUGIN_PIPELINES: Record<string, string> = { quality: 'quality', commit: 'git' };

/** Parse the CLI's `plugin list --json` output, which may be preceded by other log lines. Undefined when it is not a plugin list. */
export function parsePluginList(lines: string[]): PluginRow[] | undefined {
  const text = lines.join('\n');
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start)) as { plugins?: PluginRow[] };
    return Array.isArray(parsed.plugins) ? parsed.plugins : undefined;
  } catch {
    return undefined;
  }
}

/** Commands added by enabled plugins, as `[command, plugin id]`. */
export function enabledPluginCommands(rows: PluginRow[]): { command: string; plugin: string }[] {
  return rows.filter((r) => r.enabled && !r.error).flatMap((r) => r.commands.map((command) => ({ command, plugin: r.id })));
}

/** Whether the pipeline `id` can run: always for core pipelines, and for a plugin's pipeline only while that plugin is on. */
export function pipelineAvailable(rows: PluginRow[] | undefined, id: string): { ok: true } | { ok: false; plugin: string } {
  const plugin = PLUGIN_PIPELINES[id];
  if (!plugin || rows === undefined) return { ok: true }; // unknown state: let the CLI answer
  return rows.some((r) => r.id === plugin && r.enabled && !r.error) ? { ok: true } : { ok: false, plugin };
}

/** One line for a row's description in the tree. */
export function describeRow(r: PluginRow): string {
  const bits: string[] = [];
  if (r.error) bits.push('error');
  else bits.push(r.enabled ? 'on' : 'off');
  if (r.source === 'npm') bits.push(`npm: ${r.package ?? ''}`.trim());
  if (r.inherited) bits.push('inherited');
  if (r.disabledHere) bits.push('turned off here');
  return bits.join(' · ');
}

/** The tree item's `contextValue`, which the menus key on. */
export function rowContext(r: PluginRow): string {
  return `plugin-${r.source}-${r.enabled ? 'on' : 'off'}`;
}

/** A plugin id suggested from an npm package name: `@acme/specguard-plugin-checks` becomes `checks`. */
export function suggestPluginId(pkg: string): string {
  const base = pkg.replace(/^@[^/]+\//, '').replace(/^specguard-plugin-/, '').replace(/^specguard-/, '');
  const id = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(id) ? id : `p-${id}`;
}
