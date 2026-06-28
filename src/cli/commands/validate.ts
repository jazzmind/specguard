/**
 * `specguard validate` — PERCEIVE-PLAN-ACT-VERIFY browser validation.
 */
import { runValidate } from '../../pipelines/validate.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface ValidateCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  url?: string;
  app?: string;
}

export async function validateCommand(opts: ValidateCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runValidate(config, {
    spec: opts.spec,
    all: opts.all,
    baseUrl: opts.url,
    app: opts.app,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `validate: ${result.created} passed, ${result.skipped} skipped, ${result.failed} failed\n`,
  );
  process.exit(result.exitCode);
}
