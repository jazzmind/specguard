/**
 * `specguard validate` — PERCEIVE-PLAN-ACT-VERIFY browser validation.
 */
import { runValidate } from '../../pipelines/validate.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface ValidateCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  url?: string;
  app?: string;
  noReview?: boolean;
  headed?: boolean;
  allowOutbound?: boolean;
}

export async function validateCommand(opts: ValidateCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runValidate(config, {
    spec: opts.spec,
    all: opts.all,
    baseUrl: opts.url,
    app: opts.app,
    noReview: opts.noReview,
    headed: opts.headed,
    allowOutbound: opts.allowOutbound,
  });

  outputResult(result, opts);
}
