import { describe, expect, it } from 'vitest';

import {
  detectFormat,
  MIGRATE_NEVER_TOUCHED,
  MIGRATE_STEP_IDS,
  migrationComplete,
  planMigration,
  renderMigrationPlan,
  type MigrateStep,
  type MigrateStepId,
  type RepoFacts,
} from '../../src/core/migrate-plan.js';

const OPTS = { consolidate: false, fetchNotes: false, workflow: false };

const current = (): RepoFacts => ({
  hasConfig: true,
  v1Specs: [],
  v2Specs: ['specs/capabilities/cart.md', 'specs/capabilities/checkout.md'],
  tracked: { proofs: false, trace: false, publishSnapshot: false },
  gitignoreBlock: 'current',
  hasApprovals: true,
  notes: { localRef: true, fetchRefspec: true },
  workflow: { path: '.github/workflows/specguard.yml', generatedBySpecguard: true, hasProve: true },
  dirty: [],
  ledgerRows: 12,
  ledgerOriginCi: 0,
});

const v02 = (): RepoFacts => ({
  ...current(),
  tracked: { proofs: true, trace: true, publishSnapshot: false },
  gitignoreBlock: 'outdated',
  hasApprovals: false,
  notes: { localRef: false, fetchRefspec: false },
  workflow: { path: '.github/workflows/specguard.yml', generatedBySpecguard: true, hasProve: false },
  ledgerOriginCi: 12,
});

const v01 = (n = 3): RepoFacts => ({
  ...v02(),
  v1Specs: Array.from({ length: n }, (_, i) => `specs/core/mod-${i}.md`),
  v2Specs: [],
  tracked: { proofs: false, trace: false, publishSnapshot: false },
  gitignoreBlock: 'missing',
  ledgerOriginCi: 0,
  workflow: { generatedBySpecguard: false, hasProve: false },
});

const byId = (steps: MigrateStep[]): Record<string, MigrateStep> => Object.fromEntries(steps.map((s) => [s.id, s]));
const states = (steps: MigrateStep[]): Record<string, string> => Object.fromEntries(steps.map((s) => [s.id, s.state]));

describe('migration planning [migrate-plan]', () => {
  // [claims: capabilities/platform-foundation#migrate-detect-format]
  it('detects none, v0.1, v0.2-0.3 and v0.6 from the facts', () => {
    expect(detectFormat({ ...current(), v2Specs: [] })).toBe('none');
    expect(detectFormat({ ...current(), v2Specs: [], hasConfig: false })).toBe('none');
    expect(detectFormat(v01())).toBe('v0.1');
    expect(detectFormat(v02())).toBe('v0.2-0.3');
    expect(detectFormat(current())).toBe('v0.6');
  });

  // [claims: capabilities/platform-foundation#migrate-detect-format]
  it('puts a repo with any one stale part of the old layout at v0.2-0.3, and one with per-file specs left over at v0.1', () => {
    expect(detectFormat({ ...current(), tracked: { proofs: true, trace: false, publishSnapshot: false } })).toBe('v0.2-0.3');
    expect(detectFormat({ ...current(), tracked: { proofs: false, trace: true, publishSnapshot: false } })).toBe('v0.2-0.3');
    expect(detectFormat({ ...current(), gitignoreBlock: 'outdated' })).toBe('v0.2-0.3');
    expect(detectFormat({ ...current(), gitignoreBlock: 'missing' })).toBe('v0.2-0.3');
    expect(detectFormat({ ...current(), ledgerOriginCi: 2 })).toBe('v0.2-0.3');
    expect(detectFormat({ ...current(), v1Specs: ['specs/old.md'] })).toBe('v0.1');
  });

  // [claims: capabilities/platform-foundation#migrate-ordered-plan]
  it('lists every step in the contract order, whatever the format', () => {
    for (const f of [current(), v02(), v01(), { ...current(), v2Specs: [] }]) {
      expect(planMigration(f, OPTS).map((s) => s.id)).toEqual([...MIGRATE_STEP_IDS]);
    }
  });

  // [claims: capabilities/platform-foundation#migrate-ordered-plan]
  it('v0.2 plan lists gitignore, untrack, provisional rows, config and the person approval, each with its exact command or paths', () => {
    const plan = byId(planMigration(v02(), OPTS));
    expect(plan.gitignore).toMatchObject({ state: 'todo', changes: [{ path: '.gitignore', op: 'edit' }] });
    expect(plan['untrack-ledger']).toMatchObject({
      state: 'todo',
      commands: ['git rm --cached --quiet -- .specguard/proofs.json'],
      changes: [{ path: '.specguard/proofs.json', op: 'untrack' }],
    });
    expect(plan['untrack-ledger']!.description).toContain('Other clones lose the file');
    expect(plan['untrack-trace']).toMatchObject({ state: 'todo', commands: ['git rm --cached --quiet -- .specguard/trace.json'] });
    expect(plan['provisional-rows']!.state).toBe('todo');
    expect(plan['provisional-rows']!.description).toContain('12 local proof row');
    expect(plan.config).toMatchObject({ state: 'todo', changes: [{ path: '.specguard/config.json', op: 'edit' }] });
    expect(plan['as-built-approval']).toMatchObject({ state: 'person', commands: ['specguard spec approve --all --as-built --yes'] });
    expect(plan['first-ci-note']!.state).toBe('person');
    expect(plan['first-ci-note']!.commands).toEqual([
      'git add -A .gitignore .specguard specs .github',
      'git commit -m "chore: proofs move to git notes (specguard migrate)"',
      'git push',
      'specguard proof fetch',
      'specguard check',
    ]);
    for (const id of ['archive-v1', 'draft', 'tag', 'drop-v1-ledger'] as const) expect(plan[id]!.state).toBe('skip');
  });

  // [claims: capabilities/platform-foundation#migrate-ordered-plan]
  it('marks steps done as the repo moves, so a half-migrated repo shows only what is left', () => {
    const half: RepoFacts = { ...v02(), gitignoreBlock: 'current', tracked: { proofs: false, trace: true, publishSnapshot: false }, ledgerOriginCi: 0 };
    expect(detectFormat(half)).toBe('v0.2-0.3');
    const s = states(planMigration(half, OPTS));
    expect(s).toMatchObject({ gitignore: 'done', 'untrack-ledger': 'done', 'untrack-trace': 'todo', 'provisional-rows': 'done', config: 'todo' });
    const untracked: RepoFacts = { ...half, tracked: { proofs: false, trace: false, publishSnapshot: false } };
    expect(detectFormat(untracked)).toBe('v0.6');
    expect(planMigration(untracked, OPTS).filter((x) => x.state === 'todo')).toEqual([]);
  });

  // [claims: capabilities/platform-foundation#migrate-ordered-plan]
  it('plans the same steps for the same facts, and a plan made after applying them (facts caught up) has nothing to do', () => {
    const f = v02();
    expect(planMigration(f, OPTS)).toEqual(planMigration(f, OPTS));
    const applied: RepoFacts = {
      ...f,
      gitignoreBlock: 'current',
      tracked: { proofs: false, trace: false, publishSnapshot: false },
      ledgerOriginCi: 0,
    };
    const again = planMigration(applied, { ...OPTS, fetchNotes: true, workflow: true });
    expect(migrationComplete(again)).toBe(false);
    const withNotes: RepoFacts = { ...applied, notes: { localRef: false, fetchRefspec: true }, workflow: { ...f.workflow, hasProve: true } };
    const second = planMigration(withNotes, { ...OPTS, fetchNotes: true, workflow: true });
    expect(second.every((x) => x.state === 'done' || x.state === 'skip')).toBe(true);
  });

  // [claims: capabilities/platform-foundation#migrate-noop-current]
  it('already-migrated repo -> every step done or skip, and the plan reads as complete', () => {
    for (const o of [OPTS, { consolidate: false, fetchNotes: true, workflow: true }, { consolidate: true, fetchNotes: true, workflow: true }]) {
      const plan = planMigration(current(), o);
      expect(plan.every((s) => s.state === 'done' || s.state === 'skip')).toBe(true);
      expect(migrationComplete(plan)).toBe(true);
    }
    const text = renderMigrationPlan(current(), OPTS);
    expect(text).toContain('Nothing to do: the repository is already current.');
    expect(text).not.toContain('Apply with');
  });

  // [claims: capabilities/platform-foundation#migrate-noop-current]
  it('a current repo that never fetched notes or ran CI still has nothing to do, with a hint for later', () => {
    const f: RepoFacts = { ...current(), notes: { localRef: false, fetchRefspec: false }, hasApprovals: false, workflow: { generatedBySpecguard: false, hasProve: false } };
    const plan = planMigration(f, OPTS);
    expect(migrationComplete(plan)).toBe(true);
    expect(byId(plan)['first-ci-note']!.description).toContain('specguard proof fetch');
  });

  // [claims: capabilities/platform-foundation#migrate-noop-current]
  it('a repo with no specs has nothing to migrate and says what to run instead', () => {
    const none: RepoFacts = { ...current(), v2Specs: [], hasConfig: false };
    const plan = planMigration(none, OPTS);
    expect(migrationComplete(plan)).toBe(true);
    expect(plan[0]!.description).toContain('specguard init');
    const stopped = planMigration({ ...none, hasConfig: true }, OPTS);
    expect(stopped[0]!.description).toContain('specguard spec draft --yes');
  });

  // [claims: capabilities/platform-foundation#migrate-person-steps]
  it('as-built approval is a person step with the exact command, skipped when every claim is approved', () => {
    expect(byId(planMigration(v02(), OPTS))['as-built-approval']).toMatchObject({
      state: 'person',
      commands: ['specguard spec approve --all --as-built --yes'],
    });
    expect(byId(planMigration(v02(), OPTS))['as-built-approval']!.description).toContain('never run by migrate or an agent');
    const approved = byId(planMigration({ ...v02(), hasApprovals: true }, OPTS));
    expect(approved['as-built-approval']!.state).toBe('skip');
    expect(approved['as-built-approval']!.description).toContain('already approved');
  });

  // [claims: capabilities/platform-foundation#migrate-person-steps]
  it('no step the tool runs ever carries the approval command, and the person steps are the only ones marked person', () => {
    for (const f of [v02(), v01(), current(), v01(500)]) {
      for (const o of [OPTS, { consolidate: true, fetchNotes: true, workflow: true }]) {
        for (const s of planMigration(f, o)) {
          const approves = (s.commands ?? []).some((c) => c.includes('spec approve'));
          if (approves) expect(s.id).toBe('as-built-approval');
          if (approves) expect(s.state).toBe('person');
          if (s.state === 'person') expect(['as-built-approval', 'first-ci-note', 'workflow']).toContain(s.id);
        }
      }
    }
  });

  // [claims: capabilities/platform-foundation#migrate-person-steps]
  it('a hand-written workflow is left to the person, and the commit and push step is the person\'s too', () => {
    const f: RepoFacts = { ...v02(), workflow: { path: '.github/workflows/ci.yml', generatedBySpecguard: false, hasProve: false } };
    const plan = byId(planMigration(f, { ...OPTS, workflow: true }));
    expect(plan.workflow!.state).toBe('person');
    expect(plan.workflow!.description).toContain('leaves it alone');
    expect(plan['first-ci-note']!.commands).toContain('git push');
  });

  // [claims: capabilities/platform-foundation#migrate-dry-run]
  it('the dry run lists every step with its state, paths and commands, the options to apply with, and who runs what', () => {
    const text = renderMigrationPlan(v02(), { ...OPTS, fetchNotes: true, workflow: true });
    expect(text).toContain('dry run, nothing was changed. Detected format: v0.2-0.3.');
    for (const id of MIGRATE_STEP_IDS) expect(text).toContain(`] ${id}:`);
    expect(text).toContain('[todo] untrack-ledger');
    expect(text).toContain('    untrack .specguard/proofs.json');
    expect(text).toContain('    $ git rm --cached --quiet -- .specguard/proofs.json');
    expect(text).toContain('Apply with: specguard migrate --yes --fetch-notes --workflow.');
    expect(text).toContain('never commits');
    expect(text).toContain('Left for you (never run by migrate): as-built-approval, first-ci-note.');
  });

  // [claims: capabilities/platform-foundation#migrate-dry-run]
  it('optional steps that were not asked for are skipped with the flag that enables them', () => {
    const plan = byId(planMigration(v02(), OPTS));
    expect(plan['notes-fetch']!.state).toBe('skip');
    expect(plan['notes-fetch']!.description).toContain('--fetch-notes');
    expect(plan.workflow!.state).toBe('skip');
    expect(plan.workflow!.description).toContain('--workflow');
    const asked = byId(planMigration(v02(), { ...OPTS, fetchNotes: true, workflow: true }));
    expect(asked['notes-fetch']).toMatchObject({ state: 'todo', commands: ['git config --add remote.origin.fetch +refs/notes/specguard:refs/notes/specguard'] });
    expect(asked.workflow).toMatchObject({ state: 'todo', changes: [{ path: '.github/workflows/specguard.yml', op: 'edit' }] });
    const fresh = byId(planMigration({ ...v02(), workflow: { generatedBySpecguard: false, hasProve: false } }, { ...OPTS, workflow: true }));
    expect(fresh.workflow).toMatchObject({ state: 'todo', changes: [{ path: '.github/workflows/specguard.yml', op: 'create' }] });
  });

  // [claims: capabilities/platform-foundation#migrate-never-touches]
  it('names what is never touched in every dry run, and no step changes a spec of capabilities, a test, source, history or approvals', () => {
    expect(MIGRATE_NEVER_TOUCHED.join('\n')).toMatch(/capability specs/);
    expect(MIGRATE_NEVER_TOUCHED.join('\n')).toMatch(/test files/);
    expect(MIGRATE_NEVER_TOUCHED.join('\n')).toMatch(/source code/);
    expect(MIGRATE_NEVER_TOUCHED.join('\n')).toMatch(/specs\/history\//);
    expect(MIGRATE_NEVER_TOUCHED.join('\n')).toMatch(/approvals/);
    expect(MIGRATE_NEVER_TOUCHED.join('\n')).toMatch(/never pushes|never commits/);
    for (const f of [v02(), v01(), current()]) {
      expect(renderMigrationPlan(f, OPTS)).toContain('Never touched:');
      for (const o of [OPTS, { consolidate: true, fetchNotes: true, workflow: true }]) {
        for (const s of planMigration(f, o)) {
          for (const c of s.changes ?? []) {
            expect(c.path).not.toMatch(/^specs\/history\//);
            expect(c.path).not.toMatch(/^(src|tests?)\//);
            if (c.path.startsWith('specs/capabilities/')) expect(c.op).toBe('create');
            if (c.op === 'edit' || c.op === 'delete') expect(c.path).not.toMatch(/^specs\/capabilities\/.+\.md$/);
          }
          if (s.id !== 'first-ci-note') for (const c of s.commands ?? []) expect(c).not.toMatch(/^git (commit|push|add)\b/);
        }
      }
    }
  });

  // [claims: capabilities/platform-foundation#migrate-v1-route]
  it('v0.1 plan redrafts as-built by default: archive with moves, draft and tag by the agent, ledger rows set aside', () => {
    const plan = byId(planMigration(v01(3), OPTS));
    expect(plan['archive-v1']).toMatchObject({ state: 'todo' });
    expect(plan['archive-v1']!.changes).toEqual([
      { path: 'specs/core/mod-0.md', op: 'move' },
      { path: 'specs/core/mod-1.md', op: 'move' },
      { path: 'specs/core/mod-2.md', op: 'move' },
    ]);
    expect(plan['archive-v1']!.commands).toEqual([
      'mkdir -p specs/_archive/v1/core',
      'git mv specs/core/mod-0.md specs/_archive/v1/core/mod-0.md',
      'git mv specs/core/mod-1.md specs/_archive/v1/core/mod-1.md',
      'git mv specs/core/mod-2.md specs/_archive/v1/core/mod-2.md',
    ]);
    expect(plan.draft).toMatchObject({ state: 'agent', commands: ['specguard spec draft --yes'] });
    expect(plan.tag).toMatchObject({ state: 'agent', commands: ['specguard spec tag --yes'] });
    expect(plan['drop-v1-ledger']!.state).toBe('todo');
    expect(plan['as-built-approval']).toMatchObject({ state: 'person', commands: ['specguard spec approve --all --as-built --yes', 'specguard test run'] });
    expect(plan['first-ci-note']!.commands).toContain('git add -A');
    expect(plan['first-ci-note']!.commands).toContain('git commit -m "chore: specs redrafted as capabilities (specguard migrate)"');
  });

  // [claims: capabilities/platform-foundation#migrate-v1-route]
  it('a v1 repo with a huge spec count still redrafts by default and lists the consolidate alternative', () => {
    const plan = byId(planMigration(v01(80), OPTS));
    expect(plan['archive-v1']!.state).toBe('todo');
    expect(plan['archive-v1']!.changes).toHaveLength(80);
    expect(plan['archive-v1']!.description).toContain('redraft as-built');
    expect(plan['archive-v1']!.description).toContain('`specguard migrate --consolidate --yes`');
    expect(plan['archive-v1']!.description).toContain('80 per-file specs');
    expect(plan.draft!.description).toContain('--consolidate');
    expect(plan.draft!.state).toBe('agent');
  });

  // [claims: capabilities/platform-foundation#migrate-v1-route]
  it('consolidate swaps archive, draft, tag and drop-v1-ledger for spec consolidate', () => {
    const plan = byId(planMigration(v01(5), { ...OPTS, consolidate: true }));
    expect(plan['archive-v1']).toMatchObject({ state: 'agent', commands: ['specguard spec consolidate --yes'] });
    expect(plan['archive-v1']!.changes).toContainEqual({ path: 'specs/core/mod-0.md', op: 'move' });
    for (const id of ['draft', 'tag', 'drop-v1-ledger']) {
      expect(plan[id]!.state).toBe('skip');
      expect(plan[id]!.description).toContain('spec consolidate');
    }
    expect(plan['as-built-approval']!.state).toBe('person');
  });

  // [claims: capabilities/platform-foundation#migrate-v1-route]
  it('a repo with capability specs drafted beside leftover per-file specs resumes: draft is done, archive and tag remain', () => {
    const f: RepoFacts = { ...v01(2), v2Specs: ['specs/capabilities/core.md'] };
    expect(detectFormat(f)).toBe('v0.1');
    const s = states(planMigration(f, OPTS));
    expect(s).toMatchObject({ 'archive-v1': 'todo', draft: 'done', tag: 'agent', 'as-built-approval': 'person' });
    expect(states(planMigration({ ...f, hasApprovals: true }, OPTS))['as-built-approval']).toBe('skip');
  });

  // [claims: capabilities/platform-foundation#migrate-v1-route]
  it('a redrafted repo with leftover approvals still needs the person approval, and with no rows nothing is set aside', () => {
    const plan = byId(planMigration({ ...v01(2), hasApprovals: true, ledgerRows: 0 }, OPTS));
    expect(plan['as-built-approval']!.state).toBe('person');
    expect(plan['drop-v1-ledger']!.state).toBe('skip');
  });

  // [claims: capabilities/platform-foundation#migrate-ordered-plan]
  it('without git the git steps are blocked with the reason and the rest of the plan still stands', () => {
    const plan = byId(planMigration({ ...v02(), git: false }, { ...OPTS, fetchNotes: true }));
    for (const id of ['untrack-ledger', 'untrack-trace', 'notes-fetch', 'first-ci-note']) {
      expect(plan[id]!.state).toBe('skip');
      expect(plan[id]!.description).toMatch(/^Blocked: /);
    }
    expect(plan['first-ci-note']!.description).toContain('git init');
    expect(plan.gitignore!.state).toBe('todo');
    expect(plan.config!.state).toBe('todo');
    expect(plan['as-built-approval']!.state).toBe('person');
    const v1 = byId(planMigration({ ...v01(1), git: false }, OPTS));
    expect(v1['archive-v1']!.commands).toContain('mv specs/core/mod-0.md specs/_archive/v1/core/mod-0.md');
  });

  // [claims: capabilities/platform-foundation#migrate-ordered-plan]
  it('every step has a state from the contract, a description, and ids are unique', () => {
    const ids = new Set<MigrateStepId>();
    for (const f of [v02(), v01(), current(), { ...current(), v2Specs: [] }]) {
      for (const s of planMigration(f, { consolidate: false, fetchNotes: true, workflow: true })) {
        expect(['todo', 'done', 'skip', 'person', 'agent']).toContain(s.state);
        expect(s.description.length).toBeGreaterThan(10);
        ids.add(s.id);
      }
    }
    expect(ids.size).toBe(MIGRATE_STEP_IDS.length);
  });
});
