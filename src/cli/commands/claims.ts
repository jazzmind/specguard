/**
 * `specguard claims assign` and `specguard claims list`.
 */
import { runClaimsAssign, runClaimsList } from '../../pipelines/claims.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';
import { ExitCode } from '../../core/exit-codes.js';
import { ConfigNotFoundError } from '../../core/errors.js';

export async function claimsAssignCommand(
  opts: GlobalOpts & { dir?: string; dryRun?: boolean },
): Promise<void> {
  const config = opts.dir ? undefined : await loadCliConfig(opts);
  const result = await runClaimsAssign({ dir: opts.dir, dryRun: opts.dryRun, config });
  outputResult(result, opts);
}

export async function claimsListCommand(
  opts: GlobalOpts & { workspace?: boolean },
): Promise<void> {
  if (opts.workspace) {
    const result = await runClaimsList({ cwd: process.cwd(), workspace: true });
    outputResult(result, opts);
    return;
  }
  try {
    const config = await loadCliConfig(opts);
    const result = await runClaimsList({
      cwd: config.rootDir ?? process.cwd(),
      workspace: false,
      config,
    });
    outputResult(result, opts);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      process.stderr.write('No config found. Run from a repo, or pass --workspace.\n');
      process.exit(ExitCode.InternalError);
    }
    throw err;
  }
}
