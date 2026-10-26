/**
 * Changed claims: which requirements of a capability were added, modified or removed between a base version of
 * its spec and the current one, down to example rows. The change protocol, the proof packet and the CI approval
 * rules all start from this list. Pure: callers supply the parsed specs.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import { createHash } from 'node:crypto';

import { claimHashOf, isV2Spec } from './claim-hash.js';
import type { ClaimExample } from './examples.js';
import type { ParsedSpec, SpecClaim } from './types.js';

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
 *
 * Rules:
 * - A claim without an id has no ref and is skipped.
 * - Two v2 specs are compared by claim hash, so a changed Problem & Value (which the hash covers) modifies every claim
 *   it frames. Otherwise (a v1 spec on either side) the normalized text decides.
 * - Rows are listed only for a claim present on both sides: an added or removed claim stands for its rows.
 * - A row is modified when its cells changed; its own hash also moves when the claim is reworded, which is no change.
 * - Order: capabilities sorted; per capability the claims in current order (each followed by its rows), then removed claims.
 */
export function diffClaims(
  base: Map<string /* capability */, ParsedSpec | undefined>,
  now: Map<string, ParsedSpec | undefined>,
): ChangedClaim[] {
  const capabilities = [...new Set([...base.keys(), ...now.keys()])].sort();
  const out: ChangedClaim[] = [];
  for (const capability of capabilities) out.push(...diffCapability(capability, base.get(capability), now.get(capability)));
  return out;
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface Side {
  spec: ParsedSpec;
  claim: SpecClaim & { id: string };
  ref: string;
  hash: string;
}

/** Claims by id (first one wins on a duplicate id), in file order. */
function sideClaims(spec: ParsedSpec | undefined): Side[] {
  if (!spec) return [];
  const seen = new Set<string>();
  const out: Side[] = [];
  for (const claim of spec.claims) {
    if (!claim.id || seen.has(claim.id)) continue;
    seen.add(claim.id);
    const hash = claimHashOf(spec, claim.id) ?? createHash('sha256').update(normalize(claim.text)).digest('hex');
    out.push({ spec, claim: claim as Side['claim'], ref: `${spec.specKey}#${claim.id}`, hash });
  }
  return out;
}

function claimText(s: Side): string {
  return s.claim.text;
}

function rowText(table: { headers: string[] }, row: ClaimExample): string {
  return table.headers.map((h) => `${h}: ${row.cells[h] ?? ''}`).join('; ');
}

function cellsKey(row: ClaimExample): string {
  return JSON.stringify(
    Object.entries(row.cells)
      .map(([k, v]) => [k.toLowerCase(), normalize(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

function diffCapability(capability: string, baseSpec: ParsedSpec | undefined, nowSpec: ParsedSpec | undefined): ChangedClaim[] {
  const before = sideClaims(baseSpec);
  const after = sideClaims(nowSpec);
  const beforeById = new Map(before.map((s) => [s.claim.id, s]));
  const afterIds = new Set(after.map((s) => s.claim.id));
  const out: ChangedClaim[] = [];

  for (const cur of after) {
    const was = beforeById.get(cur.claim.id);
    if (!was) {
      out.push({ ref: cur.ref, capability, change: 'added', hash: cur.hash, text: claimText(cur) });
      continue;
    }
    const sameKind = isV2Spec(was.spec) && isV2Spec(cur.spec);
    const textChanged = sameKind ? was.hash !== cur.hash : normalize(was.claim.text) !== normalize(cur.claim.text);

    const rows: ChangedClaim[] = [];
    const parts: NonNullable<ChangedClaim['parts']> = [];
    const wasRows = new Map((was.claim.examples?.rows ?? []).map((r) => [r.id, r]));
    const nowRows = cur.claim.examples?.rows ?? [];
    const nowIds = new Set(nowRows.map((r) => r.id));
    const added: ChangedClaim[] = [];
    const changed: ChangedClaim[] = [];
    const removed: ChangedClaim[] = [];
    for (const row of nowRows) {
      const prior = wasRows.get(row.id);
      const rowRef = `${cur.ref}/${row.id}`;
      const table = cur.claim.examples!;
      if (!prior) added.push({ ref: rowRef, capability, change: 'added', hash: row.hash, text: rowText(table, row) });
      else if (cellsKey(prior) !== cellsKey(row)) {
        changed.push({
          ref: rowRef, capability, change: 'modified', hash: row.hash, baseHash: prior.hash,
          text: rowText(table, row), baseText: rowText(was.claim.examples!, prior),
        });
      }
    }
    for (const [id, prior] of wasRows) {
      if (nowIds.has(id)) continue;
      removed.push({ ref: `${cur.ref}/${id}`, capability, change: 'removed', baseHash: prior.hash, baseText: rowText(was.claim.examples!, prior) });
    }
    rows.push(...added, ...changed, ...removed);
    if (textChanged) parts.push('text');
    if (added.length) parts.push('rows-added');
    if (changed.length) parts.push('rows-changed');
    if (removed.length) parts.push('rows-removed');
    if (parts.length === 0) continue;
    out.push({
      ref: cur.ref, capability, change: 'modified', parts, hash: cur.hash, baseHash: was.hash,
      text: claimText(cur), baseText: claimText(was),
    });
    out.push(...rows);
  }

  for (const was of before) {
    if (afterIds.has(was.claim.id)) continue;
    out.push({ ref: was.ref, capability, change: 'removed', baseHash: was.hash, baseText: claimText(was) });
  }
  return out;
}
