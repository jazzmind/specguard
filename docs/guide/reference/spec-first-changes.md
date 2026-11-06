---
title: "Spec-First Changes"
audience: user
source: "specs/capabilities/spec-first-changes.md"
generated: true
---
<a id="spec-first-changes"></a>
# Spec-First Changes

<a id="why-it-exists"></a>
## Why it exists

A coding agent can write code, then a requirement that describes it, then a test that passes. Every check is green, yet nobody decided the requirement was right and no test ever failed. Checking proof after the fact can't tell a test that detects a change from one written to agree with the code.

Spec-first changes reverse the order and enforce it:

1. The requirement is written and approved by a person.
2. Tests that cite it are written and must fail against the old code.
3. Only then is the code written.
4. The tests go green, and CI validates the result.

Reviewers get a proof packet that says what changed and what was proven, so they don't have to read the code to find out.

<a id="what-you-can-do"></a>
## What you can do

<a id="work-through-a-change-in-order"></a>
### Work through a change in order

A change moves through six stages: **spec, tests, red, code, green, validated**. You open one with `specguard change start <capabilities...>`, giving the capabilities it touches and a reason. You can choose one of three kinds:

- **Feature**: changes one or more requirements and follows every stage.
- **Refactor**: changes no requirement. It needs code, a green run of all the capability's claim tests, and a CI pass. A requirement edit under a refactor is reported as changing intent and blocks it.
- **Spike**: for exploration. You can write code first, but a spike can never be validated or closed as done. Convert it with `change convert <id> --to feature` once it has a changed requirement and every changed requirement has a tagged test. The spike's trail is kept.

Use `change status` at any time. It works out the stage from what has really changed: the requirements, approvals, tests, run results and CI verdict. It shows what blocks you and the one next command to run.

- `change red` runs exactly the tests tied to the added and modified requirements against the old code. It leaves your working tree untouched. It is refused until the spec is approved and tested, and a run where a test already passes is recorded as not red.
- `change green` is refused until red is valid and code exists. A passing run leaves the change waiting for CI, because a change is never validated by local runs alone.
- `change done` needs a validated change, or a forced close with a reason that is kept. `change abandon` needs a reason.
- `change report` builds the proof packet locally and marks it provisional.

If you edit a locked test or a changed requirement after red, the change drops back to the tests stage and you record red again.

<a id="tighten-enforcement-one-capability-at-a-time"></a>
### Tighten enforcement one capability at a time

Each capability has a level, weakest first: **observe**, **warn** or **enforce**. Unless the repository sets otherwise, every capability is at observe.

- `specguard enforce show` lists each capability's level, whether it is set or defaulted, its certification, and whether it could be raised now.
- `specguard enforce raise <capability...> [--to <level>]` moves a capability up, by default to the next level. Moving to `enforce` is allowed only when the capability's proof is **certified**, meaning it comes from a CI proof note on a clean commit. Local runs only make it **provisional**. If a capability is refused, nothing is written and the reasons are listed.
- `specguard enforce lower <capability...> --to <level> --why <text>` requires a reason. Raising and lowering are both recorded in the capability's history with the person's name. A lowering is also flagged as a policy-weakening finding when it is reviewed.
- Neither command works when an agent without a terminal is detected. A person in a terminal is never refused.

Changing a level never invalidates an approval. If a level is written with an unrecognised value, the spec is still readable. `enforce show` reports the value as ignored and the default level applies.

<a id="let-the-edit-guard-keep-agents-on-track"></a>
### Let the edit guard keep agents on track

The edit guard checks an agent's edits to code that a capability owns:

| Level | Edit to owned code with no change, or a change that isn't ready |
|---|---|
| observe | Allowed silently, and logged so you can watch the pattern. |
| warn | Allowed, with a one-line message naming the next command. |
| enforce | Denied if no open change covers it, requirements are unapproved, or there is no valid failing-test evidence. Allowed once a feature change is approved with valid red. |

- Specs and tests are always editable, and other files are never guarded.
- Edits to configuration, workflows and CODEOWNERS are allowed with a note that CI reviews them.
- Open refactors allow code edits in any order. Open spikes allow code-first edits, with a cannot-merge message at warn and enforce.
- If a file belongs to several capabilities, the strictest level applies and the change must cover all of them.
- An edit that invalidates a valid red is allowed, with a message that the change is back at red and which command to run again.
- Agents can't approve requirements. The guard denies hand-written approvals, edits to existing approvals, edits to closed change records, writing to the history area or the proof notes, and shell commands that approve, raise or lower enforcement, convert, abandon, force-close, or publish proof. `spec approve` and `history add` also refuse agent approvals.
- Codex edits are guarded the same way as Claude edits. Because Codex has no "ask", a decision that would ask becomes a deny.
- Every message is a single line with one command in it.

<a id="review-from-a-proof-packet"></a>
### Review from a proof packet

Each pull request gets one comment, updated in place. It opens with a headline and a verdict, then shows these sections when they have something to say:

- **What the requirements now say**: each added, modified or removed requirement and example row, in plain words taken from the spec text. For example, "now reads: …", "now reads: … (was: …)" or "removed (was: …)". Each row shows who approved it.
- **Evidence for changed requirements.**
- **Capabilities**: always shown, with the effect on the merge.
- **Changes.**
- **Test weakening.**
- **Code no requirement asked for.**
- **Pipeline changes.**
- A collapsed list of fixes.

Approvals are labelled by how far they can be trusted:

- **verified**: a PR review by a named reviewer. Only these reviewers are mentioned by name.
- **countersigned**: added in the PR with a qualifying review.
- **inherited**: already on the base branch.
- **self-approved**: no second reviewer.
- **pending**: still needs a review.
- **not approved**: none exists.

Unrequested code is judged line by line:

- **unrequested**: a changed executable line that no test of the change's requirements reaches.
- **incidental**: reached only by other requirements' tests in the same capability.
- **unknown**: no fresh line-level coverage data. This makes the evidence not claimable.

Owned code changed with no open change covering it is listed as changed without a change. A configuration setting decides how severe unrequested code is. At `error`, an unrequested line fails its capability, and blocks at enforce. At `warn`, it only makes the packet advisory. Incidental and unknown lines never block.

<a id="verdicts-and-merge-effect"></a>
### Verdicts and merge effect

- **blocked**: a touched capability at `enforce` is failing or unknown.
- **advisory**: a `warn` capability isn't passing, or a pipeline file changed at error severity.
- **no-change**: no requirement, owned-code, weakening or pipeline change.
- **ready**: anything else.

A capability at `observe` never affects the merge and is shown collapsed.

<a id="what-to-expect"></a>
## What to expect

- **Stages follow the facts.** Editing a change record can't advance a stage. Red and green come from the real run results, and editing or removing them changes the stage.
- **Parallel changes.** Two changes open on the same capability and branch trigger a warning at start. They are judged on the same changed claims, but each needs its own red and its own green. Any one with valid red opens the code, and closing or abandoning it closes the code again unless the other has red. Commands that act on one change need it named.
- **Plans.** A plan captured while a change is open is recorded on the open changes it affects, never on closed ones or ones on another branch. A linked plan stands in for approval of the changed requirements.
- **Safe base.** The change's base is chosen from your explicit option, then the record, configuration, and common defaults. A base that could be mistaken for an option is refused, and an explicit base that can't be used fails instead of silently falling back. Starting a change on the base branch itself pins the base to the starting commit, so later commits don't hide the change.
- **Safe packets.** The comment is built only from text already in the specs, history and proof statement, with no model involved. Credentials are masked. Markup, mentions and special characters are escaped, and each table cell is a single line capped at 200 characters. The PR author and absolute paths are never printed. The packet starts with a fixed marker so CI can find and update its own comment. It ends with a digest that changes whenever the packet changes. If it grows too large for a comment, tables lose rows from the end first and say how many more are in the full packet. The verdict and headline are always kept.
- **Fast and quiet guard.** It uses no model and no network and answers in well under a second. It is silent in a directory that isn't a SpecGuard project, for paths outside the repository, and for tools it doesn't guard. It fails open: an unreadable request or an internal error allows the call, with a notice that CI still checks. If the repository sets `hooks.onError: "deny"`, an error that stops the guard from deciding denies instead, in projects with an `enforce` capability. Every decision is logged locally and the log stays small.
- **Helpful tools.** `specguard hook doctor` shows how the guard would classify a path or shell command and why. `specguard hook log` shows recent decisions, or only denials with `--denied`. `specguard hook build-index` rebuilds the guard's lookup of what each capability owns. The assistant integration offers tools to start a change, record red, record green, check status and build a report, with only status and report in read-only mode. It has no tool that approves a requirement or closes, converts or abandons a change.
