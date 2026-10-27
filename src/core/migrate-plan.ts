/**
 * Migration planning: from facts about a repository (spec format, tracked generated state, ignore block, notes
 * refspec, workflow) to the ordered steps that bring it to the current layout. Pure: `migrate` gathers the facts,
 * applies the steps and rolls them back; this module only decides what is to do, and so is the whole of `migrate`'s
 * dry run.
 *
 * Spec: specs/capabilities/platform-foundation.md
 * Contract: signatures are frozen. Additions: the optional `RepoFacts.git`, `MIGRATE_NEVER_TOUCHED`,
 * `migrationComplete` and `renderMigrationPlan`.
 */

export const REPO_FORMATS = ['none', 'v0.1', 'v0.2-0.3', 'v0.6'] as const;
export type RepoFormat = (typeof REPO_FORMATS)[number];

export interface RepoFacts {
  hasConfig: boolean;
  /** Spec files without `kind:` frontmatter (outside _archive). */
  v1Specs: string[];
  v2Specs: string[];
  tracked: { proofs: boolean; trace: boolean; activityLog?: boolean; publishSnapshot: boolean };
  gitignoreBlock: 'missing' | 'outdated' | 'current';
  hasApprovals: boolean;
  notes: { localRef: boolean; fetchRefspec: boolean };
  workflow: { path?: string; generatedBySpecguard: boolean; hasProve: boolean };
  /** `git status --porcelain` paths. */
  dirty: string[];
  /** Rows in the local proof cache (`.specguard/proofs.json`). */
  ledgerRows: number;
  /** Local cache rows whose origin is absent or `ci`: the ones `provisional-rows` rewrites. */
  ledgerOriginCi: number;
  /** Whether the directory is a git work tree. Absent means yes. */
  git?: boolean;
}

export const MIGRATE_STEP_IDS = [
  // v0.1 only
  'archive-v1', 'draft', 'tag', 'drop-v1-ledger',
  'gitignore', 'untrack-ledger', 'untrack-trace', 'untrack-activity-log', 'provisional-rows',
  'config', 'notes-fetch', 'workflow', 'hooks',
  // printed only
  'as-built-approval',
  'first-ci-note',
] as const;
export type MigrateStepId = (typeof MIGRATE_STEP_IDS)[number];

/** `person` = a command the person must run; `agent` = needs the host agent (exit 12, resumable). */
export const MIGRATE_STEP_STATES = ['todo', 'done', 'skip', 'person', 'agent'] as const;

export interface MigrateStep {
  id: MigrateStepId;
  state: (typeof MIGRATE_STEP_STATES)[number];
  description: string;
  /** Exact shell, for person/agent steps and the dry-run listing. */
  commands?: string[];
  changes?: Array<{ path: string; op: 'create' | 'edit' | 'move' | 'untrack' | 'delete' }>;
}

/** What no step of `migrate` reads for change, writes or runs: shown in every dry run. */
export const MIGRATE_NEVER_TOUCHED: readonly string[] = [
  'the text and claims of capability specs (v2)',
  'test files (only `spec tag`, the agent step of the v0.1 route, adds claim comments to them)',
  'source code',
  'specs/history/',
  'existing approvals (migrate never approves: the as-built approval is yours to run)',
  'workflows other than the one SpecGuard generated',
  'git history and remote refs (migrate never commits, never stages and never pushes)',
];

const LEDGER = '.specguard/proofs.json';
const TRACE = '.specguard/trace.json';
const CONFIG = '.specguard/config.json';
const WORKFLOW = '.github/workflows/specguard.yml';
const ARCHIVE_ROOT = 'specs/_archive/v1';
const NOTES_REFSPEC = '+refs/notes/specguard:refs/notes/specguard';
const APPROVE = 'specguard spec approve --all --as-built --yes';

function hasCurrentLayout(f: RepoFacts): boolean {
  return !f.tracked.proofs && !f.tracked.trace && !f.tracked.activityLog && f.gitignoreBlock === 'current' && f.ledgerOriginCi === 0;
}

/**
 * Per-file (v1) specs still in place -> v0.1, with or without capability specs beside them (a partly redrafted repo);
 * capability specs and (tracked proofs or trace, a missing or outdated ignore block, or local rows claiming a CI origin)
 * -> v0.2-0.3; capability specs and all current -> v0.6; no specs of either kind -> none.
 */
export function detectFormat(f: RepoFacts): RepoFormat {
  // Per-file specs still in place mean the v0.1 route is unfinished, even when capability specs already exist beside them.
  if (f.v1Specs.length > 0) return 'v0.1';
  if (f.v2Specs.length > 0) return hasCurrentLayout(f) ? 'v0.6' : 'v0.2-0.3';
  // `hasConfig` does not change the answer: a configured repo without specs has nothing to migrate either.
  return 'none';
}

/** Where a v1 spec goes: `specs/<rel>` becomes `specs/_archive/v1/<rel>`. */
function archivePath(path: string): string {
  const rel = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^specs\//, '');
  return `${ARCHIVE_ROOT}/${rel}`;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
}

type Opts = { consolidate: boolean; fetchNotes: boolean; workflow: boolean };

function build(f: RepoFacts, opts: Opts, format: RepoFormat): Record<MigrateStepId, MigrateStep> {
  const git = f.git !== false;
  const v01 = format === 'v0.1';
  const current = format === 'v0.6';
  const out = {} as Record<MigrateStepId, MigrateStep>;
  const put = (id: MigrateStepId, state: MigrateStep['state'], description: string, extra: Partial<Pick<MigrateStep, 'commands' | 'changes'>> = {}): void => {
    out[id] = { id, state, description, ...extra };
  };

  if (format === 'none') {
    const hint = f.hasConfig
      ? ' If an earlier `migrate` stopped at the draft step, run `specguard spec draft --yes` and then `specguard migrate` again.'
      : ' Run `specguard init` to start a project.';
    for (const id of MIGRATE_STEP_IDS) put(id, 'skip', `Nothing to migrate: no specs were found.${hint}`);
    return out;
  }

  // v0.1 only: archive, draft, tag, drop-v1-ledger.
  const notV01 = 'Not a v0.1 repository: no per-file specs are left.';
  const count = f.v1Specs.length;
  const alternative = `Alternative for hand-written intent worth keeping (${count} per-file spec${count === 1 ? '' : 's'}): \`specguard migrate --consolidate --yes\` rekeys tags, proofs and drift state instead.`;
  if (!v01) {
    put('archive-v1', 'skip', notV01);
    put('draft', 'skip', notV01);
    put('tag', 'skip', notV01);
    put('drop-v1-ledger', 'skip', notV01);
  } else if (opts.consolidate) {
    put(
      'archive-v1',
      'agent',
      `Consolidate ${count} per-file spec${count === 1 ? '' : 's'} into capability specs with \`spec consolidate\`, which also archives the originals under ${ARCHIVE_ROOT}, rekeys tags, proofs and drift state, and replaces the draft, tag and drop-v1-ledger steps. Needs the host agent; stops with exit 12 while it works.`,
      {
        commands: ['specguard spec consolidate --yes'],
        changes: [...f.v1Specs.map((path) => ({ path, op: 'move' as const })), { path: 'specs/capabilities/', op: 'create' as const }],
      },
    );
    for (const id of ['draft', 'tag', 'drop-v1-ledger'] as const) put(id, 'skip', 'Replaced by `spec consolidate` (--consolidate).');
  } else {
    const dirs = [...new Set(f.v1Specs.map((p) => dirOf(archivePath(p))))];
    const mv = git ? 'git mv' : 'mv';
    put(
      'archive-v1',
      'todo',
      `Default route, redraft as-built: move ${count} per-file spec${count === 1 ? '' : 's'} to ${ARCHIVE_ROOT}/ (the loaders skip _archive) and draft capability specs from the code. ${alternative}`,
      {
        commands: [...dirs.map((d) => `mkdir -p ${d}`), ...f.v1Specs.map((p) => `${mv} ${p} ${archivePath(p)}`)],
        changes: f.v1Specs.map((path) => ({ path, op: 'move' as const })),
      },
    );
    if (f.v2Specs.length > 0) put('draft', 'done', `${f.v2Specs.length} capability spec(s) already exist.`);
    else
      put('draft', 'agent', `Draft capability specs from the code as built. Needs the host agent; stops with exit 12 while it works, and \`migrate --yes\` resumes. ${alternative}`, {
        commands: ['specguard spec draft --yes'],
        changes: [{ path: 'specs/capabilities/', op: 'create' }],
      });
    put('tag', 'agent', 'Link existing tests to the drafted requirements as claim comments above each test (the only edit migrate lets reach test files). Needs the host agent; safe to repeat.', {
      commands: ['specguard spec tag --yes'],
    });
    if (f.ledgerRows === 0) put('drop-v1-ledger', 'skip', 'No proof rows in the local cache.');
    else
      put('drop-v1-ledger', 'todo', 'Move local proof rows keyed to the archived spec keys into the backup: they cannot prove capability claims.', {
        changes: [{ path: LEDGER, op: 'edit' }],
      });
  }

  // gitignore
  if (f.gitignoreBlock === 'current') put('gitignore', 'done', 'The managed ignore block in .gitignore is current.');
  else
    put(
      'gitignore',
      'todo',
      f.gitignoreBlock === 'missing'
        ? 'Add the managed generated-state block to .gitignore (it lists .specguard/proofs.json and .specguard/trace.json).'
        : 'Refresh the managed generated-state block in .gitignore (it now lists .specguard/proofs.json).',
      { changes: [{ path: '.gitignore', op: 'edit' }] },
    );

  // untrack
  const untrack = (id: 'untrack-ledger' | 'untrack-trace', file: string, tracked: boolean, what: string): void => {
    if (!git) put(id, 'skip', `Blocked: this is not a git repository, so ${file} is not tracked.`);
    else if (!tracked) put(id, 'done', `${file} is not tracked.`);
    else
      put(
        id,
        'todo',
        `Stop tracking ${file} (${what}); the file stays on disk. Other clones lose the file when they pull this commit; their next CI note replaces it.`,
        { commands: [`git rm --cached --quiet -- ${file}`], changes: [{ path: file, op: 'untrack' }] },
      );
  };
  untrack('untrack-ledger', LEDGER, f.tracked.proofs, 'proofs now live in git notes');
  untrack('untrack-trace', TRACE, f.tracked.trace, 'generated per run');
  if (!git) put('untrack-activity-log', 'skip', 'Blocked: this is not a Git repository, so no activity log is tracked.');
  else if (!f.tracked.activityLog) put('untrack-activity-log', 'done', 'The runtime activity log is not tracked.');
  else put('untrack-activity-log', 'todo', 'Stop tracking the runtime activity log; keep its content on disk so post-commit logging cannot dirty the repository again.', {
    commands: ['git rm --cached --quiet -- .specguard/activity-log.json'],
    changes: [{ path: '.specguard/activity-log.json', op: 'untrack' }],
  });

  // provisional-rows
  if (f.ledgerRows === 0) put('provisional-rows', 'skip', 'No proof rows in the local cache.');
  else if (f.ledgerOriginCi === 0) put('provisional-rows', 'done', 'No local row claims a CI origin.');
  else
    put(
      'provisional-rows',
      'todo',
      `Mark ${f.ledgerOriginCi} local proof row(s) as origin local with an imported marker: committed rows earned no CI trust. A backup goes to .specguard/cache/migrate/<timestamp>/proofs.json.`,
      { changes: [{ path: LEDGER, op: 'edit' }, { path: '.specguard/cache/migrate/', op: 'create' }] },
    );

  // config: the facts do not say which keys exist, so the step is done only when the repo is otherwise current.
  if (current && f.hasConfig) put('config', 'done', 'The configuration needs no change.');
  else
    put(
      'config',
      'todo',
      f.hasConfig
        ? 'Add `proofStore: {}` and `enforce: { default: "observe" }` to the configuration where absent; nothing else in it changes.'
        : 'Create the configuration with `proofStore: {}` and `enforce: { default: "observe" }`.',
      { changes: [{ path: CONFIG, op: f.hasConfig ? 'edit' : 'create' }] },
    );

  // notes-fetch
  const fetchCmd = `git config --add remote.origin.fetch ${NOTES_REFSPEC}`;
  if (!git) put('notes-fetch', 'skip', 'Blocked: proof notes need a git repository.');
  else if (f.notes.fetchRefspec) put('notes-fetch', 'done', 'The notes refspec is configured for fetch.');
  else if (opts.fetchNotes) put('notes-fetch', 'todo', 'Configure `git fetch` to bring the proof notes ref along.', { commands: [fetchCmd], changes: [{ path: '.git/config', op: 'edit' }] });
  else put('notes-fetch', 'skip', 'Not requested: pass --fetch-notes, or run the command yourself, to fetch proof notes with every `git fetch`.', { commands: [fetchCmd] });

  // workflow
  if (f.workflow.hasProve) put('workflow', 'done', `${f.workflow.path ?? WORKFLOW} already runs the prove gate.`);
  else if (!opts.workflow)
    put('workflow', 'skip', 'Not requested: pass --workflow to re-render the generated workflow, or to print what to add to a hand-written one.');
  else if (f.workflow.path && f.workflow.generatedBySpecguard)
    put('workflow', 'todo', `Re-render ${f.workflow.path} with the prove gate, its permissions and the pull request head checkout, and show the diff.`, {
      changes: [{ path: f.workflow.path, op: 'edit' }],
    });
  else if (f.workflow.path)
    put(
      'workflow',
      'person',
      `${f.workflow.path} was not generated by SpecGuard, so migrate leaves it alone. Add the prove gate, its permissions (checks: write, contents: write for notes) and a checkout of the pull request head commit; migrate prints the snippet.`,
    );
  else put('workflow', 'todo', `Write ${WORKFLOW}: the pull request gate with the prove step.`, { changes: [{ path: WORKFLOW, op: 'create' }] });

  // hooks
  if (current) put('hooks', 'done', 'No hook change needed.');
  else
    put('hooks', 'todo', 'When .claude/settings.json already has SpecGuard hooks, add the guard hooks; plugin users need nothing, and a repository without hooks is left as is.', {
      changes: [{ path: '.claude/settings.json', op: 'edit' }],
    });

  // as-built approval: person only
  const approveCmds = v01 ? [APPROVE, 'specguard test run'] : [APPROVE];
  const redrafted = v01 && f.v2Specs.length === 0;
  if (current) put('as-built-approval', 'skip', 'Nothing was migrated; approve new claims with `specguard spec approve`.');
  else if (f.hasApprovals && !redrafted) put('as-built-approval', 'skip', 'Every claim is already approved.');
  else
    put(
      'as-built-approval',
      'person',
      'Person only, never run by migrate or an agent: accept what the code does today as the intent, in your own terminal, and only if the code works as intended.',
      { commands: approveCmds },
    );

  // first CI note: printed
  const msg = v01 ? 'chore: specs redrafted as capabilities (specguard migrate)' : 'chore: proofs move to git notes (specguard migrate)';
  const stage = v01 ? 'git add -A' : 'git add -A .gitignore .specguard specs .github';
  if (!git)
    put('first-ci-note', 'skip', 'Blocked: needs a git repository with a remote. Run `git init`, add the remote, then commit and push so CI writes the first proof note.');
  else if (current)
    put('first-ci-note', 'done', f.notes.localRef ? 'A proof note is already present.' : 'Nothing to commit. When CI has written its first note, run `specguard proof fetch`.');
  else
    put(
      'first-ci-note',
      'person',
      'Person only: review the changes, commit and push; CI then writes the first proof note, and `specguard proof fetch` brings it in. Then raise enforcement per capability with `specguard enforce raise <capability> --to warn`.',
      { commands: [stage, `git commit -m "${msg}"`, 'git push', 'specguard proof fetch', 'specguard check'] },
    );
  return out;
}

export function planMigration(f: RepoFacts, opts: { consolidate: boolean; fetchNotes: boolean; workflow: boolean }): MigrateStep[] {
  const steps = build(f, opts, detectFormat(f));
  return MIGRATE_STEP_IDS.map((id) => steps[id]);
}

/** True when no step has work left for the tool or the person: every step is `done` or `skip`. Exit 0 with nothing to do. */
export function migrationComplete(steps: MigrateStep[]): boolean {
  return steps.every((s) => s.state === 'done' || s.state === 'skip');
}

/** The dry-run text: format, every step with its state and paths and commands, what is never touched, how to apply. */
export function renderMigrationPlan(f: RepoFacts, opts: { consolidate: boolean; fetchNotes: boolean; workflow: boolean }): string {
  const format = detectFormat(f);
  const steps = planMigration(f, opts);
  const lines = [`specguard migrate: dry run, nothing was changed. Detected format: ${format}.`, ''];
  for (const s of steps) {
    lines.push(`[${s.state}] ${s.id}: ${s.description}`);
    for (const c of s.changes ?? []) lines.push(`    ${c.op} ${c.path}`);
    for (const c of s.commands ?? []) lines.push(`    $ ${c}`);
  }
  lines.push('', 'Never touched:');
  for (const n of MIGRATE_NEVER_TOUCHED) lines.push(`  - ${n}`);
  lines.push('');
  if (migrationComplete(steps)) lines.push('Nothing to do: the repository is already current.');
  else {
    const flags = ['--yes', opts.consolidate ? '--consolidate' : '', opts.fetchNotes ? '--fetch-notes' : '', opts.workflow ? '--workflow' : ''].filter(Boolean).join(' ');
    const person = steps.filter((s) => s.state === 'person').map((s) => s.id);
    lines.push(`Apply with: specguard migrate ${flags}. It refuses a dirty working tree (use --allow-dirty), never commits, and can be undone with \`specguard migrate --rollback\`.`);
    if (person.length > 0) lines.push(`Left for you (never run by migrate): ${person.join(', ')}.`);
  }
  return lines.join('\n');
}
