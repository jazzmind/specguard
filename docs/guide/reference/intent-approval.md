---
title: "Intent Approval"
audience: user
source: "specs/capabilities/intent-approval.md"
generated: true
---
<a id="intent-approval"></a>
# Intent Approval

Intent approval lets a person confirm that each requirement says what the system should do. The confirmation is saved in the repository as a committed record and stops applying as soon as the requirement's wording changes.

<a id="why-it-exists"></a>
## Why it exists

A coding agent can write a requirement, the code for it and a test that proves it, and every check can pass without anyone deciding the requirement was right. Proofs show that code matches a spec. They don't show that a person agreed with the spec. When one tool drafts both sides, the spec just restates what the code already does.

Intent approval adds that human step:

- A person approves a requirement at its exact wording.
- The approval is stored next to the spec, so a reviewer can see who agreed to what, when, and by which method.
- Editing a requirement makes it unapproved again, because the person approved those words, not the new ones.
- Agents cannot approve anything. They can propose intent, but only a person can certify it.

<a id="what-you-can-do"></a>
## What you can do

<a id="approve-requirements"></a>
### Approve requirements

Use `specguard spec approve` with one or more targets:

- a capability, such as `cart`
- a single requirement, written `capability#claim` or as a bare claim id
- `--all` for every requirement

Without `--yes`, the command is a dry run. It lists the requirements it would approve and how many capabilities are involved, then exits successfully and writes nothing. Add `--yes` to record the approval.

Options:

- `--note <text>` adds a note, for example `--note "reviewed with product"`.
- `--by <name>` sets the approver's name.
- `--as-built` accepts what the system already does. It suits teams adopting SpecGuard on an existing codebase, for example `specguard spec approve --all --as-built --yes`.

Each approval event creates one new history record, with the approver as its author and a method (command, as-built, pr or plan). Because every approval is its own file, branches don't conflict over them. The record is added to the history list of each affected capability. It doesn't change any requirement's wording, so existing proofs stay valid.

Approving a requirement with an examples table also covers its example rows. A requirement and each of its rows are approved separately:

- `cap#claim` approves the requirement and all its current rows in one record.
- `cap#claim/row` approves only that row.
- Approving a row never approves the requirement.

<a id="see-where-approval-stands"></a>
### See where approval stands

`specguard spec approvals` shows, for each capability, how many requirements are approved out of the total and which ones are not. Add `--json` for the same information in JSON.

A requirement that was approved earlier and then edited can be told apart from one that was never approved.

<a id="make-a-pull-request-s-review-approvals-permanent"></a>
### Make a pull request's review approvals permanent

`specguard spec approve --from-pr <number>` reads the reviews on a GitHub pull request and records them as approvals. It needs a GitHub token in your environment, or the GitHub CLI signed in.

- It writes one record per reviewer, with that reviewer as the author and method `pr`.
- It approves each unapproved requirement in scope whose wording is the same as when the reviewer looked at it.
- Without targets it considers every unapproved requirement.
- Without `--yes` it only lists what it would record.
- It can't be combined with `--as-built`, and the number must be a pull request.

Only qualifying reviews count: an approval from a human who isn't the pull request's author and who is an owner, member or collaborator. Each person's latest decisive review is the one used. A requirement reworded after the review is reported as not covered. If no qualifying review exists, nothing is written and the command exits with code 2.

<a id="review-approvals-in-ci"></a>
### Review approvals in CI

When a pull request is checked, approvals are judged by these rules.

**Which reviews count.** A review counts if all of these hold:

- It is the reviewer's latest decisive review.
- Its state is APPROVED.
- The reviewer is a human other than the pull request's author, and not a bot.
- The reviewer is an owner, member or collaborator.

A later change request cancels an earlier approval, and a later approval restores a change request. A later plain comment or pending review never withdraws an approval. Login names are compared without regard to case.

**What a review covers.** A review covers a requirement or example row only if its wording at the reviewed commit matches its wording now. A review on an older commit still covers a requirement that hasn't changed since. It stops covering one that was edited afterwards, and it never covers one that didn't yet exist.

**How each approval is labelled:**

| Label | Meaning |
|---|---|
| `inherited` | The approval was already on the base branch, so it counts and needs no review. |
| countersigned (names the reviewer) | The approval was added in the pull request and a qualifying review covers it. |
| `recorded` | The approval was added in the pull request and no review is required at that level. |
| `missing` | A review is required but absent, so the approval doesn't count. |
| `self-approved` | The approval was added without a review and the `allowSelf` setting is on, so it counts. |

When several records approve the same wording, the strongest label is shown.

**Whether a review is required.** The `approvals.ci.requireReview` setting decides: `enforce` (capabilities at enforce level), `always` or `never`.

**Other cases:**

- A qualifying review of a changed requirement that has no approval record counts as a verified `pr` approval. It is noted with the reviewer, review id and reviewed commit.
- A committed `pr` approval record is verified only when a qualifying review from the same login covers the requirement.
- Removing a requirement is a change of intent. Where review is required, the removal needs a review that saw it gone, and an uncovered removal is reported as needing review.

`--from-pr` never bypasses review. The records it writes are checked again in CI and count only while a review covers the requirement.

<a id="what-to-expect"></a>
## What to expect

- **Approving is safe to repeat.** Only requirements not yet approved at their current wording are added. A second identical run writes nothing.
- **Rewording removes approval.** If you edit one requirement in an approved capability, only that one shows as unapproved in `spec approvals`. Approving the capability again approves just that requirement.
- **Targets are checked first.** An unknown or ambiguous target fails with exit code 2 and writes nothing.
- **`--as-built` is for existing code.** If any capability in scope has no source files, the command refuses with exit code 2 and writes nothing, so new or unfinished capabilities can't skip review. Name the capabilities that do have code to approve just those.
- **Agents are refused.** An agent running `spec approve` (including `--from-pr`) without an interactive terminal gets exit code 1 and a message that a person must approve in their own terminal. Nothing is written. The agent tool interface offers no approval at all, and `history add` refuses to record approvals, pointing you to `spec approve`.
- **Pull requests can't be read.** If there is no token or GitHub returns an error, nothing is written, the command exits with code 1, and the message never contains the token.
- **Reviewers see approvals in pull requests.** A new history record names which requirements were approved, by whom and by which method.
- **The agent refusal is not a security control.** Anyone with write access to the repository could create an approval record by hand. The real safeguard is the CI review checks above. Approval text is passed through the same redaction as other history entries.
- **Exit codes.** 0 means success or dry run. 1 means refused for an agent without a terminal, missing arguments, or an unreadable pull request. 2 means an unknown target, `--as-built` on a capability with no sources, or no qualifying review for `--from-pr`.
- **`proof.requireApproval` does nothing yet.** It is a reserved setting, and `check` does not yet require approval before a requirement counts as proven.
