# Matrix Pipeline

<!-- module: src/pipelines/matrix.ts -->
<!-- type: pipeline -->
<!-- status: stable -->

## Overview

The matrix pipeline builds a traceability matrix cross-referencing specs, test files,
doc files, and source modules. Output is written to `.specguard/traceability.json`
(or a configured path) and optionally as CSV for compliance teams.

The matrix enables teams to answer: "Which tests cover this requirement?" and
"Which requirements have no tests yet?"

## Acceptance Criteria

- `runMatrix(config, opts)` returns a `PipelineResult`.
- For each spec, the matrix entry contains: `specKey`, `title`, `tests` (array of matched test file paths), `docs` (matched doc file paths), `sources` (matched source file paths).
- A test file matches a spec when its basename (without `.test.ts`) matches the spec key basename.
- A doc file matches a spec when its basename (without `.md`) matches the spec key basename.
- Source files are taken from the spec's `module:` metadata when present.
- Output is written to `config.matrix.output` (default: `.specguard/traceability.json`).
- `--format csv` writes a `.csv` file with columns: `specKey,title,testCount,docCount,sourceModule`.
- Exit code is always `0` (informational pipeline).
- `--app <name>` scopes the matrix to a single app's specs.

## Scenarios

### Scenario 1: Matrix built for all apps
**Steps:**
1. Config has two apps each with specs and test files
2. Run `specguard matrix`

**Expected Results:**
- `traceability.json` written with entries for all specs
- Each entry has matched tests and docs arrays

### Scenario 2: CSV format output
**Steps:**
1. Run `specguard matrix --format csv`

**Expected Results:**
- `.csv` file written with correct headers and rows

### Scenario 3: Spec with no matching test
**Steps:**
1. Spec exists but no test file matches its key

**Expected Results:**
- Entry has `tests: []`

## Security Notes

- Traceability data may reveal security-sensitive spec names — treat output dir as internal.

## Dependencies

- `src/core/spec-parser.ts`
- `src/core/config.ts`
- `src/core/reader.ts`
- `src/core/writer.ts`
