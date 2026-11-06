/**
 * `specguard docs` — generate user-facing documentation from specs (Phase 5).
 */
import { runDocBuild } from '../../pipelines/doc-build.js';
import { runDocGenerate } from '../../pipelines/doc-generate.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface DocsCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  out?: string;
  app?: string;
}

export async function docsCommand(opts: DocsCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runDocGenerate(config, {
    spec: opts.spec,
    all: opts.all,
    out: opts.out,
    app: opts.app,
  });

  outputResult(result, opts);
}

export interface DocsBuildCliOpts extends GlobalOpts {
  noLlm?: boolean;
  check?: boolean;
  out?: string;
}

/** `specguard docs build`: the documentation set, from the specs. */
export async function docsBuildCommand(opts: DocsBuildCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runDocBuild(config, { noLlm: opts.noLlm, check: opts.check, out: opts.out });
  outputResult(result, opts);
}
