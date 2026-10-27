---
id: spec-first-changes
kind: capability
title: Spec-First Changes
parent: system
value: A change goes spec, tests, red, code, green, validated in that order, with enforcement set per capability, so a requirement is approved before it is built, its tests are seen failing before the code exists, and review sees a packet of what changed and what was proven instead of reading code.
status: active
sources:
  - "src/core/change-record.ts"
  - "src/core/change-claims.ts"
  - "src/core/unrequested.ts"
  - "src/core/proof-packet.ts"
  - "src/hooks/**"
  - "src/cli/commands/change.ts"
  - "src/cli/commands/enforce.ts"
  - "src/cli/commands/hook.ts"
  - "src/core/change-base.ts"
  - "src/core/change-stage.ts"
  - "src/core/enforce.ts"
  - "src/pipelines/enforce.ts"
  - "src/pipelines/change.ts"
  - "src/pipelines/change-run.ts"
  - "src/pipelines/change-store.ts"
  - "src/pipelines/history.ts"
  - "src/mcp/tools/change.ts"
  - "plugins/specguard/skills/specguard-change/SKILL.md"
  - "src/hooks/entry.ts"
  - "src/hooks/index-build.ts"
  - "src/hooks/main.ts"
  - "src/hooks/picomatch.d.ts"
  - "scripts/build-hook-bundle.mjs"
docs: []
history:
  - 2026-10-26-phase-3-contracts-and-seams
  - 2026-10-26-change-model-is-four-pure-modules-stage
  - 2026-10-26-proof-packet-and-unrequested-code-check
  - 2026-10-26-per-capability-enforcement-ratchet-and-i
  - 2026-10-26-edit-guard-is-a-pure-decision-table-over
  - 2026-10-26-change-pipeline-joins-the-pure-model-to
  - 2026-10-26-edit-guard-hook-entry-index-and-bundle
  - 2026-10-26-edit-guard-reads-the-red-record-change-r
  - 2026-10-27-hook-bundle-build-is-layout-independent
tests:
  - "tests/core/contracts-phase3.test.ts"
  - "tests/core/config-phase3.test.ts"
  - "tests/core/change-record.test.ts"
  - "tests/core/change-claims.test.ts"
  - "tests/core/change-base.test.ts"
  - "tests/core/change-stage.test.ts"
  - "tests/core/proof-packet.test.ts"
  - "tests/core/unrequested.test.ts"
  - "tests/core/enforce.test.ts"
  - "tests/core/weakening-enforce.test.ts"
  - "tests/pipelines/enforce.test.ts"
  - "tests/hooks/decide.test.ts"
  - "tests/hooks/stdin.test.ts"
  - "tests/pipelines/change.test.ts"
  - "tests/pipelines/change-run.test.ts"
  - "tests/mcp/change-tools.test.ts"
  - "tests/hooks/entry.test.ts"
  - "tests/hooks/index-build.test.ts"
  - "tests/hooks/bundle-fresh.test.ts"
  - "tests/cli/hook.test.ts"
  - "tests/pipelines/init-codex.test.ts"
  - "tests/e2e/change-protocol.test.ts"
  - "tests/e2e/change-guards.test.ts"
  - "tests/e2e/change-evidence.test.ts"
---

# Spec-First Changes

## Problem & Value
A coding agent can write the code, then the requirement that describes it, then a test that passes, and every check is green while nobody decided the requirement was right and no test ever failed. Checking proof after the fact cannot tell a test that detects a change from one written to agree with the code.

A spec-first change reverses the order and enforces it. The requirement is written and approved first, the tests that cite it must fail against the old code, and only then is code written. Each capability sets how strictly this binds it, from observing to enforcing, so a repository can tighten one capability at a time. The pull request carries a packet that lists the requirements that changed, the evidence for each, any test that was weakened and any code no requirement asked for.

## Users & Journeys
- A developer starts a change for a capability, edits the requirement, approves it, writes tests and records a red run before any owned code is edited.
- A coding agent that tries to edit owned code before the requirement and a failing test exist is stopped by the edit guard and told the next step.
- A tech lead raises one capability from observe to warn to enforce while the rest of the repository stays advisory.
- A reviewer opens a pull request and reads the proof packet: requirements that changed in plain words, how far each approval can be trusted, and code no requirement asked for.
- A maintainer refactors without changing a requirement and the change closes on a green run of the capability's claim tests and a CI pass.

## Requirements
- [ ] A change record is one JSON file named by an id of date, slug and four hex characters, lists at least one capability and has the kind feature, refactor or spike, so the record contract rejects an id that could leave the changes directory, a record without a capability and an unknown kind <!-- claim: change-record-contract -->
- [ ] A capability's enforcement level is observe, warn or enforce, weakest first, and a repository whose config sets none treats every capability as observe <!-- claim: enforce-levels -->
- [ ] A change's changed claims are computed by diffing the capability's spec at its base against the current spec: a claim is added, modified (its wording, or the Problem & Value it is read under, changed) or removed (kept with its base text), a spec file added or deleted adds or removes all its claims, and an edit outside the claims (frontmatter, spacing, history links) changes nothing. <!-- claim: changed-claims -->
- [ ] An example row is its own changed ref: an added, reworded or removed row is listed with the claim marked modified (rows-added, rows-changed, rows-removed), while a claim whose only change is its wording lists no row, because each row hash moves with the claim hash. <!-- claim: changed-example-rows -->
- [ ] A change's stage (spec, tests, red, code, green, validated) is detected from facts (changed claims, approvals, tagged tests and their strength, hashes, run records, the CI verdict), never from the change record, and is the first stage whose rule fails; the status carries the blocks that explain it and one next command. <!-- claim: stages-detected-from-facts -->
- [ ] Once code differs from base, a red whose tests or spec were edited afterwards is invalid: the stage falls back to tests with a block naming what was edited, and the fix is to record red again against the current files. <!-- claim: stage-locks -->
- [ ] A red run counts only when it belongs to the change, matches the current spec and test hashes, ran against owned code equal to base, and every added or modified ref has a failing test; an error counts for an added ref (default), for every ref, or for none, per policy, and tests that cover no changed ref are ignored. <!-- claim: red-acceptance -->
- [ ] A green run counts only when it belongs to the change, matches the current spec, test and code hashes, and every test tagged to a changed ref passed; any edit after it makes it stale. <!-- claim: green-acceptance -->
- [ ] A refactor changes no requirement: a changed claim blocks it, tests and red do not apply, and it needs code, a green run in which every claim test of its capabilities passed, and a CI pass. <!-- claim: refactor-rules -->
- [ ] A spike follows the feature rules for spec, tests and red but can never be validated; converting it to a feature keeps its trail and lets CI decide. <!-- claim: spike-rules -->
- [ ] The base ref is the first of the explicit flag, the record's base, the configured base, origin/HEAD, origin/main, main and master that resolves; a ref that could be read as an option is refused, and an explicit flag that is unusable fails instead of falling through. <!-- claim: base-resolution -->
- [ ] A change record is one file named by an id of date, slug and four random hex characters, so parallel changes never collide; it parses strictly (kind, capabilities, id), keeps fields a newer version added, and serializes to the same bytes every time. <!-- claim: change-ids-and-records -->
- [ ] Parallel changes on one branch see the same changed claims and are judged by their own run records, and a closed change keeps its closed fields and has no next step. <!-- claim: parallel-and-abandoned -->
- [ ] A change that links plans gets computed plan approvals (never written) for every changed, non-removed ref of its capabilities, taken from the newest linked plan, and removed claims, other capabilities and refs without a current hash get none. <!-- claim: plan-approvals -->
- [ ] The PR proof packet is one markdown comment built only from text already in the specs, history and proof statement, with a headline and, when they have something to show, these sections in order: "What the requirements now say" (one row per added, modified or removed requirement and example row, with who approved it), "Evidence for changed requirements", "Capabilities" (always shown, with the four pillars and the effect on the merge), "Changes", "Test weakening", "Code no requirement asked for", "Pipeline changes" and a collapsed list of fixes <!-- claim: packet-sections -->
- [ ] The packet verdict is `blocked` when any touched capability blocks, else `advisory` when one warns or a pipeline file changed at error severity, else `no-change` when there is no requirement change, no owned-code change, no weakening and no pipeline change, else `ready`; a capability passes only when the changed claims' four pillars are ok, no error-level weakening names it, no unrequested line is an error, no changed file lacks a change and every change covering it passed (a spike counts as not passed), is `unknown` when the only problems are unknown, and an `enforce` capability that is `unknown` or `fail` blocks, a `warn` one that is not `pass` warns, an `observe` one never affects the merge and is shown collapsed <!-- claim: packet-verdict -->
- [ ] Each changed requirement is told in plain language from its own text, never from a model: an added claim reads "now reads: ...", a modified one "now reads: ... (was: ...)", a removed one "removed (was: ...)", and an example row is described the same way as a row, so a reviewer sees the intent diff instead of the code <!-- claim: packet-intent-plain -->
- [ ] An approval is labelled by how far it can be trusted: a PR review by a named reviewer is `verified`, an entry added in the PR with a qualifying review is `countersigned`, one already on the base branch is `inherited`, one with no second reviewer is `self-approved`, one still needing a review shows as pending, and a requirement with none shows as not approved; only a verified reviewer is named with a mention <!-- claim: packet-approval-trust -->
- [ ] Code reported as unrequested is found by line: a changed executable line of an owned file that no test of the change's claims reaches is `unrequested`, one reached only by other claims' tests of the same capability is `incidental`, and one with no fresh line data, suite-wide or summarized coverage, or file-level test selection is `unknown` and makes the evidence not claimable, while an owned code file changed with no open change covering any of its capabilities is listed as changed without a change <!-- claim: unrequested-lines -->
- [ ] The severity of unrequested code comes from configuration: with `unrequested.severity` set to `error` an unrequested line fails its capability (blocking at `enforce`), with `warn` it only makes the packet advisory, and incidental and unknown lines never block <!-- claim: unrequested-severity -->
- [ ] A packet that would exceed the comment size is cut deterministically to fit under the limit (60,000 characters by default, never above GitHub's 65,536): tables lose rows from the end in fixed steps and say how many more are in packet.json, while the headline, the Capabilities table and the fixes are kept longest, and a packet too large for even that falls back to the verdict and headline <!-- claim: packet-truncation -->
- [ ] The first line of every rendered packet is the marker `<!-- specguard-proof-packet v1 -->`, which untrusted text cannot repeat, so CI finds its own comment and updates it in place <!-- claim: packet-marker -->
- [ ] The packet digest is the sha256 of the packet JSON with keys in a stable order, so the same packet always has the same digest and any change to it changes the digest, and the markdown ends with that digest <!-- claim: packet-digest-stable -->
- [ ] The packet never contains secrets or live markup from untrusted text: credentials in spec, test and finding text are masked in both the markdown and the JSON, and pipes, backslashes, backticks, angle brackets, brackets and mentions are escaped, text is collapsed to one line and capped at 200 characters per cell, and the PR author and absolute paths are never printed <!-- claim: packet-no-secrets -->
- [ ] A capability's effective level is its `enforce:` frontmatter, else the config's `enforce.default`, else `observe`; a new capability takes `enforce.newCapabilities`, else the default level <!-- claim: enforce-default-observe -->
- [ ] An `enforce:` value that is not `observe`, `warn` or `enforce` never makes the spec unreadable: it is kept as an unknown key, reported by `enforce show` as ignored, and the capability takes the default level <!-- claim: enforce-unknown-collected -->
- [ ] `enforce:` is outside every claim hash, so raising or lowering it never stales an approval, and the only guard on a lowering is policy-weakening detection <!-- claim: enforce-not-hashed -->
- [ ] Between two versions of a capability spec, a lowered `enforce:` level, or one removed so the capability falls below the config default, is an error-level `policy-enforce-lowered` finding naming the capability and its claims; raising, keeping, or newly setting a level is not <!-- claim: enforce-lowering-is-weakening -->
- [ ] `specguard enforce raise <capability...> [--to <level>]` moves a capability up (default: the next level); moving to `warn` is always allowed, moving to `enforce` only while the capability's proof statement is certified, otherwise every named capability is refused with the reasons that block it (exit 13) and nothing is written <!-- claim: enforce-raise-while-certified -->
- [ ] `specguard enforce lower <capability...> --to <level> --why <text>` needs a reason, accepts only a lower level, and records a `decision` history entry naming the person with the policy line `enforce lowered: <capability> <from>-><to>` and the reason; `raise` records `enforce raised: ...` the same way <!-- claim: enforce-lower-recorded -->
- [ ] `enforce raise` and `enforce lower` refuse, writing nothing, when an agent without a terminal is detected, the same guard as `spec approve`; a person in a terminal is never refused <!-- claim: enforce-person-only -->
- [ ] The level is written with a one-line frontmatter edit: an existing `enforce:` line is changed in place (a trailing comment is kept), a missing one is added after the last frontmatter line, and the body and every other line stay byte for byte the same apart from the history back-reference <!-- claim: enforce-minimal-edit -->
- [ ] `specguard enforce show [capability...]` (alias `status`) prints every capability's level, whether it is set or defaulted, its certification, and whether it could be raised now <!-- claim: enforce-show -->
- [ ] At observe the guard logs an edit to owned source with no covering change and allows it without a message, so a repository can watch the pattern before it binds <!-- claim: hook-observe-logs -->
- [ ] At warn the guard allows an edit to owned source that has no change, or a change that is unapproved or has no valid red, and its message names the one command that is the next step <!-- claim: hook-warn-names-next-step -->
- [ ] At enforce the guard denies an edit to owned source when no open change covers it, when the change has requirements nobody approved, or when the change has no valid failing-test evidence yet, and allows it once a feature change is approved with valid red <!-- claim: hook-enforce-denies-code -->
- [ ] Specs and tests are always editable and other files are never guarded, at every level, and edits to config, workflows and CODEOWNERS are allowed with a note that CI reviews them <!-- claim: hook-spec-test-free -->
- [ ] A test edit, or a spec edit, that would invalidate a change's valid red is allowed and answered with a message that the change is back at red and names the command to run again, and red validity is the live value the entry supplies, not the build-time one <!-- claim: hook-stage-lock -->
- [ ] The guard denies an agent's attempt to approve requirements: a history file write whose new text is an approval, any edit to a closed change record or one that sets its kind or closed state, and a Bash command that runs spec approve, enforce lower or raise, change convert, abandon or done with force, or proof publish, in plain, npx, bin and node forms, inside bash -c, eval and command substitution <!-- claim: hook-agent-bash-guard -->
- [ ] The guard denies shell writes into the history directory and git commands that write the proof notes ref, and allows reading them and every other git and specguard command <!-- claim: hook-approval-write-denied -->
- [ ] When an edit touches several files each is decided and the strictest verdict wins, and a file owned by several capabilities takes the strictest level among them and needs a change that covers all of them <!-- claim: hook-strictest-wins -->
- [ ] The guard fails open: a malformed or unknown hook payload, a missing index part, a path outside the repository or an error in the hook allows the call (with a notice that CI still checks when it was an error), and the guard never throws <!-- claim: hook-fails-open -->
- [ ] Every message the guard shows the agent is one line of at most 300 characters and contains one command <!-- claim: hook-messages-short -->
- [ ] Codex edits are read from apply_patch text, so every added, updated, deleted and moved path in the patch is guarded like a Claude edit, and a decision that would ask becomes a deny because Codex has no ask <!-- claim: hook-codex-patch-paths -->
- [ ] An open refactor change allows code edits at every level in any order, and an open spike allows code-first edits, silently at observe and with the cannot-merge message at warn and enforce <!-- claim: hook-change-kinds -->
- [ ] `specguard change start <capabilities...>` writes exactly one record of declared intent, `.specguard/changes/<id>.json` (kind, capabilities, why, base ref, start commit, branch, linked plans and nothing about stages or runs), and refuses an unknown capability, an empty list or an unknown `--plan` entry without writing anything <!-- claim: change-start-record -->
- [ ] A change started on the branch its base ref names records the start commit as its base instead of the branch name, so later commits on that branch do not move the base and hide the change; an explicit `--base` that does not resolve fails instead of falling back <!-- claim: change-base-pinned -->
- [ ] `change status` gathers its facts from git, the specs, the test tags and the run records (changed claims against the base commit, approvals including plan-derived ones, tagged tests and their strength, hashes of the changed claims, tagged test files and owned source, the owned files that differ from base, the newest red and green runs) and moves through spec, tests, red, code, green and validated as the files really change; a test or spec edit after red with code present sends it back, and a refactor needs no spec, tests or red but fails on a changed requirement <!-- claim: change-stages-detected-live -->
- [ ] Editing a change record cannot advance a stage, and red and green are judged from the content of the run records the runner's report produced, so rewriting a verdict there or removing the record changes the stage and a pointer file only names the record <!-- claim: change-record-not-evidence -->
- [ ] `change red` runs exactly the tests tagged to the added and modified requirements, in the working tree while owned code still equals base and otherwise in a constructed tree holding the current specs and tests and the owned code as it was at base, never ingests its verdicts into the proof ledger, leaves the user's working tree untouched and removes the temporary tree; it is refused before the spec is approved and tested, and a run in which a test already passes is recorded as not red <!-- claim: change-red-run -->
- [ ] `change green` is refused until red is valid and owned code exists, records the passing run of the changed requirements' tests (or of every claim of the capabilities for a refactor) and ingests it, reports a failing run as not green, and leaves the change at validated-pending until CI says it passed <!-- claim: change-green-run -->
- [ ] A plan captured while a change is open is recorded on the open changes of the capabilities it affects (or, when it was recorded against the system as a whole, every open change on the branch), never on a closed change or one on another branch, and a linked plan stands in for the approval of the changed requirements <!-- claim: change-plan-link -->
- [ ] `change done` is refused unless the change is validated, or forced with a reason that the closed record keeps; `change abandon` needs a reason; a closed record is never edited by any change command and has no next step <!-- claim: change-close-rules -->
- [ ] A spike may write code before the spec and is never validated; `change convert <id> --to feature` is refused while it has no changed requirement or any changed requirement has no tagged test, and keeps the spike's trail when it succeeds <!-- claim: change-spike-convert -->
- [ ] Two changes open on one capability and branch warn at start, are judged on the same changed claims, are each judged by their own run records, and a command that acts on one needs it named <!-- claim: change-parallel-shared -->
- [ ] `change report` builds the proof packet locally and marks it provisional: the requirements that changed in plain words with their local approval, the red-green sensitivity read from the run records, weakened tests, code changed under no change record, and no per-line list of unrequested code when no coverage was ingested <!-- claim: change-report-local -->
- [ ] The MCP server offers `specguard_change_start`, `_red`, `_green`, `_status` and `_report`, only status and report when read-only, and no tool that approves a requirement or closes, converts or abandons a change; the stage rules bind a tool call exactly as they bind the CLI <!-- claim: change-mcp-tools -->
- [ ] The hook entry answers a PreToolUse call on stdin with one JSON line and exit code 0: a deny or ask prints `hookSpecificOutput` with `hookEventName`, `permissionDecision` and the one-line reason, an allow that has advice (a warning, the back-at-red notice, a policy-file note) prints `additionalContext` and no `permissionDecision` so it never skips the user's permission prompt, and a plain allow prints nothing; the committed plugin bundle and `specguard hook pre-tool-use` print the same bytes <!-- claim: hook-entry-protocol -->
- [ ] The guard is silent, and writes and reads nothing, in a directory with no `.specguard/config.json`, for a path outside the repository, and for a tool or event it does not guard; it finds the project from a subdirectory and treats a path reached through a symlink to the repository as inside it <!-- claim: hook-silent-outside-project -->
- [ ] A payload the entry cannot read, or an internal error, in a SpecGuard project allows the call with a one-line notice that CI still checks (`ERROR_OPEN`), exits 0 and is logged; the entry never throws <!-- claim: hook-entry-fail-open-message -->
- [ ] With `hooks.onError: "deny"` an error that stops the guard deciding (such as a config that no longer parses) in a project with an `enforce` capability denies with `ERROR_CLOSED`; the default is to allow, and an unreadable payload is always an allow <!-- claim: hook-on-error-deny -->
- [ ] The ownership index lists the files each capability owns, each capability's spec file, enforce level and source globs, the test globs, the specs and history directories, and every open change with its kind, capabilities, the test files its red run covered (the lock set), its red record's validity and whether its changed claims are approved against its base; closed changes are left out and a record that does not parse becomes a note, not an error <!-- claim: hook-index-contents -->
- [ ] The index is cached in `.specguard/cache/hook-index.json` under a stat-only fingerprint of the config, every spec and history file, every change record and every red record; it is reused while the fingerprint holds, rebuilt in process the moment a spec, record or the config moves, and not rebuilt for a test or source edit (new source files are matched by the capabilities' globs); a corrupt cache is a miss and the cache is written atomically <!-- claim: hook-index-cache -->
- [ ] Red validity is checked live: on every call the entry re-hashes the locked test files against the red record's tests hash, so editing a locked test makes red invalid without any index rebuild and restoring the file makes it valid again, and a red record that shows no failing test or ran on code that was not at base is never valid <!-- claim: hook-live-red -->
- [ ] The hook decides with no model and no network, in about 55 ms on a warm index (node start-up included) and under 200 ms when it has to rebuild the index for a small repository; the committed test allows a generous second <!-- claim: hook-speed -->
- [ ] Every decision except the silent ones is appended as one JSON line to `.specguard/cache/hooks.jsonl` with its time, session, agent, tool, paths, capabilities, level, code and change, and the log rolls over to `hooks.1.jsonl` past 1 MB, so it is bounded and never in git <!-- claim: hook-decision-log -->
- [ ] The plugin ships the guard as one committed self-contained file that imports only node built-ins, so it needs no install step, and a test rebuilds it from the sources and fails when the committed bundle differs, and the rebuild depends only on the sources, the dependency versions and the esbuild version, so an npm install and a pnpm install produce byte-identical bundles <!-- claim: hook-bundle-fresh -->
- [ ] `specguard hook` has `pre-tool-use` (the same logic as the bundle, reading stdin), `build-index` (alias `index`: rebuild and cache the index), `doctor` (print the class of each path, or of a shell command, and what the guard would decide and why, as text or `--json`) and `log` (recent decisions, `--denied` for denials only) <!-- claim: hook-commands -->
- [ ] A Codex session counts as an agent environment (`CODEX_THREAD_ID` is set), so the approve and lower guards apply, while an explicit `SPECGUARD_HOST_AGENT` setting still wins <!-- claim: hook-codex-agent-env -->
- [ ] The edit guard treats any edit to an approval already on disk (a history entry whose frontmatter says `kind: approval`) as writing an approval and denies it, because an edit is judged on its new text alone and changing only the hashes in an existing approval would otherwise pass; other history entries stay editable <!-- claim: hook-approval-edit-denied -->
- [ ] A change walked end to end through the real commands and the real hook process obeys the order spec, approval by a person, tests, red, code, green: the guard denies a capability's code at `enforce` with no change open, then with unapproved requirements, then with no recorded red, allows it once red is recorded, and `change status` shows the change green and waiting for CI, never validated by itself <!-- claim: e2e-full-protocol -->
- [ ] The red evidence the edit guard reads is written by `change red` itself, in the same file and from the same run record `change status` reads: the file holds the run's per-test verdicts, the hashes the run saw and the test files it locks, so the guard and the stage detection cannot disagree about whether red holds <!-- claim: e2e-hook-follows-red -->
- [ ] An agent cannot approve its own requirement by any route: `spec approve` refuses an agent environment, `history add` refuses approval entries, the guard denies a hand-written approval file, a rewrite of a change record and the shell forms of approving, and none of them moves a change out of the spec stage <!-- claim: e2e-agent-cannot-approve -->
- [ ] Editing a locked test or a changed requirement after red sends the change back to the tests stage and the guard denies the code again until `change red` is run anew, which builds a tree with the owned code at base and leaves the working tree as it was; the guard announces the lock when a locked file is edited <!-- claim: e2e-locked-test-edit -->
- [ ] A refactor change opens only its own capability's code at once and needs no red, a requirement edit under it is reported as changing intent, and a spike may write code first but never reaches validated, not even with a passing CI verdict, and cannot be closed as done <!-- claim: e2e-refactor-spike -->
- [ ] Two changes open on one capability are judged on the same changed claims and each needs its own red; any one with a valid red opens the code, and closing or abandoning it closes the code again unless the other has red <!-- claim: e2e-parallel-changes -->
- [ ] A finished change is `provisional` while its proof comes only from local runs and `certified` only from a CI proof note for a clean commit, and `enforce raise --to enforce` is refused on the first and accepted on the second even in a checkout that holds no local proof, after which the guard denies edits made without a change <!-- claim: e2e-certified-needs-ci -->
- [ ] With a change open and red recorded, the guard answers from its cached index in under 200 ms at the median and 500 ms at the 95th percentile per call (a spawned process, node start-up included; about 50 ms on a quiet machine), for allow and deny alike <!-- claim: e2e-hook-latency -->
