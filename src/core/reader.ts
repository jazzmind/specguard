/**
 * File read abstraction for SpecGuard.
 *
 * Pipelines never call `node:fs` directly for reads — they go through this
 * module so encoding and glob behavior stay consistent across the codebase.
 */
import { readFile as fsReadFile, access } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

/** Read a file as UTF-8 text. */
export async function readFile(filePath: string): Promise<string> {
  return fsReadFile(filePath, 'utf-8');
}

/** Return true if a path exists and is accessible. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand an array of glob patterns relative to `baseDir`.
 * Returns absolute paths, sorted and deduplicated.
 */
export async function expandGlobs(patterns: string[], baseDir: string): Promise<string[]> {
  if (patterns.length === 0) return [];
  const matches = await fg(patterns, {
    cwd: baseDir,
    absolute: true,
    dot: false,
    onlyFiles: true,
  });
  // Normalize, dedupe, sort for stable output.
  const normalized = matches.map((m) => path.resolve(m));
  const unique = Array.from(new Set(normalized));
  unique.sort();
  return unique;
}
