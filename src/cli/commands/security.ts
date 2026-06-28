/**
 * `specguard security` — generate security tests / run SAST (Phase 5).
 */
import { runSecurity } from '../../pipelines/security.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface SecurityCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  withSast?: boolean;
  app?: string;
  force?: boolean;
}

export async function securityCommand(opts: SecurityCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runSecurity(config, {
    spec: opts.spec,
    all: opts.all,
    withSast: opts.withSast,
    app: opts.app,
    force: opts.force,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `security: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed\n`,
  );
  process.exit(result.exitCode);
}
