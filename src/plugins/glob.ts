import { globSync } from 'tinyglobby';
import path from 'node:path';

/** Synchronous glob relative to `rootDir`; absolute, sorted results. A literal path matches itself. */
export function expandGlobsSync(pattern: string, rootDir: string): string[] {
  const matches = globSync(pattern, { cwd: rootDir, absolute: true, onlyFiles: true, dot: false });
  return [...new Set(matches.map((m) => path.resolve(m)))].sort();
}
