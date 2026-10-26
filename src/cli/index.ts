#!/usr/bin/env node
/**
 * SpecGuard CLI entrypoint.
 *
 * Pure wiring: parses arguments with commander, loads config, and dispatches
 * to a pipeline. No business logic lives here — each subcommand delegates to a
 * handler in `./commands/` which in turn calls a pipeline.
 */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { keySetCommand, keyStatusCommand } from './commands/key.js';
import { loadSpecGuardEnv } from '../core/env.js';

// Load .specguard/.env before any pipeline runs, so secrets are available even when the user
// has not exported them in their shell (the repo's file wins over the workspace's).
for (const warning of loadSpecGuardEnv()) process.stderr.write(`warning: ${warning}\n`);

import { Command, CommanderError } from 'commander';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import type { GlobalOpts } from './commands/helpers.js';
import { reverseCommand } from './commands/reverse.js';
import { statusCommand } from './commands/status.js';
import { driftCommand } from './commands/drift.js';
import { generateCommand } from './commands/generate.js';
import { healCommand } from './commands/heal.js';
import {
  securityCommand,
  securityFixCommand,
  securityPlanListCommand,
  securityPlanSetStatusCommand,
  securityPlanShowCommand,
  securityScanCommand,
} from './commands/security.js';
import { docsCommand } from './commands/docs.js';
import { initCommand, scaffoldCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { matrixCommand } from './commands/matrix.js';
import { importCommand } from './commands/import.js';
import { gapAnalysisCommand } from './commands/gap-analysis.js';
import { alignCommand } from './commands/align.js';
import { contractsCommand } from './commands/contracts.js';
import { impactCommand } from './commands/impact.js';
import { pluginAddCommand, pluginDisableCommand, pluginEnableCommand, pluginListCommand, pluginRemoveCommand } from './commands/plugin.js';
import { workspaceIgnoreCommand, workspaceInitCommand, workspacePublishCommand, workspaceStatusCommand, workspaceSyncCommand } from './commands/workspace.js';
import { runWorkspaceDrift } from '../pipelines/workspace-drift.js';
import { loadWorkspaceWithConfigs, workspaceHint } from '../core/workspace.js';
import { indexCommand } from './commands/index.js';
import { claimsAssignCommand, claimsListCommand } from './commands/claims.js';
import type { HistoryAddOpts } from '../pipelines/history.js';
import { registerPluginCommands } from './plugin-commands.js';
import { checkCommand } from './commands/check.js';
import { publishCommand } from './commands/publish.js';
import { loginCommand, logoutCommand } from './commands/login.js';
import { serveCommand } from './commands/serve.js';
import { serverCommand } from './commands/server.js';
import { testRunCommand } from './commands/test.js';
import { historyAddCommand, historyCaptureCommand, historyInboxCommand, historyLogCommand } from './commands/history.js';
import { specApprovalsCommand, specApproveCommand, specConsolidateCommand, specDraftCommand, specGraphCommand, specIndexCommand, specTagCommand, startCommand } from './commands/spec.js';
import { proofIngestCommand, proofStatusCommand } from './commands/proof.js';
import { budgetExceededMessage, setDefaultPipeline, setRecordMode } from '../core/llm-runtime.js';
import { AgentWorkPendingError, pendingMessage, pendingThisRun } from '../core/agent-work.js';
import { agentAnswerCommand, agentPendingCommand } from './commands/agent.js';
import { resultsIngestCommand } from './commands/results.js';
import { coverageIngestCommand } from './commands/coverage.js';
import { mutationIngestCommand } from './commands/mutation.js';
import { remediateCommand, type RemediateCliOpts } from './commands/remediate.js';
import { registerProofCommands } from './commands/proof-store.js';
import { registerChangeCommands } from './commands/change.js';
import { registerEnforceCommands } from './commands/enforce.js';
import { registerHookCommands } from './commands/hook.js';
import { registerCiCommands } from './commands/ci.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { cliVersion, versionInfo } from '../core/version.js';

// One version source: package.json, or the value injected at bundle time (src/core/version.ts).
const _cliVersion = cliVersion();

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
  .option('--record', 'record every real LLM response into the replay directory (see llm.replay)')
  .showHelpAfterError('(add --help for usage)')
  // Throw instead of calling process.exit directly so we control exit codes.
  .exitOverride();

// The running command names the pipeline for per-pipeline LLM overrides and the usage log,
// and --record turns on recording for the whole run.
program.hook('preAction', (thisCommand, actionCommand) => {
  const names: string[] = [];
  for (let c: Command | null = actionCommand; c && c.parent; c = c.parent) names.unshift(c.name());
  setDefaultPipeline(names.join('-') || undefined);
  if (thisCommand.opts<{ record?: boolean }>().record) setRecordMode(true);
});

// A refused LLM call (spend cap) must surface as exit code 8 even when the pipeline
// swallowed the error and went on to print its own summary.
process.on('exit', (code) => {
  const message = budgetExceededMessage();
  if (message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = ExitCode.BudgetExceeded;
    return;
  }
  // Model requests are waiting for the host agent: say so once, and exit 12 (not a failure) even when the
  // pipeline went on to print a summary of its own.
  const waiting = pendingThisRun();
  if (waiting.length > 0) {
    process.stderr.write(`${pendingMessage(waiting)}\n`);
    process.exitCode = ExitCode.AgentWorkPending;
  } else {
    void code;
  }
});

// --- start ----------------------------------------------------------------------
program
  .command('start')
  .description('set up if needed, draft specs from the code, link tests, run them and report; resumable (rerun after the host agent answers: exit 12)')
  .option('--skip-tests', 'do not run the project tests')
  .action(async (opts: { skipTests?: boolean }, cmd: Command) => {
    await startCommand(withGlobals(cmd, opts));
  });

// --- agent (host coding agent answers model requests) --------------------------
const agentCmd = program.command('agent').description('model requests the host coding agent answers (llm.provider "host", or no API key inside an agent)');
agentCmd
  .command('pending')
  .description('list the model requests waiting for an answer (exit 12 when there are any)')
  .option('--full', 'with --json: include each request in full')
  .action(async (opts: { full?: boolean }, cmd: Command) => {
    await agentPendingCommand(withGlobals(cmd, opts));
  });
agentCmd
  .command('answer <hash>')
  .description('record the answer to a pending request (JSON for object requests, text otherwise); a unique 8+ character hash prefix is enough')
  .option('--file <path>', 'read the answer from this file')
  .option('--stdin', 'read the answer from standard input')
  .action(async (hash: string, opts: { file?: string; stdin?: boolean }, cmd: Command) => {
    await agentAnswerCommand(hash, withGlobals(cmd, opts));
  });

// --- init -----------------------------------------------------------------
program
  .command('init')
  .description('scaffold .specguard/config.json, specs, and agent-harness files')
  .option('--with-playwright', 'configure Playwright as the test framework')
  .option('--language <id>', 'target language (typescript|python|go|rust|java); auto-detected when omitted')
  .option('--harness <which>', 'also write agent files for claude, cursor or both (default: none; the Claude Code and Codex plugins make them unnecessary)')
  .option('--single', 'treat the repo as one app even when a pnpm/Yarn/npm/Nx/Turbo workspace is detected')
  .option('--runner <kind>', 'how generated MCP/hook commands run specguard: node|npx|path (default: local binary, else npx)')
  .option('--runner-path <file>', 'specguard CLI entry for --runner path')
  .option('--update-hooks', 'apply a differing existing MCP entry/hook instead of printing its diff')
  .option('--history-hooks', 'record prompts and approved plans as requirement history (hooks go in .claude/settings.local.json)')
  .option('--ci <provider>', 'also write CI workflows: github = a pull request gate that comments its results, and scheduled remediation')
  .option('--auto-merge', 'with --ci: let remediation auto-merge dependency fixes that keep every proof (needs a protected branch)')
  .action(async (opts: { withPlaywright?: boolean; language?: string; harness?: string; single?: boolean; runner?: string; runnerPath?: string; updateHooks?: boolean; historyHooks?: boolean; ci?: string; autoMerge?: boolean }) => {
    await initCommand({
      withPlaywright: opts.withPlaywright,
      language: opts.language,
      harness: opts.harness,
      single: opts.single,
      runner: opts.runner,
      runnerPath: opts.runnerPath,
      updateHooks: opts.updateHooks,
      historyHooks: opts.historyHooks,
      ci: opts.ci,
      autoMerge: opts.autoMerge,
    });
  });

// --- scaffold --------------------------------------------------------------
program
  .command('scaffold')
  .description('regenerate agent-harness files (CLAUDE.md, skills, MCP wiring, /goal) for an existing project')
  .option('--harness <which>', 'agent harness files to generate (claude|cursor|both)', 'both')
  .option('--runner <kind>', 'how generated MCP/hook commands run specguard: node|npx|path (default: local binary, else npx)')
  .option('--runner-path <file>', 'specguard CLI entry for --runner path')
  .option('--update-hooks', 'apply a differing existing MCP entry/hook instead of printing its diff')
  .option('--history-hooks', 'record prompts and approved plans as requirement history (hooks go in .claude/settings.local.json)')
  .action(async (opts: { harness?: string; runner?: string; runnerPath?: string; updateHooks?: boolean; historyHooks?: boolean }) => {
    await scaffoldCommand({ harness: opts.harness, runner: opts.runner, runnerPath: opts.runnerPath, updateHooks: opts.updateHooks, historyHooks: opts.historyHooks });
  });

// --- import <file> --------------------------------------------------------
program
  .command('import')
  .description('import an external document into a spec')
  .argument('<file>', 'document to import (file path or https:// URL)')
  .option('--app <name>', 'target app from config')
  .option('--out <path>', 'override output spec path')
  .option('--force', 'overwrite existing spec')
  .option('--capability <id>', 'add what the document says to this capability spec instead of writing new specs (dry run unless --yes)')
  .option('--yes', 'with --capability: write the proposed requirements')
  .option('--allow-private', 'let a URL resolve to a loopback, private or link-local address (a document on your own network); refused by default')
  .action(async (file: string, opts: { app?: string; out?: string; force?: boolean; capability?: string; yes?: boolean; allowPrivate?: boolean }, cmd: Command) => {
    await importCommand(file, withGlobals(cmd, opts));
  });

// --- reverse --------------------------------------------------------------
program
  .command('reverse')
  .description('generate one spec per source file (superseded by `spec draft`, which writes functional capability specs)')
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
function addGenerate(cmd: Command): Command {
  return cmd
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
        c: Command,
      ) => {
        await generateCommand(withGlobals(c, opts as Parameters<typeof generateCommand>[0]));
      },
    );
}
addGenerate(program.command('generate'));

// --- heal -----------------------------------------------------------------
function addHeal(cmd: Command): Command {
  return cmd
    .description('self-heal failing generated tests')
    .option('--spec <key>', 'run only the app that owns this spec, and only its tests')
    .option('--all', 'heal every app (the default)')
    .option('--app <name>', 'heal a single app')
    .option('--max-retries <n>', 'maximum heal attempts')
    .option('--classify-only', 'classify failures and report them; never rewrite a test or re-run')
    .option('--lenient', 'treat an unreadable test report as passing when the runner exited 0 (default: failure)')
    .action(
      async (
        opts: { spec?: string; all?: boolean; app?: string; maxRetries?: string; classifyOnly?: boolean; lenient?: boolean },
        c: Command,
      ) => {
        await healCommand(withGlobals(c, opts));
      },
    );
}
addHeal(program.command('heal'));

// --- test -----------------------------------------------------------------
const testCmd = program.command('test').description('generate, run and heal the tests that prove the specs');
addGenerate(testCmd.command('generate'));
addHeal(testCmd.command('heal'));
testCmd
  .command('run')
  .description('run the configured tests and ingest the results into the proof ledger')
  .option('--app <name>', 'only this app')
  .option('--run-id <id>', 'run id recorded with each verdict')
  .option('--ledger <file>', 'proof ledger file (default: paths.proofLedger or .specguard/proofs.json)')
  .option('--unexercised', 'also record claims no test cited as unexercised (full runs only)')
  .option('--unit <keys...>', 'workspaces: run only these units')
  .option('--affected', 'workspaces: run only the units whose files changed, and the units that depend on them')
  .option('--since <ref>', 'with --affected: git ref to compare against (default: working tree against HEAD)')
  .option('--claims <refs...>', 'run exactly the tests tagged to these claim refs (by title where the runner can, else their files)')
  .option('--coverage', "add each app's test.coverage.flags and record its report paths (ingest them with `coverage ingest`)")
  .option('--record <id>', 'write .specguard/runs/<id>.json: what ran, per-test verdicts, head commit and an owned-source hash')
  .argument('[files...]', 'run only these test files')
  .action(
    async (
      files: string[],
      opts: {
        app?: string;
        runId?: string;
        ledger?: string;
        unexercised?: boolean;
        unit?: string[];
        affected?: boolean;
        since?: string;
        claims?: string[];
        coverage?: boolean;
        record?: string;
      },
      cmd: Command,
    ) => {
      await testRunCommand(withGlobals(cmd, { ...opts, units: opts.unit, selection: files.length > 0 ? files : undefined }));
    },
  );

// --- validate / verify ----------------------------------------------------
function addValidate(cmd: Command, description: string): Command {
  return cmd
    .description(description)
    .option('--spec <key>', 'target a single spec')
    .option('--all', 'process all specs with url: metadata (with --url, also every v2 capability)')
    .option('--url <url>', 'base URL of the running app')
    .option('--app <name>', 'limit to a single app')
    .option('--no-review', 'skip the multimodal REVIEW step (criterion verdicts only)')
    .option('--headed', 'show the browser window (default: headless, or validate.headless)')
    .option('--allow-outbound', 'let outbound actions (send, invite, pay, ...) run; for staging. Destructive actions stay blocked')
    .option('--emit-tests', 'write a Playwright test (paths.e2eTests, default tests/e2e) from each passing check, tagged only with the requirements it asserts')
    .action(
      async (
        opts: {
          spec?: string;
          all?: boolean;
          url?: string;
          app?: string;
          review?: boolean;
          headed?: boolean;
          allowOutbound?: boolean;
          emitTests?: boolean;
        },
        c: Command,
      ) => {
        // commander turns --no-review into review:false
        await validateCommand(withGlobals(c, { ...opts, noReview: opts.review === false }));
      },
    );
}
addValidate(program.command('validate'), 'validate specs against the running app');
addValidate(
  program.command('verify'),
  'verify the running app against each capability: walk its journeys, judge it against its stated problem and value, and record agentic proof',
);

// --- security -------------------------------------------------------------
const securityCmd = program
  .command('security')
  .description('security: scan code, dependencies, secrets and specs into one remediation plan; fix; track items (bare `security` writes OWASP test stubs)')
  .option('--spec <key>', 'target a single spec')
  .option('--all', 'process all specs')
  .option('--with-sast', 'include static analysis (Semgrep) and the dependency audit for the app language')
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

securityCmd
  .command('scan')
  .description('detect dependency advisories, code findings and secrets, review each capability spec for security flaws, and write a RemediationPlan')
  .option('--min-severity <level>', 'lowest severity in the plan: critical | high | moderate | low (default remediate.minSeverity or high)')
  .option('--app <name>', 'limit to one app')
  .option('--no-spec-review', 'skip the model-based spec-level review')
  .option('--sarif [file]', 'also write the unresolved items as SARIF 2.1.0 for GitHub code scanning (default .specguard/security/scan.sarif)')
  .action(async (opts: { minSeverity?: string; app?: string; specReview?: boolean; sarif?: string | true }, cmd: Command) => {
    await securityScanCommand(withGlobals(cmd, opts));
  });

securityCmd
  .command('fix')
  .description('execute dependency and code items of a plan with the remediation executor (worktree, patch, re-run tests, behaviour verdict)')
  .argument('[plan]', 'plan id, or latest (default)')
  .option('--item <id>', 'fix one item')
  .option('--pr', 'push the branch and open a pull request')
  .option('--dry-run', 'plan and verify in a temporary worktree without leaving a branch')
  .option('--no-llm', 'skip the model-based breaking-change analysis')
  .option('--allow-major', 'allow major-version upgrades')
  .option('--ledger <file>', 'proof ledger the baseline starts from')
  .option('--app <name>', 'limit to one app')
  .action(
    async (
      plan: string | undefined,
      opts: { item?: string; pr?: boolean; dryRun?: boolean; llm?: boolean; allowMajor?: boolean; ledger?: string; app?: string },
      cmd: Command,
    ) => {
      await securityFixCommand(withGlobals(cmd, { ...opts, planId: plan, noLlm: opts.llm === false }));
    },
  );

const securityPlanCmd = securityCmd.command('plan').description('list plans, show one, or report an item\'s progress');
securityPlanCmd.command('list').description('list remediation plans, newest first').action(async (_o: Record<string, never>, cmd: Command) => {
  await securityPlanListCommand(withGlobals(cmd, {}));
});
securityPlanCmd
  .command('show')
  .description('show a plan\'s items')
  .argument('[plan]', 'plan id, or latest (default)', 'latest')
  .action(async (plan: string, _o: Record<string, never>, cmd: Command) => {
    await securityPlanShowCommand(plan, withGlobals(cmd, {}));
  });
securityPlanCmd
  .command('set-status')
  .description('move an item through its lifecycle: open | planned | in-progress | fixed | verified | wont-fix')
  .argument('<plan>', 'plan id, or latest')
  .argument('<item>', 'item id')
  .argument('<status>', 'new status')
  .option('--note <text>', 'why')
  .option('--by <who>', 'who or what made the change')
  .option('--external-ref <id>', 'the item\'s id in an external tracker')
  .action(async (plan: string, item: string, status: string, opts: { note?: string; by?: string; externalRef?: string }, cmd: Command) => {
    await securityPlanSetStatusCommand(plan, item, status, withGlobals(cmd, opts));
  });

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
  .description('detect specs that have drifted from source; with capability specs, one verdict per capability (also `check --drift`)')
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
  .description('build the requirement-to-test traceability matrix (also `check --matrix`)')
  .option('--out <path>', 'output path')
  .option('--format <format>', 'json or csv (default: json)')
  .option('--app <name>', 'limit to a single app')
  .action(
    async (opts: { out?: string; format?: string; app?: string }, cmd: Command) => {
      await matrixCommand(withGlobals(cmd, opts));
    },
  );

// --- gap-analysis ---------------------------------------------------------
program
  .command('gap-analysis')
  .description('detect unimplemented/partial specs and generate implementation plans (also `check --gaps`)')
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
  .description('report spec coverage (also `check`)')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await statusCommand(withGlobals(cmd, {}));
  });

// --- login / logout -------------------------------------------------------
program
  .command('login')
  .description('remember a team server token on this machine (it is checked against the server first)')
  .option('--server <url>', 'the server (default: server.url from config)')
  .option('--token <token>', 'the token; or pipe it on stdin')
  .action(async (opts: { server?: string; token?: string }, cmd: Command) => {
    await loginCommand(withGlobals(cmd, opts));
  });
program
  .command('logout')
  .description('forget the saved token for a team server')
  .option('--server <url>', 'the server (default: server.url from config)')
  .action(async (opts: { server?: string }, cmd: Command) => {
    await logoutCommand(withGlobals(cmd, opts));
  });

// --- key ------------------------------------------------------------------
const keyCmd = program.command('key').description('give SpecGuard the API key its model calls use (kept in a git-ignored .env, never in config.json)');
keyCmd
  .command('set')
  .description('save the key: typed at a hidden prompt, piped on stdin, or read from another variable; never taken from the command line')
  .option('--scope <scope>', 'user (every workspace on this machine, default), workspace, or repo')
  .option('--env-var <name>', 'the variable to set (default: llm.apiKeyEnv from config, else ANTHROPIC_API_KEY)')
  .option('--from-env <name>', 'read the key from this environment variable instead of prompting')
  .option('--workspace <path>', 'with --scope workspace: the manifest (a workspace.json, its folder or a .code-workspace file)')
  .action(async (opts: { scope?: string; envVar?: string; fromEnv?: string; workspace?: string }, cmd: Command) => {
    await keySetCommand(withGlobals(cmd, opts));
  });
keyCmd
  .command('status')
  .description('whether the key is available, and which .env files define it (never prints it)')
  .option('--env-var <name>', 'the variable to check')
  .option('--workspace <path>', 'the workspace manifest to look in')
  .action(async (opts: { envVar?: string; workspace?: string }, cmd: Command) => {
    await keyStatusCommand(withGlobals(cmd, opts));
  });

// --- publish --------------------------------------------------------------
program
  .command('publish')
  .description('write a snapshot of this project (specs, history, trace, proofs, newest plan) for a team server; no source code is included')
  .option('--out <file>', 'where to write it (default .specguard/publish/snapshot.json)')
  .option('--project <name>', 'project name on the server (default: config server.project, the repository name, or the directory name)')
  .option('--push', 'also send it to the project\'s team server (server.url in config, or SPECGUARD_SERVER)')
  .option('--server <url>', 'push to this server (implies --push)')
  .option('--token <token>', 'token for the push (default: SPECGUARD_TOKEN or a saved login)')
  .action(async (opts: { out?: string; project?: string; push?: boolean; server?: string; token?: string }, cmd: Command) => {
    await publishCommand(withGlobals(cmd, opts));
  });

// --- check ----------------------------------------------------------------
program
  .command('check')
  .description('spec health: ownership, tests, proofs, gaps, matrix and drift for the whole system')
  .option('--coverage', 'per-capability files, tests and claims cited by tests')
  .option('--gaps', 'unowned files, untested claims, and claims that are stale, failed or unproven')
  .option('--matrix', 'write the traceability matrix (capability, claim, tests, docs, proof)')
  .option('--csv', 'with --matrix: CSV instead of JSON')
  .option('--out <file>', 'with --matrix: output path relative to the repo root')
  .option('--drift', 'assess code changes against each capability\'s requirements')
  .option('--since <ref>', 'git ref to diff against: with --drift (default: working tree against HEAD); with the summary, the base the proof statement judges changed claims, coverage and weakening against')
  .option('--base <ref>', 'alias of --since')
  .option('--explain <capability>', 'the proof statement of one capability: each pillar, the blocking reasons with the command that fixes each, and the advisory ones')
  .option('--strict', 'judge the proof statement as if every proof.require* gate were on (approval, testability, strength, sensitivity, conformance, alignment, CI evidence)')
  .option('--align', 'map spec scenarios and claims to test assertions with the LLM')
  .option('--spec <id>', 'restrict to one capability')
  .option('--team', 'also show what the team server has proven (CI), set against this working tree')
  .option('--workspace [path]', 'the combined picture of every repo in a workspace (a manifest, its folder or a .code-workspace; default SPECGUARD_WORKSPACE or the manifest above here)')
  .option('--refresh', 'with --workspace: run check in each repo first so the numbers are current')
  .action(async (opts: Record<string, unknown>, cmd: Command) => {
    await checkCommand(withGlobals(cmd, opts));
  });

// --- serve ----------------------------------------------------------------
program
  .command('serve')
  .description('serve the docs and audit API (/api/v1) and a web UI; docs are generated on demand and cached')
  .option('--port <n>', 'port to listen on (default 4317)')
  .option('--host <addr>', 'address to bind (default 127.0.0.1; anything else needs --allow-remote, because the API has no authentication)')
  .option('--allow-remote', 'with --host: bind an address other than loopback, knowing everyone who can reach it can read the API')
  .option('--cors <origin>', 'origin allowed to read the API from a browser, or *')
  .option('--workspace [path]', 'serve every repo of a workspace as a project, plus GET /api/v1/workspace (a manifest, its folder or a .code-workspace; default SPECGUARD_WORKSPACE)')
  .action(async (opts: { port?: string; host?: string; cors?: string; workspace?: string | true; allowRemote?: boolean }, cmd: Command) => {
    await serveCommand(withGlobals(cmd, opts));
  });

// --- server ---------------------------------------------------------------
program
  .command('server')
  .description('run the team server: published snapshots, shared proofs, plans and documents, with sign-in and tokens (configured by SPECGUARD_* environment variables)')
  .option('--port <n>', 'port to listen on (default 4317, or PORT)')
  .option('--host <addr>', 'address to bind (default 0.0.0.0)')
  .option('--base-path <path>', 'path the server is mounted under, for example /specguard')
  .option('--data-dir <dir>', 'where a file-backed server keeps its state (ignored when DATABASE_URL is set)')
  .action(async (opts: { port?: string; host?: string; basePath?: string; dataDir?: string }) => {
    await serverCommand(opts);
  });

// --- history --------------------------------------------------------------
const historyCmd = program
  .command('history')
  .description('requirement history: the prompts, plans and decisions behind each capability');

historyCmd
  .command('add')
  .description('record a prompt, plan or decision under specs/history and link it from the capabilities it affects')
  .option('--prompt <text>', 'the prompt or request')
  .option('--plan <fileOrText>', 'an approved plan: a file path or the text itself')
  .option('--decision <text>', 'a decision and its reasoning')
  .option('--title <text>', 'entry title (default: the plan heading or first line)')
  .option('--affects <ids...>', 'capability ids the entry changes; omitted: the fast model proposes them')
  .option('--kind <kind>', 'prompt | plan | prompt+plan | decision | import')
  .action(async (opts: HistoryAddOpts, cmd: Command) => {
    await historyAddCommand(withGlobals(cmd, opts));
  });

historyCmd
  .command('log')
  .description('show the requirement timeline, newest first')
  .option('--capability <id>', 'only entries behind one capability')
  .action(async (opts: { capability?: string }, cmd: Command) => {
    await historyLogCommand(withGlobals(cmd, opts));
  });

historyCmd
  .command('inbox')
  .description('hook entry point (UserPromptSubmit): reads hook JSON on stdin, records the redacted prompt, prints nothing')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await historyInboxCommand(withGlobals(cmd, {}));
  });

historyCmd
  .command('capture')
  .description('hook entry point (PostToolUse on ExitPlanMode): reads hook JSON on stdin, writes the approved plan and its prompts as one entry')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await historyCaptureCommand(withGlobals(cmd, {}));
  });

// --- spec -----------------------------------------------------------------
const specCmd = program
  .command('spec')
  .description('author and inspect specs: the system, capability and component tree');

specCmd
  .command('graph')
  .description('print the spec tree with owned files and fail on v2 rule violations')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await specGraphCommand(withGlobals(cmd, {}));
  });

specCmd
  .command('index')
  .description('refresh the capability map table in specs/system.md')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await specIndexCommand(withGlobals(cmd, {}));
  });

specCmd
  .command('tag')
  .description('link existing tests to the requirements they prove, as [claims: ...] comments above each test (dry run unless --yes)')
  .option('--spec <id>', 'one capability')
  .option('--yes', 'write the tags')
  .option('--list', 'print every test with the requirements it was tagged with, for review')
  .option('--index <file>', 'record matches in this plain-text index (path from the config root) instead of editing test sources; re-runnable')
  .action(async (opts: { spec?: string; yes?: boolean; list?: boolean; index?: string }, cmd: Command) => {
    await specTagCommand(withGlobals(cmd, opts));
  });

specCmd
  .command('draft')
  .description('write functional specs for an existing codebase: capability map first, then one spec per capability')
  .option('--yes', 'write the specs without stopping at the capability map for review')
  .option('--from-map', 'continue from .specguard/spec-map.json (edit it first if needed)')
  .option('--force', 'overwrite specs that already exist')
  .option('--guidance <text>', 'steer the clustering, for example the capability names to use')
  .option('--history <ids...>', 'ids of specs/history entries to link from every generated spec')
  .action(async (opts: { yes?: boolean; fromMap?: boolean; force?: boolean; history?: string[]; guidance?: string }, cmd: Command) => {
    await specDraftCommand(withGlobals(cmd, opts));
  });

specCmd
  .command('consolidate')
  .description('migrate per-file specs to functional capability specs; rekeys claim tags, proofs and drift state')
  .option('--yes', 'write the specs without stopping at the capability map for review')
  .option('--from-map', 'continue from .specguard/spec-map.json (edit it first if needed)')
  .option('--force', 'overwrite capability specs that already exist')
  .option('--no-archive', 'keep the old specs in place and do not rewrite tags, ledger or registry')
  .option('--rewrite-source-refs', 'update "Spec: specs/..." comments in source files to the new capability spec')
  .option('--guidance <text>', 'steer the clustering, for example the capability names to use')
  .option('--history <ids...>', 'ids of specs/history entries to link from every generated spec')
  .action(
    async (
      opts: { yes?: boolean; fromMap?: boolean; force?: boolean; archive?: boolean; rewriteSourceRefs?: boolean; history?: string[]; guidance?: string },
      cmd: Command,
    ) => {
      await specConsolidateCommand(withGlobals(cmd, { ...opts, noArchive: opts.archive === false }));
    },
  );

specCmd
  .command('approve')
  .description('approve requirements as stating what the system should do, recorded as a committed history entry (dry run unless --yes; CLI only, never an agent tool)')
  .argument('[targets...]', 'capability ids, or claim refs such as cart#total-sums-prices')
  .option('--all', 'every requirement of every capability')
  .option('--as-built', 'accept what the code already does; refused for a capability that owns no source files')
  .option('--by <name>', 'who is approving (default: git user.name)')
  .option('--note <text>', 'why, recorded with the approval')
  .option('--yes', 'write the approval')
  .action(async (targets: string[], opts: { all?: boolean; asBuilt?: boolean; by?: string; note?: string; yes?: boolean }, cmd: Command) => {
    await specApproveCommand(withGlobals(cmd, { ...opts, targets }));
  });

specCmd
  .command('approvals')
  .description('per capability: how many requirements are approved, and which are not')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    await specApprovalsCommand(withGlobals(cmd, {}));
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
  .option('--ledger <file>', 'proof ledger file (default: paths.proofLedger or .specguard/proofs.json)')
  .action(async (verdicts: string, opts: { ledger?: string }, cmd: Command) => {
    await proofIngestCommand(verdicts, withGlobals(cmd, opts));
  });

proofCmd
  .command('status')
  .description('report proven, failed, unexercised, stale, and unproven claims')
  .option('--ledger <file>', 'proof ledger file (default: paths.proofLedger or .specguard/proofs.json)')
  .action(async (opts: { ledger?: string }, cmd: Command) => {
    await proofStatusCommand(withGlobals(cmd, opts));
  });

// --- results --------------------------------------------------------------
const resultsCmd = program
  .command('results')
  .description('ingest test-runner reports as proof verdicts');

resultsCmd
  .command('ingest')
  .description('map test results to claims by @claim tags and write proof verdicts')
  .argument('<files...>', 'reporter output files (globs allowed): vitest/jest JSON, playwright JSON, JUnit XML, pytest-json-report, go test -json, cargo JSON')
  .option('--format <fmt>', 'auto|vitest|jest|playwright|junit|pytest|go|cargo', 'auto')
  .option('--run-id <id>', 'ledger run id (default: timestamped)')
  .option('--unexercised', 'also store unexercised for claims absent from every ingested file (only on a full run; see --full-run)')
  .option('--sweep', 'alias of --unexercised')
  .option('--full-run', 'the ingested files are the complete run; lets --unexercised/--sweep apply')
  .option('--ledger <file>', 'proof ledger file (default: paths.proofLedger or .specguard/proofs.json)')
  .option('--layer <layer>', 'unit|integration|e2e|security|functional: the layer of tests that no @layer tag, config glob or path convention places')
  .action(
    async (
      files: string[],
      opts: { format?: string; runId?: string; unexercised?: boolean; sweep?: boolean; fullRun?: boolean; ledger?: string; layer?: string },
      cmd: Command,
    ) => {
      await resultsIngestCommand(files, withGlobals(cmd, opts));
    },
  );

// --- coverage and mutation evidence -----------------------------------------
const coverageCmd = program
  .command('coverage')
  .description('ingest coverage reports as evidence of which lines tests execute');

coverageCmd
  .command('ingest')
  .description('normalize lcov, JaCoCo, Cobertura or Go coverage reports into .specguard/coverage/')
  .argument('<files...>', 'coverage report files (globs allowed): lcov.info, JaCoCo XML, Cobertura XML, Go coverprofile')
  .option('--format <fmt>', 'auto|lcov|jacoco|cobertura|go', 'auto')
  .option('--capability <id>', 'store the evidence for one capability\'s tests instead of the whole suite')
  .option('--selection <kind>', 'tests|files: what ran for --capability (default tests)')
  .option('--run-id <id>', 'evidence run id (default: timestamped)')
  .option('--origin <origin>', 'local|ci|server (default: ci when CI is set, else local)')
  .action(async (files: string[], opts: { format?: string; capability?: string; selection?: string; runId?: string; origin?: string }, cmd: Command) => {
    await coverageIngestCommand(files, withGlobals(cmd, opts));
  });

const mutationCmd = program
  .command('mutation')
  .description('ingest mutation-testing reports as evidence that tests detect changes');

mutationCmd
  .command('ingest')
  .description('normalize a Stryker report or PIT mutations.xml into .specguard/mutation/')
  .argument('<files...>', 'mutation report files (globs allowed): Stryker mutation.json, PIT mutations.xml')
  .option('--format <fmt>', 'auto|stryker|pit', 'auto')
  .option('--run-id <id>', 'evidence run id (default: timestamped)')
  .option('--origin <origin>', 'local|ci|server (default: ci when CI is set, else local)')
  .action(async (files: string[], opts: { format?: string; runId?: string; origin?: string }, cmd: Command) => {
    await mutationIngestCommand(files, withGlobals(cmd, opts));
  });

// --- remediate --------------------------------------------------------------
program
  .command('remediate')
  .description('patch vulnerable dependencies or code in a temp worktree, prove behavior is preserved, then propose the change (never merges)')
  .option('--scan-only', 'detect and report only; exit 5 when findings remain')
  .option('--advisory <id>', 'remediate one advisory (GHSA/CVE/OSV id)')
  .option('--min-severity <level>', 'critical | high | moderate | low (default: high)')
  .option('--allow-major', 'allow a major version bump when it is the only fix')
  .option('--ledger <file>', 'proof ledger the baseline starts from (default: paths.proofLedger or .specguard/proofs.json)')
  .option('--pr', 'push the branch and open a PR with gh (draft unless the verdict is PRESERVED)')
  .option('--no-pr', 'leave the committed branch, do not push (default)')
  .option('--dry-run', 'run the whole loop but change nothing outside the temp worktree')
  .option('--no-llm', 'skip the LLM breaking-change analysis and code fixes')
  .option('--app <name>', 'restrict to one app')
  .option('--force', 'ignore a fresh .specguard/remediate.lock')
  .option('--from <source>', 'failing: repair the application for failing claims (a failing test or browser check) instead of fixing dependencies; always a pull request for a person')
  .option('--claim <ref>', 'with --from failing: repair only this claim or capability')
  .option('--max <n>', 'with --from failing: most capabilities repaired in one run (default 3)')
  .option('--auto-merge', 'arm GitHub auto-merge on pull requests the policy allows: dependency patch or 1.x minor, manifests and lockfiles only, every proof re-proven in every layer, base branch with required checks (also needs remediate.autoMerge.enabled)')
  .action(async (opts: Omit<RemediateCliOpts, 'config' | 'json'>, cmd: Command) => {
    await remediateCommand(withGlobals(cmd, opts));
  });

// --- contracts ------------------------------------------------------------
program
  .command('contracts')
  .description('build or refresh the workspace contract graph (contracts.json)')
  .option('--force', 'force re-parse all specs, ignoring existing contracts.json')
  .option('--with-llm', 'use LLM to extract contracts from free-text Dependencies sections (only that section of each spec is sent)')
  .option('--max-llm-specs <n>', 'with --with-llm: most specs sent to the model in one run (default 50)')
  .option('--repo <key>', 'restrict to a single repo key from workspace.json')
  .option('--workspace <path>', 'a workspace.json, its folder or a .code-workspace file (default: SPECGUARD_WORKSPACE, else the manifest above the current directory)')
  .action(
    async (
      opts: { force?: boolean; withLlm?: boolean; maxLlmSpecs?: string; repo?: string; workspace?: string },
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
  .option('--workspace <path>', 'a workspace.json, its folder or a .code-workspace file (default: SPECGUARD_WORKSPACE, else the manifest above the current directory)')
  .action(
    async (
      target: string,
      opts: { maxDepth?: string; upstream?: boolean; workspace?: string },
      cmd: Command,
    ) => {
      await impactCommand(target, withGlobals(cmd, opts));
    },
  );

// --- plugin ---------------------------------------------------------------
/** The root program also defines `--json` and takes it wherever it appears, so a subcommand's own `--json` stays unset. */
function withRootJson<T extends { json?: boolean }>(opts: T): T {
  return { ...opts, json: opts.json ?? Boolean(program.opts().json) };
}
const pluginCmd = program.command('plugin').description('browse, enable, disable, add and remove plugins for this repo');

pluginCmd
  .command('list')
  .description('built-in and configured plugins, whether each is on, and the commands it adds')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    await pluginListCommand(withRootJson(opts));
  });

pluginCmd
  .command('enable')
  .description('turn on a built-in or already-listed plugin')
  .argument('<id>', 'plugin id')
  .option('--json', 'machine-readable output')
  .action(async (id: string, opts: { json?: boolean }) => {
    await pluginEnableCommand(id, withRootJson(opts));
  });

pluginCmd
  .command('disable')
  .description('turn off a plugin in this repo, including one an extended config enables')
  .argument('<id>', 'plugin id')
  .option('--json', 'machine-readable output')
  .action(async (id: string, opts: { json?: boolean }) => {
    await pluginDisableCommand(id, withRootJson(opts));
  });

pluginCmd
  .command('add')
  .description("add an npm plugin; it is imported to check it is a plugin, which runs the package's code")
  .argument('<id>', 'plugin id (what the package\'s plugin export is named)')
  .requiredOption('--package <name>', 'npm package that exports the plugin')
  .option('--install', 'run `npm install --save-dev --ignore-scripts <package>` first')
  .option('--yes', 'confirm that you trust the package')
  .option('--json', 'machine-readable output')
  .action(async (id: string, opts: { package: string; install?: boolean; yes?: boolean; json?: boolean }) => {
    await pluginAddCommand(id, withRootJson(opts));
  });

pluginCmd
  .command('remove')
  .description("drop an npm plugin from this repo's list (the package stays installed)")
  .argument('<id>', 'plugin id')
  .option('--json', 'machine-readable output')
  .action(async (id: string, opts: { json?: boolean }) => {
    await pluginRemoveCommand(id, withRootJson(opts));
  });

// --- workspace ------------------------------------------------------------
const workspaceCmd = program
  .command('workspace')
  .description('workspace-level commands for multi-repo projects');

workspaceCmd
  .command('init')
  .description('create .specguard/workspace.json from child folders, a folder tree (--recursive) or a .code-workspace (--from)')
  .option('--name <name>', 'workspace name (defaults to directory name)')
  .option('--from <file>', 'register the folders of this .code-workspace file and keep the manifest in step with it')
  .option('--recursive', 'search nested folders for repos, not only direct children')
  .option('--depth <n>', 'how deep --recursive searches (default 3)', (v) => parseInt(v, 10))
  .option('--link', 'with --from: record the manifest location in the .code-workspace settings')
  .action(async (opts: { name?: string; from?: string; recursive?: boolean; depth?: number; link?: boolean }) => {
    await workspaceInitCommand(opts);
  });

workspaceCmd
  .command('sync')
  .description('bring the manifest in step with its .code-workspace: add new folders, retire dropped ones, keep hand edits')
  .option('--from <file>', 'the .code-workspace file (default: the one the manifest is linked to)')
  .option('--workspace <path>', 'which manifest (a workspace.json, its folder or a .code-workspace file)')
  .action(async (opts: { from?: string; workspace?: string }) => {
    await workspaceSyncCommand(opts);
  });

workspaceCmd
  .command('publish')
  .description('define this workspace on the team server, so it shows the combined view of its projects (each repo still publishes its own snapshot)')
  .option('--name <name>', 'workspace name on the server (default: server.workspace of the manifest, else its name)')
  .option('--server <url>', 'team server (default: SPECGUARD_SERVER, else server.url in a repo config)')
  .option('--token <token>', 'token for the server (default: SPECGUARD_TOKEN or a saved login)')
  .option('--workspace <path>', 'which manifest (a workspace.json, its folder or a .code-workspace file)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { name?: string; server?: string; token?: string; workspace?: string; json?: boolean }) => {
    await workspacePublishCommand(withRootJson(opts));
  });

workspaceCmd
  .command('ignore')
  .description('leave a repo out of every workspace pipeline (contracts, impact, drift, rollup, security, proofs)')
  .argument('<key>', 'repo key from workspace.json')
  .option('--reason <text>', 'why it is ignored')
  .option('--workspace <path>', 'which manifest (a workspace.json, its folder or a .code-workspace file)')
  .action(async (key: string, opts: { reason?: string; workspace?: string }) => {
    await workspaceIgnoreCommand(key, true, opts);
  });

workspaceCmd
  .command('unignore')
  .description('include a previously ignored repo again')
  .argument('<key>', 'repo key from workspace.json')
  .option('--workspace <path>', 'which manifest (a workspace.json, its folder or a .code-workspace file)')
  .action(async (key: string, opts: { workspace?: string }) => {
    await workspaceIgnoreCommand(key, false, opts);
  });

workspaceCmd
  .command('status')
  .description('cross-repo health dashboard showing spec counts, contract edges, and health')
  .option('--workspace <path>', 'which manifest (a workspace.json, its folder or a .code-workspace file)')
  .action(async (opts: { workspace?: string }) => {
    await workspaceStatusCommand(opts);
  });

workspaceCmd
  .command('drift')
  .description('run cross-repo drift detection via contract graph edges')
  .option('--since <ref>', 'git ref to diff against (default: HEAD~1)')
  .option('--force', 'force re-check all contracts regardless of git changes')
  .option('--repo <key>', 'restrict to a single repo key')
  .option('--workspace <path>', 'which manifest (a workspace.json, its folder or a .code-workspace file)')
  .action(async (opts: { since?: string; force?: boolean; repo?: string; workspace?: string }) => {
    const cwd = process.cwd();
    let manifest: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>['manifest'];
    let repos: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>['repos'];
    try {
      ({ manifest, repos } = await loadWorkspaceWithConfigs(cwd, workspaceHint(opts.workspace)));
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

// --- Phase 3 command groups ------------------------------------------------
// Each group lives in its own module so a slice adds commands without touching this file. They register after the
// commands above, so a group that extends an existing command (`proof`) finds it with `program.commands`.
registerProofCommands(program);
registerChangeCommands(program);
registerEnforceCommands(program);
registerHookCommands(program);
registerCiCommands(program);
registerMigrateCommand(program);

export async function main(): Promise<void> {
  // `specguard --version --json` is machine-readable: the extension uses it to detect a CLI/extension mismatch.
  const argv = process.argv.slice(2);
  if ((argv.includes('--version') || argv.includes('-v')) && argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(versionInfo())}\n`);
    process.exit(0);
  }
  try {
    await registerPluginCommands(program);
    await program.parseAsync(process.argv);
  } catch (err) {
    // commander throws CommanderError for --help/--version (exitCode 0) and for
    // usage errors (exitCode 1). Honor its code.
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    if (err instanceof AgentWorkPendingError) {
      process.exit(err.exitCode); // the exit hook prints what is waiting
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
