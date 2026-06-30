# Harness Scaffold

<!--
  module: src/core/scaffold.ts
  type: core
  status: draft
-->

## Overview

Generates the agent-harness files that let an AI coding agent run SpecGuard alongside a build: a root `CLAUDE.md`, per-harness skill files, MCP wiring, a `/goal` build command, and a shared `AGENTS.md`. All generators are language-aware (parameterized by a `LanguageProfile`) and harness-aware (Claude Code, Cursor, or both).

`scaffoldHarnessFiles({ cwd, profile, harness })` is called by the `init` pipeline (greenfield) and by the `specguard_scaffold` MCP tool (refresh an already-initialized repo). It is idempotent and never clobbers hand-authored content: managed Markdown files carry a `<!-- specguard-managed: true -->` marker and are only overwritten when that marker is present (or when the file is absent); `CLAUDE.md` is updated through sentinel sections (preserving surrounding prose); JSON config files (`.claude/settings.json`, `.cursor/mcp.json`) are deep-merged so user keys survive.

## Acceptance Criteria

- [ ] `scaffoldHarnessFiles({ cwd, profile, harness })` returns `{ created, updated, skipped, messages }` with absolute file paths
- [ ] `harness: 'claude'` writes root `CLAUDE.md`, `.claude/skills/specguard/SKILL.md`, `.claude/settings.json`, `.claude/commands/goal.md`, and `AGENTS.md`
- [ ] `harness: 'cursor'` writes `.cursor/skills/specguard/SKILL.md`, `.cursor/mcp.json`, `.cursor/commands/goal.md`, and `AGENTS.md`
- [ ] `harness: 'both'` (default) writes the union of the Claude and Cursor file sets
- [ ] Generated skill, goal, and AGENTS files embed `<!-- specguard-managed: true -->` and reference language-specific commands from the profile (e.g. `pytest` vs `npm test`)
- [ ] A managed file that already exists and still carries the marker is overwritten and counted as `updated`; one lacking the marker is left untouched and counted as `skipped`
- [ ] `CLAUDE.md` is created with SpecGuard sentinel sections when missing; when present, only the sentinel sections are updated (surrounding content preserved)
- [ ] `.claude/settings.json` gains an MCP server entry (`specguard-mcp`) and a `PostToolUse` hook without removing or overwriting unrelated existing keys
- [ ] `.cursor/mcp.json` gains a `specguard-mcp` server entry without dropping existing servers
- [ ] Malformed existing JSON in a config file is reported in `messages` and the file is left unchanged (no throw)
- [ ] All file writes go through `core/writer.ts` / `core/reader.ts`; no direct `fs` writes leak the abstraction

## Scenarios

### Scenario 1: Greenfield Claude scaffold

**Steps:**
1. Empty temp dir, Python profile, `harness: 'claude'`.
2. Call `scaffoldHarnessFiles`.

**Expected Results:**
- `CLAUDE.md`, `.claude/skills/specguard/SKILL.md`, `.claude/settings.json`, `.claude/commands/goal.md`, `AGENTS.md` are created.
- The skill body references `pytest`.
- `.claude/settings.json` contains a `specguard-mcp` MCP entry and a `PostToolUse` hook.

### Scenario 2: Re-run is idempotent and preserves user content

**Steps:**
1. Run scaffold once, then hand-edit `.claude/settings.json` to add an unrelated key and append prose below the CLAUDE.md sentinels.
2. Run scaffold again.

**Expected Results:**
- The unrelated settings key and the appended prose are still present.
- Managed sections are refreshed; nothing is duplicated.

### Scenario 3: Do not clobber a user-authored AGENTS.md

**Steps:**
1. Write an `AGENTS.md` WITHOUT the managed marker.
2. Run scaffold.

**Expected Results:**
- The file is left unchanged and reported as `skipped`.

## Security Notes

- Generated `.env`/secrets are never written here; only documentation, skill, and config wiring.
- JSON merges must not remove existing MCP servers, hooks, or permissions a user configured.

## Dependencies

- `src/core/language-profiles.ts` (`LanguageProfile`)
- `src/core/sentinels.ts` (`applyTargetSections`)
- `src/core/reader.ts`, `src/core/writer.ts`
- Consumed by: `src/pipelines/init.ts`, `src/mcp/server.ts`
