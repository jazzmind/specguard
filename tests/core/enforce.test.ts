import { describe, expect, it } from 'vitest';

import { claimHashOf } from '../../src/core/claim-hash.js';
import {
  canRaise,
  defaultEnforce,
  effectiveEnforce,
  isLowering,
  newCapabilityEnforce,
  nextLevel,
  policyLine,
  setEnforceLevel,
  unknownEnforce,
} from '../../src/core/enforce.js';
import { parseFrontmatter, parseSpecContent } from '../../src/core/spec-parser.js';
import { ENFORCE_LEVELS, type EnforceLevel, type SpecMeta } from '../../src/core/types.js';

const meta = (enforce?: EnforceLevel, extra: Record<string, string> = {}): SpecMeta => ({ extra, ...(enforce ? { enforce } : {}) });
const BODY = '# X\n\n## Problem & Value\n\nV.\n\n## Requirements\n- [ ] A claim <!-- claim: a-claim -->\n';
const spec = (front: string) => `---\nid: x\nkind: capability\n${front}---\n${BODY}`;

describe('effective level [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-default-observe]
  it('is the frontmatter level, else the config default, else observe', () => {
    expect(effectiveEnforce(meta('warn'), { default: 'enforce' })).toBe('warn');
    expect(effectiveEnforce(meta(), { default: 'warn' })).toBe('warn');
    expect(effectiveEnforce(meta())).toBe('observe');
    expect(effectiveEnforce(meta(), {})).toBe('observe');
    expect(defaultEnforce(undefined)).toBe('observe');
  });

  // [claims: capabilities/spec-first-changes#enforce-default-observe]
  it('a new capability takes enforce.newCapabilities, else the default level', () => {
    expect(newCapabilityEnforce({ default: 'warn', newCapabilities: 'enforce' })).toBe('enforce');
    expect(newCapabilityEnforce({ default: 'warn' })).toBe('warn');
    expect(newCapabilityEnforce()).toBe('observe');
  });

  // [claims: capabilities/spec-first-changes#enforce-unknown-collected]
  it('an unreadable value takes the default and is reported by unknownEnforce', () => {
    const parsed = parseFrontmatter(spec('enforce: strict\n'))!.meta;
    expect(effectiveEnforce(parsed, { default: 'warn' })).toBe('warn');
    expect(unknownEnforce(parsed)).toBe('strict');
    expect(unknownEnforce(meta('warn'))).toBeUndefined();
  });
});

describe('raise and lower rules [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-raise-while-certified]
  it('raising to enforce is refused unless the capability is certified', () => {
    for (const level of ['provisional', 'not-certified', 'planned'] as const) {
      const r = canRaise('warn', 'enforce', level);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain(level);
    }
    expect(canRaise('warn', 'enforce', 'certified')).toEqual({ ok: true });
    expect(canRaise('observe', 'enforce', 'certified')).toEqual({ ok: true });
  });

  // [claims: capabilities/spec-first-changes#enforce-raise-while-certified]
  it('observe to warn is always allowed, and a move that is not a raise is refused', () => {
    for (const level of ['certified', 'provisional', 'not-certified', 'planned'] as const) {
      expect(canRaise('observe', 'warn', level)).toEqual({ ok: true });
    }
    expect(canRaise('warn', 'warn', 'certified').ok).toBe(false);
    expect(canRaise('enforce', 'warn', 'certified')).toMatchObject({ ok: false, reason: expect.stringContaining('enforce lower') });
  });

  // [claims: capabilities/spec-first-changes#enforce-lower-recorded]
  it('isLowering is true for any step down and false for the same level or a step up', () => {
    const pairs = ENFORCE_LEVELS.flatMap((a) => ENFORCE_LEVELS.map((b) => [a, b] as const));
    for (const [a, b] of pairs) expect(isLowering(a, b)).toBe(ENFORCE_LEVELS.indexOf(b) < ENFORCE_LEVELS.indexOf(a));
    expect(isLowering('enforce', 'observe')).toBe(true);
    expect(nextLevel('observe')).toBe('warn');
    expect(nextLevel('enforce')).toBeUndefined();
  });

  // [claims: capabilities/spec-first-changes#enforce-lower-recorded]
  it('names the move in one policy line', () => {
    expect(policyLine('lowered', 'cart', 'enforce', 'warn')).toBe('enforce lowered: cart enforce->warn');
    expect(policyLine('raised', 'cart', 'observe', 'warn')).toBe('enforce raised: cart observe->warn');
  });
});

describe('frontmatter edit [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-minimal-edit]
  it('replaces the value of an existing line in place, keeping a trailing comment and every other byte', () => {
    const before = spec('sources:\n  - "src/**"\nenforce: warn # ratchet\nhistory:\n  - h1\n');
    const after = setEnforceLevel(before, 'enforce');
    expect(after).toBe(before.replace('enforce: warn # ratchet', 'enforce: enforce # ratchet'));
    expect(setEnforceLevel(spec('enforce: "warn"\n'), 'observe')).toBe(spec('enforce: observe\n'));
  });

  // [claims: capabilities/spec-first-changes#enforce-minimal-edit]
  it('adds the line after the last frontmatter line when none exists, and keeps CRLF', () => {
    expect(setEnforceLevel(spec('status: active\n'), 'warn')).toBe(spec('status: active\nenforce: warn\n'));
    const crlf = spec('status: active\n').replace(/\n/g, '\r\n');
    expect(setEnforceLevel(crlf, 'warn')).toBe(spec('status: active\nenforce: warn\n').replace(/\n/g, '\r\n'));
  });

  // [claims: capabilities/spec-first-changes#enforce-minimal-edit]
  it('returns content without frontmatter, or with frontmatter it cannot edit safely, unchanged', () => {
    expect(setEnforceLevel('# Just a title\n', 'warn')).toBe('# Just a title\n');
    const odd = spec('sources: [a/{b,c}/**]\n');
    expect(setEnforceLevel(odd, 'warn')).toBe(odd);
  });

  // [claims: capabilities/spec-first-changes#enforce-not-hashed]
  it('the edit does not change any claim hash', () => {
    const hash = (content: string) => claimHashOf(parseSpecContent(content, '/r/specs/x.md', '/r/specs'), 'a-claim');
    const before = spec('status: active\n');
    expect(hash(setEnforceLevel(before, 'enforce'))).toBe(hash(before));
    expect(parseFrontmatter(setEnforceLevel(before, 'enforce'))?.meta.enforce).toBe('enforce');
  });
});
