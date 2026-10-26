import { describe, expect, it } from 'vitest';

import { claimHashOf } from '../../src/core/claim-hash.js';
import { addHistoryRef, historyId, parseHistoryEntry, renderHistoryEntry, slugify } from '../../src/core/history.js';
import { mergeHistoryHooks, historyHookSpecs } from '../../src/core/scaffold.js';
import { NPX_RUNNER } from '../../src/core/runner.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';

const SPEC = (history: string) =>
  `---\nid: auth\nkind: capability\nparent: system\nvalue: v\nsources:\n  - "src/**"\n${history}---\n# Auth\n\n## Problem & Value\n\nOnly approved people sign in.\n\n## Requirements\n\n- [ ] Login works <!-- claim: login-works -->\n`;

describe('history entries [history-core]', () => {
  // [claims: capabilities/requirement-history#history-not-specs]
  it('slugifies and makes ids unique with a numeric suffix [ids]', () => {
    expect(slugify('Add: the "Fancy" thing!! ')).toBe('add-the-fancy-thing');
    expect(historyId('2026-10-15', 'Fancy thing')).toBe('2026-10-15-fancy-thing');
    expect(historyId('2026-10-15', 'Fancy thing', new Set(['2026-10-15-fancy-thing', '2026-10-15-fancy-thing-2']))).toBe('2026-10-15-fancy-thing-3');
  });

  // [claims: capabilities/requirement-history#history-entry-format]
  it('round-trips the policy list, and an entry without one renders and parses as before [policy]', () => {
    const meta = { id: '2026-10-25-x', date: '2026-10-25', kind: 'decision' as const, title: 'Raise cart', affects: ['cart'] };
    const withPolicy = renderHistoryEntry({ ...meta, policy: ['enforce cart observe->warn', 'enforce "quoted" warn->enforce'] }, '# X');
    expect(withPolicy).toContain('policy:\n  - "enforce cart observe->warn"\n  - ');
    expect(parseHistoryEntry(withPolicy, '/f.md')?.policy).toEqual(['enforce cart observe->warn', 'enforce "quoted" warn->enforce']);
    // existing entries: no policy key is written, and none is read back
    const plain = renderHistoryEntry(meta, '# X');
    expect(plain).not.toContain('policy');
    expect(renderHistoryEntry({ ...meta, policy: [] }, '# X')).toBe(plain);
    expect(parseHistoryEntry(plain, '/f.md')?.policy).toBeUndefined();
    // a policy that is not a list of strings is ignored, never trusted
    expect(parseHistoryEntry(plain.replace('---\n\n', 'policy: nope\n---\n\n'), '/f.md')?.policy).toBeUndefined();
  });

  // [claims: capabilities/requirement-history#history-entry-format]
  it('round-trips frontmatter and body [roundtrip]', () => {
    const text = renderHistoryEntry({ id: '2026-10-15-x', date: '2026-10-15', kind: 'prompt+plan', author: 'Wes', title: 'X: a "title"', affects: ['auth', 'shop'], source: 'claude-code' }, '# X\n\n## Prompt\n\nhello');
    const parsed = parseHistoryEntry(text, '/f.md');
    expect(parsed).toMatchObject({ id: '2026-10-15-x', date: '2026-10-15', kind: 'prompt+plan', author: 'Wes', title: 'X: a "title"', affects: ['auth', 'shop'] });
    expect(parsed?.body).toContain('## Prompt');
    expect(parseHistoryEntry('# no frontmatter', '/f.md')).toBeNull();
  });
});

describe('history back-references [history-refs]', () => {
  // [claims: capabilities/requirement-history#history-backrefs]
  it('appends to an existing list, creates a missing one, and converts an empty list [add-ref]', () => {
    expect(addHistoryRef(SPEC('history:\n  - h1\n'), 'h2')).toContain('history:\n  - h1\n  - h2\n---');
    expect(addHistoryRef(SPEC(''), 'h1')).toContain('history:\n  - h1\n---');
    expect(addHistoryRef(SPEC('history: []\n'), 'h1')).toContain('history:\n  - h1\n---');
  });

  // [claims: capabilities/requirement-history#history-backrefs]
  it('is idempotent and leaves content without frontmatter alone [idempotent]', () => {
    const once = addHistoryRef(SPEC('history:\n  - h1\n'), 'h2');
    expect(addHistoryRef(once, 'h2')).toBe(once);
    expect(addHistoryRef('# plain', 'h')).toBe('# plain');
  });

  // [claims: capabilities/requirement-history#history-backrefs-not-stale]
  it('never changes a claim hash, so back-references cannot stale proofs [no-stale]', () => {
    const before = parseSpecContent(SPEC(''), '/r/specs/auth.md', '/r/specs');
    const after = parseSpecContent(addHistoryRef(SPEC(''), '2026-10-15-x'), '/r/specs/auth.md', '/r/specs');
    expect(after.meta.history).toEqual(['2026-10-15-x']);
    expect(claimHashOf(after, 'login-works')).toBe(claimHashOf(before, 'login-works'));
  });
});

describe('history hooks [history-hooks]', () => {
  const ctx = (update = false) => ({ runner: NPX_RUNNER, update, notes: [] as string[] });

  // [claims: capabilities/requirement-history#history-hooks-silent]
  it('wires the prompt inbox and the plan capture, both silent [wire]', () => {
    const merged = mergeHistoryHooks({}, ctx()) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    expect(merged.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(merged.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/history inbox >\/dev\/null 2>&1 \|\| true$/);
    expect(merged.hooks.PostToolUse[0].matcher).toBe('ExitPlanMode');
    expect(merged.hooks.PostToolUse[0].hooks[0].command).toMatch(/history capture >\/dev\/null 2>&1 \|\| true$/);
  });

  // [claims: capabilities/requirement-history#history-hooks-opt-in]
  it('is idempotent, keeps the user\'s own hooks, and never rewrites a differing hook without --update-hooks [safe-merge]', () => {
    const mine = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }] } };
    const once = mergeHistoryHooks(mine, ctx());
    expect(mergeHistoryHooks(once, ctx())).toEqual(once);
    const text = JSON.stringify(once);
    expect(text).toContain('echo mine');
    expect(text).toContain('echo bash');

    const edited = JSON.parse(JSON.stringify(once).replace('history inbox >/dev/null', 'history inbox --verbose >/dev/null'));
    const c = ctx();
    expect(JSON.stringify(mergeHistoryHooks(edited, c))).toContain('--verbose');
    expect(c.notes.join('\n')).toContain('--update-hooks');
    expect(JSON.stringify(mergeHistoryHooks(edited, ctx(true)))).not.toContain('--verbose');
  });

  it('describes exactly two hook specs [specs]', () => {
    expect(historyHookSpecs(NPX_RUNNER).map((s) => s.event)).toEqual(['UserPromptSubmit', 'PostToolUse']);
  });
});

describe('back-references never corrupt frontmatter [history-refs-forms]', () => {
  const valid = (text: string, id: string) => {
    const parsed = parseSpecContent(text, '/r/specs/capabilities/auth.md', '/r/specs');
    expect(parsed.meta.history).toContain(id);
  };

  // [claims: capabilities/requirement-history#history-backrefs]
  it('appends to a flow list instead of adding a second history key [flow-list]', () => {
    const out = addHistoryRef(SPEC('history: [h1, h2]\n'), 'h3');
    expect(out.match(/^history:/gm)).toHaveLength(1);
    valid(out, 'h3');
    expect(parseSpecContent(out, '/r/specs/capabilities/auth.md', '/r/specs').meta.history).toEqual(['h1', 'h2', 'h3']);
    expect(addHistoryRef(out, 'h3')).toBe(out);
  });

  // [claims: capabilities/requirement-history#history-backrefs]
  it('appends after the last item of an unindented block list, matching its indent [unindented]', () => {
    const out = addHistoryRef(SPEC('history:\n- h1\n- h2\n'), 'h3');
    expect(parseSpecContent(out, '/r/specs/capabilities/auth.md', '/r/specs').meta.history).toEqual(['h1', 'h2', 'h3']);
    expect(out).toContain('- h2\n- h3\n---');
    expect(addHistoryRef(out, 'h2')).toBe(out);
  });

  // [claims: capabilities/requirement-history#history-backrefs]
  it('leaves the spec alone when the history value is something it cannot extend, or the result would not parse [refuses]', () => {
    const scalar = SPEC('history: just-one\n');
    expect(addHistoryRef(scalar, 'h2')).toBe(scalar);
    const broken = SPEC('history: [a, b\n');
    expect(addHistoryRef(broken, 'h2')).toBe(broken);
    expect(addHistoryRef('# no frontmatter', 'h1')).toBe('# no frontmatter');
  });
});
