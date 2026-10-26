/**
 * Registration seam for `specguard change start|status|red|green|report|convert|done|abandon|list`.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: the registration function's signature is frozen; Slice J (change pipeline) fills in the body.
 */
import type { Command } from 'commander';

export function registerChangeCommands(_program: Command): void {
  // Slice J (change pipeline) registers the commands here.
}
