/**
 * Registration seam for `specguard proof fetch|publish|show|prune`. The existing `proof ingest|status` handlers stay in `proof.ts`.
 *
 * Spec: specs/capabilities/proof-store.md
 * Contract: the registration function's signature is frozen; Slice I (proof store) fills in the body.
 */
import type { Command } from 'commander';

export function registerProofCommands(_program: Command): void {
  // Slice I (proof store) registers the commands here.
}
