import { describe, expect, it } from 'vitest';

import {
  HOOK_MESSAGE_MAX,
  classify,
  decide,
  forAgent,
  guardBash,
  looksLikeApproval,
  splitShell,
  systemDecision,
  withLogContext,
  type HookDecision,
  type HookEvent,
  type HookIndex,
  type PathClass,
} from '../../src/hooks/decide.js';
import type { EnforceLevel } from '../../src/core/types.js';

/** A tiny glob matcher standing in for picomatch: `**` crosses directories, `*` does not. */
function glob(g: string, p: string): boolean {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(p);
}

type Change = HookIndex['openChanges'][number];

const change = (over: Partial<Change> & Pick<Change, 'id'>): Change => ({
  kind: 'feature',
  capabilities: ['cart'],
  lockedTests: [],
  approvedAll: true,
  red: { testsHash: 't', claimsHash: 'c', valid: true },
  ...over,
});

const CHG = '20261025-free-shipping-a1b2';

function makeIndex(levels: Partial<Record<'cart' | 'pay' | 'docs', EnforceLevel>> = {}, openChanges: Change[] = []): HookIndex {
  return {
    version: 1,
    builtAt: '2026-10-25T00:00:00.000Z',
    fingerprint: 'f',
    specsRoot: 'specs',
    historyDir: 'specs/history',
    testGlobs: ['tests/**', '**/*.test.ts'],
    owned: { 'src/cart/cart.ts': ['cart'], 'src/shared.ts': ['cart', 'pay'], 'src/pay/pay.ts': ['pay'], 'src/docs/doc.ts': ['docs'] },
    capabilities: [
      { id: 'cart', specFile: 'specs/capabilities/cart.md', enforce: levels.cart ?? 'enforce', sources: ['src/cart/**'] },
      { id: 'pay', specFile: 'specs/capabilities/pay.md', enforce: levels.pay ?? 'warn', sources: ['src/pay/**'] },
      { id: 'docs', specFile: 'specs/capabilities/docs.md', enforce: levels.docs ?? 'observe', sources: ['src/docs/**', '!src/docs/private/**'] },
    ],
    openChanges,
  };
}

function ev(over: Partial<HookEvent> = {}): HookEvent {
  return { event: 'PreToolUse', tool: 'Edit', paths: [], agent: 'claude', ...over };
}

function run(event: HookEvent, index: HookIndex, redValid: Record<string, boolean> = {}): HookDecision {
  const classes = event.paths.map((p) => classify(p, index, glob));
  return decide(event, classes, index, { redValid: new Map(Object.entries(redValid)) });
}

const edit = (path: string, extra: Partial<HookEvent> = {}): HookEvent => ev({ paths: [path], ...extra });
const bash = (command: string): HookEvent => ev({ tool: 'Bash', bash: command });

const LEVELS: EnforceLevel[] = ['observe', 'warn', 'enforce'];
const levelIndex = (level: EnforceLevel, changes: Change[] = []): HookIndex => makeIndex({ cart: level }, changes);

describe('classify', () => {
  const index = makeIndex({}, [change({ id: CHG, lockedTests: ['spec-tests/cart.spec.ts'] }), change({ id: 'x', lockedTests: [] })]);
  const k = (p: string): PathClass => classify(p, index, glob);

  // [claims: capabilities/spec-first-changes#hook-spec-test-free]
  it('sorts a path into owned source, test, spec, history, change record, config, workflow or other', () => {
    expect(k('src/cart/cart.ts')).toEqual({ kind: 'owned', capabilities: ['cart'] });
    expect(k('src/shared.ts')).toEqual({ kind: 'owned', capabilities: ['cart', 'pay'] });
    expect(k('tests/cart.test.ts')).toEqual({ kind: 'test', lockedBy: [] });
    expect(k('specs/capabilities/cart.md')).toEqual({ kind: 'spec', capability: 'cart' });
    expect(k('specs/system.md')).toEqual({ kind: 'spec' });
    expect(k('specs/history/2026-10-25-plan.md')).toEqual({ kind: 'history', approvalLike: false });
    expect(k('.specguard/config.json')).toEqual({ kind: 'specguard-config' });
    expect(k('.github/workflows/ci.yml')).toEqual({ kind: 'workflow' });
    expect(k('CODEOWNERS')).toEqual({ kind: 'workflow' });
    expect(k('.github/CODEOWNERS')).toEqual({ kind: 'workflow' });
    expect(k('README.md')).toEqual({ kind: 'other' });
  });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('classifies a file that does not exist yet by the capability source globs, honouring a negated glob', () => {
    expect(k('src/pay/new-file.ts')).toEqual({ kind: 'owned', capabilities: ['pay'] });
    expect(k('src/docs/a/b.ts')).toEqual({ kind: 'owned', capabilities: ['docs'] });
    expect(k('src/docs/private/key.ts')).toEqual({ kind: 'other' });
  });

  // [claims: capabilities/spec-first-changes#hook-stage-lock]
  it('names the open changes that lock a test, even outside the test globs', () => {
    expect(k('spec-tests/cart.spec.ts')).toEqual({ kind: 'test', lockedBy: [CHG] });
  });

  // [claims: capabilities/spec-first-changes#hook-spec-test-free]
  it('a test file that a source glob also covers is a test', () => {
    const idx = makeIndex();
    idx.capabilities[0]!.sources = ['src/**'];
    expect(classify('src/cart/cart.test.ts', idx, glob)).toEqual({ kind: 'test', lockedBy: [] });
  });

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('a change record is closed unless an open change has its id', () => {
    expect(k(`.specguard/changes/${CHG}.json`)).toEqual({ kind: 'change-record', closed: false });
    expect(k('.specguard/changes/20260101-old-ffff.json')).toEqual({ kind: 'change-record', closed: true });
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('normalises ./ and treats parent or absolute paths and prototype names as other', () => {
    expect(k('./src/cart/cart.ts')).toEqual({ kind: 'owned', capabilities: ['cart'] });
    expect(k('src//cart/./cart.ts')).toEqual({ kind: 'owned', capabilities: ['cart'] });
    expect(k('../outside.ts')).toEqual({ kind: 'other' });
    expect(k('/etc/passwd')).toEqual({ kind: 'other' });
    expect(k('constructor')).toEqual({ kind: 'other' });
    expect(k('')).toEqual({ kind: 'other' });
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('survives an index with missing parts', () => {
    expect(classify('src/a.ts', {} as HookIndex, glob)).toEqual({ kind: 'other' });
    expect(classify('src/a.ts', { owned: { 'src/a.ts': 'oops' } } as unknown as HookIndex, glob)).toEqual({ kind: 'other' });
  });
});

describe('decide: owned source, no open change', () => {
  // [claims: capabilities/spec-first-changes#hook-observe-logs]
  it('observe logs the edit and allows it silently', () => {
    const d = run(edit('src/cart/cart.ts'), levelIndex('observe'));
    expect(d.decision).toBe('allow');
    expect(d.message).toBeUndefined();
    expect(d.log).toMatchObject({ code: 'OBSERVED', level: 'observe', caps: ['cart'], decision: 'allow', paths: ['src/cart/cart.ts'] });
  });

  // [claims: capabilities/spec-first-changes#hook-warn-names-next-step]
  it('warn allows and names the command that starts a change', () => {
    const d = run(edit('src/cart/cart.ts'), levelIndex('warn'));
    expect(d.decision).toBe('allow');
    expect(d.log.code).toBe('WARN_NO_CHANGE');
    expect(d.message).toMatch(/^SpecGuard \(warn\): /);
    expect(d.message).toContain('specguard change start cart');
  });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('enforce denies and names the command that starts a change', () => {
    const d = run(edit('src/cart/cart.ts'), levelIndex('enforce'));
    expect(d.decision).toBe('deny');
    expect(d.log).toMatchObject({ code: 'DENY_NO_CHANGE', level: 'enforce' });
    expect(d.message).toContain('specguard change start cart --why');
  });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('a new file under a capability glob is denied like an existing one', () => {
    const d = run(ev({ tool: 'Write', paths: ['src/cart/brand-new.ts'] }), levelIndex('enforce'));
    expect(d.log.code).toBe('DENY_NO_CHANGE');
  });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('a change on a different capability does not cover the edit', () => {
    const d = run(edit('src/cart/cart.ts'), levelIndex('enforce', [change({ id: CHG, capabilities: ['pay'] })]));
    expect(d.log.code).toBe('DENY_NO_CHANGE');
  });
});

describe('decide: owned source, feature change stages', () => {
  const notApproved = change({ id: CHG, approvedAll: false, red: undefined });
  const approvedNoRed = change({ id: CHG, red: undefined });
  const approvedBadRed = change({ id: CHG, red: { testsHash: 't', claimsHash: 'c', valid: false } });
  const ready = change({ id: CHG });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('approved with valid red allows at every level with ALLOW_CHANGE and names the change in the log', () => {
    for (const level of LEVELS) {
      const d = run(edit('src/cart/cart.ts'), levelIndex(level, [ready]));
      expect(d).toMatchObject({ decision: 'allow', log: { code: 'ALLOW_CHANGE', change: CHG } });
      expect(d.message).toBeUndefined();
    }
  });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('change open but not approved: observe logs, warn advises, enforce denies DENY_NOT_APPROVED', () => {
    const [o, w, e] = LEVELS.map((l) => run(edit('src/cart/cart.ts'), levelIndex(l, [notApproved])));
    expect(o).toMatchObject({ decision: 'allow', log: { code: 'OBSERVED' } });
    expect(o!.message).toBeUndefined();
    expect(w).toMatchObject({ decision: 'allow', log: { code: 'WARN_BEFORE_RED' } });
    expect(w!.message).toContain(`specguard change status ${CHG}`);
    expect(e).toMatchObject({ decision: 'deny', log: { code: 'DENY_NOT_APPROVED', change: CHG } });
  });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('approved but red missing: enforce denies DENY_BEFORE_RED with the red command', () => {
    for (const idx of [approvedNoRed, approvedBadRed]) {
      const [o, w, e] = LEVELS.map((l) => run(edit('src/cart/cart.ts'), levelIndex(l, [idx])));
      expect(o).toMatchObject({ decision: 'allow', log: { code: 'OBSERVED' } });
      expect(w).toMatchObject({ decision: 'allow', log: { code: 'WARN_BEFORE_RED' } });
      expect(e).toMatchObject({ decision: 'deny', log: { code: 'DENY_BEFORE_RED' } });
      expect(e!.message).toContain(`specguard change red ${CHG}`);
      expect(e!.message).toContain('failing test first');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-stage-lock]
  it('red validity is read live: a live false denies although the index said valid, a live true allows', () => {
    expect(run(edit('src/cart/cart.ts'), levelIndex('enforce', [ready]), { [CHG]: false }).log.code).toBe('DENY_BEFORE_RED');
    expect(run(edit('src/cart/cart.ts'), levelIndex('enforce', [approvedBadRed]), { [CHG]: true }).log.code).toBe('ALLOW_CHANGE');
  });

  // [claims: capabilities/spec-first-changes#hook-enforce-denies-code]
  it('another covering change that is ready allows the edit', () => {
    const d = run(edit('src/cart/cart.ts'), levelIndex('enforce', [notApproved, change({ id: '20261025-other-ffff' })]));
    expect(d.log).toMatchObject({ code: 'ALLOW_CHANGE', change: '20261025-other-ffff' });
  });
});

describe('decide: refactor and spike changes', () => {
  // [claims: capabilities/spec-first-changes#hook-change-kinds]
  it('an open refactor change allows code edits at every level in any order', () => {
    const c = change({ id: CHG, kind: 'refactor', approvedAll: false, red: undefined });
    for (const level of LEVELS) {
      const d = run(edit('src/cart/cart.ts'), levelIndex(level, [c]));
      expect(d).toMatchObject({ decision: 'allow', log: { code: 'ALLOW_REFACTOR', change: CHG } });
      expect(d.message).toBeUndefined();
    }
  });

  // [claims: capabilities/spec-first-changes#hook-change-kinds]
  it('an open spike allows code-first edits; observe is silent, warn and enforce carry the spike message', () => {
    const c = change({ id: CHG, kind: 'spike', approvedAll: false, red: undefined });
    const [o, w, e] = LEVELS.map((l) => run(edit('src/cart/cart.ts'), levelIndex(l, [c])));
    expect(o).toMatchObject({ decision: 'allow', log: { code: 'ALLOW_SPIKE' } });
    expect(o!.message).toBeUndefined();
    for (const d of [w!, e!]) {
      expect(d).toMatchObject({ decision: 'allow', log: { code: 'ALLOW_SPIKE', change: CHG } });
      expect(d.message).toContain('cannot merge');
      expect(d.message).toContain(`specguard change convert ${CHG} --to feature`);
    }
  });
});

describe('decide: multiple owners and paths', () => {
  // [claims: capabilities/spec-first-changes#hook-strictest-wins]
  it('strictest level wins for a file owned by two capabilities', () => {
    const idx = makeIndex({ cart: 'observe', pay: 'enforce' });
    const d = run(edit('src/shared.ts'), idx);
    expect(d.log).toMatchObject({ code: 'DENY_NO_CHANGE', level: 'enforce', caps: ['cart', 'pay'] });
    expect(run(edit('src/shared.ts'), makeIndex({ cart: 'observe', pay: 'warn' })).log).toMatchObject({ code: 'WARN_NO_CHANGE', level: 'warn' });
  });

  // [claims: capabilities/spec-first-changes#hook-strictest-wins]
  it('a change must cover every owning capability', () => {
    const idx = makeIndex({ cart: 'enforce', pay: 'enforce' }, [change({ id: CHG, capabilities: ['cart'] })]);
    expect(run(edit('src/shared.ts'), idx).log.code).toBe('DENY_NO_CHANGE');
    const both = makeIndex({ cart: 'enforce', pay: 'enforce' }, [change({ id: CHG, capabilities: ['cart', 'pay'] })]);
    expect(run(edit('src/shared.ts'), both).log.code).toBe('ALLOW_CHANGE');
  });

  // [claims: capabilities/spec-first-changes#hook-strictest-wins]
  it('multi-path apply_patch denies when any path is denied', () => {
    const event = ev({ tool: 'apply_patch', agent: 'codex', paths: ['README.md', 'tests/a.test.ts', 'src/cart/cart.ts', 'src/pay/pay.ts'] });
    const d = run(event, levelIndex('enforce'));
    expect(d.decision).toBe('deny');
    expect(d.log.code).toBe('DENY_NO_CHANGE');
    expect(d.log.paths).toEqual(event.paths);
  });

  // [claims: capabilities/spec-first-changes#hook-strictest-wins]
  it('a patch of free files and an advised file allows with the advice', () => {
    const d = run(ev({ tool: 'apply_patch', paths: ['README.md', 'src/pay/pay.ts'] }), levelIndex('enforce'));
    expect(d).toMatchObject({ decision: 'allow', log: { code: 'WARN_NO_CHANGE' } });
  });

  // [claims: capabilities/spec-first-changes#hook-strictest-wins]
  it('an approval write beats an owned-source denial', () => {
    const d = run(ev({ paths: ['src/cart/cart.ts', 'specs/history/a.md'], newText: 'kind: approval' }), levelIndex('enforce'));
    expect(d.log.code).toBe('DENY_APPROVAL_WRITE');
  });
});

describe('decide: specs and tests are always editable', () => {
  // [claims: capabilities/spec-first-changes#hook-spec-test-free]
  it('allows a spec edit and a test edit at every level with no message', () => {
    for (const level of LEVELS) {
      for (const p of ['specs/capabilities/cart.md', 'specs/system.md', 'tests/cart.test.ts', 'src/cart/cart.test.ts']) {
        const d = run(edit(p), levelIndex(level));
        expect(d).toMatchObject({ decision: 'allow', log: { code: 'FREE' } });
        expect(d.message).toBeUndefined();
      }
    }
  });

  // [claims: capabilities/spec-first-changes#hook-spec-test-free]
  it('other files are allowed silently', () => {
    expect(run(edit('README.md'), levelIndex('enforce'))).toMatchObject({ decision: 'allow', log: { code: 'FREE' } });
  });

  // [claims: capabilities/spec-first-changes#hook-spec-test-free]
  it('an edit with no paths and no command, and any PostToolUse, is allowed', () => {
    expect(run(ev(), levelIndex('enforce')).decision).toBe('allow');
    expect(run(ev({ event: 'PostToolUse', paths: ['src/cart/cart.ts'] }), levelIndex('enforce'))).toMatchObject({ decision: 'allow', log: { code: 'FREE' } });
  });
});

describe('decide: stage locks', () => {
  const locked = change({ id: CHG, lockedTests: ['tests/cart.test.ts'] });

  // [claims: capabilities/spec-first-changes#hook-stage-lock]
  it('a test locked by a change with valid red is allowed with the LOCK_TESTS message at every level', () => {
    for (const level of LEVELS) {
      const d = run(edit('tests/cart.test.ts'), levelIndex(level, [locked]));
      expect(d).toMatchObject({ decision: 'allow', log: { code: 'LOCK_TESTS', change: CHG } });
      expect(d.message).toContain(`specguard change red ${CHG}`);
      expect(d.message).toContain('back at "red"');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-stage-lock]
  it('a locked test whose red is not valid yet is free', () => {
    expect(run(edit('tests/cart.test.ts'), levelIndex('enforce', [locked]), { [CHG]: false }).log.code).toBe('FREE');
    expect(run(edit('tests/cart.test.ts'), levelIndex('enforce', [change({ id: CHG, lockedTests: ['tests/cart.test.ts'], red: undefined })])).log.code).toBe('FREE');
  });

  // [claims: capabilities/spec-first-changes#hook-stage-lock]
  it('a spec edit covered by a change with valid red is allowed with the LOCK_SPEC message', () => {
    for (const level of LEVELS) {
      const d = run(edit('specs/capabilities/cart.md'), levelIndex(level, [locked]));
      expect(d).toMatchObject({ decision: 'allow', log: { code: 'LOCK_SPEC', change: CHG } });
      expect(d.message).toContain(`specguard change red ${CHG}`);
    }
  });

  // [claims: capabilities/spec-first-changes#hook-stage-lock]
  it('a spec edit for another capability is not locked', () => {
    expect(run(edit('specs/capabilities/pay.md'), levelIndex('enforce', [locked])).log.code).toBe('FREE');
  });

  // [claims: capabilities/spec-first-changes#hook-stage-lock]
  it('several locking changes are all named by the first id and a count', () => {
    const two = [locked, change({ id: '20261025-second-ffff', lockedTests: ['tests/cart.test.ts'] })];
    const d = run(edit('tests/cart.test.ts'), levelIndex('enforce', two));
    expect(d.message).toContain('(+1 more)');
  });
});

describe('decide: approvals and change records', () => {
  const approvals = [
    '---\nkind: approval\napproves:\n  - cart#fee\n---\n',
    "kind: 'approval'",
    'kind: "approval"',
    '{"kind":"approval"}',
    'method: command\napproves:\n  - cart#fee',
  ];

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('approval-like history text is denied at every level, with the person-only message', () => {
    for (const level of LEVELS) {
      for (const text of approvals) {
        const d = run(ev({ tool: 'Write', paths: ['specs/history/2026-10-25-approve-cart.md'], newText: text }), levelIndex(level));
        expect(d).toMatchObject({ decision: 'deny', log: { code: 'DENY_APPROVAL_WRITE' } });
        expect(d.message).toContain("person's decision");
        expect(d.message).toContain('specguard spec approve');
      }
    }
  });

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('approval-like history write is denied at observe', () => {
    expect(run(ev({ paths: ['specs/history/a.md'], newText: 'kind: approval' }), levelIndex('observe')).decision).toBe('deny');
  });

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('other history text is allowed', () => {
    for (const text of ['kind: plan\ntitle: x', 'kind: decision', 'method: command', 'the word approval alone', undefined]) {
      const d = run(ev({ paths: ['specs/history/a.md'], ...(text !== undefined ? { newText: text } : {}) }), levelIndex('enforce'));
      expect(d.decision).toBe('allow');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('looksLikeApproval reads kind and method with approves, and ignores empty text', () => {
    expect(looksLikeApproval('kind: approval')).toBe(true);
    expect(looksLikeApproval('method: pr\napproves: [a#b]')).toBe(true);
    expect(looksLikeApproval('kind: plan')).toBe(false);
    expect(looksLikeApproval('')).toBe(false);
    expect(looksLikeApproval(undefined)).toBe(false);
  });

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('closed change record edit is denied', () => {
    const d = run(edit('.specguard/changes/20260101-old-ffff.json', { newText: '{"plans":[]}' }), levelIndex('observe', [change({ id: CHG })]));
    expect(d).toMatchObject({ decision: 'deny', log: { code: 'DENY_RECORD_EDIT' } });
    expect(d.message).toContain('specguard change');
  });

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('an edit that sets kind or closed on an open record is denied; other edits are allowed', () => {
    const idx = levelIndex('enforce', [change({ id: CHG })]);
    const file = `.specguard/changes/${CHG}.json`;
    expect(run(edit(file, { newText: '  "kind": "refactor",' }), idx).log.code).toBe('DENY_RECORD_EDIT');
    expect(run(edit(file, { newText: '"closed": {"reason":"done"}' }), idx).log.code).toBe('DENY_RECORD_EDIT');
    expect(run(edit(file, { newText: '"why": "kind of urgent"' }), idx).decision).toBe('allow');
    expect(run(edit(file), idx).decision).toBe('allow');
  });

  // [claims: capabilities/spec-first-changes#hook-spec-test-free]
  it('config, workflow and CODEOWNERS edits are allowed with a note at every level', () => {
    for (const level of LEVELS) {
      for (const p of ['.specguard/config.json', '.github/workflows/ci.yml', 'CODEOWNERS']) {
        const d = run(edit(p), levelIndex(level));
        expect(d).toMatchObject({ decision: 'allow', log: { code: 'NOTE_POLICY_FILE' } });
        expect(d.message).toBeTruthy();
      }
    }
  });
});

describe('decide: the Bash guard', () => {
  const idx = levelIndex('observe');
  const code = (command: string) => run(bash(command), idx).log.code;

  const denied: Array<[string, string]> = [
    ['plain', 'specguard spec approve cart#fee'],
    ['npx -p', 'npx -p specguard-ai specguard spec approve cart#fee'],
    ['npx -y pinned', 'npx -y -p specguard-ai@0.6.0 specguard spec approve cart#fee'],
    ['npx package bin', 'npx specguard-ai spec approve cart#fee'],
    ['pnpm dlx', 'pnpm dlx specguard-ai spec approve a#b'],
    ['bin path', './bin/specguard spec approve a#b'],
    ['absolute bin', '/usr/local/bin/specguard spec approve a#b'],
    ['node entry', 'node dist/cli/index.js spec approve a#b'],
    ['tsx entry', 'npx tsx src/cli/index.ts spec approve a#b'],
    ['after cd', 'cd app && specguard spec approve a#b'],
    ['after a pipe', 'echo y | specguard spec approve a#b'],
    ['env assignment', 'FOO=1 specguard spec approve a#b'],
    ['env wrapper', 'env FOO=1 specguard spec approve a#b'],
    ['sudo', 'sudo specguard spec approve a#b'],
    ['time', 'time specguard spec approve a#b'],
    ['leading option with value', 'specguard --config c.json spec approve a#b'],
    ['quoted words', `'specguard' "spec" approve a#b`],
    ['backslash split', 'specguard sp\\ec approve a#b'],
    ['ansi-c quoting', "$'\\x73pecguard' spec approve a#b"],
    ['bash -c', 'bash -c "specguard spec approve a#b"'],
    ['sh -lc', "sh -lc 'echo hi; specguard spec approve a#b'"],
    ['eval', 'eval "specguard spec approve a#b"'],
    ['command substitution', 'echo "$(specguard spec approve a#b)"'],
    ['backticks', 'echo `specguard spec approve a#b`'],
    ['subshell', '(specguard spec approve a#b)'],
    ['newline', 'ls\nspecguard spec approve a#b'],
    ['background', 'specguard spec approve a#b &'],
    ['spec approve --from-pr', 'specguard spec approve --from-pr 12'],
    ['enforce lower', 'specguard enforce lower cart --to warn --why "too slow"'],
    ['enforce raise', 'specguard enforce raise cart'],
    ['enforce lower via npx', 'npx -p specguard-ai specguard enforce lower cart --to observe --why x'],
    ['change convert', 'specguard change convert 20261025-x-a1b2 --to feature'],
    ['change abandon', 'specguard change abandon 20261025-x-a1b2 --why gone'],
    ['change done --force', 'specguard change done 20261025-x-a1b2 --force --why x'],
    ['proof publish', 'specguard proof publish'],
  ];

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it.each(denied)('bash: %s is denied', (_name, command) => {
    const d = run(bash(command), idx);
    expect(d).toMatchObject({ decision: 'deny', log: { code: 'DENY_BASH_APPROVE', tool: 'Bash' } });
    expect(d.message).toContain('person');
  });

  const allowed: Array<[string, string]> = [
    ['check', 'specguard check'],
    ['spec graph', 'specguard spec graph'],
    ['change status', 'specguard change status'],
    ['change done without force', 'specguard change done 20261025-x-a1b2'],
    ['change red', 'specguard change red 20261025-x-a1b2'],
    ['enforce status', 'specguard enforce status'],
    ['history add naming the words', 'specguard history add --why "spec approve later"'],
    ['echo of the words', 'echo specguard spec approve'],
    ['commit message', 'git commit -m "specguard spec approve"'],
    ['grep for the words', 'grep -r "spec approve" docs'],
    ['heredoc body', "cat <<'EOF'\nspecguard spec approve a#b\nEOF"],
    ['comment', 'ls # specguard spec approve a#b'],
    ['tests', 'npm test'],
    ['unterminated quote', 'specguard "spec approve'],
    ['empty', ''],
    ['whitespace', '   \n  '],
  ];

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it.each(allowed)('bash: %s is allowed', (_name, command) => {
    expect(run(bash(command), idx)).toMatchObject({ decision: 'allow', log: { code: 'FREE' } });
  });

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('bash: git notes and refs/notes pushes are denied; other git is allowed', () => {
    for (const c of [
      'git notes --ref=specguard add -m x HEAD',
      'git notes --ref refs/notes/specguard add -m x',
      'git -C repo notes --ref=specguard append -m y',
      'git push origin refs/notes/specguard',
      "git push origin 'refs/notes/*:refs/notes/*'",
      'git -c user.name=x push origin refs/notes/specguard',
      'git update-ref refs/notes/specguard abc123',
    ]) {
      expect(run(bash(c), idx)).toMatchObject({ decision: 'deny', log: { code: 'DENY_BASH_NOTES' } });
    }
    for (const c of ['git notes list', 'git push origin main', 'git log --oneline', 'git status', 'git notes show HEAD']) {
      expect(code(c)).toBe('FREE');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-approval-write-denied]
  it('bash: writes into the history directory are denied; reads are allowed', () => {
    for (const c of [
      'echo x > specs/history/a.md',
      'echo x >> ./specs/history/a.md',
      'echo x 2>/dev/null > specs/history/b.md',
      'echo x &> specs/history/b.md',
      "cat > specs/history/c.md <<'EOF'\nkind: decision\nEOF",
      'echo x | tee specs/history/a.md',
      'tee -a specs/history/a.md < in.txt',
      'cp /tmp/a.md specs/history/a.md',
      'cp -t specs/history /tmp/a.md',
      'mv a.md specs/history/',
      'sed -i s/a/b/ specs/history/a.md',
      'dd if=/tmp/a of=specs/history/a.md',
      'sudo tee specs/history/a.md',
      'echo x > /work/repo/specs/history/a.md',
      'bash -c "echo x > specs/history/a.md"',
    ]) {
      expect(run(bash(c), idx)).toMatchObject({ decision: 'deny', log: { code: 'DENY_APPROVAL_WRITE' } });
    }
    for (const c of ['cat specs/history/a.md', 'cp specs/history/a.md /tmp/x', 'ls specs/history', 'echo x > /tmp/history', 'sed s/a/b/ specs/history/a.md', 'grep -r a specs/history']) {
      expect(code(c)).toBe('FREE');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('the guard applies at every enforce level', () => {
    for (const level of LEVELS) expect(run(bash('specguard spec approve a#b'), levelIndex(level)).decision).toBe('deny');
  });

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('a shell command that also carries a patch is judged on both', () => {
    const event = ev({ tool: 'Bash', agent: 'codex', bash: 'apply_patch <<EOF\n*** Begin Patch\nEOF', paths: ['src/cart/cart.ts'] });
    expect(run(event, levelIndex('enforce')).log.code).toBe('DENY_NO_CHANGE');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('guardBash and splitShell never throw on junk', () => {
    for (const junk of ['"', "'", '$(', '`', '<<', '<<-EOF', '>', '&>', '\\', '$\'', '((((', 'a'.repeat(100_000), '\u0000\u0001', 'eval eval eval eval eval eval eval "eval eval specguard spec approve"']) {
      expect(() => guardBash(junk, 'specs/history')).not.toThrow();
      expect(() => splitShell(junk)).not.toThrow();
    }
    expect(guardBash(undefined as unknown as string)).toBeNull();
  });

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('splitShell separates commands, keeps quoted text whole and records output redirections', () => {
    expect(splitShell('a b && c "d e" ; f \'g h\' | i')).toEqual([
      { words: ['a', 'b'], redirects: [] },
      { words: ['c', 'd e'], redirects: [] },
      { words: ['f', 'g h'], redirects: [] },
      { words: ['i'], redirects: [] },
    ]);
    expect(splitShell('echo hi 2>&1 > out.txt < in.txt')).toEqual([{ words: ['echo', 'hi'], redirects: ['1', 'out.txt'] }]);
  });
});

describe('decide: errors, agents, log and messages', () => {
  const event = edit('src/cart/cart.ts');

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('OUTSIDE_REPO and NOT_SPECGUARD allow silently', () => {
    for (const code of ['OUTSIDE_REPO', 'NOT_SPECGUARD'] as const) {
      const d = systemDecision(code, event);
      expect(d).toMatchObject({ decision: 'allow', log: { code, level: null, caps: [] } });
      expect(d.message).toBeUndefined();
    }
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('ERROR_OPEN allows with a notice that names the cause and says CI still checks', () => {
    const d = systemDecision('ERROR_OPEN', event, 'index is corrupt:\n  unexpected token');
    expect(d).toMatchObject({ decision: 'allow', log: { code: 'ERROR_OPEN' } });
    expect(d.message).toBe('SpecGuard hook could not decide (index is corrupt: unexpected token); edit allowed. CI still checks this change.');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('ERROR_CLOSED denies, and a very long cause is shortened to fit the message limit', () => {
    const d = systemDecision('ERROR_CLOSED', event, 'x'.repeat(5000));
    expect(d).toMatchObject({ decision: 'deny', log: { code: 'ERROR_CLOSED' } });
    expect(d.message!.length).toBeLessThanOrEqual(HOOK_MESSAGE_MAX);
    expect(d.message).toContain('hooks.onError');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('decide and classify do not throw on an empty index or event', () => {
    const d = decide({} as HookEvent, [{ kind: 'owned', capabilities: ['x'] }], {} as HookIndex, { redValid: new Map() });
    expect(d.decision).toBe('allow');
    expect(decide({} as HookEvent, [], {} as HookIndex, { redValid: new Map() }).decision).toBe('allow');
    expect(decide(ev({ bash: 'ls' }), [{ kind: 'history', approvalLike: false }], {} as HookIndex, { redValid: new Map() }).decision).toBe('allow');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open]
  it('an owned file whose capability is missing from the index is treated as observe', () => {
    const d = decide(edit('src/x.ts'), [{ kind: 'owned', capabilities: ['ghost'] }], makeIndex(), { redValid: new Map() });
    expect(d).toMatchObject({ decision: 'allow', log: { code: 'OBSERVED', level: 'observe' } });
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('codex ask becomes deny', () => {
    const ask: HookDecision = { decision: 'ask', message: 'm', log: { ts: '', tool: 'apply_patch', paths: [], caps: [], level: null, decision: 'ask', code: 'DENY_NO_CHANGE' } };
    expect(forAgent(ask, 'codex')).toMatchObject({ decision: 'deny', message: 'm', log: { decision: 'deny' } });
    expect(forAgent(ask, 'claude').decision).toBe('ask');
    const allow: HookDecision = { ...ask, decision: 'allow', log: { ...ask.log, decision: 'allow' } };
    expect(forAgent(allow, 'codex')).toBe(allow);
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths]
  it('a codex apply_patch event is judged like a claude edit and logs the agent', () => {
    const d = run(ev({ tool: 'apply_patch', agent: 'codex', paths: ['src/cart/cart.ts'], subagent: 'worker' }), levelIndex('enforce'));
    expect(d).toMatchObject({ decision: 'deny', log: { agent: 'codex', tool: 'apply_patch', code: 'DENY_NO_CHANGE' } });
  });

  // [claims: capabilities/spec-first-changes#hook-observe-logs]
  it('the log entry carries the tool, paths, caps, level, decision and code, and the entry stamps time and session', () => {
    const d = run(edit('src/cart/cart.ts'), levelIndex('warn'));
    expect(d.log).toEqual({ ts: '', agent: 'claude', tool: 'Edit', paths: ['src/cart/cart.ts'], caps: ['cart'], level: 'warn', decision: 'allow', code: 'WARN_NO_CHANGE' });
    const stamped = withLogContext(d, { ts: '2026-10-25T12:00:00.000Z', session: 's1' });
    expect(stamped.log).toMatchObject({ ts: '2026-10-25T12:00:00.000Z', session: 's1', code: 'WARN_NO_CHANGE' });
    expect(withLogContext(d, { ts: 't' }).log).not.toHaveProperty('session');
    expect(d.log.ts).toBe('');
  });

  // [claims: capabilities/spec-first-changes#hook-messages-short]
  it('messages are at most 300 chars and contain one command', () => {
    const longCaps = ['a-very-long-capability-identifier-one', 'a-very-long-capability-identifier-two', 'a-very-long-capability-identifier-three', 'four'];
    const longId = '20261025-an-extremely-long-slug-for-a-change-that-goes-on-and-on-and-on-a1b2';
    const idx = (level: EnforceLevel, c: Change[]) => ({ ...makeIndex({}, c), capabilities: longCaps.map((id) => ({ id, specFile: `specs/capabilities/${id}.md`, enforce: level, sources: ['src/x/**'] })) });
    const messages: string[] = [];
    for (const level of LEVELS) {
      for (const changes of [
        [],
        [change({ id: longId, capabilities: longCaps, approvedAll: false, red: undefined })],
        [change({ id: longId, capabilities: longCaps, red: undefined })],
        [change({ id: longId, capabilities: longCaps, kind: 'spike' })],
        [change({ id: longId, capabilities: longCaps, lockedTests: ['tests/t.test.ts'] })],
      ]) {
        const index = idx(level, changes);
        for (const p of ['src/x/a.ts', 'tests/t.test.ts', 'specs/capabilities/four.md', '.specguard/config.json']) {
          const classes = [p === 'src/x/a.ts' ? ({ kind: 'owned', capabilities: longCaps } as PathClass) : classify(p, index, glob)];
          const d = decide(edit(p), classes, index, { redValid: new Map() });
          if (d.message) messages.push(d.message);
        }
      }
    }
    messages.push(
      run(edit('src/cart/cart.ts'), levelIndex('enforce')).message!,
      run(ev({ paths: ['specs/history/a.md'], newText: 'kind: approval' }), levelIndex('enforce')).message!,
      run(edit('.specguard/changes/gone-ffff.json'), levelIndex('enforce')).message!,
      run(bash('specguard spec approve a'), levelIndex('enforce')).message!,
      run(bash('specguard enforce lower cart --to observe --why x'), levelIndex('enforce')).message!,
      run(bash('specguard change convert x'), levelIndex('enforce')).message!,
      run(bash('specguard proof publish'), levelIndex('enforce')).message!,
      run(bash('git notes --ref=specguard add'), levelIndex('enforce')).message!,
      run(bash('echo x > specs/history/a.md'), levelIndex('enforce')).message!,
      systemDecision('ERROR_OPEN', event0(), 'boom').message!,
      systemDecision('ERROR_CLOSED', event0(), 'boom').message!,
    );
    expect(messages.length).toBeGreaterThan(20);
    for (const m of messages) {
      expect(m.length).toBeLessThanOrEqual(HOOK_MESSAGE_MAX);
      expect(m).not.toContain('\n');
      // Error notices name no command to run, or exactly one: the rebuild.
      expect((m.match(/specguard [a-z]/g) ?? []).length).toBeLessThanOrEqual(1);
      if (!m.startsWith('SpecGuard hook could not decide (boom); edit allowed')) expect((m.match(/specguard [a-z]/g) ?? []).length).toBe(1);
    }
  });

  // [claims: capabilities/spec-first-changes#hook-messages-short]
  it('the denial text matches the documented wording', () => {
    expect(run(edit('src/cart/cart.ts'), levelIndex('enforce')).message).toBe('cart is at enforce: start a change before editing its code. Run: specguard change start cart --why "<what>"');
    expect(run(bash('specguard spec approve a#b'), levelIndex('enforce')).message).toBe(
      "Approving requirements is a person's decision. Ask them to run it in their own terminal: specguard spec approve <refs>",
    );
  });
});

function event0(): HookEvent {
  return ev({ paths: ['src/cart/cart.ts'] });
}
