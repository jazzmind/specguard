import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `selfUrl` is the process entrypoint named by `argv1`.
 * npx and npm/pnpm `.bin` entries are symlinks, so `argv1` can differ from the module's own path;
 * compare real paths, as the CLI's entry check does.
 */
export function isEntrypoint(selfUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    const self = fileURLToPath(selfUrl);
    const abs = path.resolve(argv1);
    if (self === abs) return true;
    return realpathSync(abs) === realpathSync(self);
  } catch {
    return false;
  }
}
