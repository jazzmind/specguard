/**
 * Harness scaffold — generates the agent-harness files that let an AI coding
 * agent run SpecGuard alongside a build.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 *
 * Language-aware (parameterized by a LanguageProfile) and harness-aware (Claude
 * Code, Cursor, or both). Idempotent and non-clobbering: managed Markdown files
 * carry a `<!-- specguard-managed: true -->` marker and are only overwritten
 * when present; CLAUDE.md is updated via sentinels; JSON configs are deep-merged.
 */
import path from 'node:path';

import type { LanguageProfile } from './language-profiles.js';
import { readFile, fileExists } from './reader.js';
import { writeFile } from './writer.js';
import { applyTargetSections } from './sentinels.js';
import { NPX_CLI, NPX_RUNNER, resolveRunner, type ResolvedRunner, type RunnerChoice } from './runner.js';

export type Harness = 'claude' | 'cursor' | 'both';

export interface ScaffoldOpts {
  cwd: string;
  profile: LanguageProfile;
  harness?: Harness;
  /** How generated MCP/hook commands invoke SpecGuard (default: local binary, else npx). */
  runner?: RunnerChoice['runner'];
  runnerPath?: string;
  /** Apply a differing existing MCP entry/hook instead of printing its diff. */
  updateHooks?: boolean;
  /** Also wire the requirement-history hooks into `.claude/settings.local.json` (personal, not committed). */
  historyHooks?: boolean;
}

export interface ScaffoldResult {
  created: string[];
  updated: string[];
  skipped: string[];
  messages: string[];
}

/** Marker identifying a file SpecGuard owns and may overwrite. */
const MANAGED_MARKER = '<!-- specguard-managed: true -->';

// ---------------------------------------------------------------------------
// Content generators (language-parameterized)
// ---------------------------------------------------------------------------

const COMMAND_TABLE = (p: LanguageProfile): string =>
  [
    '| Command | What it does |',
    '|---------|-------------|',
    '| `specguard check` | Spec health for the whole system: ownership, tests, proofs, gaps, drift. Start here |',
    '| `specguard spec graph` | The spec tree, the files each spec owns, and rule violations |',
    '| `specguard spec draft` | Write the system spec and functional capability specs from existing code |',
    '| `specguard history add` | Record why a requirement changed: a prompt, plan or decision |',
    '| `specguard test run` | Run the tests and record the results as proof |',
    '| `specguard verify --all --url <base>` | Judge the running app against each capability\'s problem and value |',
    '| `specguard security scan` | Code, dependency, secret and spec-level findings as one remediation plan |',
    '| `specguard serve` | Docs and audit API, with a web UI |',
    `| (tests run via) | \`${p.testCommand}\` |`,
    '',
    'Without a global install, run any command as `npx -p specguard-ai specguard <command>`.',
  ].join('\n');

/** AGENTS.md — harness-agnostic agent guide. */
export function buildAgentsMd(profile: LanguageProfile): string {
  return `# AGENTS.md

${MANAGED_MARKER}

## SpecGuard Enforced (${profile.id})

This repository uses **SpecGuard** for spec-driven QA. Code is fluid; the specs in
\`specs/\`, and the tests that prove the code conforms to them, are the source of truth.
\`specs/system.md\` describes the whole system; each file in \`specs/capabilities/\` describes
one piece of functionality that delivers value, and lists the code, tests and docs behind it.
As an AI agent you **must** keep specs and code in sync.

### Workflow

1. **Find the spec.** \`specguard spec graph\` shows which capability owns a file. Read it, and
   \`specs/system.md\`, before changing the code (target language: ${profile.id}).
2. **Edit** — make your code changes.
3. **Update the spec** — if behaviour or requirements change, edit the capability spec: its
   requirements are the bullets under \`## Requirements\`, each with a claim id
   (\`<!-- claim: some-id -->\`). Record why with \`specguard history add\` (or let the
   history hooks capture the plan).
4. **Prove it** — run the tests (\`${profile.testCommand}\`). Tag a test that proves a requirement
   with a comment above it: \`// [claims: capabilities/<id>#<claim-id>]\`. Then run
   \`specguard check\`; it reports files no spec owns, untested requirements, stale proofs and drift.
5. **Report** — include the \`check\` summary in your response.

> **Tip**: A project with no specs yet starts with \`specguard spec draft\`; one with a spec per
> file moves to capability specs with \`specguard spec consolidate\`. \`specguard spec tag\`
> links existing tests to the requirements they prove.

### Pipelines

${COMMAND_TABLE(profile)}

### Safety Rules

- NO secrets or credentials in code.
- NEVER edit a spec to make a gap disappear — implement the code instead.
- Treat \`heal\` \`app-bug\` results as real defects, not test problems.
`;
}

/** SKILL.md body, shared between Claude Code and Cursor. */
export function buildSkill(profile: LanguageProfile): string {
  return `---
name: specguard
description: >-
  SpecGuard QA agent. Maintains Living Specs as the single source of truth
  alongside coding work. Use after a build step, when checking spec coverage,
  generating tests from a spec, or validating the app against a spec.
---

${MANAGED_MARKER}

# SpecGuard Skill (${profile.id})

The \`specguard\` CLI and MCP server run every QA pipeline. Prefer the MCP tools
(\`specguard_*\`) when available; otherwise use \`npx -p specguard-ai specguard <command>\`
(or just \`specguard <command>\` when the CLI is installed with \`npm install -g specguard-ai\`).

## When to Run

- After implementing or changing a module (check coverage + drift).
- When the user asks for spec coverage, test generation, or validation.
- Security-sensitive files changed (\`**/auth/**\`, \`**/api/**\`).

## Quick Reference

${COMMAND_TABLE(profile)}

## Build-from-specs Loop

1. \`specguard check --gaps\` → what is unowned, untested, stale or failing.
2. Implement one capability's requirements against its spec.
3. Write tests and tag each with the requirement it proves (\`// [claims: capabilities/<id>#<claim-id>]\`).
4. \`specguard test run\` → results become proof; \`specguard check\` shows what is proven.
5. Repeat until every requirement is proven.

Tests for this project run with \`${profile.testCommand}\`.
`;
}

/** /goal command — drives a module-by-module build from specs + plans. */
export function buildGoalCommand(profile: LanguageProfile): string {
  return `---
description: Build the whole project from its specs, with SpecGuard tracking coverage.
---

${MANAGED_MARKER}

# /goal — Build everything from the specs

You are building this ${profile.id} project from its Living Specifications.

## Steps

1. Run \`specguard check --gaps\` (or the \`specguard_check\` MCP tool). It lists the
   requirements nothing proves yet.
2. Read \`specs/system.md\` and \`specs/capabilities/**\` — the specs are the source of
   truth. Read a capability's spec before implementing it.
3. Build an ordered capability list, in dependency order.
4. For each capability:
   - Implement its requirements (language: ${profile.id}).
   - Write tests and tag each with the requirement it proves
     (\`// [claims: capabilities/<id>#<claim-id>]\`).
   - Run \`specguard test run\` (tests run via \`${profile.testCommand}\`) and confirm
     \`specguard check\` shows the requirements proven.
5. Stop when \`specguard check\` shows every requirement proven.

## Rules

- NEVER edit a spec to make a gap disappear — implement the code.
- A failing proven requirement is a real defect: fix the code, do not weaken the test.
- Keep going capability-by-capability; report progress after each.
`;
}

/** CLAUDE.md sentinel sections (created/updated, surrounding prose preserved). */
function claudeMdSections(profile: LanguageProfile): { sentinel: string; content: string }[] {
  return [
    {
      sentinel: 'specguard-workflow',
      content: [
        '## SpecGuard',
        '',
        `This project uses SpecGuard for spec-driven QA (language: **${profile.id}**).`,
        'Specs in `specs/` are the source of truth: `specs/system.md` describes the system,',
        'each file in `specs/capabilities/` one piece of functionality. Read the capability',
        'that owns a file (`specguard spec graph`) before editing it.',
        '',
        'After changing code, update the capability spec, record why with `specguard history add`,',
        `and run \`specguard check\`. Tests run with \`${profile.testCommand}\`; tag a test with the`,
        'requirement it proves: `// [claims: capabilities/<id>#<claim-id>]`. Run `/goal` to build',
        'the whole project from its specs.',
      ].join('\n'),
    },
    {
      sentinel: 'specguard-commands',
      content: COMMAND_TABLE(profile),
    },
  ];
}

// ---------------------------------------------------------------------------
// JSON config builders (pure — caller persists)
// ---------------------------------------------------------------------------

interface JsonObject {
  [key: string]: unknown;
}

export { NPX_CLI };

/** The specguard-mcp server entry (shared by Claude + Cursor configs). */
export function mcpServerEntry(runner: ResolvedRunner = NPX_RUNNER): JsonObject {
  return { command: runner.mcp.command, args: [...runner.mcp.args] };
}

/** How `init`/`scaffold` wire MCP and hooks; existing user entries change only with `update`. */
export interface WireContext {
  runner: ResolvedRunner;
  /** Replace an existing, differing MCP entry or hook (the `--update-hooks` confirm flag). */
  update: boolean;
  /** Receives a diff for every existing entry left alone. */
  notes: string[];
}

interface HookSpec {
  event: string;
  /** Tool matcher; absent for events that take none (UserPromptSubmit). */
  matcher?: string;
  /** Substring that identifies our entry among the user's own hooks. */
  marker: string;
  command: string;
}

/**
 * Add one hook to a settings `hooks` object, identified by `marker`. A differing
 * existing entry is left alone with a diff unless `ctx.update` is set.
 */
function ensureHook(hooks: JsonObject, spec: HookSpec, where: string, ctx: WireContext): void {
  const list = Array.isArray(hooks[spec.event]) ? [...(hooks[spec.event] as unknown[])] : [];
  let found = false;
  for (const entry of list as Array<{ hooks?: Array<{ command?: string }> }>) {
    for (const h of entry.hooks ?? []) {
      if (typeof h.command !== 'string' || !h.command.includes(spec.marker)) continue;
      found = true;
      if (h.command === spec.command) continue;
      if (ctx.update) h.command = spec.command;
      else {
        ctx.notes.push(
          `  differs  ${where} ${spec.event} hook (left unchanged; re-run with --update-hooks to apply):`,
          `    - ${h.command}`,
          `    + ${spec.command}`,
        );
      }
    }
  }
  if (!found) {
    list.push({ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [{ type: 'command', command: spec.command }] });
  }
  hooks[spec.event] = list;
}

/**
 * The requirement-history hooks. Both print nothing (a UserPromptSubmit hook's
 * stdout would be added to the model's context), use the resolved runner rather
 * than an npx cold start, and never fail the session.
 */
export function historyHookSpecs(runner: ResolvedRunner): HookSpec[] {
  return [
    { event: 'UserPromptSubmit', marker: 'history inbox', command: `${runner.cli} history inbox >/dev/null 2>&1 || true` },
    { event: 'PostToolUse', matcher: 'ExitPlanMode', marker: 'history capture', command: `${runner.cli} history capture >/dev/null 2>&1 || true` },
  ];
}

/** Merge the history hooks into a settings object (used for `settings.local.json`). */
export function mergeHistoryHooks(existing: JsonObject, ctx: WireContext = defaultWire()): JsonObject {
  const next: JsonObject = { ...existing };
  const hooks = { ...(next.hooks as JsonObject | undefined) };
  for (const spec of historyHookSpecs(ctx.runner)) ensureHook(hooks, spec, '.claude/settings.local.json', ctx);
  next.hooks = hooks;
  return next;
}

function defaultWire(): WireContext {
  return { runner: NPX_RUNNER, update: false, notes: [] };
}

/**
 * `npx specguard-mcp` resolves to an unrelated or missing package. Entries that
 * older SpecGuard versions wrote that way are repaired; anything else the user
 * wrote is left alone.
 */
function isBrokenMcpEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as { command?: unknown; args?: unknown };
  return e.command === 'npx' && Array.isArray(e.args) && e.args.length === 1 && e.args[0] === 'specguard-mcp';
}

/** Add the MCP entry, repair a known-broken one, and never silently rewrite a differing one. */
function wireMcp(mcpServers: JsonObject, where: string, ctx: WireContext): void {
  const wanted = mcpServerEntry(ctx.runner);
  const current = mcpServers['specguard-mcp'];
  if (!current || isBrokenMcpEntry(current)) {
    mcpServers['specguard-mcp'] = wanted;
    return;
  }
  if (JSON.stringify(current) === JSON.stringify(wanted)) return;
  if (ctx.update) {
    mcpServers['specguard-mcp'] = wanted;
    return;
  }
  ctx.notes.push(
    `  differs  ${where} specguard-mcp (left unchanged; re-run with --update-hooks to apply, ${ctx.runner.comment}):`,
    `    - ${JSON.stringify(current)}`,
    `    + ${JSON.stringify(wanted)}`,
  );
}

const SANITIZE = /["$`\\]/g;

/** The PostToolUse shell command. A leading no-op string records which runner was chosen and why. */
export function hookCommand(runner: ResolvedRunner): string {
  return (
    `: "specguard runner: ${runner.comment.replace(SANITIZE, '')}"; ` +
    'f="$(cat | sed -n \'s/.*"file_path"[: ]*"\\([^"]*\\)".*/\\1/p\')"; ' +
    'case "$f" in *"/specs/"*|*"/tests/"*|*"/.specguard/"*) exit 0;; esac; ' +
    `${runner.cli} status 2>/dev/null | tail -3 || true`
  );
}

/** Strip the leading runner comment so comment-only differences are not diffs. */
function withoutRunnerComment(command: string): string {
  return command.replace(/^: "specguard runner: [^"]*"; /, '');
}

/** Merge the specguard-mcp server + run-alongside hook into Claude settings. */
export function mergeClaudeSettings(existing: JsonObject, ctx: WireContext = defaultWire()): JsonObject {
  const next: JsonObject = { ...existing };

  const mcpServers = { ...(next.mcpServers as JsonObject | undefined) };
  wireMcp(mcpServers, '.claude/settings.json', ctx);
  next.mcpServers = mcpServers;

  // PostToolUse hook: read-only `specguard status` after edits. The script
  // itself skips spec/test/.specguard paths.
  const hooks = { ...(next.hooks as JsonObject | undefined) };
  const postToolUse = Array.isArray(hooks.PostToolUse) ? [...(hooks.PostToolUse as unknown[])] : [];
  const wanted = hookCommand(ctx.runner);
  let alreadyWired = false;
  for (let i = 0; i < postToolUse.length; i += 1) {
    let text = JSON.stringify(postToolUse[i]);
    if (!text.includes('specguard status')) continue;
    alreadyWired = true;
    // Repair a hook an older version wrote as `npx specguard status`.
    if (text.includes('npx specguard status')) {
      text = text.split('npx specguard status').join(`${NPX_CLI} status`);
      postToolUse[i] = JSON.parse(text);
    }
    const entry = postToolUse[i] as { hooks?: Array<{ command?: string }> };
    for (const h of entry.hooks ?? []) {
      if (typeof h.command !== 'string' || !h.command.includes('specguard status')) continue;
      if (withoutRunnerComment(h.command) === withoutRunnerComment(wanted)) continue;
      if (ctx.update) {
        h.command = wanted;
      } else {
        ctx.notes.push(
          `  differs  .claude/settings.json PostToolUse hook (left unchanged; re-run with --update-hooks to apply, ${ctx.runner.comment}):`,
          `    - ${withoutRunnerComment(h.command)}`,
          `    + ${withoutRunnerComment(wanted)}`,
        );
      }
    }
  }
  if (!alreadyWired) {
    postToolUse.push({
      matcher: 'Edit|Write|MultiEdit',
      hooks: [{ type: 'command', command: wanted }],
    });
  }
  hooks.PostToolUse = postToolUse;
  next.hooks = hooks;

  return next;
}

/** The specguard-sync always-applied Cursor rule content. */
export function buildSyncRule(): string {
  return `# SpecGuard Spec Sync

## After modifying source files

Specs describe functionality, not files: \`specs/system.md\` is the whole system and each
file in \`specs/capabilities/\` is one capability, with the code, tests and docs behind it.
When you change behaviour, keep the spec in sync:

1. **Find the owning capability** — \`specguard spec graph\` shows which spec owns a file.
   Read it, and update any requirement or scenario the change makes untrue.

2. **Add a requirement for new behaviour** — a new user-visible behaviour is a new
   requirement (a bullet under \`## Requirements\` with a \`<!-- claim: id -->\`). If no
   capability owns the file, add it to the right capability's \`sources\`.

3. **Check when done** — at the end of a task (not after every file), run:
   \`\`\`
   specguard check
   \`\`\`
   Fix what it reports (unowned files, untested or stale requirements, drift) before
   declaring the task complete.

## Keep it light

- You do NOT need to run the full pipelines on every edit.
- Tag a test that proves a requirement with \`// [claims: capabilities/<id>#<claim-id>]\`.
- Record why a requirement changed with \`specguard history add\`, or let the hooks do it.

## Granularity

Do not write one spec per file. Several files that deliver one piece of functionality
belong to one capability spec.
`;
}


/** Merge the specguard-mcp server into a Cursor mcp.json. */
export function mergeCursorMcpJson(existing: JsonObject, ctx: WireContext = defaultWire()): JsonObject {
  const next: JsonObject = { ...existing };
  const mcpServers = { ...(next.mcpServers as JsonObject | undefined) };
  wireMcp(mcpServers, '.cursor/mcp.json', ctx);
  next.mcpServers = mcpServers;
  return next;
}

// ---------------------------------------------------------------------------
// File writers
// ---------------------------------------------------------------------------

async function writeManaged(
  absPath: string,
  content: string,
  result: ScaffoldResult,
  cwd: string,
): Promise<void> {
  const rel = path.relative(cwd, absPath);
  if (await fileExists(absPath)) {
    const current = await readFile(absPath);
    if (!current.includes(MANAGED_MARKER)) {
      result.skipped.push(absPath);
      result.messages.push(`  skipped  ${rel} (user-authored, no managed marker)`);
      return;
    }
    await writeFile(absPath, content);
    result.updated.push(absPath);
    result.messages.push(`  updated  ${rel}`);
    return;
  }
  await writeFile(absPath, content);
  result.created.push(absPath);
  result.messages.push(`  created  ${rel}`);
}

/** Deep-merge a JSON config file, preserving unrelated keys. Never throws. */
async function mergeJsonFile(
  absPath: string,
  merge: (existing: JsonObject) => JsonObject,
  result: ScaffoldResult,
  cwd: string,
): Promise<void> {
  const rel = path.relative(cwd, absPath);
  let existing: JsonObject = {};
  const had = await fileExists(absPath);
  if (had) {
    try {
      existing = JSON.parse(await readFile(absPath)) as JsonObject;
    } catch {
      result.skipped.push(absPath);
      result.messages.push(`  skipped  ${rel} (malformed JSON — left unchanged)`);
      return;
    }
  }
  const merged = merge(existing);
  await writeFile(absPath, `${JSON.stringify(merged, null, 2)}\n`);
  if (had) {
    result.updated.push(absPath);
    result.messages.push(`  updated  ${rel}`);
  } else {
    result.created.push(absPath);
    result.messages.push(`  created  ${rel}`);
  }
}

async function writeClaudeMd(
  cwd: string,
  profile: LanguageProfile,
  result: ScaffoldResult,
): Promise<void> {
  const claudePath = path.join(cwd, 'CLAUDE.md');
  const had = await fileExists(claudePath);
  // applyTargetSections preserves surrounding content and only touches sentinels.
  applyTargetSections(claudePath, claudeMdSections(profile));
  const rel = path.relative(cwd, claudePath);
  if (had) {
    result.updated.push(claudePath);
    result.messages.push(`  updated  ${rel} (SpecGuard sections)`);
  } else {
    result.created.push(claudePath);
    result.messages.push(`  created  ${rel}`);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate harness files for the requested harness(es). Idempotent and
 * non-clobbering. Returns the created/updated/skipped paths and log messages.
 */
export async function scaffoldHarnessFiles(opts: ScaffoldOpts): Promise<ScaffoldResult> {
  const { cwd, profile } = opts;
  const harness: Harness = opts.harness ?? 'both';
  const result: ScaffoldResult = { created: [], updated: [], skipped: [], messages: [] };

  let runner: ResolvedRunner;
  try {
    runner = resolveRunner(cwd, { runner: opts.runner, runnerPath: opts.runnerPath });
  } catch (err) {
    result.messages.push(`  [warn] ${err instanceof Error ? err.message : String(err)}; using the npx fallback`);
    runner = NPX_RUNNER;
  }
  const wire: WireContext = { runner, update: opts.updateHooks === true, notes: [] };
  result.messages.push(`  runner   ${runner.comment}`);

  const wantClaude = harness === 'claude' || harness === 'both';
  const wantCursor = harness === 'cursor' || harness === 'both';

  // Shared, harness-agnostic.
  await writeManaged(path.join(cwd, 'AGENTS.md'), buildAgentsMd(profile), result, cwd);

  if (wantClaude) {
    await writeClaudeMd(cwd, profile, result);
    await writeManaged(
      path.join(cwd, '.claude', 'skills', 'specguard', 'SKILL.md'),
      buildSkill(profile),
      result,
      cwd,
    );
    await writeManaged(
      path.join(cwd, '.claude', 'commands', 'goal.md'),
      buildGoalCommand(profile),
      result,
      cwd,
    );
    await mergeJsonFile(
      path.join(cwd, '.claude', 'settings.json'),
      (existing) => mergeClaudeSettings(existing, wire),
      result,
      cwd,
    );
    if (opts.historyHooks) {
      // Personal settings: history capture is each person's choice, and the file is not committed by default.
      await mergeJsonFile(
        path.join(cwd, '.claude', 'settings.local.json'),
        (existing) => mergeHistoryHooks(existing, wire),
        result,
        cwd,
      );
    }
  }

  if (wantCursor) {
    await writeManaged(
      path.join(cwd, '.cursor', 'skills', 'specguard', 'SKILL.md'),
      buildSkill(profile),
      result,
      cwd,
    );
    await writeManaged(
      path.join(cwd, '.cursor', 'commands', 'goal.md'),
      buildGoalCommand(profile),
      result,
      cwd,
    );
    await mergeJsonFile(
      path.join(cwd, '.cursor', 'mcp.json'),
      (existing) => mergeCursorMcpJson(existing, wire),
      result,
      cwd,
    );
    await writeManaged(
      path.join(cwd, '.cursor', 'rules', 'specguard-sync.mdc'),
      buildSyncRule(),
      result,
      cwd,
    );
  }

  result.messages.push(...wire.notes);
  return result;
}
