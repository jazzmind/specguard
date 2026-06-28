/**
 * `specguard reverse` — generate specs from source via the reverse pipeline.
 */
import { runReverseGenerate } from '../../pipelines/reverse-generate.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface ReverseCliOpts extends GlobalOpts {
  app: string;
  file?: string;
  force?: boolean;
}

export async function reverseCommand(opts: ReverseCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);

  process.stdout.write(`reverse: analyzing app "${opts.app}"...\n`);
  const result = await runReverseGenerate(config, {
    app: opts.app,
    file: opts.file,
    force: opts.force,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `reverse: ${result.created} created, ${result.updated} updated, ` +
      `${result.skipped} skipped, ${result.failed} failed\n`,
  );

  process.exit(result.exitCode);
}
