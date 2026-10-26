import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { listHistory } from '../../src/core/history.js';
import { registerEnforceCommands } from '../../src/cli/commands/enforce.js';
import { enumerateClaims, runSpecApprove } from '../../src/pipelines/approve.js';
import { runCoverageIngest } from '../../src/pipelines/coverage-ingest.js';
import { runEnforceLower, runEnforceRaise, runEnforceShow } from '../../src/pipelines/enforce.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import type { TmpRepo } from '../helpers/repo.js';
import { AUTH_SPEC, gitCommit, gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const PERSON = { agent: false, tty: true };
const AGENT = { agent: true, tty: false };
const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';
const STRONG = "// [claims: capabilities/auth#login-valid-code]\nit('logs in', () => { expect(1 + 1).toBe(2); });\n// [claims: capabilities/auth#logout-clears-session]\nit('logs out', () => { expect(2 + 2).toBe(4); });\n";
const LCOV = 'SF:src/auth/login.ts\nDA:1,3\nDA:2,1\nend_of_record\nSF:src/auth/logout.ts\nDA:1,1\nend_of_record\n';

const read = (repo: TmpRepo, rel: string) => readFileSync(path.join(repo.dir, rel), 'utf8');
const AUTH = 'specs/capabilities/auth.md';
const withEnforce = (level: string) => AUTH_SPEC.replace('kind: capability\n', `kind: capability\nenforce: ${level}\n`);

/** A repo where auth is at `level`. */
function repoAt(level?: string, extra: Record<string, unknown> = {}): TmpRepo {
  const repo = makeV2Repo(extra);
  if (level) repo.write(AUTH, withEnforce(level));
  return repo;
}

/** One approved, proven, covered capability with CI evidence on a clean commit: certified. */
async function certifiedRepo(level?: string): Promise<TmpRepo> {
  const repo = makeV2Repo();
  rmSync(path.join(repo.dir, 'specs/capabilities/shop.md'));
  rmSync(path.join(repo.dir, 'src/shop'), { recursive: true });
  const spec = (level ? withEnforce(level) : AUTH_SPEC).replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "src/orphan.ts"\n  - "src/core/awards.ts"\n');
  repo.write(AUTH, spec);
  repo.write('tests/auth.test.ts', STRONG);
  repo.write('lcov.info', LCOV);
  const config = await loadConfig(repo.dir);
  await runSpecApprove(config, { all: true, yes: true, by: 'Ada', actor: PERSON });
  await ingestVerdicts({ runId: 'run-1', verdicts: [{ claim: LOGIN, verdict: 'proven' }, { claim: LOGOUT, verdict: 'proven' }] }, repo.dir, { provenance: { origin: 'ci' } });
  await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'auth', selection: 'tests', runId: 'cov-1', origin: 'ci' });
  gitInit(repo.dir);
  return repo;
}

describe('enforce show [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-show]
  it('prints every capability with its level and where it comes from', async () => {
    const repo = repoAt('warn');
    const r = await runEnforceShow(await loadConfig(repo.dir));
    expect(r.exitCode).toBe(0);
    expect(r.items.map((i) => `${i.key}:${i.message}`)).toEqual(['auth:warn', 'shop:observe']);
    const text = r.messages.join('\n');
    expect(text).toMatch(/auth\s+warn\s+.*\(set\)/);
    expect(text).toMatch(/shop\s+observe\s+.*\(default observe\)/);
    expect(text).toContain('can raise to warn');
  });

  // [claims: capabilities/spec-first-changes#enforce-show, capabilities/spec-first-changes#enforce-default-observe]
  it('a capability with no enforce: takes enforce.default from the config, and one capability can be asked for by id', async () => {
    const repo = repoAt(undefined, { enforce: { default: 'warn' } });
    const r = await runEnforceShow(await loadConfig(repo.dir), { targets: ['shop'] });
    expect(r.items.map((i) => `${i.key}:${i.message}`)).toEqual(['shop:warn']);
    expect(r.messages[0]).toContain('(default warn)');
    const bad = await runEnforceShow(await loadConfig(repo.dir), { targets: ['nope'] });
    expect(bad.exitCode).toBe(ExitCode.ValidationFailed);
  });

  // [claims: capabilities/spec-first-changes#enforce-show, capabilities/spec-first-changes#enforce-unknown-collected]
  it('shows an unreadable enforce: value as ignored, with the default level in force', async () => {
    const repo = repoAt('strict');
    const r = await runEnforceShow(await loadConfig(repo.dir), { targets: ['auth'] });
    expect(r.items[0].message).toBe('observe');
    expect(r.messages[0]).toContain('[ignored enforce: "strict"]');
  });
});

describe('enforce raise [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-raise-while-certified, capabilities/spec-first-changes#enforce-minimal-edit, capabilities/spec-first-changes#enforce-not-hashed]
  it('observe to warn needs no certification: it edits the enforce line, changes no claim hash and records a decision', async () => {
    const repo = repoAt('observe');
    const config = await loadConfig(repo.dir);
    const hashes = (await enumerateClaims(config)).map((c) => `${c.ref}=${c.claimHash}`);
    const before = read(repo, AUTH);
    const r = await runEnforceRaise(config, { targets: ['auth'], actor: PERSON, by: 'Ada' });
    expect(r.exitCode).toBe(0);
    expect(r.updated).toBe(1);
    const entry = listHistory(config).find((e) => e.source === 'enforce')!;
    // The only other change is the history back-reference.
    expect(read(repo, AUTH)).toBe(before.replace('enforce: observe', 'enforce: warn').replace('---\n#', `history:\n  - ${entry.id}\n---\n#`));
    expect((await enumerateClaims(config)).map((c) => `${c.ref}=${c.claimHash}`)).toEqual(hashes);
    expect(entry).toMatchObject({ kind: 'decision', author: 'Ada', affects: ['auth'], policy: ['enforce raised: auth observe->warn'] });
  });

  // [claims: capabilities/spec-first-changes#enforce-raise-while-certified, capabilities/spec-first-changes#enforce-minimal-edit]
  it('a spec with no enforce: line gets one; raising twice goes warn then enforce', async () => {
    const repo = await certifiedRepo();
    const config = await loadConfig(repo.dir);
    expect((await runEnforceRaise(config, { targets: ['auth'], actor: PERSON, by: 'Ada' })).exitCode).toBe(0);
    expect(read(repo, AUTH)).toContain('\nenforce: warn\n');
    gitCommit(repo.dir, 'raise to warn'); // certification is judged at a clean commit
    const second = await runEnforceRaise(config, { targets: ['auth'], actor: PERSON, by: 'Ada' });
    expect(second.exitCode).toBe(0);
    expect(read(repo, AUTH)).toContain('\nenforce: enforce\n');
    expect(read(repo, AUTH).match(/^enforce:/gm)).toHaveLength(1);
  });

  // [claims: capabilities/spec-first-changes#enforce-raise-while-certified]
  it('raising to enforce is refused while the capability is not certified, with the reasons, and writes nothing', async () => {
    const repo = repoAt('warn');
    const before = read(repo, AUTH);
    const r = await runEnforceRaise(await loadConfig(repo.dir), { targets: ['auth'], actor: PERSON, by: 'Ada' });
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    const text = r.messages.join('\n');
    expect(text).toContain('auth: a capability can move to enforce only while it is certified');
    expect(text).toContain('[APPROVALS_NOT_IN_USE]');
    expect(text).toContain('Nothing was written.');
    expect(read(repo, AUTH)).toBe(before);
    expect(listHistory(await loadConfig(repo.dir))).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#enforce-raise-while-certified]
  it('raising to enforce works while the capability is certified', async () => {
    const repo = await certifiedRepo('warn');
    const config = await loadConfig(repo.dir);
    const r = await runEnforceRaise(config, { targets: ['auth'], to: 'enforce', actor: PERSON, by: 'Ada' });
    expect(r.exitCode).toBe(0);
    expect(read(repo, AUTH)).toContain('enforce: enforce');
    expect(listHistory(config).find((e) => e.source === 'enforce')?.policy).toEqual(['enforce raised: auth warn->enforce']);
  });

  // [claims: capabilities/spec-first-changes#enforce-raise-while-certified]
  it('several capabilities move together or not at all, and a level that is not above the current one is refused', async () => {
    const repo = repoAt('observe');
    const config = await loadConfig(repo.dir);
    const before = read(repo, AUTH);
    const r = await runEnforceRaise(config, { targets: ['auth', 'shop'], to: 'enforce', actor: PERSON });
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(read(repo, AUTH)).toBe(before);
    expect(read(repo, 'specs/capabilities/shop.md')).not.toContain('enforce:');

    const same = await runEnforceRaise(config, { targets: ['auth'], to: 'observe', actor: PERSON });
    expect(same.exitCode).toBe(ExitCode.ValidationFailed);
    const top = await runEnforceRaise(await loadConfig((repoAt('enforce')).dir), { targets: ['auth'], actor: PERSON });
    expect(top.messages.join('\n')).toContain('already at enforce');
    expect((await runEnforceRaise(config, { targets: ['auth'], to: 'max', actor: PERSON })).exitCode).toBe(ExitCode.ValidationFailed);
    expect((await runEnforceRaise(config, { targets: ['ghost'], actor: PERSON })).exitCode).toBe(ExitCode.ValidationFailed);
  });

  // [claims: capabilities/spec-first-changes#enforce-person-only]
  it('refuses an agent without a terminal and writes nothing, but accepts one that has a terminal', async () => {
    const repo = repoAt('observe');
    const config = await loadConfig(repo.dir);
    const before = read(repo, AUTH);
    const r = await runEnforceRaise(config, { targets: ['auth'], actor: AGENT });
    expect(r.exitCode).toBe(ExitCode.InternalError);
    expect(r.messages[0]).toContain('by a person in their own terminal');
    expect(read(repo, AUTH)).toBe(before);
    expect(listHistory(config)).toEqual([]);
    expect((await runEnforceRaise(config, { targets: ['auth'], actor: { agent: true, tty: true } })).exitCode).toBe(0);
  });
});

describe('enforce lower [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-lower-recorded, capabilities/spec-first-changes#enforce-not-hashed]
  it('lowers the level and records a history entry with the policy line, the reason and the person, without moving a claim hash', async () => {
    const repo = repoAt('enforce');
    const config = await loadConfig(repo.dir);
    const hashes = (await enumerateClaims(config)).map((c) => `${c.ref}=${c.claimHash}`);
    const r = await runEnforceLower(config, { targets: ['auth'], to: 'warn', why: 'migration in flight', actor: PERSON, by: 'Ada' });
    expect(r.exitCode).toBe(0);
    expect(read(repo, AUTH)).toContain('enforce: warn');
    expect(read(repo, AUTH)).not.toContain('enforce: enforce');
    expect((await enumerateClaims(config)).map((c) => `${c.ref}=${c.claimHash}`)).toEqual(hashes);
    const entry = listHistory(config).find((e) => e.source === 'enforce')!;
    expect(entry).toMatchObject({ kind: 'decision', author: 'Ada', affects: ['auth'], policy: ['enforce lowered: auth enforce->warn'] });
    expect(entry.body).toContain('Ada lowered the enforce level: auth enforce to warn');
    expect(entry.body).toContain('Why: migration in flight');
    expect(read(repo, AUTH)).toContain(`  - ${entry.id}`);
  });

  // [claims: capabilities/spec-first-changes#enforce-lower-recorded]
  it('requires --why and --to, and only lowers: nothing is written otherwise', async () => {
    const repo = repoAt('warn');
    const config = await loadConfig(repo.dir);
    const before = read(repo, AUTH);
    const noWhy = await runEnforceLower(config, { targets: ['auth'], to: 'observe', actor: PERSON });
    expect(noWhy.exitCode).toBe(ExitCode.ValidationFailed);
    expect(noWhy.messages[0]).toContain('--why is required');
    expect((await runEnforceLower(config, { targets: ['auth'], to: 'observe', why: '   ', actor: PERSON })).exitCode).toBe(ExitCode.ValidationFailed);
    expect((await runEnforceLower(config, { targets: ['auth'], why: 'x', actor: PERSON })).messages[0]).toContain('--to is required');
    const up = await runEnforceLower(config, { targets: ['auth'], to: 'enforce', why: 'x', actor: PERSON });
    expect(up.exitCode).toBe(ExitCode.ValidationFailed);
    expect(up.messages.join('\n')).toContain('enforce raise');
    expect((await runEnforceLower(config, { targets: ['auth'], to: 'warn', why: 'x', actor: PERSON })).exitCode).toBe(ExitCode.ValidationFailed);
    expect(read(repo, AUTH)).toBe(before);
    expect(listHistory(config)).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#enforce-person-only]
  it('refuses an agent without a terminal, even with a reason, and writes nothing', async () => {
    const repo = repoAt('enforce');
    const config = await loadConfig(repo.dir);
    const before = read(repo, AUTH);
    const r = await runEnforceLower(config, { targets: ['auth'], to: 'observe', why: 'because', actor: AGENT });
    expect(r.exitCode).toBe(ExitCode.InternalError);
    expect(r.messages[0]).toContain('by a person in their own terminal');
    expect(read(repo, AUTH)).toBe(before);
    expect(listHistory(config)).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#enforce-person-only]
  it('takes the actor from the environment when none is given: an agent marker without a terminal is refused', async () => {
    const repo = repoAt('enforce');
    const config = await loadConfig(repo.dir);
    const saved = process.env.SPECGUARD_HOST_AGENT;
    process.env.SPECGUARD_HOST_AGENT = '1';
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      expect((await runEnforceLower(config, { targets: ['auth'], to: 'observe', why: 'x' })).exitCode).toBe(ExitCode.InternalError);
      expect((await runEnforceRaise(config, { targets: ['auth'], to: 'enforce' })).exitCode).toBe(ExitCode.InternalError);
    } finally {
      if (saved === undefined) delete process.env.SPECGUARD_HOST_AGENT;
      else process.env.SPECGUARD_HOST_AGENT = saved;
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

describe('enforce commands [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-show, capabilities/spec-first-changes#enforce-lower-recorded]
  it('registers show (alias status), raise and lower under enforce', () => {
    const program = new Command();
    registerEnforceCommands(program);
    const enforce = program.commands.find((c) => c.name() === 'enforce')!;
    expect(enforce.commands.map((c) => c.name())).toEqual(['show', 'raise', 'lower']);
    expect(enforce.commands[0].aliases()).toEqual(['status']);
    expect(enforce.commands[2].options.map((o) => o.long)).toEqual(['--to', '--why', '--by']);
  });
});
