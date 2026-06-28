/**
 * `specguard docs` — generate user-facing documentation from specs (Phase 5).
 */
import { runDocGenerate } from '../../pipelines/doc-generate.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface DocsCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  out?: string;
  app?: string;
}

export async function docsCommand(opts: DocsCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runDocGenerate(config, {
    spec: opts.spec,
    all: opts.all,
    out: opts.out,
    app: opts.app,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `docs: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed\n`,
  );
  process.exit(result.exitCode);
}
