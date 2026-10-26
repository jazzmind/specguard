import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { OVERLAY_ENV } from '../../src/core/overlay.js';
import { findProject } from '../../src/hooks/entry.js';
import { makeNestedWorkspace, makeOverlayWorkspace, type OverlayWorkspace } from '../helpers/overlay-fixture.js';
import { runBundle } from '../helpers/hook-repo.js';

const edit = (cwd: string, file: string): string =>
  JSON.stringify({ session_id: 's-1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });

const run = (ws: OverlayWorkspace, cwd: string, file: string, env: NodeJS.ProcessEnv = ws.env) => runBundle(edit(cwd, file), { cwd, env });
const decisionOf = (r: ReturnType<typeof runBundle>): string => String(r.json?.hookSpecificOutput.permissionDecision ?? 'allow');

describe('the edit guard in overlay mode [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('denies an edit to an owned file of a repo whose specs live in the overlay, with the normal message', () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce' });
    const r = run(ws, ws.api, path.join(ws.api, 'src/shop/cart.ts'));
    expect(r.status, r.stderr).toBe(0);
    expect(decisionOf(r)).toBe('deny');
    expect(String(r.json?.hookSpecificOutput.permissionDecisionReason)).toContain('shop is at enforce: start a change');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('judges from a nested directory of the repo, and a file the specs do not own is allowed silently', () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce' });
    expect(decisionOf(run(ws, path.join(ws.api, 'src/shop'), path.join(ws.api, 'src/shop/cart.ts')))).toBe('deny');
    const free = run(ws, ws.api, path.join(ws.api, 'src/orphan.ts'));
    expect(free.stdout).toBe('');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('writes its index and decision log into the overlay and nothing into the application repo', () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce', git: true });
    run(ws, ws.api, path.join(ws.api, 'src/shop/cart.ts'));
    expect(existsSync(path.join(ws.api, '.specguard'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: ws.api, encoding: 'utf8' })).toBe('');
    expect(readFileSync(path.join(ws.apiApp, '.specguard/cache/hooks.jsonl'), 'utf8')).toContain('DENY_NO_CHANGE');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('lets an edit to an overlay file through when the session is opened in the repo: it is outside the repo', () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce' });
    const r = run(ws, ws.api, path.join(ws.apiApp, 'specs/capabilities/shop.md'));
    expect(r.stdout).toBe('');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it("does not mistake the repo's own specs/ folder for the overlay's specs", () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce' });
    ws.write(path.join(ws.api, 'specs/capabilities/shop.md'), '# not a spec\n');
    expect(run(ws, ws.api, path.join(ws.api, 'specs/capabilities/shop.md')).stdout).toBe('');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('is silent when no overlay covers the repo, and for a repo the overlay does not name', () => {
    const none = makeOverlayWorkspace({ shop: 'enforce', registered: false });
    expect(run(none, none.api, path.join(none.api, 'src/shop/cart.ts')).stdout).toBe('');
    const ws = makeOverlayWorkspace({ shop: 'enforce' });
    expect(run(ws, ws.web, path.join(ws.web, 'src/index.ts')).stdout).toBe('');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('works from SPECGUARD_OVERLAY alone, with no registration', () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce', registered: false });
    const env = { ...ws.env, [OVERLAY_ENV]: ws.specs };
    expect(decisionOf(run(ws, ws.api, path.join(ws.api, 'src/shop/cart.ts'), env))).toBe('deny');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('stays quick once the index is cached (generous bound: 1 s per call)', () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce' });
    run(ws, ws.api, path.join(ws.api, 'src/shop/cart.ts'));
    const warm = run(ws, ws.api, path.join(ws.api, 'src/shop/cart.ts'));
    expect(decisionOf(warm)).toBe('deny');
    expect(warm.ms).toBeLessThan(1000);
  });

  // [claims: capabilities/integration-surfaces#hook-overlay]
  it('fails open: two overlay configs for one repo give silence, not a guess or an error', () => {
    const ws = makeOverlayWorkspace({ shop: 'enforce' });
    ws.write(path.join(ws.specs, 'apps/api2/.specguard/config.json'), JSON.stringify({ apps: [{ name: 'api2', repo: '../../../shop-api', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' }] }));
    expect(findProject(ws.api, { ...ws.env, [OVERLAY_ENV]: ws.specs })).toBeNull();
    expect(run(ws, ws.api, path.join(ws.api, 'src/shop/cart.ts'), { ...ws.env, [OVERLAY_ENV]: ws.specs }).stdout).toBe('');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay, capabilities/platform-foundation#overlay-enclosing-git-root]
  it('with the entry pointing at a nested app folder, a session opened at the git root denies an edit inside the app and is silent outside it', () => {
    const ws = makeNestedWorkspace({ shop: 'enforce' });
    const run2 = (file: string, cwd: string = ws.webRoot) => runBundle(edit(cwd, file), { cwd, env: ws.env });
    const denied = run2(path.join(ws.webApp, 'src/shop/cart.ts'));
    expect(denied.status, denied.stderr).toBe(0);
    expect(decisionOf(denied)).toBe('deny');
    expect(String(denied.json?.hookSpecificOutput.permissionDecisionReason)).toContain('shop is at enforce: start a change');
    // a file in the git repository but outside the app folder is not owned: allowed silently
    expect(run2(path.join(ws.webRoot, 'ci/build.ts')).stdout).toBe('');
    expect(run2(path.join(ws.webRoot, 'README.md')).stdout).toBe('');
    // unowned files inside the app folder are classified normally (free)
    expect(run2(path.join(ws.webApp, 'src/orphan.ts')).stdout).toBe('');
    // the same edit from inside the app folder gives the same answer
    expect(decisionOf(run2(path.join(ws.webApp, 'src/shop/cart.ts'), ws.webApp))).toBe('deny');
    // the cache and log are in the overlay; nothing in the app repo
    expect(existsSync(path.join(ws.webRoot, '.specguard'))).toBe(false);
    expect(existsSync(path.join(ws.webApp, '.specguard'))).toBe(false);
    expect(readFileSync(path.join(ws.webSpecs, '.specguard/cache/hooks.jsonl'), 'utf8')).toContain('DENY_NO_CHANGE');
  });

  // [claims: capabilities/integration-surfaces#hook-overlay, capabilities/platform-foundation#overlay-enclosing-git-root]
  it('is silent at the root of a git repo whose apps each have an entry (ambiguous), above a git root, and outside any repo', () => {
    const ws = makeNestedWorkspace({ shop: 'enforce' });
    const at = (cwd: string, file: string) => runBundle(edit(cwd, file), { cwd, env: ws.env });
    expect(at(ws.monoRoot, path.join(ws.monoRoot, 'apps/a/src/a.ts')).stdout).toBe('');
    expect(at(ws.base, path.join(ws.webApp, 'src/shop/cart.ts')).stdout).toBe('');
    expect(at(ws.loose, path.join(ws.loose, 'x.ts')).stdout).toBe('');
    expect(findProject(ws.webRoot, ws.env)).toMatchObject({ root: ws.webApp, stateRoot: ws.webSpecs });
    expect(findProject(ws.monoRoot, ws.env)).toBeNull();
  });
});
