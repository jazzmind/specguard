---
title: "Conformance Testing (developer reference)"
audience: dev
source: "specs/capabilities/conformance-testing.md"
generated: true
---
<a id="conformance-testing"></a>
# Conformance Testing

<a id="purpose"></a>
## Purpose

Conformance testing lets a team show, claim by claim, that the current code delivers what the specs say, and see immediately when a proof can no longer be trusted.

It does this in three steps:

1. It turns spec scenarios into tests whose titles carry claim tags.
2. It runs the project's own test suite through whatever runner the project uses.
3. It reduces the results to one verdict per claim in a single proof ledger.

Each proof records what it was based on: the claim text, the source files and the dependencies. It goes stale as soon as any of them change. Failing tests are triaged into "the test is wrong" and "the application is wrong", and only the first is ever repaired automatically.

<a id="responsibilities"></a>
## Responsibilities

- **Generate** tests from spec scenarios, with claim tags in the titles.
- **Run** tests through runner adapters (vitest, jest, playwright, pytest, JUnit-producing runners, go, cargo). Results are read from the reporter's output file, never from stdout.
- **Normalise** reporter output into one result shape and reduce it to claim verdicts.
- **Record** verdicts in the proof ledger, with the basis (hashes, dependency fingerprint, provenance, evidence) needed to compute staleness.
- **Report** failed, stale and incomplete proofs, including per-layer proof.
- **Heal** failing tests by classifying each failure as a test bug or an application bug, rewriting only test code.
- **Index** runs and evidence (`.specguard/runs/`, `.specguard/evidence/`).
- **Select** exact tests per claim (`test run --claims`).

Out of scope:

- Replacing the test runner or CI system.
- Judging the running system in a browser (see agentic-verification).
- Detecting drift between source and specs (see traceability-and-drift).
- Repairing application source (see security-and-remediation).

<a id="interfaces"></a>
## Interfaces

<a id="cli"></a>
### CLI

- `specguard generate [--spec <key>] [--all] [--app <name>] [--framework <name>] [--force] [--type unit|integration|e2e]`
- `specguard heal [--spec] [--all] [--app] [--max-retries <n>] [--classify-only] [--lenient]`
- `specguard results ingest <file...> [--format auto|vitest|jest|playwright|junit|pytest|go|cargo] [--run-id <id>] [--unexercised|--sweep] [--full-run] [--ledger <file>]`

  Further flags described in the requirements: `--layer`, `--run-label`, `--max-attachment-mb`, `--no-attachments`.
- `specguard proof ingest <verdicts> [--ledger <file>]`
- `specguard proof status [--ledger <file>]`
- `specguard test generate | run | heal`. The older `generate` and `heal` names keep working.
  - `test run` options described in the requirements: `--claims <refs...>`, `--coverage`, `--record <id>`.
- `specguard runs list` and `specguard runs prune --keep N`
- `specguard status`, `specguard drift` and `specguard check` also surface proof information (see Requirements).

<a id="mcp-tools"></a>
### MCP tools

`specguard_generate`, `specguard_heal`, `specguard_results_ingest`, `specguard_proof_ingest`, `specguard_proof_status`.

<a id="files-and-configuration"></a>
### Files and configuration

- Ledger: `.specguard/proofs.json`, or `paths.proofLedger` (workspace root when a workspace file exists). The `--ledger` flag takes precedence.
- Per-app config: `test: { command, cwd, reporter, resultsFile, timeoutMs, image }`, plus `test.layers`, `test.suites` and `test.coverage`.
- Heal config: `heal.maxRetries`, `heal.testCommand`.
- Proof config: `proof.requiredLayers`, `proof.enforceLayers` (`fail`, `warn` (default) or `off`).
- Capability frontmatter: `layers:`.
- Run records: `.specguard/runs/<runId>.json`. Evidence: `.specguard/evidence/<runId>/…`.
- Migration file: `.specguard/claim-migration.json`.

<a id="claim-tag"></a>
### Claim tag

`@claim:<specKey>#<claimId>`. See `claim-tag-forms` for the other accepted forms.

<a id="exit-codes"></a>
### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 2 | Failed or stale claims, or unparseable results |
| 7 | Heal failed (tests still broken) |

`test run` also exits non-zero in the cases listed under `test-run-fails-honestly`.

<a id="requirements"></a>
## Requirements

<a id="generation"></a>
### Generation

- **generate-per-scenario**: Generation turns every scenario of a spec into one test block titled with the scenario name, importing the module the spec declares, for a single spec or all specs and optionally limited to one app.
- **generate-test-types**: Generation supports unit, integration and end-to-end test types, uses the owning app's framework unless overridden, and uses a browser framework for end-to-end tests in TypeScript.
- **generate-claim-tags**: When a spec has claims, the generation prompt lists each claim with its exact tag and requires it in the verifying test's title. Generation warns about every claim whose tag is missing from the output while still writing the file.
- **generate-safe-writes**: Generation never overwrites an existing test file unless forced, strips stray Markdown fences from LLM output, and records an LLM failure for one spec without stopping the others.
- **framework-profiles**: Framework detection recognises common web, API and CLI frameworks from the repository's manifests, falls back to a generic profile and honours an explicit entry-point override.

<a id="claim-tags-runners-and-results"></a>
### Claim tags, runners and results

- **claim-tag-forms**: A claim tag is recognised in the forms `@claim:<spec>#<id>`, `[claim: <spec>#<id>]` and `[claims: a#b, c#d]`, in titles, tags and annotations, with an optional repository prefix. All consumers read tags through the same logic.
- **runner-adapters**: Tests are run through a runner adapter for vitest, jest, playwright, pytest, any JUnit-producing runner, go and cargo. Results are always read from the reporter's output file, never scraped from stdout.
- **runner-invocation**: Adapters inject the reporter flags the runner needs (with a single separator for npm scripts), run the command verbatim when a results file is configured, pass a test selection as file arguments, merge a results glob, and kill a run that exceeds its timeout. They can run inside a Docker sandbox with the repository mounted. A missing Docker or image is a clear failure that never falls back to the host.
- **normalised-results**: Reporter output of every supported format is normalised into one result shape covering passes, failures and skips. The format can be auto-detected. Unparseable input is a named error rather than an empty list.
- **claim-verdict-rule**: A claim's verdict is failed when any tagged test fails, proven when at least one passes and none fail, and unexercised otherwise, with counts of exercised tests and counterexamples.
- **old-claim-tags-accepted**: After a consolidation, results that still carry old claim tags are accepted for one release through `.specguard/claim-migration.json` and recorded under the new claim refs.

<a id="ledger-and-staleness"></a>
### Ledger and staleness

- **ledger-verdict-states**: The proof ledger stores proven, failed, unexercised and error verdicts. Stale is computed and never stored. Unproven means the ledger has no row for the claim.
- **stale-rule**: A proof is stale when the spec (or, for v2 specs, the claim) hash changed, when a source file recorded at ingest changed on disk, or when the repository's dependency fingerprint changed. A file that vanished from the registry alone does not make it stale.
- **ledger-records-basis**: Each stored row records the claim hash, the source file hashes taken from the spec's declared sources, the dependency fingerprint, the run id, the git revision and the evidence path. Editing one source file therefore stales exactly the claims of the specs that declare it.
- **proof-provenance**: Each proof row records its provenance: `origin` (`ci` on a GitHub Actions or other CI run, `local` otherwise, `server` for a server-side run), repository, branch, CI actor (never a developer's git identity) and the claim-hash version in force. Ledger writes go through one store interface (a file by default) that serialises concurrent updates so none is lost. A ledger written by a newer SpecGuard is refused rather than read as empty and overwritten.
- **proof-evidence-kind**: A proof records what produced it: a test run leaves `evidence` unset and an agentic browser run records `agentic`.
- **evidence-path-inside-repo**: An evidence path is recorded only when it stays inside the repository, normalised and relative. An absolute path, one that climbs out, or a symlink that leaves is dropped with a message, and the verdict itself is kept.
- **deterministic-walk**: A deterministic walk (`deterministic: true` on the proof options) judges every proof by hashes alone. It never consults the LLM drift assessments, so any changed owned file stales the proof. The default walk still lets an assessment of "unaffected" keep a proof fresh.

<a id="ingest"></a>
### Ingest

- **ingest-validation**: Ingesting verdicts rejects a file without a run id or verdicts. It fails, and does not store a verdict for, an unparseable reference, missing spec or unknown claim. A later ingest replaces an earlier row.
- **results-ingest**: `results ingest` merges several report files before aggregating, detects or accepts an explicit format, accepts a run id, records a repo-relative evidence path, and exits 2 when any claim failed or a file could not be parsed.
- **partial-and-sweep**: A partial ingest only writes verdicts for claims present in the results. The sweep option stores unexercised for absent claims only on a declared full run, and never downgrades a still-matching proven claim.
- **shared-ingest-and-ledger-path**: `proof ingest` and `results ingest` share one code path, write identical rows for identical verdicts, and use a ledger path from `--ledger`, then `paths.proofLedger`, then `.specguard/proofs.json`, kept portable with repo-relative keys.
- **proof-reporting**: `proof status` lists failed and stale claims and exits 2 when any exist. `status` shows proof counts without changing its exit code. `drift` reports each stale proof.

<a id="heal"></a>
### Heal

- **heal-classifies-failures**: Healing runs one job per distinct test command, classifies each failing test as a test bug or an application bug, rewrites only test code and re-runs up to the retry budget, and never modifies application source.
- **heal-exit-and-safety**: Healing treats a missing or unparseable report as a failure even when the runner exited 0 unless told to be lenient. It exits 7 while any test remains broken, including application bugs. With classify-only it never writes or re-runs.

<a id="test-command-group"></a>
### `test` command group

- **test-run-ingests**: `test run` runs each configured app's tests through its runner adapter, reads the report from the file the runner writes, and ingests the verdicts into the proof ledger in one step, so tests run locally and results produced by CI land in the same ledger.
- **test-run-fails-honestly**: `test run` exits non-zero when a suite fails, when a runner produces no readable report, or when a tagged claim fails, even if no failing test carries a claim tag.
- **test-command-group**: `test generate`, `test run` and `test heal` group the test commands. The older `generate` and `heal` names keep working.
- **coverage-flags-recorded**: `test run --coverage` appends each app's `test.coverage.flags` to the test command and records the configured report paths (and format) in the run output and run record, without ingesting them. An app with no `test.coverage` runs without coverage and says so.
- **run-record-owned-hash**: `test run --record <id>` writes `.specguard/runs/<id>.json` with the run id, start and finish times, claims, selected tests with per-test verdicts, suites, head commit and `ownedSourceTreeHash`. That hash covers the owned source files' contents. It changes when an owned file is edited or added, and not when an unowned file changes.

<a id="layered-proofs"></a>
### Layered proofs

- **layered-proofs**: Evidence is kept per test layer (`unit`, `integration`, `e2e`, `security`, `functional`). Each claim's ledger row holds one entry per layer with its own staleness inputs. The row's combined fields come from the layer that decides it (a failure in any layer, else the newest proof). A failing browser check is therefore not overwritten by the next passing unit run, and the other way round. A row written before layers existed reads as one layer (`functional` when the browser check wrote it, else `unclassified`). A project that requires no layers sees exactly the old verdicts.
- **layer-classification**: A test's layer is the first of:
  1. an `@layer:` tag on the test, or a `[layer: x]` comment in the first lines of its file;
  2. the app's `test.layers` globs;
  3. the suite that ran it;
  4. `results ingest --layer`;
  5. Playwright, which means `e2e`;
  6. path conventions (`e2e`, `integration`, `security` folders and `.e2e.`/`.int.` file names);
  7. otherwise `unit`.
- **layer-requirements**: A capability's `layers:` frontmatter (a list for every claim, or a default plus per-claim lists) and the project's `proof.requiredLayers` say which layers a claim needs: the claim's own list first, then the capability's default, then the project's. An unknown layer name is reported, not ignored.
- **layer-ingest**: `results ingest` writes one verdict per claim and layer. An unclassified `unexercised` sweep row replaces the whole row. Classified evidence replaces unclassified evidence of the same tests, so an old failure cannot outlive its fix. `test run` ingests each suite's report with the suite's layer.
- **layer-reports**: When layers are required, `check` and `proof status` list `[proof-incomplete] <claim> (missing: <layers>)` for each claim not proven in every required layer, and print a `LAYERS:` line with proven over required per layer. The `PROOFS:` line is unchanged. `proof.enforceLayers: fail` makes `proof status` fail on them (`warn` is the default, `off` hides them). The trace carries `required`, `layers` and `missing` per claim, and `layerCounts` per capability and in total.
- **layer-suites**: An app's `test.suites` lists suites that each have a command, a report and a layer (for example vitest for `unit` and Playwright for `e2e`). `test run` runs every suite in place of the app's single command. A failing suite fails only the layer it covers, and each suite's report is ingested with its layer.
- **nonautomated-evidence-functional-only**: Agentic and manual evidence can only prove the `functional` layer. Ingesting an `agentic` or `manual` verdict for any other layer fails that row with a clear message and stores nothing. A verdict with that evidence and no layer is recorded as `functional`. A required non-functional layer whose only proof came from such evidence stays missing.

<a id="example-rows"></a>
### Example rows

- **row-proofs**: A claim with an examples table has a proof per row, stored under `specKey#claim/row` with the row hash in `claimHash`. Ingest resolves a row ref against the claim's table and fails a row that is not in it. The proof walk visits each row after its claim and judges it against the row hash, so editing a row cell stales only that row's proof. A spec with no tables is walked exactly as before.
- **row-aggregation**: A result tagged `cap#claim/row` counts for the row and also, once, for the parent claim. A parameterized test tagged `cap#claim` whose title names exactly one row id of that claim is also attributed to that row.
- **example-title-ambiguity-warning**: A parameterized test whose title names more than one row id of its claim is attributed to no row, and `results ingest` warns `EXAMPLE_TITLE_AMBIGUOUS` without failing.

<a id="targeted-runs-and-title-selection"></a>
### Targeted runs and title selection

- **claims-run-exact-tests**: `test run --claims <refs...>` runs exactly the tests tagged to the given claim refs (found through the claim-test index), selecting them by title where the runner can. It reports which claims have no tagged test instead of running the whole suite.
- **claims-files-fallback**: When the runner cannot select by title (or a tagged test has no title the runner can be given), `test run --claims` runs the files that hold the tests, says so, and flags `selection: files` in the run output and the run record. A report row that names none of the selected tests reads `missing`, never pass.
- **title-selection-per-runner**: Each runner selects tests by exact title:
  - vitest and jest with `-t`;
  - Playwright with `--grep` (an escaped, end-anchored regex alternation);
  - pytest with `-k`;
  - go test with an anchored `-run`;
  - cargo with name filters after `--`;
  - JUnit through Maven `-Dtest=Class#method` or Gradle `--tests`, from the declaration's class and method.
- **title-selection-safe-quoting**: A title is passed to the runner as one literal argument. Regex metacharacters, quotes, unicode and shell syntax are escaped or quoted and never interpolated. A list too long for one command line, or an argument the shell cannot be given, yields unknown.
- **title-unsupported-unknown**: A runner that cannot select by title, or a title it cannot express (a pytest, go or cargo name that is not an identifier, a Java test without a known class and method, an empty list), yields `undefined` from `titleFlags`. That means unknown, which callers treat as files or the whole suite, never as a pass.

<a id="evidence-run-index-and-partial-evidence"></a>
### Evidence, run index and partial evidence

- **test-attachments**: `results ingest` reads test attachments (Playwright `attachments[]` with a path, JUnit `[[ATTACHMENT|path]]` lines and `attachment` properties). It resolves relative paths against the report's directory, then the working directory. It copies each existing file into `.specguard/evidence/<runId>/<sha256-16>-<basename>` once: duplicates are skipped, and missing files and files over `--max-attachment-mb` (default 200) are skipped with a warning. `--no-attachments` copies nothing. Ledger rows gain optional `runLabel` and `tests[]` (title, file, status, duration, attachment paths), and a ledger written before these fields still loads.
- **run-index**: Every ingest has a run id (`--run-id`, else an ISO timestamp with a short random suffix) and an optional `--run-label`. It writes `.specguard/runs/<runId>.json` with the run's tests, per-claim verdicts (combined and per layer) and attachments. `runs list` prints the runs. `runs prune --keep N` removes older indexes and evidence that no kept run or ledger row refers to. Nothing is rotated automatically.
- **partial-claim-evidence**: A Playwright annotation or JUnit property named `partial-claim` marks a test as partial evidence for a claim. The test's verdict and media are recorded in the run index (`partialClaims`) and shown separately in the report, but never counted in the claim's verdict or proof. A claim the same test also proves outright is not listed as partial.

<a id="code-map"></a>
## Code map

Owned files: 24.

| Area | Files |
|---|---|
| Claim tags and migration | `src/core/claim-tags.ts`, `src/core/claim-migration.ts` |
| Result normalisation | `src/core/test-results.ts` |
| Layers | `src/core/test-layers.ts` |
| Ledger, provenance, state | `src/core/proof-ledger.ts`, `src/core/provenance.ts`, `src/core/state/ledger-store.ts`, `src/core/state/lock.ts`, `src/core/dependency-fingerprint.ts` |
| Evidence | `src/core/evidence.ts` |
| Framework detection | `src/core/framework-profiles.ts` |
| Runner adapters | `src/adapters/test-runners.ts` |
| Pipelines | `src/pipelines/forward-generate.ts`, `src/pipelines/heal.ts`, `src/pipelines/results.ts`, `src/pipelines/runs.ts`, `src/pipelines/proof.ts`, `src/pipelines/test-run.ts` |
| CLI commands | `src/cli/commands/generate.ts`, `heal.ts`, `results.ts`, `proof.ts`, `runs.ts`, `test.ts` (all under `src/cli/commands/`) |

<a id="tests"></a>
## Tests

- `tests/core/claim-tags.test.ts`
- `tests/core/state-stores.test.ts`
- `tests/core/test-results.test.ts`
- `tests/core/framework-profiles.test.ts`
- `tests/adapters/test-runners.test.ts`
- `tests/adapters/test-runners-title.test.ts`
- `tests/pipelines/forward-generate.test.ts`
- `tests/pipelines/heal.test.ts`
- `tests/pipelines/results.test.ts`
- `tests/pipelines/proof.test.ts`
- `tests/pipelines/test-run.test.ts`
- `tests/pipelines/test-run-claims.test.ts`
- `tests/mcp/ingest-tools.test.ts`
- `tests/fixtures/results/**` (sample reporter output)

<a id="security-and-data"></a>
## Security and data

- **Test commands** come from the repository's own configuration and run with the developer's or CI's privileges. The Docker sandbox option (`test.image`) isolates them when the code is not trusted. A missing Docker or image fails clearly and never falls back to the host.
- **LLM exposure**: `generate` and `heal` send test code, spec text and failure messages to the LLM, subject to configured redaction. `heal` only ever writes test files.
- **External verdict files** are untrusted input. They are schema-checked, every claim reference must resolve to an anchored claim, and unknown references are rejected rather than stored.
- **Ledger contents**: hashes, counts and relative paths, never secrets. Keys are repo-relative so the ledger is portable.
- **Evidence paths** must stay inside the repository (see `evidence-path-inside-repo`).
- **Provenance** records the CI actor, never a developer's git identity.
- **Ledger safety**: concurrent writes are serialised, and a ledger written by a newer SpecGuard is refused rather than overwritten.
- **Non-automated evidence** (agentic or manual) can only prove the `functional` layer.

<a id="extending-it"></a>
## Extending it

The requirements imply the following extension points. Check the named files before changing anything.

- **Supporting another runner or report format**
  - Add an adapter in `src/adapters/test-runners.ts`. It must inject the reporter flags the runner needs and read results from the reporter's output file, not stdout.
  - Add parsing in `src/core/test-results.ts` so the format normalises into the shared result shape. Unparseable input must be a named error, not an empty list.
  - If the runner can select by exact title, implement `titleFlags` with safe literal quoting. If it cannot, or cannot express a title, return `undefined` (unknown) so callers fall back to files or the whole suite.
- **Recognising a new tag form:** change `src/core/claim-tags.ts` only. All consumers must read tags through that one piece of logic (`claim-tag-forms`).
- **Adding or changing layers:** layer names and classification live around `src/core/test-layers.ts`. Keep the classification order in `layer-classification`, and keep unknown layer names reported rather than ignored.
- **Changing what makes a proof stale:** the basis recorded per row (`ledger-records-basis`) must stay in step with the rule in `stale-rule`. A new staleness input has to be recorded at ingest. Ledger rows written before the change must still load, as with the optional fields added for attachments and layers.
- **Changing ledger storage:** go through the store interface in `src/core/state/ledger-store.ts`. It must keep serialising concurrent updates and refusing a ledger from a newer SpecGuard.
- **Adding an ingest source:** reuse the shared ingest path so rows stay identical for identical verdicts (`shared-ingest-and-ledger-path`), and apply the validation in `ingest-validation`.
- **Heal:** keep the invariants that only test code is rewritten, application bugs are reported but never changed, and a missing or unparseable report counts as failure unless lenient.
