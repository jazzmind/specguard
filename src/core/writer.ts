/**
 * File write abstraction for SpecGuard.
 *
 * Pipelines write through this module rather than calling `node:fs` directly so
 * intermediate directory creation and UTF-8 encoding stay consistent.
 */
import { writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Ensure a directory exists, creating intermediate dirs as needed. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Write UTF-8 content to `filePath`, creating any missing parent directories.
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsWriteFile(filePath, content, 'utf-8');
}
