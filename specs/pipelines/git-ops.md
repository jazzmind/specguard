# Git-Ops Pipeline

<!-- module: specguard-pipelines/git-ops / type: pipeline / status: draft -->

## Overview

The Git-Ops pipeline stages and commits SpecGuard-generated files to a Git repository on behalf of the `specguard commit` CLI command. It restricts all staging operations to a configurable set of safe root directories (`tests/`, `docs/`, `specs/`, `.specguard/` by default), ensuring hand-written source code under paths such as `src/`, `app/`, or `lib/` is never touched. Files outside the safe roots are silently skipped and reported in the pipeline log. A `--dry-run` flag allows previewing which files would be staged and committed without making any changes. Commit messages follow the format `specguard: <pipeline> — <summary>` or `specguard: <custom message>` when `--message` is supplied.

## Acceptance Criteria

1. Only files whose relative paths begin with an allowed safe root prefix are staged; all others are skipped.
2. When `--dry-run` is active, no `git add` or `git commit` commands are executed and the log contains `[git-ops] dry-run complete — no changes made`.
3. When the working tree is clean (no changed files), the pipeline exits successfully with the message `[git-ops] nothing to commit — working tree clean`.
4. When no changed files fall within the safe roots, the pipeline exits successfully with the message `[git-ops] no SpecGuard-generated files to commit`.
5. When `git` is not available, the pipeline exits with `ExitCode.InternalError` and logs `[git-ops] git not available`.
6. A successful commit logs the short SHA and the full commit message, and sets `result.created` to the number of staged files.
7. The auto-generated commit message lists the unique top-level directory names of staged files and their count (e.g., `specguard: generated — 3 file(s) in tests, specs`).
8. When `--message` is provided, the commit message is `specguard: <provided message>` with no auto-generated summary appended.
9. When `git add` fails, the pipeline exits with `ExitCode.InternalError` and logs the stderr output.
10. When `git commit` fails, the pipeline exits with `ExitCode.InternalError` and logs the stderr output.
11. The safe root set can be overridden via `opts.scope`; the override fully replaces the default roots.
12. When more than 10 files are skipped, the log shows the first 10 skipped paths and a trailing count of the remainder.

## Scenarios

### Scenario 1: Clean working tree produces no commit

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0` and `git status --porcelain` returns an empty string.
2. Call `runGitOps(config, {})`.

**Expected Results:**
- The returned `result.exitCode` is the default success code (not `ExitCode.InternalError`).
- `result.messages` contains exactly one entry matching `[git-ops] nothing to commit — working tree clean`.
- `gitRunner.exec` is never called with `['add', ...]` or `['commit', ...]`.

---

### Scenario 2: Dry-run with stageable files makes no Git changes

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0` and `git status --porcelain` returns two lines: `M  tests/foo.spec.ts` and `M  specs/bar.md`.
2. Call `runGitOps(config, { dryRun: true })`.

**Expected Results:**
- `result.messages` contains a line matching `[git-ops] [dry-run] staging 2 file(s):`.
- `result.messages` contains `  + tests/foo.spec.ts` and `  + specs/bar.md`.
- `result.messages` contains `[git-ops] dry-run complete — no changes made`.
- `gitRunner.exec` is never called with args beginning with `add` or `commit`.
- `result.exitCode` is the default success code.

---

### Scenario 3: Files outside safe roots are skipped; safe files are committed

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0`, `git status --porcelain` returns three lines: `M  tests/a.spec.ts`, `M  src/core/engine.ts`, and `M  lib/utils.ts`, and both `git add` and `git commit` return status `0`.
2. Stub `git rev-parse --short HEAD` to return `abc1234`.
3. Call `runGitOps(config, {})`.

**Expected Results:**
- `result.messages` contains a line matching `[git-ops] skipped 2 file(s) outside safe scope:`.
- `result.messages` contains `  skip: src/core/engine.ts` and `  skip: lib/utils.ts`.
- `gitRunner.exec` is called with `['add', '--', 'tests/a.spec.ts']` and no other file paths.
- `result.messages` contains a line matching `[git-ops] committed: abc1234 — specguard: generated — 1 file(s) in tests`.
- `result.created` equals `1`.

---

### Scenario 4: Custom commit message is used verbatim with prefix

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0`, `git status --porcelain` returns `M  docs/api.md`, and both `git add` and `git commit` return status `0`.
2. Stub `git rev-parse --short HEAD` to return `def5678`.
3. Call `runGitOps(config, { message: 'update API docs' })`.

**Expected Results:**
- `gitRunner.exec` is called with `['commit', '-m', 'specguard: update API docs']`.
- `result.messages` contains a line matching `[git-ops] committed: def5678 — specguard: update API docs`.
- The commit message does not contain any auto-generated file count or directory summary.

---

### Scenario 5: Git not available returns InternalError

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `1`.
2. Call `runGitOps(config, {})`.

**Expected Results:**
- `result.exitCode` equals `ExitCode.InternalError`.
- `result.messages` contains `[git-ops] git not available`.
- `gitRunner.exec` is never called with `status`, `add`, or `commit` as the first argument.

---

### Scenario 6: `git add` failure returns InternalError

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0`, `git status --porcelain` returns `M  specs/spec.md`, and `git add` returns status `1` with stderr `fatal: pathspec error`.
2. Call `runGitOps(config, {})`.

**Expected Results:**
- `result.exitCode` equals `ExitCode.InternalError`.
- `result.messages` contains a line matching `[git-ops] git add failed: fatal: pathspec error`.
- `gitRunner.exec` is never called with args beginning with `commit`.

---

### Scenario 7: `git commit` failure returns InternalError

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0`, `git status --porcelain` returns `M  .specguard/report.json`, `git add` returns status `0`, and `git commit` returns status `1` with stderr `error: nothing to commit`.
2. Call `runGitOps(config, {})`.

**Expected Results:**
- `result.exitCode` equals `ExitCode.InternalError`.
- `result.messages` contains a line matching `[git-ops] git commit failed: error: nothing to commit`.

---

### Scenario 8: Custom scope overrides default safe roots

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0`, `git status --porcelain` returns two lines: `M  output/report.txt` and `M  tests/foo.spec.ts`, and both `git add` and `git commit` return status `0`.
2. Stub `git rev-parse --short HEAD` to return `aaa0001`.
3. Call `runGitOps(config, { scope: ['output/'] })`.

**Expected Results:**
- `gitRunner.exec` is called with `['add', '--', 'output/report.txt']` and `tests/foo.spec.ts` is not included.
- `result.messages` contains a line indicating `tests/foo.spec.ts` was skipped.
- `result.created` equals `1`.

---

### Scenario 9: Skipped file list is truncated after 10 entries

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0` and `git status --porcelain` returns 12 lines all under `src/` (e.g., `M  src/file01.ts` through `M  src/file12.ts`).
2. Call `runGitOps(config, {})`.

**Expected Results:**
- `result.messages` contains a line matching `[git-ops] skipped 12 file(s) outside safe scope:`.
- Exactly 10 individual `  skip: src/fileXX.ts` lines appear in `result.messages`.
- `result.messages` contains a line matching `  ... and 2 more`.
- `result.messages` contains `[git-ops] no SpecGuard-generated files to commit`.

---

### Scenario 10: No changed files fall within safe roots

**Steps:**
1. Stub `gitRunner.exec` so that `git --version` returns status `0` and `git status --porcelain` returns `M  src/index.ts`.
2. Call `runGitOps(config, {})`.

**Expected Results:**
- `result.messages` contains `[git-ops] no SpecGuard-generated files to commit`.
- `result.exitCode` is the default success code.
- `gitRunner.exec` is never called with args beginning with `add` or `commit`.

## Security Notes

- The pipeline must never stage or commit files outside the configured safe root prefixes. Path matching normalises backslashes to forward slashes before comparison to prevent Windows path separator bypass.
- The `opts.scope` override is accepted only from trusted internal callers (programmatic API or the authenticated CLI); it must not be derived from untrusted user input without validation.
- No credentials, tokens, or API keys are present in this module. Any future integration with remote Git operations (push) must not embed authentication material in commit messages or log output.
- `spawnSync` is invoked with a fixed `'git'` executable and caller-controlled argument arrays; callers must not pass unsanitised user strings as file paths to avoid argument injection.

## Dependencies

| Dependency | Role |
|---|---|
| `node:child_process` (`spawnSync`) | Executes Git sub-commands |
| `node:path` | Resolves workspace root and normalises file paths |
| `../core/types` (`SpecGuardConfig`, `PipelineResult`, `emptyResult`) | Shared pipeline result and configuration types |
| `../core/exit-codes` (`ExitCode`) | Standardised exit code constants |
| `gitRunner` (internal seam) | Replaceable wrapper around `spawnSync` to enable test stubbing |