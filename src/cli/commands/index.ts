import type { GlobalOpts } from './helpers.js';
import type { IndexOpts } from '../../pipelines/index-generate.js';
import { runIndex } from '../../pipelines/index-generate.js';
import { loadConfig } from '../../core/config.js';

export type IndexCliOpts = GlobalOpts & { app?: string; force?: boolean };

export async function indexCommand(opts: IndexCliOpts): Promise<void> {
  const config = await loadConfig(opts.config);

  const indexOpts: IndexOpts = {
    app: opts.app,
    force: opts.force,
    onLog: (line: string) => process.stdout.write(`${line}\n`),
  };

  const result = await runIndex(config, indexOpts);
  process.exit(result.exitCode);
}
