# SpecGuard CLI Entrypoint

<!-- module: specguard-cli/index / type: cli / status: draft -->

## Overview

The SpecGuard CLI is the primary command-line interface for the SpecGuard Living Specification QA agent. It is implemented as a Node.js executable that uses Commander to parse arguments and dispatch to subcommand handlers located in `./commands/`. Before any subcommand runs, the entrypoint performs a best-effort load of secrets from `.specguard/.env` in the current working directory, injecting any keys not already present in the process environment. No business logic resides in this file; all pipeline behaviour is delegated to individual command modules. Exit codes are controlled explicitly: Commander errors honour Commander's own exit code, `SpecGuardError` instances use their typed exit code, and all other errors exit with `ExitCode.InternalError`.

## Acceptance Criteria

- AC-1: Running `specguard --version` (or `-v`) prints the version string resolved from `package.json`; if `package.json` is unavailable (bundled deployment), the fallback version `0.1.0` is printed.
- AC-2: Running `specguard --help` prints usage information and exits with code `0`.
- AC-3: Running an unknown subcommand prints a usage hint containing `(add --help for usage)` and exits with a non-zero code.
- AC-4: The global `--config <path>` option is forwarded to every subcommand via `withGlobals`.
- AC-5: Variables defined in `.specguard/.env` in the current working directory are loaded into `process.env` before any subcommand executes, and existing environment variables are never overwritten.
- AC-6: Lines in `.specguard/.env` that are blank or begin with `#` are ignored.
- AC-7: A `SpecGuardError` thrown by any subcommand causes the error message to be written to `stderr` and the process to exit with the error's typed exit code.
- AC-8: An unexpected (non-SpecGuard, non-Commander) error causes the error message to be written to `stderr` and the process to exit with `ExitCode.InternalError`.
- AC-9: All registered subcommands (`init`, `import`, `reverse`, `generate`, `heal`, `validate`, `security`, `docs`, `drift`, `matrix`, `quality`, `deps`, `commit`, `analyze`, `plan-fix`, `gap-analysis`, `status`) are reachable via `specguard <subcommand> --help`.
- AC-10: `plan-fix` requires both `--pipeline` and `--issues`; omitting either causes a usage error with a non-zero exit code.

## Scenarios

### Scenario 1: Print version

**Steps:**
1. Execute `specguard --version` from any working directory.

**Expected Results:**
- The process exits with code `0`.
- Standard output contains a semver string (e.g. `0.1.0` or the value from `package.json`).

---

### Scenario 2: Print help

**Steps:**
1. Execute `specguard --help`.

**Expected Results:**
- The process exits with code `0`.
- Standard output contains the text `SpecGuard — Living Specification QA agent`.
- Standard output lists all registered subcommands including `init`, `reverse`, `generate`, `status`, `drift`, `gap-analysis`, and `plan-fix`.

---

### Scenario 3: Unknown subcommand shows usage hint

**Steps:**
1. Execute `specguard nonexistent-command`.

**Expected Results:**
- The process exits with a non-zero exit code.
- Standard error or standard output contains the text `add --help for usage`.

---

### Scenario 4: `.specguard/.env` variables are loaded before subcommand runs

**Steps:**
1. Create a file at `<cwd>/.specguard/.env` containing a line `MY_TEST_VAR=hello`.
2. Ensure `MY_TEST_VAR` is not set in the shell environment.
3. Execute any subcommand (e.g. `specguard status`) and capture the environment available to the subcommand handler.

**Expected Results:**
- `process.env.MY_TEST_VAR` equals `hello` when the subcommand handler is invoked.

---

### Scenario 5: `.specguard/.env` does not overwrite existing environment variables

**Steps:**
1. Create a file at `<cwd>/.specguard/.env` containing `MY_TEST_VAR=from_file`.
2. Set `MY_TEST_VAR=from_shell` in the shell environment before invoking the CLI.
3. Execute `specguard status`.

**Expected Results:**
- `process.env.MY_TEST_VAR` remains `from_shell` when the subcommand handler is invoked.

---

### Scenario 6: `.specguard/.env` ignores blank lines and comments

**Steps:**
1. Create `.specguard/.env` with the following content:
   ```
   # this is a comment
   
   VALID_KEY=value
   ```
2. Execute `specguard status`.

**Expected Results:**
- `process.env.VALID_KEY` equals `value`.
- No error is thrown due to the blank line or comment line.

---

### Scenario 7: Missing `.specguard/.env` file is silently ignored

**Steps:**
1. Ensure no `.specguard/.env` file exists in the current working directory.
2. Execute `specguard status`.

**Expected Results:**
- The process does not throw or print any error related to the missing `.env` file.
- The subcommand executes normally.

---

### Scenario 8: `SpecGuardError` exits with typed exit code

**Steps:**
1. Configure a subcommand handler to throw a `SpecGuardError` with a specific `exitCode` (e.g. `2`) and message `"spec not found"`.
2. Execute the corresponding subcommand.

**Expected Results:**
- Standard error contains `spec not found`.
- The process exits with code `2`.

---

### Scenario 9: Unexpected error exits with `InternalError` code

**Steps:**
1. Configure a subcommand handler to throw a plain `Error` with message `"unexpected failure"`.
2. Execute the corresponding subcommand.

**Expected Results:**
- Standard error contains `unexpected failure`.
- The process exits with the value of `ExitCode.InternalError`.

---

### Scenario 10: Global `--config` option is forwarded to subcommand

**Steps:**
1. Execute `specguard --config /custom/path/config.json status`.
2. Inspect the options object received by the `statusCommand` handler.

**Expected Results:**
- The `config` property of the options object equals `/custom/path/config.json`.

---

### Scenario 11: `plan-fix` fails when required options are omitted

**Steps:**
1. Execute `specguard plan-fix --pipeline validate` (omitting `--issues`).

**Expected Results:**
- The process exits with a non-zero exit code.
- Output contains a message indicating `--issues` is required.

---

### Scenario 12: `gap-analysis --no-plan` sets `noPlan` flag

**Steps:**
1. Execute `specguard gap-analysis --no-plan`.
2. Inspect the options object received by the `gapAnalysisCommand` handler.

**Expected Results:**
- The `noPlan` property of the options object is `true`.
- The `plan` property (raw Commander value) is `false`.

## Security Notes

- The `.specguard/.env` file may contain sensitive credentials (API keys, tokens). The CLI loads this file at startup and injects values into `process.env`. **Raw secret values from this file must never be logged, printed to stdout/stderr, or reproduced in generated specs or reports.**
- The `.env` loader strips surrounding single and double quotes from values but performs no further sanitisation; consumers must validate values before use.
- The `.env` file should be added to `.gitignore` to prevent accidental secret exposure in version control.
- The `--config` path is accepted as user-supplied input and passed directly to subcommand handlers; handlers are responsible for validating and safely resolving the path.

## Dependencies

- **commander** — argument parsing, subcommand dispatch, and `--help`/`--version` handling.
- **`../core/errors.js` (`SpecGuardError`)** — typed error class carrying an exit code used for controlled failure exits.
- **`../core/exit-codes.js` (`ExitCode`)** — enumeration of process exit codes, including `ExitCode.InternalError`.
- **`./commands/helpers.js` (`GlobalOpts`)** — type definition for the global `--config` option merged into every subcommand's options.
- **Individual command modules** — `reverse`, `status`, `drift`, `generate`, `heal`, `security`, `docs`, `init`, `validate`, `matrix`, `import`, `stubs`, `quality`, `deps`, `commit`, `analyze`, `plan-fix`, `gap-analysis` — each implements the business logic for its subcommand.
- **Node.js built-ins** — `node:fs` (`readFileSync`, `existsSync`), `node:path` (`join`), `node:module` (`createRequire`) for `.env` loading and version resolution.