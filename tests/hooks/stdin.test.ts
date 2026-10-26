import { describe, expect, it } from 'vitest';

import { decide, classify, systemDecision, type HookIndex } from '../../src/hooks/decide.js';
import { parseHookInput, parsePatch } from '../../src/hooks/stdin.js';

const ROOT = '/work/repo';
const payload = (over: Record<string, unknown>): string => JSON.stringify({ session_id: 's1', cwd: ROOT, hook_event_name: 'PreToolUse', ...over });
const parse = (over: Record<string, unknown>, opts = {}) => parseHookInput(payload(over), opts);

describe('parseHookInput: claude edits', () => {
  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('claude Edit/Write/MultiEdit/NotebookEdit payloads -> repo-relative paths', () => {
    const cases: Array<[string, Record<string, unknown>, string, string | undefined]> = [
      ['Write', { file_path: `${ROOT}/src/a.ts`, content: 'hello' }, 'src/a.ts', 'hello'],
      ['Edit', { file_path: `${ROOT}/src/b.ts`, old_string: 'x', new_string: 'kind: approval', replace_all: false }, 'src/b.ts', 'kind: approval'],
      ['MultiEdit', { file_path: `${ROOT}/src/c.ts`, edits: [{ old_string: 'a', new_string: 'one' }, { old_string: 'b', new_string: 'two' }] }, 'src/c.ts', 'one\ntwo'],
      ['NotebookEdit', { notebook_path: `${ROOT}/nb/n.ipynb`, new_source: 'print(1)' }, 'nb/n.ipynb', 'print(1)'],
    ];
    for (const [tool, input, path, text] of cases) {
      const r = parse({ tool_name: tool, tool_input: input });
      expect(r.event).toMatchObject({ event: 'PreToolUse', tool, paths: [path], newText: text, agent: 'claude' });
      expect(r.event.bash).toBeUndefined();
      expect(r.noop).toBeUndefined();
      expect(r.session).toBe('s1');
      expect(r.cwd).toBe(ROOT);
    }
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('resolves a relative path against the cwd field and normalises dots', () => {
    expect(parse({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: '' } }).event.paths).toEqual(['src/a.ts']);
    expect(parse({ cwd: `${ROOT}/src`, tool_name: 'Write', tool_input: { file_path: './x/../a.ts', content: '' } }, { root: ROOT }).event.paths).toEqual(['src/a.ts']);
    expect(parse({ cwd: `${ROOT}/src`, tool_name: 'Write', tool_input: { file_path: '../specs/system.md', content: '' } }, { root: ROOT }).event.paths).toEqual(['specs/system.md']);
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('treats an unconfirmed edit-like tool name as an edit of its path', () => {
    const r = parse({ tool_name: 'mcp__fs__write_file', tool_input: { path: `${ROOT}/src/z.ts`, content: 'z' } });
    expect(r.event.paths).toEqual(['src/z.ts']);
    expect(parse({ tool_name: 'str_replace_editor', tool_input: { path: 'src/z.ts', new_str: 'q' } }).event.paths).toEqual(['src/z.ts']);
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('paths outside cwd -> OUTSIDE_REPO: they are listed apart and leave no path to guard', () => {
    const r = parse({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts', content: '' } });
    expect(r.event.paths).toEqual([]);
    expect(r.outside).toEqual(['/etc/hosts']);
    expect(r.noop).toBe('no-paths');
    const rel = parse({ tool_name: 'Edit', tool_input: { file_path: '../other/x.ts', new_string: '' } });
    expect(rel.outside).toEqual(['../other/x.ts']);
    expect(systemDecision('OUTSIDE_REPO', r.event)).toMatchObject({ decision: 'allow', log: { code: 'OUTSIDE_REPO' } });
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('a sibling directory that shares the root name prefix is outside', () => {
    expect(parse({ tool_name: 'Write', tool_input: { file_path: `${ROOT}-other/a.ts`, content: '' } }).outside).toEqual([`${ROOT}-other/a.ts`]);
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('without a cwd or root only a relative path that stays inside is answered', () => {
    const noCwd = (input: Record<string, unknown>) => parseHookInput(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: input }));
    expect(noCwd({ file_path: 'src/a.ts' }).event.paths).toEqual(['src/a.ts']);
    expect(noCwd({ file_path: '/abs/a.ts' }).outside).toEqual(['/abs/a.ts']);
    expect(noCwd({ file_path: '../a.ts' }).outside).toEqual(['../a.ts']);
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('carries the subagent from agent_type or agent_id', () => {
    expect(parse({ tool_name: 'Edit', agent_type: 'reviewer', agent_id: 'a1', tool_input: { file_path: 'a.ts' } }).event.subagent).toBe('reviewer');
    expect(parse({ tool_name: 'Edit', agent_id: 'a1', tool_input: { file_path: 'a.ts' } }).event.subagent).toBe('a1');
    expect(parse({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).event).not.toHaveProperty('subagent');
  });
});

describe('parseHookInput: Bash', () => {
  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('reads the Bash command and no paths', () => {
    const r = parse({ tool_name: 'Bash', tool_input: { command: 'specguard spec approve a#b', description: 'x', timeout: 5 } });
    expect(r.event).toMatchObject({ tool: 'Bash', bash: 'specguard spec approve a#b', paths: [] });
    expect(r.noop).toBeUndefined();
  });

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('reads a codex argv command: a shell -lc script, or a quoted join', () => {
    expect(parse({ turn_id: 't', tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'specguard spec approve a#b'] } }).event.bash).toBe('specguard spec approve a#b');
    expect(parse({ turn_id: 't', tool_name: 'shell', tool_input: { command: ['git', 'notes', '--ref', 'a b'] } }).event.bash).toBe("git notes --ref 'a b'");
  });

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('feeds the guard end to end', () => {
    const r = parse({ tool_name: 'Bash', tool_input: { command: 'npx -p specguard-ai specguard spec approve cart#fee' } });
    const d = decide(r.event, [], {} as HookIndex, { redValid: new Map() });
    expect(d).toMatchObject({ decision: 'deny', log: { code: 'DENY_BASH_APPROVE' } });
  });
});

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/cart/cart.ts',
  '@@ function total',
  '-  return a;',
  '+  return a + b;',
  '*** Add File: specs/history/2026-10-25-approve-cart.md',
  '+kind: approval',
  '+approves:',
  '+  - cart#fee',
  '*** Delete File: old/dead.ts',
  '*** Update File: src/move-me.ts',
  '*** Move to: src/moved.ts',
  '@@',
  '+x',
  '*** End Patch',
].join('\n');

describe('parseHookInput: codex apply_patch', () => {
  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('codex apply_patch command -> Add/Update/Delete/Move paths', () => {
    const r = parse({ turn_id: 't1', model: 'm', tool_name: 'apply_patch', tool_input: { command: PATCH } });
    expect(r.event).toMatchObject({ tool: 'apply_patch', agent: 'codex' });
    expect(r.event.paths).toEqual(['src/cart/cart.ts', 'specs/history/2026-10-25-approve-cart.md', 'old/dead.ts', 'src/move-me.ts', 'src/moved.ts']);
    expect(r.event.newText).toContain('kind: approval');
    expect(r.event.newText).toContain('return a + b;');
    expect(r.event.newText).not.toContain('return a;');
    expect(r.event.bash).toBeUndefined();
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('finds the patch under Edit/Write names, as input or patch, and as an argv', () => {
    for (const [tool, input] of [
      ['Edit', { command: PATCH }],
      ['Write', { command: PATCH }],
      ['apply_patch', { input: PATCH }],
      ['apply_patch', { patch: PATCH }],
      ['apply_patch', { command: ['apply_patch', PATCH] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = parse({ turn_id: 't', tool_name: tool, tool_input: input });
      expect(r.event.paths).toContain('src/moved.ts');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('makes absolute patch paths repo-relative, sends outside ones apart, and tolerates CRLF and indentation', () => {
    const patch = `*** Begin Patch\r\n*** Update File: ${ROOT}/src/a.ts\r\n*** Add File: /elsewhere/b.ts\r\n  *** Delete File: c.ts\r\n*** End Patch`;
    const r = parse({ turn_id: 't', tool_name: 'apply_patch', tool_input: { command: patch } });
    expect(r.event.paths).toEqual(['src/a.ts', 'c.ts']);
    expect(r.outside).toEqual(['/elsewhere/b.ts']);
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('a patch run through a shell is both a command and a patch', () => {
    const r = parse({ turn_id: 't', tool_name: 'Bash', tool_input: { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` } });
    expect(r.event.bash).toContain('apply_patch');
    expect(r.event.paths).toContain('src/cart/cart.ts');
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('parsePatch lists each path once, reads git-style +++ headers and ignores /dev/null', () => {
    expect(parsePatch('*** Update File: a.ts\n*** Update File: a.ts\n+++ b/c.ts\n--- /dev/null\n+++ /dev/null').paths).toEqual(['a.ts', 'c.ts']);
    expect(parsePatch('').paths).toEqual([]);
    expect(parsePatch(undefined as unknown as string)).toEqual({ paths: [], added: '' });
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('a patch that approves requirements is denied end to end', () => {
    const index = { version: 1, specsRoot: 'specs', historyDir: 'specs/history', testGlobs: [], owned: {}, capabilities: [], openChanges: [] } as unknown as HookIndex;
    const r = parse({ turn_id: 't', tool_name: 'apply_patch', tool_input: { command: PATCH } });
    const classes = r.event.paths.map((p) => classify(p, index, () => false));
    expect(decide(r.event, classes, index, { redValid: new Map() })).toMatchObject({ decision: 'deny', log: { code: 'DENY_APPROVAL_WRITE', agent: 'codex' } });
  });
});

describe('parseHookInput: agents and events', () => {
  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('infers codex from turn_id; an explicit agent wins', () => {
    expect(parse({ turn_id: 't', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).event.agent).toBe('codex');
    expect(parse({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).event.agent).toBe('claude');
    expect(parse({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, { agent: 'codex' }).event.agent).toBe('codex');
    expect(parse({ turn_id: 't', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, { agent: 'claude' }).event.agent).toBe('claude');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('PostToolUse keeps its phase; a missing event name is inferred from tool_response', () => {
    expect(parse({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }).event.event).toBe('PostToolUse');
    const noName = (extra: Record<string, unknown>) => parseHookInput(JSON.stringify({ cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'ls' }, ...extra }));
    expect(noName({}).event.event).toBe('PreToolUse');
    expect(noName({ tool_response: {} }).event.event).toBe('PostToolUse');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('SessionStart and unknown events are no-ops that carry their metadata', () => {
    const r = parseHookInput(JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume', session_id: 's9', cwd: ROOT }));
    expect(r).toMatchObject({ noop: 'unknown-event', hookEventName: 'SessionStart', source: 'resume', session: 's9', cwd: ROOT });
    expect(r.event.paths).toEqual([]);
    expect(r.event.bash).toBeUndefined();
    expect(parse({ hook_event_name: 'SomethingNew', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).noop).toBe('unknown-event');
  });
});

describe('parseHookInput: malformed input', () => {
  const allowed = (r: ReturnType<typeof parseHookInput>) => decide(r.event, [], {} as HookIndex, { redValid: new Map() }).decision;

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('malformed JSON -> allow', () => {
    for (const raw of ['', '{', 'not json', '{"tool_name":', '\u0000', 'null', '[]', '42', '"str"', 'true']) {
      const r = parseHookInput(raw);
      expect(r.noop).toBeDefined();
      expect(r.event.paths).toEqual([]);
      expect(r.event.bash).toBeUndefined();
      expect(allowed(r)).toBe('allow');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('names why: malformed-json, not-an-object, no-tool', () => {
    expect(parseHookInput('{').noop).toBe('malformed-json');
    expect(parseHookInput('[1]').noop).toBe('not-an-object');
    expect(parse({}).noop).toBe('no-tool');
    expect(parse({ tool_input: {} }).noop).toBe('no-tool');
    expect(parseHookInput('{"cwd":"/work/repo"}').noop).toBe('unknown-event');
    expect(parse({ tool_name: '', tool_input: {} }).noop).toBe('no-tool');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('unknown shapes become a no-op event, not a throw', () => {
    const odd: Array<Record<string, unknown>> = [
      { tool_name: 'Edit' },
      { tool_name: 'Edit', tool_input: null },
      { tool_name: 'Edit', tool_input: 'a string' },
      { tool_name: 'Edit', tool_input: [] },
      { tool_name: 'Edit', tool_input: { file_path: 42 } },
      { tool_name: 'Edit', tool_input: { file_path: '' } },
      { tool_name: 'Edit', tool_input: { file_path: ['a'] } },
      { tool_name: 'MultiEdit', tool_input: { file_path: 'a.ts', edits: 'nope' } },
      { tool_name: 'Bash', tool_input: { command: 42 } },
      { tool_name: 'Bash', tool_input: { command: [1, 2] } },
      { tool_name: 'Bash', tool_input: {} },
      { tool_name: 'Read', tool_input: { file_path: 'a.ts' } },
      { tool_name: 'WebSearch', tool_input: { query: 'x' } },
      { tool_name: 42, tool_input: {} },
      { tool_name: 'apply_patch', tool_input: { command: 'not a patch' } },
      { tool_name: 'apply_patch', tool_input: { command: [] } },
      { cwd: 5, tool_name: 'Edit', tool_input: { file_path: 'a.ts' } },
    ];
    for (const o of odd) {
      const r = parse(o);
      expect(r.event.agent).toBeDefined();
      expect(r.event.bash).toBeUndefined();
      expect(allowed(r)).toBe('allow');
    }
    // A cwd that is not a string is ignored, the path still resolves relative.
    expect(parse({ cwd: 5, tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).event.paths).toEqual(['a.ts']);
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('an oversized text is cut, not rejected', () => {
    const r = parse({ tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'x'.repeat(500_000) } });
    expect(r.event.paths).toEqual(['a.ts']);
    expect(r.event.newText!.length).toBe(200_000);
  });
});
