import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';

import type { ExampleIssue, ExampleTable } from '../../src/core/examples.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import {
  isTestabilityRuleId,
  lintCapability,
  lintClaim,
  resolveTestabilityConfig,
  type ClaimLintInput,
  type TestabilityConfig,
} from '../../src/core/testability.js';
import type { TestLayer } from '../../src/core/test-layers.js';

const table = (ids: string[]): ExampleTable => ({
  claimId: 'c',
  headers: ['id'],
  idColumn: 'id',
  rows: ids.map((id, n) => ({ id, cells: { id }, line: n + 1, hash: id })),
});

function lint(text: string, extra: Partial<ClaimLintInput> = {}, config?: TestabilityConfig) {
  const input: ClaimLintInput = { ref: 'cap#c1', id: 'c1', text, exampleIssues: [], required: [], assurance: 'tested', ...extra };
  return lintClaim(input, resolveTestabilityConfig(config));
}

/** `RULE[match, match]` for every finding, so a row of the example table reads like the design. */
const summary = (text: string, extra: Partial<ClaimLintInput> = {}, config?: TestabilityConfig): string[] =>
  lint(text, extra, config).findings.map((f) => (f.matches.length > 0 ? `${f.rule}[${f.matches.join(', ')}]` : f.rule));

const SHIPPING = 'The shipping fee depends on the destination state and the order total.';
const VALID_TABLE = table(['ny-small', 'ny-free', 'ak-any']);
const dupIssue: ExampleIssue = { code: 'EX-DUP-ID', severity: 'error', line: 9, claimId: 'c1', message: 'dup' };

interface Row {
  n: number;
  text: string;
  extra?: Partial<ClaimLintInput>;
  config?: TestabilityConfig;
  expected: string[];
}

const ROWS: Row[] = [
  { n: 1, text: 'The login page should work properly on mobile.', expected: ['T-HEDGE[should]', 'T-VAGUE[should work, properly]'] },
  { n: 2, text: 'Search results load fast.', expected: ['T-SUBJECTIVE[fast]'] },
  { n: 3, text: 'Search returns the first page within 300 ms at the 95th percentile.', expected: [] },
  { n: 4, text: 'Search is fast (p95 under 300 ms).', expected: [] },
  { n: 5, text: 'Errors are handled.', expected: ['T-NO-OUTCOME', 'T-PASSIVE[are handled]'] },
  { n: 6, text: 'When the gateway returns a 5xx, checkout shows a retry banner and does not charge the card.', expected: [] },
  { n: 7, text: 'The dashboard is user-friendly and intuitive.', expected: ['T-NO-OUTCOME', 'T-VAGUE[user-friendly, intuitive]'] },
  { n: 8, text: 'Supports CSV, JSON, XML, etc.', expected: ['T-NO-OUTCOME', 'T-OPEN-LIST[etc]'] },
  { n: 9, text: 'Admins can create and/or delete users.', expected: ['T-OPEN-LIST[and/or]'] },
  { n: 10, text: '`check` exits 4 when a source file has no owning spec.', expected: [] },
  { n: 11, text: SHIPPING, expected: ['T-NO-OUTCOME', 'T-VARIES-NO-EXAMPLES[depends on]'] },
  { n: 12, text: SHIPPING, extra: { examples: VALID_TABLE }, expected: [] },
  { n: 13, text: SHIPPING, extra: { examples: VALID_TABLE, exampleIssues: [dupIssue] }, expected: ['T-EX-DUP-ID[line 9]'] },
  { n: 14, text: 'TBD: refund rules for partial shipments.', expected: ['T-PLACEHOLDER[TBD]'] },
  { n: 15, text: 'Large uploads are processed in the background.', expected: ['T-PASSIVE[are processed]', 'T-SUBJECTIVE[large]'] },
  { n: 16, text: 'A critical or high severity advisory blocks the merge.', expected: [] },
  {
    n: 17,
    text: 'Status reports X; it exits 4 when Y; it never calls the LLM; it writes no files; an app with no files is not an error.',
    expected: ['T-COMPOUND'],
  },
  {
    n: 18,
    text: 'Checkout copy matches the brand voice guide.',
    extra: { evidence: { kind: 'manual', verifier: '' } },
    expected: ['T-EVIDENCE-VERIFIER'],
  },
  {
    n: 19,
    text: 'The route map draws the selected route.',
    extra: { evidence: { kind: 'agentic', verifier: 'specguard verify' }, required: ['unit', 'functional'] },
    expected: ['T-EVIDENCE-LAYER-CONFLICT[unit]'],
  },
  { n: 20, text: 'The API usually responds within 2 seconds.', expected: ['T-HEDGE[usually]'] },
  { n: 21, text: 'Parses the import file correctly.', expected: ['T-VAGUE[correctly]'] },
  { n: 22, text: 'Returns 401 for an expired token', extra: { id: undefined }, expected: ['T-NO-ANCHOR'] },
  { n: 23, text: 'Reports a file that could not be parsed as a named error.', expected: [] },
  { n: 24, text: 'Uses the fast tier for summaries.', expected: ['T-SUBJECTIVE[fast]'] },
  { n: '24b' as unknown as number, text: 'Uses the fast tier for summaries.', config: { allow: ['fast tier'] }, expected: [] },
  { n: 25, text: 'Writes `etc` files and the "as expected" marker to disk.', expected: [] },
  { n: 26, text: 'Uses the fast-tier model for summaries.', expected: [] },
];

describe('testability lint [testability]', () => {
  // [claims: capabilities/spec-authoring#testability-lint]
  it.each(ROWS)('example claim $n gives exactly the expected findings', ({ text, extra, config, expected }) => {
    expect(summary(text, extra, config)).toEqual(expected);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('severities: errors for the oracle-less rules, warnings for the soft ones', () => {
    const vagueHedge = lint(ROWS[0].text);
    expect(vagueHedge.findings.map((f) => [f.rule, f.severity])).toEqual([['T-HEDGE', 'warn'], ['T-VAGUE', 'error']]);
    expect(vagueHedge.testable).toBe(false);
    expect(lint('Search results load fast.').testable).toBe(true);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('strips code spans, double-quoted literals and URLs before matching', () => {
    expect(summary('Logs `properly` and "correctly" and https://example.com/properly/robust to the file.')).toEqual([]);
    expect(summary('Logs the line properly to the file.')).toEqual(['T-VAGUE[properly]']);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('matches whole tokens only; hyphenated compounds never match their parts', () => {
    expect(summary('Writes the user-friendly-ish report and the fast-tier file.')).toEqual([]);
    expect(summary('Writes the robustness report to disk.')).toEqual([]);
    expect(summary('Writes the robust report to disk.')).toEqual(['T-VAGUE[robust]']);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-VAGUE matches phrases across single spaces and case', () => {
    expect(summary('Shows the result As Expected on the page.')).toEqual(['T-VAGUE[as expected]']);
    expect(summary('Shows the result as   expected on the page.')).toEqual(['T-VAGUE[as expected]']);
    expect(summary('Shows the result as a list when data arrives.')).toEqual([]);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-HEDGE excludes could not, couldn\'t, should not and may', () => {
    expect(summary('Reports a file that could not be read.')).toEqual([]);
    expect(summary("Reports a file that couldn't be read.")).toEqual([]);
    expect(summary('Never writes a file that should not be written.')).toEqual([]);
    expect(summary('An admin may delete users.')).toEqual([]);
    expect(summary('Search might return stale results.')).toEqual(['T-HEDGE[might]']);
    expect(summary('Tries to retry the call, if possible.')).toEqual(['T-HEDGE[tries to, if possible]']);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-SUBJECTIVE is suppressed by a digit in the same segment but not in another segment', () => {
    expect(summary('Search is fast (p95 under 300 ms).')).toEqual([]);
    expect(summary('Search is fast, and returns 300 results.')).toEqual(['T-SUBJECTIVE[fast]']);
    expect(summary('Search returns 300 results; pages load fast.')).toEqual(['T-SUBJECTIVE[fast]']);
    expect(summary('Search is fast (p95, under 300 ms).')).toEqual([]);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-SUBJECTIVE severity exemption for high/low + severity|priority|risk|confidence', () => {
    expect(summary('A high severity finding blocks the merge.')).toEqual([]);
    expect(summary('A low confidence match is skipped.')).toEqual([]);
    expect(summary('A high load blocks the merge.')).toEqual(['T-SUBJECTIVE[high]']);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-NO-OUTCOME is suppressed by an examples table, a code span, a literal, a digit or a negation', () => {
    const bare = 'The dashboard layout feels pleasant overall.';
    expect(summary(bare)).toEqual(['T-NO-OUTCOME']);
    expect(summary(bare, { examples: table(['a']) })).toEqual([]);
    expect(summary('The dashboard layout feels like `x` overall.')).toEqual([]);
    expect(summary('The dashboard layout feels like "x" overall.')).toEqual([]);
    expect(summary('The dashboard layout feels 3 ways overall.')).toEqual([]);
    expect(summary('The dashboard layout never feels odd overall.')).toEqual([]);
    expect(summary("The dashboard layout isn't odd overall.")).toEqual([]);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-COMPOUND counts clauses on ; and sentence ends, ignoring parentheses; respects maxClauses', () => {
    const four = 'Writes a file. Reads a file; deletes a file. Lists a file.';
    expect(summary(four)).toEqual(['T-COMPOUND']);
    expect(summary('Writes a file. Reads a file; deletes a file.')).toEqual([]);
    expect(summary('Writes a file (a; b; c; d; e). Reads a file.')).toEqual([]);
    expect(summary('Writes a file. Reads a file; deletes a file.', {}, { maxClauses: 2 })).toEqual(['T-COMPOUND']);
    expect(summary('Reads v1.2 files e.g. in the folder.')).toEqual([]);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-LONG respects maxWords', () => {
    const long = `Writes ${Array.from({ length: 90 }, () => 'file').join(' ')}.`;
    expect(summary(long)).toEqual(['T-LONG']);
    expect(summary(long, {}, { maxWords: 100 })).toEqual([]);
    expect(summary('Writes five small files to disk now.', {}, { maxWords: 5 })).toEqual(['T-LONG', 'T-SUBJECTIVE[small]']);
  });

  // [claims: capabilities/spec-authoring#testability-config]
  it('allow removes terms and multi-word phrases; deny adds T-DENY errors', () => {
    expect(summary('Search returns robust and quick pages.', {}, { allow: ['robust'] })).toEqual(['T-SUBJECTIVE[quick]']);
    expect(summary('Returns as expected data.', {}, { allow: ['as expected'] })).toEqual([]);
    const denied = lint('Search handles errors and returns a banner.', {}, { deny: ['handles'] });
    expect(denied.findings.map((f) => [f.rule, f.severity, f.matches])).toEqual([['T-DENY', 'error', ['handles']]]);
    expect(denied.testable).toBe(false);
  });

  // [claims: capabilities/spec-authoring#testability-config]
  it('rules override can raise warn to error and turn a rule off; unknown rule id throws', () => {
    const raised = lint('Search results load fast.', {}, { rules: { 'T-SUBJECTIVE': 'error' } });
    expect(raised.findings[0].severity).toBe('error');
    expect(raised.testable).toBe(false);
    expect(summary('Search results load fast.', {}, { rules: { 'T-SUBJECTIVE': 'off' } })).toEqual([]);
    expect(summary('Writes e.g. a file.')).toEqual([]);
    expect(summary('Writes e.g. a file.', {}, { rules: { 'T-SUCH-AS': 'warn' } })).toEqual(['T-SUCH-AS[e g]']);
    expect(() => resolveTestabilityConfig({ rules: { 'T-NOPE': 'warn' } as never })).toThrow(/unknown rule/);
    expect(() => resolveTestabilityConfig({ waive: { 'cap#c1': ['T-NOPE' as never] } })).toThrow(/unknown rule/);
    expect(isTestabilityRuleId('T-EX-DUP-ID')).toBe(true);
    expect(isTestabilityRuleId('T-EX-NOPE')).toBe(false);
  });

  // [claims: capabilities/spec-authoring#testability-config]
  it('waive downgrades error to warn for the named claim only and marks waived', () => {
    const config: TestabilityConfig = { waive: { 'cap#c1': ['T-VAGUE'] } };
    const waived = lint('Parses the import file correctly.', {}, config);
    expect(waived.findings).toMatchObject([{ rule: 'T-VAGUE', severity: 'warn', waived: true }]);
    expect(waived.testable).toBe(true);
    const other = lint('Parses the import file correctly.', { ref: 'cap#c2', id: 'c2' }, config);
    expect(other.findings).toMatchObject([{ rule: 'T-VAGUE', severity: 'error' }]);
    expect(other.testable).toBe(false);
    // a waiver never turns a rule off and does not touch warnings
    const soft = lint('Search results load fast.', {}, { waive: { 'cap#c1': ['T-SUBJECTIVE'] } });
    expect(soft.findings[0]).not.toHaveProperty('waived');
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('one finding per rule per claim listing every match in order', () => {
    const out = lint('Returns a robust, intuitive and, as needed, seamless page.');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].matches).toEqual(['robust', 'intuitive', 'as needed', 'seamless']);
    expect(out.findings[0].claim).toBe('cap#c1');
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('T-EMPTY and T-PLACEHOLDER (case-sensitive, ?? and lorem ipsum)', () => {
    expect(summary('Works.')).toEqual(['T-EMPTY']);
    expect(summary('Writes the todo list to disk.')).toEqual([]);
    expect(summary('TODO write this later.')).toEqual(['T-PLACEHOLDER[TODO]']);
    expect(summary('Writes ?? files to disk.')).toEqual(['T-PLACEHOLDER[??]']);
    expect(summary('Lorem ipsum dolor sit amet.')).toEqual(['T-PLACEHOLDER[lorem ipsum]']);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('evidence manual without verifier, and evidence key naming no claim', () => {
    const spec = parseSpecContent(
      `---\nid: cap\nkind: capability\nevidence:\n  copy-ok: { kind: manual }\n  ghost: { kind: manual, verifier: "Lead" }\n---\n# Cap\n\n## Problem & Value\n\nV.\n\n## Requirements\n\n- [ ] Checkout copy matches the brand voice guide. <!-- claim: copy-ok -->\n`,
      '/r/specs/cap.md',
      '/r/specs',
    );
    const out = lintCapability(spec, resolveTestabilityConfig(), []);
    expect(out.claims[0].findings.map((f) => f.rule)).toEqual(['T-EVIDENCE-VERIFIER']);
    expect(out.capabilityFindings).toMatchObject([{ rule: 'T-EVIDENCE-VERIFIER', matches: ['ghost'] }]);
    expect(out.capabilityFindings[0].claim).toBeUndefined();
    expect(out.testable).toBe(false);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('evidence agentic conflicts with any non-functional required layer; manual conflicts with any layer', () => {
    const run = (kind: 'agentic' | 'manual', required: TestLayer[]) =>
      summary('The route map draws the selected route.', { evidence: { kind, verifier: 'someone' }, required });
    expect(run('agentic', ['functional'])).toEqual([]);
    expect(run('agentic', ['unit', 'e2e'])).toEqual(['T-EVIDENCE-LAYER-CONFLICT[unit, e2e]']);
    expect(run('manual', ['functional'])).toEqual(['T-EVIDENCE-LAYER-CONFLICT[functional]']);
    expect(run('manual', [])).toEqual([]);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('unknown assurance values and unknown layer names give one capability-level finding each', () => {
    const spec = parseSpecContent(
      `---\nid: cap\nkind: capability\nlayers: [unit, bogus]\nassurance:\n  default: tested\n  claims:\n    a-claim: magic\n---\n# Cap\n\n## Problem & Value\n\nV.\n\n## Requirements\n\n- [ ] Returns 401 for an expired token. <!-- claim: a-claim -->\n`,
      '/r/specs/cap.md',
      '/r/specs',
    );
    const out = lintCapability(spec, resolveTestabilityConfig(), []);
    expect(out.capabilityFindings.map((f) => [f.rule, f.severity, f.matches])).toEqual([
      ['T-ASSURANCE-UNKNOWN', 'error', ['magic']],
      ['T-LAYER-UNKNOWN', 'error', ['bogus']],
    ]);
    expect(out.testable).toBe(false);
    expect(out.claims[0].testable).toBe(true);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('example issues are mapped to T-EX-* findings with their severities', () => {
    const spec = parseSpecContent(
      `---\nid: cap\nkind: capability\n---\n# Cap\n\n## Problem & Value\n\nV.\n\n## Requirements\n\n- [ ] Returns 401 for an expired token. <!-- claim: a-claim -->\n\n  | id | v |\n  |---|---|\n  | x | 1 |\n  | x | 2 |\n\nProse breaks the claim.\n\n| id | v |\n|---|---|\n| y | 1 |\n`,
      '/r/specs/cap.md',
      '/r/specs',
    );
    const out = lintCapability(spec, resolveTestabilityConfig(), []);
    expect(out.claims[0].findings.map((f) => [f.rule, f.severity])).toEqual([['T-EX-DUP-ID', 'error']]);
    expect(out.capabilityFindings.map((f) => [f.rule, f.severity])).toEqual([['T-EX-ORPHAN-TABLE', 'warn']]);
    const lenient = lintCapability(spec, resolveTestabilityConfig({ rules: { 'T-EX-DUP-ID': 'off' } }), []);
    expect(lenient.claims[0].findings).toEqual([]);
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('lintCapability lints anchored and unanchored bullets of v2 specs and skips v1 specs', () => {
    const v2 = parseSpecContent(
      `---\nid: cap\nkind: capability\nlayers: [unit]\n---\n# Cap\n\n## Problem & Value\n\nV.\n\n## Requirements\n\n- [ ] Returns 401 for an expired token. <!-- claim: a-claim -->\n- [ ] Returns 403 for a banned user.\n`,
      '/r/specs/cap.md',
      '/r/specs',
    );
    const out = lintCapability(v2, resolveTestabilityConfig(), []);
    expect(out.capability).toBe('cap');
    expect(out.claims.map((c) => c.ref)).toEqual(['cap#a-claim', 'cap#unanchored-2']);
    expect(out.claims[1].findings.map((f) => f.rule)).toEqual(['T-NO-ANCHOR']);
    const v1 = parseSpecContent('# X\n\n<!-- module: x / type: api -->\n\n## Acceptance Criteria\n- works properly\n', '/r/specs/x.md', '/r/specs');
    expect(lintCapability(v1, resolveTestabilityConfig(), [])).toEqual({ capability: 'x', claims: [], capabilityFindings: [], testable: true });
  });

  // [claims: capabilities/spec-authoring#testability-lint]
  it('waivers apply by claim ref in lintCapability and output is deterministic', () => {
    const spec = parseSpecContent(
      `---\nid: cap\nkind: capability\n---\n# Cap\n\n## Problem & Value\n\nV.\n\n## Requirements\n\n- [ ] Parses the import file correctly and robustly. <!-- claim: parse-ok -->\n`,
      '/r/specs/cap.md',
      '/r/specs',
    );
    const cfg = resolveTestabilityConfig({ waive: { 'cap#parse-ok': ['T-VAGUE'] } });
    const first = lintCapability(spec, cfg, []);
    expect(first.testable).toBe(true);
    expect(first.claims[0].findings[0]).toMatchObject({ rule: 'T-VAGUE', severity: 'warn', waived: true, matches: ['correctly', 'robustly'] });
    expect(lintCapability(spec, cfg, [])).toEqual(first);
  });
});

describe('testability config block [testability]', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const app = { name: 'a', repo: '.', specDir: 'specs', sources: { routes: ['src/**/*.ts'] }, framework: 'vitest', testOutput: 'tests/' };
  const load = async (testability: unknown) => {
    const root = mkdtempSync(path.join(tmpdir(), 'specguard-testability-'));
    dirs.push(root);
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    writeFileSync(path.join(root, '.specguard', 'config.json'), JSON.stringify({ apps: [app], testability }));
    return loadConfig(root);
  };

  // [claims: capabilities/spec-authoring#testability-config]
  it('loads rules, allow, deny, limits and waivers', async () => {
    const config = await load({
      rules: { 'T-HEDGE': 'off', 'T-EX-DUP-ID': 'warn' },
      allow: ['fast tier'],
      deny: ['handles'],
      maxClauses: 4,
      maxWords: 60,
      waive: { 'cap#c1': ['T-VAGUE'] },
    });
    expect(config.testability?.maxClauses).toBe(4);
    const resolved = resolveTestabilityConfig(config.testability);
    expect(resolved.severity['T-HEDGE']).toBe('off');
    expect(resolved.maxWords).toBe(60);
    expect(resolved.allow).toEqual([['fast', 'tier']]);
  });

  // [claims: capabilities/spec-authoring#testability-config]
  it('rejects an unknown rule id, a bad severity and a non-positive limit', async () => {
    await expect(load({ rules: { 'T-NOPE': 'warn' } })).rejects.toThrow(/testability/);
    await expect(load({ rules: { 'T-HEDGE': 'loud' } })).rejects.toThrow(/testability/);
    await expect(load({ waive: { 'cap#c1': ['T-NOPE'] } })).rejects.toThrow(/testability/);
    await expect(load({ maxClauses: 0 })).rejects.toThrow(/testability/);
  });

  // [claims: capabilities/spec-authoring#testability-config]
  it('defaults: three clauses, eighty words, no waivers', () => {
    const resolved = resolveTestabilityConfig();
    expect([resolved.maxClauses, resolved.maxWords, resolved.waive]).toEqual([3, 80, {}]);
    expect(resolved.severity['T-SUCH-AS']).toBe('off');
  });
});
