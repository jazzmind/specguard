/**
 * `specguard history ...`: requirement history.
 *
 * `inbox` and `capture` are hook entry points: they read the hook JSON from
 * stdin, print nothing and always exit 0, so a failure can never disturb the
 * agent session that triggered them.
 */
import { capturePlan, recordPrompt, runHistoryAdd, runHistoryLog, type HistoryAddOpts } from '../../pipelines/history.js';
import { loadCliConfig, outputResult, tryLoadCliConfig, type GlobalOpts } from './helpers.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export async function historyAddCommand(opts: GlobalOpts & HistoryAddOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runHistoryAdd(config, opts), opts);
}

export async function historyLogCommand(opts: GlobalOpts & { capability?: string }): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runHistoryLog(config, { capability: opts.capability }), opts);
}

export async function historyInboxCommand(opts: GlobalOpts): Promise<void> {
  try {
    const stdin = await readStdin();
    const config = await tryLoadCliConfig(opts);
    if (config) recordPrompt(config, stdin);
  } catch {
    /* hooks never fail the session */
  }
  process.exit(0);
}

export async function historyCaptureCommand(opts: GlobalOpts): Promise<void> {
  try {
    const stdin = await readStdin();
    const config = await tryLoadCliConfig(opts);
    if (config) await capturePlan(config, stdin);
  } catch {
    /* hooks never fail the session */
  }
  process.exit(0);
}
