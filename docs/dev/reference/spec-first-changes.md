---
title: "Spec-First Changes (developer reference)"
audience: dev
source: "specs/capabilities/spec-first-changes.md"
generated: true
---
<a id="spec-first-changes"></a>
# Spec-First Changes

<a id="purpose"></a>
## Purpose

Spec-first changes enforce the order **spec, tests, red, code, green, validated**. A requirement is approved before it is built. The tests that cite it must be seen failing against the old code before the code exists. Review then reads a proof packet of what changed and what was proven, not the code.

The problem it addresses is that an agent can write code, then a requirement describing it, then a passing test, so every check is green while nobody decided the requirement was right and no test ever failed. Enforcement is set per capability (`observe`, `warn`, `enforce`), so a repository can tighten one capability at a time. The pull request carries a packet listing:

- the requirements that changed
- the evidence for each
- any weakened test
- any code no requirement asked for

Journeys it supports:

- A developer starts a change, edits and approves the requirement, writes tests and records a red run before editing owned code.
- An agent that edits owned code too early is stopped by the edit guard and told the next step.
- A tech lead raises one capability from observe to warn to enforce while the rest of the repository stays advisory.
- A reviewer reads the proof packet.
- A maintainer refactors without changing a requirement. The change closes on a green run of the capability's claim tests and a CI pass.

<a id="responsibilities"></a>
## Responsibilities

- **Change records:** declare intent only (kind, capabilities, why, base, branch, linked plans). They never carry stage or run data.
- **Changed-claim computation:** diff a capability's spec at the base against the current spec, including example rows.
- **Stage detection:** derive the stage from facts (claims, approvals, tagged tests, hashes, run records, CI verdict), never from the record.
- **Red and green runs:** `change red` and `change green` run the tagged tests and record the evidence that red and green acceptance are judged from.
- **Enforcement levels:** read, show, raise and lower levels, with lowering treated as policy weakening.
- **Edit guard (hook):** decides every agent edit and shell command without a model or network, per capability level, and fails open on errors.
- **Proof packet:** builds one deterministic, escaped, size-bounded markdown comment plus JSON, with a verdict and per-capability effect on the merge.
- **Unrequested-code detection:** finds changed executable lines that no test of the change's claims reaches.
- **Agent restrictions:** an agent cannot approve its own requirements by any route.

<a id="interfaces"></a>
## Interfaces

**CLI**

| Command | Behaviour |
|---|---|
| `specguard change start <capabilities...>` | Writes one record `.specguard/changes/<id>.json`; refuses unknown capability, empty list or unknown `--plan` entry. |
| `change red` / `change green` | Record and judge red and green runs. |
| `change status` | Detects the stage live, with blocks and one next command. |
| `change report` | Builds a provisional local packet. |
| `change done` | Refused unless validated, or forced with a reason. |
| `change abandon` | Needs a reason. |
| `change convert <id> --to feature` | Converts a spike. |
| `specguard enforce raise <capability...> [--to <level>]` | Raises the level; refusals exit 13. |
| `enforce lower <capability...> --to <level> --why <text>` | Lowers the level and records the reason. |
| `enforce show [capability...]` (alias `status`) | Prints level, set or defaulted, certification and whether it can be raised now. |
| `specguard hook pre-tool-use` | Same logic as the bundle, reading stdin. |
| `hook build-index` (alias `index`) | Rebuilds and caches the index. |
| `hook doctor [--json]` | Prints the class of each path or shell command and what the guard would decide. |
| `hook log [--denied]` | Shows recent decisions. |

**MCP tools:** `specguard_change_start`, `_red`, `_green`, `_status`, `_report`. Only status and report are offered when read-only. No tool approves a requirement or closes, converts or abandons a change.

**Hook protocol:** the entry reads a PreToolUse call on stdin and prints one JSON line with exit code 0.

- A deny or ask prints `hookSpecificOutput` with `hookEventName`, `permissionDecision` and a one-line reason.
- An allow with advice prints `additionalContext` and no `permissionDecision`.
- A plain allow prints nothing.

**Files and configuration**

- `.specguard/config.json`
- `.specguard/changes/<id>.json`
- `.specguard/cache/hook-index.json`
- `.specguard/cache/hooks.jsonl` (rolling to `hooks.1.jsonl` past 1 MB)
- Config keys `enforce.default`, `enforce.newCapabilities`, `unrequested.severity` and `hooks.onError`
- Spec frontmatter `enforce:`
- Environment variables `CODEX_THREAD_ID` and `SPECGUARD_HOST_AGENT`
- The packet's first line is the marker `<!-- specguard-proof-packet v1 -->`.

<a id="requirements"></a>
## Requirements

<a id="change-records-and-base"></a>
### Change records and base

- **change-record-contract**: A record is one JSON file named by date, slug and four hex characters. It lists at least one capability and has kind feature, refactor or spike. The contract rejects an id that could leave the changes directory, a record without a capability and an unknown kind.
- **change-ids-and-records**: Ids carry four random hex characters so parallel changes never collide. Records parse strictly, keep fields a newer version added, and serialize to the same bytes every time.
- **base-resolution**: The base is the first that resolves of: explicit flag, record's base, configured base, origin/HEAD, origin/main, main, master. A ref readable as an option is refused. An unusable explicit flag fails instead of falling through.
- **change-base-pinned**: A change started on the branch its base names records the start commit as base, so later commits don't hide the change. An explicit `--base` that doesn't resolve fails.
- **change-start-record**: `change start` writes exactly one record of declared intent (kind, capabilities, why, base ref, start commit, branch, linked plans, nothing about stages or runs). It writes nothing on refusal.

<a id="claims-and-stages"></a>
### Claims and stages

- **changed-claims**: Claims are computed by diffing the spec at base against the current spec. A claim is added, modified (wording, or its Problem & Value changed) or removed (kept with base text). An added or deleted spec file adds or removes all its claims. Edits outside claims change nothing.
- **changed-example-rows**: A row is its own changed ref (rows-added, rows-changed, rows-removed) and the claim is marked modified. A wording-only change lists no row.
- **stages-detected-from-facts**: The stage (spec, tests, red, code, green, validated) is detected from facts, never from the record. It is the first stage whose rule fails, and the status carries the blocks and one next command.
- **stage-locks**: Once code differs from base, a red whose tests or spec were edited afterwards is invalid. The stage falls back to tests with a block naming what was edited. The fix is to record red again.
- **red-acceptance**: A red run counts only if it belongs to the change, matches current spec and test hashes, ran against owned code equal to base, and every added or modified ref has a failing test. An error counts for an added ref (default), for every ref, or for none, per policy. Tests covering no changed ref are ignored.
- **green-acceptance**: A green run counts only if it belongs to the change, matches current spec, test and code hashes, and every test tagged to a changed ref passed. Any later edit makes it stale.
- **refactor-rules**: A refactor changes no requirement. A changed claim blocks it. It needs code, a green run in which every claim test of its capabilities passed, and a CI pass.
- **spike-rules**: A spike follows feature rules for spec, tests and red but can never be validated. Converting it to a feature keeps its trail and lets CI decide.
- **parallel-and-abandoned**: Parallel changes on one branch see the same changed claims and are judged by their own run records. A closed change keeps its closed fields and has no next step.
- **plan-approvals**: A change that links plans gets computed (never written) plan approvals for every changed, non-removed ref of its capabilities, from the newest linked plan. Removed claims, other capabilities and refs without a current hash get none.

<a id="change-commands"></a>
### Change commands

- **change-stages-detected-live**: `change status` gathers facts from git, specs, test tags and run records and moves through the stages as files change. A test or spec edit after red with code present sends it back. A refactor needs no spec, tests or red but fails on a changed requirement.
- **change-record-not-evidence**: Editing a record cannot advance a stage. Red and green are judged from the run records' content, so rewriting a verdict or removing the record changes the stage. A pointer file only names the record.
- **change-red-run**: Runs exactly the tests tagged to added and modified requirements. It runs in the working tree while owned code equals base, otherwise in a constructed tree with current specs and tests and owned code as at base. It never ingests verdicts into the proof ledger, leaves the working tree untouched and removes the temporary tree. It is refused before the spec is approved and tested. A run where a test already passes is recorded as not red.
- **change-green-run**: Refused until red is valid and owned code exists. It records and ingests the passing run (every claim of the capabilities for a refactor), reports a failing run as not green, and leaves the change at validated-pending until CI passes.
- **change-plan-link**: A plan captured while a change is open is recorded on the open changes of the capabilities it affects (or every open change on the branch if recorded against the whole system). It is never recorded on a closed change or one on another branch. A linked plan stands in for approval of the changed requirements.
- **change-close-rules**: `change done` is refused unless validated, or forced with a reason the closed record keeps. `change abandon` needs a reason. A closed record is never edited by a change command.
- **change-spike-convert**: A spike may write code before the spec and is never validated. `change convert <id> --to feature` is refused while there is no changed requirement or any lacks a tagged test, and keeps the trail on success.
- **change-parallel-shared**: Two changes open on one capability and branch warn at start, share changed claims, are judged by their own run records, and a command acting on one needs it named.
- **change-report-local**: `change report` builds a provisional packet locally. It shows changed requirements in plain words with local approval, red-green sensitivity from run records, weakened tests and code changed under no record. It has no per-line unrequested list when no coverage was ingested.
- **change-mcp-tools**: The MCP server offers the five change tools (status and report only when read-only), and no approve, close, convert or abandon tool. Stage rules bind a tool call as they bind the CLI.

<a id="enforcement-levels"></a>
### Enforcement levels

- **enforce-levels**: Levels are observe, warn, enforce (weakest first). A repository whose config sets none treats every capability as observe.
- **enforce-default-observe**: The effective level is the `enforce:` frontmatter, else `enforce.default`, else `observe`. A new capability takes `enforce.newCapabilities`, else the default.
- **enforce-unknown-collected**: An unrecognized `enforce:` value never makes the spec unreadable. It is kept as an unknown key, reported by `enforce show` as ignored, and the capability takes the default.
- **enforce-not-hashed**: `enforce:` is outside every claim hash, so changing it never stales an approval. The only guard on lowering is policy-weakening detection.
- **enforce-lowering-is-weakening**: A lowered level, or one removed so the capability falls below the config default, is an error-level `policy-enforce-lowered` finding naming the capability and claims. Raising, keeping or newly setting is not.
- **enforce-raise-while-certified**: `enforce raise` moves a capability up (default: next level). Moving to `warn` is always allowed. Moving to `enforce` is allowed only while the proof statement is certified, otherwise every named capability is refused with reasons (exit 13) and nothing is written.
- **enforce-lower-recorded**: `enforce lower` needs `--why`, accepts only a lower level, and records a `decision` history entry naming the person, with policy line `enforce lowered: <capability> <from>-><to>` and the reason. `raise` records `enforce raised: ...` the same way.
- **enforce-person-only**: `raise` and `lower` refuse, writing nothing, when an agent without a terminal is detected (the same guard as `spec approve`). A person in a terminal is never refused.
- **enforce-minimal-edit**: The level is a one-line frontmatter edit. An existing line changes in place (a trailing comment is kept), a missing one is added after the last frontmatter line, and everything else stays byte for byte the same apart from the history back-reference.
- **enforce-show**: Prints every capability's level, whether set or defaulted, its certification, and whether it could be raised now.

<a id="proof-packet"></a>
### Proof packet

- **packet-sections**: One markdown comment built only from text already in specs, history and the proof statement. It has a headline and, when they have content, these sections in order:
  1. "What the requirements now say"
  2. "Evidence for changed requirements"
  3. "Capabilities" (always shown, with the four pillars and merge effect)
  4. "Changes"
  5. "Test weakening"
  6. "Code no requirement asked for"
  7. "Pipeline changes"
  8. A collapsed list of fixes
- **packet-verdict**: The verdict is `blocked` when any touched capability blocks, else `advisory` when one warns or a pipeline file changed at error severity, else `no-change` when nothing changed (no requirement change, no owned-code change, no weakening, no pipeline change), else `ready`.
  - A capability passes only when the four pillars of the changed claims are ok, no error-level weakening names it, no unrequested line is an error, no changed file lacks a change, and every covering change passed (a spike counts as not passed).
  - It is `unknown` when the only problems are unknown.
  - An `enforce` capability that is `unknown` or `fail` blocks.
  - A `warn` one that is not `pass` warns.
  - An `observe` one never affects the merge and is shown collapsed.
- **packet-intent-plain**: Each changed requirement is told from its own text, never a model: "now reads: ...", "now reads: ... (was: ...)", "removed (was: ...)". Example rows are described the same way.
- **packet-approval-trust**: Approvals are labelled `verified` (PR review by a named reviewer), `countersigned` (entry added in the PR with a qualifying review), `inherited` (already on base), `self-approved` (no second reviewer), pending (still needs a review) or not approved. Only a verified reviewer is named with a mention.
- **packet-truncation**: A packet over the limit (60,000 characters by default, never above 65,536) is cut deterministically. Tables lose rows from the end in fixed steps and say how many more are in packet.json. The headline, Capabilities table and fixes are kept longest. A packet too large for that falls back to verdict and headline.
- **packet-marker**: The first line is the marker `<!-- specguard-proof-packet v1 -->`, which untrusted text cannot repeat, so CI finds and updates its own comment.
- **packet-digest-stable**: The digest is the sha256 of the packet JSON with keys in stable order. The markdown ends with that digest.
- **packet-no-secrets**: Credentials in spec, test and finding text are masked in markdown and JSON. Pipes, backslashes, backticks, angle brackets, brackets and mentions are escaped. Text is collapsed to one line and capped at 200 characters per cell. The PR author and absolute paths are never printed.

<a id="unrequested-code"></a>
### Unrequested code

- **unrequested-lines**: A changed executable line of an owned file that no test of the change's claims reaches is `unrequested`. One reached only by other claims' tests of the same capability is `incidental`. One with no fresh line data, suite-wide or summarized coverage, or file-level test selection is `unknown` and makes the evidence not claimable. An owned code file changed with no open change covering it is listed as changed without a change.
- **unrequested-severity**: `unrequested.severity` set to `error` fails the capability for an unrequested line (blocking at `enforce`). `warn` only makes the packet advisory. Incidental and unknown lines never block.

<a id="edit-guard-behaviour"></a>
### Edit guard behaviour

- **hook-observe-logs**: At observe, an edit to owned source with no covering change is logged and allowed without a message.
- **hook-warn-names-next-step**: At warn, an edit with no change, or a change that is unapproved or has no valid red, is allowed with a message naming the one next command.
- **hook-enforce-denies-code**: At enforce, owned source is denied when no open change covers it, requirements are unapproved, or there is no valid failing-test evidence. It is allowed once a feature change is approved with valid red.
- **hook-spec-test-free**: Specs and tests are always editable and other files are never guarded, at every level. Edits to config, workflows and CODEOWNERS are allowed with a note that CI reviews them.
- **hook-stage-lock**: A test or spec edit that would invalidate a valid red is allowed with a message that the change is back at red and the command to run again. Red validity is the live value the entry supplies, not the build-time one.
- **hook-agent-bash-guard**: The guard denies an agent's attempt to approve requirements:
  - a history file write whose new text is an approval
  - any edit to a closed change record, or one setting its kind or closed state
  - a Bash command running `spec approve`, `enforce lower`/`raise`, `change convert`, `abandon`, `done` with force, or `proof publish`, in plain, npx, bin and node forms, inside `bash -c`, `eval` and command substitution
- **hook-approval-write-denied**: Shell writes into the history directory and git commands that write the proof notes ref are denied. Reading them and every other git and specguard command is allowed.
- **hook-approval-edit-denied**: Any edit to an approval already on disk (history entry with `kind: approval`) is denied as writing an approval. Other history entries stay editable.
- **hook-strictest-wins**: With several files, each is decided and the strictest verdict wins. A file owned by several capabilities takes the strictest level and needs a change covering all of them.
- **hook-change-kinds**: An open refactor allows code edits at every level in any order. An open spike allows code-first edits, silently at observe and with the cannot-merge message at warn and enforce.
- **hook-codex-patch-paths**: Codex edits are read from `apply_patch` text, so every added, updated, deleted and moved path is guarded like a Claude edit. An "ask" becomes a deny because Codex has no ask.
- **hook-codex-agent-env**: A Codex session (`CODEX_THREAD_ID` set) counts as an agent environment, so the approve and lower guards apply. An explicit `SPECGUARD_HOST_AGENT` wins.
- **hook-messages-short**: Every message shown to the agent is one line of at most 300 characters and contains one command.

<a id="guard-robustness-and-entry"></a>
### Guard robustness and entry

- **hook-fails-open**: A malformed or unknown payload, a missing index part, a path outside the repository or a hook error allows the call (with a CI-still-checks notice when it was an error). The guard never throws.
- **hook-entry-protocol**: The entry answers a PreToolUse call with one JSON line and exit 0. A deny or ask prints `hookSpecificOutput`. An allow with advice prints `additionalContext` and no `permissionDecision`, so it never skips the user's permission prompt. A plain allow prints nothing. The committed bundle and `specguard hook pre-tool-use` print the same bytes.
- **hook-silent-outside-project**: The guard is silent, and reads and writes nothing, in a directory with no `.specguard/config.json`, for a path outside the repository, and for an unguarded tool or event. It finds the project from a subdirectory and treats a symlinked path into the repository as inside.
- **hook-entry-fail-open-message**: An unreadable payload or internal error in a SpecGuard project allows the call with a one-line notice (`ERROR_OPEN`), exits 0 and is logged. The entry never throws.
- **hook-on-error-deny**: With `hooks.onError: "deny"`, an error that stops the guard deciding (such as an unparsable config) in a project with an `enforce` capability denies with `ERROR_CLOSED`. The default is to allow, and an unreadable payload is always an allow.

<a id="index-cache-log-bundle"></a>
### Index, cache, log, bundle

- **hook-index-contents**: The ownership index lists each capability's owned files, spec file, enforce level and source globs, plus the test globs and the specs and history directories. It also lists every open change with kind, capabilities, lock set (test files its red covered), red validity, and whether its changed claims are approved against base. Closed changes are left out and an unparsable record becomes a note, not an error.
- **hook-index-cache**: The index is cached in `.specguard/cache/hook-index.json` under a stat-only fingerprint of config, specs, history files, change records and red records. It is reused while the fingerprint holds, rebuilt in process when a spec, record or config moves, and not rebuilt for a test or source edit (new source files match by glob). A corrupt cache is a miss and writes are atomic.
- **hook-live-red**: On every call the entry re-hashes the locked test files against the red record's tests hash. Editing a locked test invalidates red with no index rebuild, and restoring the file makes it valid again. A red record with no failing test, or one run on code not at base, is never valid.
- **hook-speed**: No model, no network. About 55 ms on a warm index (node start-up included) and under 200 ms when rebuilding for a small repository. The committed test allows a generous second.
- **hook-decision-log**: Every non-silent decision is appended as one JSON line to `.specguard/cache/hooks.jsonl` (time, session, agent, tool, paths, capabilities, level, code, change). The log rolls over to `hooks.1.jsonl` past 1 MB and is never in git.
- **hook-bundle-fresh**: The plugin ships the guard as one committed self-contained file importing only node built-ins. A test rebuilds it from sources and fails if the committed bundle differs. The rebuild depends only on sources, dependency versions and the esbuild version, so hoisted npm, nested npm and pnpm installs produce byte-identical bundles even when invoked outside the repository. Distinct versions of a bundled package remain distinct.
- **hook-commands**: `specguard hook` has `pre-tool-use`, `build-index` (alias `index`), `doctor` (text or `--json`) and `log` (`--denied`).

<a id="end-to-end-guarantees"></a>
### End-to-end guarantees

- **e2e-full-protocol**: Walking a change through the real commands and hook process obeys spec, approval by a person, tests, red, code, green. The guard denies code at `enforce` with no change, then with unapproved requirements, then with no red, and allows it once red is recorded. `change status` shows green and waiting for CI, never validated by itself.
- **e2e-hook-follows-red**: `change red` writes the red evidence the guard reads, in the same file and from the same run record `change status` reads. It holds per-test verdicts, the hashes the run saw and the locked test files, so the guard and stage detection cannot disagree.
- **e2e-agent-cannot-approve**: `spec approve` refuses an agent environment, `history add` refuses approval entries, and the guard denies a hand-written approval file, a change-record rewrite and shell approval forms. None of them moves a change out of the spec stage.
- **e2e-locked-test-edit**: Editing a locked test or a changed requirement after red returns the change to tests and the guard denies code again until `change red` is run anew. That run builds a tree with owned code at base and leaves the working tree as it was. The guard announces the lock when a locked file is edited.
- **e2e-refactor-spike**: A refactor opens only its own capability's code at once and needs no red. A requirement edit under it is reported as changing intent. A spike may write code first but never reaches validated, even with a passing CI verdict, and cannot be closed as done.
- **e2e-parallel-changes**: Two changes on one capability share changed claims and each needs its own red. Any one with valid red opens the code. Closing or abandoning it closes the code again unless the other has red.
- **e2e-certified-needs-ci**: A finished change is `provisional` while its proof is only from local runs and `certified` only from a CI proof note for a clean commit. `enforce raise --to enforce` is refused on the first and accepted on the second, even in a checkout with no local proof. The guard then denies edits made without a change.
- **e2e-hook-latency**: With a change open and red recorded, the guard answers from its cached index in under 200 ms at the median and 500 ms at the 95th percentile per call (spawned process, node start-up included; about 50 ms on a quiet machine), for allow and deny alike.

<a id="code-map"></a>
## Code map

The spec states 24 owned files.

**Sources**

- Core
  - `src/core/change-record.ts`
  - `src/core/change-claims.ts`
  - `src/core/change-base.ts`
  - `src/core/change-stage.ts`
  - `src/core/enforce.ts`
  - `src/core/unrequested.ts`
  - `src/core/proof-packet.ts`
- Hooks
  - `src/hooks/**`
  - `src/hooks/entry.ts`
  - `src/hooks/index-build.ts`
  - `src/hooks/main.ts`
  - `src/hooks/picomatch.d.ts`
  - `scripts/build-hook-bundle.mjs`
- CLI
  - `src/cli/commands/change.ts`
  - `src/cli/commands/enforce.ts`
  - `src/cli/commands/hook.ts`
- Pipelines
  - `src/pipelines/enforce.ts`
  - `src/pipelines/change.ts`
  - `src/pipelines/change-run.ts`
  - `src/pipelines/change-store.ts`
  - `src/pipelines/history.ts`
- MCP: `src/mcp/tools/change.ts`
- Skill: `plugins/specguard/skills/specguard-change/SKILL.md`

<a id="tests"></a>
## Tests

- **Core**
  - `tests/core/contracts-phase3.test.ts`
  - `tests/core/config-phase3.test.ts`
  - `tests/core/change-record.test.ts`
  - `tests/core/change-claims.test.ts`
  - `tests/core/change-base.test.ts`
  - `tests/core/change-stage.test.ts`
  - `tests/core/proof-packet.test.ts`
  - `tests/core/unrequested.test.ts`
  - `tests/core/enforce.test.ts`
  - `tests/core/weakening-enforce.test.ts`
- **Pipelines**
  - `tests/pipelines/enforce.test.ts`
  - `tests/pipelines/change.test.ts`
  - `tests/pipelines/change-run.test.ts`
  - `tests/pipelines/init-codex.test.ts`
- **Hooks**
  - `tests/hooks/decide.test.ts`
  - `tests/hooks/stdin.test.ts`
  - `tests/hooks/entry.test.ts`
  - `tests/hooks/index-build.test.ts`
  - `tests/hooks/bundle-fresh.test.ts`
- **CLI and MCP**
  - `tests/cli/hook.test.ts`
  - `tests/mcp/change-tools.test.ts`
- **End to end**
  - `tests/e2e/change-protocol.test.ts`
  - `tests/e2e/change-guards.test.ts`
  - `tests/e2e/change-evidence.test.ts`

`hook-bundle-fresh` is enforced by `tests/hooks/bundle-fresh.test.ts`, which rebuilds the committed bundle from sources and fails on any difference.

<a id="security-and-data"></a>
## Security and data

- **Agents cannot approve:** approval is person-only. The guard blocks approval writes, edits to on-disk approvals, closed-record edits, and the shell forms of approve, enforce raise/lower, convert, abandon, done with force and proof publish. The MCP server exposes no approving or closing tool. `enforce raise` and `enforce lower` refuse when an agent without a terminal is detected.
- **Proof is not self-reported:** stages come from facts and run-record content, not from the change record. Lowering `enforce:` is flagged as policy weakening. Raising to `enforce` requires certification from a CI proof note.
- **Untrusted text in the packet:** the packet masks credentials, escapes markup and mentions, caps cell length, and never prints the PR author or absolute paths. The marker cannot be repeated by untrusted text.
- **Local data:** the index cache (`hook-index.json`) and decision log (`hooks.jsonl`, `hooks.1.jsonl`) live under `.specguard/cache/`. The log is bounded at 1 MB per file and never in git. The guard uses no network or model.
- **Failure behaviour:** the guard fails open by default (`hooks.onError: "deny"` makes it deny for projects with an `enforce` capability) and is silent outside a SpecGuard project.
- **Git inputs:** base refs that could be read as options are refused.

<a id="extending-it"></a>
## Extending it

The spec defines no extension mechanism, so the notes below follow only from its requirements.

- **Change kinds or fields:** the record contract (`change-record-contract`, `change-ids-and-records`) rejects unknown kinds and parses strictly while preserving fields from newer versions. A new kind has to be added to that contract and to stage detection, the guard's per-kind behaviour (`hook-change-kinds`) and the packet's pass rule.
- **Guard rules:** keep the guard's invariants:
  - no model or network
  - fail open
  - one-line messages of at most 300 characters with one command
  - never throw
  - silent outside a project
  - stable `hookSpecificOutput` and `additionalContext` output
- **Rebuild the bundle:** changing anything under `src/hooks/**` means rebuilding the committed bundle with `scripts/build-hook-bundle.mjs`, or `tests/hooks/bundle-fresh.test.ts` fails.
- **Index inputs:** new inputs to the guard's decisions must be reflected in the index fingerprint and contents (`hook-index-cache`, `hook-index-contents`). Test and source edits deliberately do not trigger a rebuild, and red validity is re-hashed live.
- **Packet changes:** new sections or text must keep the fixed section order, deterministic truncation, the first-line marker, stable-key digest and the escaping and masking rules. Packet text should come only from specs, history and the proof statement.
- **Levels and policy:** enforcement level wording lives in frontmatter and config (`enforce.default`, `enforce.newCapabilities`). `enforce:` stays outside claim hashes, and lowering stays an error-level weakening finding.
- **Tooling surface:** CLI and MCP changes must respect `change-mcp-tools` (no tool that approves, closes, converts or abandons) and apply the same stage rules as the CLI.
- **Evidence:** cover new behaviour with a test that cites its requirement id and is seen failing first, per this capability's own protocol. Place it alongside the existing core, pipeline, hook, CLI, MCP or e2e tests listed above.
