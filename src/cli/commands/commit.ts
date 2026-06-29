/**
 * `specguard commit` — commit SpecGuard-generated files to git.
 */
import { runGitOps } from '../../pipelines/git-ops.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface CommitCliOpts extends GlobalOpts {
  dryRun?: boolean;
  message?: string;
  app?: string;
  /** Originating pipeline name for descriptive commit messages and changelog. */
  pipeline?: string;
}

export async function commitCommand(opts: CommitCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runGitOps(config, {
    dryRun: opts.dryRun,
    message: opts.message,
    app: opts.app,
    context: opts.pipeline ? { pipeline: opts.pipeline, summary: opts.message } : undefined,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `commit: ${result.created} file(s) staged${opts.dryRun ? ' (dry-run)' : ''}\n`,
  );
  process.exit(result.exitCode);
}
