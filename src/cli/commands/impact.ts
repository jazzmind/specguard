/**
 * `specguard impact <target>` — show blast radius of a changed spec or file.
 *
 * Given a changed spec or source file, traverses the workspace contract graph
 * to show which other repos and specs are affected, and suggests drift/sync
 * commands to run.
 */
import path from 'node:path';
import { loadWorkspaceWithConfigs } from '../../core/workspace.js';
import { runImpact } from '../../pipelines/impact.js';
import { outputResult } from './helpers.js';
import type { GlobalOpts } from './helpers.js';

export interface ImpactCmdOpts extends GlobalOpts {
  maxDepth?: string;
  upstream?: boolean;
}

export async function impactCommand(target: string, opts: ImpactCmdOpts): Promise<void> {
  const cwd = path.resolve(process.cwd());

  let manifest: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>['manifest'];
  try {
    ({ manifest } = await loadWorkspaceWithConfigs(cwd));
  } catch {
    process.stderr.write(
      '[impact] No workspace.json found. Run `specguard workspace init` first.\n',
    );
    process.exit(1);
  }

  const { result } = await runImpact(manifest, {
    target,
    maxDepth: opts.maxDepth ? parseInt(opts.maxDepth, 10) : undefined,
    showUpstream: opts.upstream,
  });

  outputResult(result, opts);
}
