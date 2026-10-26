/**
 * `specguard migrate [--yes] [--consolidate] [--allow-dirty] [--json]`: bring a repository from an older layout to the
 * current one. Dry run unless `--yes`; thin wiring over src/pipelines/migrate.ts.
 *
 * Spec: specs/capabilities/platform-foundation.md
 * Contract: the registration function's signature is frozen.
 */
import type { Command } from 'commander';

import { runMigrate } from '../../pipelines/migrate.js';
import type { GlobalOpts } from './helpers.js';

/** The directory `--config` points at (or into), else the current one: the same reading every command gives it. */
function startDir(config?: string): string {
  if (!config) return process.cwd();
  const norm = config.replace(/\\/g, '/');
  const idx = norm.indexOf('/.specguard/');
  if (idx >= 0) return norm.slice(0, idx) || '/';
  if (norm.endsWith('/.specguard')) return norm.slice(0, -'/.specguard'.length) || '/';
  return config;
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('bring this repository to the current layout: a dry run that lists every step, or with --yes the steps the tool may do itself (never approving, committing or pushing)')
    .option('--yes', 'apply the steps migrate may do itself; without it nothing is changed')
    .option('--consolidate', 'for per-file specs worth keeping: print `spec consolidate` instead of archive, draft and tag')
    .option('--allow-dirty', 'apply even though the working tree has uncommitted changes')
    .option('--json', 'machine-readable output: the steps')
    .action(async (opts: { yes?: boolean; consolidate?: boolean; allowDirty?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOpts;
      const result = await runMigrate({ cwd: startDir(globals.config), yes: opts.yes, consolidate: opts.consolidate, allowDirty: opts.allowDirty });
      if (globals.json) process.stdout.write(`${JSON.stringify(result.failed > 0 ? { error: result.messages.join(' ') } : result.steps)}\n`);
      else process.stdout.write(`${result.messages.join('\n')}\n`);
      process.exit(result.exitCode);
    });
}
