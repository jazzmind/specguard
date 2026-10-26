/**
 * Changed claims: which requirements of a capability were added, modified or removed between a base version of
 * its spec and the current one, down to example rows. The change protocol, the proof packet and the CI approval
 * rules all start from this list. Pure: callers supply the parsed specs.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import type { ParsedSpec } from './types.js';

export type ClaimChange = 'added' | 'modified' | 'removed';

export interface ChangedClaim {
  /** `specKey#claim` or `specKey#claim/row`. */
  ref: string;
  capability: string;
  change: ClaimChange;
  /** For claims: which parts changed. */
  parts?: Array<'text' | 'rows-added' | 'rows-changed' | 'rows-removed'>;
  /** Current hash (absent when removed). */
  hash?: string;
  /** Hash at base (absent when added). */
  baseHash?: string;
  /** Current text, for the packet. */
  text?: string;
  baseText?: string;
}

/**
 * Compare the parsed spec at base and now, for the given capabilities. A spec file added means all its claims are
 * added; deleted means all removed. A row whose only change is the claim-hash cascade is not listed on its own.
 */
export function diffClaims(
  _base: Map<string /* capability */, ParsedSpec | undefined>,
  _now: Map<string, ParsedSpec | undefined>,
): ChangedClaim[] {
  throw new Error('not implemented: diffClaims');
}
