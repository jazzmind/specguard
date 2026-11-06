---
title: "Intent Approval (developer reference)"
audience: dev
source: "specs/capabilities/intent-approval.md"
generated: true
---
<a id="intent-approval"></a>
# Intent Approval

<a id="purpose"></a>
## Purpose

Intent approval records that a person, not a tool, agreed that each requirement states what the system should do. Proofs show that code matches a spec, but they do not show that anyone agreed with the spec. When a coding agent drafts the requirement, the code and the test, every check can pass without a human ever deciding the requirement was right.

An approval is a committed history entry stored next to the spec, so a reviewer can see who approved what, when, and by which method. It is tied to the exact wording of a requirement. Editing the text makes the requirement unapproved again. Approvals cannot be given through the agent tool surface, so an agent can propose intent but never certify it.

<a id="responsibilities"></a>
## Responsibilities

- Record each approval event as one new `kind: approval` history entry.
- Decide whether a claim (or example row) counts as approved by comparing the recorded hash with the hash of the current wording.
- Provide `spec approve`, including a dry-run default, target resolution, `--as-built` and `--from-pr`, with guards against agent use.
- Provide `spec approvals` to report approved and unapproved claims.
- Refuse to record approvals through any other route (`history add`, the MCP server).
- In CI, decide which recorded approvals the statement may count and with what label (`inherited`, `countersigned`, `recorded`, `missing`, `self-approved`, or a verified `pr` approval), based on qualifying pull request reviews.

<a id="interfaces"></a>
## Interfaces

**CLI**

```
specguard spec approve [targets...] [--all] [--as-built] [--by <name>] [--note <text>] [--yes]
specguard spec approve --from-pr <n> [targets...] [--yes]
specguard spec approvals [--json]
```

`--from-pr` is defined by the `approve-from-pr*` requirements. It does not appear in the spec's Interfaces signature line.

Targets are capability ids, `capability#claim` refs, or bare claim ids. `--all` covers every claim.

**Files**

`specs/history/YYYY-MM-DD-approval-<tag>-<capabilities>.md` with frontmatter:

- `kind: approval`
- `approves`: a list of `specKey#claimId@<first 16 hex of claim hash>`, or `specKey#claimId/rowId@<first 16 hex of row hash>` for example rows
- `method`: `command`, `as-built`, `pr` or `plan`
- the approver as author

**Config**

- `proof.requireApproval` (boolean, default false) is reserved for `check` to require approval before a claim counts as proven. It is only a setting here and has no effect yet.
- `approvals.ci.requireReview` (`enforce`, `always` or `never`) and `approvals.ci.allowSelf` control the CI rules below.

**Index API**

- `latest(ref)` returns the newest approval of a ref at any hash.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Success or dry run |
| 1 | Refused for an agent without a terminal, missing arguments, or (`--from-pr`) a pull request that cannot be read |
| 2 | Unknown or ambiguous target, `--as-built` on a capability with no sources, or `--from-pr` with no qualifying review |

<a id="requirements"></a>
## Requirements

**Recording and state**

- **approval-entry-record**: An approval is recorded as one new history entry per approval event, with `kind: approval`, an `approves` list of `specKey#claimId@<first 16 hex of the claim hash>`, a `method` (command, as-built, pr or plan) and the approver as author, so approvals are committed files that branches never conflict on.
- **approved-while-hash-matches**: A claim counts as approved only while an approval's recorded hash equals the hash of the claim as it reads now, so editing a claim's text or its Problem & Value makes it unapproved. When several approvals match, the newest wins.
- **approval-backrefs-keep-hashes**: Recording an approval adds the entry id to the `history:` list of each affected capability and changes no claim hash, so no existing proof goes stale.
- **approved-untouched**: Approving only adds approval for claims that are not yet approved at their current wording. An approved claim is left alone, and a second identical run writes nothing.
- **approval-rows**: An approval may name an example row (`specKey#claimId/rowId@<first 16 hex of the row hash>`). A claim and each of its rows are approved separately, so approving a claim never approves its rows and the other way round. `spec approve cap#claim` approves the claim and all its current rows in one entry, `cap#claim/row` approves only that row, and a claim without an examples table has no row entries.
- **approval-latest**: The approval index offers `latest(ref)`, the newest approval of a ref at any hash, so a claim approved earlier and changed since can be told apart from one never approved.

**`spec approve` behaviour**

- **approve-dry-run**: `spec approve` is a dry run unless `--yes` is given. It lists the claims it would approve and the number of capabilities, exits 0 and writes nothing.
- **approve-targets**: `spec approve` takes capability ids, `capability#claim` refs or bare claim ids, and with `--all` every claim. An unknown or ambiguous target fails with exit 2 and writes nothing.
- **as-built-needs-sources**: `--as-built` refuses, with exit 2 and nothing written, any capability in scope that owns no source files, so a new or work-in-progress capability cannot skip review.
- **agent-needs-terminal**: `spec approve` run by a coding agent without an interactive terminal is refused with exit 1 and a message that approvals must be given by a person in their own terminal.
- **approvals-report**: `spec approvals` reports, per capability, how many claims are approved out of how many, and lists the unapproved claim refs. `--json` prints the same data as JSON.

**Closed doors**

- **approve-cli-only**: Approval is available only through the CLI. The MCP server offers no tool that approves, so an agent cannot certify intent.
- **no-approval-via-history-add**: `history add` never writes an approval. It refuses `--kind approval` and any approves list with a message pointing to `spec approve`, so the only way to record an approval is the person-run command and its guards.

**CI review rules**

- **ci-review-qualifies**: In CI an approving review counts only when it is the latest decisive review of a human other than the pull request's author, its state is APPROVED, its author association is owner, member or collaborator, and it is not a bot (by type or a `[bot]` login suffix). Logins compare case-insensitively.
- **ci-review-latest-per-user**: A reviewer's latest decisive review wins. A later change request cancels an earlier approval, and a later approval restores a change request. A later plain comment or pending review never withdraws an approval. The result does not depend on input order.
- **ci-review-covers-by-hash**: A review covers a claim, or example row, only when its hash at the reviewed commit equals its hash at head. A review on an older commit still covers a claim that did not change since, and stops covering one edited after it. A claim absent at the reviewed commit is not covered.
- **ci-inherited-approvals**: A recorded approval entry already on the base branch is inherited: it counts in CI, is labelled `inherited`, and needs no review.
- **ci-countersigned-approvals**: A recorded approval entry added in the pull request (method command, plan or as-built) is countersigned, and counts, when a qualifying review covers its claim. The packet label names the reviewer and the proof note records a countersign row.
- **ci-review-required-by-policy**: An approval added in the pull request needs a covering review only where `approvals.ci.requireReview` says so (`enforce`: capabilities at enforce; `always`; `never`). Below that it counts labelled `recorded`. Where a review is required and missing it does not count and is labelled `missing`.
- **ci-self-approved-opt-in**: With `approvals.ci.allowSelf` an approval added in the pull request without a review counts and is labelled `self-approved` (also in the note). A covering review still labels it countersigned. Self-approval is never applied when `allowSelf` is off.
- **ci-review-is-approval**: A qualifying review that covers a changed claim with no approval entry is itself a verified `pr` approval, written to the proof note with reviewer, review id and reviewed commit. An approval already carried in the note for the same wording is reused rather than written again, and one for an earlier wording does not count.
- **ci-pr-entry-needs-same-reviewer**: A committed `pr` approval entry is verified only when a qualifying review whose login equals the entry's author covers the claim. Otherwise it is treated like any recorded entry and needs a countersign where a review is required.
- **ci-removal-needs-review**: Removing a claim is a change of intent. At a capability that requires review, a removal needs a review that saw the claim gone, and an uncovered removal is reported as needing review (not when review is not required or `allowSelf` is on). A covered removal is shown as a verified approval.
- **ci-effective-approvals**: The approvals the statement may count in CI are exactly the ones that pass these rules, judged for every recorded entry (including entries for claims that did not change) and dropping entries for an earlier wording of a changed claim. When several entries approve the same wording the strongest label is shown.

**`--from-pr`**

- **approve-from-pr**: `spec approve --from-pr <n>` makes a pull request's review approvals permanent. It reads the pull request's reviews from GitHub (a token in the environment or `gh auth token`). It writes one committed history entry per reviewer with `method: pr` and that reviewer as author, approving each unapproved claim in scope whose hash at the reviewed commit equals its hash now. Without targets it looks at every unapproved claim. Without `--yes` it only lists what it would record. It refuses `--as-built` and a number that is not a pull request.
- **approve-from-pr-qualifying**: `--from-pr` uses only qualifying reviews (an approval by a human other than the pull request's author with owner, member or collaborator association, latest decisive review per person) and covers only claims whose wording is the one reviewed. A claim reworded after the review is reported as not covered, and no qualifying review writes nothing and exits 2.
- **approve-from-pr-person-only**: `--from-pr` stays a person-only command (an agent without a terminal is refused exactly as for `spec approve`). A pull request that cannot be read (no token, an API error) writes nothing and exits 1 with a message that holds no token.
- **approve-from-pr-ci-rechecks**: `--from-pr` is a convenience and never a way around the review. The entries it writes are still re-checked in CI as records, and count only while a review covers the claim.

**Note on the source spec.** Its Out of Scope section says CI author checks are not covered, and that the `pr` and `plan` methods are "recognised when read but not yet written". Its Security section calls the CI check "a later phase". The `ci-*` and `approve-from-pr*` requirements above describe that behaviour. Treat the requirements as authoritative and confirm the current state against the code before relying on either statement.

<a id="code-map"></a>
## Code map

Sources (4 owned files):

- `src/core/approvals.ts`
- `src/pipelines/approve.ts`
- `src/ci/pr-approvals.ts`
- `src/ci/claim-hash-at.ts`

The spec does not describe the responsibilities of each file. Read them directly to see how the requirements divide among them.

<a id="tests"></a>
## Tests

- `tests/core/approvals.test.ts`
- `tests/pipelines/approve.test.ts`
- `tests/pipelines/approve-from-pr.test.ts`
- `tests/cli/approve.test.ts`
- `tests/mcp/no-approve-tool.test.ts`
- `tests/ci/pr-approvals.test.ts`

The spec defines these scenarios, which tests should cover:

- **Approve a capability**: a dry run prints the claims and "would approve N claim(s)" and writes nothing. Rerun with `--yes`, one `kind: approval` entry appears under `specs/history/`, the capability's `history:` list gains the entry id and nothing else in the file changes, and `spec approvals` shows it fully approved.
- **A requirement is reworded**: only the reworded requirement is listed as unapproved, and `spec approve --yes` approves only that one.
- **Accepting an existing codebase**: `--all --as-built --yes` refuses and names the capability with no source files, writing nothing. After that capability is excluded by naming the others as targets, they are approved with method `as-built`.
- **An agent tries to approve**: with no interactive terminal, the command exits 1 with a message that a person must approve in their own terminal, and no history entry is written.

<a id="security-and-data"></a>
## Security and data

- Approvals are evidence that a person agreed. Anyone with write access to the repository can forge an approval file.
- The refusal for agents without a terminal is a speed bump, not a security control. Real enforcement belongs in CI, where approvals added in a pull request are backed by a qualifying review from someone other than the author.
- The MCP server never exposes approval (`approve-cli-only`), and `history add` refuses approvals (`no-approval-via-history-add`).
- Approval text is passed through the shared redactor like any history entry.
- When a pull request cannot be read, the `--from-pr` error message must not contain the token (`approve-from-pr-person-only`).
- Approving records hashes only. It adds backrefs to `history:` and changes no claim hash, so existing proofs stay valid (`approval-backrefs-keep-hashes`).

<a id="extending-it"></a>
## Extending it

The spec gives no extension procedure. These constraints follow from the requirements:

- Any new route that writes approvals must keep the person-only guard and must not appear on the MCP surface or in `history add`.
- Approvals are keyed by `ref@<first 16 hex of hash>`. New approval targets need their own hash, as example rows do, and must not be implied by approving a parent claim.
- A new approval method must be added to the `method` values and to the CI handling. Today CI treats `command`, `plan` and `as-built` entries as recorded entries that need a countersign where review is required. It treats `pr` entries as verified only with a same-login covering review.
- `proof.requireApproval` is reserved for `check`. Wiring it in is a separate change outside this capability's current scope.
