/**
 * Registration seam for `specguard ci run`.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 * Contract: the registration function's signature is frozen; Slice M (CI orchestrator) fills in the body.
 */
import type { Command } from 'commander';

export function registerCiCommands(_program: Command): void {
  // Slice M (CI orchestrator) registers the commands here.
}
