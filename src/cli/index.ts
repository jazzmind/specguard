#!/usr/bin/env node
/**
 * SpecGuard CLI entrypoint.
 *
 * Pure wiring: parses arguments with commander, loads config, and dispatches
 * to a pipeline. No business logic lives here — each subcommand delegates to a
 * handler in `./commands/` which in turn calls a pipeline.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Auto-load .specguard/.env before any pipeline runs so secrets are available
// even when the user hasn't exported them in their shell.
(function loadSpecGuardEnv() {
  const envFile = join(process.cwd(), '.specguard', '.env');
  if (!existsSync(envFile)) return;
  try {
    for (const raw of readFileSync(envFile, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* best-effort */ }
})();

import { Command, CommanderError } from 'commander';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import type { GlobalOpts } from './commands/helpers.js';
import { reverseCommand } from './commands/reverse.js';
import { statusCommand } from './commands/status.js';
import { driftCommand } from './commands/drift.js';
import { generateCommand } from './commands/generate.js';
import { healCommand } from './commands/heal.js';
import { securityCommand } from './commands/security.js';
import { docsCommand } from './commands/docs.js';
import { initCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { matrixCommand } from './commands/matrix.js';
import { importCommand } from './commands/import.js';
import { qualityCommand } from './commands/quality.js';
import { depsCommand } from './commands/deps.js';
import { commitCommand } from './commands/commit.js';
import { analyzeCommand } from './commands/analyze.js';
import { planFixCommand } from './commands/plan-fix.js';
import { gapAnalysisCommand } from './commands/gap-analysis.js';

// Resolve version from package.json. Falls back gracefully when the CLI is
// bundled into the extension (installed at a path where ../../package.json
// doesn't exist).
let _cliVersion = '0.1.0';
try {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json') as { version: string };
  _cliVersion = pkg.version;
} catch { /* bundled deployment — version unavailable */ }

/** Merge a subcommand's own options with the global `--config` option. */
function withGlobals<T extends object>(cmd: Command, local: T): T & GlobalOpts {
  const globals = cmd.optsWithGlobals() as GlobalOpts;
  return { ...local, config: globals.config };
}

const program = new Command();

program
  .name('specguard')
  .description('SpecGuard — Living Specification QA agent')
  .version(_cliVersion, '-v, --version', 'print the SpecGuard version')
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
  .argument('<file>', 'document to import (file path or https:// URL)')
  .option('--app <name>', 'target app from config')
  .option('--out <path>', 'override output spec path')
  .option('--force', 'overwrite existing spec')
  .action(async (file: string, opts: { app?: string; out?: string; force?: boolean }, cmd: Command) => {
    await importCommand(file, withGlobals(cmd, opts));
  });

// --- reverse --------------------------------------------------------------
program
  .command('reverse')
  .description('generate specs from existing source')
  .option('--app <name>', 'target app from config (required unless --all is used)')
  .option('--all', 'process all apps defined in config')
  .option('--file <path>', 'process a single source file (only with --app)')
  .option('--force', 'overwrite existing specs')
  .action(async (opts: { app?: string; all?: boolean; file?: string; force?: boolean }, cmd: Command) => {
    await reverseCommand(withGlobals(cmd, opts));
  });

// --- generate -------------------------------------------------------------
program
  .command('generate')
  .description('generate tests from specs')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--framework <name>', 'override test framework')
  .option('--app <name>', 'limit to a single app')
  .option('--force', 'overwrite existing test files')
  .option('--type <type>', 'test type: unit | integration | e2e (default: unit)')
  .action(
    async (
      opts: { spec?: string; all?: boolean; framework?: string; app?: string; force?: boolean; type?: string },
      cmd: Command,
    ) => {
      await generateCommand(withGlobals(cmd, opts as Parameters<typeof generateCommand>[0]));
    },
  );

// --- heal -----------------------------------------------------------------
program
  .command('heal')
  .description('self-heal failing generated tests')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--max-retries <n>', 'maximum heal attempts')
  .action(
    async (opts: { spec?: string; all?: boolean; maxRetries?: string }, cmd: Command) => {
      await healCommand(withGlobals(cmd, opts));
    },
  );

// --- validate -------------------------------------------------------------
program
  .command('validate')
  .description('validate specs against the running app')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs with url: metadata')
  .option('--url <url>', 'base URL of the running app')
  .option('--app <name>', 'limit to a single app')
  .action(
    async (
      opts: { spec?: string; all?: boolean; url?: string; app?: string },
      cmd: Command,
    ) => {
      await validateCommand(withGlobals(cmd, opts));
    },
  );

// --- security -------------------------------------------------------------
program
  .command('security')
  .description('run security analysis for specs')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--with-sast', 'include static analysis (Semgrep/Bandit)')
  .option('--app <name>', 'limit to a single app')
  .option('--force', 'overwrite existing security tests')
  .action(
    async (
      opts: { spec?: string; all?: boolean; withSast?: boolean; app?: string; force?: boolean },
      cmd: Command,
    ) => {
      await securityCommand(withGlobals(cmd, opts));
    },
  );

// --- docs -----------------------------------------------------------------
program
  .command('docs')
  .description('generate documentation from specs')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--out <path>', 'output directory')
  .option('--app <name>', 'limit to a single app')
  .action(
    async (opts: { spec?: string; all?: boolean; out?: string; app?: string }, cmd: Command) => {
      await docsCommand(withGlobals(cmd, opts));
    },
  );

// --- drift ----------------------------------------------------------------
program
  .command('drift')
  .description('detect specs that have drifted from source (hash+LLM by default)')
  .option('--since <ref>', 'git ref to diff against (default HEAD~1)')
  .option('--spec <key>', 'target a single spec')
  .option('--force', 'bypass hash cache and re-evaluate all files with LLM')
  .option('--mtime', 'use legacy mtime-based check instead of hash+LLM')
  .action(async (opts: { since?: string; spec?: string; force?: boolean; mtime?: boolean }, cmd: Command) => {
    await driftCommand(withGlobals(cmd, opts));
  });

// --- matrix ---------------------------------------------------------------
program
  .command('matrix')
  .description('build the requirement-to-test traceability matrix')
  .option('--out <path>', 'output path')
  .option('--format <format>', 'json or csv (default: json)')
  .option('--app <name>', 'limit to a single app')
  .action(
    async (opts: { out?: string; format?: string; app?: string }, cmd: Command) => {
      await matrixCommand(withGlobals(cmd, opts));
    },
  );

// --- quality --------------------------------------------------------------
program
  .command('quality')
  .description('run ESLint + Knip code quality checks')
  .option('--app <name>', 'limit to a single app')
  .option('--fix', 'auto-fix ESLint fixable issues')
  .action(async (opts: { app?: string; fix?: boolean }, cmd: Command) => {
    await qualityCommand(withGlobals(cmd, opts));
  });

// --- deps -----------------------------------------------------------------
program
  .command('deps')
  .description('run npm-audit + depcheck dependency health checks')
  .option('--app <name>', 'limit to a single app')
  .action(async (opts: { app?: string }, cmd: Command) => {
    await depsCommand(withGlobals(cmd, opts));
  });

// --- commit ---------------------------------------------------------------
program
  .command('commit')
  .description('commit SpecGuard-generated files (tests, docs, specs, reports)')
  .option('--dry-run', 'preview what would be staged without committing')
  .option('--message <msg>', 'custom commit message suffix')
  .option('--app <name>', 'restrict to a single app')
  .option('--pipeline <name>', 'originating pipeline (used for conventional commit message and changelog)')
  .action(async (opts: { dryRun?: boolean; message?: string; app?: string; pipeline?: string }, cmd: Command) => {
    await commitCommand(withGlobals(cmd, opts));
  });

// --- analyze --------------------------------------------------------------
program
  .command('analyze')
  .description('run all diagnostic checks and return recommendations')
  .option('--auto-fix', 'automatically run recommended pipelines after analysis')
  .action(async (opts: { autoFix?: boolean }, cmd: Command) => {
    await analyzeCommand(withGlobals(cmd, opts));
  });

// --- plan-fix -------------------------------------------------------------
program
  .command('plan-fix')
  .description('generate a fix plan from pipeline findings')
  .requiredOption('--pipeline <name>', 'pipeline that produced the findings (e.g. validate, security)')
  .requiredOption('--issues <text>', 'summary of issues to fix')
  .action(async (opts: { pipeline: string; issues: string }, cmd: Command) => {
    await planFixCommand(withGlobals(cmd, opts));
  });

// --- gap-analysis ---------------------------------------------------------
program
  .command('gap-analysis')
  .description('detect unimplemented/partial specs and generate implementation plans')
  .option('--spec <key>', 'restrict to a single spec key (e.g. app/feature)')
  .option('--all', 'check all apps (default)')
  .option('--no-plan', 'skip LLM plan generation — only report gaps')
  .action(async (opts: { spec?: string; all?: boolean; plan?: boolean }, cmd: Command) => {
    await gapAnalysisCommand(withGlobals(cmd, { spec: opts.spec, all: opts.all, noPlan: opts.plan === false }));
  });

// --- status ---------------------------------------------------------------
program
  .command('status')
  .description('report spec coverage')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await statusCommand(withGlobals(cmd, {}));
  });

export async function main(): Promise<void> {
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

/** True when this module is the process entrypoint (not imported as a library). */
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(argv1);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
