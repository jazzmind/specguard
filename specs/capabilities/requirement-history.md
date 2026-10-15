---
id: requirement-history
kind: capability
title: Requirement History
parent: system
value: Anyone can see which prompts, approved plans and decisions shaped each capability, so the reason behind a requirement survives the chat session that produced it.
status: active
sources:
  - "src/core/redact.ts"
  - "specs/history/**"
  - "src/core/history.ts"
  - "src/core/intent-gap.ts"
  - "src/pipelines/history.ts"
  - "src/cli/commands/history.ts"
docs:
  - "README.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
tests:
  - "tests/core/history.test.ts"
  - "tests/pipelines/history.test.ts"
---

# Requirement History

## Problem & Value
Specs say what a system must do, but not why it says that. The reasoning lives in chat transcripts, pull request threads and people's memories, and it is gone by the time someone asks why a requirement exists or whether it may be removed. Git history records what changed in code, not the intent that drove the change, and AI-assisted development makes this worse because the most important decisions are made in prompts and plans that are never committed.

Requirement History keeps a committed, readable record of the prompts, approved plans and explicit decisions that shaped each capability, and links each entry to the capabilities it affects. Reviewers and auditors get the intent behind a change; new contributors and coding agents get context before they edit; and `check` can point at capabilities whose code changed with no recorded reason.

This capability is planned and not yet built. The folder `specs/history/` and the `history:` frontmatter list already exist and are tolerated by the spec loader and proof hashing; the commands, hooks and reporting below are the work still to do.

## Users & Journeys
- A developer finishes a design discussion and runs `specguard history add --decision "Use per-request budgets in the docs server" --affects documentation-api` so the reasoning is committed with the code.
- A developer opts a repo in with `specguard init --history-hooks`, and from then on every approved plan from a Claude Code session is saved as a history entry along with the prompts that led to it.
- A reviewer runs `specguard history log --capability security-and-remediation` to read the timeline of why that capability is the way it is.
- A tech lead runs `specguard check` and sees a list of capabilities whose sources changed with neither a history entry nor a spec edit.
- A coding agent reads the history entries linked from a capability spec before changing it, so it does not undo a deliberate decision.
- A security reviewer reads a history entry to confirm a requirement was a deliberate decision and not an accident.

## Requirements
- [ ] A history entry is a markdown file at `specs/history/YYYY-MM-DD-<slug>.md` whose frontmatter has id (equal to the file name without extension), date, kind (prompt, plan, decision or a combination such as prompt+plan), author, source and an `affects` list of capability ids or `system`, followed by the verbatim text of the prompt, plan or decision <!-- claim: history-entry-format -->
- [ ] History entries are not specs: the spec loader skips the history folder, entries never appear as nodes in the spec graph, and two entries created on the same day with the same slug get distinct ids <!-- claim: history-not-specs -->
- [ ] `history add` records a prompt (`--prompt`), an approved plan (`--plan <file>`) or a decision (`--decision`) as a new entry, taking the author from git config and the source from the caller (default `manual`), and refuses to add an entry with no content <!-- claim: history-add -->
- [ ] when `--affects <ids>` is given, `history add` validates each id against the spec graph and fails with exit 2 on an unknown capability id, writing nothing <!-- claim: history-add-affects -->
- [ ] when `--affects` is omitted, `history add` asks the fast model tier to propose affected capabilities from the entry text (and the working-tree diff when present), keeps only ids that exist in the spec graph, and falls back to `system` when the model is disabled or proposes nothing <!-- claim: history-affects-proposal -->
- [ ] `history add` appends the entry id to the `history:` list in the frontmatter of each affected capability spec, leaving the rest of the spec byte-for-byte unchanged and adding the id only once <!-- claim: history-backrefs -->
- [ ] Editing only the `history:` or `sources:` frontmatter of a spec never marks an existing proof stale, because proofs hash the claim text and normative sections and not back-references <!-- claim: history-backrefs-not-stale -->
- [ ] `history log` prints entries newest first with date, kind, title and affected capabilities; `--capability <id>` restricts it to entries affecting that capability, and `--json` prints the same data as JSON <!-- claim: history-log -->
- [ ] `specguard init --history-hooks` is the only way hooks are installed; without the flag no history hook is written, and a repeated run changes nothing, preserves hooks the user already has, and replaces a differing SpecGuard hook only with `--update-hooks` <!-- claim: history-hooks-opt-in -->
- [ ] a UserPromptSubmit hook runs `history inbox`, which reads the hook's JSON from stdin with a real JSON parser (so quotes and newlines survive), appends the redacted prompt keyed by `session_id` and `cwd` to an uncommitted inbox file, caps the inbox size, and never fails the user's prompt <!-- claim: history-inbox-capture -->
- [ ] every history hook prints nothing to stdout (stdout is injected into the model's context), uses the resolved local SpecGuard binary rather than a cold package download, and ends in a way that swallows its own failures <!-- claim: history-hooks-silent -->
- [ ] a PostToolUse hook on ExitPlanMode runs `history capture`, which takes the approved plan from the tool input (falling back to the session transcript), pairs it with only the inbox prompts from the same `session_id`, and writes one committed prompt+plan entry; prompts from sessions that never reach an approved plan are never committed <!-- claim: history-plan-capture -->
- [ ] prompt text is passed through the shared secret redactor both when it is written to the inbox and again when an entry is committed, so keys, tokens and personal data never reach `specs/history/` <!-- claim: history-redaction -->
- [ ] `check` reports each capability whose owned sources changed since its last history entry or spec edit without either, as an advisory finding that does not by itself fail the build unless the project opts in <!-- claim: history-check-gap -->
- [ ] Planned: the MCP server exposes `history_add` with the same behaviour as the CLI command so agents can record decisions directly <!-- claim: history-mcp-tool -->

## Scenarios
### Scenario 1: The worked example in this repository
**Steps:**
1. A developer asks Claude Code to redesign SpecGuard around functional specs and four pillars, then approves the resulting plan on 2026-10-15.
2. The history hooks capture the session and write `specs/history/2026-10-15-functional-specs-and-four-pillars.md`.
3. The entry's `affects` list contains `system`, and later capability specs list the entry id in their `history:` frontmatter.

**Expected Results:**
- The entry has frontmatter `id`, `date: 2026-10-15`, `kind: prompt+plan`, `author`, `source: claude-code` and `affects`.
- The body contains the original prompt verbatim, any follow-up decisions and the approved plan.
- `history log --capability spec-authoring` lists the entry once the capability links to it.

### Scenario 2: Record a decision by hand
**Steps:**
1. A developer runs `specguard history add --decision "Docs responses are not streamed" --affects documentation-api`.
2. The developer runs `specguard history log --capability documentation-api`.

**Expected Results:**
- A new dated entry exists under `specs/history/` with kind `decision`.
- The documentation-api spec's `history:` list gains the entry id and nothing else in the file changes.
- No proof for that capability becomes stale.
- The log shows the new entry first.

### Scenario 3: Affected capabilities are proposed
**Steps:**
1. A developer runs `specguard history add --prompt "Add per-request LLM budgets"` without `--affects`.
2. The fast model proposes `documentation-api`, `platform-foundation` and a made-up id.

**Expected Results:**
- The two real ids are used; the made-up id is discarded.
- Both capabilities gain the back-reference.
- With the LLM disabled the entry is recorded against `system`.

### Scenario 4: Hook capture across concurrent sessions
**Steps:**
1. A repo has history hooks installed; two Claude Code sessions A and B are open.
2. Each session submits prompts; session A approves a plan, session B does not.

**Expected Results:**
- Both sessions' prompts land in the uncommitted inbox, redacted, tagged with their `session_id`.
- Exactly one entry is committed, containing session A's plan and only session A's prompts.
- Session B's prompts are not committed.
- The hooks printed nothing to stdout in either session.

### Scenario 5: A secret in a prompt
**Steps:**
1. A developer pastes an API key into a prompt, then approves the plan.

**Expected Results:**
- The inbox line and the committed entry both show a placeholder instead of the key.
- The key appears nowhere under `specs/history/`.

### Scenario 6: A change with no recorded reason
**Steps:**
1. A developer edits files owned by a capability and commits without touching its spec or adding a history entry.
2. The developer runs `specguard check`.

**Expected Results:**
- The capability is listed as changed without a history entry or spec edit.
- Adding a history entry or editing the spec clears the finding.

## Security & Data Considerations
Prompts routinely contain secrets, customer data and internal URLs. Redaction (the shared redactor) is applied twice: at inbox write and at commit time. The inbox lives under `.specguard/history/` and is gitignored; only a captured, redacted entry is ever committed. Hooks read untrusted JSON from stdin and must parse it, never interpolate it into a shell command. Entries are append-only records, so a leaked value that slips past redaction must be removed by editing the committed file and rotating the secret. Hooks are opt-in so a repo never records prompts without a deliberate choice.

## Interfaces
- CLI (planned): `specguard history add [--prompt <text>|--plan <file>|--decision <text>] [--affects <ids>]`, `specguard history log [--capability <id>] [--json]`, `specguard history inbox` and `specguard history capture` (read hook JSON on stdin, print nothing), `specguard init --history-hooks`, `specguard check` (history-gap finding).
- Files: `specs/history/YYYY-MM-DD-<slug>.md` (committed), `.specguard/history/inbox.jsonl` (uncommitted), `history:` list in capability frontmatter.
- Hooks (planned): `UserPromptSubmit` and `PostToolUse` with matcher `ExitPlanMode`, written to `.claude/settings.json`.
- MCP (planned): `history_add`.
- Exit codes: 0 success, 1 internal error, 2 validation failure (unknown capability id). Hook commands always exit 0.

## Out of Scope
- Capturing full chat transcripts or tool output; only prompts, approved plans and explicit decisions are kept.
- Replacing git history, issue trackers or pull request discussions.
- Supporting coding tools other than Claude Code hooks in the first version.
- Rewriting or deleting past entries automatically.
