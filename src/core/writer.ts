/**
 * File write abstraction for SpecGuard.
 *
 * Pipelines write through this module rather than calling `node:fs` directly so
 * intermediate directory creation and UTF-8 encoding stay consistent.
 */
import { writeFile as fsWriteFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Ensure a directory exists, creating intermediate dirs as needed. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Write UTF-8 content to `filePath`, creating any missing parent directories.
 * The content goes to a sibling temp file that is then renamed over the target, so a
 * reader (the docs API, another process) sees the old file or the new one, never half of one.
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await fsWriteFile(temp, content, 'utf-8');
    await rename(temp, filePath);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
