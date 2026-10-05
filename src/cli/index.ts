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
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, parse } from 'node:path';

// Auto-load .specguard/.env before any pipeline runs so secrets are available
// even when the user hasn't exported them in their shell.
// Loading order (later wins, because we only set vars not already in process.env):
//   1. workspace-level  …/.specguard/.env  (lowest precedence)
//   2. per-repo         {cwd}/.specguard/.env  (highest precedence — loaded last)
(function loadSpecGuardEnv() {
  function parseDotEnv(filePath: string): void {
    try {
      for (const raw of readFileSync(filePath, 'utf-8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) process.env[key] = val;
      }
    } catch { /* best-effort */ }
  }

  // 1. Walk up from cwd looking for a workspace-level .specguard/workspace.json,
  //    then load its sibling .env (gives shared keys to all repos in the workspace).
  try {
    let dir = resolve(process.cwd());
    const fsRoot = parse(dir).root;
    while (true) {
      if (existsSync(join(dir, '.specguard', 'workspace.json'))) {
        const wsEnv = join(dir, '.specguard', '.env');
        if (existsSync(wsEnv)) parseDotEnv(wsEnv);
        break;
      }
      const parent = join(dir, '..');
      if (parent === dir || dir === fsRoot) break;
      dir = parent;
    }
  } catch { /* best-effort */ }

  // 2. Per-repo .env — overrides workspace values for this specific repo.
  const repoEnv = join(process.cwd(), '.specguard', '.env');
  if (existsSync(repoEnv)) parseDotEnv(repoEnv);
})();

import { Command, CommanderError } from 'commander';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import type { GlobalOpts } from './commands/helpers.js';
import { reverseCommand } from './commands/reverse.js';
import { statusCommand } from './commands/status.js';
import { featuresCommand } from './commands/features.js';
import { featureStateCommand } from './commands/feature-state.js';
import { driftCommand } from './commands/drift.js';
import { generateCommand } from './commands/generate.js';
import { healCommand } from './commands/heal.js';
import { securityCommand } from './commands/security.js';
import { docsCommand } from './commands/docs.js';
import { initCommand, scaffoldCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { matrixCommand } from './commands/matrix.js';
import { importCommand } from './commands/import.js';
import { qualityCommand } from './commands/quality.js';
import { depsCommand } from './commands/deps.js';
import { commitCommand } from './commands/commit.js';
import { analyzeCommand } from './commands/analyze.js';
import { planFixCommand } from './commands/plan-fix.js';
import { gapAnalysisCommand } from './commands/gap-analysis.js';
import { alignCommand } from './commands/align.js';
import { contractsCommand } from './commands/contracts.js';
import { impactCommand } from './commands/impact.js';
import { workspaceInitCommand, workspaceStatusCommand } from './commands/workspace.js';
import { runWorkspaceDrift } from '../pipelines/workspace-drift.js';
import { loadWorkspaceWithConfigs } from '../core/workspace.js';
import { indexCommand } from './commands/index.js';
import { claimsAssignCommand, claimsListCommand } from './commands/claims.js';
import { proofIngestCommand, proofStatusCommand } from './commands/proof.js';

// Resolve version from package.json. Falls back gracefully when the CLI is
// bundled into the extension (installed at a path where ../../package.json
// doesn't exist).
let _cliVersion = '0.1.0';
try {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json') as { version: string };
  _cliVersion = pkg.version;
} catch { /* bundled deployment — version unavailable */ }

/** Merge a subcommand's own options with the global options (`--config`, `--json`). */
function withGlobals<T extends object>(cmd: Command, local: T): T & GlobalOpts {
  const globals = cmd.optsWithGlobals() as GlobalOpts;
  return { ...local, config: globals.config, json: globals.json };
}

const program = new Command();

program
  .name('specguard')
  .description('SpecGuard — Living Specification QA agent')
  .version(_cliVersion, '-v, --version', 'print the SpecGuard version')
  .option('--config <path>', 'path to .specguard/config.json')
  .option('--json', 'emit machine-readable JSON result to stdout (suppresses human-readable output)')
  .showHelpAfterError('(add --help for usage)')
  // Throw instead of calling process.exit directly so we control exit codes.
  .exitOverride();

// --- init -----------------------------------------------------------------
program
  .command('init')
  .description('scaffold .specguard/config.json, specs, and agent-harness files')
  .option('--with-playwright', 'configure Playwright as the test framework')
  .option('--language <id>', 'target language (typescript|python|go|rust|java); auto-detected when omitted')
  .option('--harness <which>', 'agent harness files to generate (claude|cursor|both)', 'both')
  .action(async (opts: { withPlaywright?: boolean; language?: string; harness?: string }) => {
    await initCommand({
      withPlaywright: opts.withPlaywright,
      language: opts.language,
      harness: opts.harness,
    });
  });

// --- scaffold --------------------------------------------------------------
program
  .command('scaffold')
  .description('regenerate agent-harness files (CLAUDE.md, skills, MCP wiring, /goal) for an existing project')
  .option('--harness <which>', 'agent harness files to generate (claude|cursor|both)', 'both')
  .action(async (opts: { harness?: string }) => {
    await scaffoldCommand({ harness: opts.harness });
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
  .option(
    '--collapse <globs>',
    'comma-separated glob patterns to collapse into per-directory specs ' +
    '(merged with collapse patterns already in config.json). ' +
    'Example: --collapse "src/resolvers/!(mutations|queries)/**/*.ts,src/lib/**/*.ts"',
  )
  .action(async (opts: { app?: string; all?: boolean; file?: string; force?: boolean; collapse?: string }, cmd: Command) => {
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
  .option('--no-review', 'skip the multimodal REVIEW step (criterion verdicts only)')
  .action(
    async (
      opts: { spec?: string; all?: boolean; url?: string; app?: string; noReview?: boolean },
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

// --- align ----------------------------------------------------------------
program
  .command('align')
  .description('semantically compare spec scenarios to test assertions via LLM')
  .option('--app <name>', 'limit to a single app')
  .option('--spec <key>', 'target a single spec key (e.g. auth/login)')
  .option('--all', 'process all apps')
  .option('--concurrency <n>', 'how many specs to align at once', '4')
  .option('--fresh', 'ignore a saved alignment checkpoint and start over')
  .option('--extra-tests <globs...>', 'additional test file glob patterns (resolved from workspace root)')
  .action(
    async (
      opts: { app?: string; spec?: string; all?: boolean; concurrency?: string; fresh?: boolean; extraTests?: string[] },
      cmd: Command,
    ) => {
      const concurrency = Number(opts.concurrency);
      await alignCommand(withGlobals(cmd, {
        ...opts,
        concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      }));
    },
  );

// --- index ----------------------------------------------------------------
program
  .command('index')
  .description('generate or update specs/index.md with system architecture overview and route map')
  .option('--app <name>', 'target app in config (defaults to first app)')
  .option('--force', 'regenerate even if index.md already exists')
  .action(async (opts: { app?: string; force?: boolean }, cmd: Command) => {
    await indexCommand(withGlobals(cmd, opts));
  });

// --- status ---------------------------------------------------------------
program
  .command('status')
  .description('report spec coverage')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await statusCommand(withGlobals(cmd, {}));
  });

// --- features -------------------------------------------------------------
program
  .command('features')
  .description('list spec back-references, or with --state the channel report and agent gate')
  .option('--state', 'print summary, UI/API/MCP state, and the agent gate')
  .option('--cases <file>', 'extra TestCaseResult rows (JSON array) used with --state')
  .action(async (opts: { state?: boolean; cases?: string }, cmd: Command) => {
    if (opts.state) await featureStateCommand(withGlobals(cmd, opts));
    else await featuresCommand(withGlobals(cmd, {}));
  });

// --- claims ---------------------------------------------------------------
const claimsCmd = program
  .command('claims')
  .description('stable claim ids on acceptance criteria, and the cross-repo catalog');

claimsCmd
  .command('assign')
  .description('add claim ids to acceptance-criteria bullets that do not have one')
  .option('--dir <dir>', 'spec directory to assign (default: the repo specs/ tree)')
  .option('--dry-run', 'print the ids that would be added without writing')
  .action(async (opts: { dir?: string; dryRun?: boolean }, cmd: Command) => {
    await claimsAssignCommand(withGlobals(cmd, opts));
  });

claimsCmd
  .command('list')
  .description('list claim refs and fail on dangling journey references')
  .option('--workspace', 'catalog every repo in .specguard/workspace.json')
  .action(async (opts: { workspace?: boolean }, cmd: Command) => {
    await claimsListCommand(withGlobals(cmd, opts));
  });

// --- proof ----------------------------------------------------------------
const proofCmd = program
  .command('proof')
  .description('ingest and report spec-anchored proof verdicts');

proofCmd
  .command('ingest')
  .description('merge a verdicts file into .specguard/proofs.json')
  .argument('<verdicts>', 'path to verdicts.json')
  .action(async (verdicts: string, _opts: Record<string, never>, cmd: Command) => {
    await proofIngestCommand(verdicts, withGlobals(cmd, {}));
  });

proofCmd
  .command('status')
  .description('report proven, failed, unexercised, stale, and unproven claims')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await proofStatusCommand(withGlobals(cmd, {}));
  });

// --- contracts ------------------------------------------------------------
program
  .command('contracts')
  .description('build or refresh the workspace contract graph (contracts.json)')
  .option('--force', 'force re-parse all specs, ignoring existing contracts.json')
  .option('--with-llm', 'use LLM to extract contracts from free-text Dependencies sections')
  .option('--repo <key>', 'restrict to a single repo key from workspace.json')
  .action(
    async (
      opts: { force?: boolean; withLlm?: boolean; repo?: string },
      cmd: Command,
    ) => {
      await contractsCommand(withGlobals(cmd, opts));
    },
  );

// --- impact ---------------------------------------------------------------
program
  .command('impact')
  .description('show blast radius of a changed spec or file')
  .argument('<target>', 'spec node ID, relative path, or absolute path to analyze')
  .option('--max-depth <n>', 'maximum traversal depth (default: 6)')
  .option('--upstream', 'also show upstream dependencies (what this node depends on)')
  .action(
    async (
      target: string,
      opts: { maxDepth?: string; upstream?: boolean },
      cmd: Command,
    ) => {
      await impactCommand(target, withGlobals(cmd, opts));
    },
  );

// --- workspace ------------------------------------------------------------
const workspaceCmd = program
  .command('workspace')
  .description('workspace-level commands for multi-repo projects');

workspaceCmd
  .command('init')
  .description('create .specguard/workspace.json by scanning sibling repo directories')
  .option('--name <name>', 'workspace name (defaults to directory name)')
  .action(async (opts: { name?: string }) => {
    await workspaceInitCommand({ name: opts.name });
  });

workspaceCmd
  .command('status')
  .description('cross-repo health dashboard showing spec counts, contract edges, and health')
  .action(async () => {
    await workspaceStatusCommand();
  });

workspaceCmd
  .command('drift')
  .description('run cross-repo drift detection via contract graph edges')
  .option('--since <ref>', 'git ref to diff against (default: HEAD~1)')
  .option('--force', 'force re-check all contracts regardless of git changes')
  .option('--repo <key>', 'restrict to a single repo key')
  .action(async (opts: { since?: string; force?: boolean; repo?: string }) => {
    const cwd = process.cwd();
    let manifest: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>['manifest'];
    let repos: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>['repos'];
    try {
      ({ manifest, repos } = await loadWorkspaceWithConfigs(cwd));
    } catch {
      process.stderr.write(
        '[workspace drift] No workspace.json found. Run `specguard workspace init` first.\n',
      );
      process.exit(1);
    }
    const result = await runWorkspaceDrift(manifest, repos, {
      since: opts.since,
      force: opts.force,
      repo: opts.repo,
    });
    for (const line of result.messages) process.stdout.write(`${line}\n`);
    process.exit(result.exitCode);
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

/**
 * True when this module is the process entrypoint.
 *
 * Handles two execution contexts:
 *  - ESM (tsx dev, direct node --experimental-vm-modules): import.meta.url is set
 *  - CJS bundle (esbuild --format=cjs): import_meta = {}, so import.meta.url is
 *    undefined; fall back to __filename which Node.js always sets in CJS modules.
 */
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const abs = resolve(argv1);
  // ESM path: import.meta.url is set (tsx, native ESM)
  try {
    if (import.meta.url) {
      const self = fileURLToPath(import.meta.url);
      if (self === abs) return true;
      // pnpm/npm bin wrappers: argv[1] traverses a symlink that resolves to
      // a different absolute path than import.meta.url. Compare real paths.
      try {
        if (realpathSync(abs) === self) return true;
        if (realpathSync(abs) === realpathSync(self)) return true;
      } catch { /* not a symlink or path doesn't exist */ }
    }
  } catch { /* ignore — not in ESM context */ }
  // CJS bundle path: __filename is a Node.js CJS local variable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cjsFilename = (globalThis as any).__filename as string | undefined;
  if (cjsFilename) return resolve(cjsFilename) === abs;
  // Last resort: basename match for the known entry-point filename
  return abs.replace(/\.js$/, '').split('/').pop() === 'cli';
}

if (isMainModule()) {
  void main();
}
