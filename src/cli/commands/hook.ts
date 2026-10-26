/**
 * Registration seam for `specguard hook pre-tool|post-tool|session-start|log|index`.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: the registration function's signature is frozen; Slice K (hooks) fills in the body.
 */
import type { Command } from 'commander';

export function registerHookCommands(_program: Command): void {
  // Slice K (hooks) registers the commands here.
}
