/**
 * `specguard ci run|packet|doctor`: the CI gate and the tools around it. Thin wiring over `src/pipelines/ci-run.ts`.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { ExitCode } from '../../core/exit-codes.js';
import { ciContextFromEnv, renderSavedPacket, runCi, runCiDoctor } from '../../pipelines/ci-run.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

const globalsOf = (cmd: Command): GlobalOpts => {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return { config: g.config, json: g.json };
};

export function registerCiCommands(program: Command): void {
  const ci = program.command('ci').description('the CI gate: prove what a pull request changed, post the proof packet, write the proof note');

  ci.command('run')
    .description('prove the pull request or commit: run the stale claims, show by construction that changed requirements are tested, trust approvals, post the packet, push the proof note; exits 13 when an enforce capability blocks')
    .option('--event <file>', 'read the event payload from a file instead of the Actions environment (a replay: nothing is written to GitHub)')
    .option('--dry-run', 'do everything locally; write nothing to the notes remote or to GitHub')
    .option('--full', 'run every claim with a test, not just the stale or changed ones')
    .option('--no-tests', 'run no tests: judge what the notes and the ledger hold')
    .option('--no-red', 'skip the constructed red tree: sensitivity stays unknown')
    .option('--no-push', 'write the proof note to the local notes ref only')
    .option('--no-comment', 'do not post or update the pull request comment')
    .option('--out <dir>', 'artifact directory (default .specguard/ci)')
    .action(async (opts: { event?: string; dryRun?: boolean; full?: boolean; tests?: boolean; red?: boolean; push?: boolean; comment?: boolean; out?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      const config = await loadCliConfig(globals);
      const ctx = ciContextFromEnv(process.env, opts.event ? path.resolve(opts.event) : undefined);
      const result = await runCi(config, ctx, {
        dryRun: opts.dryRun,
        full: opts.full,
        noTests: opts.tests === false,
        noRed: opts.red === false,
        noPush: opts.push === false,
        noComment: opts.comment === false,
        ...(opts.out ? { out: opts.out } : {}),
      });
      outputResult(result, globals);
    });

  ci.command('packet')
    .description('render a saved proof packet (packet.json) as the pull request markdown')
    .argument('[file]', 'a packet.json (default .specguard/ci/packet.json)')
    .action((file: string | undefined, _opts: Record<string, never>, cmd: Command) => {
      const globals = globalsOf(cmd);
      const target = path.resolve(file ?? '.specguard/ci/packet.json');
      let text: string;
      try {
        text = readFileSync(target, 'utf8');
      } catch {
        process.stderr.write(`no packet at ${target}: run \`specguard ci run\` first\n`);
        process.exit(ExitCode.InternalError);
      }
      const rendered = renderSavedPacket(text);
      if (!rendered.ok) {
        process.stderr.write(`${rendered.error}\n`);
        process.exit(ExitCode.ValidationFailed);
      }
      process.stdout.write(globals.json ? `${JSON.stringify(rendered.packet)}\n` : `${rendered.markdown}\n`);
      process.exit(ExitCode.Success);
    });

  ci.command('doctor')
    .description('check the environment, the permissions and what ci run would do here (no network)')
    .option('--event <file>', 'check against a recorded event payload')
    .action(async (opts: { event?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runCiDoctor(await loadCliConfig(globals), { ...(opts.event ? { eventFile: path.resolve(opts.event) } : {}) }), globals);
    });
}
