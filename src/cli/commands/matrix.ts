/**
 * `specguard matrix` — traceability matrix.
 */
import { runMatrix } from '../../pipelines/matrix.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface MatrixCliOpts extends GlobalOpts {
  out?: string;
  format?: string;
  app?: string;
}

export async function matrixCommand(opts: MatrixCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runMatrix(config, {
    out: opts.out,
    format: (opts.format as 'json' | 'csv') ?? 'json',
    app: opts.app,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`matrix: ${result.created} entries written\n`);
  process.exit(result.exitCode);
}
