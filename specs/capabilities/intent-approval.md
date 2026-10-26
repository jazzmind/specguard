---
id: intent-approval
kind: capability
title: Intent Approval
parent: system
value: A person, not a tool, signs off that each requirement states what the system should do, and the sign-off is a committed record that lapses the moment the requirement's wording changes.
status: active
sources:
  - "src/core/approvals.ts"
  - "src/pipelines/approve.ts"
docs: []
history:
  - 2026-10-26-intent-approvals-are-history-entries-bou
tests:
  - "tests/core/approvals.test.ts"
  - "tests/pipelines/approve.test.ts"
  - "tests/mcp/no-approve-tool.test.ts"
  - "tests/cli/approve.test.ts"
---

# Intent Approval

## Problem & Value
A coding agent can write a requirement, write the code for it and write a test that proves it, and every check passes while nobody ever decided the requirement was right. Proofs show that code matches a spec; they say nothing about whether a person agreed with the spec in the first place. When the same tool drafts both sides, the spec only restates what the code happens to do.

Intent approval adds the missing human step. A person approves a requirement at its exact wording, and the approval is stored in the repository next to the spec, so a reviewer can see who agreed to what and when. Editing a requirement's text makes it unapproved again, because the person approved those words and not the new ones. Approvals cannot be given through the agent tool surface, so an agent can propose intent but never certify it.

## Users & Journeys
- A tech lead reads the requirements of the cart capability, runs `specguard spec approve cart --yes --note "reviewed with product"`, and the capability's requirements become approved.
- A team adopting SpecGuard on an existing codebase runs `specguard spec approve --all --as-built --yes` to accept what the system already does, capability by capability, where the code exists.
- A developer edits one requirement and runs `specguard spec approvals`; that one requirement is listed as unapproved while its neighbours stay approved.
- A reviewer opens a pull request and sees a new file under `specs/history/` naming exactly which requirements were approved, by whom and by which method.
- A coding agent that tries to approve its own requirements is refused and told to hand the step to a person.

## Requirements
- [ ] An approval is recorded as one new history entry per approval event, with `kind: approval`, an `approves` list of `specKey#claimId@<first 16 hex of the claim hash>`, a `method` (command, as-built, pr or plan) and the approver as author, so approvals are committed files that branches never conflict on <!-- claim: approval-entry-record -->
- [ ] A claim counts as approved only while an approval's recorded hash equals the hash of the claim as it reads now, so editing a claim's text or its Problem & Value makes it unapproved, and when several approvals match the newest wins <!-- claim: approved-while-hash-matches -->
- [ ] Recording an approval adds the entry id to the `history:` list of each affected capability and changes no claim hash, so no existing proof goes stale <!-- claim: approval-backrefs-keep-hashes -->
- [ ] `spec approve` is a dry run unless `--yes` is given: it lists the claims it would approve and the number of capabilities, exits 0 and writes nothing <!-- claim: approve-dry-run -->
- [ ] `spec approve` takes capability ids, `capability#claim` refs or bare claim ids, and with `--all` every claim; an unknown or ambiguous target fails with exit 2 and writes nothing <!-- claim: approve-targets -->
- [ ] `--as-built` refuses, with exit 2 and nothing written, any capability in scope that owns no source files, so a new or work-in-progress capability cannot skip review <!-- claim: as-built-needs-sources -->
- [ ] `spec approve` run by a coding agent without an interactive terminal is refused with exit 1 and a message that approvals must be given by a person in their own terminal <!-- claim: agent-needs-terminal -->
- [ ] Approving only adds approval for claims that are not yet approved at their current wording: an approved claim is left alone, and a second identical run writes nothing <!-- claim: approved-untouched -->
- [ ] Approval is available only through the CLI: the MCP server offers no tool that approves, so an agent cannot certify intent <!-- claim: approve-cli-only -->
- [ ] `spec approvals` reports, per capability, how many claims are approved out of how many, and lists the unapproved claim refs; `--json` prints the same data as JSON <!-- claim: approvals-report -->

## Scenarios
### Scenario 1: Approve a capability
**Steps:**
1. A tech lead runs `specguard spec approve cart` and reads the list.
2. The tech lead reruns it with `--yes`.

**Expected Results:**
- The first run prints the claims and "would approve N claim(s)" and writes nothing.
- The second run writes one `kind: approval` entry under `specs/history/`.
- The cart spec's `history:` list gains the entry id and nothing else in the file changes.
- `specguard spec approvals` shows cart fully approved.

### Scenario 2: A requirement is reworded
**Steps:**
1. A capability is fully approved.
2. A developer changes the text of one requirement.
3. The developer runs `specguard spec approvals`.

**Expected Results:**
- The reworded requirement is listed as unapproved; the others remain approved.
- Running `spec approve --yes` for the capability approves only the reworded requirement.

### Scenario 3: Accepting an existing codebase
**Steps:**
1. A team has drafted specs for existing code and one capability for a feature not yet written.
2. A person runs `specguard spec approve --all --as-built --yes`.

**Expected Results:**
- The command refuses and names the capability that owns no source files; nothing is written.
- After the unbuilt capability is excluded by naming the others as targets, they are approved with method `as-built`.

### Scenario 4: An agent tries to approve
**Steps:**
1. A coding agent runs `specguard spec approve --all --yes` in a session with no interactive terminal.

**Expected Results:**
- The command exits 1 with a message that a person must approve in their own terminal.
- No history entry is written.

## Security & Data Considerations
Approvals are evidence that a person agreed, and anyone with write access to the repository can forge a file. The refusal for agents without a terminal is a speed bump, not a security control. The real enforcement belongs in CI, which should check that approvals added in a pull request are backed by a review from someone other than the author; that check is a later phase. The MCP server never exposes approval, and approval text is passed through the shared redactor like any history entry.

## Interfaces
- CLI: `specguard spec approve [targets...] [--all] [--as-built] [--by <name>] [--note <text>] [--yes]`, `specguard spec approvals [--json]`.
- Files: `specs/history/YYYY-MM-DD-approval-<tag>-<capabilities>.md` with frontmatter `kind: approval`, `approves`, `method`.
- Config: `proof.requireApproval` (boolean, default false) is reserved for `check` to require approval before a claim counts as proven.
- Exit codes: 0 success or dry run, 1 refused for an agent without a terminal or missing arguments, 2 unknown target or `--as-built` on a capability with no sources.

## Out of Scope
- Verifying in CI that the approver is not the author of the change.
- Approving through a pull request review or an approved plan (the `pr` and `plan` methods are recognised when read but not yet written).
- Making `check` require approval; `proof.requireApproval` is only a setting here.
