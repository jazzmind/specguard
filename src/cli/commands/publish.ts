/**
 * `specguard publish`: write a snapshot of this project for a team server.
 */
import { runPublish } from '../../pipelines/publish.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface PublishCliOpts extends GlobalOpts {
  out?: string;
  project?: string;
  push?: boolean;
  server?: string;
  token?: string;
}

export async function publishCommand(opts: PublishCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runPublish(config, { out: opts.out, project: opts.project, push: opts.push, server: opts.server, token: opts.token }), opts);
}
