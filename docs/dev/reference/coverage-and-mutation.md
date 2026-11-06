---
title: "Coverage and Mutation Evidence (developer reference)"
audience: dev
source: "specs/capabilities/coverage-and-mutation.md"
generated: true
---
<a id="coverage-and-mutation-evidence"></a>
# Coverage and Mutation Evidence

<a id="purpose"></a>
## Purpose

This capability turns existing coverage and mutation reports into evidence that a reviewer can trust, because each figure is attributed to an owner and states its limits. It answers two questions that a passing test run cannot:

- Which owned code do the tests execute?
- Would a claim's tests notice if that code changed?

Reports are read from files, their paths are mapped onto repository files, and the results are credited to the capability that owns each file. Lines changed in a diff get their own coverage figure, and mutation results are scored per claim through the tests tagged to that claim. Evidence is stored with the content hash of every file it describes. When the code changes, the evidence is marked stale rather than silently kept. A whole-suite report is never presented as proof that a claim's tests reach the code.

Supported inputs:

- Coverage: lcov, JaCoCo, Cobertura, Go coverprofiles.
- Mutation: Stryker, PIT.

<a id="responsibilities"></a>
## Responsibilities

- Parse coverage reports (lcov, JaCoCo, Cobertura, Go) into per-file executable lines with hit counts and branch totals.
- Parse mutation reports (Stryker, PIT) into mutants with status, location, mutator, killing and covering tests, and file hashes where available.
- Map report paths onto repository files, and report every path that cannot be mapped, with its reason.
- Credit coverage to capabilities through file ownership, and list owned files missing from the report and lines no test reached.
- Compute diff coverage for the added lines of changed owned files.
- Label each coverage report with what it can and cannot prove (suite-wide, test-file scoped, or capability-test scoped).
- Match mutant-related tests to test declarations and, through tags, to claims, without guessing.
- Score mutation results per claim and per capability, and apply the mutation policy.
- Mark evidence stale when the files it describes, or the set of tagged tests, have changed since ingest.
- Provide the `coverage ingest` and `mutation ingest` commands and persist the normalized evidence.

Out of scope:

- Running the tests or the mutation tool. Ingest reads finished reports.
- Per-claim coverage. It would need one run per claim, so claim-level statements come from mutation.
- Deciding that a mutant is equivalent. Projects suppress those with the tool's own disable comments, and they are reported as ignored.
- Feeding these figures into the check verdict and the proof statement.

<a id="interfaces"></a>
## Interfaces

<a id="cli"></a>
### CLI

```
specguard coverage ingest <files...>
  [--format auto|lcov|jacoco|cobertura|go]
  [--capability <id>] [--selection tests|files]
  [--run-id <id>] [--origin local|ci|server]

specguard mutation ingest <files...>
  [--format auto|stryker|pit]
  [--run-id <id>] [--origin local|ci|server]
```

Examples:

```
specguard coverage ingest coverage/lcov.info
specguard coverage ingest target/site/jacoco/jacoco.xml
specguard mutation ingest target/pit-reports/mutations.xml
specguard coverage ingest cov.info --capability cart
```

<a id="files-written"></a>
### Files written

| Path | Content |
|---|---|
| `.specguard/coverage/suite.json` | Whole-suite coverage evidence |
| `.specguard/coverage/cap/<capability>.json` | Evidence from `--capability` ingest |
| `.specguard/mutation/report.json` | Mutation evidence |

Only the latest evidence per scope is kept. These directories are in the generated-state ignore list.

<a id="config"></a>
### Config

| Key | Default | Meaning |
|---|---|---|
| `coverage.pathPrefixes` | — | Prefixes (such as a CI checkout directory) stripped from report paths |
| `coverage.sourceRoots` | — | JaCoCo and PIT source roots used when mapping paths |
| `mutation.minScore` | 70 | Minimum per-claim score; values outside 0–100 are rejected |
| `mutation.minKilled` | 1 | Minimum mutants a claim's tests must kill |
| `mutation.timeoutAsKilled` | true | Whether timeouts count as killed |
| `mutation.attribution` | — | `full` when the tool lists every killing test |

<a id="exit-codes"></a>
### Exit codes

- `0`: ingested.
- `2`: no input file matched, nothing parsed, nothing mapped onto the repository, or a bad option. Nothing is written in these cases.

<a id="requirements"></a>
## Requirements

- **coverage-formats-parsed**: Each coverage report format is parsed into per-file executable lines with hit counts and per-line branch totals.
  - lcov: `SF`, `DA`, `BRDA`.
  - JaCoCo XML: `package`/`sourcefile`/`line` with `mi`, `ci`, `mb`, `cb`.
  - Cobertura XML: `class`, `line`, `condition-coverage`, with repeated classes merged.
  - Go coverprofiles: `mode:` line, multi-line blocks, duplicate blocks taking the highest count.
  - The format is detected from the content, and a DOCTYPE entity is never expanded.
  - Unparseable input fails with a typed error naming the format.
- **mutation-formats-parsed**: A Stryker mutation report and a PIT `mutations.xml` are parsed into mutants. Each mutant has:
  - a file, line range and mutator;
  - one of seven statuses: killed, survived, no-coverage, timeout, invalid, ignored, pending;
  - the tests that killed it;
  - the tests that covered it, when the tool recorded that;
  - whether the report lists every killer or only the first;
  - the hash of each mutated file, where the tool embeds its source.
- **paths-normalized**: Report paths are mapped onto repository files by these steps, in order:
  1. Strip `file://`.
  2. Convert backslashes.
  3. Remove the checkout root or a configured `coverage.pathPrefixes` entry.
  4. Apply Go module prefixes and JaCoCo or PIT source roots (`coverage.sourceRoots`).
  5. Match a unique file-name suffix.

  A path that is outside the root, matches nothing or matches several files is reported as unmapped with its reason. It is never dropped silently.
- **attributed-by-ownership**: Coverage is credited to a capability through the files it owns.
  - Line coverage is computed over the owned source files that the evidence reports and that are unchanged since ingest.
  - Owned files absent from the report are listed.
  - Lines in reported files that no test hit are reported as unreached. For a whole-suite report this is a sound lower bound on code no claim test reaches.
- **diff-coverage**: Diff coverage takes the added lines of each changed owned file and keeps only the lines the evidence marks executable. It reports how many were hit, with the missed ranges per file. A changed owned file with no fresh coverage is listed as unknown and never counted as covered.
- **suite-report-limit**: A whole-suite report, and a capability report scoped to test files, can show only that some test executed a line.
  - Neither is marked able to prove that a claim's tests reach the code, or that executed lines are specified behaviour.
  - Only a report scoped to the capability's tagged tests, while the set of tagged tests is unchanged, is marked able to prove both.
- **tests-mapped-to-claims**: A test that killed or covered a mutant is matched to a test declaration by file and title, and through its tag to a claim.
  - Accepted title forms: a describe-prefixed name, a JVM method name, and a parameterized `[param]` or `(param)` suffix.
  - A test that matches no declaration, or more than one, is listed as unmatched and never guessed.
- **mutation-score-per-claim**: A claim's mutation score is the mutants its tests killed, divided by those mutants plus the ones its tests covered and nobody killed. It is computed only when the report records coverage per test.
- **mutation-edge-statuses**:
  - Ignored, invalid and pending mutants are counted but left out of every score.
  - No-coverage mutants count against the capability score but not against a claim's score.
  - Timeouts count as killed when `mutation.timeoutAsKilled` is true, and are left out of the score when it is false.
  - When the tool lists only the first killing test, mutants killed by another test are reported as unattributed instead of as survivors.
- **mutation-min-score**: A claim meets the mutation policy only when both conditions hold:
  - its tests killed at least `mutation.minKilled` mutants (default 1);
  - when a per-claim score exists, that score is at least `mutation.minScore` (default 70).

  The config rejects a `minScore` outside 0 to 100. Failing reasons are reported as *not killed*, *score low* or *stale*.
- **evidence-staleness**: Stored evidence records the content hash of every file it describes.
  - A file whose current hash differs is excluded from every coverage and mutation figure and listed as stale.
  - A claim whose mutants touch such a file is marked stale.
  - Capability coverage is marked stale when the set of tests tagged to the capability's claims has changed since ingest.
- **ingest-commands**: `specguard coverage ingest <files...>` and `specguard mutation ingest <files...>` read the report files and write the normalized evidence.
  - Coverage goes under `.specguard/coverage/` (`suite.json`, or `cap/<id>.json` with `--capability`). Mutation goes to `.specguard/mutation/report.json`.
  - Only the latest evidence per scope is kept.
  - The commands exit 2 without writing when no file matches, no file parses or no path maps onto the repository.
  - Those directories are in the generated-state ignore list.

<a id="behaviour-by-scenario"></a>
### Behaviour by scenario

- **Whole-suite ingest.**
  - `suite.json` lists, per file, the executable and hit line ranges and the content hash.
  - Absolute CI paths map when `coverage.pathPrefixes` names the checkout directory. Paths that still do not map are listed.
  - The command prints that a whole-suite report shows what some test executed, not what a claim's tests execute.
- **Changed line no test reaches.**
  - Diff coverage counts only the added lines the report marks executable, and shows missed lines as a range.
  - If the file was edited again after ingest, it is listed as unknown for the diff and its lines do not count as hit.
- **Claim whose tests do not notice a change.**
  - With a Stryker report that has per-test coverage, mutants covered by the claim's tagged tests are scored as killed over killed plus survived.
  - Survivors are listed with file, line and mutator.
  - A claim whose tests killed no mutant fails the policy (*not killed*), whatever the capability's score.
- **Report older than the code.** The edited file is listed as stale and is left out of line coverage, diff coverage and mutation scores. Claims whose mutants are in that file are marked stale.

<a id="code-map"></a>
## Code map

| Area | File |
|---|---|
| Coverage logic | `src/core/coverage.ts` |
| Mutation logic | `src/core/mutation.ts` |
| Coverage ingest pipeline | `src/pipelines/coverage-ingest.ts` |
| Mutation ingest pipeline | `src/pipelines/mutation-ingest.ts` |
| Coverage CLI command | `src/cli/commands/coverage.ts` |
| Mutation CLI command | `src/cli/commands/mutation.ts` |

These six files are the capability's owned files. The material given does not say how functionality is divided inside each file, so check the source before assuming where a given parser or calculation lives.

<a id="tests"></a>
## Tests

| Test file | Covers |
|---|---|
| `tests/core/coverage.test.ts` | Core coverage logic |
| `tests/core/mutation.test.ts` | Core mutation logic |
| `tests/pipelines/coverage-ingest.test.ts` | Coverage ingest pipeline |
| `tests/pipelines/mutation-ingest.test.ts` | Mutation ingest pipeline |

The CLI command files have no dedicated test file in this list.

<a id="security-and-data"></a>
## Security and data

- **Untrusted input.** Reports are untrusted. XML is parsed without entity expansion, and a DOCTYPE entity is never expanded.
- **No file reads from report paths.** Report paths are only matched against the repository's own file list and never opened. A report cannot make the tool read a file outside the repository.
- **No source text stored.** Stored evidence holds file paths, line numbers, test names and content hashes.
- **Local cache with provenance.** Evidence is a gitignored local cache. It carries an origin (`local`, `ci` or `server`), so a later gate can decide to trust only CI evidence.

<a id="extending-it"></a>
## Extending it

The following points follow from the requirements above.

- **Tuning behaviour.** Use the config keys before changing code:
  - `coverage.pathPrefixes` and `coverage.sourceRoots` for path mapping problems.
  - `mutation.minScore`, `mutation.minKilled` and `mutation.timeoutAsKilled` for policy.
  - `mutation.attribution` for tools that list every killing test.
- **Adding a report format.** Any new parser has to preserve these rules:
  - It produces the same normalized shape (per-file executable lines with hit counts and branch totals for coverage; mutants with the seven statuses for mutation).
  - It is detected from content when `--format auto` is used.
  - It never expands entities.
  - It fails with a typed error naming the format.
  - It is also reflected in the `--format` option values.
- **Adding path-mapping rules.** Keep the contract of **paths-normalized**: a path that cannot be mapped uniquely must be reported as unmapped with a reason, never dropped or guessed.
- **Changing what a report may prove.** Preserve **suite-report-limit**. Only a report scoped to the capability's tagged tests, with an unchanged tagged-test set, may be marked able to prove that claim tests reach the code.
- **Adding new evidence kinds.** Record the content hash of every file the evidence describes, so **evidence-staleness** applies to it.
- **Feeding the check verdict.** Wiring these figures into the check verdict and proof statement is explicitly out of scope for this capability. Treat it as separate work.
