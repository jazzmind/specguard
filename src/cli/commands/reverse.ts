/**
 * `specguard reverse` — generate specs from source via the reverse pipeline.
 */
import { runReverseGenerate } from '../../pipelines/reverse-generate.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';
import { ExitCode } from '../../core/exit-codes.js';
import { emptyResult } from '../../core/types.js';

export interface ReverseCliOpts extends GlobalOpts {
  app?: string;
  all?: boolean;
  file?: string;
  force?: boolean;
}

export async function reverseCommand(opts: ReverseCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);

  if (!opts.app && !opts.all) {
    process.stderr.write('reverse: pass --app <name> to target one app, or --all to process every app.\n');
    process.exit(ExitCode.InternalError);
  }

  const apps = opts.all ? config.apps.map((a) => a.name) : [opts.app as string];

  const aggregate = emptyResult('reverse');

  for (const appName of apps) {
    aggregate.messages.push(`reverse: analyzing app "${appName}"...`);
    const result = await runReverseGenerate(config, {
      app: appName,
      file: opts.file,
      force: opts.force,
    });

    aggregate.messages.push(...result.messages);
    aggregate.created += result.created;
    aggregate.updated += result.updated ?? 0;
    aggregate.skipped += result.skipped;
    aggregate.failed += result.failed;
    aggregate.items.push(...result.items);
    if (result.exitCode !== 0) aggregate.exitCode = result.exitCode;
  }

  outputResult(aggregate, opts);
}
