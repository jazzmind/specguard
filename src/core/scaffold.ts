/**
 * Harness scaffold — generates the agent-harness files that let an AI coding
 * agent run SpecGuard alongside a build.
 *
 * Spec: specs/core/scaffold.md
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

export type Harness = 'claude' | 'cursor' | 'both';

export interface ScaffoldOpts {
  cwd: string;
  profile: LanguageProfile;
  harness?: Harness;
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
    '| `specguard analyze` | Smart diagnostics — start here when unsure |',
    '| `specguard gap-analysis` | Find unimplemented specs and generate build plans |',
    '| `specguard status` | Spec + test coverage report |',
    '| `specguard reverse --all` | Generate Living Specs from source |',
    '| `specguard generate --all` | Generate test files from specs |',
    '| `specguard heal --all` | Run tests and auto-fix test bugs |',
    '| `specguard drift` | Detect specs out of sync with code |',
    '| `specguard security --all` | OWASP security test stubs |',
    `| (tests run via) | \`${p.testCommand}\` |`,
  ].join('\n');

/** AGENTS.md — harness-agnostic agent guide. */
export function buildAgentsMd(profile: LanguageProfile): string {
  return `# AGENTS.md

${MANAGED_MARKER}

## SpecGuard Enforced (${profile.id})

This repository uses **SpecGuard** for spec-driven QA. Specs in \`specs/\` are the
source of truth. As an AI agent you **must** keep specs and code in sync.

### Workflow

1. **Read the spec** for a module before implementing it.
2. **Edit** — make your code changes (target language: ${profile.id}).
3. **Check coverage** — \`specguard gap-analysis\` then \`specguard status\`.
4. **Validate** — run tests: \`${profile.testCommand}\`; \`specguard heal --all\` to auto-fix test bugs.
5. **Report** — include the pipeline summary in your response.

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
(\`specguard_*\`) when available; otherwise use \`npx specguard <command>\`.

## When to Run

- After implementing or changing a module (check coverage + drift).
- When the user asks for spec coverage, test generation, or validation.
- Security-sensitive files changed (\`**/auth/**\`, \`**/api/**\`).

## Quick Reference

${COMMAND_TABLE(profile)}

## Build-from-specs Loop

1. \`specguard gap-analysis\` → plans for every unimplemented spec (\`.specguard/plans/*\`).
2. Implement one module against its spec + plan.
3. \`specguard status\` → confirm the spec flips to covered.
4. \`specguard generate --spec <key>\` then \`specguard heal --all\`.
5. Repeat until \`status\` reports full coverage.

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

1. Run \`specguard gap-analysis\` (or the \`specguard_gap_analysis\` MCP tool). Read
   every plan it writes under \`.specguard/plans/*.md\`.
2. Read \`specs/**\` — the specs are the source of truth. Read a module's spec
   before implementing it.
3. Build an ordered module list from the plans' suggested files / steps.
4. For each module, in dependency order:
   - Implement the code (language: ${profile.id}).
   - Run \`specguard gap-analysis\` and confirm the spec is no longer "unimplemented".
   - Generate tests: \`specguard generate --spec <key>\`, then \`specguard heal --all\`
     (tests run via \`${profile.testCommand}\`).
5. Stop when \`specguard status\` reports the target coverage and all plans are
   implemented.

## Rules

- NEVER edit a spec to make a gap disappear — implement the code.
- A \`heal\` \`app-bug\` is a real defect: fix the code, do not weaken the test.
- Keep going module-by-module; report progress after each.
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
        'Specs in `specs/` are the source of truth — read a module\'s spec before editing it.',
        '',
        'After changing code, run `specguard gap-analysis`, `specguard status`, and',
        `\`specguard drift\`. Tests run with \`${profile.testCommand}\`. Run \`/goal\` to build`,
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

/** The specguard-mcp server entry (shared by Claude + Cursor configs). */
function mcpServerEntry(): JsonObject {
  return { command: 'npx', args: ['specguard-mcp'] };
}

/** Merge the specguard-mcp server + run-alongside hook into Claude settings. */
export function mergeClaudeSettings(existing: JsonObject): JsonObject {
  const next: JsonObject = { ...existing };

  const mcpServers = { ...(next.mcpServers as JsonObject | undefined) };
  if (!mcpServers['specguard-mcp']) mcpServers['specguard-mcp'] = mcpServerEntry();
  next.mcpServers = mcpServers;

  // PostToolUse hook: read-only `specguard status` after edits. The script
  // itself (scaffolded separately as a guard) skips spec/test/.specguard paths.
  const hooks = { ...(next.hooks as JsonObject | undefined) };
  const postToolUse = Array.isArray(hooks.PostToolUse) ? [...(hooks.PostToolUse as unknown[])] : [];
  const alreadyWired = postToolUse.some(
    (h) => typeof h === 'object' && h !== null && JSON.stringify(h).includes('specguard status'),
  );
  if (!alreadyWired) {
    postToolUse.push({
      matcher: 'Edit|Write|MultiEdit',
      hooks: [
        {
          type: 'command',
          command:
            'f="$(cat | sed -n \'s/.*"file_path"[: ]*"\\([^"]*\\)".*/\\1/p\')"; ' +
            'case "$f" in *"/specs/"*|*"/tests/"*|*"/.specguard/"*) exit 0;; esac; ' +
            'npx specguard status 2>/dev/null | tail -3 || true',
        },
      ],
    });
  }
  hooks.PostToolUse = postToolUse;
  next.hooks = hooks;

  return next;
}

/** Merge the specguard-mcp server into a Cursor mcp.json. */
export function mergeCursorMcpJson(existing: JsonObject): JsonObject {
  const next: JsonObject = { ...existing };
  const mcpServers = { ...(next.mcpServers as JsonObject | undefined) };
  if (!mcpServers['specguard-mcp']) mcpServers['specguard-mcp'] = mcpServerEntry();
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
      mergeClaudeSettings,
      result,
      cwd,
    );
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
      mergeCursorMcpJson,
      result,
      cwd,
    );
  }

  return result;
}
