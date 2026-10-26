import { describe, expect, it } from 'vitest';

import { claimHashOf } from '../../src/core/claim-hash.js';
import { parseClaims } from '../../src/core/claims.js';
import {
  attachExampleRows,
  exampleHashOf,
  matchExampleByTitle,
  parseExampleTables,
  splitTableRow,
  type ExampleTable,
} from '../../src/core/examples.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';

const hashOf = (id: string): string => `hash-of-${id}`;

const TABLE = `  | id        | state | total  | fee   |
  |-----------|-------|--------|-------|
  | ny-small  | NY    | 49.99  | 5.00  |
  | ny-free   | NY    | 50.00  | 0.00  |
  | ak-any    | AK    | 500.00 | 25.00 |`;

function spec(requirements: string, front = 'id: ship\nkind: capability'): ReturnType<typeof parseSpecContent> {
  const text = `---\n${front}\n---\n# Ship\n\n## Problem & Value\n\nFees are fair.\n\n## Requirements\n\n${requirements}\n\n## Scenarios\n`;
  return parseSpecContent(text, '/r/specs/ship.md', '/r/specs');
}

describe('example tables [examples]', () => {
  // [claims: capabilities/spec-authoring#example-tables]
  it('attaches a column-0 table to the preceding claim', () => {
    const out = parseExampleTables(`- [ ] Fee depends on state. <!-- claim: shipping-fee -->\n\n| id | state |\n|---|---|\n| ny | NY |\n`, 1, hashOf);
    expect(out.issues).toEqual([]);
    const table = out.tables.get('shipping-fee');
    expect(table?.headers).toEqual(['id', 'state']);
    expect(table?.rows.map((r) => r.id)).toEqual(['ny']);
    expect(table?.rows[0].cells).toEqual({ id: 'ny', state: 'NY' });
  });

  // [claims: capabilities/spec-authoring#example-tables]
  // [claims: capabilities/spec-authoring#claim-hash-unchanged-by-tables]
  it('attaches an indented table and leaves claim.text unchanged', () => {
    const withTable = spec(`- [ ] Fee depends on state. <!-- claim: shipping-fee -->\n\n${TABLE}`);
    const without = spec('- [ ] Fee depends on state. <!-- claim: shipping-fee -->');
    expect(withTable.claims[0].text).toBe('Fee depends on state.');
    expect(withTable.claims[0].examples?.rows).toHaveLength(3);
    expect(claimHashOf(withTable, 'shipping-fee')).toBe(claimHashOf(without, 'shipping-fee'));
  });

  // [claims: capabilities/spec-authoring#claim-hash-unchanged-by-tables]
  it('parseClaims never takes a table line as continuation text', () => {
    const claims = parseClaims(`- [ ] Fee depends. <!-- claim: a -->\n  continued words\n  | id | x |\n  |---|---|\n  | r1 | 1 |\n- [ ] Next <!-- claim: b -->`);
    expect(claims.map((c) => c.text)).toEqual(['Fee depends. continued words', 'Next']);
  });

  // [claims: capabilities/spec-authoring#example-tables]
  it('takes the id from the column headed id (any case), else the first column', () => {
    const named = parseExampleTables(`- [ ] A <!-- claim: a -->\n\n| State | ID |\n|---|---|\n| NY | ny-row |\n`, 1, hashOf);
    expect(named.tables.get('a')?.idColumn).toBe('id');
    expect(named.tables.get('a')?.rows[0].id).toBe('ny-row');
    const first = parseExampleTables(`- [ ] A <!-- claim: a -->\n\n| case | state |\n|---|---|\n| one | NY |\n`, 1, hashOf);
    expect(first.tables.get('a')?.idColumn).toBe('case');
    expect(first.tables.get('a')?.rows[0].id).toBe('one');
  });

  // [claims: capabilities/spec-authoring#example-table-issues]
  it('reports EX-BAD-ID, EX-DUP-ID, EX-CELL-COUNT, EX-NO-SEPARATOR and EX-EMPTY', () => {
    const bad = parseExampleTables(
      `- [ ] A <!-- claim: a -->\n\n| id | v |\n|---|---|\n| Bad Id | 1 |\n| ok | 1 |\n| ok | 2 |\n| short |\n`,
      10,
      hashOf,
    );
    expect(bad.issues.map((i) => [i.code, i.severity, i.line])).toEqual([
      ['EX-BAD-ID', 'error', 14],
      ['EX-DUP-ID', 'error', 16],
      ['EX-CELL-COUNT', 'error', 17],
    ]);
    expect(bad.tables.get('a')?.rows.map((r) => r.id)).toEqual(['ok']);

    const noSep = parseExampleTables(`- [ ] A <!-- claim: a -->\n\n| id | v |\n| x | 1 |\n`, 1, hashOf);
    expect(noSep.issues.map((i) => i.code)).toEqual(['EX-NO-SEPARATOR']);
    expect(noSep.tables.size).toBe(0);

    const empty = parseExampleTables(`- [ ] A <!-- claim: a -->\n\n| id | v |\n|---|---|\n`, 1, hashOf);
    expect(empty.issues.map((i) => [i.code, i.severity])).toEqual([['EX-EMPTY', 'warn']]);

    const noId = parseExampleTables(`- [ ] A <!-- claim: a -->\n\n|  | v |\n|---|---|\n| x | 1 |\n`, 1, hashOf);
    expect(noId.issues.map((i) => i.code)).toEqual(['EX-NO-ID-COLUMN']);
  });

  // [claims: capabilities/spec-authoring#example-table-issues]
  it('reports a table under a claim without an id as EX-CLAIM-NO-ID', () => {
    const out = parseExampleTables(`- [ ] No anchor here\n\n| id | v |\n|---|---|\n| x | 1 |\n`, 1, hashOf);
    expect(out.issues.map((i) => [i.code, i.severity])).toEqual([['EX-CLAIM-NO-ID', 'error']]);
  });

  // [claims: capabilities/spec-authoring#example-tables]
  it('handles escaped pipes in cells', () => {
    expect(splitTableRow('| a \\| b |  c  |')).toEqual(['a | b', 'c']);
    const out = parseExampleTables(`- [ ] A <!-- claim: a -->\n\n| id | v |\n|---|---|\n| x | 1 \\| 2 |\n`, 1, hashOf);
    expect(out.tables.get('a')?.rows[0].cells.v).toBe('1 | 2');
  });

  // [claims: capabilities/spec-authoring#example-row-hashes]
  it('row hash ignores whitespace and column order and changes with a cell or the claim text', () => {
    const base = exampleHashOf('c1', ['id', 'state'], ['x', 'NY']);
    expect(exampleHashOf('c1', ['state', 'id'], ['NY', 'x'])).toBe(base);
    expect(exampleHashOf('c1', ['ID', ' State '], ['x', ' N  Y '.replace(/ /g, '')])).toBe(base);
    expect(exampleHashOf('c1', ['id', 'state'], ['x', 'NJ'])).not.toBe(base);
    expect(exampleHashOf('c2', ['id', 'state'], ['x', 'NY'])).not.toBe(base);
  });

  // [claims: capabilities/spec-authoring#example-row-hashes]
  it('row hashes in a parsed spec build on the claim hash, so rewording the claim changes them', () => {
    const a = spec(`- [ ] Fee depends on state. <!-- claim: shipping-fee -->\n\n${TABLE}`);
    const b = spec(`- [ ] Fee depends on the state. <!-- claim: shipping-fee -->\n\n${TABLE}`);
    const rowA = a.claims[0].examples?.rows[0];
    expect(rowA?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rowA?.hash).toBe(exampleHashOf(claimHashOf(a, 'shipping-fee') as string, a.claims[0].examples?.headers ?? [], ['ny-small', 'NY', '49.99', '5.00']));
    expect(b.claims[0].examples?.rows[0].hash).not.toBe(rowA?.hash);
  });

  // [claims: capabilities/spec-authoring#example-table-issues]
  it('a table after prose or before the first claim is EX-ORPHAN-TABLE (a warning)', () => {
    const out = parseExampleTables(`| id | v |\n|---|---|\n| x | 1 |\n\n- [ ] A <!-- claim: a -->\n\nSome prose.\n\n| id | v |\n|---|---|\n| y | 2 |\n`, 1, hashOf);
    expect(out.issues.map((i) => [i.code, i.severity, i.line])).toEqual([
      ['EX-ORPHAN-TABLE', 'warn', 1],
      ['EX-ORPHAN-TABLE', 'warn', 9],
    ]);
    expect(out.tables.size).toBe(0);
  });

  // [claims: capabilities/spec-authoring#example-table-issues]
  it('a second table under one claim is EX-MULTIPLE-TABLES', () => {
    const out = parseExampleTables(`- [ ] A <!-- claim: a -->\n\n| id | v |\n|---|---|\n| x | 1 |\n\n| id | v |\n|---|---|\n| y | 2 |\n`, 1, hashOf);
    expect(out.issues.map((i) => [i.code, i.severity, i.claimId])).toEqual([['EX-MULTIPLE-TABLES', 'error', 'a']]);
    expect(out.tables.get('a')?.rows.map((r) => r.id)).toEqual(['x']);
  });

  // [claims: capabilities/spec-authoring#example-tables]
  it('a table follows the continuation lines of its bullet, and a claim anchor may sit on one', () => {
    const out = parseExampleTables(`- [ ] A long claim\n  that continues <!-- claim: a -->\n\n  | id | v |\n  |---|---|\n  | x | 1 |\n`, 1, hashOf);
    expect(out.issues).toEqual([]);
    expect(out.tables.get('a')?.rows).toHaveLength(1);
  });

  // [claims: capabilities/spec-authoring#example-tables]
  it('v1 specs produce no tables and no issues', () => {
    const v1 = parseSpecContent(
      `# Ship\n\n<!-- module: ship / type: api -->\n\n## Acceptance Criteria\n- A <!-- claim: a -->\n\n| id | v |\n|---|---|\n| x | 1 |\n`,
      '/r/specs/ship.md',
      '/r/specs',
    );
    expect(v1.claims[0].examples).toBeUndefined();
    expect(v1.exampleIssues).toEqual([]);
  });

  // [claims: capabilities/spec-authoring#example-tables]
  it('rows report their line in the spec file, frontmatter included', () => {
    const s = spec(`- [ ] Fee <!-- claim: shipping-fee -->\n\n${TABLE}`);
    const lines = s.claims[0].examples?.rows.map((r) => r.line);
    // 4 frontmatter lines, then title, Problem & Value (with text) and Requirements (with the bullet) before the table
    expect(lines).toEqual([17, 18, 19]);
    expect(s.exampleIssues).toEqual([]);
  });
});

describe('example title matching [examples]', () => {
  const table: ExampleTable = {
    claimId: 'shipping-fee',
    headers: ['id'],
    idColumn: 'id',
    rows: ['ny', 'ny-small', 'ak-any'].map((id, n) => ({ id, cells: { id }, line: n + 1, hash: id })),
  };

  // [claims: capabilities/spec-authoring#example-title-matching]
  it('matches a unique id token, never ny inside ny-small, and is undefined when ambiguous or absent', () => {
    expect(matchExampleByTitle('fee for ny-small orders', table)).toBe('ny-small');
    expect(matchExampleByTitle('fee for NY orders', table)).toBe('ny');
    expect(matchExampleByTitle('compare ny and ak-any', table)).toBeUndefined();
    expect(matchExampleByTitle('no row named here', table)).toBeUndefined();
    expect(matchExampleByTitle('xny-small and nyx', table)).toBeUndefined();
  });

  // [claims: capabilities/spec-authoring#example-title-matching]
  it('attachExampleRows adds cap#claim/row only to rows tagged with cap#claim', () => {
    const tables = new Map([['cap#shipping-fee', table]]);
    const rows = [
      { file: 'a.test.ts', title: 'fee ny-small', claims: ['cap#shipping-fee'] },
      { file: 'a.test.ts', title: 'fee ak-any', claims: ['cap#other'] },
      { file: 'a.test.ts', title: 'fee ny-small', claims: [] },
      { file: 'a.test.ts', title: 'ny and ak-any', claims: ['cap#shipping-fee'] },
      { file: 'a.test.ts', title: 'fee ny-small', claims: ['cap#shipping-fee/ny-small'] },
    ];
    const out = attachExampleRows(rows, tables);
    expect(out.attached).toBe(1);
    expect(rows[0].claims).toEqual(['cap#shipping-fee', 'cap#shipping-fee/ny-small']);
    expect(rows[1].claims).toEqual(['cap#other']);
    expect(rows[2].claims).toEqual([]);
    expect(rows[3].claims).toEqual(['cap#shipping-fee']);
    expect(out.ambiguous).toEqual([{ file: 'a.test.ts', title: 'ny and ak-any', claim: 'cap#shipping-fee', ids: ['ny', 'ak-any'] }]);
  });
});
