import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { HOOK_MESSAGE_MAX } from '../../src/hooks/decide.js';
import { CHANGE_ID, claudePayload, editOf, hookRepo, readLog, runBundle, writeChange, writeRed } from '../helpers/hook-repo.js';

const ctxOf = (r: ReturnType<typeof runBundle>): string => String(r.json?.hookSpecificOutput.additionalContext ?? '');

describe('the hook entry, spawned as the plugin runs it [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#hook-entry-protocol, capabilities/spec-first-changes#hook-enforce-denies-code]
  it('prints a deny as hookSpecificOutput with permissionDecision and the reason, and exits 0', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const r = runBundle(editOf(repo, 'src/shop/cart.ts'));
    expect(r.status).toBe(0);
    expect(r.json).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'shop is at enforce: start a change before editing its code. Run: specguard change start shop --why "<what>"',
      },
    });
    expect(String(r.json?.hookSpecificOutput.permissionDecisionReason).length).toBeLessThanOrEqual(HOOK_MESSAGE_MAX);
  });

  // [claims: capabilities/spec-first-changes#hook-entry-protocol, capabilities/spec-first-changes#hook-warn-names-next-step]
  it('prints a warning as additionalContext without a permissionDecision, so it never skips the permission prompt', () => {
    const repo = hookRepo({ shop: 'warn' });
    const r = runBundle(editOf(repo, 'src/shop/cart.ts'));
    expect(r.status).toBe(0);
    expect(r.json).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'SpecGuard (warn): shop is at warn: start a change before editing its code. Run: specguard change start shop --why "<what>"',
      },
    });
  });

  // [claims: capabilities/spec-first-changes#hook-entry-protocol, capabilities/spec-first-changes#hook-observe-logs, capabilities/spec-first-changes#hook-decision-log]
  it('observe allows in silence and logs the decision', () => {
    const repo = hookRepo({ shop: 'observe' });
    const r = runBundle(editOf(repo, 'src/shop/cart.ts'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readLog(repo)).toEqual([expect.objectContaining({ code: 'OBSERVED', decision: 'allow', tool: 'Edit', paths: ['src/shop/cart.ts'], caps: ['shop'], level: 'observe', session: 's-1', agent: 'claude' })]);
  });

  // [claims: capabilities/spec-first-changes#hook-spec-test-free]
  it('allows specs, tests and unowned files at enforce, without a word', () => {
    const repo = hookRepo({ shop: 'enforce', auth: 'enforce' });
    for (const rel of ['specs/capabilities/shop.md', 'tests/shop.test.ts', 'src/orphan.ts']) {
      const r = runBundle(editOf(repo, rel));
      expect(r.stdout, rel).toBe('');
    }
  });

  // [claims: capabilities/spec-first-changes#hook-change-kinds, capabilities/spec-first-changes#hook-entry-protocol]
  it('lets an open refactor change edit code at enforce', () => {
    const repo = hookRepo({ shop: 'enforce' });
    writeChange(repo, 'refactor');
    const r = runBundle(editOf(repo, 'src/shop/cart.ts'));
    expect(r.stdout).toBe('');
    expect(readLog(repo).at(-1)).toMatchObject({ code: 'ALLOW_REFACTOR', change: CHANGE_ID });
  });

  // [claims: capabilities/spec-first-changes#hook-stage-lock, capabilities/spec-first-changes#hook-live-red]
  it('answers an edit to a locked test with the back-at-red message, then notices the edit through the live red check', () => {
    const repo = hookRepo({ shop: 'enforce' });
    writeChange(repo, 'feature');
    writeRed(repo, ['tests/shop.test.ts']);
    const first = runBundle(editOf(repo, 'tests/shop.test.ts'));
    expect(ctxOf(first)).toContain(`change ${CHANGE_ID} is back at "red"`);
    expect(ctxOf(first)).toContain(`specguard change red ${CHANGE_ID}`);
    expect(readLog(repo).at(-1)).toMatchObject({ code: 'LOCK_TESTS', decision: 'allow', change: CHANGE_ID });

    // The test is now edited: no index rebuild is needed for the guard to see that red no longer holds (it re-hashes live).
    writeFileSync(path.join(repo.dir, 'tests/shop.test.ts'), "it('totals @claim:capabilities/shop#cart-totals', () => { /* edited */ });\n");
    const second = runBundle(editOf(repo, 'src/shop/cart.ts'));
    expect(second.json?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readLog(repo).at(-1)).toMatchObject({ code: expect.stringMatching(/^DENY_(BEFORE_RED|NOT_APPROVED)$/) });
  });

  // [claims: capabilities/spec-first-changes#hook-agent-bash-guard]
  it('denies a Bash command that approves requirements, and allows an ordinary one', () => {
    const repo = hookRepo({ shop: 'observe' });
    const denied = runBundle(claudePayload(repo, { tool: 'Bash', input: { command: 'npx -y -p specguard-ai specguard spec approve shop --yes' } }));
    expect(denied.json?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(String(denied.json?.hookSpecificOutput.permissionDecisionReason)).toContain("a person's decision");
    expect(readLog(repo).at(-1)).toMatchObject({ code: 'DENY_BASH_APPROVE', tool: 'Bash' });

    const ok = runBundle(claudePayload(repo, { tool: 'Bash', input: { command: 'git status && npm test' } }));
    expect(ok.stdout).toBe('');
  });

  // [claims: capabilities/spec-first-changes#hook-codex-patch-paths, capabilities/spec-first-changes#hook-entry-protocol]
  it('reads a Codex apply_patch payload and denies when any patched path is guarded', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const patch = ['*** Begin Patch', '*** Update File: src/orphan.ts', '@@', '-a', '+b', '*** Update File: src/shop/cart.ts', '@@', '-a', '+b', '*** End Patch'].join('\n');
    const payload = JSON.stringify({ session_id: 'c-1', turn_id: 'turn-1', cwd: repo.dir, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch }, model: 'm' });
    const r = runBundle(payload, { args: ['pre-tool-use', '--agent', 'codex'] });
    expect(r.status).toBe(0);
    expect(r.json?.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(readLog(repo).at(-1)).toMatchObject({ agent: 'codex', tool: 'apply_patch', paths: ['src/orphan.ts', 'src/shop/cart.ts'] });
  });

  // [claims: capabilities/spec-first-changes#hook-silent-outside-project]
  it('is silent, and writes nothing, in a directory with no SpecGuard config', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-nohook-'));
    const r = runBundle(JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.ts'), content: 'x' } }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(existsSync(path.join(dir, '.specguard'))).toBe(false);
  });

  // [claims: capabilities/spec-first-changes#hook-silent-outside-project]
  it('is silent for a path outside the repository and logs nothing for it', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const outside = path.join(mkdtempSync(path.join(os.tmpdir(), 'sg-elsewhere-')), 'notes.md');
    const r = runBundle(claudePayload(repo, { tool: 'Write', input: { file_path: outside, content: 'x' } }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readLog(repo)).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#hook-silent-outside-project]
  it('finds the project from a subdirectory', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const sub = path.join(repo.dir, 'src', 'shop');
    const r = runBundle(JSON.stringify({ cwd: sub, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'cart.ts', old_string: 'a', new_string: 'b' } }));
    expect(r.json?.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // [claims: capabilities/spec-first-changes#hook-silent-outside-project]
  it('treats a path reached through a symlink to the repository as inside it', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'sg-link-')), 'repo-link');
    symlinkSync(repo.dir, link);
    const r = runBundle(claudePayload(repo, { tool: 'Edit', input: { file_path: path.join(link, 'src/shop/cart.ts'), old_string: 'a', new_string: 'b' } }));
    expect(r.json?.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open, capabilities/spec-first-changes#hook-entry-fail-open-message]
  it('fails open with a notice on malformed JSON in a SpecGuard project', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const r = runBundle('{ this is not json', { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.json?.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(ctxOf(r)).toMatch(/could not decide .*edit allowed\. CI still checks this change\./);
    expect(readLog(repo).at(-1)).toMatchObject({ code: 'ERROR_OPEN', decision: 'allow' });
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open, capabilities/spec-first-changes#hook-entry-fail-open-message]
  it('allows a payload with an unknown tool or event without a word', () => {
    const repo = hookRepo({ shop: 'enforce' });
    expect(runBundle(claudePayload(repo, { tool: 'Read', input: { file_path: path.join(repo.dir, 'src/shop/cart.ts') } })).stdout).toBe('');
    expect(runBundle(JSON.stringify({ cwd: repo.dir, hook_event_name: 'SessionStart', source: 'startup' })).stdout).toBe('');
    expect(runBundle('', { cwd: repo.dir }).status).toBe(0);
  });

  // [claims: capabilities/spec-first-changes#hook-fails-open, capabilities/spec-first-changes#hook-on-error-deny]
  it('an unreadable config allows with ERROR_OPEN by default, and denies with ERROR_CLOSED under hooks.onError deny', () => {
    for (const onError of ['allow', 'deny'] as const) {
      const repo = hookRepo({ shop: 'enforce', config: { hooks: { onError } } });
      expect(runBundle(editOf(repo, 'src/shop/cart.ts')).json?.hookSpecificOutput.permissionDecision).toBe('deny'); // a good index first
      // The config no longer parses, so the index cannot be rebuilt.
      writeFileSync(path.join(repo.dir, '.specguard/config.json'), JSON.stringify({ apps: 'broken', hooks: { onError } }));
      const r = runBundle(editOf(repo, 'src/shop/cart.ts'));
      expect(r.status).toBe(0);
      if (onError === 'allow') {
        expect(r.json?.hookSpecificOutput.permissionDecision).toBeUndefined();
        expect(ctxOf(r)).toContain('edit allowed');
        expect(readLog(repo).at(-1)).toMatchObject({ code: 'ERROR_OPEN', decision: 'allow' });
      } else {
        expect(r.json?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
        expect(String(r.json?.hookSpecificOutput.permissionDecisionReason)).toContain('hooks.onError is "deny"');
        expect(readLog(repo).at(-1)).toMatchObject({ code: 'ERROR_CLOSED', decision: 'deny' });
      }
    }
  });

  // [claims: capabilities/spec-first-changes#hook-index-cache]
  it('rebuilds a stale index in process: a spec raised to enforce binds on the very next call', () => {
    const repo = hookRepo({ shop: 'observe' });
    expect(runBundle(editOf(repo, 'src/shop/cart.ts')).stdout).toBe('');
    const spec = path.join(repo.dir, 'specs/capabilities/shop.md');
    writeFileSync(spec, readFileSync(spec, 'utf8').replace('enforce: observe', 'enforce: enforce'));
    expect(runBundle(editOf(repo, 'src/shop/cart.ts')).json?.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // [claims: capabilities/spec-first-changes#hook-speed]
  it('answers well inside a second on a warm index', () => {
    const repo = hookRepo({ shop: 'enforce' });
    runBundle(editOf(repo, 'src/shop/cart.ts')); // builds and caches the index
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) times.push(runBundle(editOf(repo, 'src/shop/cart.ts')).ms);
    times.sort((a, b) => a - b);
    expect(times[2]!, `median ${times[2]} ms, all ${times.map((t) => Math.round(t)).join(', ')}`).toBeLessThan(1000);
  });

  // [claims: capabilities/spec-first-changes#hook-decision-log]
  it('rolls the log over past 1 MB instead of growing without bound', () => {
    const repo = hookRepo({ shop: 'observe' });
    runBundle(editOf(repo, 'src/shop/cart.ts'));
    const log = path.join(repo.dir, '.specguard/cache/hooks.jsonl');
    writeFileSync(log, `${'x'.repeat(1_000_100)}\n`);
    runBundle(editOf(repo, 'src/shop/cart.ts'));
    expect(readFileSync(path.join(repo.dir, '.specguard/cache/hooks.1.jsonl'), 'utf8').length).toBeGreaterThan(1_000_000);
    expect(readLog(repo)).toHaveLength(1);
  });
});
