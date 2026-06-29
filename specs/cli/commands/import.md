# specguard import Command

<!-- module: specguard-cli/commands/import / type: cli-command / status: draft -->

## Overview

The `specguard import` command converts external documents into Living Specifications. It accepts a `source` argument identifying the document or directory to import, along with optional flags to control the target application, output path, and overwrite behaviour. After the import pipeline runs, the command prints per-file messages followed by a summary line showing counts of created, skipped, and failed items. The process exits with the exit code returned by the import pipeline.

## Acceptance Criteria

- AC1: The command requires exactly one positional `source` argument.
- AC2: The `--app` flag, when provided, is forwarded to the import pipeline as the target application identifier.
- AC3: The `--out` flag, when provided, overrides the default output path for generated spec files.
- AC4: The `--force` flag, when provided, signals the pipeline to overwrite existing spec files.
- AC5: All messages returned by the pipeline are printed to `stdout`, one per line, before the summary line.
- AC6: A summary line in the format `import: <N> created, <N> skipped, <N> failed` is printed to `stdout` after all messages.
- AC7: The process exits with the exit code returned by the import pipeline result.
- AC8: Global CLI options (e.g. config file path) are loaded via `loadCliConfig` before the pipeline is invoked.

## Scenarios

### Scenario 1: Successful import with no conflicts

**Steps:**
1. Run `specguard import ./docs/api.md` with no additional flags.
2. Observe all output written to `stdout`.
3. Observe the process exit code.

**Expected Results:**
- Each message from the pipeline result appears on its own line in `stdout` before the summary.
- The final line of `stdout` matches the pattern `import: <N> created, 0 skipped, 0 failed`.
- The process exits with the exit code provided by the pipeline (e.g. `0` on success).

### Scenario 2: Import with --force flag overwrites existing specs

**Steps:**
1. Run `specguard import ./docs/api.md --force` when a spec file already exists at the target path.
2. Observe the summary line printed to `stdout`.
3. Observe the process exit code.

**Expected Results:**
- The `--force` option is passed to the pipeline; the pipeline does not skip the existing file.
- The summary line reflects at least 1 created and 0 skipped (assuming the pipeline honours `force`).
- The process exits with the exit code returned by the pipeline.

### Scenario 3: Import with --app and --out flags

**Steps:**
1. Run `specguard import ./docs/api.md --app my-service --out ./specs/generated`.
2. Observe the arguments forwarded to the pipeline.
3. Observe `stdout` output and process exit code.

**Expected Results:**
- The pipeline receives `app: "my-service"` and `out: "./specs/generated"` in its options.
- The summary line is printed to `stdout` in the format `import: <N> created, <N> skipped, <N> failed`.
- The process exits with the exit code returned by the pipeline.

### Scenario 4: Import with partial failures

**Steps:**
1. Run `specguard import ./docs/` against a directory where some files fail to convert.
2. Observe all lines written to `stdout`.
3. Observe the process exit code.

**Expected Results:**
- Per-file error messages from the pipeline appear in `stdout` before the summary line.
- The summary line shows a non-zero value for `failed` (e.g. `import: 2 created, 0 skipped, 1 failed`).
- The process exits with a non-zero exit code as returned by the pipeline.

### Scenario 5: Source file is skipped (already exists, no --force)

**Steps:**
1. Run `specguard import ./docs/api.md` without `--force` when the target spec already exists.
2. Observe the summary line printed to `stdout`.
3. Observe the process exit code.

**Expected Results:**
- The summary line shows at least 1 skipped and 0 created for the conflicting file (e.g. `import: 0 created, 1 skipped, 0 failed`).
- The process exits with the exit code returned by the pipeline.

## Security Notes

- No secret values, API keys, or credentials are present in this source file.
- The `source` argument and all flag values are passed directly to the import pipeline; callers should ensure that path traversal or injection risks are handled within the pipeline layer.
- Global options loaded via `loadCliConfig` may reference configuration files containing sensitive values; those values must not be echoed to `stdout` by this command.

## Dependencies

- `../../pipelines/import.js` — `runImport` pipeline function that performs the actual document conversion and returns `{ messages, created, skipped, failed, exitCode }`.
- `./helpers.js` — `loadCliConfig` utility and `GlobalOpts` type for resolving CLI-level configuration.
- Node.js built-ins: `process.stdout`, `process.exit`.