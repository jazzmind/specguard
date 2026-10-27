import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectFormat, MIGRATE_NEVER_TOUCHED, renderMigrationPlan } from '../../src/core/migrate-plan.js';
import { applyIgnoreBlock, GENERATED_STATE_PATHS } from '../../src/core/state-ignore.js';
import { loadAllSpecs as coreLoadAllSpecs } from '../../src/core/spec-parser.js';
import { loadAllSpecs } from '../../src/legacy/index.js';
import { gatherFacts, MIGRATE_PERSON_PENDING, runMigrate } from '../../src/pipelines/migrate.js';
import { gitInit } from '../helpers/v2-repo.js';
import { draftCapabilities, git, ledgerRow, ledgerText, makeV01Repo, makeV02Repo, repoHash, treeHash } from '../helpers/migrate-repos.js';
import { makeRepo } from '../helpers/repo.js';
import { appendActivityLogEntry } from '../../src/mcp/activity-hook.js';

const PLAN = { consolidate: false, fetchNotes: false, workflow: false };
const readJson = (file: string): Record<string, any> => JSON.parse(readFileSync(file, 'utf8'));
const ignored = (dir: string, rel: string): boolean => {
  try {
    git(dir, 'check-ignore', '-q', rel);
    return true;
  } catch {
    return false;
  }
};
/** The single backup folder of the first run, or undefined. */
const backupDir = (dir: string): string | undefined => {
  const root = path.join(dir, '.specguard/cache/migrate');
  const stamp = existsSync(root) ? readdirSync(root).find((n) => n !== 'state.json') : undefined;
  return stamp ? path.join(root, stamp) : undefined;
};

describe('migrate: a v0.2/0.3 repository [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#migrate-apply-untracks-state, capabilities/integration-surfaces#activity-log-never-committed]
  it('repairs a tracked activity log once and stays clean when logging resumes after the migration commit', async () => {
    const repo = makeV02Repo();
    repo.write('.specguard/activity-log.json', '[]');
    git(repo.dir, 'add', '.specguard/activity-log.json');
    git(repo.dir, 'commit', '-qm', 'legacy activity log');
    const dry = await runMigrate({ cwd: repo.dir });
    expect(dry.steps.find((s) => s.id === 'untrack-activity-log')?.state).toBe('todo');
    expect(git(repo.dir, 'ls-files', '.specguard/activity-log.json').trim()).toBe('.specguard/activity-log.json');
    const applied = await runMigrate({ cwd: repo.dir, yes: true });
    expect(applied.applied).toContain('untrack-activity-log');
    expect(git(repo.dir, 'ls-files', '.specguard/activity-log.json').trim()).toBe('');
    expect(readFileSync(path.join(repo.dir, '.specguard/activity-log.json'), 'utf8')).toBe('[]');
    git(repo.dir, 'add', '-A');
    git(repo.dir, 'commit', '-qm', 'stop tracking runtime state');
    appendActivityLogEntry(repo.dir, { pipeline: 'post-commit', status: 'pass', source: 'mcp' });
    expect(git(repo.dir, 'status', '--porcelain').trim()).toBe('');
  });
  // [claims: capabilities/platform-foundation#migrate-dry-run-changes-nothing]
  it('reads the facts and prints the plan without changing anything', async () => {
    const repo = makeV02Repo();
    const before = repoHash(repo.dir);

    const facts = await gatherFacts(repo.dir);
    expect(facts).toMatchObject({
      hasConfig: true,
      v1Specs: [], // the seed's empty markdown file is not a spec
      tracked: { proofs: true, trace: true },
      gitignoreBlock: 'missing',
      hasApprovals: false,
      ledgerRows: 3,
      ledgerOriginCi: 2,
      dirty: [],
      git: true,
    });
    expect(facts.v2Specs).toEqual(['specs/capabilities/auth.md', 'specs/capabilities/shop.md', 'specs/system.md']);

    const res = await runMigrate({ cwd: repo.dir });
    expect(res.format).toBe('v0.2-0.3');
    expect(res.messages.join('\n')).toBe(renderMigrationPlan(facts, PLAN));
    expect(res.exitCode).toBe(MIGRATE_PERSON_PENDING);
    expect(res.applied).toEqual([]);
    expect(repoHash(repo.dir)).toBe(before);
    expect(existsSync(path.join(repo.dir, '.specguard/cache'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#migrate-apply-untracks-state, capabilities/platform-foundation#migrate-person-steps-never-run]
  it('with --yes untracks the generated proof files, keeps them on disk, ignores them, and never commits or approves', async () => {
    const repo = makeV02Repo();
    const head = git(repo.dir, 'rev-parse', 'HEAD');

    const res = await runMigrate({ cwd: repo.dir, yes: true });

    expect(res.failed).toBe(0);
    expect(res.applied).toEqual(['gitignore', 'untrack-ledger', 'untrack-trace', 'provisional-rows', 'config']);
    const tracked = git(repo.dir, 'ls-files').split('\n');
    expect(tracked).not.toContain('.specguard/trace.json');
    expect(tracked).not.toContain('.specguard/proofs.json');
    expect(tracked).toContain('.specguard/config.json');
    expect(existsSync(path.join(repo.dir, '.specguard/trace.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs).toBeDefined();
    expect(readFileSync(path.join(repo.dir, '.gitignore'), 'utf8')).toBe(applyIgnoreBlock(''));
    expect(ignored(repo.dir, '.specguard/trace.json')).toBe(true);
    // The block lists whatever the current state list says; the ledger joins it with the proof store slice.
    expect(ignored(repo.dir, '.specguard/proofs.json')).toBe(GENERATED_STATE_PATHS.includes('.specguard/proofs.json'));

    // Never commits, never adds: the only staged changes are the two deletions from the index.
    expect(git(repo.dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo.dir, 'diff', '--cached', '--name-status').trim().split('\n').sort()).toEqual(['D\t.specguard/proofs.json', 'D\t.specguard/trace.json']);
    expect(git(repo.dir, 'status', '--porcelain', '--', '.gitignore').trim()).toBe('?? .gitignore');

    // The approval and the commit are the person's: listed with their commands, never run.
    const approval = res.steps.find((s) => s.id === 'as-built-approval');
    expect(approval).toMatchObject({ state: 'person', commands: ['specguard spec approve --all --as-built --yes'] });
    expect(res.steps.find((s) => s.id === 'first-ci-note')?.state).toBe('person');
    expect(existsSync(path.join(repo.dir, 'specs/history'))).toBe(false);
    expect(res.exitCode).toBe(MIGRATE_PERSON_PENDING);
    expect(res.messages.join('\n')).toContain('Left for you (never run by migrate): as-built-approval, first-ci-note.');
  });

  // [claims: capabilities/platform-foundation#migrate-rows-provisional]
  it('marks committed proof rows provisional with an imported marker, keeps a backup, and leaves local rows alone', async () => {
    const repo = makeV02Repo();
    const original = readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8');
    const sha = git(repo.dir, 'log', '-n1', '--format=%H', '--', '.specguard/proofs.json').trim();

    await runMigrate({ cwd: repo.dir, yes: true });

    const rows = readJson(path.join(repo.dir, '.specguard/proofs.json')).proofs;
    expect(rows['capabilities/auth#login-valid-code']).toMatchObject({ origin: 'local', imported: `tracked-ledger@${sha}` });
    expect(rows['capabilities/auth#logout-clears-session']).toMatchObject({ origin: 'local', imported: `tracked-ledger@${sha}` });
    expect(rows['capabilities/shop#cart-totals']).toEqual(JSON.parse(original).proofs['capabilities/shop#cart-totals']);
    const backup = backupDir(repo.dir) as string;
    expect(readFileSync(path.join(backup, 'proofs.json'), 'utf8')).toBe(original);
    const manifest = readJson(path.join(backup, 'manifest.json'));
    expect(manifest.applied).toContain('provisional-rows');
    expect(manifest.undo).toContainEqual({ op: 'retrack', path: '.specguard/proofs.json' });
  });

  // [claims: capabilities/platform-foundation#migrate-idempotent-rerun]
  it('a second --yes is a no-op success, even on the tree the first run left dirty', async () => {
    const repo = makeV02Repo();
    await runMigrate({ cwd: repo.dir, yes: true });
    const before = repoHash(repo.dir);

    const again = await runMigrate({ cwd: repo.dir, yes: true });

    expect(again.failed).toBe(0);
    expect(again.exitCode).toBe(0);
    expect(again.applied).toEqual([]);
    expect(again.steps.every((s) => s.state === 'done' || s.state === 'skip')).toBe(true);
    expect(repoHash(repo.dir)).toBe(before);
    expect(await detectFormatOf(repo.dir)).toBe('v0.6');
  });

  // [claims: capabilities/platform-foundation#migrate-refuses-dirty-tree]
  it('refuses a dirty working tree, and --allow-dirty applies without touching the uncommitted source', async () => {
    const repo = makeV02Repo();
    repo.write('src/auth/login.ts', 'export const login = 2; // uncommitted\n');
    const before = repoHash(repo.dir);

    const refused = await runMigrate({ cwd: repo.dir, yes: true });
    expect(refused.exitCode).toBe(2);
    expect(refused.failed).toBe(1);
    expect(refused.messages.join('\n')).toContain('src/auth/login.ts');
    expect(repoHash(repo.dir)).toBe(before);

    const dry = await runMigrate({ cwd: repo.dir });
    expect(dry.messages.join('\n')).toContain('--yes refuses to run on it unless you pass --allow-dirty');

    const res = await runMigrate({ cwd: repo.dir, yes: true, allowDirty: true });
    expect(res.failed).toBe(0);
    expect(res.applied).toContain('untrack-ledger');
    expect(readFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'utf8')).toContain('// uncommitted');
  });

  // [claims: capabilities/platform-foundation#migrate-person-steps-never-run]
  it('never touches source, tests, capability specs or history', async () => {
    const repo = makeV02Repo();
    repo.write('specs/history/2026-01-01-note.md', '# an old note\n');
    git(repo.dir, 'add', '-A');
    git(repo.dir, 'commit', '-q', '-m', 'history');
    const guarded = ['src', 'tests', 'specs'];
    const before = guarded.map((d) => treeHash(repo.dir, d));

    await runMigrate({ cwd: repo.dir, yes: true });

    expect(guarded.map((d) => treeHash(repo.dir, d))).toEqual(before);
    // The list the dry run shows names exactly what the test above holds still.
    expect(MIGRATE_NEVER_TOUCHED.join('\n')).toContain('source code');
    expect(git(repo.dir, 'diff', '--cached', '--name-only').split('\n').filter((p) => p.startsWith('src/') || p.startsWith('tests/') || p.startsWith('specs/'))).toEqual([]);
  });

  // [claims: capabilities/platform-foundation#migrate-config-and-hooks-additive]
  it('adds only the config keys that are absent, as text, and never rewrites what the user wrote', async () => {
    const repo = makeV02Repo();
    const original = readFileSync(path.join(repo.dir, '.specguard/config.json'), 'utf8');
    await runMigrate({ cwd: repo.dir, yes: true });
    const next = readFileSync(path.join(repo.dir, '.specguard/config.json'), 'utf8');
    expect(next.startsWith(original.slice(0, original.lastIndexOf('}')).trimEnd())).toBe(true);
    expect(JSON.parse(next)).toEqual({ ...JSON.parse(original), proofStore: {}, enforce: { default: 'observe' } });
    expect(readFileSync(path.join(backupDir(repo.dir) as string, 'config.json'), 'utf8')).toBe(original);

    // A hand-formatted config that already has one of the keys keeps its layout and its value.
    const custom = makeV02Repo();
    const text = `{\n    "_comment": "mine",\n    "apps": ${JSON.stringify(readJson(path.join(custom.dir, '.specguard/config.json')).apps)},\n    "llm": { "provider": "none", "model": "none", "apiKeyEnv": "NONE" },\n    "enforce": { "default": "warn" }\n}\n`;
    custom.write('.specguard/config.json', text);
    git(custom.dir, 'commit', '-qam', 'config');
    await runMigrate({ cwd: custom.dir, yes: true });
    const out = readFileSync(path.join(custom.dir, '.specguard/config.json'), 'utf8');
    expect(out.startsWith(text.slice(0, text.lastIndexOf('}')).trimEnd())).toBe(true);
    expect(out).toContain('    "proofStore": {}');
    expect(readJson(path.join(custom.dir, '.specguard/config.json')).enforce).toEqual({ default: 'warn' });

    // With both keys present the file is not written, so no backup of it exists either.
    const both = makeV02Repo();
    const full = text.replace('"enforce"', '"proofStore": {},\n    "enforce"');
    both.write('.specguard/config.json', full);
    git(both.dir, 'commit', '-qam', 'config');
    await runMigrate({ cwd: both.dir, yes: true });
    expect(readFileSync(path.join(both.dir, '.specguard/config.json'), 'utf8')).toBe(full);
    expect(existsSync(path.join(backupDir(both.dir) as string, 'config.json'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#migrate-config-and-hooks-additive]
  it('adds guard hooks only to a settings file that already has SpecGuard hooks, and only once', async () => {
    const hooks = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'specguard history inbox || true' }] }], PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    const repo = makeV02Repo();
    repo.write('.claude/settings.json', `${JSON.stringify(hooks, null, 2)}\n`);
    git(repo.dir, 'add', '-A');
    git(repo.dir, 'commit', '-q', '-m', 'settings');

    const res = await runMigrate({ cwd: repo.dir, yes: true });

    expect(res.applied).toContain('hooks');
    const settings = readJson(path.join(repo.dir, '.claude/settings.json')).hooks;
    expect(settings.UserPromptSubmit).toEqual(hooks.hooks.UserPromptSubmit);
    expect(settings.PostToolUse[0]).toEqual(hooks.hooks.PostToolUse[0]);
    expect(JSON.stringify(settings.PreToolUse)).toContain('specguard hook pre-tool');
    expect(settings.PostToolUse).toHaveLength(1); // the guard is a PreToolUse hook only

    // Guard hooks already there (a hand-wired copy, or the plugin's bundle): the file is not written at all.
    const wired = makeV02Repo();
    const has = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'specguard hook pre-tool' }] }], PostToolUse: [{ hooks: [{ type: 'command', command: 'specguard hook post-tool' }] }], UserPromptSubmit: hooks.hooks.UserPromptSubmit } }, null, 2)}\n`;
    wired.write('.claude/settings.json', has);
    git(wired.dir, 'add', '-A');
    git(wired.dir, 'commit', '-q', '-m', 'settings');
    expect((await runMigrate({ cwd: wired.dir, yes: true })).applied).not.toContain('hooks');
    expect(readFileSync(path.join(wired.dir, '.claude/settings.json'), 'utf8')).toBe(has);

    // No SpecGuard hooks in it: the file is not touched.
    const plain = makeV02Repo();
    const mine = `${JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } })}\n`;
    plain.write('.claude/settings.json', mine);
    git(plain.dir, 'add', '-A');
    git(plain.dir, 'commit', '-q', '-m', 'settings');
    await runMigrate({ cwd: plain.dir, yes: true });
    expect(readFileSync(path.join(plain.dir, '.claude/settings.json'), 'utf8')).toBe(mine);
  });

  // [claims: capabilities/platform-foundation#migrate-dry-run-changes-nothing, capabilities/platform-foundation#migrate-person-steps-never-run]
  it('works in a directory that is not a git repository', async () => {
    const repo = makeV02Repo();
    rmSync(path.join(repo.dir, '.git'), { recursive: true });
    const before = treeHash(repo.dir);

    const dry = await runMigrate({ cwd: repo.dir });
    expect((await gatherFacts(repo.dir)).git).toBe(false);
    expect(dry.steps.find((s) => s.id === 'untrack-ledger')?.state).toBe('skip');
    expect(dry.messages.join('\n')).toContain('Blocked: this is not a git repository');
    expect(treeHash(repo.dir)).toBe(before);

    const res = await runMigrate({ cwd: repo.dir, yes: true });
    expect(res.failed).toBe(0);
    expect(res.applied).toEqual(['gitignore', 'provisional-rows', 'config']);
    expect(existsSync(path.join(repo.dir, '.git'))).toBe(false);
    expect(readJson(path.join(repo.dir, '.specguard/proofs.json')).proofs['capabilities/auth#login-valid-code'].imported).toBe('tracked-ledger@untracked');
    expect(res.exitCode).toBe(MIGRATE_PERSON_PENDING);
    expect((await runMigrate({ cwd: repo.dir, yes: true })).exitCode).toBe(0);
  });
});

async function detectFormatOf(dir: string): Promise<string> {
  return detectFormat(await gatherFacts(dir));
}

describe('migrate: a v0.1 repository [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#migrate-archive-v1-keeps-history]
  it('archives per-file specs with git mv so history follows them, and moves their ledger rows to the backup', async () => {
    const repo = makeV01Repo();
    const original = readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8');
    const dry = await runMigrate({ cwd: repo.dir });
    expect(dry.format).toBe('v0.1');
    expect(dry.steps.find((s) => s.id === 'archive-v1')?.state).toBe('todo');
    expect(dry.exitCode).toBe(12);

    const res = await runMigrate({ cwd: repo.dir, yes: true });

    expect(res.applied).toEqual(expect.arrayContaining(['archive-v1', 'drop-v1-ledger']));
    for (const key of ['core/awards', 'api/users']) {
      expect(existsSync(path.join(repo.dir, `specs/${key}.md`))).toBe(false);
      expect(existsSync(path.join(repo.dir, `specs/_archive/v1/${key}.md`))).toBe(true);
    }
    expect(git(repo.dir, 'diff', '--cached', '-M', '--name-status')).toMatch(/R100\tspecs\/core\/awards\.md\tspecs\/_archive\/v1\/core\/awards\.md/);
    git(repo.dir, 'commit', '-q', '-m', 'archive');
    expect(git(repo.dir, 'log', '--follow', '--format=%s', '--', 'specs/_archive/v1/core/awards.md').trim().split('\n')).toEqual(['archive', 'base']);

    // Rows of the archived specs cannot prove capability claims; the one for a capability stays.
    const rows = readJson(path.join(repo.dir, '.specguard/proofs.json')).proofs;
    expect(Object.keys(rows)).toEqual(['capabilities/auth#login-valid-code']);
    expect(readFileSync(path.join(backupDir(repo.dir) as string, 'proofs.json'), 'utf8')).toBe(original);
  });

  // [claims: capabilities/platform-foundation#migrate-resumable]
  it('prints the drafting and tagging commands for the host agent, exits 12, and resumes from its state file', async () => {
    const repo = makeV01Repo();
    const first = await runMigrate({ cwd: repo.dir, yes: true });

    expect(first.exitCode).toBe(12);
    const text = first.messages.join('\n');
    expect(text).toContain('$ specguard spec draft --yes');
    expect(text).toContain('$ specguard spec tag --yes');
    expect(text).toContain('Waiting for the host agent');
    expect(existsSync(path.join(repo.dir, 'specs/capabilities'))).toBe(false); // the tool drafted nothing itself
    const statePath = path.join(repo.dir, '.specguard/cache/migrate/state.json');
    const state = readJson(statePath);
    expect(state.completedAt).toBeUndefined();
    expect(state.archived.map((a: { path: string }) => a.path).sort()).toEqual(['specs/api/users.md', 'specs/core/awards.md']);

    // Between the archive and the end of the draft the repository has no specs of either kind: only the state says v0.1.
    expect(await detectFormatOf(repo.dir)).toBe('v0.1');
    const saved = readFileSync(statePath, 'utf8');
    rmSync(statePath);
    expect(await detectFormatOf(repo.dir)).toBe('none');
    writeFileSync(statePath, saved);

    // Rerun while the agent is still drafting: not refused for the tree the first run left dirty, archive already done.
    const waiting = await runMigrate({ cwd: repo.dir, yes: true });
    expect(waiting.failed).toBe(0);
    expect(waiting.exitCode).toBe(12);
    expect(waiting.steps.find((s) => s.id === 'archive-v1')?.state).toBe('done');
    expect(waiting.steps.find((s) => s.id === 'draft')?.state).toBe('agent');

    // The agent drafts; the tests are not tagged yet.
    draftCapabilities(repo);
    const drafted = await runMigrate({ cwd: repo.dir, yes: true });
    expect(drafted.steps.find((s) => s.id === 'draft')?.state).toBe('done');
    expect(drafted.steps.find((s) => s.id === 'tag')?.state).toBe('agent');
    expect(drafted.exitCode).toBe(12);

    // The agent tags (the tag is assembled so this file carries no tag of its own).
    repo.write('tests/auth.test.ts', `it('logs in ${'@' + 'claim:capabilities/auth#login-valid-code'}', () => {});\n`);
    const tagged = await runMigrate({ cwd: repo.dir, yes: true });
    expect(tagged.steps.find((s) => s.id === 'tag')?.state).toBe('done');
    expect(tagged.steps.filter((s) => s.state === 'agent')).toEqual([]);
    expect(tagged.exitCode).toBe(MIGRATE_PERSON_PENDING);
    expect(tagged.steps.find((s) => s.id === 'as-built-approval')?.state).toBe('person');
    expect(readJson(statePath).completedAt).toBeDefined();
    expect(existsSync(path.join(repo.dir, 'specs/history'))).toBe(false);

    // Finished: the repository now reads as current and a further run changes nothing.
    expect(await detectFormatOf(repo.dir)).toBe('v0.6');
    const before = repoHash(repo.dir);
    const done = await runMigrate({ cwd: repo.dir, yes: true });
    expect(done.exitCode).toBe(0);
    expect(repoHash(repo.dir)).toBe(before);
  });

  // [claims: capabilities/platform-foundation#migrate-resumable]
  it('--consolidate prints `spec consolidate` for the agent, moves no spec itself, and still does the tool steps', async () => {
    const repo = makeV01Repo();
    const res = await runMigrate({ cwd: repo.dir, yes: true, consolidate: true });

    expect(res.exitCode).toBe(12);
    const archive = res.steps.find((s) => s.id === 'archive-v1');
    expect(archive).toMatchObject({ state: 'agent', commands: ['specguard spec consolidate --yes'] });
    expect(res.steps.filter((s) => ['draft', 'tag', 'drop-v1-ledger'].includes(s.id)).map((s) => s.state)).toEqual(['skip', 'skip', 'skip']);
    expect(existsSync(path.join(repo.dir, 'specs/core/awards.md'))).toBe(true);
    expect(existsSync(path.join(repo.dir, 'specs/_archive'))).toBe(false);
    expect(res.applied).toContain('gitignore');
  });

  // [claims: capabilities/platform-foundation#migrate-archive-v1-keeps-history]
  it('never overwrites an archived spec', async () => {
    const repo = makeV01Repo();
    repo.write('specs/_archive/v1/core/awards.md', 'older archive\n');

    await expect(runMigrate({ cwd: repo.dir, yes: true, allowDirty: true })).rejects.toThrow(/already exists; refusing to overwrite/);

    expect(readFileSync(path.join(repo.dir, 'specs/_archive/v1/core/awards.md'), 'utf8')).toBe('older archive\n');
    expect(existsSync(path.join(repo.dir, 'specs/core/awards.md'))).toBe(true);
    expect(existsSync(path.join(repo.dir, 'specs/api/users.md'))).toBe(true);
  });

  // [claims: capabilities/platform-foundation#migrate-archive-v1-keeps-history]
  it('archives with a plain move when there is no git, and reads v1 specs through the legacy barrel', async () => {
    const repo = makeRepo();
    expect(loadAllSpecs).toBe(coreLoadAllSpecs);
    repo.write('.specguard/proofs.json', ledgerText([ledgerRow('core/awards#award-once', 'ci')]));

    const res = await runMigrate({ cwd: repo.dir, yes: true });

    expect(res.exitCode).toBe(12);
    expect(existsSync(path.join(repo.dir, 'specs/core/awards.md'))).toBe(false);
    expect(existsSync(path.join(repo.dir, 'specs/_archive/v1/core/awards.md'))).toBe(true);
    expect(existsSync(path.join(repo.dir, '.git'))).toBe(false);
    expect(await detectFormatOf(repo.dir)).toBe('v0.1');
  });

  // [claims: capabilities/platform-foundation#migrate-refuses-dirty-tree]
  it('refuses a fresh start on a dirty tree, and starts once the tree is committed', async () => {
    const repo = makeV01Repo();
    repo.write('src/users.ts', 'export const users = 2;\n');
    const before = repoHash(repo.dir);
    const res = await runMigrate({ cwd: repo.dir, yes: true });
    expect(res.exitCode).toBe(2);
    expect(repoHash(repo.dir)).toBe(before);
    gitInit(repo.dir); // commit it: a clean tree starts the migration
    expect((await runMigrate({ cwd: repo.dir, yes: true })).exitCode).toBe(12);
  });
});
