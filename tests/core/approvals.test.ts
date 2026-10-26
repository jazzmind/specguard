import { describe, expect, it } from 'vitest';

import { approvalsFrom, formatApproved, indexApprovals, parseApproved, shortHash, type Approval } from '../../src/core/approvals.js';
import { parseHistoryEntry, renderHistoryEntry, type HistoryEntry } from '../../src/core/history.js';

const HASH = 'ab12'.repeat(16);
const REF = 'capabilities/cart#total-sums-prices';

function entry(over: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return { date: '2026-10-20', kind: 'approval', affects: [], file: `/x/${over.id}.md`, body: '', method: 'command', author: 'Ada', approves: [formatApproved(REF, HASH)], ...over };
}

describe('approval refs [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approval-entry-record]
  it('formats and parses ref@hash round trip', () => {
    const s = formatApproved(REF, HASH);
    expect(s).toBe(`${REF}@${HASH.slice(0, 16)}`);
    expect(shortHash(HASH)).toHaveLength(16);
    expect(parseApproved(s)).toEqual({ ref: REF, hash: HASH.slice(0, 16) });
  });

  // [claims: capabilities/intent-approval#approval-entry-record]
  it('rejects malformed refs and hashes', () => {
    for (const bad of ['', 'nohash', `${REF}@`, `${REF}@xyz`, `${REF}@${'g'.repeat(16)}`, `${REF}@abc`, '@abcdabcdabcdabcd', `nohashmark@${'a'.repeat(16)}`, `repo:${REF}@${'a'.repeat(16)}`]) {
      expect(parseApproved(bad), bad).toBeNull();
    }
  });

  // [claims: capabilities/intent-approval#approval-entry-record]
  it('survives a render/parse round trip of a history entry', () => {
    const text = renderHistoryEntry(
      { id: '2026-10-20-approval', date: '2026-10-20', kind: 'approval', author: 'Ada', affects: ['cart'], approves: [formatApproved(REF, HASH)], method: 'as-built' },
      '# Approval\n\nbody',
    );
    const parsed = parseHistoryEntry(text, '/x.md')!;
    expect(parsed.kind).toBe('approval');
    expect(parsed.method).toBe('as-built');
    expect(parsed.approves).toEqual([formatApproved(REF, HASH)]);
    const [a] = approvalsFrom([parsed]);
    expect(a).toMatchObject({ claim: REF, hash: HASH.slice(0, 16), method: 'as-built', by: 'Ada', date: '2026-10-20', entry: '2026-10-20-approval' });
  });

  // [claims: capabilities/intent-approval#approval-entry-record]
  it('leaves entries without approval fields as they were', () => {
    const text = renderHistoryEntry({ id: '2026-10-20-x', date: '2026-10-20', kind: 'decision', affects: [] }, 'body');
    expect(text).not.toContain('approves');
    expect(text).not.toContain('method');
  });
});

describe('approvalsFrom [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approval-entry-record]
  it('reads only approval entries and skips malformed refs and unknown methods', () => {
    const list = approvalsFrom([
      entry({ id: 'a' }),
      entry({ id: 'b', kind: 'decision' }),
      entry({ id: 'c', method: 'telepathy' }),
      entry({ id: 'd', method: undefined }),
      entry({ id: 'e', approves: ['garbage', formatApproved('other#ok', HASH)] }),
    ]);
    expect(list.map((a) => `${a.entry}:${a.claim}`)).toEqual([`a:${REF}`, 'e:other#ok']);
  });
});

describe('indexApprovals [intent-approval]', () => {
  const approval = (entryId: string, date: string, hash = HASH): Approval => ({ claim: REF, hash: shortHash(hash), method: 'command', by: 'Ada', date, entry: entryId });

  // [claims: capabilities/intent-approval#approved-while-hash-matches]
  it('matches only while the hash is the same', () => {
    const idx = indexApprovals([approval('a', '2026-10-20')]);
    expect(idx.find(REF, HASH)?.entry).toBe('a');
    expect(idx.find(REF, HASH + 'extra')?.entry).toBe('a'); // only the 16-char prefix is stored
    expect(idx.find('capabilities/cart#other', HASH)).toBeUndefined();
  });

  // [claims: capabilities/intent-approval#approved-while-hash-matches]
  it('editing a claim (new hash) makes it unapproved', () => {
    const idx = indexApprovals([approval('a', '2026-10-20')]);
    expect(idx.find(REF, 'ff'.repeat(32))).toBeUndefined();
  });

  // [claims: capabilities/intent-approval#approved-while-hash-matches]
  it('the newest matching approval wins, ignoring newer ones for other wordings', () => {
    const other = 'cd'.repeat(32);
    const idx = indexApprovals([
      approval('2026-10-18-first', '2026-10-18'),
      approval('2026-10-20-b', '2026-10-20'),
      approval('2026-10-20-a', '2026-10-20'),
      approval('2026-10-25-reworded', '2026-10-25', other),
    ]);
    expect(idx.find(REF, HASH)?.entry).toBe('2026-10-20-b');
    expect(idx.find(REF, other)?.entry).toBe('2026-10-25-reworded');
  });
});
