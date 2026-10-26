/**
 * Registration seam for `specguard migrate`.
 *
 * Spec: specs/capabilities/platform-foundation.md
 * Contract: the registration function's signature is frozen; Slice L (migrate) fills in the body.
 */
import type { Command } from 'commander';

export function registerMigrateCommand(_program: Command): void {
  // Slice L (migrate) registers the commands here.
}
