# specguard matrix Command

<!-- module: specguard-cli/commands/matrix / type: cli-command / status: draft -->

## Overview

The `specguard matrix` command generates a traceability matrix by invoking the `runMatrix` pipeline with configuration resolved from CLI options and the loaded config file. It accepts optional arguments to control the output file path, output format (`json` or `csv`), and an application filter. Upon completion, the command prints all pipeline messages to stdout, reports the total number of entries written, and exits with the pipeline-determined exit code.

## Acceptance Criteria

- AC1: The command loads CLI configuration via `loadCliConfig` before invoking the matrix pipeline.
- AC2: The `--format` option accepts `json` or `csv`; when omitted, `json` is used as the default.
- AC3: The `--out` option, when provided, is forwarded to the pipeline as the output file path.
- AC4: The `--app` option, when provided, is forwarded to the pipeline as an application filter.
- AC5: Every message in `result.messages` is written to stdout, each on its own line.
- AC6: A summary line in the format `matrix: <N> entries written` is written to stdout after all messages.
- AC7: The process exits with `result.exitCode` as returned by the pipeline.

## Scenarios

### Scenario 1: Default format used when --format is omitted

**Steps:**
1. Invoke `matrixCommand` with opts containing no `format` property.
2. Capture the arguments passed to `runMatrix`.

**Expected Results:**
- The `format` argument received by `runMatrix` equals `"json"`.

---

### Scenario 2: CSV format forwarded when --format csv is supplied

**Steps:**
1. Invoke `matrixCommand` with `opts.format` set to `"csv"`.
2. Capture the arguments passed to `runMatrix`.

**Expected Results:**
- The `format` argument received by `runMatrix` equals `"csv"`.

---

### Scenario 3: Output path forwarded when --out is supplied

**Steps:**
1. Invoke `matrixCommand` with `opts.out` set to `"./reports/matrix.json"`.
2. Capture the arguments passed to `runMatrix`.

**Expected Results:**
- The `out` argument received by `runMatrix` equals `"./reports/matrix.json"`.

---

### Scenario 4: Application filter forwarded when --app is supplied

**Steps:**
1. Invoke `matrixCommand` with `opts.app` set to `"my-service"`.
2. Capture the arguments passed to `runMatrix`.

**Expected Results:**
- The `app` argument received by `runMatrix` equals `"my-service"`.

---

### Scenario 5: Pipeline messages printed to stdout

**Steps:**
1. Configure the `runMatrix` mock to return `{ messages: ["Processing specs", "Linking tests"], created: 2, exitCode: 0 }`.
2. Invoke `matrixCommand` with minimal opts.
3. Capture all output written to `process.stdout`.

**Expected Results:**
- stdout contains the line `Processing specs`.
- stdout contains the line `Linking tests`.
- Each message appears on its own line (terminated with `\n`).

---

### Scenario 6: Summary line written after messages

**Steps:**
1. Configure the `runMatrix` mock to return `{ messages: ["Done"], created: 42, exitCode: 0 }`.
2. Invoke `matrixCommand` with minimal opts.
3. Capture all output written to `process.stdout`.

**Expected Results:**
- The final line written to stdout is `matrix: 42 entries written`.

---

### Scenario 7: Process exits with pipeline exit code on success

**Steps:**
1. Configure the `runMatrix` mock to return `{ messages: [], created: 0, exitCode: 0 }`.
2. Invoke `matrixCommand` with minimal opts.
3. Observe the argument passed to `process.exit`.

**Expected Results:**
- `process.exit` is called with `0`.

---

### Scenario 8: Process exits with non-zero exit code on pipeline failure

**Steps:**
1. Configure the `runMatrix` mock to return `{ messages: ["Error: spec not found"], created: 0, exitCode: 1 }`.
2. Invoke `matrixCommand` with minimal opts.
3. Observe the argument passed to `process.exit`.

**Expected Results:**
- `process.exit` is called with `1`.
- stdout contains the line `Error: spec not found`.
- stdout contains the line `matrix: 0 entries written`.

## Security Notes

- No secret values, API keys, or credentials are present in this command's source.
- CLI options (`--out`, `--format`, `--app`) are passed directly to the pipeline; the pipeline layer is responsible for validating and sanitising these values before use in file system or data operations.

## Dependencies

- `runMatrix` — pipeline function from `../../pipelines/matrix.js`; must be available and correctly implemented for this command to function.
- `loadCliConfig` — helper from `./helpers.js`; resolves merged configuration from CLI global options and any config file on disk.
- `GlobalOpts` — type from `./helpers.js`; provides the base set of global CLI options inherited by `MatrixCliOpts`.