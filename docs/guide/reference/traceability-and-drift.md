---
title: "Traceability and Drift"
audience: user
source: "specs/capabilities/traceability-and-drift.md"
generated: true
---
<a id="traceability-and-drift"></a>
# Traceability and Drift

Traceability and Drift shows how each spec relates to its code, tests, docs and proof. It tells you when code and specs stop agreeing. You can run it at any time, and it gives the same answer for the same inputs. The output is meant for CI: stable exit codes, plus JSON files under `.specguard/`.

<a id="why-it-exists"></a>
## Why it exists

Code changes faster than the documents that describe it. Without a continuous answer to "which spec owns this file, which tests cover this requirement, and has the code moved since the spec was written?", specs rot quietly and tests stop meaning anything. Reviewers and auditors can't tell whether a requirement is implemented, tested, or only written down.

<a id="what-you-can-do"></a>
## What you can do

<a id="see-what-lacks-a-spec-or-a-test-specguard-status"></a>
### See what lacks a spec or a test: `specguard status`
- For every configured app, see how many source files have an owning spec and how many have a test. Files without a spec are listed.
- Test files are never counted as source files that need their own spec.
- A spec counts as tested if a test carries one of its claim tags, or a test file matches its name. The claim tag takes precedence.
- If a proof ledger exists, a proofs summary is appended. It never affects the exit code.
- An app with no matching source files is not an error.

<a id="export-a-traceability-table-specguard-matrix"></a>
### Export a traceability table: `specguard matrix`
- Lists every spec with its title and its linked test files, doc files and source files.
- Each entry lists its claims and the tests that carry each claim's tag in their title, tag or annotation. A test file that carries a claim tag is listed even if its name doesn't match the spec.
- Output is JSON by default, or CSV with `--format csv`. Use `--out <path>` to choose the location and `--app <name>` to limit it to one app.
- Tests are found from your configured test output, test source globs and extra test sources.

<a id="find-what-isn-t-built-yet-specguard-gap-analysis"></a>
### Find what isn't built yet: `specguard gap-analysis`
- Classifies each spec as **unimplemented** (no owning source), **partial** (source exists but some criteria are unchecked) or **implemented**. Test files don't count as source here.
- Use `--spec <key>` to look at one spec, and `--no-plan` to skip plan generation.
- Every run writes `.specguard/gaps.json`. When any gap exists, it also writes a summary plan that a coding agent can read.
- Implementation plans are generated only for unimplemented specs, and never with `--no-plan`. If the LLM fails, the run still completes.

<a id="find-what-tests-don-t-exercise-specguard-align"></a>
### Find what tests don't exercise: `specguard align`
- Settles claims and scenarios first from claim tags and from scenario names in test titles. Only what remains uncovered, along with the tests that plausibly relate to it, goes to the LLM.
- A spec with nothing left uncovered makes no LLM call and scores 100.
- Results record covered and uncovered claims per spec. Progress is saved to `.specguard/alignment.json` after every spec.
- Options: `--app`, `--spec`, `--all`, `--concurrency <n>`, `--fresh`, `--extra-tests <globs...>`.

<a id="detect-drift-specguard-drift"></a>
### Detect drift: `specguard drift`
- Drift keeps a registry of a content hash for each source file. If a file's hash is unchanged, it is skipped with no LLM call. If it changed, the LLM is asked whether the change affects the spec.
- A changed source file with no spec counts as drift. Specs with no matching source are reported as orphans.
- On the first run, or with `--mtime`, it compares source and spec modification times instead, and still builds the registry. `--force` re-checks every file regardless of hash.
- `--since <ref>` limits the check to changes since a git ref such as `main`. If git isn't available (for example on a shallow clone), you get a warning and all configured sources are scanned.
- A stored proof whose recorded spec hash or file hash no longer matches is also reported as drift.
- For v2 specs, a claim's fingerprint covers only that claim's text and the Problem & Value section. Editing other claims, scenarios, frontmatter or history doesn't make a proof stale. Changing Problem & Value does.

<a id="one-combined-view-specguard-check"></a>
### One combined view: `specguard check`
`check` is a single command that gives the same results as the older commands. `status`, `gap-analysis`, `drift`, `matrix` and `align` still work as aliases.

- The system is modelled as capabilities and their claims. `--coverage`, `--gaps` and `--matrix [--csv]` show different views of it, and the whole picture is written to `.specguard/trace.json`.
- Drift runs per capability across all of its source files and reports at claim level. Large diffs are filtered, ranked with interface-like files first, and split into chunks of about 40k characters. An oversized file is reduced to its headers and declarations. Each capability has a cap, and whatever exceeds it is reported for manual review.
- On its first run, a capability is taken as the baseline. After that only files whose content changed are assessed. Lockfiles and build output are skipped without a model call. If no verdict comes back, every claim is treated as affected. Changed files that no capability owns are reported.
- A proof goes stale for a changed file only if no assessment covers that exact file version, or an assessment names the claim. A changed file nobody assessed makes every claim of its capability stale.

<a id="read-the-proof-statement"></a>
### Read the proof statement
The summary opens with a `STATEMENT:` line for each capability and one for the whole system. Each capability is judged on four pillars, each `ok`, `fail` or `unknown`:

| Pillar | Question it answers |
|---|---|
| **Approved** | Has a person approved each claim and example row at its current wording? |
| **Testable** | Do the claims pass the testability lint, and does the capability have anchored claims? |
| **Aligned** | Does coverage show the owned code is reached by the claims' tests, and for a changed claim, is the change specified? |
| **Conforms** | Do the proof ledger, required layers, example rows, test strength, mutation sensitivity and assurance level hold? |

A planned capability is judged on Approved and Testable only.

Every reason has a code, a message and a command that fixes it. Approval is kept separate. An unapproved claim with a passing proof still counts as proven, and approval never makes a proof stale or failed.

A capability's overall level is:
- **Certified** at a commit: all four pillars are `ok`, all evidence was earned in CI, the commit is known, and none of the capability's input files has uncommitted changes.
- **Provisional**: all four pillars are `ok`, but some evidence is local or from a server, or an input file is dirty.
- **Not certified**: anything else.
- **Planned**: the capability is planned.

The system is certified only when every non-planned capability is certified and no source file is unowned.

Evidence your repository doesn't have (no ledger, coverage, mutation report, base ref or git checkout) shows as `unknown`, never `fail`.

With `--since <ref>`, each claim is classified as added, modified or unchanged against that ref. The statement also reports any policy that the change relaxed: spec `layers`, `assurance` or `evidence` frontmatter, config gates, or weakened tests. Without a base ref no change is judged. If the ref doesn't resolve, you get a warning and no change judgement.

<a id="decide-what-blocks"></a>
### Decide what blocks
Pillar results never depend on policy. The `proof.require*` settings (approval, testable, strength, sensitivity, conforms, alignment, ci) and `proof.strict` only decide which reasons count as **blocking**. All are off by default. `strict` turns them all on, with `enforceLayers` at `fail`. A reason that can never block (such as a capability that owns no files, or an intent gap) never does.

- `specguard check --strict` applies every gate for that run without changing your config.
- `specguard check --explain <capability>` prints that capability's pillars, its blocking reasons first with the fix for each, then advisory reasons and the stated limits of the evidence. It exits 13 if that capability has a blocking reason and 0 otherwise. For an unknown id it exits 1 and names the known capabilities.
- `--json` gives the statement in a stable JSON shape.

A repository that uses none of these features sees the same `check` lines and exit codes as before. Its statement reads "not certified" with the exact reasons (for example no approvals recorded, no coverage evidence, strength not analysed), nothing blocks, and the statement adds exit code 0.

<a id="build-a-shareable-report-specguard-report"></a>
### Build a shareable report: `specguard report`
- Writes a self-contained folder with `index.html` (inline styles and scripts, evidence copied beside it) and `report.json`.
- It covers one run (`--run`, default the latest) and shows:
  - totals by layer
  - a capability and claim table with per-test status, duration and attachments
  - a comparison with a baseline (`--baseline`; by default the previous run with the same label, otherwise the previous run), listing newly failing, newly proven, newly unexercised, removed and flaky items
  - a gap analysis (untested, linked-not-executed, weak-only, partial, failed, proven) with a ranked top-gaps list
- All test text is escaped in the HTML.
- `report --workspace` builds a report for every non-ignored repo in the workspace manifest, plus a top-level index and `workspace-report.json`. Per repo it shows the latest run, tests, claims proven or failed, a claim-status bar, change since baseline, evidence counts and a short run history, with totals across repos. A repo with no recorded run or a broken config is listed with its error and doesn't stop the others. Extra links can be added in `.specguard/report-links.json`.
- A team server can render the same workspace rollup from report data that clients publish, without reading any repo.

<a id="what-to-expect"></a>
## What to expect

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Internal error (or unknown capability in `--explain`) |
| 2 | Spec rule violations (`check`) |
| 3 | Drift detected |
| 4 | Missing specs or gaps present |
| 13 | Not certified: a blocking statement reason under an enabled `proof` gate |

- `status` exits 4 when any source file lacks a spec, otherwise 0. It never calls the LLM and never writes files.
- `gap-analysis` exits 4 when any gap exists, otherwise 0.
- `drift` exits 3 when any spec has drifted. The summary reads `drift: <N> spec(s) drifted`.
- `matrix` is informational and always exits 0. It prints how many entries were written.
- `check` exits 2 on spec rule violations. It exits 4 when a source file has no owning spec, or when a non-planned capability owns no files. Otherwise it exits 13 if the statement has a blocking reason, and 0 if not. Codes 2, 3 and 4 take precedence over 13. With every gate off, the statement never changes the exit code. Under a gate that is on, an unapproved claim, a lint failure, a skipped or assertion-free test, local-only evidence, or a changed claim without sensitivity evidence each produce exit 13 with the reason listed.

**Ordering of blocking reasons.** They are ordered by pillar (Approved, Testable, Aligned, Conforms), then failures before unknowns, then capability-level before claim-level, then spec order. A capability's headline names the count and the first two.

**Files.** Results are written only under `.specguard/`:
- `drift-registry.json`
- `gaps.json`
- `plans/<feature>.md` and `plans/gap-analysis-<timestamp>.md`
- `alignment.json`
- `traceability.json` (the location is configurable via `matrix.output`)
- `trace.json`

**Also available.** The MCP tools `specguard_status`, `specguard_drift`, `specguard_matrix`, `specguard_gap_analysis` and `specguard_check` offer the same capabilities. `specguard_check` accepts `explain`, `strict` and `since`. A saved check trace records the tool's name, package version and Node version. Older traces without this are treated as having an unknown engine version.

**Privacy and limits**
- The drift registry stores hashes, timestamps and verdicts, never file content or credentials. It uses repo-relative paths, so it can be committed and compared across machines.
- Hashes detect change. They are not a guarantee against a deliberate attacker.
- Diffs and spec excerpts sent to the LLM follow your configured redaction. LLM keys are referenced by environment variable name only and never appear in plans, `gaps.json` or the registry.
- Output reveals spec and test names, so treat the output folder as internal.

**Not covered here:** running tests or recording proof verdicts, judging the running system in a browser, writing or rewriting specs, and serving the matrix over HTTP. Each has its own capability.
