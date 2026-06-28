#!/usr/bin/env node
/**
 * SpecGuard CLI entrypoint.
 *
 * Pure wiring: parses arguments with commander, loads config, and dispatches
 * to a pipeline. No business logic lives here — each subcommand delegates to a
 * handler in `./commands/` which in turn calls a pipeline.
 */
import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import type { GlobalOpts } from './commands/helpers.js';
import { reverseCommand } from './commands/reverse.js';
import { statusCommand } from './commands/status.js';
import { initCommand } from './commands/init.js';
import { makeStub } from './commands/stubs.js';

// Resolve version from package.json relative to this module. The bin maps to
// dist/cli/index.js, so package.json sits two directories up in both src and
// dist layouts.
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

/** Merge a subcommand's own options with the global `--config` option. */
function withGlobals<T extends object>(cmd: Command, local: T): T & GlobalOpts {
  const globals = cmd.optsWithGlobals() as GlobalOpts;
  return { ...local, config: globals.config };
}

const program = new Command();

program
  .name('specguard')
  .description('SpecGuard — Living Specification QA agent')
  .version(pkg.version, '-v, --version', 'print the SpecGuard version')
  .option('--config <path>', 'path to .specguard/config.json')
  .showHelpAfterError('(add --help for usage)')
  // Throw instead of calling process.exit directly so we control exit codes.
  .exitOverride();

// --- init -----------------------------------------------------------------
program
  .command('init')
  .description('scaffold .specguard/config.json and specs/README.md')
  .option('--with-playwright', 'configure Playwright as the test framework')
  .action(async (opts: { withPlaywright?: boolean }) => {
    await initCommand({ withPlaywright: opts.withPlaywright });
  });

// --- import <file> --------------------------------------------------------
program
  .command('import')
  .description('import an external document into a spec')
  .argument('<file>', 'document to import')
  .option('--app <name>', 'target app from config')
  .option('--format <format>', 'source format')
  .action(makeStub('import'));

// --- reverse --------------------------------------------------------------
program
  .command('reverse')
  .description('generate specs from existing source')
  .requiredOption('--app <name>', 'target app from config')
  .option('--file <path>', 'process a single source file')
  .option('--force', 'overwrite existing specs')
  .action(async (opts: { app: string; file?: string; force?: boolean }, cmd: Command) => {
    await reverseCommand(withGlobals(cmd, opts));
  });

// --- generate -------------------------------------------------------------
program
  .command('generate')
  .description('generate tests from specs')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--framework <name>', 'override test framework')
  .action(makeStub('generate'));

// --- heal -----------------------------------------------------------------
program
  .command('heal')
  .description('self-heal failing generated tests')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--max-retries <n>', 'maximum heal attempts')
  .action(makeStub('heal'));

// --- validate -------------------------------------------------------------
program
  .command('validate')
  .description('validate specs against the running app')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--url <url>', 'base URL of the running app')
  .option('--auth <profile>', 'auth profile from config')
  .option('--out <path>', 'write report to path')
  .action(makeStub('validate'));

// --- security -------------------------------------------------------------
program
  .command('security')
  .description('run security analysis for specs')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--with-sast', 'include static analysis (Semgrep/Bandit)')
  .action(makeStub('security'));

// --- docs -----------------------------------------------------------------
program
  .command('docs')
  .description('generate documentation from specs')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--out <path>', 'output directory')
  .action(makeStub('docs'));

// --- drift ----------------------------------------------------------------
program
  .command('drift')
  .description('detect specs that have drifted from source')
  .option('--since <ref>', 'git ref to diff against')
  .option('--spec <key>', 'target a single spec')
  .action(makeStub('drift'));

// --- matrix ---------------------------------------------------------------
program
  .command('matrix')
  .description('build the requirement-to-test traceability matrix')
  .option('--out <path>', 'output path')
  .option('--format <format>', 'json or markdown')
  .action(makeStub('matrix'));

// --- status ---------------------------------------------------------------
program
  .command('status')
  .description('report spec coverage')
  .action(async () => {
    await statusCommand();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // commander throws CommanderError for --help/--version (exitCode 0) and for
    // usage errors (exitCode 1). Honor its code.
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    if (err instanceof SpecGuardError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`${(err as Error).message ?? String(err)}\n`);
    process.exit(ExitCode.InternalError);
  }
}

void main();
