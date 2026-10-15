/**
 * `specguard import` — convert external documents to Living Specs.
 */
import { runImport } from '../../pipelines/import.js';
import { runImportIntoCapability } from '../../pipelines/import-capability.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface ImportCliOpts extends GlobalOpts {
  app?: string;
  out?: string;
  force?: boolean;
  capability?: string;
  yes?: boolean;
}

export async function importCommand(source: string, opts: ImportCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  if (opts.capability) {
    const into = await runImportIntoCapability(config, { source, capability: opts.capability, yes: opts.yes });
    for (const line of into.messages) process.stdout.write(`${line}\n`);
    process.stdout.write(`import: ${into.updated} added, ${into.skipped} skipped, ${into.failed} failed\n`);
    process.exit(into.exitCode);
  }
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
