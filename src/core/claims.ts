/**
 * Claim anchors and journey invariants.
 *
 * A claim is a stable id on one acceptance-criteria bullet:
 *   - Award is skipped when already earned <!-- claim: award-once -->
 *
 * The full reference used by journey specs and the proof ledger is
 * `repo:specKey#claimId` (repo key from workspace.json). `specKey#claimId`
 * is accepted when the spec lives in the repo currently being checked.
 *
 * Spec: specs/core/claims.md
 */
import type { JourneyInvariant, JourneySpec, SpecClaim, SpecMeta } from './types.js';

const CLAIM_ANCHOR = /<!--\s*claim:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->/i;
const BULLET = /^(\s*[-*]\s+(?:\[[ xX]\]\s+)?)(.*)$/;

/** Pull claim bullets out of an Acceptance Criteria section body. */
export function parseClaims(acceptanceCriteria: string): SpecClaim[] {
  if (!acceptanceCriteria.trim()) return [];
  const claims: SpecClaim[] = [];
  for (const line of acceptanceCriteria.split(/\r?\n/)) {
    const bullet = line.match(BULLET);
    if (!bullet) continue;
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

/** Claim ids that appear more than once in one spec. */
export function duplicateClaimIds(claims: SpecClaim[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const claim of claims) {
    if (!claim.id) continue;
    if (seen.has(claim.id)) dupes.add(claim.id);
    seen.add(claim.id);
  }
  return [...dupes];
}

/** Deterministic slug from bullet text. At most six words, 48 characters. */
export function slugFromText(text: string): string {
  const words = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`]*`/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6);
  let slug = words.join('-').slice(0, 48).replace(/-+$/g, '');
  if (!/^[a-z]/.test(slug)) slug = `claim-${slug}`.replace(/-+$/g, '');
  if (!slug || slug === 'claim-') slug = 'claim';
  return slug;
}

function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export interface AssignedClaim {
  id: string;
  text: string;
}

/**
 * Append `<!-- claim: slug -->` to acceptance-criteria bullets that lack one.
 * Existing anchors are never rewritten. Bullets outside that section are left
 * alone. Returns the rewritten markdown and the claims that were added.
 */
export function assignClaimIds(content: string): { content: string; assigned: AssignedClaim[] } {
  const lines = content.split(/\r?\n/);
  const used = new Set<string>();
  let inCriteria = false;
  const assigned: AssignedClaim[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inCriteria = /^##\s+Acceptance Criteria\s*$/i.test(line);
      continue;
    }
    if (!inCriteria) continue;
    const bullet = line.match(BULLET);
    if (!bullet) continue;
    const anchor = bullet[2].match(CLAIM_ANCHOR);
    if (anchor) used.add(anchor[1].toLowerCase());
  }

  const out: string[] = [];
  inCriteria = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inCriteria = /^##\s+Acceptance Criteria\s*$/i.test(line);
      out.push(line);
      continue;
    }
    if (!inCriteria) {
      out.push(line);
      continue;
    }
    const bullet = line.match(BULLET);
    if (!bullet || CLAIM_ANCHOR.test(bullet[2])) {
      out.push(line);
      continue;
    }
    const text = bullet[2].trim();
    if (!text) {
      out.push(line);
      continue;
    }
    const id = uniqueSlug(slugFromText(text), used);
    used.add(id);
    assigned.push({ id, text });
    out.push(`${line} <!-- claim: ${id} -->`);
  }

  return { content: out.join('\n'), assigned };
}

/** `repo:specKey#claimId` or `specKey#claimId`. */
export interface ClaimRef {
  repo?: string;
  specKey: string;
  claimId: string;
}

export function formatClaimRef(repo: string | undefined, specKey: string, claimId: string): string {
  return repo ? `${repo}:${specKey}#${claimId}` : `${specKey}#${claimId}`;
}

export function parseClaimRef(ref: string): ClaimRef | null {
  const hash = ref.lastIndexOf('#');
  if (hash <= 0 || hash === ref.length - 1) return null;
  const claimId = ref.slice(hash + 1).trim().toLowerCase();
  const left = ref.slice(0, hash).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(claimId) || !left) return null;
  const colon = left.indexOf(':');
  if (colon === -1) return { specKey: left, claimId };
  const repo = left.slice(0, colon).trim();
  const specKey = left.slice(colon + 1).trim();
  if (!repo || !specKey) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(repo)) return null;
  return { repo, specKey, claimId };
}

/** Parse `### id` blocks and their `verifies:` lines from an Invariants section. */
export function parseInvariants(section: string): JourneyInvariant[] {
  if (!section.trim()) return [];
  const blocks: { id: string; body: string[] }[] = [];
  for (const line of section.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      const id = heading[1].trim().replace(/^Invariant:\s*/i, '');
      blocks.push({ id, body: [] });
      continue;
    }
    if (blocks.length > 0) blocks[blocks.length - 1].body.push(line);
  }
  return blocks.map((block) => {
    const verifies: string[] = [];
    const description: string[] = [];
    for (const line of block.body) {
      const marker = line.match(/^\s*verifies:\s*(.+)$/i);
      if (marker) {
        for (const part of marker[1].split(',')) {
          const ref = part.trim();
          if (ref) verifies.push(ref);
        }
      } else if (line.trim()) {
        description.push(line.trim());
      }
    }
    return { id: block.id, description: description.join('\n'), verifies };
  });
}

/**
 * Build the journey view when the spec declares `type: journey` or already
 * has an Invariants section. Returns undefined for ordinary module specs.
 */
export function parseJourney(
  meta: SpecMeta,
  sections: Record<string, string>,
): JourneySpec | undefined {
  const invariants = sections['Invariants'] ?? '';
  if (meta.type !== 'journey' && !invariants.trim()) return undefined;
  return {
    world: sections['World'] ?? '',
    actorsAndGoals: sections['Actors and Goals'] ?? '',
    invariants: parseInvariants(invariants),
    budget: sections['Budget'] ?? '',
    evidence: sections['Evidence'] ?? '',
  };
}

/** Refs cited by invariants that are not in the catalog of known claim refs. */
export function danglingClaimRefs(invariants: JourneyInvariant[], catalog: Set<string>): string[] {
  const missing: string[] = [];
  for (const invariant of invariants) {
    for (const ref of invariant.verifies) {
      if (!catalog.has(ref)) missing.push(`${invariant.id}: ${ref}`);
    }
  }
  return missing;
}
