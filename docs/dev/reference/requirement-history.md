---
title: "Requirement History (developer reference)"
audience: dev
source: "specs/capabilities/requirement-history.md"
generated: true
---
<a id="requirement-history"></a>
# Requirement History

<a id="purpose"></a>
## Purpose

Specs say what a system must do, not why. The reasoning behind a requirement usually lives in chat transcripts, pull request threads and people's memories, and is gone by the time someone asks whether the requirement can be removed. Git records what changed in code, not the intent behind it. With AI-assisted development the key decisions are made in prompts and plans that are never committed.

Requirement History keeps a committed, readable record of the prompts, approved plans and explicit decisions that shaped each capability, and links each entry to the capabilities it affects. This gives:

- reviewers and auditors the intent behind a change;
- new contributors and coding agents context before they edit;
- `check` a way to flag capabilities whose code changed with no recorded reason.

<a id="responsibilities"></a>
## Responsibilities

- Store entries as markdown files in `specs/history/` and keep them out of the spec graph.
- Record entries from the CLI (`history add`) and the MCP server (`history_add`).
- Resolve which capabilities an entry affects: validated explicit ids, or a proposal from the fast model tier.
- Back-link each entry from the `history:` frontmatter list of the affected capability specs without disturbing the rest of the file.
- List entries (`history log`, `history_log`), optionally filtered by capability or emitted as JSON.
- Optionally install Claude Code hooks (`init --history-hooks`) that capture prompts into an uncommitted inbox and turn an approved plan into one committed entry.
- Redact secrets and personal data before anything is stored or committed.
- Report capabilities whose owned sources changed with neither a history entry nor a spec edit (advisory finding in `check`).

<a id="interfaces"></a>
## Interfaces

**CLI**

- `specguard history add [--prompt <text>|--plan <file>|--decision <text>] [--affects <ids>]`
- `specguard history log [--capability <id>] [--json]`
- `specguard history inbox` and `specguard history capture`: hook entry points. They read hook JSON on stdin and print nothing.
- `specguard init --history-hooks`
- `specguard check`: includes the history-gap finding.

**Files**

- `specs/history/YYYY-MM-DD-<slug>.md` (committed)
- `.specguard/history/inbox.jsonl` (uncommitted, gitignored)
- `history:` list in capability frontmatter

**Hooks** (opt-in, written to `.claude/settings.local.json`)

- `UserPromptSubmit`
- `PostToolUse` with matcher `ExitPlanMode`

**MCP**: `history_add`, `history_log`.

**Exit codes**: 0 success, 1 internal error, 2 validation failure (unknown capability id). Hook commands always exit 0.

<a id="requirements"></a>
## Requirements

- **history-entry-format**: A history entry is a markdown file at `specs/history/YYYY-MM-DD-<slug>.md`. Its frontmatter has `id` (equal to the file name without extension), `date`, `kind` (prompt, plan, decision or a combination such as prompt+plan), `author`, `source` and an `affects` list of capability ids or `system`. The verbatim text of the prompt, plan or decision follows.
- **history-not-specs**: History entries are not specs. The spec loader skips the history folder, entries never appear as nodes in the spec graph, and two entries created on the same day with the same slug get distinct ids.
- **history-add**: `history add` records a prompt (`--prompt`), an approved plan (`--plan <file>`) or a decision (`--decision`) as a new entry. The author comes from git config and the source from the caller (default `manual`). It refuses to add an entry with no content.
- **history-add-affects**: When `--affects <ids>` is given, `history add` validates each id against the spec graph and fails with exit 2 on an unknown capability id, writing nothing.
- **history-affects-proposal**: When `--affects` is omitted, `history add` asks the fast model tier to propose affected capabilities from the entry text (and the working-tree diff when present). It keeps only ids that exist in the spec graph and falls back to `system` when the model is disabled or proposes nothing.
- **history-backrefs**: `history add` appends the entry id to the `history:` list in the frontmatter of each affected capability spec. The rest of the spec stays byte-for-byte unchanged, and the id is added only once.
- **history-backrefs-not-stale**: Editing only the `history:` or `sources:` frontmatter of a spec never marks an existing proof stale, because proofs hash the claim text and normative sections and not back-references.
- **history-log**: `history log` prints entries newest first with date, kind, title and affected capabilities. `--capability <id>` restricts it to entries affecting that capability, and `--json` prints the same data as JSON.
- **history-hooks-opt-in**: `specguard init --history-hooks` is the only way hooks are installed. Without the flag no history hook is written. A repeated run changes nothing and preserves hooks the user already has. A differing SpecGuard hook is replaced only with `--update-hooks`.
- **history-inbox-capture**: A UserPromptSubmit hook runs `history inbox`. It reads the hook's JSON from stdin with a real JSON parser (so quotes and newlines survive), appends the redacted prompt keyed by `session_id` and `cwd` to an uncommitted inbox file, caps the inbox size, and never fails the user's prompt.
- **history-hooks-silent**: Every history hook prints nothing to stdout (stdout is injected into the model's context). It uses the resolved local SpecGuard binary rather than a cold package download, and ends in a way that swallows its own failures.
- **history-plan-capture**: A PostToolUse hook on ExitPlanMode runs `history capture`. It takes the approved plan from the tool input (falling back to the session transcript), pairs it with only the inbox prompts from the same `session_id`, and writes one committed prompt+plan entry. Prompts from sessions that never reach an approved plan are never committed.
- **history-redaction**: Prompt text is passed through the shared secret redactor both when it is written to the inbox and again when an entry is committed, so keys, tokens and personal data never reach `specs/history/`.
- **history-check-gap**: `check` reports each capability whose owned sources changed since its last history entry or spec edit without either, as an advisory finding that does not by itself fail the build unless the project opts in.
- **history-mcp-tool**: The MCP server exposes `history_add` and `history_log` with the same behaviour as the CLI command so agents can record decisions directly.
- **hook-input-bounded**: The history hooks read their JSON from stdin up to 4 MB and drop larger input whole. A single prompt is cut to 50,000 characters before it is redacted and stored. The uncommitted inbox is kept to the newest 300 prompts once it passes 1 MB, and is readable by its owner only.

<a id="code-map"></a>
## Code map

Sources owned by this capability (110 owned files in total):

| Path | Notes |
| --- | --- |
| `src/core/history.ts` | core history logic |
| `src/core/redact.ts` | shared secret redactor |
| `src/core/intent-gap.ts` | listed as a source; see `history-check-gap` |
| `src/pipelines/history.ts` | history pipeline |
| `src/cli/commands/history.ts` | CLI command |
| `specs/history/**` | committed entries |

<a id="tests"></a>
## Tests

- `tests/core/history.test.ts`
- `tests/pipelines/history.test.ts`

The spec's scenarios describe the behaviour the tests should cover:

- **Worked example:** the entry `2026-10-15-functional-specs-and-four-pillars.md` has `kind: prompt+plan`, `source: claude-code` and `affects: system`. Its body holds the original prompt verbatim, any follow-up decisions and the approved plan.
- **Hand-recorded decision:** a new `decision` entry appears, the spec's `history:` list gains the id and nothing else changes, no proof goes stale, and the log shows the entry first.
- **Proposed affects:** real ids are kept and made-up ids are discarded. With the LLM disabled the entry is recorded against `system`.
- **Concurrent sessions:** both sessions' prompts reach the inbox, redacted and tagged by `session_id`. Exactly one entry is committed, containing session A's plan and only A's prompts. Hooks print nothing in either session.
- **Secret in a prompt:** the key is replaced by a placeholder in the inbox line and the committed entry, and appears nowhere under `specs/history/`.
- **Change with no recorded reason:** `check` lists the capability, and adding a history entry or editing the spec clears the finding.

<a id="security-and-data"></a>
## Security and data

- Prompts routinely contain secrets, customer data and internal URLs. The shared redactor runs twice: at inbox write and at commit time.
- The inbox lives under `.specguard/history/`, is gitignored, and is readable only by its owner. Only a captured, redacted entry is ever committed.
- Hooks read untrusted JSON from stdin. They must parse it and never interpolate it into a shell command.
- Hook input is bounded (see **hook-input-bounded**).
- Entries are append-only records. A leaked value that slips past redaction must be removed by editing the committed file and rotating the secret.
- Hooks are opt-in, so a repo never records prompts without a deliberate choice.

<a id="extending-it"></a>
## Extending it

The spec does not describe extension points beyond the following constraints:

- **Scope.** Only prompts, approved plans and explicit decisions are kept. Full chat transcripts and tool output are out of scope, as is replacing git history, issue trackers or PR discussions.
- **Other tools.** The first version supports only Claude Code hooks. The entry's `source` field records the caller (default `manual`). Support for other tools is out of scope for now.
- **New or changed hooks.** They must keep the existing guarantees: parse stdin as JSON, stay within the input bounds, redact before storing, print nothing to stdout, use the resolved local binary, and always exit 0.
- **Automatic rewriting.** Rewriting or deleting past entries automatically is out of scope.
- **New entry-writing paths.** They should keep entries out of the spec graph, produce distinct ids for same-day same-slug entries, and leave specs byte-for-byte unchanged apart from the `history:` list.
