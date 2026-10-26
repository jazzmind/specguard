/**
 * Registration seam for `specguard enforce raise|lower|status`.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: the registration function's signature is frozen; Slice E (ratchet) fills in the body.
 */
import type { Command } from 'commander';

export function registerEnforceCommands(_program: Command): void {
  // Slice E (ratchet) registers the commands here.
}
