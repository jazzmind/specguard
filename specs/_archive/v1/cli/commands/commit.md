# specguard commit Command

<!-- module: specguard-cli/commands/commit / type: cli-command / status: draft -->

## Overview

The `specguard commit` command stages and commits SpecGuard-generated files to git by delegating to the `runGitOps` pipeline. It accepts optional flags to control dry-run behaviour, a custom commit message, a target app scope, and an originating pipeline name used to enrich commit messages and changelogs. After the git operation completes, the command prints all result messages to stdout followed by a summary line indicating how many files were staged. The process exits with the exit code returned by `runGitOps`.

## Acceptance Criteria

- AC-1: The command loads CLI configuration via `loadCliConfig` before executing any git operations.
- AC-2: When `--dry-run` is supplied, no files are actually committed and the summary line includes the text `(dry-run)`.
- AC-3: When `--dry-run` is not supplied, the summary line does not include `(dry-run)`.
- AC-4: When `--pipeline` is supplied, a `context` object containing `pipeline` and `summary` (equal to `--message`) is forwarded to `runGitOps`.
- AC-5: When `--pipeline` is not supplied, `context` is `undefined` in the call to `runGitOps`.
- AC-6: All messages returned in `result.messages` are printed to stdout, one per line, before the summary line.
- AC-7: The summary line reports the exact count of staged files as returned by `result.created`.
- AC-8: The process exits with the exit code provided by `result.exitCode`.

## Scenarios

### Scenario 1: Successful commit without optional flags

**Steps:**
1. Invoke `commitCommand({})` with no optional flags set.
2. Observe the arguments passed to `runGitOps`.
3. Capture all output written to `process.stdout`.
4. Observe the value passed to `process.exit`.

**Expected Results:**
- `runGitOps` is called with `dryRun: undefined`, `message: undefined`, `app: undefined`, and `context: undefined`.
- Each string in `result.messages` appears on its own line in stdout output.
- The final stdout line matches `commit: <N> file(s) staged` where `<N>` equals `result.created`.
- `process.exit` is called with `result.exitCode`.

---

### Scenario 2: Dry-run mode

**Steps:**
1. Invoke `commitCommand({ dryRun: true, message: 'test commit' })`.
2. Capture all output written to `process.stdout`.
3. Observe the arguments passed to `runGitOps`.

**Expected Results:**
- `runGitOps` receives `dryRun: true`.
- The final stdout line ends with `(dry-run)`.
- No actual git commit is performed (verified by `runGitOps` mock receiving `dryRun: true`).

---

### Scenario 3: Commit with pipeline context

**Steps:**
1. Invoke `commitCommand({ pipeline: 'my-pipeline', message: 'generated specs' })`.
2. Observe the `context` argument passed to `runGitOps`.

**Expected Results:**
- `runGitOps` receives `context: { pipeline: 'my-pipeline', summary: 'generated specs' }`.

---

### Scenario 4: Commit without pipeline flag omits context

**Steps:**
1. Invoke `commitCommand({ message: 'manual commit' })` with no `pipeline` option.
2. Observe the `context` argument passed to `runGitOps`.

**Expected Results:**
- `runGitOps` receives `context: undefined`.

---

### Scenario 5: Non-zero exit code propagates

**Steps:**
1. Configure the `runGitOps` mock to return `{ exitCode: 1, created: 0, messages: ['error: nothing to commit'] }`.
2. Invoke `commitCommand({})`.
3. Observe the value passed to `process.exit`.

**Expected Results:**
- stdout contains the line `error: nothing to commit`.
- The summary line reads `commit: 0 file(s) staged`.
- `process.exit` is called with `1`.

---

### Scenario 6: App scope is forwarded

**Steps:**
1. Invoke `commitCommand({ app: 'my-app' })`.
2. Observe the arguments passed to `runGitOps`.

**Expected Results:**
- `runGitOps` receives `app: 'my-app'`.

## Security Notes

- No credentials, tokens, or secret values are handled or stored by this command.
- Commit messages supplied via `--message` are passed directly to `runGitOps`; callers must ensure message content does not include sensitive data before invocation.
- Configuration is loaded through `loadCliConfig`, which is responsible for any credential or secret handling; this command does not access secrets directly.

## Dependencies

- `../../pipelines/git-ops` — provides `runGitOps`, which performs the underlying git staging and commit operations.
- `./helpers` — provides `loadCliConfig` for resolving CLI configuration and the `GlobalOpts` type.
- Node.js `process.stdout` and `process.exit` — used for output and exit-code propagation.