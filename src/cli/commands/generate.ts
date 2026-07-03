/**
 * `specguard generate` — generate tests from specs (Phase 4 forward pipeline).
 */
import { runForwardGenerate, type TestType } from '../../pipelines/forward-generate.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

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

  outputResult(result, opts);
}
