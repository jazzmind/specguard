import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ConfigInvalidError } from '../../src/core/errors.js';
import {
  APPROVALS_CI_DEFAULTS,
  CHANGE_DEFAULTS,
  CI_DEFAULTS,
  ENFORCE_DEFAULTS,
  HOOKS_DEFAULTS,
  PROOF_STORE_DEFAULTS,
  UNREQUESTED_DEFAULTS,
} from '../../src/core/types.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const APP = {
  name: 'app',
  repo: '.',
  specDir: 'specs',
  sources: { routes: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] },
  framework: 'vitest',
  testOutput: 'tests/',
};

/** Load a config made of one app plus the given top-level keys (and optional changes to the app). */
async function load(extra: Record<string, unknown> = {}, app: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'specguard-cfg3-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.specguard'));
  writeFileSync(path.join(dir, '.specguard', 'config.json'), JSON.stringify({ apps: [{ ...APP, ...app }], ...extra }));
  return loadConfig(dir);
}
const rejects = (extra: Record<string, unknown>, app: Record<string, unknown> = {}) => expect(load(extra, app)).rejects.toBeInstanceOf(ConfigInvalidError);

describe('config: Phase 3 blocks [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#config-validation]
  it('an old config parses unchanged: none of the new blocks appears', async () => {
    const config = await load({ proof: { requireApproval: true }, mutation: { minScore: 60 }, coverage: { pathPrefixes: ['/ci/'] } }, { test: { command: 'npm test', coverage: undefined } });
    for (const key of ['proofStore', 'change', 'enforce', 'hooks', 'approvals', 'unrequested', 'ci']) expect(config, key).not.toHaveProperty(key);
    expect(config.mutation).toEqual({ minScore: 60 });
    expect(config.apps[0].test).toEqual({ command: 'npm test' });
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('the repository\'s own config still loads', async () => {
    const config = await loadConfig(path.resolve(__dirname, '..', '..'));
    expect(config.apps.length).toBeGreaterThan(0);
  });

  // [claims: capabilities/platform-foundation#config-apps-and-defaults]
  it('an empty block takes every default, and the defaults are the exported constants', async () => {
    const config = await load({ proofStore: {}, change: {}, enforce: {}, hooks: {}, approvals: { ci: {} }, unrequested: {}, ci: {} });
    expect(config.proofStore).toEqual(PROOF_STORE_DEFAULTS);
    expect(config.change).toEqual(CHANGE_DEFAULTS);
    expect(config.enforce).toEqual(ENFORCE_DEFAULTS);
    expect(config.hooks).toEqual(HOOKS_DEFAULTS);
    expect(config.approvals?.ci).toEqual(APPROVALS_CI_DEFAULTS);
    expect(config.unrequested).toEqual(UNREQUESTED_DEFAULTS);
    expect(config.ci).toEqual(CI_DEFAULTS);
    // the owner's decisions: notes are not authenticated unless asked, hooks fail open, a review is needed at enforce, no self-approval
    expect(PROOF_STORE_DEFAULTS.verify).toBe('off');
    expect(HOOKS_DEFAULTS.onError).toBe('allow');
    expect(APPROVALS_CI_DEFAULTS).toEqual({ requireReview: 'enforce', allowSelf: false });
    expect(ENFORCE_DEFAULTS.default).toBe('observe');
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('accepts every new key with good values', async () => {
    const config = await load(
      {
        proofStore: { notesRef: 'refs/notes/proofs', remote: 'upstream', maxWalk: 50, verify: 'check-run', autoFetch: 'off', pruneDays: 30 },
        change: { baseRef: 'origin/develop', redAcceptsErrors: 'never', requireChangeRecord: false, worktreeLinks: ['node_modules', 'packages/a/node_modules'] },
        enforce: { default: 'warn', newCapabilities: 'enforce' },
        hooks: { onError: 'deny', bashGuard: true },
        approvals: { ci: { requireReview: 'always', allowSelf: true } },
        unrequested: { severity: 'warn' },
        ci: { capabilityCoverage: false },
        mutation: { command: 'npx stryker run --mutate {files}' },
      },
      { test: { command: 'npm test', coverage: { flags: '--coverage', reports: ['coverage/lcov.info', 'coverage/*.xml'], format: 'lcov' } } },
    );
    expect(config.proofStore).toEqual({ notesRef: 'refs/notes/proofs', remote: 'upstream', maxWalk: 50, verify: 'check-run', autoFetch: 'off', pruneDays: 30 });
    expect(config.change).toEqual({ baseRef: 'origin/develop', redAcceptsErrors: 'never', requireChangeRecord: false, worktreeLinks: ['node_modules', 'packages/a/node_modules'] });
    expect(config.enforce).toEqual({ default: 'warn', newCapabilities: 'enforce' });
    expect(config.hooks).toEqual({ onError: 'deny', bashGuard: true });
    expect(config.approvals?.ci).toEqual({ requireReview: 'always', allowSelf: true });
    expect(config.unrequested).toEqual({ severity: 'warn' });
    expect(config.ci).toEqual({ capabilityCoverage: false });
    expect(config.mutation?.command).toBe('npx stryker run --mutate {files}');
    expect(config.apps[0].test?.coverage).toEqual({ flags: '--coverage', reports: ['coverage/lcov.info', 'coverage/*.xml'], format: 'lcov' });
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('keeps unknown keys inside the new blocks, so a newer config still loads', async () => {
    const config = await load({ proofStore: { futureKey: 1 }, hooks: { futureKey: true } }, { test: { coverage: { reports: ['c.info'], futureKey: 'x' } } });
    expect((config.proofStore as Record<string, unknown>).futureKey).toBe(1);
    expect((config.hooks as Record<string, unknown>).futureKey).toBe(true);
    expect((config.apps[0].test?.coverage as Record<string, unknown>).futureKey).toBe('x');
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('rejects bad proofStore values', async () => {
    await rejects({ proofStore: { verify: 'none' } }); // 'off' and 'check-run' only
    await rejects({ proofStore: { verify: true } });
    await rejects({ proofStore: { autoFetch: 'always' } });
    await rejects({ proofStore: { notesRef: 'refs/heads/main' } }); // must be a notes ref
    await rejects({ proofStore: { notesRef: 'specguard' } });
    await rejects({ proofStore: { remote: '--upload-pack=sh' } }); // would read as an option
    await rejects({ proofStore: { remote: '' } });
    await rejects({ proofStore: { maxWalk: 0 } });
    await rejects({ proofStore: { maxWalk: 1.5 } });
    await rejects({ proofStore: { pruneDays: -1 } });
    await rejects({ proofStore: 'notes' });
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('rejects bad change values', async () => {
    await rejects({ change: { redAcceptsErrors: 'sometimes' } });
    await rejects({ change: { baseRef: '--output=x' } });
    await rejects({ change: { baseRef: '' } });
    await rejects({ change: { requireChangeRecord: 'yes' } });
    await rejects({ change: { worktreeLinks: '../node_modules' } });
    await rejects({ change: { worktreeLinks: ['../node_modules'] } }); // must stay inside the repository
    await rejects({ change: { worktreeLinks: ['/etc'] } });
    await rejects({ change: { worktreeLinks: [''] } });
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('rejects bad enforce, hooks, approvals, unrequested and ci values', async () => {
    await rejects({ enforce: { default: 'strict' } });
    await rejects({ enforce: { newCapabilities: 'block' } });
    await rejects({ hooks: { onError: 'block' } });
    await rejects({ hooks: { bashGuard: 'on' } });
    await rejects({ approvals: { ci: { requireReview: 'sometimes' } } });
    await rejects({ approvals: { ci: { allowSelf: 'yes' } } });
    await rejects({ approvals: { ci: 'review' } });
    await rejects({ unrequested: { severity: 'fatal' } });
    await rejects({ ci: { capabilityCoverage: 'yes' } });
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('rejects bad apps[].test.coverage and mutation.command values', async () => {
    await rejects({}, { test: { coverage: { flags: '--coverage' } } }); // reports are required
    await rejects({}, { test: { coverage: { reports: [] } } });
    await rejects({}, { test: { coverage: { reports: [''] } } });
    await rejects({}, { test: { coverage: { reports: 'lcov.info' } } });
    await rejects({}, { test: { coverage: { reports: ['c.info'], format: 'clover' } } });
    await rejects({}, { test: { coverage: { reports: ['c.info'], flags: 3 } } });
    await rejects({ mutation: { command: '' } });
    await rejects({ mutation: { command: 7 } });
  });

  // [claims: capabilities/platform-foundation#config-validation]
  it('accepts the auto format and every report format', async () => {
    for (const format of ['auto', 'lcov', 'jacoco', 'cobertura', 'go']) {
      const config = await load({}, { test: { coverage: { reports: ['c.out'], format } } });
      expect(config.apps[0].test?.coverage?.format).toBe(format);
    }
  });

  // [claims: capabilities/platform-foundation#config-extends]
  it('an extended config can set the blocks, and the child overrides one level deep', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'specguard-cfg3-p-'));
    dirs.push(parent);
    mkdirSync(path.join(parent, '.specguard'));
    writeFileSync(path.join(parent, '.specguard', 'config.json'), JSON.stringify({ apps: [APP], enforce: { default: 'warn', newCapabilities: 'enforce' }, hooks: { onError: 'deny' } }));
    const child = mkdtempSync(path.join(tmpdir(), 'specguard-cfg3-c-'));
    dirs.push(child);
    mkdirSync(path.join(child, '.specguard'));
    writeFileSync(path.join(child, '.specguard', 'config.json'), JSON.stringify({ extends: parent, apps: [APP], enforce: { default: 'enforce' } }));
    const config = await loadConfig(child);
    expect(config.enforce).toEqual({ default: 'enforce', newCapabilities: 'enforce' });
    expect(config.hooks).toEqual({ onError: 'deny', bashGuard: false });
  });
});
