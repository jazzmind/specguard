---
title: "Conformance Testing"
audience: user
source: "specs/capabilities/conformance-testing.md"
generated: true
---
<a id="conformance-testing"></a>
# Conformance Testing

Conformance testing lets a team show, claim by claim, that the current code does what its specs say. It also shows right away when an earlier proof can no longer be trusted.

<a id="why-it-exists"></a>
## Why it exists

A spec is only a claim until something shows the code honours it. Hand-written tests drift from the spec. Tests written by an LLM may assert nothing meaningful. A green run from yesterday says little about the code changed today. Reviewers often can't tell which requirements are really exercised, which only have a similarly named test file, and which proofs have quietly expired.

Conformance testing addresses this in three steps:

- It turns specs into tests.
- It runs your project's own tests with your existing runner.
- It reduces the results to one verdict per claim in a single proof ledger.

Each proof remembers what it was based on: the claim text, the source files and the dependencies. When any of these change, the proof goes stale.

<a id="what-you-can-do"></a>
## What you can do

<a id="generate-tests-from-a-spec"></a>
### Generate tests from a spec

Run `specguard generate --spec <key>` (or `--all`, optionally limited to one app with `--app`).

- Every scenario in the spec becomes one test, titled with the scenario name. The test imports the module the spec declares.
- Choose unit, integration or end-to-end tests with `--type`. The app's own test framework is used unless you override it with `--framework`. End-to-end tests in TypeScript use a browser framework.
- If the spec has claims, each claim's exact tag (`@claim:<spec>#<id>`) must appear in the title of the test that verifies it. If a tag is missing from the output, you get a warning for that claim, and the file is still written.
- An existing test file is never overwritten unless you pass `--force`. Stray Markdown fences in LLM output are removed.
- If the LLM fails for one spec, that failure is recorded and the other specs continue.

`specguard test generate` is the grouped name for the same command. The older `generate` still works.

<a id="tag-tests-with-claims"></a>
### Tag tests with claims

A test says which claim it proves through its title, tags or annotations. These forms are recognised:

- `@claim:<spec>#<id>`
- `[claim: <spec>#<id>]`
- `[claims: a#b, c#d]`

An optional repository prefix is allowed. Every part of SpecGuard reads tags the same way.

<a id="record-proof-from-a-test-run"></a>
### Record proof from a test run

- **In CI:** run your tests with a supported reporter, then run `specguard results ingest report.json`. No LLM call is made. Several report files can be merged in one go. The format is auto-detected, or you can name it with `--format`. You can also give a run id (`--run-id`) and a label (`--run-label`).
- **Locally:** `specguard test run` runs each configured app's tests through its runner and records the verdicts in the same ledger as CI results, in one step.
- **From other systems:** a QA service or manual test tool can submit a verdicts file with `specguard proof ingest`. The file must have a run id and verdicts. Each claim reference must resolve to a real claim, and anything else is reported as failed and not stored. A later submission replaces an earlier one for the same claim.

Supported runners are vitest, jest, Playwright, pytest, any runner that produces JUnit output, go test and cargo test. Results are always read from the runner's report file, never scraped from console output. A team using several languages tags claims the same way for all of them.

Each claim gets one verdict:

- **Failed** if any test tagged to it fails.
- **Proven** if at least one passes and none fail.
- **Unexercised** if no tagged test ran.

A partial ingest only writes verdicts for claims that appear in the results. With the sweep option (`--sweep` or `--unexercised`) on a declared full run (`--full-run`), claims missing from the results are marked unexercised. A claim that is still proven and still matches is never downgraded by the sweep.

<a id="check-what-is-proven-failed-or-stale"></a>
### Check what is proven, failed or stale

- `specguard proof status` lists failed and stale claims.
- `specguard status` shows proof counts.
- `specguard drift` reports each stale proof.

A proof goes stale when any of these change:

- The spec text (or the individual claim, for specs that track claims separately).
- A source file the spec declares as its source.
- The project's dependencies.

Editing one source file therefore stales only the claims of the specs that declare it. A claim with no ledger entry at all is "unproven".

<a id="heal-broken-tests"></a>
### Heal broken tests

After a refactor, run `specguard heal` (or `specguard test heal`).

- Each failing test is classified as either **a test bug** (the test is out of date) or **an application bug** (the code is wrong).
- Only test bugs are rewritten, and the suite is re-run up to the retry budget (`--max-retries`).
- Application bugs are reported with a reason. Application source is never changed.
- `--classify-only` shows the classification without writing or re-running anything.
- A missing or unreadable report counts as a failure even if the runner exited cleanly. Pass `--lenient` to treat that case as passing.

<a id="run-only-some-tests"></a>
### Run only some tests

`specguard test run --claims <refs...>` runs only the tests tagged to the claims you name. It tells you which claims have no tagged test instead of running everything.

- Where the runner can select by exact test title, it does. Titles are passed safely, so quotes, symbols and unicode are never misread.
- Where it can't, the files holding those tests are run. The output says so and marks `selection: files`. A selected test that never shows up in the report reads as `missing`, never as a pass.

<a id="more-control"></a>
### More control

- **Test layers.** Evidence can be kept per layer: `unit`, `integration`, `e2e`, `security` and `functional`.
  - A claim can require certain layers, set per claim, per capability or for the whole project. When layers are required, `check` and `proof status` list each claim not yet proven in every required layer, with a `LAYERS:` summary line.
  - A failure in one layer is not hidden by a pass in another.
  - Setting `proof.enforceLayers` to `fail` makes `proof status` fail on missing layers. The default is `warn`, and `off` hides them.
  - A test's layer comes from, in order: an `@layer:` tag, the app's layer settings, the suite that ran it, `--layer` on ingest, Playwright meaning e2e, folder and file-name conventions, and otherwise unit.
- **Multiple suites per app.** An app can list suites, each with its own command, report and layer, for example vitest for unit and Playwright for e2e. `test run` runs them all, and a failing suite fails only its own layer.
- **Examples tables.** A claim with an examples table gets a proof per row. Editing one row stales only that row's proof. Tests tagged to a row also count once for the parent claim. A parameterized test whose title names exactly one row is attributed to that row. If the title names more than one row, it is attributed to none, and ingest warns `EXAMPLE_TITLE_AMBIGUOUS` without failing.
- **Coverage.** `test run --coverage` adds each app's configured coverage flags and records where the coverage reports are. It does not ingest them. Apps without coverage settings run normally and say so.
- **Run records and evidence.**
  - `test run --record <id>` saves a record of the run: claims, selected tests with verdicts, suites, the commit and a hash of the owned source files.
  - Every ingest writes a run record. `runs list` shows them, and `runs prune --keep N` removes older ones. Nothing is removed automatically.
  - Attachments such as screenshots, videos and traces are picked up from Playwright and JUnit reports and copied into the evidence folder. Use `--no-attachments` to skip copying, and `--max-attachment-mb` (default 200) to set a size limit. Missing or oversized files are skipped with a warning.
- **Partial evidence.** A test marked `partial-claim` is shown separately in reports but never counts toward a claim's verdict or proof.
- **Docker sandbox.** Tests can run inside a Docker sandbox with the repository mounted. If Docker or the image is missing, the run fails clearly and never falls back to running on your machine.
- **Renamed claims.** After a consolidation, results with old claim tags are accepted for one release and recorded under the new claim names.

<a id="what-to-expect"></a>
## What to expect

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Success |
| 2 | A claim failed or is stale, or a results file couldn't be parsed |
| 7 | Healing finished with tests still broken, including application bugs |

`test run` also exits non-zero when a suite fails, when a runner produces no readable report, or when a tagged claim fails, even if the failing test carries no claim tag.

**Each proof row records:**

- Its claim and source-file fingerprints.
- The dependency fingerprint.
- The run id and git revision.
- The evidence location.
- Where it came from: `ci`, `local` or `server`.
- The repository and branch.
- For CI runs, the CI actor, never a developer's git identity.

**Ledger behaviour**

- The ledger location is `--ledger`, then the `paths.proofLedger` setting, then the default `.specguard/proofs.json`.
- Entries use repo-relative paths, so the ledger is portable.
- Concurrent updates don't lose each other's writes.
- A ledger written by a newer SpecGuard is refused rather than read as empty and overwritten.

**Evidence paths:** an evidence location is kept only if it stays inside the repository. Absolute paths, paths that climb out, and symlinks that leave are dropped with a message. The verdict itself is still kept.

**Agentic and manual evidence:** this evidence can only prove the `functional` layer. A verdict from either source with no layer is recorded as `functional`. Submitting it for another layer fails that row with a clear message, and nothing is stored. A required non-functional layer proven only by such evidence stays missing.

**Staleness checks:** the default check lets an LLM judgement of "unaffected" keep a proof fresh. A deterministic check (`deterministic: true`) uses hashes alone, so any change to an owned file stales the proof.

**Unparseable input:** a report that can't be read is reported as a named error, not treated as an empty result.

**Data handling**

- Test commands come from your repository's configuration and run with your or CI's privileges. Use the Docker sandbox if the code isn't trusted.
- Generate and heal send test code, spec text and failure messages to the LLM, subject to your redaction settings. Heal writes only test files.
- Verdict files from external systems are checked against a schema, and unknown claim references are rejected.
- The ledger holds hashes, counts and relative paths, never secrets.

**Not covered**

- Replacing your test runner or CI system.
- Judging the running system in a browser (see agentic verification).
- Detecting drift between source and specs (see traceability and drift).
- Repairing application source code.
