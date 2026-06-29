/**
 * File read abstraction for SpecGuard.
 *
 * Pipelines never call `node:fs` directly for reads — they go through this
 * module so encoding and glob behavior stay consistent across the codebase.
 *
 * Security: rejects paths that contain null bytes, URL-encoded traversal
 * sequences, or resolve into restricted OS system directories.
 */
import { readFile as fsReadFile, access } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * OS-level system directories that SpecGuard should never need to read.
 * Pipelines only read project files (specs, source, config).
 */
const RESTRICTED_PREFIXES = ['/etc/', '/dev/', '/proc/', '/sys/'];

/**
 * Validate a path argument for obvious security violations before passing it
 * to the OS. Throws on dangerous inputs; passes clean inputs through.
 */
function validatePath(filePath: unknown): void {
  if (typeof filePath !== 'string') return; // Node.js will throw a TypeError

  // Reject null-byte injection.
  if (filePath.includes('\x00')) {
    throw new Error('Access denied: path contains a null byte');
  }

  // Reject URL-encoded traversal sequences (%2e%2e and double-encoded %252e).
  const lower = filePath.toLowerCase();
  if (lower.includes('%2e%2e') || lower.includes('%252e')) {
    throw new Error('Access denied: URL-encoded traversal sequence detected');
  }

  // Reject raw directory traversal components (".." or "..\" segments).
  // Legitimate paths in SpecGuard are always absolute after path.resolve(),
  // so they never contain ".." components.
  const forwardSlash = filePath.replace(/\\/g, '/');
  if (forwardSlash.split('/').some((seg) => seg === '..')) {
    throw new Error('Access denied: path traversal component (..) detected');
  }

  // Reject paths that resolve to known OS system directories.
  try {
    const resolved = path.resolve(filePath) + '/';
    for (const prefix of RESTRICTED_PREFIXES) {
      if (resolved.startsWith(prefix)) {
        throw new Error('Access denied: path resolves to a restricted system directory');
      }
    }
  } catch (err) {
    if ((err as Error).message.startsWith('Access denied:')) throw err;
    // path.resolve failure or other issues — pass through to the real syscall.
  }
}

/** Read a file as UTF-8 text. */
export async function readFile(filePath: string): Promise<string> {
  validatePath(filePath);
  return fsReadFile(filePath, 'utf-8');
}

/** Return true if a path exists and is accessible. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    validatePath(filePath);
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
