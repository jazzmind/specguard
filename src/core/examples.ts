/**
 * Examples: where behaviour that varies is declared.
 *
 * A markdown table directly under a claim bullet lists concrete cases of that claim:
 *
 *   - [ ] The shipping fee depends on the destination state. <!-- claim: shipping-fee -->
 *
 *     | id       | state | fee  |
 *     |----------|-------|------|
 *     | ny-small | NY    | 5.00 |
 *
 * Each row has an id and a hash, and a test may name it in its claim tag (`cap#claim/ny-small`).
 * The table never enters the claim text, so it never changes the claim hash. All functions are pure.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import { createHash } from 'node:crypto';

export interface ClaimExample {
  id: string;
  /** Lower-cased header -> normalized cell, including the id column. */
  cells: Record<string, string>;
  /** 1-based line in the spec file. */
  line: number;
  /** `exampleHashOf(...)`. */
  hash: string;
}

export type ExampleIssueCode =
  | 'EX-NO-SEPARATOR'
  | 'EX-NO-ID-COLUMN'
  | 'EX-BAD-ID'
  | 'EX-DUP-ID'
  | 'EX-CELL-COUNT'
  | 'EX-EMPTY'
  | 'EX-ORPHAN-TABLE'
  | 'EX-MULTIPLE-TABLES'
  | 'EX-CLAIM-NO-ID';

export interface ExampleIssue {
  code: ExampleIssueCode;
  severity: 'error' | 'warn';
  /** 1-based line in the spec file. */
  line: number;
  claimId?: string;
  message: string;
}

export interface ExampleTable {
  claimId: string;
  headers: string[];
  idColumn: string;
  rows: ClaimExample[];
}

export interface ParsedExamples {
  /** Claim id -> its table. A table with structural problems still lists the rows that were readable. */
  tables: Map<string, ExampleTable>;
  issues: ExampleIssue[];
}

const WARNINGS: ReadonlySet<ExampleIssueCode> = new Set(['EX-ORPHAN-TABLE', 'EX-EMPTY']);
const ROW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BULLET = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/;
const CLAIM_ANCHOR = /<!--\s*claim:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->/i;
const SEPARATOR_CELL = /^:?-+:?$/;
const FENCE = /^\s*(?:```|~~~)/;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** True for a line that belongs to a table: its trimmed text starts with `|`. */
export function isTableLine(line: string): boolean {
  return line.trim().startsWith('|');
}

/** Split one table line into trimmed, whitespace-collapsed cells. `\|` is a literal pipe. */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(collapse(current));
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(collapse(current));
  return cells;
}

/**
 * Hash of one example row: `sha256(claimHash + "\n---\n" + pairs)`, where `pairs` is `header=cell` per column,
 * sorted and joined with newlines. It covers the claim hash, so rewording the claim changes every row hash,
 * and it ignores column order and whitespace. It adds a hash and changes none that exist.
 */
export function exampleHashOf(claimHash: string, headers: string[], cells: string[]): string {
  const pairs = headers
    .map((header, i) => [collapse(header).toLowerCase(), collapse(cells[i] ?? '')] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([header, cell]) => `${header}=${cell}`);
  return createHash('sha256').update(`${claimHash}\n---\n${pairs.join('\n')}`).digest('hex');
}

interface TableRun {
  /** Index of the first line of the run within the section. */
  start: number;
  lines: string[];
}

interface ClaimBlock {
  id?: string;
  /** True while only blank lines and continuation lines lie between the bullet and here. */
  attachable: boolean;
  runs: TableRun[];
}

/**
 * Read the example tables of a Requirements section.
 *
 * `section` is the raw section body and `firstLine` the 1-based file line of its first line. A table belongs to
 * the nearest preceding claim bullet when only blank lines and that bullet's continuation lines lie between them.
 * `claimHash` gives the hash of a claim id (undefined for an unknown id), which every row hash is built on.
 */
export function parseExampleTables(
  section: string,
  firstLine: number,
  claimHash: (claimId: string) => string | undefined,
): ParsedExamples {
  const tables = new Map<string, ExampleTable>();
  const issues: ExampleIssue[] = [];
  const issue = (code: ExampleIssueCode, line: number, message: string, claimId?: string): void => {
    const found: ExampleIssue = { code, severity: WARNINGS.has(code) ? 'warn' : 'error', line, message };
    if (claimId) found.claimId = claimId;
    issues.push(found);
  };

  const lines = section.split(/\r?\n/);
  const blocks: ClaimBlock[] = [];
  const orphans: TableRun[] = [];
  let current: ClaimBlock | undefined;
  let run: TableRun | undefined;
  let fenced = false;

  const closeRun = (): void => {
    if (!run) return;
    if (current?.attachable) current.runs.push(run);
    else orphans.push(run);
    run = undefined;
  };

  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      closeRun();
      fenced = !fenced;
      if (current) current.attachable = false;
      return;
    }
    if (fenced) return;
    if (isTableLine(line)) {
      if (run) run.lines.push(line);
      else run = { start: index, lines: [line] };
      return;
    }
    closeRun();
    const bullet = line.match(BULLET);
    if (bullet) {
      const anchor = bullet[1].match(CLAIM_ANCHOR);
      // Mirror `parseClaims`: a bullet with no text and no anchor is not a claim.
      if (!bullet[1].replace(CLAIM_ANCHOR, '').trim() && !anchor) {
        if (current) current.attachable = false;
        return;
      }
      current = { id: anchor?.[1].toLowerCase(), attachable: true, runs: [] };
      blocks.push(current);
    } else if (current && line.trim() && /^\s{2,}\S/.test(line)) {
      // An indented line continues the claim, and an anchor may sit on it.
      const anchor = line.match(CLAIM_ANCHOR);
      if (anchor && !current.id) current.id = anchor[1].toLowerCase();
    } else if (current && line.trim()) {
      current.attachable = false;
    }
  });
  closeRun();

  for (const orphan of orphans) {
    issue('EX-ORPHAN-TABLE', firstLine + orphan.start, 'A table must sit directly under the claim bullet it gives examples for.');
  }
  for (const block of blocks) {
    block.runs.forEach((tableRun, n) => {
      const line = firstLine + tableRun.start;
      if (!block.id) {
        issue('EX-CLAIM-NO-ID', line, 'The claim this table belongs to has no id; add a claim anchor (`specguard claims assign`).');
        return;
      }
      if (n > 0) {
        issue('EX-MULTIPLE-TABLES', line, `Claim '${block.id}' has more than one table; use one table per claim.`, block.id);
        return;
      }
      const table = readTable(tableRun, firstLine, block.id, claimHash(block.id) ?? '', issue);
      if (table) tables.set(block.id, table);
    });
  }
  issues.sort((a, b) => a.line - b.line);
  return { tables, issues };
}

function readTable(
  tableRun: TableRun,
  firstLine: number,
  claimId: string,
  claimHash: string,
  issue: (code: ExampleIssueCode, line: number, message: string, claimId?: string) => void,
): ExampleTable | undefined {
  const headerLine = firstLine + tableRun.start;
  const separator = tableRun.lines[1] === undefined ? undefined : splitTableRow(tableRun.lines[1]);
  if (!separator || !separator.every((cell) => SEPARATOR_CELL.test(cell))) {
    issue('EX-NO-SEPARATOR', headerLine, `The table under '${claimId}' needs a header row followed by a separator row such as |---|---|.`, claimId);
    return undefined;
  }
  const headers = splitTableRow(tableRun.lines[0]).map((header) => header.toLowerCase());
  const idIndex = headers.includes('id') ? headers.indexOf('id') : 0;
  if (headers.length === 0 || !headers[idIndex]) {
    issue('EX-NO-ID-COLUMN', headerLine, `The table under '${claimId}' has no id column: head one column "id" or start with an id column.`, claimId);
    return undefined;
  }
  const table: ExampleTable = { claimId, headers, idColumn: headers[idIndex], rows: [] };
  const seen = new Set<string>();
  const body = tableRun.lines.slice(2);
  if (body.length === 0) issue('EX-EMPTY', headerLine, `The table under '${claimId}' has no rows.`, claimId);
  body.forEach((text, n) => {
    const line = firstLine + tableRun.start + 2 + n;
    const cells = splitTableRow(text);
    if (cells.length !== headers.length) {
      issue('EX-CELL-COUNT', line, `A row under '${claimId}' has ${cells.length} cells but the table has ${headers.length} columns.`, claimId);
      return;
    }
    const id = cells[idIndex];
    if (!ROW_ID.test(id)) {
      issue('EX-BAD-ID', line, `Example id '${id}' under '${claimId}' must be lower-case words joined by hyphens.`, claimId);
      return;
    }
    if (seen.has(id)) {
      issue('EX-DUP-ID', line, `Example id '${id}' appears more than once under '${claimId}'.`, claimId);
      return;
    }
    seen.add(id);
    const row: ClaimExample = { id, cells: {}, line, hash: exampleHashOf(claimHash, headers, cells) };
    headers.forEach((header, i) => {
      row.cells[header] = cells[i];
    });
    table.rows.push(row);
  });
  return table;
}

/** Row ids of `table` that occur in `title` as a delimited token (hyphens count as word characters). */
export function matchingExampleIds(title: string, table: ExampleTable): string[] {
  const found: string[] = [];
  for (const row of table.rows) {
    if (new RegExp(`(?<![a-z0-9-])${row.id}(?![a-z0-9-])`, 'i').test(title)) found.push(row.id);
  }
  return found;
}

/**
 * Parameterized-test matching: the single row id that occurs in `title`, or undefined when none or several do.
 * `ny` never matches inside `ny-small`.
 */
export function matchExampleByTitle(title: string, table: ExampleTable): string | undefined {
  const ids = matchingExampleIds(title, table);
  return ids.length === 1 ? ids[0] : undefined;
}

export interface AmbiguousExampleMatch {
  file: string;
  title: string;
  /** The claim ref the test is tagged with. */
  claim: string;
  ids: string[];
}

/**
 * Attribute parameterized-test rows to example rows. A result row tagged `cap#claim` whose title names exactly
 * one row id of that claim's table also gains `cap#claim/<row>`. Rows whose title names several ids gain nothing
 * and are returned in `ambiguous` for the caller to warn about. `tablesByClaim` is keyed by `specKey#claimId`
 * (with the `repo:` prefix when the tag has one). Row claims are changed in place.
 */
export function attachExampleRows(
  rows: Array<{ file: string; title: string; claims: string[] }>,
  tablesByClaim: Map<string, ExampleTable>,
): { attached: number; ambiguous: AmbiguousExampleMatch[] } {
  let attached = 0;
  const ambiguous: AmbiguousExampleMatch[] = [];
  for (const row of rows) {
    const gained: string[] = [];
    for (const ref of row.claims) {
      const table = tablesByClaim.get(ref);
      if (!table) continue;
      const ids = matchingExampleIds(row.title, table);
      if (ids.length === 1) gained.push(`${ref}/${ids[0]}`);
      else if (ids.length > 1) ambiguous.push({ file: row.file, title: row.title, claim: ref, ids });
    }
    const fresh = gained.filter((ref) => !row.claims.includes(ref));
    if (fresh.length === 0) continue;
    row.claims = [...row.claims, ...fresh];
    attached += fresh.length;
  }
  return { attached, ambiguous };
}
