/**
 * The repo's plugin state, read through the CLI (`plugin list --json`) and changed through it
 * (`plugin enable|disable|add|remove`). The CLI owns the rules, so the extension never edits config.
 */
import * as vscode from 'vscode';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';
import { parsePluginList, type PluginRow } from './plugins-model.js';

const TTL_MS = 30_000;

interface Cached {
  at: number;
  rows: PluginRow[] | undefined;
  error?: string;
}

const cache = new Map<string, Cached>();
const changed = new vscode.EventEmitter<string>();
/** Fires with the root whose plugins changed. */
export const onDidChangePlugins = changed.event;

async function runCli(root: string, args: string[]): Promise<{ code: number; lines: string[] }> {
  const cli = await resolveCliPath(root);
  const lines: string[] = [];
  const handle = spawnCli(cli, args, root, (l) => lines.push(l));
  try {
    return { code: await handle.promise, lines };
  } catch (err) {
    lines.push((err as Error).message);
    return { code: 1, lines };
  }
}

/** The plugin rows for `root`, from a short cache. Undefined when the CLI cannot list them (no config, old CLI). */
export async function getPlugins(root: string, opts: { fresh?: boolean } = {}): Promise<{ rows: PluginRow[] | undefined; error?: string }> {
  const hit = cache.get(root);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return { rows: hit.rows, error: hit.error };
  const res = await runCli(root, ['plugin', 'list', '--json']);
  const rows = res.code === 0 ? parsePluginList(res.lines) : undefined;
  const entry: Cached = { at: Date.now(), rows, ...(rows ? {} : { error: res.lines.slice(-1)[0] ?? 'plugin list failed' }) };
  cache.set(root, entry);
  return { rows, error: entry.error };
}

export async function isPluginEnabled(root: string, id: string): Promise<boolean | undefined> {
  const { rows } = await getPlugins(root);
  return rows === undefined ? undefined : rows.some((r) => r.id === id && r.enabled && !r.error);
}

/** Run a `plugin` subcommand, then drop the cache and tell listeners. Resolves to the CLI's last line on success. */
export async function changePlugins(root: string, args: string[]): Promise<{ ok: boolean; message: string }> {
  const res = await runCli(root, ['plugin', ...args]);
  cache.delete(root);
  const message = res.lines.filter((l) => l.trim() !== '').slice(-1)[0] ?? '';
  if (res.code === 0) changed.fire(root);
  return { ok: res.code === 0, message };
}
