/**
 * `specguard import` — convert external documents to Living Specs.
 */
import { runImport } from '../../pipelines/import.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface ImportCliOpts extends GlobalOpts {
  app?: string;
  out?: string;
  force?: boolean;
}

export async function importCommand(source: string, opts: ImportCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runImport(config, {
    source,
    app: opts.app,
    out: opts.out,
    force: opts.force,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `import: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed\n`,
  );
  process.exit(result.exitCode);
}
