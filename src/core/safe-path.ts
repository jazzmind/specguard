/**
 * Keeping a path an untrusted caller named inside the directory it was meant for.
 *
 * Used where an agent (through the MCP server) names a file to read: `../../.ssh/id_rsa` and a symlink inside the
 * project that points outside it must not get through. A person on the command line may read any file they could
 * read anyway, so callers opt in to the restriction.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class OutsideRootError extends Error {
  constructor(file: string, root: string) {
    super(`${file} is outside ${root}; only files inside the project can be read here`);
    this.name = 'OutsideRootError';
  }
}

/** True when `child` is `root` or inside it, after resolving symlinks of whatever exists. */
export function isInside(root: string, child: string): boolean {
  const real = (p: string): string => {
    // resolve the longest existing prefix, so a not-yet-created file is judged by where its folder really is
    let head = path.resolve(p);
    const tail: string[] = [];
    while (!existsSync(head) && path.dirname(head) !== head) {
      tail.unshift(path.basename(head));
      head = path.dirname(head);
    }
    return path.join(existsSync(head) ? realpathSync(head) : head, ...tail);
  };
  const rel = path.relative(real(root), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `source` resolved against `root`, or an `OutsideRootError` when it ends up elsewhere. */
export function resolveInside(root: string, source: string): string {
  const abs = path.resolve(root, source);
  if (!isInside(root, abs)) throw new OutsideRootError(source, root);
  return abs;
}
