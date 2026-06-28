/**
 * `specguard generate` — generate tests from specs (Phase 4 forward pipeline).
 */
import { runForwardGenerate, type TestType } from '../../pipelines/forward-generate.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface GenerateCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  framework?: string;
  app?: string;
  force?: boolean;
  type?: TestType;
}

export async function generateCommand(opts: GenerateCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runForwardGenerate(config, {
    spec: opts.spec,
    all: opts.all,
    framework: opts.framework,
    app: opts.app,
    force: opts.force,
    type: opts.type,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `generate: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed\n`,
  );
  process.exit(result.exitCode);
}
