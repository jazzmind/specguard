/**
 * `specguard deps` — run dependency health checks (npm-audit + depcheck).
 */
import { runDepCheck } from '../../pipelines/dep-check.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface DepsCliOpts extends GlobalOpts {
  app?: string;
}

export async function depsCommand(opts: DepsCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runDepCheck(config, { app: opts.app });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `deps: ${result.created} finding(s)\n`,
  );
  process.exit(result.exitCode);
}
