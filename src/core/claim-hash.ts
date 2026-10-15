/**
 * Claim-scoped hashing for v2 specs.
 *
 * A capability spec holds many claims. Hashing the whole file would make every
 * proof in it stale on any edit, including the `history:` back-references that
 * `history add` writes. A claim's hash covers only what defines it: its own
 * text and the spec's Problem & Value. v1 specs have no such hash and keep the
 * whole-file `specHash` rule.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { createHash } from 'node:crypto';

import type { ParsedSpec } from './types.js';

/**
 * Version of the hashing rules below. Proofs record it, and a client refuses to compare proofs made under
 * different rules. Bump it whenever `claimHashOf` would return a different value for the same spec.
 */
export const HASH_VERSION = 1;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** True for specs that opted into the v2 model (they declare a `kind`). */
export function isV2Spec(spec: Pick<ParsedSpec, 'meta'>): boolean {
  return spec.meta.kind !== undefined;
}

/**
 * Hash of one claim in a v2 spec, or undefined for a v1 spec or an unknown
 * claim id. The same text under a different Problem & Value hashes differently,
 * because the claim's meaning changed.
 */
export function claimHashOf(spec: ParsedSpec, claimId: string): string | undefined {
  if (!isV2Spec(spec)) return undefined;
  const claim = spec.claims.find((c) => c.id === claimId);
  if (!claim) return undefined;
  const value = normalize(spec.sections['Problem & Value'] ?? spec.overview);
  return createHash('sha256').update(`${normalize(claim.text)}\n---\n${value}`).digest('hex');
}
