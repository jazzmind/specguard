---
title: "Integration Surfaces - CLI, Agents, CI, IDE and Plugins (developer reference)"
audience: dev
source: "specs/capabilities/integration-surfaces.md"
generated: true
---
<a id="integration-surfaces-cli-agents-ci-ide-and-plugins"></a>
# Integration Surfaces: CLI, Agents, CI, IDE and Plugins

<a id="purpose"></a>
## Purpose

This capability is the set of surfaces through which people, coding agents and CI systems drive SpecGuard, and the plugin system that extends it without forking. The surfaces are:

- one command line with stable exit codes and machine-readable output;
- an `init` and `scaffold` that set a project up and wire agents in without overwriting anything;
- an MCP server that exposes the same operations to agents;
- a GitHub Action and generated workflows that turn checks into pass/fail gates;
- a VS Code extension with a sidebar and dashboards;
- Claude Code and Codex plugin marketplaces;
- optional plugins (feature catalog, code quality, git helpers, contract mappings).

The pipelines these surfaces call are specified in their own capabilities.

<a id="responsibilities"></a>
## Responsibilities

- Route every CLI subcommand to its pipeline, with typed exit codes and `--json` output.
- Bootstrap a project (`init`, `start`) and generate harness files, hooks and MCP wiring. Existing user content is preserved, and a differing hook is shown as a diff, not rewritten.
- Serve the same operations over MCP, with activity logging, rate limits, a read-only mode and path restrictions.
- Provide CI gating through the GitHub Action, generated workflows and `specguard ci run`. Every external step degrades rather than failing the job.
- Provide VS Code views for workspace, coverage, pipelines, plugins and help, plus a test report, team publish, settings and docs viewer.
- Load, list, add, remove, enable and disable plugins. Core never imports a plugin by name.
- Keep platform-specific conventions (catalog layouts, id schemes) out of core. They are plugin or config concerns.

Out of scope:

- Hosting a documentation site or API.
- The pipelines the surfaces call.
- Platform-specific built-in integrations.
- Running tests or builds for CI beyond invoking the CLI.
- Editors other than VS Code and compatible ones; other editors use the CLI or MCP.

<a id="interfaces"></a>
## Interfaces

**CLI:** `specguard <command>` with global `--config <path>`, `--json` and `--record`.
- Setup commands:
  - `init`: `--with-playwright`, `--language`, `--harness claude|cursor|both`, `--single`, `--runner node|npx|path`, `--runner-path`, `--update-hooks`.
  - `scaffold`.
- Plugin commands, present only while the owning plugin is enabled:
  - `features [--state] [--cases <file>]` (feature-catalog)
  - `quality [--app] [--fix]`
  - `commit [--dry-run] [--message] [--app] [--pipeline]` (git)
  - `contracts-map [--workspace] [--repo] [--dry-run] [--min-confidence] [--with-llm] [--max-llm-specs] [--all-specs] [--with-code] [--send-code] [--assess]` (contract-mappings)
- Further commands and flags named in the requirements: `start`, `agent pending|answer`, `ci run|packet|doctor`, `overlay add|list|refresh|remove|resolve`, `plugin list|enable|disable|add|remove`, `init --ci github`, `init --codex`, `init --history-hooks`.

**MCP:** binary `specguard-mcp` over stdio. Tools are named `specguard_<command>` (including `specguard_scaffold`, `specguard_read_spec`, `specguard_write_spec`), plus `specguard_<command>` for each enabled plugin command.

**Files written:**
- `.specguard/config.json`, `.specguard/.env`, `.specguard/activity-log.json`, `.specguard/code-quality.json`, `.specguard/changelog.md`, `.specguard/ci/<gate>.json`
- `CLAUDE.md`, `AGENTS.md`
- `.claude/settings.json`, `.claude/skills/specguard/SKILL.md`, `.claude/commands/goal.md`
- `.cursor/mcp.json`, `.cursor/skills/specguard/SKILL.md`

**Config keys:**
- `plugins`
- `featureState` (catalog, catalogFormat, reporters, resultsDirs, externalIds, channelByType, repoChannels, moduleStems, idSkipSegments, placeholderSummaryPattern, mcpModulePattern, agentTools)
- `contractMappings` (file, list, spec, providers, docs, edgeType, basePrefixes, baseRepos, providerRepos)
- `runners`
- `llm.*`

**GitHub Action inputs:** `mode`, `gates`, `fail-on`, `results`, `run-id`, `drift-since`, `validate-url`, `version`, `working-directory`, `remediate-args`, `open-pr`, `github-token`, `upload-evidence`. Output: `remediate-exit`. The requirements also refer to inputs not in this list: `affected`, `affected-since`, `sarif`, `full`, `notes`, `comment`, `prove`, `note-required`.

**VS Code:**
- View container `specguard-sidebar` with views `specguard.workspaceView`, `specguard.coverageView`, `specguard.pipelinesView`, `specguard.pluginsView`, `specguard.helpView`.
- Commands: `specguard.openDashboard`, `specguard.generateContractMappings`, `specguard.contracts`, `specguard.openDocs` (optional topic: help key or `page.md#anchor`), `specguard.status`, `specguard.registerMcp`.
- Context key: `specguard.contractMappingsEnabled`.
- Settings: `specguard.cliPath`, `specguard.autoRefresh`, `specguard.showStatusBar`.

**Exit codes:** 0 success, 1 internal/usage error, 2 validation failed, 3 drift, 4 missing specs, 5 security issues, 7 heal failed, 8 LLM budget exceeded, 12 waiting for the host agent. `ci run` uses 13 for a blocked packet at `enforce`. `remediate` has its own codes 8 to 11. The Interfaces list in the source says "0 to 5, 7 and 8", while `exit-codes-and-env` also defines 12.

<a id="requirements"></a>
## Requirements

<a id="output-routing-and-editor-actions"></a>
### Output routing and editor actions
- **output-destinations**: CLI and editor actions resolve saved output directories per application and artifact kind (unit, integration and e2e tests separate). Generated directories join test discovery and native sources stay intact. Changing a spec root copies Markdown without deleting originals or overwriting conflicts, and preserves canonical spec/claim keys.
- **extension-output-routing**: Before Generate, Reverse, Import, Docs or Gap Analysis writes, the editor shows the application, locations and destination. It offers runnable directories or an alternate, flags mapping-only test directories, remembers the choice and scopes the action to the application. Cancelling does not start generation.
- **activity-log-never-committed**: `.specguard/activity-log.json` is never staged, including nested projects and explicit scopes. A legacy tracked log can be untracked once by migration while keeping local history.

<a id="build-and-release"></a>
### Build and release
- **make-workflows**: `make help` groups commands and gives example flows. `install`, `install-cli`, `install-vsix`, `install-dev` (`npm ci` in root, extension and webview) and `build-vsix` are defined. `install-vsix` finds `code` on PATH, in a macOS app location or via `CODE`. Local install and packaging never tag or publish.
- **release-waits-for-ci**: `make release-check` and `make publish` check the latest CI run on `main` for the exact commit. They watch queued or running runs to completion and proceed only on confirmed success. Failed, cancelled, interrupted, missing or unreadable runs block before any tag or push.

<a id="cli-core"></a>
### CLI core
- **cli-routing-and-flags**: Each subcommand routes to its pipeline and has help. `--version` prints the version, and `--version --json` prints one JSON line. An unknown subcommand exits non-zero with a usage hint. `--config` accepts a file, a directory or a path containing `/.specguard/`. `--json` and `--record` reach every command.
- **exit-codes-and-env**: Exit codes are typed and stable. A SpecGuard error prints to stderr and exits with its code, and an unexpected error exits 1. Budget refusal forces exit 8. Pending host-agent requests force exit 12 and print what is waiting and how to answer. A missing config exits 1 with the `specguard init` instruction. `.specguard/.env` is loaded without overwriting existing variables, and an older placeholder key value is ignored.
- **planned-reduced-surface**: `analyze`, `plan-fix` and `deps` are gone (`check`, `security scan` and the remediation plan replace them; the Action's `deps` gate aliases `scan`). The MCP server registers about 16 core tools (`check`, `spec_graph`, `read_spec`, `write_spec`, `history_add`, `history_log`, `test_run`, `verify`, `security_scan`, `security_plan`, `proof_status`, `results_ingest`, `impact`, `contracts`, `workspace_status`, `init`). Pre-0.2 names register only with `SPECGUARD_MCP_LEGACY=1`, and plugin tools always register.
- **start-command**: `specguard start` runs init (if no config), drafts specs (unless `specs/system.md` exists), links tests, runs tests (unless `--skip-tests`) and reports. A step waiting on the host agent stops with exit 12, and a rerun resumes.
- **agent-work-tools**: `agent pending` lists waiting model requests (exit 12 if any). `agent answer <hash>` records an answer from a file or stdin. A unique prefix of 8 or more characters is enough, and a JSON answer may sit in a markdown fence. An unknown request or wrong-shaped answer is refused. The `specguard_agent_work` MCP tool (`list` / `answer`) is a default tool and is not offered by a read-only server.

<a id="init-scaffold-and-harness-wiring"></a>
### Init, scaffold and harness wiring
- **init-bootstrap**: `init` creates only `.specguard/config.json` (no `llm` block) and `specs/README.md`, asks for no API key and writes no key file. It detects language and test framework (`--with-playwright` forces Playwright) and matches root-level code when there is no `src/`. It never overwrites files and reports created and skipped paths. It adds a managed git-ignore block and prints the untrack command when git tracks such files. Agent files are written only with `--harness`.
- **harness-files**: `init --harness` and `scaffold` generate files for Claude, Cursor or both: a CLAUDE.md with managed sections, skill files, a goal command and AGENTS.md. All are marked as SpecGuard-managed. For Claude, the MCP server goes in `.mcp.json`. Marked files are refreshed, unmarked hand-written files are left alone, and content outside managed sections is preserved.
- **agent-wiring-and-runner**: Setup merges an MCP entry and a post-edit status hook without removing unrelated keys. Malformed JSON is reported and left unchanged. The runner resolves from `--runner node|npx|path`, then `SPECGUARD_CLI`, a local binary, a global binary, then `npx -p specguard-ai specguard`. An older broken entry is repaired. Any other differing entry is left alone with a printed diff unless `--update-hooks` is given.
- **harness-guard-hook**: `init --harness claude` and `scaffold` also merge the guard as a PreToolUse hook into `.claude/settings.json` (once, beside the user's hooks). With `hooks.onError: "deny"` the hook sets `onFailure: "block"`.
- **init-codex-files**: `init --codex` writes `.codex/hooks.json` (PreToolUse on `apply_patch`, `Edit`, `Write`, `Bash`, timeout 10 s) and `.codex/rules/specguard.rules` (`prefix_rule` forbidding `specguard spec approve`). It merges without duplicating, never overwrites a rules file it does not own or a hooks file it cannot parse, and tells the user to trust the hook in `/hooks`. Without the flag no `.codex` file is written.
- **planned-history-hooks**: `init --history-hooks` installs history hooks into `.claude/settings.local.json` using the same safe, idempotent merge rules.
- **init-ci**: `init --ci github` writes `.github/workflows/specguard.yml` and `specguard-remediate.yml` (auto-merge and bot token only with `--auto-merge`). It never overwrites an existing workflow and writes none unless asked.

<a id="mcp-server"></a>
### MCP server
- **mcp-tools-parity**: stdio server, one tool per core command plus `read_spec` / `write_spec`. It calls the same pipeline functions as the CLI with optional `cwd`, returns a text summary, and returns an error result instead of throwing. Importing the module does not start the transport.
- **mcp-activity-and-limits**: Each call appends a running entry, then a pass, fail or error entry with duration, to `.specguard/activity-log.json`. The log is trimmed to the latest 200 entries once it exceeds 1 MB, recovers from invalid JSON and never throws. `read_spec` needs a key or path. MCP performs no effects outside the machine (remediate is scan-only and dry-run, commit stages only generated files).
- **mcp-spec-paths**: Agents may read and write only Markdown inside the project's spec directories. `..`, absolute paths elsewhere, other file types and symlinks leaving the project are refused.
- **mcp-limits**: At most 300 calls per minute (`SPECGUARD_MCP_RATE_PER_MIN`) and 20 history entries per minute (`SPECGUARD_MCP_HISTORY_PER_MIN`). Over the limit, the caller gets an error result naming the setting, and the event is logged.
- **mcp-readonly**: `SPECGUARD_MCP_READONLY=1` removes every tool that creates or changes files and every plugin tool.

<a id="claude-code-and-codex-plugin-distribution"></a>
### Claude Code and Codex plugin distribution
- **plugin-distribution**: The repository is a Claude Code and a Codex plugin marketplace with one plugin, `specguard`. It needs no API key, writes nothing into the project, and ships skills, the `start` and `check` commands, a `specguard` executable (`SPECGUARD_CLI` runs a local build), MCP config and a session-start status hook. Both manifests carry the package version.
- **plugin-guard-hooks**: The Claude plugin has a PreToolUse hook on `Edit|Write|MultiEdit|NotebookEdit|Bash` running the committed bundle (timeout 5 s, no `onFailure`, so it fails open). It is silent without `.specguard/config.json`.
- **codex-plugin-hook-free**: The Codex plugin carries no hooks. Codex gets the guard only through the repository.

<a id="github-action-and-ci"></a>
### GitHub Action and CI
- **action-gates**: The Action installs the requested version and runs gates in a fixed order (status, drift, proof, align, results, validate, security, check, test, verify, scan; `deps` aliases `scan`). It rejects an unknown gate first, writes a job summary and per-gate JSON, and uploads `.specguard/` evidence excluding secrets and auth state.
- **action-fail-on**: `fail-on` thresholds (missing-specs, drift, proof-failed, proof-stale, proof-unexercised, proof-unproven, proof-incomplete, align-below:<n>, results, validate, security, check, test, verify, scan, deps, none) fail from gate exit codes. A gate that did not run, or a missing proof ledger, never fails the job.
- **action-affected-since**: With `affected: true`, the `test` gate measures changed units against `affected-since`, else the PR base commit, else the working tree against HEAD.
- **action-pr-comment**: One marker-identified, updatable PR comment carries failed thresholds, the numbers `check`, `proof` and `scan` printed, and deltas since the previous run. A run that cannot comment says so and does not fail.
- **action-sarif**: `sarif: true` makes `scan` write `.specguard/security/scan.sarif` and upload it to code scanning.
- **action-remediate-and-release**: `mode: remediate` runs `specguard remediate` (adds `--pr` when asked), exposes the exit code, fails only on exit 1 or 11, and never merges. A release tag must equal the package version, and the CLI is published before the extension.
- **action-prove-gate**: A `prove` gate runs `specguard ci run` (`--full`, `--no-push`, `--no-comment` follow `full`, `notes`, `comment`). It trips `fail-on: prove` on any non-zero exit. It is added to the default gates only when the repo uses `proofStore`, `enforce`, `change` or `approvals`, has change records, or has a spec with `enforce:` (input `prove: auto|true|false`). When it runs, the default `fail-on` becomes `missing-specs,drift,prove,results`. The older comment becomes a pointer to the packet. `note-required` can fail the job when the note was not pushed, and the `proof` gate reads the effective ledger.
- **ci-workflow-prove**: The generated PR workflow has a `prove` job that checks out the PR head with full history and fetches proof notes, with no model API key (the scan runs in a separate `security` job). It pins the installed version by major.minor and listens to the merge queue. It asks for `contents: write` and `pull-requests: write` (`checks: write` only when notes are attested), and fails on `prove`.
- **ci-context-pull-request**: The CI context is read from the Actions environment and event payload without I/O. For a PR: head sha, base sha, author, number, head repo, draft and fork flags (a missing or deleted head repo is a fork). Push and merge-group events take their base from `before` or `base_sha` (all-zero means none). Scheduled, dispatched and unknown events have none. Bad input never throws.
- **ci-context-write-rights**: Notes, comments and check runs need a token and GitHub Actions. Comments also need a same-repo PR. A fork or missing or blank token makes all three false.
- **github-client-calls**: A thin client over global `fetch` (injectable) makes only the needed calls: list PR reviews and files, list check runs by name, create a check run. The token goes only as a bearer header to the configured API root. It follows `Link` pagination (or page numbers) and has no dependencies, retry or cache.
- **github-client-errors-and-token**: A failed call throws a typed error (status, 0 for no response, method, path, rate-limit flag). The token never appears in errors. Pagination links leaving the API root are not followed. A missing token or malformed repository is refused before any request.
- **github-comment-upsert**: The comment is found by marker on any page and updated, or posted new. It never throws, and a refused write returns `posted: false` with a token-free reason.
- **pipeline-change-detection**: PR files that run or guard the gates (workflows of any provider, SpecGuard config, code owners, the Action) are listed from names and statuses. Add or edit is a warning. Delete or rename-away is an error. Each file appears once, sorted, with the error winning.

<a id="specguard-ci-run"></a>
### `specguard ci run`
- **ci-run-ready**: Proves a PR without a model call. It fetches proof notes and runs only stale, missing or PR-changed claims (all claims with tests when there is no usable note or with `--full`). A PR whose changed requirements are approved, proven and shown sensitive is `ready`: exit 0, one marker-identified packet comment, the packet appended to the job summary, and `packet.json`, `packet.md`, `statement.json` and `note.json` under `.specguard/ci`.
- **ci-run-blocks-enforce**: At `enforce`, `ci run` exits 13 and the packet is `blocked` when any of these holds:
  - a changed requirement is not approved (an approval added in the PR counts only with a review by someone other than the author, or when `approvals.ci.allowSelf` labels it self-approved);
  - its tests also pass on the base code;
  - a changed owned line is reached by no claim test;
  - an existing test became a skip or lost an assertion;
  - owned code changed with no change record and no changed requirement;
  - a covering change is a spike.
  
  Packet and comment name each cause and fix, and `unknown` blocks like `fail`.
- **ci-run-observe-silent**: `warn` shows findings and annotates with `::warning` but never fails. `observe` neither blocks nor annotates. With only these touched, the exit code is 0 and the packet still lists findings.
- **ci-run-red-by-construction**: Claim tests run at head and in a temporary worktree of head whose owned source files come from the base commit (tests selected by title). A claim is `ok` when a test fails on base and all pass at head, and `fail` when its tests pass on base. It is `unknown`, never a pass, when no owned code differs, when `--no-red` or `--no-tests` is given, when no test was recorded, or when the tree could not be built. The worktree is always removed.
- **ci-run-note-head**: The proof note is written for the checked-out commit (PR head, not the merge ref), with fresh rows, approvals, countersigns, statement summary, change verdicts, packet digest and `sensitivity`. It is pushed with fetch, re-apply and push. Check runs `specguard/proof-note` and `specguard/proof` are created only with `proofStore.verify: check-run`, and then an ancestor note without a matching check run is ignored.
- **ci-run-affected-only**: On later commits only stale and changed claims rerun. The rest are carried from the nearest noted ancestor, recorded as `carriedFrom`.
- **ci-run-squash-import**: On push or merge-group runs, a note for a commit with the same tree is copied with `importedFrom: tree-equal`, after `proofStore.verify` is satisfied. No test runs.
- **ci-run-degrades**: Forks and missing tokens post no comment and push no note (packet goes to summary and artifacts) but still decide by exit code. Unreadable reviews, a refused comment, a merge-ref checkout (no note), a missing git checkout and v1 specs are reported and carried on. `--dry-run` writes nothing outside `.specguard/ci`. Only a missing base commit (shallow PR checkout) is an error, exit 1.
- **ci-commands**: `ci packet [file]` renders a saved `packet.json` through the escaping renderer and refuses unsupported files. `ci doctor` reports what `ci run` would do, with no network call and no token printed. `ci run --event <file>` replays a payload and never carries the token.

<a id="overlays"></a>
### Overlays
- **overlay-cli**: `overlay add <dir>` scans, shows covered repos and skipped configs with reasons, and writes only the registry. It refuses a directory with no config pointing at another repo. `overlay list` flags stale entries and shows `SPECGUARD_OVERLAY` roots. `overlay refresh [dir]` rescans. `overlay remove <dir>` forgets without touching files. `overlay resolve [dir]` is read-only (exit 0 configured, 1 not or ambiguous). `--json` works on all. `init` refuses a second config in an overlay-covered repo. `check` and `status` print a first line `configured via overlay <root> (app <name>)` only through an overlay.
- **hook-overlay**: The edit guard works for repos whose specs live in an overlay. It uses a light lookup (node built-ins) of `SPECGUARD_CONFIG`, `SPECGUARD_OVERLAY` and the registry. Ownership is relative to the real repo, while specs, change records and enforce levels are read from the overlay. Index cache and decision log live in the overlay. Overlay files edited from a repo session are outside the repo and allowed. The repo's own `specs/` is never mistaken for the overlay's. For a nested app folder, ownership is relative to that folder. It fails open when zero or more than one config matches.
- **overlay-clients**: The session-start script runs `overlay resolve . --json` only when the folder has no config and an overlay registry, `SPECGUARD_OVERLAY` or `SPECGUARD_CONFIG` exists. The extension asks `overlay resolve <folder> --json` when `.specguard/config.json` is absent, reads specs and traces from the config's folder, starts on `onStartupFinished` and stays quiet with no SpecGuard project.

<a id="vs-code-extension"></a>
### VS Code extension
- **extension-navigation-order**: Sidebar order is Workspace, Coverage, Pipelines, Plugins, Help & Docs. Workspace has its own tree and works without coverage or after a coverage load failure.
- **extension-workspace-alignment**: Lists each repo's catalog files, schema versions, content revision, feature-to-spec link coverage and missing links. It separately shows extension version, last harness setup version, spec format, Git revision and working changes, and the last spec check's revision and engine version. Absent or differing evidence shows as needing refresh, and catalog links alone never claim verified alignment.
- **extension-output-browser**: Specs, Tests and Docs open a searchable inventory (configured directories, colocated tests, overlay roots; archived specs and dependency/build output excluded). Files open in the editor. Team-server specs and docs can be listed and read through the existing API, with local files still available if the server cannot answer.
- **extension-setup-preview**: Before updating agent files, the extension previews per file how each kind is treated:
  - CLAUDE.md keeps custom rules outside SpecGuard sections.
  - Marked skills/commands and AGENTS.md are replaced.
  - Unmarked standalone files are skipped.
  - Unrelated JSON settings and MCP entries are retained.
  
  Cancelling runs nothing, and a failed scaffold never records a successful setup version.
- **vscode-dashboard**: Activity-bar sidebar and singleton dashboard panel run the CLI (from setting, local binary or npx) and read `.specguard` files. Commands needing a workspace report when none is open, and no secrets are passed. Source coverage is a percentage of source files, with capabilities counted separately. Archived v1 specs are not counted. `trace.json` is preferred over `traceability.json`. A contract edge with no `lastVerified` or one older than 30 days is unverified. The workspace spec count includes child specs under `capabilities/` and equals coverage and dashboard totals.
- **vscode-test-report**: `SpecGuard: Open Test Report` (and a sidebar row) opens the workspace report in a webview, building it with `report --workspace` when missing or on request. It uses a strict CSP (`<base>`, nonce'd scripts), Back/Workspace navigation, inline screenshots and video, other evidence in VS Code and Playwright traces in the trace viewer. Links leaving the report folder are refused.
- **extension-team-publish**: Team server section: server and sign-in state, per-repo status (up to date, needs publish with reasons from `workspace publish --check --json`, never published, error), and buttons to check, publish one, publish all, publish the workspace definition and open the server report. Publishing test evidence is an opt-in toggle showing upload size. Progress comes from CLI progress lines, the token is passed by environment and never on a command line, and all CLI strings are escaped.
- **extension-overlay-workspace**: A repo row previews on single click and activates on double click. Evidence containers are labelled as overlays with code consumers, and repos show discovered specs, code, tests and docs without needing an app config on a container. Coverage links resolve from the owning config directory. Cards open dashboards without activating, and sidebar output links open evidence sections with persistent Workspace navigation. Spec descriptions exclude YAML frontmatter. Cards use at most two columns (one when narrow), show compact catalog and proof summaries and collapse diagnostics. The sidebar reports team-server availability separately from project access.
- **extension-workspace-settings**: Workspace Settings sets shared AI provider, model, endpoint and team-server defaults once per workspace. Repo overrides win, inherited settings show their source, and reset restores defaults. Project config and environment credentials stay as fallbacks, and each repo keeps its server project mapping. New API keys and tokens go to VS Code SecretStorage, never shareable config, argv or webview state. The same defaults drive CLI runs and API connections. Connection tests report connectivity and project access without echoing secrets or running generation. The dashboard, sidebar and repo Settings link to one editor.
- **extension-plugins-view**: The Plugins view is driven by `plugin list --json` (description, enabled state, commands, errors). Switching projects refreshes it, and an older in-flight list cannot replace the selected project's result. Enable, Disable, Add (a modal stating the package's code will run) and Remove run the CLI, then restart the local API and refresh actions. Pipeline actions come from enabled plugins' commands, and heal commits only when the `git` plugin is enabled.
- **extension-generate-contract-mappings**: `SpecGuard: Generate Contract Mappings` offers a QuickPick of modes (spec text only; spec text + model; assess whether code helps; with code locally; with code + model) and a dry-run option. It runs `specguard contracts-map` with matching flags in a terminal at the manifest root (`--repo <key>` from a repo row), then offers to open each mapping file and build the contract graph. It is shown only when a workspace repo enables `contract-mappings`. `specguard.contracts` offers build, rebuild (`--force`) and with a model (`--with-llm`).
- **extension-docs-viewer**: Documentation ships in the package (`media/docs`, copied at build). `SpecGuard: Open Documentation` shows it in a singleton "SpecGuard Docs" panel with a manifest table of contents, in-panel links, external links through the host and no raw HTML from markdown. The topic can be a help key or `page.md#anchor`, and an unknown topic opens the index.
- **extension-help-view**: Help & Docs lists manifest pages grouped as Start here, Quickstarts, Reference and Developer. The repository dashboard's Docs tab offers the docs.
- **extension-help-popovers**: Question-mark icons on dashboard tabs, workspace sections and the Coverage, Pipelines and Plugins views show topic text and a Read more link. Every help key used exists in `docs/help-topics.json`.

<a id="plugin-system"></a>
### Plugin system
- **plugin-contract**: Plugins named in `config.plugins` may supply commands, catalog providers, implementation discoverers, external-id adapters, result sources, feature-state tuning, module stems and contract importers. An unknown or malformed name is a configuration error where a pipeline loads it, and core never imports a plugin by name.
- **core-plugin-boundary**: Core reaches optional functionality only through enabled plugins. `quality` exists only when a plugin provides it.
- **plugin-commands**: Plugin commands register as `specguard <name>` and `specguard_<name>` (typed inputs when declared), only while enabled. Config is read before commands are parsed, core wins name clashes, and an unloadable plugin is reported once and skipped so `init` still works.
- **plugin-catalog**: Built-in plugins are described in a catalog (id, title, description, interface parts, config key, whether `init` enables it). The catalog lists exactly the directories under `src/plugins/`, and each plugin exports its listed id. An npm plugin may describe itself with `meta`.
- **plugin-manage**: `plugin list [--json]` shows built-in and npm plugins with on/off, inherited via `extends` or turned off here, commands and load errors. `enable|disable <id>` edit only the repo's raw config. A repo with no list of its own writes one restating what it inherits, and a plugin enabled only by an extended config is turned off with `disabledPlugins`. A disabled npm plugin keeps its package.
- **plugin-add-remove**: `plugin add <id> --package <name> --yes [--install]` imports the package to check its id (this runs its code, so it is refused without `--yes`), installs with scripts disabled when asked, validates, and only then lists it. `plugin remove` drops it and refuses built-ins.
- **plugin-package-names**: Only valid npm package names are accepted. Paths, URLs, uppercase or spaced names are refused before import. A package not installed or exporting another id is refused, and a bare string never names a package.
- **plugin-surfaces**: The plugin list is served at `GET /api/v1/plugins` (read-only, empty with no working tree) and by `specguard_plugin_list`, which belongs to the extra tool set (`SPECGUARD_MCP_LEGACY=1`) because the default MCP list is capped at 16.
- **planned-plugin-extensions**: Plugins can add `detectors` (findings become `code` items in the remediation plan under the owning capability, reported but never auto-patched, closed only when the detector ran without warnings) and `docRenderers` (tried before the model, falling through on decline or failure). npm plugins load only from an explicit `{name, package}` allowlist resolved from the project's `node_modules`.

<a id="feature-catalog-and-state"></a>
### Feature catalog and state
- **feature-catalog**: The `feature-catalog` plugin reads a directory of YAML with a real parser, validated against a schema. Unversioned or malformed files and duplicate feature ids are errors naming the file. `catalogFormat: list` reads bare lists, and `catalogExclude` skips matching file names before parsing. GraphQL, REST and tRPC discoverers and generic, Zephyr and Jira id adapters are built in. `specguard features` lists each spec's feature back-references.
- **feature-state**: `features --state` reports per feature a summary, required channels and a state for UI, API and MCP (no, stub, built, broken, passing, proven), from specs, discovered implementations and results matched by feature id, tag or external id. An agent gate opens only on a latest passing unit or integration test. With no catalog it prints `[]` with a note and does not fail.
- **catalog-layout-config**: Layout is entirely `featureState` config (catalog dir and format, exclusions, results dirs, id rules, placeholder and MCP patterns, repo channels, module stems, agent tool declarations and exclusions). The catalog path is relative to the directory holding that config's `.specguard/` (also in overlays). No platform's layout is built in, and a test fails if a customer platform is named in code, docs or specs.

<a id="code-quality-and-git-helpers"></a>
### Code quality and git helpers
- **code-quality**: `quality` runs ESLint and Knip (and Ruff for Python) for every app or one app and can auto-fix. It writes findings to `.specguard/code-quality.json` with error and warning totals and exits 2 only on lint errors. An unavailable tool is a warning, and an unknown app name is rejected with the known list.
- **git-helpers**: `commit` stages and commits only SpecGuard-generated paths (tests, docs, specs, `.specguard/`, configured output directories). It supports `--dry-run`, a custom message and an originating pipeline. A clean tree or nothing to commit succeeds, and a missing git or failed add/commit exits 1. Each commit is appended to `.specguard/changelog.md`.
- **commit-never-secrets**: `commit` never stages env files (templates like `.env.example` excepted), private keys and certificates, credentials files, `.npmrc`, `.specguard/auth` or `.specguard/evidence`, even inside a safe root.

<a id="contract-mappings-contract-mappings-plugin"></a>
### Contract mappings (`contract-mappings` plugin)
- **contract-mappings-importer**: Adds contract edges from a JSON file of spec-to-provider mappings (location and key names from `contractMappings` config, with defaults). It yields nothing for a missing or malformed file.
- **contract-importer-ignores-extra-fields**: The importer ignores `generated`, `pinned`, `suggestions`, `reason`, `confidence`, `evidence` and `source`. Edges are identical with or without them.
- **contracts-map-spec-text**: `contracts-map` (MCP `specguard_contracts-map`) proposes consumer-to-provider mappings from spec text alone, with no model. Per consumer repo (role `consumer`, or all repos when none has a role) it matches by `repo::spec` reference (0.95), spec path (0.9), spec key or id (0.8) and whole-phrase title of two or more words (0.7). It keeps matches at or above `--min-confidence` and writes `.specguard/contract-mappings.json` per consumer repo, with provider paths relative to that repo and a `suggestions` list (provider, source, confidence, reason, evidence sentence).
- **contracts-map-merge**: Merging keeps hand work. An entry without `generated: true` is manual and untouched. A generated entry whose providers no longer equal its suggestions becomes manual. `pinned: true` entries stay. Other generated entries not found again are removed and listed under "Removed:". The output summarises added, kept, removed and unmatched specs per repo.
- **contracts-map-dry-run**: `--dry-run` prints the proposal and writes nothing.
- **contracts-map-llm-catalogue-only**: `--with-llm` asks only about specs with no text match (all with `--all-specs`). It sends frontmatter-stripped, secret-redacted spec text and a numbered provider catalogue, and rejects and logs any answer naming a provider outside the catalogue.
- **contracts-map-llm-egress-notice**: Before sending, it names the provider and model, lists each spec to be sent, and stops at `--max-llm-specs` (default 50), naming specs not sent.
- **contracts-map-code-extractors**: `--with-code` finds call sites and provider endpoints with built-in extractors (fetch, axios and ky calls, Angular `HttpClient`, Spring and JAX-RS annotations, Express and Fastify routes, OpenAPI; plugins may add `endpointExtractors`). Paths are normalised (origin, query and configured base prefixes dropped, parameters as `{}`). Matching is by exact path and method (0.9), normalised suffix (0.75) or base key and path tail (0.6).
- **contracts-map-code-ownership**: Code matches become `code`-source suggestions with evidence `file:line METHOD path`, mapping consumer and provider files to owning specs (spec-graph owned files, falling back to trace). A call site in a file no spec owns proposes nothing.
- **contracts-map-assess**: `--assess` reads only local files and writes nothing. It reports the share of consumer specs with no text match, call sites found (and how many are named in spec text or sit in unowned files) and provider endpoints per repo. It recommends "code likely helps", "spec text is sufficient" or "code won't help: no provider endpoint definitions found". A plain run prints a one-line hint from a cheap form of the assessment.
- **contracts-map-precision**: Only real dependencies are proposed:
  - When any repo has role `provider`, only provider repos are candidates.
  - The system spec is neither consumer nor candidate.
  - A title in a heading or table row is not a reference.
  - A title naming specs in more than one provider repo scores 0.5 and is flagged ambiguous.
  - An overlay app's code is read where its config `repo` points.
  - An endpoint defined in more than one provider repo is capped at 0.6 and flagged, unless `contractMappings.baseRepos` resolves the base.
  - `contractMappings.providerRepos` restricts a consumer's providers.
- **contracts-map-code-egress-opt-in**: Code goes to a model only when asked twice. `--send-code` requires `--with-llm` and sends only ±15-line excerpts around unmatched call sites plus the provider endpoint list, under the same notice and cap. It skips and logs any file that looks like it holds a secret.

<a id="code-map"></a>
## Code map

Sources:
- CLI: `src/cli/index.ts`, `src/cli/commands/{helpers,init,agent,ci,outputs,plugin,overlay,stubs,index}.ts`, `src/cli/plugin-commands.ts`
- Core: `src/core/{output-locations,scaffold,runner,ci-workflow,safe-path}.ts`, `src/core/endpoints/**`
- Pipelines: `src/pipelines/{start,init,plugin-manage,ci-run}.ts`
- CI: `src/ci/{context,github-api,pipeline-changes}.ts`
- MCP: `src/mcp/**`
- Plugins: `src/plugins/**`, `plugins/**`, `.claude-plugin/**`, `.agents/**`, `plugins/specguard/scripts/session-status.sh`
- Action: `action/**`, `action.yml`
- Extension: `extension/src/**`, `extension/scripts/build.mjs`, `extension/webview/src/**`
- Release: `Makefile`, `scripts/wait-for-ci.mjs`

The capability owns 188 files.

<a id="tests"></a>
## Tests

- `tests/core/`: `output-locations`, `make`, `release-ci`, `cli`, `exit-codes`, `version`, `scaffold`, `runner`, `mcp-server`, `extension`, `neutral` (fails if a customer platform is named), `endpoints*`, `ci-workflow`
- `tests/pipelines/`: `output-destinations`, `init`, `init-codex`, `feature-state`, `feature-state-collect`, `git-ops-changelog`, `git-ops-scope`, `ci-run`
- `tests/mcp/*.test.ts` (including `agent-work-tool`)
- `tests/action/run-gates.test.ts`
- `tests/cli/`: `features`, `check-base`, `ci`, `overlay`
- `tests/ci/`: `context`, `github-api`, `pipeline-changes`, `ci-workflow`
- `tests/plugins/`: `contracts-map*`, `plugin-package`, `session-status`, plus `tests/plugins/*.test.ts`
- `tests/hooks/overlay.test.ts`
- `extension/src/**/*.test.ts`

<a id="security-and-data"></a>
## Security and data

- **Agent config can run commands.** Setup never silently overwrites an existing hook or MCP entry. It prints a diff and always writes the exact runner it resolved. Malformed JSON is left unchanged.
- **Secrets.**
  - `.specguard/.env` is git-ignored by the managed block and excluded from CI evidence along with auth state.
  - Environment loading never overrides set variables.
  - Logs and results never include key values.
  - Tokens (GitHub, team server) are never put in errors, comments or command lines.
  - New extension secrets use SecretStorage.
- **MCP limits.** MCP runs with user privileges but is limited to read, generate and report. It is rate-limited, restricted to Markdown in spec directories, offers a read-only mode, and never performs remediation writes or stages non-generated files.
- **Commit safety.** `commit` and the activity log rules prevent staging secrets, personal data, auth state, browser evidence and the runtime activity log.
- **Plugins are code.** Built-ins load by name from a known location. The npm loader accepts only an explicit `{name, package}` allowlist with valid npm names. `plugin add` requires `--yes` because importing runs the package's code, and installs run with scripts disabled.
- **Egress.** Model use in `contracts-map` is opt-in, announced and capped, and redacts secrets. Code is sent only with both `--with-llm` and `--send-code`.
- **CI.** The Action token is needed only for remediate push/PR creation, comments and notes. Nothing is ever merged. The `prove` job holds no model API key. Forks and missing tokens degrade to read-only behaviour.
- **Spec inconsistency to resolve.** `init-bootstrap` says init writes no key file, while the Files-written list, the Security notes and the first scenario describe a `.specguard/.env` with a placeholder at creation. `exit-codes-and-env` ignores a placeholder written by an older init. Check actual behaviour before relying on either.

<a id="extending-it"></a>
## Extending it

- **Add behaviour as a plugin, not in core.**
  - A plugin may provide commands, catalog providers, implementation discoverers, external-id adapters, result sources, feature-state tuning, module stems, contract importers, `detectors`, `docRenderers` and `endpointExtractors`.
  - Plugin commands appear on CLI and MCP automatically while the plugin is enabled. Core names win clashes.
- **Add a built-in plugin.**
  - Create a directory under `src/plugins/`, export an id, and add a matching catalog entry (id, title, description, interface parts, config key, whether `init` enables it).
  - The catalog must list exactly the directories under `src/plugins/`.
- **Add an npm plugin.**
  - Run `specguard plugin add <id> --package <name> --yes [--install]`.
  - The package must export a plugin with that id and may describe itself with `meta`.
  - Use `plugin enable|disable|remove` to manage it. Built-ins cannot be removed.
- **Configure a platform's conventions.**
  - Use config (`featureState`, `contractMappings`) or an example configuration. Never name a platform in code, docs or specs, because `tests/core/neutral.test.ts` enforces this.
- **Add an MCP tool.**
  - Keep the default list within the 16-tool cap, and put extras behind `SPECGUARD_MCP_LEGACY=1`.
  - Tools that change files must be unavailable under `SPECGUARD_MCP_READONLY=1`.
- **Add a help topic.**
  - Add the key to `docs/help-topics.json` before using it in the extension.
