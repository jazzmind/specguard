---
title: "Integration Surfaces - CLI, Agents, CI, IDE and Plugins"
audience: user
source: "specs/capabilities/integration-surfaces.md"
generated: true
---
<a id="integration-surfaces-cli-agents-ci-ide-and-plugins"></a>
# Integration Surfaces: CLI, Agents, CI, IDE and Plugins

SpecGuard can be driven from a terminal, a coding agent, a CI pipeline or VS Code, and it can be extended with plugins. All of these surfaces run the same underlying operations, so results are consistent wherever you work.

<a id="why-it-exists"></a>
## Why it exists

A spec-driven tool only helps if it fits how people already work. Developers use a terminal, coding agents use a harness, release managers use CI, and reviewers use an editor. If each needed different setup, behaved differently, or quietly changed your own configuration, you would not trust or adopt the tool.

Teams also have their own conventions, such as feature catalogs, test-management ids and lint tools. SpecGuard keeps these out of its core. You switch them on as optional plugins, and no platform's layout is built in.

<a id="what-you-can-do"></a>
## What you can do

<a id="use-the-command-line"></a>
### Use the command line

- Run `specguard <command>`. Every subcommand has help, and `--version` prints the version. `--version --json` prints one line of JSON.
- Use the global options on any command:
  - `--config <path>` points at a config file, a directory, or a path containing `/.specguard/`.
  - `--json` gives a machine-readable result with the exit code and suppresses human output.
  - `--record` is also accepted by every command.
- Rely on stable exit codes:

  | Code | Meaning |
  |---|---|
  | 0 | Success |
  | 1 | Internal or usage error |
  | 2 | Validation failed |
  | 3 | Drift |
  | 4 | Missing specs |
  | 5 | Security issues |
  | 7 | Heal failed |
  | 8 | LLM budget exceeded |
  | 12 | Waiting for the host agent |
  | 13 | A pull request is blocked at an enforced capability |

  Remediation has its own codes, 8 to 11.
- Variables in `.specguard/.env` are loaded before commands run. They never override variables you have already set.

<a id="set-up-a-project"></a>
### Set up a project

- **`specguard init`** creates a config and a `specs/README.md`. It detects your language and test framework (`--with-playwright` forces Playwright). It never asks for an API key and never overwrites existing files. It reports what it created and what it skipped, and it adds a managed git-ignore block for generated state. If git already tracks such files, it prints the command to untrack them. Running it again changes nothing.
- **Agent files:** `init --harness claude|cursor|both` (or `scaffold`) writes the agent instructions, skills, a goal command and MCP wiring. It adds a post-edit status hook and, for Claude, an edit guard. Files marked as SpecGuard-managed are refreshed, hand-written files are left alone, and content outside managed sections is preserved.
- **Hooks and settings:** unrelated keys in your settings are kept. Malformed JSON is reported and left unchanged. If an existing hook differs from the generated one, SpecGuard prints a diff and leaves the file alone. Add `--update-hooks` to apply the change. Entries written in an older broken form are repaired automatically.
- **Runner:** `--runner node|npx|path` chooses how generated commands call SpecGuard.
- **Other options:**
  - `init --history-hooks` captures prompts and plans into the requirement history through personal, uncommitted hooks.
  - `init --codex` adds the Codex guard and a rules file that forbids `specguard spec approve`. Without that flag, no Codex files are written.
  - `init --ci github` writes pull-request and remediation workflows. It never overwrites an existing workflow and writes none unless you ask.
- **`specguard start`** takes a project from nothing to a first report in one resumable command. It sets up the project, drafts specs, links tests to requirements, runs tests (unless `--skip-tests`) and prints where things stand. If a step is waiting for your coding agent, it stops with exit 12. Run it again to continue.

<a id="let-coding-agents-drive-specguard"></a>
### Let coding agents drive SpecGuard

- **MCP server:** the `specguard-mcp` server runs over stdio. It offers one tool per core command, plus `read_spec` and `write_spec`, named `specguard_<command>`. A failed call returns an error result and the server keeps running.
- **Spec files:** agents can read and write only Markdown files inside your spec directories. Paths that escape the project are refused.
- **Limits:** by default an agent can make 300 tool calls a minute and 20 history entries a minute. A call over the limit gets an error result naming the setting to change.
- **Read-only mode:** set `SPECGUARD_MCP_READONLY=1` to remove every tool that creates or changes files, plus plugin tools.
- **Answering model requests:** when SpecGuard needs a model answer, the host coding agent supplies it.
  - `specguard agent pending` lists the waiting requests.
  - `specguard agent answer <hash>` records an answer from a file or stdin. A hash prefix of 8 or more characters is enough, and a JSON answer may sit in a markdown code fence.
  - The `specguard_agent_work` tool does the same over MCP.
- **Claude Code and Codex plugins:** the repository is a plugin marketplace for both. One plugin, `specguard`, installs in one line, needs no API key inside the agent and writes nothing into your project. It ships the skills, `start` and `check` commands, a `specguard` executable, the MCP server, and a session-start hook. The hook prints a short status only in projects that use SpecGuard. The Claude plugin also guards edits and shell commands. It stays silent in projects without SpecGuard and fails open. The Codex plugin carries no hooks.

<a id="gate-pull-requests-in-ci"></a>
### Gate pull requests in CI

- **The GitHub Action** installs the SpecGuard version you request and runs your chosen gates in a fixed order: status, drift, proof, align, results, validate, security, check, test, verify, scan. `deps` is an alias of `scan`. An unknown gate is rejected before anything runs.
- **Pass/fail rules:** `fail-on` decides what fails the job, for example `fail-on: drift,proof-failed`. Other options include `missing-specs`, the `proof-*` conditions, `align-below:<n>`, `results`, `validate`, `security`, `check`, `test`, `verify`, `scan` and `none`. A gate that did not run, or a missing proof ledger, never fails the job.
- **Outputs:** the Action writes a job summary and JSON per gate, and uploads `.specguard/` as evidence, excluding secrets and saved login state.
- **Options:**
  - `affected: true` tests only the units a pull request changed.
  - `sarif: true` uploads scan results to GitHub code scanning.
  - `mode: remediate` runs dependency remediation, optionally opening a pull request. It never merges.
- **Pull request comment:** the Action posts one comment and updates it on later runs. It lists the tripped thresholds, the key numbers and how they moved since the last run. If it cannot comment (no token, a fork, an API error), it says so and does not fail the job.
- **Proving a pull request without a model:** `specguard ci run` reruns only the proofs that are stale, missing or changed, and carries the rest forward from the nearest earlier proof note.
  - It checks that changed requirements are approved, proven, and that their tests fail against the old code.
  - A ready pull request exits 0 with one packet comment.
  - Capabilities set to `enforce` block with exit 13 and name each cause and the fix.
  - Capabilities set to `warn` show findings and annotations but never fail the run. Capabilities set to `observe` neither block nor annotate.
  - The `prove` gate wraps this in the Action.
- **Diagnostics:**
  - `ci doctor` reports what `ci run` would do in your environment, without a network call or printing the token.
  - `ci packet [file]` renders a saved proof packet.
  - `ci run --event <file>` replays a recorded event.
- **Risky pull request files:** changes to workflows, the SpecGuard config, the code owners file or the Action are flagged. Adding or editing one is a warning. Deleting or renaming one away is an error.

<a id="work-inside-vs-code"></a>
### Work inside VS Code

- **Sidebar:** the views appear in this order: Workspace, Coverage, Pipelines, Plugins, Help & Docs. Workspace works even when the active repo has no coverage or its coverage fails to load.
- **Dashboard:** a dashboard panel shows coverage, recent pipeline runs, drift, traceability and agent activity. It also shows the extension version, the Git revision and working changes, and how recent the last spec check is. Missing or differing check evidence is shown as needing a refresh.
- **Workspace view:** repository rows preview a dashboard on a single click and activate on a double click. Cards show compact catalog and proof summaries, with technical diagnostics collapsed by default.
- **Outputs:** clicking Specs, Tests or Docs opens a searchable inventory. Archived specs and dependency or build output are excluded. Team-server specs and docs are included when you are signed in, and local files remain available if the server cannot answer.
- **Where outputs go:** before Generate, Reverse, Import, Docs or Gap Analysis writes anything, the editor shows the application and destination. It offers existing runnable directories or an alternate, and remembers your choice. Cancelling starts nothing.
- **Agent setup preview:** before updating agent files, the extension previews what will happen per file. Custom rules in CLAUDE.md are kept. Marked skills, commands and AGENTS.md are replaced. Unmarked standalone files are skipped. Unrelated JSON settings and MCP entries are retained. Cancelling runs nothing, and a failed setup never records a successful version.
- **Test report:** `SpecGuard: Open Test Report` (or the Test report row in the sidebar) opens the workspace report. It builds the report if it is missing or you ask for a rebuild. You can move between the rollup and per-repo pages, view screenshots and video inline, open other evidence in VS Code and open Playwright traces. Links that leave the report folder are refused.
- **Team server:** the workspace panel shows the server, your sign-in state, and one row per repo: up to date, needs publish (with reasons), never published, or an error. You can check, publish one repo, publish all, publish the workspace definition and open the server report. Publishing test evidence is a separate opt-in that shows the size still to upload.
- **Settings:** Workspace Settings sets the AI provider, model, endpoint and team-server defaults once per workspace. Repository overrides win, and inherited values show their source. New API keys and tokens go into VS Code's secret storage. Connection tests report connectivity and project access without echoing secrets or generating anything.
- **Docs and help:** `SpecGuard: Open Documentation` shows the bundled docs in a panel. The Help & Docs view groups pages as Start here, Quickstarts, Reference and Developer. Question-mark icons throughout the dashboards show short help with a Read more link.
- **Contract mappings:** `SpecGuard: Generate Contract Mappings` offers modes (spec text only, with a model, assess, with code, with code and a model) plus a dry-run option. It appears only when a workspace repo enables the `contract-mappings` plugin.

<a id="extend-specguard-with-plugins"></a>
### Extend SpecGuard with plugins

- **Enabling plugins:** name them in `plugins` in your config. A misspelt or malformed name is reported once, for example `plugins not loaded: unknown plugin 'typo'`, and none of its commands are registered. `init` still works with a broken config.
- **Plugin commands:** an enabled plugin's commands appear as `specguard <name>` on the CLI and `specguard_<name>` over MCP. Core commands win on a name clash. Plugins can also supply catalog providers, discoverers, result sources, detectors and doc renderers.
- **Managing plugins:**
  - `specguard plugin list [--json]` shows each built-in and configured npm plugin, whether it is on, whether it is inherited or turned off here, its commands, and any load error.
  - `plugin enable|disable <id>` edits only your repo's own config.
  - `plugin add <id> --package <name> --yes [--install]` registers an npm plugin. It is refused without `--yes`, because importing a package runs its code. Only valid npm package names are accepted, never paths or URLs.
  - `plugin remove` drops a plugin from the list and refuses built-ins.
- **In VS Code:** the Plugins view shows each plugin's description, state, commands and errors, with Enable, Disable, Add and Remove actions. Pipeline actions come from the enabled plugins.

Built-in plugins include:

- **Feature catalog:**
  - **Catalog:** read from a directory of YAML files that you describe in `featureState` config. A malformed or unversioned file, or a duplicate feature id, is an error naming the file.
  - **`specguard features`:** lists features and their spec links.
  - **`specguard features --state`:** shows, per feature, a summary and the state of UI, API and MCP: no, stub, built, broken, passing or proven. It also shows whether an agent may run on the feature. That gate opens only when the latest unit or integration test passes. With no catalog it prints `[]` with a note and does not fail.
- **Code quality:**
  - **`specguard quality [--app] [--fix]`:** runs ESLint and Knip (and Ruff for Python) and can auto-fix lint issues. It writes totals to `.specguard/code-quality.json`.
  - **Exit codes:** it exits 2 only when lint errors exist. An unavailable tool is a warning, and an unknown app name is rejected with the list of known ones.
- **Git helpers:** `specguard commit [--dry-run] [--message] [--app] [--pipeline]` stages and commits only SpecGuard-generated paths and logs each commit to `.specguard/changelog.md`. It never stages files that hold secrets or personal data, such as environment files, keys, credentials and saved login state.
- **Contract mappings:**
  - **`specguard contracts-map`:** proposes which consumer specs depend on which provider specs, using spec text alone, with no model by default. It writes a mappings file per consumer repo with confidence scores and evidence.
  - **Re-runs:** hand-edited, manual and pinned entries are preserved. Stale generated entries are removed and listed.
  - **Options:**
    - `--dry-run` writes nothing.
    - `--assess` reads local files only and tells you whether using code is likely to help.
    - `--with-llm` asks a model only about unmatched specs. It first says which provider and model, lists each spec it will send, and stops at `--max-llm-specs` (default 50).
    - `--with-code` finds call sites and endpoint definitions.
    - `--send-code` also sends small code excerpts. It requires `--with-llm` and skips files that look like they hold secrets.

<a id="work-with-overlays"></a>
### Work with overlays

An overlay keeps specs and config outside the code repository. The `specguard overlay` subcommands are:

- `add <dir>` registers an overlay.
- `list` shows registered overlays and flags stale ones.
- `refresh [dir]` rescans.
- `remove <dir>` forgets an overlay without touching its files.
- `resolve [dir]` shows which config, overlay and app a directory resolves to.

All of them accept `--json`. When a command runs through an overlay, `check` and `status` print `configured via overlay <root> (app <name>)` as their first line. The edit guard, session-start status and VS Code extension all recognise overlay-covered folders as configured.

<a id="developing-and-installing-locally"></a>
### Developing and installing locally

`make help` groups commands for local use, development, validation and publishing, with example flows. `make install` builds and installs this checkout's CLI and VS Code extension. `make build-vsix` packages the extension without installing it. Local installs and packaging never tag or publish. `make release-check` and `make publish` confirm that the latest CI run on `main` succeeded for the exact commit being released. They watch a running build to completion, and block with an explanation before any tag or push if the run failed, was cancelled, is missing or is unreadable.

<a id="what-to-expect"></a>
## What to expect

- **Safe by default:** setup never silently overwrites an existing hook, MCP entry, hand-written file or workflow. It prints a diff or skips the file and tells you. Running setup again is safe.
- **Secrets:** `init` asks for no API key, and logs and results never include key values. `.specguard/.env` is git-ignored and excluded from CI evidence uploads. Tokens are never passed on command lines or shown in errors.
- **No surprise commits:** SpecGuard never stages its runtime activity log. The commit command stages only SpecGuard-generated files.
- **Limited agent reach:** MCP tools are limited to reading, generating and reporting. Remediation over MCP is scan-only and dry-run, and nothing is ever merged automatically.
- **Plugins are code:** built-in plugins load by name from a known location. npm plugins load only when you list them explicitly by package name, because importing a package runs its code.
- **CI degrades gracefully:** if a pull request comes from a fork, no token is available or a comment is refused, SpecGuard skips that step, reports it, and still decides pass or fail from the exit code. The one hard error is a missing base commit, such as a shallow checkout of a pull request, which exits 1.
- **When a model is needed:** commands that need one may stop with exit 12 and say what is waiting and how to answer it. Run the command again after answering.
- **Activity log:** every MCP tool call is logged as running, then pass, fail or error, with its duration. The log is trimmed to the latest 200 entries once it exceeds 1 MB, and it recovers from invalid content.
- **Not covered here:** hosting a documentation site or API, running builds or tests for you beyond invoking the CLI, platform-specific integrations (those are plugins or example configuration), and editors other than VS Code and compatible ones. Those editors can use the CLI or MCP.
