/**
 * `specguard plugin list|enable|disable|add|remove`: manage the plugins a repo uses.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import {
  addNpmPlugin,
  disablePlugin,
  enablePlugin,
  formatPluginRows,
  listPlugins,
  removeNpmPlugin,
  type PluginChange,
} from '../../pipelines/plugin-manage.js';
import { SpecGuardError } from '../../core/errors.js';
import { ExitCode } from '../../core/exit-codes.js';

interface Out {
  json?: boolean;
  cwd?: string;
}

function fail(err: unknown): never {
  const message = err instanceof SpecGuardError || err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(ExitCode.InternalError);
}

function report(change: PluginChange, opts: Out): never {
  if (opts.json) process.stdout.write(`${JSON.stringify(change)}\n`);
  else process.stdout.write(`${change.note}\n`);
  process.exit(ExitCode.Success);
}

export async function pluginListCommand(opts: Out = {}): Promise<void> {
  try {
    const list = await listPlugins(opts.cwd ?? process.cwd());
    if (opts.json) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    else for (const line of formatPluginRows(list.plugins)) process.stdout.write(`${line}\n`);
    process.exit(ExitCode.Success);
  } catch (err) {
    fail(err);
  }
}

export async function pluginEnableCommand(id: string, opts: Out = {}): Promise<void> {
  try {
    report(await enablePlugin(opts.cwd ?? process.cwd(), id), opts);
  } catch (err) {
    fail(err);
  }
}

export async function pluginDisableCommand(id: string, opts: Out = {}): Promise<void> {
  try {
    report(await disablePlugin(opts.cwd ?? process.cwd(), id), opts);
  } catch (err) {
    fail(err);
  }
}

export async function pluginAddCommand(id: string, opts: Out & { package: string; install?: boolean; yes?: boolean }): Promise<void> {
  try {
    report(await addNpmPlugin(opts.cwd ?? process.cwd(), id, opts.package, { confirmed: opts.yes === true, install: opts.install }), opts);
  } catch (err) {
    fail(err);
  }
}

export async function pluginRemoveCommand(id: string, opts: Out = {}): Promise<void> {
  try {
    report(await removeNpmPlugin(opts.cwd ?? process.cwd(), id), opts);
  } catch (err) {
    fail(err);
  }
}
