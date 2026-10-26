---
title: "CLI Entrypoint"
sidebar_label: "CLI Entrypoint"
description: "Complete reference for the specguard CLI binary: how to invoke it, all available subcommands, their key flags, and the exit codes returned by each operation."
category: "reference"
order: 0
generated: true
---

# CLI Entrypoint

The `specguard` command is your single entry point into every SpecGuard workflow. It reads your project configuration, then hands off to the right pipeline — keeping your terminal experience consistent no matter which operation you're running.

---

## Getting help

Every part of the CLI is self-documenting.

```bash
# Print top-level usage and a list of all subcommands
specguard --help

# Print the installed package version
specguard --version

# Get help for a specific subcommand
specguard <subcommand> --help
```

---

## Configuration

By default, `specguard` looks for a configuration file at `.specguard/config.json` relative to your current working directory. You can point it at a different file with the `--config` flag:

```bash
specguard --config path/to/my-config.json <subcommand>
```

If the config file is missing, the CLI exits with an error and tells you exactly what to do:

```
Config file not found. Run `specguard init` to create one.
```

---

## Subcommands

Each subcommand maps directly to a SpecGuard pipeline. The table below shows every available command alongside its most commonly used flags.

| Command | What it does | Key flags |
|---|---|---|
| `init` | Scaffolds `.specguard/config.json` and `specs/README.md` in your project (only creates files that don't already exist) | `--with-playwright` |
| `import <file>` | Imports an existing spec or API definition file into SpecGuard | `--app`, `--format` |
| `reverse` | Reverse-generates a spec from your existing codebase or tests | `--app`, `--file`, `--force` |
| `generate` | Forward-generates test or code artefacts from a spec | `--spec`, `--all`, `--framework` |
| `heal` | Attempts to automatically fix broken tests against a spec | `--spec`, `--all`, `--max-retries` |
| `validate` | Validates a live application against its spec | `--spec`, `--all`, `--url`, `--auth`, `--out` |
| `security` | Runs security checks against a spec | `--spec`, `--all`, `--with-sast` |
| `docs` | Generates documentation from a spec | `--spec`, `--all`, `--out` |
| `drift` | Detects drift between specs and the current state of your code or API | `--since`, `--spec` |
| `matrix` | Produces a coverage matrix across all specs | `--out`, `--format` |
| `status` | Shows an at-a-glance summary of spec coverage across your project | _(none)_ |
| `check` | Spec health for the whole system. The summary starts with one `STATEMENT:` line per capability (approved, testable, aligned and conforms, each `ok`, `FAIL` or `??`) and a system line, then the ownership, test and proof lines | `--explain <capability>`, `--strict`, `--since <ref>` (or `--base <ref>`), `--no-notes`, `--json` |
| `spec approve [targets...]` | A person approves requirements as stating what the system should do, recorded as a committed history entry. A dry run unless `--yes`; refused inside an agent environment | `--all`, `--as-built`, `--by`, `--note`, `--yes` |
| `spec approvals` | Per capability, how many requirements are approved and which are not | _(none)_ |
| `change start <capabilities...>` | Opens a spec-first change: one committed record of intent under `.specguard/changes/` | `--refactor`, `--spike`, `--why`, `--base`, `--plan` |
| `change status [id]` | Where a change stands (spec, tests, red, code, green, validated), what blocks it and the one next command; every open change on the branch without an id | `--base`, `--json` |
| `change list` | Open changes with their derived stage | `--all` |
| `change red [id]` | Runs exactly the tests of the changed requirements against the base code and records the run; they must fail. Provisional: CI proves it again | `--base` |
| `change green [id]` | Runs those tests against the current code and records the run | `--base` |
| `change report [id]` | The proof packet for a change, built locally and marked provisional | `--base`, `--json` |
| `change convert [id]` | Turns a spike into a feature once it has changed requirements and tagged tests | `--to feature` |
| `change done [id]` | Closes a validated change; an earlier close is labelled in the packet | `--force --why <text>` |
| `change abandon [id]` | Closes a change without finishing it; the guard and CI then ignore it | `--why <text>` (required) |
| `enforce show [capabilities...]` | Each capability's enforce level (`observe`, `warn` or `enforce`), where it comes from, and whether it could be raised now | _(none)_ |
| `enforce raise <capabilities...>` | Raises the level one step, or to `--to`. Moving to `enforce` needs the capability to be certified (exit 13 otherwise). A person runs it, never an agent | `--to`, `--by` |
| `enforce lower <capabilities...>` | Lowers the level; recorded in history because it weakens policy. A person runs it, never an agent | `--to`, `--why` (required), `--by` |
| `hook pre-tool-use` | The agent edit guard: reads the host's tool call as JSON on stdin and prints its decision. Fails open, silent outside a SpecGuard project | `--agent claude\|codex` |
| `hook doctor [paths...]` | Prints what the guard would decide for a path or a shell command, and why | `--tool`, `--bash`, `--agent` |
| `hook log` | The guard's recent decisions, newest last | `--denied`, `--limit` |
| `hook build-index` | Rebuilds the ownership index the guard reads | _(none)_ |
| `proof fetch` | Fetches the CI proof notes (`refs/notes/specguard`) so `check` sees what CI proved | `--configure`, `--quiet`, `--if-older <duration>` |
| `proof publish` | Writes the proof note for HEAD from fresh evidence and pushes it. CI only; `--force-local` writes a provisional note on this machine | `--commit`, `--no-push`, `--force-local`, `--allow-non-github` |
| `proof notes [commit]` | Summarizes the nearest proof note: rows by verdict, its statement, and where this checkout's evidence comes from | _(none)_ |
| `proof prune` | Lists proof notes of commits no branch or tag reaches (removes them with `--yes`) | `--days`, `--yes`, `--push` |
| `ci run` | The CI gate: proves the pull request or commit, posts the proof packet, writes the proof note; exits 13 when an enforce capability blocks | `--event`, `--dry-run`, `--full`, `--no-tests`, `--no-red`, `--no-push`, `--no-comment`, `--out` |
| `ci packet [file]` | Renders a saved `packet.json` as the pull request markdown | _(none)_ |
| `ci doctor` | Checks the environment, permissions and what `ci run` would do here, with no network | `--event` |
| `overlay add <dir>` | Scans an overlay repository (one `.specguard/config.json` per app, each `apps[].repo` pointing at the real repo), shows what it covers and what it skipped, and registers it in the per-user registry. Writes nothing into the app repos; refuses a directory with no usable config | `--json` |
| `overlay list` | The registered overlays and `SPECGUARD_OVERLAY` roots, with the repos each covers; stale entries (config deleted) are flagged | `--json` |
| `overlay remove <dir>` | Forgets a registered overlay; its files are not touched | `--json` |
| `overlay refresh [dir]` | Rescans one or all registered overlays and reports what was added or removed | `--json` |
| `overlay resolve [dir]` | Which config, overlay and app a directory resolves to, or why none. Read-only; exit 0 when configured, 1 when not (including an ambiguous repo) | `--json` |
| `migrate` | Brings a repository to the current layout. A dry run that lists every step; `--yes` applies those the tool may do itself (it never approves, commits or pushes) | `--yes`, `--consolidate`, `--allow-dirty`, `--json` |
| `test run [files...]` | Runs the configured tests and ingests the results into the proof ledger; with `--claims` runs exactly the tests tagged to those requirements | `--claims <refs...>`, `--record <id>`, `--coverage`, `--app` |
| `coverage ingest <files...>` | Normalizes lcov, JaCoCo, Cobertura or Go coverage reports into evidence | `--format`, `--capability`, `--selection`, `--run-id`, `--origin` |
| `mutation ingest <files...>` | Normalizes a Stryker report or PIT `mutations.xml` into evidence | `--format`, `--run-id`, `--origin` |
| `agent pending` | Lists the model requests waiting for the host coding agent (exit 12 when there are any) | `--full` |
| `agent answer <hash>` | Records the answer to a pending request | `--file`, `--stdin` |

`check --explain <capability>` lists that capability's pillars, the blocking reasons first with the command that fixes each, then the advisory ones. `check --strict` judges the statement as if every `proof.require*` gate were on, whatever the config says. `check --since <ref>` also compares changed claims, coverage and weakened tests with that ref. With `--json` the result carries the full `statement`. `check` also reads the CI proof notes in git (see `proof fetch`); `--no-notes` ignores them and reads the local proof cache alone.

### The change protocol

`change`, `enforce` and `hook` implement the order spec, approval, tests, red, code, green, validated (see "The change protocol" in the README). `change red` and `change green` are thin wrappers over `test run --claims <refs> --record <id>`. `change convert`, `change done --force` and `change abandon` change what CI will accept, so they are CLI-only and the guard denies them to an agent. Commands that take an optional `[id]` act on the one open change on the branch, and ask you to name one when there are several. `proof publish` and `ci run` write CI evidence; a capability is `certified` only from such a note, and the same proof from a local run is `provisional`.

> **Tip:** Run `specguard <subcommand> --help` to see the full flag reference for any individual command.

---

## Exit codes

`specguard` uses a consistent set of exit codes so you can integrate it reliably into CI pipelines, shell scripts, and other tooling.

| Code | Meaning |
|------|---------|
| `0` | All checks passed / command succeeded |
| `1` | Internal error — unexpected failure, missing config, or bad arguments |
| `2` | Validation failed — critical or major issues were found |
| `3` | Drift detected — one or more specs are stale |
| `4` | Missing specs — uncovered features were found by `status` |
| `5` | Security issues found |
| `7` | Heal failed — tests are still broken after the maximum number of retries |
| `12` | Waiting for the agent — a step needs a model answer; run `specguard agent pending`, answer, and run the same command again |
| `13` | Not certified — `check` found a blocking reason in the proof statement. Only returned when a `proof.require*` gate (or `--strict`) is on, and after codes 2, 3 and 4. Also returned by `enforce raise --to enforce` for a capability that is not certified, and by `ci run` when an `enforce` capability blocks |

### Example: failing a CI job on drift

```bash
specguard drift --since main
if [ $? -eq 3 ]; then
  echo "Specs are out of date — please update them before merging."
  exit 1
fi
```

---

## Unknown subcommands

If you type a subcommand that SpecGuard doesn't recognise, the CLI prints a clear error message and exits with code `1`. No silent failures.

```bash
$ specguard frobnicate
Error: Unknown subcommand "frobnicate". Run `specguard --help` to see available commands.
```
