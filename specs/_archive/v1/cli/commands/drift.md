# specguard drift Command

<!-- module: specguard-cli/commands/drift / type: cli-command / status: draft -->

## Overview

The `specguard drift` command detects Living Specifications that have drifted from their corresponding source code. It delegates to the `runDrift` pipeline, passing user-supplied filter and mode options. Results are written line-by-line to standard output, followed by a summary message indicating how many specs drifted or confirming no drift was found. The process exits with the exit code returned by the pipeline, enabling integration with CI systems and shell scripts.

## Acceptance Criteria

- AC1: When invoked, the command loads CLI configuration via `loadCliConfig` before running the drift pipeline.
- AC2: The `--since`, `--spec`, `--force`, and `--mtime` options are forwarded to the drift pipeline unchanged.
- AC3: Each message in `result.messages` is printed to stdout on its own line.
- AC4: When one or more specs have drifted (`result.failed > 0`), the summary line reads `drift: <N> spec(s) drifted` where `<N>` is the exact count.
- AC5: When no specs have drifted (`result.failed === 0`), the summary line reads `drift: no drift detected`.
- AC6: The process exits with the exit code provided by `result.exitCode`.
- AC7: No output is written to stderr by this command layer (all output goes to stdout).

## Scenarios

### Scenario 1: No drift detected across all specs

**Steps:**
1. Run `specguard drift` with no additional options against a repository where all specs match their source.
2. Capture stdout and the process exit code.

**Expected Results:**
- stdout contains the line `drift: no drift detected`.
- No `drift: <N> spec(s) drifted` line appears in stdout.
- Process exits with the exit code returned by the pipeline (typically `0`).

### Scenario 2: One or more specs have drifted

**Steps:**
1. Run `specguard drift` against a repository where at least one spec has drifted from its source.
2. Capture stdout and the process exit code.

**Expected Results:**
- stdout contains one line per entry in `result.messages`, each terminated by a newline.
- The final summary line in stdout matches the pattern `drift: <N> spec(s) drifted` where `<N>` equals the number of drifted specs.
- Process exits with a non-zero exit code as returned by the pipeline.

### Scenario 3: Filtering drift check to a single spec via `--spec`

**Steps:**
1. Run `specguard drift --spec path/to/my-spec.md`.
2. Capture stdout and the process exit code.

**Expected Results:**
- The drift pipeline is invoked with `spec` set to `path/to/my-spec.md`.
- Output and exit code reflect only the drift status of the specified spec.
- Summary line is either `drift: no drift detected` or `drift: 1 spec(s) drifted`.

### Scenario 4: Restricting drift check to changes since a git ref via `--since`

**Steps:**
1. Run `specguard drift --since main`.
2. Capture stdout and the process exit code.

**Expected Results:**
- The drift pipeline is invoked with `since` set to `main`.
- Only specs whose source files changed since the given ref are evaluated.
- Summary line and exit code reflect the scoped result.

### Scenario 5: Forcing full re-evaluation via `--force`

**Steps:**
1. Run `specguard drift --force`.
2. Capture stdout and the process exit code.

**Expected Results:**
- The drift pipeline is invoked with `force` set to `true`.
- Any caching or incremental-check optimisations are bypassed.
- All specs are evaluated and results are reported normally.

### Scenario 6: Using mtime-based change detection via `--mtime`

**Steps:**
1. Run `specguard drift --mtime`.
2. Capture stdout and the process exit code.

**Expected Results:**
- The drift pipeline is invoked with `mtime` set to `true`.
- File modification timestamps are used as the change-detection strategy.
- Summary line and exit code reflect the result of the mtime-based evaluation.

### Scenario 7: Configuration is loaded before pipeline execution

**Steps:**
1. Run `specguard drift` with a `--config` global option pointing to a valid config file.
2. Observe that `loadCliConfig` resolves before `runDrift` is called.

**Expected Results:**
- The resolved configuration object is passed to `runDrift`.
- If the config file is missing or invalid, the command fails before producing any drift output.

## Security Notes

- No secret values, API keys, or credentials are handled by this command.
- The `--spec` and `--since` option values are passed directly to the pipeline; callers should ensure these values are not sourced from untrusted user input in automated contexts to avoid path traversal or unexpected git ref resolution.

## Dependencies

- `../../pipelines/drift` — `runDrift` pipeline function that performs the actual drift analysis.
- `./helpers` — `loadCliConfig` utility and `GlobalOpts` type for shared CLI configuration loading.
- Node.js `process.stdout` and `process.exit` — used for output and exit-code signalling.