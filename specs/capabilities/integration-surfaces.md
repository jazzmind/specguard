---
id: integration-surfaces
kind: capability
title: Integration Surfaces - CLI, Agents, CI, IDE and Plugins
parent: system
value: People, coding agents and other systems can drive SpecGuard from wherever they work (terminal, agent harness, CI or IDE) and extend it without forking it.
status: active
sources:
  - "src/core/output-locations.ts"
  - "src/cli/commands/outputs.ts"
  - "Makefile"
  - "scripts/wait-for-ci.mjs"
  - "src/cli/index.ts"
  - "src/cli/commands/helpers.ts"
  - "src/cli/commands/init.ts"
  - "src/cli/commands/agent.ts"
  - "src/cli/commands/ci.ts"
  - "src/pipelines/start.ts"
  - "plugins/**"
  - ".claude-plugin/**"
  - ".agents/**"
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
  - "extension/scripts/build.mjs"
  - "extension/webview/src/**"
  - "src/cli/commands/plugin.ts"
  - "src/pipelines/plugin-manage.ts"
  - "src/core/ci-workflow.ts"
  - "src/core/safe-path.ts"
  - "src/ci/context.ts"
  - "src/ci/github-api.ts"
  - "src/ci/pipeline-changes.ts"
  - "src/pipelines/ci-run.ts"
  - "src/cli/commands/overlay.ts"
  - "plugins/specguard/scripts/session-status.sh"
tests:
  - "tests/core/output-locations.test.ts"
  - "tests/pipelines/output-destinations.test.ts"
  - "tests/core/make.test.ts"
  - "tests/core/release-ci.test.ts"
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
  - "tests/cli/check-base.test.ts"
  - "tests/pipelines/init.test.ts"
  - "tests/mcp/agent-work-tool.test.ts"
  - "tests/plugins/plugin-package.test.ts"
  - "tests/pipelines/feature-state.test.ts"
  - "tests/pipelines/feature-state-collect.test.ts"
  - "tests/pipelines/git-ops-changelog.test.ts"
  - "tests/pipelines/git-ops-scope.test.ts"
  - "tests/plugins/*.test.ts"
  - "tests/core/neutral.test.ts"
  - "extension/src/**/*.test.ts"
  - "tests/ci/context.test.ts"
  - "tests/ci/github-api.test.ts"
  - "tests/ci/pipeline-changes.test.ts"
  - "tests/pipelines/init-codex.test.ts"
  - "tests/pipelines/ci-run.test.ts"
  - "tests/ci/ci-workflow.test.ts"
  - "tests/cli/ci.test.ts"
  - "tests/core/ci-workflow.test.ts"
  - "tests/cli/overlay.test.ts"
  - "tests/hooks/overlay.test.ts"
  - "tests/plugins/session-status.test.ts"
docs:
  - "docs/business-organization.md"
  - "docs/development.md"
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
  - 2026-10-29-output-routing-and-business-organization
  - 2026-10-29-editor-endpoint-startup
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-15-catalog-exclude
  - 2026-10-22-0-3-phase-2-plugin-management
  - 2026-10-22-0-3-phase-3-test-layers-and-ci
  - 2026-10-22-security-mcp-commit-tool-has-no-requirem
  - 2026-10-22-security-activity-log-may-capture-prompt
  - 2026-10-22-security-npm-plugin-loader-lacks-package
  - 2026-10-22-security-hardening-from-audit-sast-and-p
  - 2026-10-22-header-role-fix-and-spec-level-security
  - 2026-10-22-security-init-history-hooks-writes-to-pe
  - 2026-10-22-security-mcp-server-has-no-rate-limit-or
  - 2026-10-22-extension-runs-the-cli-under-the-host-ex
  - 2026-10-25-specguard-proves-intent-not-metrics-thre
  - 2026-10-25-0-4-the-host-coding-agent-does-the-model
  - 2026-10-26-ci-trust-approvals-are-records-ci-plumbi
  - 2026-10-26-edit-guard-hook-entry-index-and-bundle
  - 2026-10-26-ci-orchestrator-ci-run-proof-packet-and
  - 2026-10-26-overlay-spec-sources-specs-kept-outside
  - 2026-10-27-portable-ci-fixtures-and-grouped-local-d
  - 2026-10-27-consistent-install-and-build-targets-wor
  - 2026-10-27-workspace-first-extension-navigation-ver
  - 2026-10-27-keep-runtime-activity-logging-out-of-com
  - 2026-10-27-overlay-app-catalogs-and-project-plugin
  - 2026-10-28-overlay-aware-workspace-navigation-and-r
  - 2026-10-28-readable-two-column-repository-cards
  - 2026-10-28-unified-workspace-and-evidence-dashboard
  - 2026-10-28-workspace-defaults-and-secure-editor-cre
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
- [ ] CLI and editor actions resolve saved output directories per application and artifact kind, including separate unit, integration and e2e tests; generated directories join test discovery, native sources remain intact, and changing a spec root copies existing Markdown without deleting originals or overwriting conflicting content while preserving canonical spec/claim keys <!-- claim: output-destinations -->
- [ ] Before Generate, Reverse, Import, Docs or Gap Analysis writes outputs, the editor shows the application, code/config locations and chosen destination, offers established runnable directories and an alternate directory, flags mapping-only test directories, remembers the choice and scopes the action to the chosen application; cancelled routing does not start generation <!-- claim: extension-output-routing -->
- [ ] SpecGuard never stages runtime `.specguard/activity-log.json` files, including nested projects and explicit generated, dependency or code-fix scopes; a legacy tracked log can be untracked once by migration while retaining its local history, after which post-commit activity remains local <!-- claim: activity-log-never-committed -->
- [ ] The VS Code sidebar defaults to Workspace, Coverage, Pipelines and Plugins in that order; Workspace has its own independent tree and remains usable when the active repo has no coverage or its coverage load fails <!-- claim: extension-navigation-order -->
- [ ] The workspace dashboard lists every repo's configured feature catalog files, schema versions, content revision, feature-to-current-spec link coverage and missing links; it separately shows the installed extension version, last harness setup version, spec format, current Git revision and working changes, and the revision and engine version of the last spec check; absent or differing check evidence is shown as needing a refresh, and catalog links alone never claim verified content alignment <!-- claim: extension-workspace-alignment -->
- [ ] Clicking Specs, Tests or Docs in Outputs opens a searchable inventory inside VS Code, using configured directories, colocated tests and overlay spec roots while excluding archived specs and dependency/build output; files open in the editor, and authenticated team-server specs and docs can be listed and read through the existing API, with local files still available when the server cannot answer <!-- claim: extension-output-browser -->
- [ ] Before updating agent setup files, the extension explains and previews per file that CLAUDE.md retains custom rules outside SpecGuard sections, entire marked skills/commands and AGENTS.md are replaced, unmarked standalone files are skipped, and unrelated JSON settings/MCP entries are retained; cancelling runs nothing, and a failed scaffold never records a successful setup version <!-- claim: extension-setup-preview -->
- [ ] `make help` groups commands by local usage, development, validation and publishing, includes example flows for installing and running locally, developing and publishing, and explains outputs and publishing effects; `install` builds and installs this checkout's CLI and VS Code extension through `install-cli` and `install-vsix`, `install-dev` sets up locked dependencies with `npm ci` in the root, extension and webview, and `build-vsix` packages without installing; builds use installed dependencies, `install-vsix` finds `code` on PATH, in a standard macOS app location, or through an explicit `CODE` executable, and local installation and packaging never tag or publish <!-- claim: make-workflows -->
- [ ] `make release-check` and `make publish` check the latest CI workflow run on `main` for the exact commit being released, using `GH_USER` when GitHub CLI is available; a queued, requested, waiting, pending or running run is watched to completion with visible progress and proceeds only after confirmed success for that commit, while a failed, cancelled, interrupted, missing or unreadable run blocks release with an explanation before any tag or push <!-- claim: release-waits-for-ci -->
- [ ] The `specguard` command routes each subcommand to its pipeline and prints help for every subcommand; `--version` prints the package version and `--version --json` prints one JSON line with name, version and Node version; an unknown subcommand exits non-zero with a usage hint; global options `--config <path>` (a file, a directory, or a path containing `/.specguard/`), `--json` (machine-readable result with the exit code, human output suppressed) and `--record` reach every command <!-- claim: cli-routing-and-flags -->
- [ ] Exit codes are typed and stable (0 success, 1 internal or usage error, 2 validation failed, 3 drift, 4 missing specs, 5 security issues, 7 heal failed, 8 LLM budget exceeded, 12 waiting for the host agent); a SpecGuard error prints its message to stderr and exits with its own code, an unexpected error exits 1, a refused LLM call for budget forces exit 8, and model requests still waiting for the host agent force exit 12 and print what is waiting and how to answer it, even when the command went on to print its own summary; a missing config exits 1 with the instruction to run `specguard init`, and `.specguard/.env` variables are loaded before commands run without overwriting existing environment variables, a placeholder key value an older init wrote being ignored <!-- claim: exit-codes-and-env -->
- [ ] `init` creates only `.specguard/config.json` (no `llm` block) and `specs/README.md`, asks for no API key and writes no key file, detects the language and test framework (Playwright forced by `--with-playwright`), matches code kept at the repo root when there is no `src/` folder (every code file except tests, type declarations and tool configs), never overwrites existing files and reports created and skipped paths; it adds a managed git-ignore block for generated state and prints the untrack command when git already tracks such files; agent files are written only when `--harness` names a harness <!-- claim: init-bootstrap -->
- [ ] `init --harness` and `scaffold` generate agent-harness files for Claude, Cursor or both: a CLAUDE.md with managed sections, per-harness skill files, a goal command and AGENTS.md, all marked as SpecGuard-managed and using language-specific commands, and for Claude the MCP server in `.mcp.json` where Claude Code reads it; a marked file is refreshed, an unmarked hand-written file is left alone, and content outside managed sections is preserved <!-- claim: harness-files -->
- [ ] Setup merges an MCP server entry and a post-edit status hook into the agent's settings without removing unrelated keys (malformed existing JSON is reported and left unchanged); the generated commands use a resolved runner (`--runner node|npx|path`, otherwise `SPECGUARD_CLI`, a local binary, a global binary, then `npx -p specguard-ai specguard`); an entry written in an older broken form is repaired, and any other differing existing entry is never rewritten silently: a diff is printed and the file left alone unless `--update-hooks` is given <!-- claim: agent-wiring-and-runner -->
- [ ] The MCP server runs over stdio, registers one tool per core command plus `read_spec` and `write_spec` (the pre-0.2 names only with `SPECGUARD_MCP_LEGACY=1`), calls the same pipeline functions as the CLI with an optional `cwd`, returns a text summary (counts, messages, items, raw result) and returns an error result instead of throwing; importing the module does not start the transport <!-- claim: mcp-tools-parity -->
- [ ] `specguard agent pending` lists the model requests waiting for the host coding agent (exit 12 when there are any) and `specguard agent answer <hash>` records an answer from a file or stdin (a unique hash prefix of 8 or more characters is enough, a JSON answer may sit in a markdown code fence), refusing an unknown request and an answer of the wrong shape; the `specguard_agent_work` MCP tool does the same (`list` returns each request in full, `answer` records one), is one of the default tools and is not offered by a read-only server <!-- claim: agent-work-tools -->
- [ ] `specguard start` carries a project from nothing to a first report in one resumable command: it sets the project up when there is no config, drafts the specs unless `specs/system.md` exists, links tests to requirements, runs the tests (unless `--skip-tests`) and prints where things stand; when a step waits for the host agent it stops with exit 12 saying to run it again, and the rerun continues from that step <!-- claim: start-command -->
- [ ] The repository is a Claude Code plugin marketplace and a Codex plugin marketplace whose one plugin, `specguard`, installs with one line, needs no API key inside the agent and writes nothing into the project: it ships the skills (the working rules, and how to answer model requests), the `start` and `check` commands, a `specguard` executable on the agent's PATH that runs the CLI of the same minor version with the host agent doing the model work (`SPECGUARD_CLI` runs a local build), the MCP server configured the same way, and a session-start hook that prints a short status only in a project that uses SpecGuard (including one whose specs live in an overlay); both manifests carry the package's version <!-- claim: plugin-distribution -->
- [ ] Every MCP tool call appends a running entry and then a pass, fail or error entry with duration to `.specguard/activity-log.json`, which is bounded to the latest 200 entries once it exceeds 1 MB, recovers from invalid JSON and never throws; `read_spec` needs a spec key or path; MCP tools never perform effects outside the machine (remediate is scan-only and dry-run only, commit stages only SpecGuard-generated files) <!-- claim: mcp-activity-and-limits -->
- [ ] The GitHub Action installs the requested SpecGuard version, runs the chosen gates in a fixed order (status, drift, proof, align, results, validate, security, check, test, verify, scan; `deps` is an alias of `scan`), rejects an unknown gate before running anything, writes a job summary and per-gate JSON, and uploads `.specguard/` as evidence excluding secrets and auth state <!-- claim: action-gates -->
- [ ] `fail-on` thresholds (missing-specs, drift, proof-failed, proof-stale, proof-unexercised, proof-unproven, proof-incomplete (claims missing a required test layer), align-below:<n>, results, validate, security, check, test, verify, scan, deps, none) fail the job from the gates' exit codes; a gate that did not run, or a missing proof ledger, never fails the job <!-- claim: action-fail-on -->
- [ ] With `affected: true` the `test` gate measures changed workspace units against `affected-since`, else the pull request's base commit, else the working tree against HEAD, so a clean checkout of a pull request tests what the pull request changed instead of nothing <!-- claim: action-affected-since -->
- [ ] On a pull request the Action posts one comment (found again by a marker, and updated on later runs) with the failed thresholds, the numbers `check`, `proof` and `scan` printed (specs, tests, claims proven, failed, stale and missing a layer, findings) and how each moved since the previous run on that pull request; a run that cannot comment (no token, a fork, an API error) says so and does not fail <!-- claim: action-pr-comment -->
- [ ] With `sarif: true` the `scan` gate also writes `.specguard/security/scan.sarif` and the Action uploads it to GitHub code scanning <!-- claim: action-sarif -->
- [ ] `init --ci github` writes `.github/workflows/specguard.yml` (a pull request and main-branch gate: full-history checkout, the project's own install step, gates `check,test,scan,proof,publish`, `fail-on` of missing specs, failed or stale proofs and tests plus `proof-incomplete` when layers are required, changed-units testing only for a workspace with packages, the comment, SARIF, and an optional manual browser `verify` run) and `.github/workflows/specguard-remediate.yml` (weekday remediation pull requests, with auto-merge and the bot token it needs only when `--auto-merge` is given); it never overwrites a workflow that exists and writes none unless asked <!-- claim: init-ci -->
- [ ] `mode: remediate` runs `specguard remediate` instead of the gates, adds `--pr` when asked, exposes the exit code, fails only on exit 1 or 11, and never merges; a release tag must equal the package version with the CLI published before the extension <!-- claim: action-remediate-and-release -->
- [ ] The VS Code extension adds an activity-bar sidebar and a singleton dashboard panel that run the CLI (resolved from a setting, a local binary or npx) and read `.specguard` files for coverage, pipeline status, drift, traceability and agent activity; commands needing a workspace report when none is open, the project can be switched, and no secrets are passed through. A capability project shows source coverage as a percentage of source files and counts capabilities separately from those files; archived v1 specs are not counted as current specs; `trace.json` is preferred over an older `traceability.json`; a contract edge with no `lastVerified` or one older than 30 days is described as unverified <!-- claim: vscode-dashboard -->
- [ ] Optional behaviour is added through plugins named in `config.plugins`: a plugin may supply commands, catalog providers, implementation discoverers, external-id adapters, result sources, feature-state tuning, module stems and contract importers; an unknown or malformed plugin name is a configuration error where a pipeline loads it, and core never imports a plugin by name <!-- claim: plugin-contract -->
- [ ] The feature catalog (the `feature-catalog` plugin) is a directory of YAML parsed with a real YAML parser and validated against a schema (an unversioned or malformed file or a duplicate feature id is an error naming the file; `catalogFormat: list` reads bare lists; `catalogExclude` skips file names that match its globs before they are parsed); built-in GraphQL, REST and tRPC discoverers and the generic, Zephyr and Jira external-id adapters need no other plugin, and `specguard features` lists each spec's feature back-references <!-- claim: feature-catalog -->
- [ ] `features --state` reports per feature a summary, required channels and a state for UI, API and MCP (no, stub, built, broken, passing, proven) from specs, discovered implementations and test results matched by feature id, tag or external id, plus an agent gate that opens only on a latest passing unit or integration test; with no catalog it prints `[]` with a note and does not fail <!-- claim: feature-state -->
- [ ] `quality` runs ESLint and Knip (and Ruff for Python) for every app or one app, can auto-fix lint issues, normalises findings into `.specguard/code-quality.json` with error and warning totals, exits 2 only when lint errors exist, treats an unavailable tool as a warning, and rejects an unknown app name with the list of known ones <!-- claim: code-quality -->
- [ ] `commit` stages and commits only SpecGuard-generated paths (tests, docs, specs, `.specguard/` and the directories the config writes to), supports `--dry-run`, a custom message and an originating pipeline, reports a clean tree or nothing to commit with success, fails with exit 1 when git is missing or git add or commit fails, and appends each commit to `.specguard/changelog.md` <!-- claim: git-helpers -->
- [ ] The surface is small: `analyze`, `plan-fix` and `deps` are gone (`check`, `security scan` and the remediation plan replace them, and the Action's `deps` gate is an alias of `scan`), and the MCP server registers about 16 core tools (`check`, `spec_graph`, `read_spec`, `write_spec`, `history_add`, `history_log`, `test_run`, `verify`, `security_scan`, `security_plan`, `proof_status`, `results_ingest`, `impact`, `contracts`, `workspace_status`, `init`) while the pre-0.2 tool names register only when `SPECGUARD_MCP_LEGACY=1`; plugin tools always register <!-- claim: planned-reduced-surface -->
- [ ] Plugin commands are registered on the CLI as `specguard <name>` and on the MCP server as `specguard_<name>` (with typed inputs when the command declares them), only while the plugin is enabled; config is read before commands are parsed, core commands and tools win a name clash, and a plugin that cannot be loaded is reported once and skipped so `init` still works with a broken config <!-- claim: plugin-commands -->
- [ ] Plugins can add `detectors` (their findings become `code` items in the remediation plan under the owning capability, reported but never auto-patched, and closed only when the detector ran without warnings) and `docRenderers` (the docs API tries them before the model; a renderer that declines or fails falls through), and npm plugins load only from an explicit `{name, package}` allowlist in config, resolved from the project's own `node_modules`, because importing a package runs its code <!-- claim: planned-plugin-extensions -->
- [ ] `init --history-hooks` installs history hooks (into `.claude/settings.local.json`, personal and uncommitted) so prompts and plans are captured into the requirement history automatically, using the same safe, idempotent merge rules as the existing hooks <!-- claim: planned-history-hooks -->
- [ ] The feature catalog's layout is entirely `featureState` config (catalog directory and format, file-name globs to leave out, results directories, id rules, placeholder and MCP patterns, repo channels, module stems, and where agent tools are declared and which of them do not count); a config's catalog path is relative to the directory holding that config's `.specguard/`, including in an overlay beneath a workspace manifest; no platform's layout is built in, and a test fails if a customer platform is named anywhere in code, docs or specs <!-- claim: catalog-layout-config -->
- [ ] The `contract-mappings` plugin adds contract edges from a JSON file of spec-to-provider mappings whose location and key names are `contractMappings` config, with plain defaults, and yields nothing for a missing or malformed file <!-- claim: contract-mappings-importer -->
- [ ] Core reaches optional functionality only through enabled plugins: `quality` exists only when a plugin provides it, and core commands never run code quality themselves <!-- claim: core-plugin-boundary -->
- [ ] Built-in plugins are described in a catalog (id, title, description, the parts of the plugin interface each provides, its config key and whether `init` turns it on); the catalog lists exactly the directories under `src/plugins/` and each plugin exports the id it is listed under; an npm plugin may describe itself with `meta` <!-- claim: plugin-catalog -->
- [ ] `specguard plugin list [--json]` shows every built-in and every configured npm plugin with whether it is on, whether it is inherited through `extends` or turned off here, the commands it adds and any load error; `plugin enable|disable <id>` edit only the repo's own raw config (keeping every other key), a repo with no list of its own writes one that restates what it inherits, and a plugin enabled only by an extended config is turned off with `disabledPlugins`; a disabled npm plugin keeps its package so it can be re-enabled by id <!-- claim: plugin-manage -->
- [ ] `plugin add <id> --package <name> --yes [--install]` imports the package to check it exports a plugin with that id (which runs its code, so it is refused without `--yes`), installs with scripts disabled when asked, validates the name and package, and only then lists it; `plugin remove` drops it from the list and refuses built-ins <!-- claim: plugin-add-remove -->
- [ ] The plugin list is also served at `GET /api/v1/plugins` (read-only, empty for a project with no working tree) and by the `specguard_plugin_list` MCP tool, which is part of the extra tool set (`SPECGUARD_MCP_LEGACY=1`) because the default MCP tool list is capped at 16 <!-- claim: plugin-surfaces -->
- [ ] The VS Code extension has a Plugins view driven by `plugin list --json`: each plugin with its description, enabled state, commands and errors; switching projects refreshes the plugin list and pipeline actions, and an older in-flight list cannot replace the selected project's result; Enable, Disable, Add (a modal that names the package and says its code will run) and Remove actions run the CLI, then restart the local API and refresh the actions; the pipeline actions come from the enabled plugins' commands instead of a fixed list, and heal commits its result only when the `git` plugin is enabled <!-- claim: extension-plugins-view -->
- [ ] Through the MCP server an agent may read and write only Markdown files inside the project's spec directories (the specs root and each app's spec directory, or `<cwd>/specs` with no config): `..`, absolute paths elsewhere, other file types and symlinks that leave the project are refused, so a spec tool cannot write a git hook, a shell profile or an agent settings file <!-- claim: mcp-spec-paths -->
- [ ] The `commit` command never stages a file that holds secrets or personal data, even inside a safe root: environment files (templates such as `.env.example` excepted), private keys and certificates, credentials files, `.npmrc`, saved login state under `.specguard/auth` and browser evidence under `.specguard/evidence` <!-- claim: commit-never-secrets -->
- [ ] An npm plugin is named only by a valid npm package name: a path, a URL, an uppercase or spaced name is refused before anything is imported, a package that is not installed or that exports another id is refused, and a bare string never names a package <!-- claim: plugin-package-names -->
- [ ] The MCP server limits what an agent can do in one process: at most 300 tool calls a minute (`SPECGUARD_MCP_RATE_PER_MIN`) and 20 history entries a minute (`SPECGUARD_MCP_HISTORY_PER_MIN`), a call over the limit gets an error result naming the setting, not a thrown error, and is logged <!-- claim: mcp-limits -->
- [ ] With `SPECGUARD_MCP_READONLY=1` the MCP server offers no tool that creates or changes files (spec writes, history entries, init, generation, test runs, verification, scans, ingest, contracts) and no plugin tool, leaving the tools that read <!-- claim: mcp-readonly -->
- [ ] The CI context is read from the GitHub Actions environment and event payload without I/O of its own: for a pull request the commit under test is the head sha, the base is the PR base sha, and the author, number, head repository, draft flag and fork status come from the payload (a missing or deleted head repository is a fork); a push or merge group takes its base from `before` or `base_sha` and an all-zero `before` is no base; scheduled, dispatched and unknown events have none; missing, malformed or throwing input never throws <!-- claim: ci-context-pull-request -->
- [ ] The CI context says what the run may write: notes, comments and check runs need a token and GitHub Actions, comments need a same-repository pull request, and a fork or a missing or blank token leaves all three false <!-- claim: ci-context-write-rights -->
- [ ] The GitHub client is a thin layer over the global `fetch` that makes exactly the calls the gate needs (list pull request reviews and files, list check runs by name on a commit, create a check run), sends the token only as a bearer header to the configured API root, follows `Link` pagination (or page numbers when there is no header) and has no dependency, retry or cache; `fetch` is injectable <!-- claim: github-client-calls -->
- [ ] A failed GitHub call throws a typed error carrying status (0 for no response), method, path and a rate-limit flag; the token never appears in an error, not even when the server or network layer echoes it, a pagination link that leaves the API root is never followed, and a missing token or malformed repository is refused before any request <!-- claim: github-client-errors-and-token -->
- [ ] Posting the pull request comment finds the comment holding a marker (on any page) and updates it, or posts a new one, and never throws: a refused write returns `posted: false` with a reason that holds no token <!-- claim: github-comment-upsert -->
- [ ] Pull request files that run or guard the gates (workflows of any provider, the SpecGuard config, the code owners file, the Action) are listed from file names and statuses alone: adding or editing one is a warning, deleting one or renaming it away is an error, and each file appears once, sorted, with the error winning <!-- claim: pipeline-change-detection -->
- [ ] The Claude Code plugin guards edits and shell commands with a PreToolUse hook on `Edit|Write|MultiEdit|NotebookEdit|Bash` that runs the committed bundle (`node "${CLAUDE_PLUGIN_ROOT}/hooks/dist/specguard-hook.mjs" pre-tool-use`, timeout 5 s, no `onFailure`, so it fails open), next to the SessionStart status, and it stays silent in a project with no `.specguard/config.json` <!-- claim: plugin-guard-hooks -->
- [ ] The Codex plugin carries no hooks, so it stays eligible for the public plugin directory; Codex gets the guard only through the repository <!-- claim: codex-plugin-hook-free -->
- [ ] `specguard init --codex` writes the repository's `.codex/hooks.json` (a PreToolUse hook on `apply_patch`, `Edit`, `Write` and `Bash`, timeout 10 s, using the installed bundle when the package is a local dependency, else a pinned npx command, with `--agent codex`) and `.codex/rules/specguard.rules` (`prefix_rule` forbidding `specguard spec approve` and its npx forms), merges into an existing hooks file without duplicating on a re-run, never overwrites a rules file it does not own or a hooks file it cannot parse, and tells the person to trust the hook in `/hooks`; without the flag no `.codex` file is written <!-- claim: init-codex-files -->
- [ ] `init --harness claude` and `scaffold` also merge the same guard as a PreToolUse hook into `.claude/settings.json` (the installed bundle when the package is a local dependency, else the resolved runner's `hook pre-tool-use`), once and beside the user's own hooks, and with `hooks.onError: "deny"` the scaffolded hook sets `onFailure: "block"` <!-- claim: harness-guard-hook -->
- [ ] `specguard ci run` proves a pull request without a model call: it reads the CI context, fetches the proof notes, runs only the claims whose proofs are stale, missing or changed in the pull request (the rest are carried from the nearest proof note, and every claim with a test runs when there is no usable note or with `--full`), and a pull request whose changed requirements are approved, proven and shown sensitive is `ready`: exit 0, one packet comment found again by the packet marker and updated on later runs, the packet appended to the job summary, and `packet.json`, `packet.md`, `statement.json` and `note.json` written under `.specguard/ci` <!-- claim: ci-run-ready -->
- [ ] At a capability at `enforce`, `ci run` exits 13 and the packet is `blocked` when a changed requirement is not approved (an approval added in the pull request counts only when a review by someone other than the author covers it, or `approvals.ci.allowSelf` labels it self-approved), when its tests also pass on the base code, when a changed owned line no claim test reaches, when an existing test became a skip or lost an assertion, when owned code changed with no change record and no changed requirement, or when a covering change is a spike; the packet and the comment name each cause and the fix, and `unknown` blocks as `fail` does <!-- claim: ci-run-blocks-enforce -->
- [ ] A capability at `warn` is shown with its findings and annotated with `::warning` but never fails the run, and a capability at `observe` neither blocks nor annotates: with only such capabilities touched the exit code is 0 and the packet still lists what was found <!-- claim: ci-run-observe-silent -->
- [ ] Sensitivity is proven by construction, not by commit order: the changed claims' tests run once at head and once in a temporary worktree of head whose owned source files of the change's capabilities are taken from the base commit (files added since removed, the configured dependency directories linked in), selecting the tests by title; a claim is `ok` when a test of it fails on the base code and all pass at head, `fail` when its tests pass on the base code, and `unknown` (never a pass) when no owned code differs, `--no-red` or `--no-tests` is given, the run recorded no test of the claim, or the tree could not be built; the worktree is always removed <!-- claim: ci-run-red-by-construction -->
- [ ] `ci run` writes the proof note for the checked-out commit (the pull request head, not GitHub's merge ref): the rows fresh at that commit (those earned in the run counted as CI evidence), the approvals carried or earned from reviews, countersign rows, the statement summary, the change verdicts, the packet digest and `sensitivity` on the changed claims' rows, pushed with fetch, re-apply and push; a check run `specguard/proof-note` carrying the note's digest (and `specguard/proof` with the verdict) is created only with `proofStore.verify: check-run`, and then an ancestor note without a matching check run is ignored and its claims re-proved <!-- claim: ci-run-note-head -->
- [ ] On a later commit of the same pull request only the stale claims (and the changed ones) run again, and the others are carried from the nearest noted ancestor, which the new note names as `carriedFrom` <!-- claim: ci-run-affected-only -->
- [ ] On a push or merge-group run, a note recorded for a commit with the same tree (a squash or rebase merge of a pull request that was up to date) is copied to the new commit with `importedFrom: tree-equal`, after `proofStore.verify` is satisfied, and no test runs <!-- claim: ci-run-squash-import -->
- [ ] Every external step degrades instead of failing the job: a pull request from a fork, or a run with no token, posts no comment and pushes no note (the packet goes to the job summary and the artifacts, the note to `note.json`) and still decides by exit code; unreadable reviews, a refused comment, a checkout of the merge ref (no note is written for it), a missing git checkout and v1 specs are reported and carried on, `--dry-run` writes nothing outside `.specguard/ci`, and only a missing base commit (a shallow checkout of a pull request) is an error, exit 1 <!-- claim: ci-run-degrades -->
- [ ] `ci packet [file]` renders a saved `packet.json` through the escaping renderer and refuses a file that is not a proof packet of a supported version; `ci doctor` reports what `ci run` would do here (context, token, rights to comment and push, notes remote, enforce levels, test and coverage configuration) without a network call and never prints the token; `ci run --event <file>` replays a recorded payload and never carries the token <!-- claim: ci-commands -->
- [ ] The generated pull request workflow has a `prove` job that checks out the pull request head with full history (not the merge ref) and fetches the proof notes, passes no model API key (the scan runs in a separate `security` job that holds it), pins the installed SpecGuard by the package's major and minor, listens to the merge queue, asks for `contents: write` and `pull-requests: write` (and `checks: write` only when notes are attested), and fails on `prove` instead of the legacy proof thresholds <!-- claim: ci-workflow-prove -->
- [ ] The Action has a `prove` gate that runs `specguard ci run` (`--full`, `--no-push` and `--no-comment` follow the `full`, `notes` and `comment` inputs), trips `fail-on: prove` on any non-zero exit, is added to the default gates only when the repository uses `proofStore`, `enforce`, `change` or `approvals` or has change records or a spec with `enforce:` (input `prove: auto`, `true` or `false`), swaps the default `fail-on` for `missing-specs,drift,prove,results` when it runs (a gitignored ledger is absent from a fresh checkout), echoes the run's own lines and annotations, turns the older comment into a pointer to the proof packet instead of posting a second comment, can fail the job when the note was not pushed (`note-required`), and the `proof` gate reads the effective ledger (the nearest note and the local cache) <!-- claim: action-prove-gate -->
- [ ] `specguard overlay add <dir>` scans the directory, shows each repo it covers and each config it skipped with the reason, and registers it (refusing a directory with no config that points at another repository, and writing only the registry); `overlay list` shows registered overlays and `SPECGUARD_OVERLAY` roots and flags stale entries; `overlay refresh [dir]` rescans and reports what was added or removed; `overlay remove <dir>` forgets one without touching its files; `overlay resolve [dir]` prints which config, overlay and app a directory resolves to or why none (exit 0 when configured, 1 when not or ambiguous), read-only; `--json` works on all of them, `init` refuses to write a second config into an overlay-covered repo, and `check` and `status` print one first line `configured via overlay <root> (app <name>)` only when running through an overlay <!-- claim: overlay-cli -->
- [ ] The agent edit guard works in a real repository whose specs live in an overlay: it finds the overlay app with a light lookup (node built-ins, no heavy imports) of `SPECGUARD_CONFIG`, `SPECGUARD_OVERLAY` and the registry, expresses ownership relative to the real repository while reading specs, change records and enforce levels from the overlay, keeps its index cache and decision log in the overlay, classifies an edit to an overlay file from a session opened in the repo as outside the repo and allows it, never mistakes the repository's own `specs/` folder for the overlay's, takes ownership relative to the entry's app folder when that is nested inside the git repo the session opened (a file in the repo outside the app folder is outside and allowed), and fails open (silent) when nothing or more than one config matches <!-- claim: hook-overlay -->
- [ ] The session-start status script and the VS Code extension see overlay-covered folders as configured: the script runs `specguard overlay resolve . --json` only when the folder has no config and an overlay registry, `SPECGUARD_OVERLAY` or `SPECGUARD_CONFIG` exists (no CLI start-up for projects without overlays); the extension asks the CLI's `overlay resolve <folder> --json` when `.specguard/config.json` is absent, reads specs and traces from the folder that holds the config, starts on `onStartupFinished` and stays quiet in a window with no SpecGuard project <!-- claim: overlay-clients -->

- [ ] Workspace repository rows preview the dashboard on a single click and activate on a double click. Evidence containers are labelled as overlays with their code consumers, and repositories show discovered specs, code, tests and docs contributions without requiring an app config on an evidence container. Coverage links resolve from the owning config directory. Workspace cards open each project dashboard without activating it; sidebar output links open the dashboard evidence sections with persistent Workspace navigation. Repository cards and refresh controls have separate spacing, and spec descriptions exclude YAML frontmatter. Repository cards use at most two columns (one in narrow views), show compact catalog and proof summaries, and keep technical diagnostics collapsed by default; the sidebar reports configured team-server availability separately from project access. <!-- claim: extension-overlay-workspace -->

- [ ] Workspace Settings configures shared AI provider, model, endpoint and team-server defaults once per VS Code workspace. Explicit repository overrides win, inherited settings display their source, and reset restores workspace defaults. Existing project config and environment credentials remain fallbacks; each repo retains its server project mapping unless explicitly changed. Newly entered API keys and server tokens use VS Code SecretStorage, never shareable configuration, argv or webview state. The same resolved defaults and credentials drive extension CLI runs and API connections, and connection tests report connectivity and project access without echoing secrets or running model generation. Workspace dashboard, sidebar and repository Settings link to the same editor, including repository relationships. <!-- claim: extension-workspace-settings -->

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
- Plugins are code. Built-in plugins load only by name from a known location, and the npm plugin loader accepts only an explicit `{name, package}` allowlist, with package names restricted to npm names (no paths or URLs), because importing a package executes it.
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
