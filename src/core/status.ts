/**
 * Live status lines for long-running pipelines.
 *
 * `console.log` and `process.stdout.write` are block-buffered when stdout is
 * a pipe, so a multi-hour run can look frozen until the process exits.
 * `writeSync` on the stdout fd pushes the line through immediately.
 */
import fs from 'node:fs';

export function emitStatus(line: string): void {
  const text = line.endsWith('\n') ? line : `${line}\n`;
  try {
    fs.writeSync(process.stdout.fd, text);
  } catch {
    process.stdout.write(text);
  }
}
