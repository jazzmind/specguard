---
title: "Requirement History"
audience: user
source: "specs/capabilities/requirement-history.md"
generated: true
---
<a id="requirement-history"></a>
# Requirement History

Requirement History keeps a readable, committed record of the prompts, approved plans and decisions that shaped each capability. When someone later asks "why does this requirement exist?" or "can we remove it?", the answer is stored next to the specs instead of being lost with a chat session.

<a id="why-it-exists"></a>
## Why it exists

Specs say what a system must do, but not why. The reasoning usually lives in chat transcripts, pull request threads and people's memories, and it is often gone by the time someone needs it. Git history shows what changed in the code, not the intent behind it. With AI-assisted development this gets worse, because the key decisions are made in prompts and plans that are never committed.

Requirement History helps several kinds of reader:

- **Reviewers and auditors** see the intent behind a change.
- **New contributors and coding agents** get context before they edit, so they don't undo a deliberate decision.
- **Security reviewers** can confirm a requirement was a conscious decision and not an accident.
- **Tech leads** can see which capabilities changed with no recorded reason.

<a id="what-you-can-do"></a>
## What you can do

<a id="record-a-decision-prompt-or-plan-by-hand"></a>
### Record a decision, prompt or plan by hand

Use `specguard history add` with one of:

- `--prompt <text>` for a prompt,
- `--plan <file>` for an approved plan,
- `--decision <text>` for an explicit decision.

Example:

```
specguard history add --decision "Docs responses are not streamed" --affects documentation-api
```

This creates a dated entry under `specs/history/`. The author comes from your git configuration, and the source defaults to `manual`. An entry with no content is refused.

**Choosing affected capabilities.** With `--affects`, each id you give is checked against your specs. If an id is unknown, the command fails with exit code 2 and writes nothing. If you leave `--affects` out, the fast model tier proposes affected capabilities from the entry text, plus your working-tree changes when there are any. Only ids that really exist are kept. If the model is disabled or proposes nothing, the entry is recorded against `system`.

Each affected capability's spec gets the entry id added to its `history:` list. The rest of the spec is left exactly as it was, and an id is never added twice.

<a id="read-the-timeline"></a>
### Read the timeline

```
specguard history log
specguard history log --capability security-and-remediation
specguard history log --json
```

Entries are shown newest first, with date, kind, title and affected capabilities. `--capability <id>` limits the list to one capability. `--json` prints the same information as JSON.

<a id="capture-claude-code-sessions-automatically"></a>
### Capture Claude Code sessions automatically

Run `specguard init --history-hooks` to opt in. From then on:

- Each prompt you submit in a Claude Code session is saved, with secrets redacted, to a private local inbox that is not committed.
- When you approve a plan, one committed entry is written. It contains the approved plan and only the prompts from that same session.
- Prompts from sessions that never reach an approved plan are never committed.

This is the only way hooks get installed. Without the flag, nothing is recorded. Running it again changes nothing and keeps any hooks you already have. A differing SpecGuard hook is replaced only if you add `--update-hooks`. The hooks are written to `.claude/settings.local.json`.

<a id="find-changes-with-no-recorded-reason"></a>
### Find changes with no recorded reason

`specguard check` lists capabilities whose owned sources changed since their last history entry or spec edit, with neither one recorded. This is advisory and does not fail the build unless your project opts in. Adding a history entry or editing the spec clears the finding.

<a id="use-it-from-agents"></a>
### Use it from agents

The MCP server offers `history_add` and `history_log`, which behave like the CLI commands, so agents can record decisions and read the timeline directly.

<a id="what-to-expect"></a>
## What to expect

**What an entry looks like.** Each entry is a markdown file named `specs/history/YYYY-MM-DD-<slug>.md`. Its header records:

- the id (matching the file name),
- the date,
- the kind (prompt, plan, decision, or a combination such as prompt+plan),
- the author,
- the source (for example `manual` or `claude-code`),
- the list of affected capabilities, or `system`.

Below the header is the verbatim text of the prompt, plan or decision. Two entries created on the same day with the same slug get distinct ids.

**Entries are not specs.** They never appear as nodes in the spec graph, and the spec loader skips the history folder.

**Proofs stay valid.** Adding a `history:` reference, or editing only the `history:` or `sources:` header of a spec, does not make any existing proof stale.

**Secrets are redacted.** Prompt text goes through the redactor twice, when it is saved to the inbox and again when an entry is committed. Keys, tokens and personal data should never reach `specs/history/`. Entries are append-only records, so if a secret ever slips through, you need to edit the committed file and rotate the secret.

**Hooks stay out of the way.**
- They print nothing into the model's context.
- They never fail your prompt, and always exit 0.
- Input is limited: hook input over 4 MB is dropped whole, and a single prompt is cut to 50,000 characters before redaction.
- The local inbox keeps only the newest 300 prompts once it passes 1 MB, and is readable only by its owner.

**Exit codes.** 0 means success, 1 an internal error, and 2 a validation failure such as an unknown capability id.

**Limits.**
- Only prompts, approved plans and explicit decisions are kept, not full chat transcripts or tool output.
- Only Claude Code hooks are supported at first.
- Past entries are never rewritten or deleted automatically.
- It does not replace git history, issue trackers or pull request discussions.
