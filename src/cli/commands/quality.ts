/**
 * `specguard quality` — run code quality checks (ESLint + Knip).
 */
import { runCodeQuality } from '../../pipelines/code-quality.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface QualityCliOpts extends GlobalOpts {
  app?: string;
  fix?: boolean;
}

export async function qualityCommand(opts: QualityCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runCodeQuality(config, { app: opts.app, fix: opts.fix });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `quality: ${result.created} finding(s) — ${result.failed} error(s)\n`,
  );
  process.exit(result.exitCode);
}
