/**
 * `specguard reverse` — generate specs from source via the reverse pipeline.
 */
import { runReverseGenerate } from '../../pipelines/reverse-generate.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';
import { ExitCode } from '../../core/exit-codes.js';

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

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let lastExitCode = 0;

  for (const appName of apps) {
    process.stdout.write(`reverse: analyzing app "${appName}"...\n`);
    const result = await runReverseGenerate(config, {
      app: appName,
      file: opts.file,
      force: opts.force,
    });

    for (const line of result.messages) {
      process.stdout.write(`${line}\n`);
    }
    totalCreated += result.created;
    totalUpdated += result.updated ?? 0;
    totalSkipped += result.skipped;
    totalFailed += result.failed;
    if (result.exitCode !== 0) lastExitCode = result.exitCode;
  }

  process.stdout.write(
    `reverse: ${totalCreated} created, ${totalUpdated} updated, ` +
      `${totalSkipped} skipped, ${totalFailed} failed\n`,
  );

  process.exit(lastExitCode);
}
