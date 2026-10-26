/**
 * `specguard change start|status|red|green|report|convert|done|abandon|list`: the spec-first change protocol.
 *
 * Thin wiring over `src/pipelines/change.ts` and `change-run.ts`. `status` and `report` print a document of their own
 * with `--json` (the stage detection, the packet); the other commands print their `PipelineResult`.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import type { Command } from 'commander';

import { ExitCode } from '../../core/exit-codes.js';
import { buildChangePacket, changeStatuses, runChangeAbandon, runChangeConvert, runChangeDone, runChangeList, runChangeReport, runChangeStart, runChangeStatus } from '../../pipelines/change.js';
import { runChangeGreen, runChangeRed } from '../../pipelines/change-run.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

const globalsOf = (cmd: Command): GlobalOpts => {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return { config: g.config, json: g.json };
};

function printJson(doc: unknown, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(doc)}\n`);
  process.exit(exitCode);
}

export function registerChangeCommands(program: Command): void {
  const change = program.command('change').description('spec-first changes: spec, approval, tests, red, code, green (a person approves; CI validates)');

  change
    .command('start')
    .description('open a change for one or more capabilities (writes .specguard/changes/<id>.json)')
    .argument('<capabilities...>', 'capability ids')
    .option('--refactor', 'no requirement changes: needs code and a green run of the capability claim tests')
    .option('--spike', 'exploration: code first is allowed, but the change cannot merge as a spike')
    .option('--why <text>', 'what the change is for')
    .option('--base <ref>', 'ref the base commit is computed from (default: origin/HEAD, origin/main, main, master)')
    .option('--plan <entryId>', 'link an approved plan (a history entry id)')
    .action(async (capabilities: string[], opts: { refactor?: boolean; spike?: boolean; why?: string; base?: string; plan?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      if (opts.refactor && opts.spike) {
        process.stderr.write('--refactor and --spike cannot be combined\n');
        process.exit(ExitCode.InternalError);
      }
      const kind = opts.refactor ? 'refactor' : opts.spike ? 'spike' : 'feature';
      outputResult(await runChangeStart(await loadCliConfig(globals), { capabilities, kind, why: opts.why, base: opts.base, plan: opts.plan }), globals);
    });

  change
    .command('status')
    .description('where a change stands, detected from git, specs, tests and run records, with the blocks and the next step (all open changes on this branch without an id)')
    .argument('[id]', 'change id (or a unique part of it)')
    .option('--base <ref>', 'base ref to compare against')
    .action(async (id: string | undefined, opts: { base?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      const config = await loadCliConfig(globals);
      if (globals.json) {
        const got = await changeStatuses(config, { id, base: opts.base });
        printJson(got.ok ? { changes: got.changes, errors: got.errors } : { error: got.error }, got.ok && got.errors.length === 0 ? ExitCode.Success : ExitCode.InternalError);
      }
      outputResult(await runChangeStatus(config, { id, base: opts.base }), globals);
    });

  change
    .command('list')
    .description('open changes (and closed ones with --all) with their derived stage')
    .option('--all', 'include closed changes')
    .action(async (opts: { all?: boolean }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runChangeList(await loadCliConfig(globals), { all: opts.all }), globals);
    });

  change
    .command('red')
    .description('run exactly the tests of the changed requirements against the base code and record the run (provisional: CI re-proves red)')
    .argument('[id]', 'change id')
    .option('--base <ref>', 'base ref to compare against')
    .action(async (id: string | undefined, opts: { base?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runChangeRed(await loadCliConfig(globals), { id, base: opts.base }), globals);
    });

  change
    .command('green')
    .description('run the tests of the changed requirements against the current code and record the run')
    .argument('[id]', 'change id')
    .option('--base <ref>', 'base ref to compare against')
    .action(async (id: string | undefined, opts: { base?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runChangeGreen(await loadCliConfig(globals), { id, base: opts.base }), globals);
    });

  change
    .command('report')
    .description('the PR proof packet, built locally and marked provisional (markdown, or the packet with --json)')
    .argument('[id]', 'change id; every open change on this branch when omitted')
    .option('--base <ref>', 'base ref to compare against')
    .action(async (id: string | undefined, opts: { base?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      const config = await loadCliConfig(globals);
      if (globals.json) {
        const built = await buildChangePacket(config, { id, base: opts.base });
        printJson(built.ok ? built.packet : { error: built.error }, built.ok ? ExitCode.Success : ExitCode.InternalError);
      }
      outputResult(await runChangeReport(config, { id, base: opts.base }), globals);
    });

  change
    .command('convert')
    .description('turn a spike into a feature once it has changed requirements and tagged tests')
    .argument('[id]', 'change id')
    .option('--to <kind>', 'only "feature"', 'feature')
    .action(async (id: string | undefined, opts: { to?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runChangeConvert(await loadCliConfig(globals), { id, to: opts.to }), globals);
    });

  change
    .command('done')
    .description('close a validated change (--force --why closes it earlier and is labelled in the packet)')
    .argument('[id]', 'change id')
    .option('--force', 'close although it is not validated')
    .option('--why <text>', 'why (required with --force)')
    .action(async (id: string | undefined, opts: { force?: boolean; why?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runChangeDone(await loadCliConfig(globals), { id, force: opts.force, why: opts.why }), globals);
    });

  change
    .command('abandon')
    .description('close a change without finishing it; hooks and CI then ignore it')
    .argument('[id]', 'change id')
    .requiredOption('--why <text>', 'why the change is abandoned')
    .action(async (id: string | undefined, opts: { why: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runChangeAbandon(await loadCliConfig(globals), { id, why: opts.why }), globals);
    });
}
