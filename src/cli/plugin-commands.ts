/**
 * Registers the commands of the plugins a config enables.
 *
 * Plugins are named in `config.plugins`, so the config is read before commander
 * parses, and a plugin that cannot be loaded is reported once and skipped
 * rather than blocking commands (`init` must work with a broken config). Core
 * commands win a name clash.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import type { Command } from 'commander';

import { loadConfig } from '../core/config.js';
import { enabledPluginCommands } from '../plugins/commands.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './commands/helpers.js';

export async function registerPluginCommands(program: Command, cwd: string = process.cwd()): Promise<void> {
  const commands = await enabledPluginCommands(cwd, (m) => process.stderr.write(`${m}\n`));
  const taken = new Set(program.commands.map((c) => c.name()));
  for (const spec of commands) {
    if (taken.has(spec.name)) continue;
    taken.add(spec.name);
    const cmd = program.command(spec.name).description(spec.description);
    for (const o of spec.options ?? []) cmd.option(o.flags, o.description);
    if (spec.args) cmd.argument(spec.args.includes('...') ? '[args...]' : '[arg]', spec.args);
    cmd.action(async (...received: unknown[]) => {
      const command = received[received.length - 1] as Command;
      const first = received[0];
      const args = Array.isArray(first) ? (first as string[]) : typeof first === 'string' ? [first] : [];
      const globals = command.optsWithGlobals() as GlobalOpts & Record<string, unknown>;
      const config = spec.needsConfig === false ? await loadConfig(cwd).catch(() => null) : await loadCliConfig(globals);
      const result = await spec.run({ config, opts: command.opts(), args });
      if (spec.output === 'messages' && !globals.json) {
        for (const line of result.messages) process.stdout.write(`${line}\n`);
        process.exit(result.exitCode);
      }
      outputResult(result, globals);
    });
  }
}
