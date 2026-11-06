---
title: "Coverage and Mutation Evidence"
audience: user
source: "specs/capabilities/coverage-and-mutation.md"
generated: true
---
<a id="coverage-and-mutation-evidence"></a>
# Coverage and Mutation Evidence

Coverage and mutation evidence shows which of your code the tests actually run, and whether the tests would notice if that code changed. You produce the reports with the tools you already use. SpecGuard reads them, credits the results to the capability that owns each file, and states what each number cannot prove.

<a id="why-it-exists"></a>
## Why it exists

A passing test run does not say how much code the tests touched. A coverage figure does not say whether the tests would fail if the code were wrong. A whole-suite coverage report also invites the claim "this requirement is covered", when all it shows is that some test, somewhere, ran the line. Code written beyond what the requirements ask for, with a test that runs it but asserts nothing, still looks healthy in both numbers.

This capability turns existing reports into evidence that:

- is attributed to the capability that owns the code,
- says what it cannot prove,
- is marked stale when the code has changed since it was measured.

<a id="what-you-can-do"></a>
## What you can do

<a id="ingest-coverage-reports"></a>
### Ingest coverage reports

Run `specguard coverage ingest <files...>` on a finished report. Supported formats are lcov, JaCoCo XML, Cobertura XML and Go coverprofiles. The format is detected from the content, or you can set it with `--format auto|lcov|jacoco|cobertura|go`.

Each capability then gets:

- its line coverage over the owned source files the report covers,
- a list of owned files missing from the report,
- the lines in reported files that no test hit.

For a whole-suite report, the unreached lines are code that no claim test reaches. The reverse does not hold: a line that was hit is not shown to be reached by a claim's tests.

<a id="scope-coverage-to-one-capability"></a>
### Scope coverage to one capability

If your pipeline runs only one capability's tagged tests with coverage on, ingest the result with `--capability <id>`:

```
specguard coverage ingest cov.info --capability cart
```

Only this kind of report can say that the claim tests as a group reach the owned code. A whole-suite report cannot say that. A capability report scoped to test files cannot either. You can set the scope with `--selection tests|files`.

<a id="see-coverage-of-changed-lines"></a>
### See coverage of changed lines

Diff coverage looks only at the lines added in a change that the report marks as executable. It tells you how many were hit and gives the missed line ranges per file. For example, 3 of 40 changed executable lines are not hit by any test. A changed file with no fresh coverage is listed as unknown. Its lines are never counted as covered.

<a id="ingest-mutation-reports"></a>
### Ingest mutation reports

Run `specguard mutation ingest <files...>` on a Stryker report or a PIT `mutations.xml`. Choose the format with `--format auto|stryker|pit`. A mutation tool makes small changes to the code and checks whether the tests fail. A mutant that the tests catch is "killed", and one they miss "survived".

Mutants are matched to your test declarations by file and title, and through the test's tag to a claim. Each claim gets a score. For example, a claim's tests killed 2 of the 3 mutants they cover (66.7%), and the survivor is on line 5 of the cart file. Survivors are listed with their file, line and mutator.

<a id="apply-a-mutation-policy"></a>
### Apply a mutation policy

A claim meets the policy only when both of these hold:

- Its tests killed at least `mutation.minKilled` mutants (default 1).
- If a per-claim score exists, it is at least `mutation.minScore` (default 70, and it must be between 0 and 100).

A claim that fails is reported as one of three reasons: not killed, score low, or stale. A high capability-wide score does not rescue a claim whose own tests killed nothing.

<a id="help-specguard-find-your-files"></a>
### Help SpecGuard find your files

Report paths often come from a CI machine and look different from your repository paths. SpecGuard strips `file://` prefixes, converts backslashes, removes the checkout root, and then looks for a unique file-name match in the repository. Use these settings to help it:

- `coverage.pathPrefixes` for checkout directories,
- `coverage.sourceRoots` for JaCoCo or PIT source roots.

Go module prefixes are applied automatically. Paths that cannot be mapped are listed with a reason. They are never dropped silently.

<a id="other-options"></a>
### Other options

Both commands accept `--run-id <id>` and `--origin local|ci|server`. The origin is stored with the evidence so a later check can choose to trust only CI evidence.

<a id="what-to-expect"></a>
## What to expect

**How scores are counted**

- A claim's mutation score is the mutants its tests killed, divided by those killed plus those its tests covered that nobody killed. It is calculated only when the report records which tests covered each mutant.
- Ignored, invalid and pending mutants are counted but kept out of every score.
- Mutants with no coverage count against the capability's score, but not against a claim's score.
- Timeouts count as killed by default. Set `mutation.timeoutAsKilled` to false to leave them out of the score.
- If the tool lists only the first test that killed a mutant, mutants killed by another test are reported as unattributed, not as survivors. Set `mutation.attribution` to `full` when your tool lists every killing test.
- A test that matches no declaration, or more than one, is listed as unmatched. SpecGuard never guesses.

**Stale evidence**

Evidence is stored with a fingerprint of every file it describes. If you edit an owned file after ingesting:

- the file is listed as stale,
- it drops out of line coverage, diff coverage and mutation scores,
- claims whose mutants are in that file are marked stale,
- capability coverage is marked stale if the set of tests tagged to its claims has changed.

Run your tools and ingest again to refresh the evidence.

**Where evidence is saved**

- Coverage goes in `.specguard/coverage/suite.json`, or `.specguard/coverage/cap/<id>.json` when you use `--capability`.
- Mutation goes in `.specguard/mutation/report.json`.
- Only the latest evidence per scope is kept.
- These folders are in the generated-state ignore list.

**When ingest fails**

The command exits with code 2 and writes nothing if:

- no file matches,
- no file parses (the error names the format),
- no path maps onto the repository,
- an option is invalid.

Otherwise it exits with 0.

**Safety**

Reports are treated as untrusted input. XML entities are never expanded. Report paths are only compared against your repository's own file list and are never opened. Stored evidence contains file paths, line numbers, test names and content hashes, never source code.

**What this does not do**

- It does not run your tests or your mutation tool. It reads finished reports.
- It does not give per-claim coverage. Claim-level statements come from mutation results.
- It does not decide whether a mutant is equivalent. Use your tool's own disable comments, and those mutants are reported as ignored.
- It does not yet feed these figures into the check verdict or the proof statement.
