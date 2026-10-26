/**
 * `specguard enforce show|raise|lower`: the per-capability ratchet.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: the registration function's signature is frozen; the commands are thin wiring over src/pipelines/enforce.ts.
 */
import type { Command } from 'commander';

import { runEnforceLower, runEnforceRaise, runEnforceShow } from '../../pipelines/enforce.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

const globalsOf = (cmd: Command): GlobalOpts => {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return { config: g.config, json: g.json };
};

export function registerEnforceCommands(program: Command): void {
  const enforce = program.command('enforce').description('the per-capability ratchet: observe, warn or enforce (enforce: in a spec\'s frontmatter)');

  enforce
    .command('show')
    .alias('status')
    .description("every capability's level, where it comes from, and whether it could be raised now")
    .argument('[capabilities...]', 'capability ids; all when omitted')
    .action(async (targets: string[], _opts: Record<string, never>, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runEnforceShow(await loadCliConfig(globals), { targets }), globals);
    });

  enforce
    .command('raise')
    .description('raise the level (default: the next one up); moving to enforce is allowed only while the capability is certified. A person runs this, never an agent')
    .argument('<capabilities...>', 'capability ids')
    .option('--to <level>', 'observe, warn or enforce')
    .option('--by <name>', 'who is deciding (default: git user.name)')
    .action(async (targets: string[], opts: { to?: string; by?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runEnforceRaise(await loadCliConfig(globals), { ...opts, targets }), globals);
    });

  enforce
    .command('lower')
    .description('lower the level; needs --why and is recorded in history, because it weakens policy. A person runs this, never an agent')
    .argument('<capabilities...>', 'capability ids')
    .option('--to <level>', 'observe, warn or enforce')
    .option('--why <text>', 'why the level is being lowered (required)')
    .option('--by <name>', 'who is deciding (default: git user.name)')
    .action(async (targets: string[], opts: { to?: string; why?: string; by?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runEnforceLower(await loadCliConfig(globals), { ...opts, targets }), globals);
    });
}
