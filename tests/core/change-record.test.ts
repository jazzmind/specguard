import { describe, expect, it } from 'vitest';

import { shortHash } from '../../src/core/approvals.js';
import type { ChangedClaim } from '../../src/core/change-claims.js';
import {
  CHANGE_ID_PATTERN,
  derivePlanApprovals,
  newChangeId,
  parseChangeRecord,
  serializeChangeRecord,
  type ChangeRecord,
} from '../../src/core/change-record.js';
import type { HistoryEntry } from '../../src/core/history.js';

const record = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
  version: 1,
  id: '20261025-free-shipping-a1b2',
  kind: 'feature',
  capabilities: ['cart'],
  why: 'free shipping over 50',
  createdAt: '2026-10-25T10:00:00.000Z',
  createdBy: 'Ada',
  baseRef: 'origin/main',
  startSha: 'a'.repeat(40),
  branch: 'free-shipping',
  plans: [],
  ...over,
});

const plan = (over: Partial<HistoryEntry> & { id: string }): HistoryEntry => ({
  date: '2026-10-25', kind: 'plan', author: 'Grace', affects: ['cart'], file: `/x/${over.id}.md`, body: '', ...over,
});

const HASH = (n: number): string => String(n).repeat(64).slice(0, 64);

const claim = (ref: string, change: ChangedClaim['change'], over: Partial<ChangedClaim> = {}): ChangedClaim => ({
  ref, capability: 'cart', change, ...(change === 'removed' ? { baseHash: HASH(9) } : { hash: HASH(1) }), ...over,
});

describe('change ids [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-ids-and-records]
  it('newChangeId is date-slug-hex and unique per random', () => {
    const date = new Date('2026-10-25T23:59:00Z');
    const a = newChangeId(date, 'Free shipping over $50!', () => 'a1b2');
    const b = newChangeId(date, 'Free shipping over $50!', () => 'C3D4');
    expect(a).toBe('20261025-free-shipping-over-50-a1b2');
    expect(b).toBe('20261025-free-shipping-over-50-c3d4');
    expect(a).not.toBe(b);
    expect(CHANGE_ID_PATTERN.test(a)).toBe(true);
  });

  // [claims: capabilities/spec-first-changes#change-ids-and-records]
  it('newChangeId keeps the slug short and never empty, and always matches the id pattern', () => {
    const long = newChangeId(new Date('2026-01-02T00:00:00Z'), 'x'.repeat(200), () => '0000');
    expect(long.length).toBeLessThanOrEqual(8 + 1 + 40 + 1 + 4);
    for (const source of ['', '   ', '!!!', 'ünïcode only ✓', 'a--b__c', '-lead and trail-']) {
      expect(CHANGE_ID_PATTERN.test(newChangeId(new Date('2026-01-02T00:00:00Z'), source, () => 'abcd')), source).toBe(true);
    }
    expect(newChangeId(new Date('2026-01-02T00:00:00Z'), '', () => 'abcd')).toBe('20260102-change-abcd');
  });

  // [claims: capabilities/spec-first-changes#change-ids-and-records]
  it('newChangeId refuses a random that is not 4 hex characters and an invalid date', () => {
    for (const bad of ['', 'abc', 'abcde', 'zzzz', '../x']) {
      expect(() => newChangeId(new Date('2026-01-02T00:00:00Z'), 'x', () => bad), bad).toThrow(/4 hex/);
    }
    expect(() => newChangeId(new Date('nope'), 'x', () => 'abcd')).toThrow(/invalid date/);
  });
});

describe('change record files [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-ids-and-records]
  it('parse rejects unknown kind, empty capabilities, bad id, bad JSON, with the file name in the error', () => {
    const cases: Array<[string, unknown]> = [
      ['kind', { ...record(), kind: 'hotfix' }],
      ['capabilities', { ...record(), capabilities: [] }],
      ['id', { ...record(), id: '../../etc/passwd' }],
      ['version', { ...record(), version: 2 }],
      ['plans', { ...record(), plans: undefined }],
    ];
    for (const [what, value] of cases) {
      const out = parseChangeRecord(JSON.stringify(value), 'a.json');
      expect(out.ok, what).toBe(false);
      if (!out.ok) {
        expect(out.error).toContain('a.json');
        expect(out.error).toContain(what);
      }
    }
    const bad = parseChangeRecord('{nope', 'b.json');
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toContain('b.json');
  });

  // [claims: capabilities/spec-first-changes#change-ids-and-records]
  it('serialize is stable: fixed key order, 2-space JSON, trailing newline, same input same bytes', () => {
    const scrambled = JSON.parse(JSON.stringify({ plans: ['p'], branch: 'b', kind: 'feature', id: '20261025-x-0000', version: 1, capabilities: ['cart'], baseRef: 'main', createdBy: 'Ada', createdAt: 't' })) as ChangeRecord;
    const text = serializeChangeRecord(scrambled);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(['version', 'id', 'kind', 'capabilities', 'createdAt', 'createdBy', 'baseRef', 'branch', 'plans']);
    expect(text.split('\n')[1]).toBe('  "version": 1,');
    expect(serializeChangeRecord(scrambled)).toBe(text);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(scrambled).reverse()))) as ChangeRecord;
    expect(serializeChangeRecord(reordered)).toBe(text);
  });

  // [claims: capabilities/spec-first-changes#change-ids-and-records]
  it('serialize then parse round trips, drops undefined fields, and keeps unknown fields in sorted order', () => {
    const r = { ...record({ why: undefined }), zeta: { b: 2, a: 1 }, alpha: [1] } as unknown as ChangeRecord;
    const text = serializeChangeRecord(r);
    expect(text).not.toContain('why');
    expect(Object.keys(JSON.parse(text)).slice(-2)).toEqual(['alpha', 'zeta']);
    expect(Object.keys(JSON.parse(text).zeta)).toEqual(['a', 'b']);
    const back = parseChangeRecord(text, 'r.json');
    expect(back.ok).toBe(true);
    if (back.ok) expect(serializeChangeRecord(back.record)).toBe(text);
  });

  // [claims: capabilities/spec-first-changes#parallel-and-abandoned]
  it('closed record parse keeps closed fields in order, and a spike conversion trail', () => {
    const closed = record({
      kind: 'feature',
      convertedFrom: { kind: 'spike', at: '2026-10-25T09:00:00.000Z', by: 'Ada' },
      closed: { reason: 'abandoned', note: 'superseded', by: 'Ada', at: '2026-10-26T09:00:00.000Z' },
    });
    const text = serializeChangeRecord(closed);
    const back = parseChangeRecord(text, 'c.json');
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.record.closed).toEqual({ at: '2026-10-26T09:00:00.000Z', by: 'Ada', reason: 'abandoned', note: 'superseded' });
    expect(back.record.convertedFrom?.kind).toBe('spike');
    expect(Object.keys(JSON.parse(text).closed)).toEqual(['at', 'by', 'reason', 'note']);
    expect(parseChangeRecord(JSON.stringify({ ...closed, closed: { at: 'x', by: 'y', reason: 'merged' } }), 'c.json').ok).toBe(false);
  });

  // [claims: capabilities/spec-first-changes#parallel-and-abandoned]
  it('two changes started the same day on the same text never share a file name when their random parts differ', () => {
    const date = new Date('2026-10-25T10:00:00Z');
    const ids = new Set(['a1b2', 'a1b3', '0000', 'ffff'].map((r) => newChangeId(date, 'free shipping', () => r)));
    expect(ids.size).toBe(4);
  });
});

describe('plan-derived approvals [spec-first-changes]', () => {
  const changed: ChangedClaim[] = [
    claim('capabilities/cart#fee', 'modified', { parts: ['text'] }),
    claim('capabilities/cart#fee/ny-free', 'modified'),
    claim('capabilities/cart#total', 'added'),
    claim('capabilities/cart#old', 'removed'),
    claim('capabilities/other#thing', 'added', { capability: 'other' }),
  ];

  // [claims: capabilities/spec-first-changes#plan-approvals]
  it('derivePlanApprovals covers changed refs only, not removed ones, and not other capabilities', () => {
    const out = derivePlanApprovals(record({ plans: ['2026-10-25-free-shipping'] }), [plan({ id: '2026-10-25-free-shipping' })], changed);
    expect(out.map((a) => a.claim)).toEqual(['capabilities/cart#fee', 'capabilities/cart#fee/ny-free', 'capabilities/cart#total']);
    expect(out[0]).toEqual({
      claim: 'capabilities/cart#fee', hash: shortHash(HASH(1)), method: 'plan', by: 'Grace', date: '2026-10-25', entry: '2026-10-25-free-shipping',
    });
    expect(out.every((a) => a.hash.length === 16)).toBe(true);
  });

  // [claims: capabilities/spec-first-changes#plan-approvals]
  it('derivePlanApprovals gives nothing when the change links no plan or none is supplied', () => {
    expect(derivePlanApprovals(record({ plans: [] }), [plan({ id: 'p' })], changed)).toEqual([]);
    expect(derivePlanApprovals(record({ plans: ['p'] }), [], changed)).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#plan-approvals]
  it('derivePlanApprovals uses the newest supplied plan, one approval per ref, and tolerates an author-less plan', () => {
    const plans = [
      plan({ id: '2026-10-24-old', date: '2026-10-24', author: 'Old' }),
      plan({ id: '2026-10-25-b', author: undefined }),
      plan({ id: '2026-10-25-a', author: 'Mid' }),
    ];
    const out = derivePlanApprovals(record({ plans: ['2026-10-24-old', '2026-10-25-a', '2026-10-25-b'] }), plans, changed.slice(0, 1));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ entry: '2026-10-25-b', by: 'unknown' });
  });

  // [claims: capabilities/spec-first-changes#plan-approvals]
  it('derivePlanApprovals skips a ref with no current hash and several capabilities share one record', () => {
    const out = derivePlanApprovals(
      record({ capabilities: ['cart', 'other'], plans: ['p'] }),
      [plan({ id: 'p' })],
      [claim('capabilities/cart#x', 'added', { hash: undefined }), claim('capabilities/other#thing', 'added', { capability: 'other' })],
    );
    expect(out.map((a) => a.claim)).toEqual(['capabilities/other#thing']);
  });
});
