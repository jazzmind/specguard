---
id: integration-surfaces
kind: capability
title: Integration Surfaces - CLI, Agents, CI, IDE and Plugins
parent: system
value: People, coding agents and other systems can drive SpecGuard from wherever they work (terminal, agent harness, CI or IDE) and extend it without forking it.
status: active
sources:
  - "src/cli/index.ts"
  - "src/cli/commands/helpers.ts"
  - "src/cli/commands/init.ts"
  - "src/cli/commands/stubs.ts"
  - "src/cli/commands/index.ts"
  - "src/mcp/**"
  - "src/core/scaffold.ts"
  - "src/core/runner.ts"
  - "src/pipelines/init.ts"
  - "src/cli/plugin-commands.ts"
  - "src/plugins/**"
  - "action/**"
  - "action.yml"
  - "extension/src/**"
  - "extension/webview/src/**"
tests:
  - "tests/action/run-gates.test.ts"
  - "tests/mcp/*.test.ts"
  - "tests/core/cli.test.ts"
  - "tests/core/exit-codes.test.ts"
  - "tests/core/version.test.ts"
  - "tests/core/scaffold.test.ts"
  - "tests/core/runner.test.ts"
  - "tests/core/mcp-server.test.ts"
  - "tests/core/extension.test.ts"
  - "tests/cli/features.test.ts"
  - "tests/pipelines/init.test.ts"
  - "tests/pipelines/feature-state.test.ts"
  - "tests/pipelines/feature-state-collect.test.ts"
  - "tests/pipelines/git-ops-changelog.test.ts"
  - "tests/pipelines/git-ops-scope.test.ts"
  - "tests/plugins/*.test.ts"
  - "tests/core/neutral.test.ts"
  - "extension/src/**/*.test.ts"
docs:
  - "README.md"
  - "docs/ci.md"
  - "docs/ci-remediate.md"
  - "docs/user/cli.md"
  - "docs/user/mcp-server.md"
  - "docs/user/extension.md"
  - "docs/user/exit-codes.md"
  - "docs/examples/**"
  - "docs/feature-catalog.md"
  - "extension/README.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
---

# Integration Surfaces - CLI, Agents, CI, IDE and Plugins

## Problem & Value
A spec-driven tool is only useful if it fits into how work is actually done. Developers live in a terminal, coding agents in a harness such as an agent CLI or an editor, release managers in CI, and reviewers in an IDE. If each of those needed different setup, behaved differently, or silently changed the user's own configuration, SpecGuard would not be adopted or trusted. Teams also have platform-specific conventions (feature catalogs, test-management ids, lint tools) that must not be hard-wired into the core.

This capability is the set of surfaces through which people, agents and systems drive SpecGuard: one command line with stable exit codes and machine-readable output, an `init` that sets a project up and wires agents in without clobbering anything, an MCP server that exposes the same operations to agents, a GitHub Action that turns checks into pass or fail gates, a VS Code extension with a dashboard, and a plugin system for optional, generalised features such as the feature catalog, code quality and git helpers.

## Users & Journeys
- A developer runs `specguard init` in a repo and gets a config, a specs directory and agent files; running it again changes nothing.
- A coding agent starts a session, finds the MCP server and the CLAUDE.md or AGENTS.md instructions that init wrote, and calls tools such as `specguard_status` and `specguard_drift` after each change.
- A release manager adds the GitHub Action with `fail-on: drift,proof-failed` so a pull request fails on the right conditions, and schedules `mode: remediate` for dependency fixes.
- A reviewer opens the VS Code dashboard to see coverage, last pipeline runs and agent activity without leaving the editor.
- A platform team enables `feature-catalog` by name and describes its catalog layout, id scheme and result sources in `featureState` config; an unknown plugin name is reported, not ignored.
- A team lead runs `specguard features --state` to see, per catalogued feature, which of UI, API and MCP are built, passing or proven and whether an agent may run on it.
- A developer runs `specguard quality` and `specguard commit` to lint and commit only SpecGuard-generated files.

## Requirements
- [ ] The `specguard` command routes each subcommand to its pipeline and prints help for every subcommand; `--version` prints the package version and `--version --json` prints one JSON line with name, version and Node version; an unknown subcommand exits non-zero with a usage hint; global options `--config <path>` (a file, a directory, or a path containing `/.specguard/`), `--json` (machine-readable result with the exit code, human output suppressed) and `--record` reach every command <!-- claim: cli-routing-and-flags -->
- [ ] Exit codes are typed and stable (0 success, 1 internal or usage error, 2 validation failed, 3 drift, 4 missing specs, 5 security issues, 7 heal failed, 8 LLM budget exceeded); a SpecGuard error prints its message to stderr and exits with its own code, an unexpected error exits 1, and a refused LLM call for budget forces exit 8; a missing config exits 1 with the instruction to run `specguard init`, and `.specguard/.env` variables are loaded before commands run without overwriting existing environment variables <!-- claim: exit-codes-and-env -->
- [ ] `init` creates `.specguard/config.json`, `specs/README.md` and a `.specguard/.env` containing only a placeholder key, detects the language and test framework (Playwright forced by `--with-playwright`), never overwrites existing files and reports created and skipped paths; it adds a managed git-ignore block for generated state and prints the untrack command when git already tracks such files <!-- claim: init-bootstrap -->
- [ ] `init` and `scaffold` generate agent-harness files for Claude, Cursor or both: a CLAUDE.md with managed sections, per-harness skill files, a goal command and AGENTS.md, all marked as SpecGuard-managed and using language-specific commands; a marked file is refreshed, an unmarked hand-written file is left alone, and content outside managed sections is preserved <!-- claim: harness-files -->
- [ ] Setup merges an MCP server entry and a post-edit status hook into the agent's settings without removing unrelated keys (malformed existing JSON is reported and left unchanged); the generated commands use a resolved runner (`--runner node|npx|path`, otherwise `SPECGUARD_CLI`, a local binary, a global binary, then `npx -p specguard-ai specguard`); an entry written in an older broken form is repaired, and any other differing existing entry is never rewritten silently: a diff is printed and the file left alone unless `--update-hooks` is given <!-- claim: agent-wiring-and-runner -->
- [ ] The MCP server runs over stdio, registers one tool per CLI command plus `read_spec` and `write_spec`, calls the same pipeline functions as the CLI with an optional `cwd`, returns a text summary (counts, messages, items, raw result) and returns an error result instead of throwing; importing the module does not start the transport <!-- claim: mcp-tools-parity -->
- [ ] Every MCP tool call appends a running entry and then a pass, fail or error entry with duration to `.specguard/activity-log.json`, which is bounded to the latest 200 entries once it exceeds 1 MB, recovers from invalid JSON and never throws; `read_spec` needs a spec key or path; MCP tools never perform effects outside the machine (remediate is scan-only and dry-run only, commit stages only SpecGuard-generated files) <!-- claim: mcp-activity-and-limits -->
- [ ] The GitHub Action installs the requested SpecGuard version, runs the chosen gates in a fixed order (status, drift, proof, align, results, validate, security, deps), rejects an unknown gate before running anything, writes a job summary and per-gate JSON, and uploads `.specguard/` as evidence excluding secrets and auth state <!-- claim: action-gates -->
- [ ] `fail-on` thresholds (missing-specs, drift, proof-failed, proof-stale, proof-unexercised, proof-unproven, align-below:<n>, results, validate, security, deps, none) fail the job from the gates' exit codes; a gate that did not run, or a missing proof ledger, never fails the job <!-- claim: action-fail-on -->
- [ ] `mode: remediate` runs `specguard remediate` instead of the gates, adds `--pr` when asked, exposes the exit code, fails only on exit 1 or 11, and never merges; a release tag must equal the package version with the CLI published before the extension <!-- claim: action-remediate-and-release -->
- [ ] The VS Code extension adds an activity-bar sidebar and a singleton dashboard panel that run the CLI (resolved from a setting, a local binary or npx) and read `.specguard` files for coverage, pipeline status, drift, traceability and agent activity; commands needing a workspace report when none is open, the project can be switched, and no secrets are passed through <!-- claim: vscode-dashboard -->
- [ ] Optional behaviour is added through plugins named in `config.plugins`: a plugin may supply commands, catalog providers, implementation discoverers, external-id adapters, result sources, feature-state tuning, module stems and contract importers; an unknown or malformed plugin name is a configuration error where a pipeline loads it, and core never imports a plugin by name <!-- claim: plugin-contract -->
- [ ] The feature catalog (the `feature-catalog` plugin) is a directory of YAML parsed with a real YAML parser and validated against a schema (an unversioned or malformed file or a duplicate feature id is an error naming the file; `catalogFormat: list` reads bare lists); built-in GraphQL, REST and tRPC discoverers and the generic, Zephyr and Jira external-id adapters need no other plugin, and `specguard features` lists each spec's feature back-references <!-- claim: feature-catalog -->
- [ ] `features --state` reports per feature a summary, required channels and a state for UI, API and MCP (no, stub, built, broken, passing, proven) from specs, discovered implementations and test results matched by feature id, tag or external id, plus an agent gate that opens only on a latest passing unit or integration test; with no catalog it prints `[]` with a note and does not fail <!-- claim: feature-state -->
- [ ] `quality` runs ESLint and Knip (and Ruff for Python) for every app or one app, can auto-fix lint issues, normalises findings into `.specguard/code-quality.json` with error and warning totals, exits 2 only when lint errors exist, treats an unavailable tool as a warning, and rejects an unknown app name with the list of known ones <!-- claim: code-quality -->
- [ ] `commit` stages and commits only SpecGuard-generated paths (tests, docs, specs, `.specguard/` and the directories the config writes to), supports `--dry-run`, a custom message and an originating pipeline, reports a clean tree or nothing to commit with success, fails with exit 1 when git is missing or git add or commit fails, and appends each commit to `.specguard/changelog.md` <!-- claim: git-helpers -->
- [ ] Planned: the command set is reduced to about 14 top-level commands and the MCP server to about 15 tools that mirror them plus `read_spec`, `write_spec`, trace and history tools, with old gate and command names kept as aliases for a transition period <!-- claim: planned-reduced-surface -->
- [ ] Plugin commands are registered on the CLI as `specguard <name>` and on the MCP server as `specguard_<name>` (with typed inputs when the command declares them), only while the plugin is enabled; config is read before commands are parsed, core commands and tools win a name clash, and a plugin that cannot be loaded is reported once and skipped so `init` still works with a broken config <!-- claim: plugin-commands -->
- [ ] Planned: plugins gain the extension points `detectors` and `docRenderers`, and npm plugins load only from an explicit `{name, package}` allowlist in config because importing a package runs its code <!-- claim: planned-plugin-extensions -->
- [ ] `init --history-hooks` installs history hooks (into `.claude/settings.local.json`, personal and uncommitted) so prompts and plans are captured into the requirement history automatically, using the same safe, idempotent merge rules as the existing hooks <!-- claim: planned-history-hooks -->
- [ ] The feature catalog's layout is entirely `featureState` config (catalog directory and format, results directories, id rules, placeholder and MCP patterns, repo channels, module stems, and where agent tools are declared and which of them do not count); no platform's layout is built in, and a test fails if a customer platform is named anywhere in code, docs or specs <!-- claim: catalog-layout-config -->
- [ ] The `contract-mappings` plugin adds contract edges from a JSON file of spec-to-provider mappings whose location and key names are `contractMappings` config, with plain defaults, and yields nothing for a missing or malformed file <!-- claim: contract-mappings-importer -->
- [ ] Core reaches optional functionality only through enabled plugins: `analyze` runs code quality only when a plugin provides a `quality` command and says so when none does <!-- claim: core-plugin-boundary -->

## Scenarios
### Scenario 1: Bootstrap a project for humans and agents
**Steps:**
1. In a clean repository the developer runs `specguard init`.
2. They run it a second time.

**Expected Results:**
- The config, specs directory, `.env` placeholder, git-ignore block, agent instruction files and MCP and hook wiring exist, and stdout lists what was created and next steps.
- The second run reports every path as skipped and modifies nothing.
- No real secret is written.

### Scenario 2: Existing hook differs from the generated one
**Steps:**
1. The user has customised the post-edit hook in `.claude/settings.json`.
2. They run `specguard scaffold`.

**Expected Results:**
- A diff of old versus new is printed and the file is unchanged.
- Running `specguard scaffold --update-hooks` applies the change.
- Unrelated settings keys are preserved either way.

### Scenario 3: An agent drives SpecGuard over MCP
**Steps:**
1. An agent starts the MCP server and calls `specguard_status` then `specguard_drift`.
2. A call fails because of a bad argument.

**Expected Results:**
- Each call returns a text summary with counts and messages, and writes running and pass or fail entries to the activity log that the dashboard displays.
- The failed call returns an error result and the server keeps running.

### Scenario 4: Pull request gate in CI
**Steps:**
1. A workflow uses the Action with `gates: status,drift,proof` and `fail-on: drift,proof-failed`.
2. A pull request introduces drift.

**Expected Results:**
- The drift gate exits 3, the threshold trips and the job fails with a summary naming the tripped rule.
- Per-gate JSON and the evidence artifact are uploaded without secrets.
- A gate that was not requested cannot fail the job.

### Scenario 5: Misspelt plugin
**Steps:**
1. The config lists `plugins: ["typo"]`.
2. The user runs any command that loads plugins.

**Expected Results:**
- The CLI reports `plugins not loaded: unknown plugin 'typo'` once and registers none of that plugin's commands, and a pipeline that needs the plugin fails with a configuration error naming it.

### Scenario 6: Feature alignment report
**Steps:**
1. A catalog directory lists two features; tests and specs link to them.
2. The user runs `specguard features --state`.

**Expected Results:**
- Each feature shows its summary, required channels and a state per channel.
- A feature with only a passing end-to-end result has a proven channel, while one with a failing latest result shows broken.
- The agent gate is open only for a feature with a passing unit or integration test.

### Scenario 7: Commit generated files only
**Steps:**
1. The working tree contains new generated tests and an unrelated source change.
2. The user runs `specguard commit --dry-run`, then `specguard commit`.

**Expected Results:**
- The dry run lists what would be staged and changes nothing.
- The real run commits only the generated tests, skipping the source change, and logs the entry in `.specguard/changelog.md`.

## Security & Data Considerations
- Setup writes agent configuration files that can run commands (hooks and MCP servers), so it never overwrites an existing entry silently, prints a diff instead, and always writes the exact runner it resolved.
- `.specguard/.env` holds API keys; it contains only a placeholder at creation, is git-ignored by the managed block, and is excluded from CI evidence uploads along with auth state.
- Environment loading never overrides variables already set; logs and results never include key values.
- MCP tools run with the user's privileges but are limited to read, generate and report operations; remediation over MCP is read-only and the commit tool stages only generated files.
- Plugins are code. Built-in plugins load only by name from a known location, and the planned npm plugin loader accepts only an explicit allowlist because importing a package executes it.
- The Action's token is only needed in remediate mode and only for push and pull request creation; nothing is ever merged.

## Interfaces
- CLI: `specguard <command>` with global `--config`, `--json`, `--record`; setup commands `init` (`--with-playwright`, `--language`, `--harness claude|cursor|both`, `--single`, `--runner node|npx|path`, `--runner-path`, `--update-hooks`) and `scaffold`; plus the commands of enabled plugins: `features [--state] [--cases <file>]` (feature-catalog), `quality [--app] [--fix]` (quality), `commit [--dry-run] [--message] [--app] [--pipeline]` (git).
- MCP: binary `specguard-mcp` over stdio, tools named `specguard_<command>` (including `specguard_scaffold`, `specguard_read_spec`, `specguard_write_spec`), plus `specguard_<command>` for each enabled plugin command (`specguard_features`, `specguard_quality`, `specguard_commit`).
- Files written: `.specguard/config.json`, `.specguard/.env`, `.specguard/activity-log.json`, `.specguard/code-quality.json`, `.specguard/changelog.md`, `.specguard/ci/<gate>.json`, `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.claude/skills/specguard/SKILL.md`, `.claude/commands/goal.md`, `.cursor/mcp.json`, `.cursor/skills/specguard/SKILL.md`.
- Config keys: `plugins`, `featureState` (catalog, catalogFormat, reporters, resultsDirs, externalIds, channelByType, repoChannels, moduleStems, idSkipSegments, placeholderSummaryPattern, mcpModulePattern, agentTools), `contractMappings`, `runners`, `llm.*`.
- GitHub Action inputs: `mode`, `gates`, `fail-on`, `results`, `run-id`, `drift-since`, `validate-url`, `version`, `working-directory`, `remediate-args`, `open-pr`, `github-token`, `upload-evidence`; output `remediate-exit`.
- VS Code: view container `specguard-sidebar`, commands such as `specguard.openDashboard`, `specguard.status`, `specguard.registerMcp`, settings `specguard.cliPath`, `specguard.autoRefresh`, `specguard.showStatusBar`.
- Exit codes: 0 to 5, 7 and 8 as listed above; remediate has its own 8 to 11.

## Out of Scope
- Hosting a documentation site or API (see the documentation capability) and the pipelines the surfaces call, which are specified in their own capabilities.
- Platform-specific built-in integrations: anything tied to one platform's layout or id scheme is a plugin or an example configuration.
- Running tests or builds on behalf of CI beyond invoking the CLI; the Action is a thin gate runner.
- Supporting every editor: the dashboard targets VS Code and compatible editors; other editors use the CLI or MCP.
