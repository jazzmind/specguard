import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { claimHashOf } from '../../src/core/claim-hash.js';
import { loadAllSpecs, parseSpecContent } from '../../src/core/spec-parser.js';
import type { SpecClaim } from '../../src/core/types.js';

const SPECS_ROOT = path.resolve(__dirname, '../../specs');

const CLAIM_ANCHOR = /<!--\s*claim:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->/i;
const BULLET = /^(\s*[-*]\s+(?:\[[ xX]\]\s+)?)(.*)$/;

/** The claim parser as it was before example tables existed, kept as the reference the live one must match. */
function legacyParseClaims(section: string): SpecClaim[] {
  const claims: SpecClaim[] = [];
  for (const line of section.split(/\r?\n/)) {
    const bullet = line.match(BULLET);
    if (!bullet) {
      const last = claims[claims.length - 1];
      if (last && /^\s{2,}\S/.test(line)) {
        const anchor = line.match(CLAIM_ANCHOR);
        const more = line.replace(CLAIM_ANCHOR, '').trim();
        if (more) last.text = `${last.text} ${more}`.trim();
        if (anchor && !last.id) last.id = anchor[1].toLowerCase();
      }
      continue;
    }
    const raw = bullet[2];
    const anchor = raw.match(CLAIM_ANCHOR);
    const checkbox = bullet[1].match(/\[([ xX])\]/);
    const text = raw.replace(CLAIM_ANCHOR, '').trim();
    if (!text && !anchor) continue;
    const claim: SpecClaim = { text };
    if (anchor) claim.id = anchor[1].toLowerCase();
    if (checkbox) claim.checked = checkbox[1].toLowerCase() === 'x';
    claims.push(claim);
  }
  return claims;
}

const FIXTURE = `---
id: awards
kind: capability
---
# Awards

## Problem & Value

Players are rewarded fairly.

## Requirements
- [ ] Award is skipped when already earned <!-- claim: award-once -->
- [x] A continued claim
  that spans two lines <!-- claim: continued -->

  Some indented prose that is not a table.
* Star bullet with no checkbox <!-- claim: star-bullet -->
- [ ] Unanchored bullet

## Scenarios
`;

// Hashes recorded from the parser before example tables were added. A change here is a change of every proof and approval.
const FIXTURE_HASHES: Record<string, string> = {
  'award-once': 'fc66c8313fd6c3f53d986c803bb032ad1c464b29e7510e791b115cf7b608d3ea',
  continued: '914c2ab24d17fa34ea8aeeedeef08754d10482ee358cffc5cd0db9f1b24fcd30',
  'star-bullet': '1774fd640a190f540dd824a8a90320ccffc9bcf1f94afd2b0bb2be4548c4107d',
};

describe('claim hash stability [claim-hash-stability]', () => {
  // [claims: capabilities/spec-authoring#claim-hash-unchanged-by-tables]
  it('pins the hashes of a fixture recorded before example tables existed', () => {
    const spec = parseSpecContent(FIXTURE, '/r/specs/awards.md', '/r/specs');
    const got: Record<string, string> = {};
    for (const claim of spec.claims) if (claim.id) got[claim.id] = claimHashOf(spec, claim.id) ?? '';
    expect(got).toEqual(FIXTURE_HASHES);
  });

  // [claims: capabilities/spec-authoring#claim-hash-unchanged-by-tables]
  it('golden: claimHashOf of every claim in specs/ equals the hash the pre-table parser gives', () => {
    const specs = loadAllSpecs(SPECS_ROOT);
    let checked = 0;
    for (const spec of specs) {
      const legacy = { ...spec, claims: legacyParseClaims(spec.acceptanceCriteria) };
      expect(spec.claims.map((c) => c.text)).toEqual(legacy.claims.map((c) => c.text));
      for (const claim of spec.claims) {
        if (!claim.id) continue;
        expect(claimHashOf(spec, claim.id), `${spec.specKey}#${claim.id}`).toBe(claimHashOf(legacy, claim.id));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(250);
  });
});
