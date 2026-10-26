import { describe, expect, it } from 'vitest';

import { diffClaims, type ChangedClaim } from '../../src/core/change-claims.js';
import { claimHashOf } from '../../src/core/claim-hash.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import type { ParsedSpec } from '../../src/core/types.js';

const FEE_TABLE = (rows: string[][]): string =>
  ['', '  | id | state | total |', '  |----|-------|-------|', ...rows.map((r) => `  | ${r.join(' | ')} |`)].join('\n');

interface Opts {
  value?: string;
  front?: string;
  /** Raw requirements section, instead of `claims`. */
  raw?: string;
}

function spec(claims: Array<[id: string, text: string, table?: string]> = [], opts: Opts = {}): ParsedSpec {
  const requirements = opts.raw ?? claims.map(([id, text, table]) => `- [ ] ${text} <!-- claim: ${id} -->${table ?? ''}`).join('\n');
  const front = opts.front ?? 'id: cart\nkind: capability';
  const text = `---\n${front}\n---\n# Cart\n\n## Problem & Value\n\n${opts.value ?? 'Shoppers pay a fair total.'}\n\n## Requirements\n\n${requirements}\n\n## Scenarios\n`;
  return parseSpecContent(text, '/r/specs/capabilities/cart.md', '/r/specs');
}

const one = (base: ParsedSpec | undefined, now: ParsedSpec | undefined, cap = 'cart'): ChangedClaim[] =>
  diffClaims(new Map([[cap, base]]), new Map([[cap, now]]));

const summary = (list: ChangedClaim[]): string[] => list.map((c) => `${c.change} ${c.ref}${c.parts ? ` [${c.parts.join(',')}]` : ''}`);

const BASE_ROWS = [['ny-small', 'NY', '49.99'], ['ny-free', 'NY', '50.00']];

describe('changed claims [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#changed-claims]
  it('added spec file -> all claims added', () => {
    const now = spec([['fee', 'The fee depends on the state.'], ['total', 'The total sums prices.']]);
    const out = one(undefined, now);
    expect(summary(out)).toEqual(['added capabilities/cart#fee', 'added capabilities/cart#total']);
    expect(out[0]).toMatchObject({ capability: 'cart', text: 'The fee depends on the state.', hash: claimHashOf(now, 'fee') });
    expect(out[0].baseHash).toBeUndefined();
  });

  // [claims: capabilities/spec-first-changes#changed-claims]
  it('deleted spec file -> all claims removed with base text and hash', () => {
    const base = spec([['fee', 'The fee depends on the state.']]);
    const out = one(base, undefined);
    expect(summary(out)).toEqual(['removed capabilities/cart#fee']);
    expect(out[0]).toMatchObject({ baseText: 'The fee depends on the state.', baseHash: claimHashOf(base, 'fee') });
    expect(out[0].hash).toBeUndefined();
    expect(out[0].text).toBeUndefined();
  });

  // [claims: capabilities/spec-first-changes#changed-claims]
  it('claim text edit -> modified(text) with both texts and hashes', () => {
    const base = spec([['fee', 'The fee depends on the state.'], ['total', 'The total sums prices.']]);
    const now = spec([['fee', 'The fee depends on the state and the total.'], ['total', 'The total sums prices.']]);
    const out = one(base, now);
    expect(summary(out)).toEqual(['modified capabilities/cart#fee [text]']);
    expect(out[0]).toMatchObject({
      text: 'The fee depends on the state and the total.',
      baseText: 'The fee depends on the state.',
      hash: claimHashOf(now, 'fee'),
      baseHash: claimHashOf(base, 'fee'),
    });
  });

  // [claims: capabilities/spec-first-changes#changed-claims]
  it('whitespace-only edits and frontmatter-only edits -> no changed claims', () => {
    const claims: Array<[string, string]> = [['fee', 'The fee depends on the state.']];
    const base = spec(claims);
    expect(one(base, spec(claims, { front: 'id: cart\nkind: capability\nhistory: [2026-10-25-x]' }))).toEqual([]);
    expect(one(base, spec([['fee', 'The fee   depends on\n  the state.']]))).toEqual([]);
    expect(one(base, base)).toEqual([]);
    expect(one(undefined, undefined)).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#changed-claims]
  it('a changed Problem & Value moves the meaning of every claim, so each is modified', () => {
    const claims: Array<[string, string]> = [['fee', 'The fee depends on the state.'], ['total', 'The total sums prices.']];
    const out = one(spec(claims), spec(claims, { value: 'Shoppers pay a fair total, including tax.' }));
    expect(summary(out)).toEqual(['modified capabilities/cart#fee [text]', 'modified capabilities/cart#total [text]']);
  });

  // [claims: capabilities/spec-first-changes#changed-claims]
  it('claim removed -> removed with baseText, others untouched', () => {
    const base = spec([['fee', 'The fee depends on the state.'], ['total', 'The total sums prices.']]);
    const now = spec([['total', 'The total sums prices.']]);
    const out = one(base, now);
    expect(summary(out)).toEqual(['removed capabilities/cart#fee']);
    expect(out[0].baseText).toBe('The fee depends on the state.');
  });

  // [claims: capabilities/spec-first-changes#changed-claims]
  it('v1 specs, which have no claim hash, are compared by normalized text', () => {
    const v1 = (text: string): ParsedSpec =>
      parseSpecContent(`<!-- spec: cart -->\n# Cart\n\n## Overview\n\nx\n\n## Acceptance Criteria\n\n- [ ] ${text} <!-- claim: fee -->\n`, '/r/specs/cart.md', '/r/specs');
    const base = v1('The fee depends on the state.');
    expect(one(base, v1('The fee  depends on the state.'))).toEqual([]);
    const out = one(base, v1('The fee depends on the state and total.'));
    expect(summary(out)).toEqual(['modified cart#fee [text]']);
    expect(out[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // [claims: capabilities/spec-first-changes#changed-claims]
  it('lists capabilities in sorted order and ignores a claim with no id', () => {
    const cartBase = spec([['fee', 'Fee.']]);
    const cartNow = spec([['fee', 'Fee changed.']]);
    const anon = spec([], { raw: '- [ ] A bullet with no anchor.' });
    const out = diffClaims(
      new Map<string, ParsedSpec | undefined>([['cart', cartBase], ['alpha', anon]]),
      new Map<string, ParsedSpec | undefined>([['cart', cartNow], ['alpha', anon]]),
    );
    expect(out.map((c) => c.capability)).toEqual(['cart']);
    const both = diffClaims(new Map([['zeta', undefined], ['alpha', undefined]]), new Map([['zeta', cartNow], ['alpha', cartNow]]));
    expect([...new Set(both.map((c) => c.capability))]).toEqual(['alpha', 'zeta']);
  });
});

describe('changed example rows [spec-first-changes]', () => {
  const FEE = 'The fee depends on the state.';

  // [claims: capabilities/spec-first-changes#changed-example-rows]
  it('row added -> row added + claim modified(rows-added)', () => {
    const base = spec([['fee', FEE, FEE_TABLE(BASE_ROWS)]]);
    const now = spec([['fee', FEE, FEE_TABLE([...BASE_ROWS, ['ak-any', 'AK', '500.00']])]]);
    const out = one(base, now);
    expect(summary(out)).toEqual(['modified capabilities/cart#fee [rows-added]', 'added capabilities/cart#fee/ak-any']);
    expect(out[1].hash).toBe(now.claims[0].examples!.rows[2].hash);
    expect(out[1].text).toContain('state: AK');
  });

  // [claims: capabilities/spec-first-changes#changed-example-rows]
  it('row cells changed -> row modified + claim modified(rows-changed)', () => {
    const base = spec([['fee', FEE, FEE_TABLE(BASE_ROWS)]]);
    const now = spec([['fee', FEE, FEE_TABLE([['ny-small', 'NY', '49.99'], ['ny-free', 'NY', '49.00']])]]);
    const out = one(base, now);
    expect(summary(out)).toEqual(['modified capabilities/cart#fee [rows-changed]', 'modified capabilities/cart#fee/ny-free']);
    expect(out[1]).toMatchObject({ baseText: 'id: ny-free; state: NY; total: 50.00', text: 'id: ny-free; state: NY; total: 49.00' });
    expect(out[1].baseHash).toBe(base.claims[0].examples!.rows[1].hash);
  });

  // [claims: capabilities/spec-first-changes#changed-example-rows]
  it('row removed -> row removed + claim modified(rows-removed)', () => {
    const base = spec([['fee', FEE, FEE_TABLE(BASE_ROWS)]]);
    const now = spec([['fee', FEE, FEE_TABLE([BASE_ROWS[0]])]]);
    const out = one(base, now);
    expect(summary(out)).toEqual(['modified capabilities/cart#fee [rows-removed]', 'removed capabilities/cart#fee/ny-free']);
    expect(out[1].baseText).toContain('total: 50.00');
    expect(out[1].hash).toBeUndefined();
  });

  // [claims: capabilities/spec-first-changes#changed-example-rows]
  it('claim text edit -> modified(text), rows not listed even though every row hash cascades', () => {
    const base = spec([['fee', FEE, FEE_TABLE(BASE_ROWS)]]);
    const now = spec([['fee', 'The fee depends on the state and the total.', FEE_TABLE(BASE_ROWS)]]);
    expect(base.claims[0].examples!.rows[0].hash).not.toBe(now.claims[0].examples!.rows[0].hash);
    expect(summary(one(base, now))).toEqual(['modified capabilities/cart#fee [text]']);
  });

  // [claims: capabilities/spec-first-changes#changed-example-rows]
  it('text edit plus a changed cell -> claim [text, rows-changed] and only the changed row', () => {
    const base = spec([['fee', FEE, FEE_TABLE(BASE_ROWS)]]);
    const now = spec([['fee', `${FEE} Always.`, FEE_TABLE([['ny-small', 'NY', '49.99'], ['ny-free', 'NY', '49.00']])]]);
    expect(summary(one(base, now))).toEqual(['modified capabilities/cart#fee [text,rows-changed]', 'modified capabilities/cart#fee/ny-free']);
  });

  // [claims: capabilities/spec-first-changes#changed-example-rows]
  it('column order and spacing in a table are not a change; an added or removed claim stands for its rows', () => {
    const base = spec([['fee', FEE, FEE_TABLE(BASE_ROWS)]]);
    const reordered = ['', '  | total | id | state |', '  |---|---|---|', '  | 49.99 | ny-small | NY |', '  | 50.00 | ny-free | NY |'].join('\n');
    expect(one(base, spec([['fee', FEE, reordered]]))).toEqual([]);
    expect(summary(one(undefined, base))).toEqual(['added capabilities/cart#fee']);
    expect(summary(one(base, undefined))).toEqual(['removed capabilities/cart#fee']);
  });
});
