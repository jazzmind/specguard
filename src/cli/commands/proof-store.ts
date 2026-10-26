/**
 * `specguard proof fetch|publish|notes|prune`: the proof notes in git. They join the `proof` group that
 * `proof ingest|status` (in `proof.ts`) already created.
 *
 * Spec: specs/capabilities/proof-store.md
 * Contract: the registration function's signature is frozen; the commands are thin wiring over src/pipelines/proof-store-cmd.ts.
 */
import type { Command } from 'commander';

import { runProofFetch, runProofNotes, runProofPrune, runProofPublish } from '../../pipelines/proof-store-cmd.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

const globalsOf = (cmd: Command): GlobalOpts => {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return { config: g.config, json: g.json };
};

export function registerProofCommands(program: Command): void {
  const proof = program.commands.find((c) => c.name() === 'proof') ?? program.command('proof').description('ingest and report spec-anchored proof verdicts');

  proof
    .command('fetch')
    .description('fetch the CI proof notes (refs/notes/specguard) from the remote, so check sees what CI proved')
    .option('--configure', 'add the notes refspec to remote.<name>.fetch, so a plain git fetch brings the notes')
    .option('--quiet', 'say nothing and never fail (for a background fetch)')
    .option('--if-older <duration>', 'skip when the last fetch is younger than this (30s, 10m, 2h, 1d); skipped when proofStore.autoFetch is off')
    .action(async (opts: { configure?: boolean; quiet?: boolean; ifOlder?: string }, cmd: Command) => {
      const globals = globalsOf(cmd);
      const result = await runProofFetch(await loadCliConfig(globals), opts);
      if (opts.quiet) process.exit(0);
      outputResult(result, globals);
    });

  proof
    .command('publish')
    .description('write the proof note for HEAD from the fresh evidence and push it (CI only; --force-local writes a provisional note on this machine)')
    .option('--commit <sha>', 'the commit to record (must be the checked-out commit)')
    .option('--no-push', 'write the local notes ref only')
    .option('--push', 'with --force-local: push the provisional note too')
    .option('--force-local', 'outside CI: write a provisional note from the local ledger; readers treat its rows as local evidence')
    .option('--allow-non-github', 'allow a CI that is not GitHub Actions (CI=true)')
    .action(async (opts: { commit?: string; push?: boolean; forceLocal?: boolean; allowNonGithub?: boolean }, cmd: Command) => {
      const globals = globalsOf(cmd);
      // Commander turns --no-push into push: false and leaves push undefined when neither flag is given.
      const result = await runProofPublish(await loadCliConfig(globals), { commit: opts.commit, noPush: opts.push === false, push: opts.push === true, forceLocal: opts.forceLocal, allowNonGithub: opts.allowNonGithub });
      outputResult(result, globals);
    });

  proof
    .command('notes')
    .alias('show')
    .description("summarize the nearest proof note (or the note on a commit): rows by verdict, its statement, and where this checkout's evidence comes from")
    .argument('[commit]', 'a commit; default the nearest noted ancestor of HEAD')
    .action(async (commit: string | undefined, _opts: Record<string, never>, cmd: Command) => {
      const globals = globalsOf(cmd);
      outputResult(await runProofNotes(await loadCliConfig(globals), { commit }), globals);
    });

  proof
    .command('prune')
    .description('remove proof notes of commits no branch or tag reaches, older than --days; lists them unless --yes')
    .option('--days <n>', 'older than this many days (default proofStore.pruneDays, 90)')
    .option('--yes', 'remove them')
    .option('--push', 'push the notes ref afterwards, so the removal reaches the remote')
    .action(async (opts: { days?: string; yes?: boolean; push?: boolean }, cmd: Command) => {
      const globals = globalsOf(cmd);
      const days = opts.days === undefined ? undefined : Number(opts.days);
      outputResult(await runProofPrune(await loadCliConfig(globals), { days, yes: opts.yes, push: opts.push }), globals);
    });
}
