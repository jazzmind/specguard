---
id: coverage-and-mutation
kind: capability
title: Coverage and Mutation Evidence
parent: system
value: A reviewer can see which owned code the tests execute and whether a claim's tests would notice the code changing, with every number carrying what it cannot prove and a mark when the code has moved on since it was measured.
status: active
sources:
  - "src/core/coverage.ts"
  - "src/core/mutation.ts"
  - "src/pipelines/coverage-ingest.ts"
  - "src/pipelines/mutation-ingest.ts"
  - "src/cli/commands/coverage.ts"
  - "src/cli/commands/mutation.ts"
docs: []
history:
  - 2026-10-26-coverage-and-mutation-evidence-is-attrib
tests:
  - "tests/core/coverage.test.ts"
  - "tests/core/mutation.test.ts"
  - "tests/pipelines/coverage-ingest.test.ts"
  - "tests/pipelines/mutation-ingest.test.ts"
---

# Coverage and Mutation Evidence

## Problem & Value
A passing test run says nothing about how much of the code the tests touched, and a coverage figure says nothing about whether the tests would fail if the code were wrong. A coding agent can write code beyond what its requirements ask for and a test that executes it without asserting anything; both numbers still look healthy. Worse, a whole-suite coverage report invites the claim "this requirement is covered" when all it shows is that some test, somewhere, ran the line.

This capability turns the reports teams already produce into evidence that is attributed to the right owner and honest about its limits. Coverage reports (lcov, JaCoCo, Cobertura, Go) and mutation reports (Stryker, PIT) are read from files, their paths are mapped onto repository files, and the results are credited to the capability that owns each file. Lines changed in a diff get their own coverage figure. Mutation results are scored per claim through the tests tagged to that claim. Evidence is stored with the content hash of every file it describes, so when the code changes the evidence is marked stale instead of silently kept. A whole-suite report is never presented as proof that a claim's tests reach the code.

## Users & Journeys
- A developer runs the test suite with coverage on in CI, then `specguard coverage ingest coverage/lcov.info`; each capability's executable and hit lines, and the lines no test reached, become available to `check`.
- A team on the JVM runs `specguard coverage ingest target/site/jacoco/jacoco.xml` and `specguard mutation ingest target/pit-reports/mutations.xml` and gets the same evidence as a TypeScript team using lcov and Stryker.
- A pipeline that runs one capability's tagged tests with coverage on runs `specguard coverage ingest cov.info --capability cart`; that evidence can say the claim tests as a group reach the owned code, which a whole-suite report cannot.
- A reviewer looks at a pull request and sees that 3 of the 40 changed executable lines are not hit by any test, with the file and line ranges.
- A tech lead reads that a claim's tests killed 2 of the 3 mutants they cover (66.7%) and that the survivor is on line 5 of the cart file.
- A developer edits an owned file after ingesting; the evidence for that file shows as stale and drops out of every figure until the reports are produced again.

## Requirements
- [ ] Each coverage report format is parsed into per-file executable lines with hit counts and per-line branch totals: lcov (`SF`, `DA`, `BRDA`), JaCoCo XML (`package`/`sourcefile`/`line` with `mi`, `ci`, `mb`, `cb`), Cobertura XML (`class`, `line`, `condition-coverage`, repeated classes merged) and Go coverprofiles (`mode:` line, multi-line blocks, duplicate blocks taking the highest count); the format is detected from the content, a DOCTYPE entity is never expanded, and unparseable input fails with a typed error naming the format <!-- claim: coverage-formats-parsed -->
- [ ] A Stryker mutation report and a PIT `mutations.xml` are parsed into mutants with a file, line range, mutator and one of seven statuses (killed, survived, no-coverage, timeout, invalid, ignored, pending), the tests that killed each mutant, the tests that covered it when the tool recorded that, whether the report lists every killer or only the first, and the hash of each mutated file where the tool embeds its source <!-- claim: mutation-formats-parsed -->
- [ ] Report paths are mapped onto repository files by stripping `file://`, converting backslashes, removing the checkout root or a configured `coverage.pathPrefixes` entry, applying Go module prefixes and JaCoCo or PIT source roots (`coverage.sourceRoots`), and then matching a unique file-name suffix; a path that is outside the root, matches nothing or matches several files is reported as unmapped with its reason and is never dropped silently <!-- claim: paths-normalized -->
- [ ] Coverage is credited to a capability through the files it owns: line coverage is computed over the owned source files that the evidence reports and that are unchanged since ingest, owned files absent from the report are listed, and lines in reported files that no test hit are reported as unreached, which for a whole-suite report is a sound lower bound on code no claim test reaches <!-- claim: attributed-by-ownership -->
- [ ] Diff coverage takes the added lines of each changed owned file, keeps only the lines the evidence marks executable, and reports how many were hit with the missed ranges per file; a changed owned file with no fresh coverage is listed as unknown and never counted as covered <!-- claim: diff-coverage -->
- [ ] A whole-suite report, and a capability report scoped to test files, can show only that some test executed a line, so neither is marked able to prove that a claim's tests reach the code or that executed lines are specified behaviour; only a report scoped to the capability's tagged tests, while the set of tagged tests is unchanged, is marked able to prove both <!-- claim: suite-report-limit -->
- [ ] A test that killed or covered a mutant is matched to a test declaration by file and title (a describe-prefixed name, a JVM method name and a parameterized `[param]` or `(param)` suffix are accepted), and through its tag to a claim; a test that matches no declaration, or more than one, is listed as unmatched and never guessed <!-- claim: tests-mapped-to-claims -->
- [ ] A claim's mutation score is the mutants its tests killed divided by those mutants plus the ones its tests covered and nobody killed, and it is computed only when the report records coverage per test <!-- claim: mutation-score-per-claim -->
- [ ] Mutants that were ignored, invalid or pending are counted but left out of every score, no-coverage mutants count against the capability score but not against a claim's score, timeouts count as killed when `mutation.timeoutAsKilled` is true and are left out of the score when it is false, and when the tool lists only the first killing test the mutants killed by another test are reported as unattributed instead of as survivors <!-- claim: mutation-edge-statuses -->
- [ ] A claim meets the mutation policy only when its tests killed at least `mutation.minKilled` mutants (default 1) and, when a per-claim score exists, that score is at least `mutation.minScore` (default 70); the config rejects a `minScore` outside 0 to 100, and the failing reasons are reported as not killed, score low or stale <!-- claim: mutation-min-score -->
- [ ] Stored evidence records the content hash of every file it describes, so a file whose current hash differs is excluded from every coverage and mutation figure and listed as stale, a claim whose mutants touch such a file is marked stale, and capability coverage is marked stale when the set of tests tagged to the capability's claims has changed since ingest <!-- claim: evidence-staleness -->
- [ ] `specguard coverage ingest <files...>` and `specguard mutation ingest <files...>` read the report files, write the normalized evidence under `.specguard/coverage/` (`suite.json`, or `cap/<id>.json` with `--capability`) and `.specguard/mutation/report.json` keeping only the latest per scope, and exit 2 without writing when no file matches, no file parses or no path maps onto the repository; those directories are in the generated-state ignore list <!-- claim: ingest-commands -->

## Scenarios
### Scenario 1: Whole-suite coverage credited to capabilities
**Steps:**
1. CI runs the whole suite with coverage on and produces `lcov.info`.
2. A developer runs `specguard coverage ingest lcov.info`.

**Expected Results:**
- `.specguard/coverage/suite.json` lists, per file, the executable and hit line ranges and the file's content hash.
- Report paths written as absolute CI paths map onto repository files when `coverage.pathPrefixes` names the checkout directory; the paths that still do not map are listed.
- The command prints that a whole-suite report shows what some test executed, not what a claim's tests execute.

### Scenario 2: A changed line no test reaches
**Steps:**
1. A developer adds six lines to an owned file and the suite does not execute two of them.
2. Coverage is ingested after the run.

**Expected Results:**
- Diff coverage for the owning capability counts only the added lines the report marks executable and shows the two missed lines as a range.
- If the file was edited again after ingest, the file is listed as unknown for the diff and its lines do not count as hit.

### Scenario 3: A claim whose tests do not notice a change
**Steps:**
1. A team ingests a Stryker report with per-test coverage.
2. The cart capability owns the mutated file and one claim is tagged on two tests.

**Expected Results:**
- Mutants those two tests cover are scored for the claim: killed over killed plus survived.
- A survivor is listed with its file, line and mutator.
- A claim whose tests killed no mutant does not meet the policy (not killed), however high the capability's score is.

### Scenario 4: The report is older than the code
**Steps:**
1. Evidence is ingested for a capability.
2. A developer edits one of its owned files.

**Expected Results:**
- That file is listed as stale and is left out of line coverage, diff coverage and mutation scores.
- Claims whose mutants are in that file are marked stale.

## Security & Data Considerations
Reports are untrusted input. XML is parsed without entity expansion, and report paths are only ever matched against the repository's own file list and never opened, so a report cannot make the tool read a file outside the repository. Stored evidence holds file paths, line numbers, test names and content hashes, never source text. Evidence is a gitignored local cache; it carries an origin (local, ci or server) so a later gate can decide to trust only CI evidence.

## Interfaces
- CLI: `specguard coverage ingest <files...> [--format auto|lcov|jacoco|cobertura|go] [--capability <id>] [--selection tests|files] [--run-id <id>] [--origin local|ci|server]`, `specguard mutation ingest <files...> [--format auto|stryker|pit] [--run-id <id>] [--origin local|ci|server]`.
- Files: `.specguard/coverage/suite.json`, `.specguard/coverage/cap/<capability>.json`, `.specguard/mutation/report.json`.
- Config: `coverage.pathPrefixes`, `coverage.sourceRoots`, `mutation.minScore` (default 70), `mutation.minKilled` (default 1), `mutation.timeoutAsKilled` (default true), `mutation.attribution` (`full` when the tool lists every killing test).
- Exit codes: 0 ingested, 2 no input matched, nothing parsed, nothing mapped onto the repository, or a bad option.

## Out of Scope
- Running the tests, or the mutation tool, with coverage on; the ingest commands read finished reports.
- Per-claim coverage: it would need one run per claim, so claim-level statements come from mutation, not coverage.
- Deciding that a mutant is equivalent; projects suppress those with the tool's own disable comments, and the tool reports them as ignored.
- Feeding these figures into the check verdict and the proof statement.
