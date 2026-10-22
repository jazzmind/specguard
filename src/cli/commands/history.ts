/**
 * `specguard history ...`: requirement history.
 *
 * `inbox` and `capture` are hook entry points: they read the hook JSON from
 * stdin, print nothing and always exit 0, so a failure can never disturb the
 * agent session that triggered them.
 */
import { capturePlan, recordPrompt, runHistoryAdd, runHistoryLog, type HistoryAddOpts } from '../../pipelines/history.js';
import { loadCliConfig, outputResult, tryLoadCliConfig, type GlobalOpts } from './helpers.js';

/** Hook input is a small JSON document; reading stops at this size so a runaway or hostile writer cannot exhaust memory. */
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;

/** Read stdin up to `limit` bytes. Input over the limit is dropped whole (a truncated JSON document is useless). */
export async function readStdin(stream: AsyncIterable<unknown> = process.stdin, limit = MAX_STDIN_BYTES): Promise<string> {
  if (stream === process.stdin && process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > limit) return '';
    chunks.push(buf);
  }
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
