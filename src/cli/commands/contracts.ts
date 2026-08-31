/**
 * `specguard contracts` — build/refresh the workspace contract graph.
 *
 * Reads traceability.json files and spec Dependencies sections across all
 * repos in the workspace manifest and writes `.specguard/contracts.json`.
 */
import path from 'node:path';
import { loadWorkspaceWithConfigs } from '../../core/workspace.js';
import { runContracts } from '../../pipelines/contracts.js';
import { outputResult } from './helpers.js';
import type { GlobalOpts } from './helpers.js';

export interface ContractsOpts extends GlobalOpts {
  /** Force re-parse all specs, ignoring any existing contracts.json. */
  force?: boolean;
  /** Use LLM to extract contracts from free-text Dependencies sections. */
  withLlm?: boolean;
  /** Restrict to a single repo key. */
  repo?: string;
}

export async function contractsCommand(opts: ContractsOpts): Promise<void> {
  const cwd = path.resolve(process.cwd());

  let manifest: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>['manifest'];
  let repos: Awaited<ReturnType<typeof loadWorkspaceWithConfigs>>['repos'];
  try {
    ({ manifest, repos } = await loadWorkspaceWithConfigs(cwd));
  } catch {
    process.stderr.write(
      '[contracts] No workspace.json found. Run `specguard workspace init` first.\n',
    );
    process.exit(1);
  }

  // Use LLM config from any repo that has it (first one found)
  const llmConfig = repos.find((r) => r.specGuardConfig != null)?.specGuardConfig ?? undefined;

  const result = await runContracts(manifest, repos, {
    force: opts.force,
    withLlm: opts.withLlm,
    repo: opts.repo,
  }, llmConfig);

  outputResult(result, opts);
}
