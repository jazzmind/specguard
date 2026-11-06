---
title: "Platform Foundation (developer reference)"
audience: dev
source: "specs/capabilities/platform-foundation.md"
generated: true
---
<a id="platform-foundation"></a>
# Platform Foundation

<a id="purpose"></a>
## Purpose

Platform Foundation is the shared engine under every SpecGuard capability. It gives every command and pipeline the same behaviour for:

- configuration discovery, validation and overlays
- model access: retries, fallbacks, spend caps, usage accounting, replay and the host-agent hand-off
- redaction of sensitive text
- file reading and writing
- language and framework profiles
- exit codes
- migration planning between spec formats

Without it, each pipeline could load config, handle model failures, scan files or pick exit codes in its own way. That would make the tool unpredictable, expensive, unsafe in CI and hard to test without a live model. With it, cross-cutting fixes live in one place.

Out of scope:
- Deciding which specs exist or whether code satisfies them.
- Running tests or browsers. This capability only describes how to find the right test command.
- Hosting a model gateway or managing API keys. Keys are read from the environment.
- Customer- or platform-specific configuration, which lives in project config or plugins.

<a id="responsibilities"></a>
## Responsibilities

- **Configuration:** find `.specguard/config.json`, validate it against one schema, apply defaults, and support `extends` and overlays. It exposes the directory that holds `.specguard/` as the root.
- **Model access:** provide one layer for all providers, with timeouts, retries with backoff, fallback chains, model tiers, per-pipeline overrides, spend caps, a usage log, record/replay, a hard off switch and an image block.
- **Host-agent provider:** when running inside a coding agent, write request files instead of calling a model, and serve the agent's recorded answers on the next run.
- **Redaction:** mask sensitive text in prompts and logs, using built-in and project-supplied rules.
- **File access:** provide reader and writer helpers, sentinel-delimited regions in hand-written files, and a managed ignore block for generated state.
- **Globbing:** never descend into dependency, build or VCS folders, and return sorted, unique, absolute paths.
- **Language profiles:** TypeScript, Python, Go, Rust and Java.
- **Errors and exit codes:** typed errors carrying stable exit codes.
- **Version:** a single source for the reported version.
- **Migration planning and apply:** plan and apply migrations between spec formats.
- **Repository hygiene:** a test that keeps private names out of tracked files.

<a id="interfaces"></a>
## Interfaces

**Files**
- `.specguard/config.json` (optional `extends`)
- `.specguard/llm-usage.json`
- `.specguard/replay/` (default replay directory)
- `.specguard/agent-requests/` (host-agent request files)
- `.specguard/cache/migrate/` (including `state.json` and timestamped backups)
- the managed ignore block in `.gitignore`
- Git's local `info/exclude` (activity-log ignore rules)
- sentinel regions in hand-written docs
- `$XDG_CONFIG_HOME/specguard/overlays.json`, else `~/.config/specguard/overlays.json` (per-user overlay registry)

**Config keys**
- `apps[]`, `paths.*`, `granularity.*`, `plugins`
- `llm.provider|model|apiKeyEnv`
- `llm.models.fast|frontier`
- `llm.pipelines.<name>`
- `llm.fallback`
- `llm.timeoutMs|retries|backoffMs`
- `llm.budget.maxUsd|maxTokens|maxCalls`
- `llm.pricing`
- `llm.replay.*`
- `llm.allowImages`
- `llm.redactPrompts`, `llm.redactPatterns`
- `validate.redaction.*`
- `proofStore` and `enforce` (added by migration)

**Environment variables**
- `SPECGUARD_IDE_LLM`
- `SPECGUARD_HOST_AGENT` (`1` enables, `0` disables)
- `SPECGUARD_OVERLAY` (path-list separated)
- `SPECGUARD_CONFIG`
- the named key variable for each provider (default `ANTHROPIC_API_KEY` for Anthropic)

**CLI flags and output**
- `--config <path>`, `--record`, `--json`
- `--version`, and `--version --json` (name, version and Node version on one line)
- `migrate`: `--yes`, `--allow-dirty`, `--consolidate`

**Providers:** `anthropic`, `openai`, `replay`, `none`, `host`, plus any provider the layer registers.

**Exit codes** (stable across releases)

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | internal (the default for typed errors) |
| 2 | validation failed |
| 3 | drift |
| 4 | missing specs |
| 5 | security issues |
| 7 | heal failed |
| 8 | budget exceeded |
| 12 | waiting for the host agent (not a failure) |

- `remediate` uses 8 to 11 for its own outcomes, scoped to that command.
- `migrate` also exits 14 while steps remain for the tool or a person.

**Programmatic entry points named in the spec:** `resolveConfigDir(start, env)` in `src/core/overlay.ts`, used by `loadConfig`.

<a id="requirements"></a>
## Requirements

<a id="configuration"></a>
### Configuration

- **config-discovery**: searches upward from the working directory for `.specguard/config.json` and stops at the repository boundary, so a parent repo's config is never inherited. If nothing is found, it raises a not-found error that names the search start and suggests `specguard init`.
- **config-validation**: one schema. Invalid JSON or an invalid field gives an invalid-config error. Unknown keys and `_comment` are tolerated. The directory holding `.specguard/` is exposed as the root.
- **config-extends**: a config extends exactly one other config by explicit path (file or directory). Keys merge one level deep, and a child's `apps` and arrays replace the parent's. A cycle or missing target is an invalid-config error.
- **config-apps-and-defaults**: apps carry language, repo directory, spec directory, source globs, framework, test output, test command settings, entry points, exclusions and prefix stripping. Top-level paths, granularity, plugin and validation settings are also supported. Defaults apply to anything omitted, including TypeScript as the default language and the whole `llm` block, so no model setup is needed to start.
- **config-editor-ai-defaults**: `SPECGUARD_IDE_LLM` may override only provider, model, key environment-variable name and endpoint. It applies after `extends` and before schema validation. Other project settings are retained and no file is rewritten. An omitted endpoint clears a previous one. Child CLI environments omit unset or inactive endpoint variables rather than passing empty strings. Malformed JSON or invalid fields fail as invalid configuration.
- **default-glob-excludes**: globs never descend into `node_modules`, `dist`, `build`, `coverage`, `.next` or `.git`. They return sorted, de-duplicated absolute paths and skip dot-files.
- **glob-literal-parens**: a parenthesised segment such as `app/(authenticated)/page.tsx` matches literally. Extglob forms (`!(a|b)`, `@(a|b)`) and already-escaped characters keep their meaning.
- **single-version-source**: one build version is reported by `--version`, `--version --json`, the MCP server and the extension.

<a id="overlays"></a>
### Overlays

- **overlay-resolution-order**: with no repo config, the order is (a) the repo's own config (including the git-boundary rule and `extends`), (b) `SPECGUARD_CONFIG`, (c) overlay entries (`SPECGUARD_OVERLAY` roots first, then the registry), each tier taking the deepest-ancestor-or-equal repo, (d) null, which `loadConfig` reports as the usual not-found error.
- **overlay-repo-config-wins**: a repo's own config always wins and carries no overlay metadata.
- **overlay-mode-semantics**: `loadConfig` in overlay mode behaves as if run from the overlay app's directory. `rootDir` is the folder holding that `.specguard/`, and `apps[].repo` resolves to the real repo. The config carries `resolvedVia` (`overlay`, `env-overlay` or `env-config`).
- **overlay-scan**: scans `**/.specguard/config.json` up to four levels below the root, skipping `node_modules`, `.git`, `dist` and dot-folders. An app whose repo is its own folder is an ordinary in-repo config. Invalid JSON, no apps, or a missing repo directory means the config is skipped and reported with the reason.
- **overlay-registry**: JSON of the form `{ version: 1, overlays: [{ root, addedAt, entries: [{ repo, config, app }] }] }`. It is written atomically with mode 600 in a 700 folder. A missing, corrupt or foreign file reads as empty with the problem named. With no home in the given environment there is no registry.
- **overlay-deepest-match**: matching is by real path, the deepest repo wins, and the walk stops at a git boundary.
- **overlay-ambiguity**: the same repo with different overlay configs raises a typed error naming both configs and saying to use `--config` or `SPECGUARD_CONFIG`. One config naming the same repo through several apps is not ambiguous.
- **overlay-env-roots**: `SPECGUARD_OVERLAY=<dir>[:<dir>...]` is scanned on the fly and takes precedence over the registry. A nonexistent root contributes nothing.
- **overlay-env-config**: `SPECGUARD_CONFIG` names a config file, its `.specguard` folder or the folder above it, and beats the registry. A value that names no config is an invalid-config error. `--config` works as before.
- **overlay-stale-entry**: a registry entry whose config was deleted is ignored with a warning naming `specguard overlay refresh <root>`. The not-found error hints at `specguard overlay add` when an overlay is registered but none matched.
- **overlay-no-change**: with no overlay and no config, the original `ConfigNotFoundError` message is unchanged, and only the registry file is read.
- **overlay-enclosing-git-root**: when no entry's repo contains the start directory, entries whose enclosing git root matches the start's git root apply. One distinct config resolves. Several distinct configs raise the ambiguity error, which asks the user to start inside an app or pass `--config`/`SPECGUARD_CONFIG`. The walk never goes above the start's own git root.

<a id="model-access"></a>
### Model access

- **llm-provider-layer**: one layer for all calls. The key comes only from a named environment variable and is never logged or put in an error. A missing key or unknown provider fails clearly. Structured output is validated against the caller's schema.
  - A reply with code fences or chatter is accepted if the object inside is valid.
  - A reply cut off at the output limit is retried once with twice the room (up to 32000 tokens).
  - An unusable reply fails with the reason and the start of the reply.
- **llm-timeout-retry**: each attempt has a timeout. Timeouts, rate limits, server errors and network resets are retried with exponential backoff and jitter. Authentication, validation and missing-key failures are never retried.
- **llm-fallback-chain**: after a target exhausts its attempts, an ordered chain (global or per pipeline) is tried. A budget or disabled-model error never triggers fallback.
- **llm-model-tiers**: `fast` and `frontier` tiers. Summarise, document and propose-history pipelines use `fast`. Cluster and review-specs pipelines use `frontier`. Precedence is pipeline override, then tier, then global default.
- **llm-pipeline-overrides**: per-pipeline provider, model, key variable, tier and fallback. The pipeline name comes from the CLI command or MCP tool.
- **llm-budget-cap**: a hard cap on tokens, calls or estimated dollars, per process run or per request scope in a server. Each scope has its own count, budget, config and user. Once the cap is reached or projected to be crossed, later calls fail with a budget error and the CLI exits 8 and says why. A scope's user and labels go to the provider, and its usage is reported to its callback.
- **llm-usage-log**: every real call adds tokens, call count and estimated cost, in total and per pipeline and model. It uses a built-in price table that config can override.
- **llm-replay-record**: the replay provider serves recordings keyed by a hash of prompt, system text and image bytes, with no network. A miss names the hash and how to record. `--record` or config writes every real response.
- **llm-disabled-and-images**: provider `none` fails every call with a disabled error without touching the network. Disallowing images rejects any call that carries them.
- **host-agent-provider**: applies with `llm.provider: "host"`, or when a keyed provider's key is unset inside a coding agent (Claude Code is auto-recognised; other agents use `SPECGUARD_HOST_AGENT=1`; `=0` turns it off). A call with no recorded answer writes a request file under `.specguard/agent-requests/` (system text, credential-masked prompt and, for structured output, the JSON Schema), records it as pending and raises a typed error with exit code 12, without calling a model. The agent records its answer in the replay store. The next run validates it with the caller's schema and serves it. An answer that fails the schema is set aside with the reason written on the request, so it is asked again.
- **host-agent-batching**: a step that makes many requests asks for all of them in one round (file summaries in batches of up to 25). It applies nothing and writes no system spec until every answer is in. It never records a guessed verdict: a drift judgement still waiting leaves the change unassessed. A hook's own call opts out so a hook never leaves a request behind.

<a id="redaction"></a>
### Redaction

- **secret-redaction**: masks emails, phone numbers, US SSNs, Luhn-valid card numbers, bearer and basic credentials (token-shaped values only, not prose like "basic requirements"), JWTs, private-key blocks, `password=`-style assignments and common API-key shapes, using fixed placeholders and running in linear time. Projects can add patterns, blank page selectors and a hook. It applies to every text kind, and re-redacting changes nothing.
- **prompt-redaction**: every model call has credentials masked in prompt and system message. A prompt with nothing sensitive is unchanged byte for byte, so replay recordings still match. `llm.redactPatterns` adds patterns (a non-regex pattern is skipped). `llm.redactPrompts: false` is the only way to turn it off.
- **log-redaction**: activity-log messages and the prompt preview in a replay recording pass through the redactor first.
- **redaction-hook-fails-closed**: the hook must be a synchronous function returning a string of at most 2,000,000 characters. A throw, a promise or any other result raises an error.
- **hook-path-inside-project**: a hook module must be a file inside the project. A URL, an absolute path elsewhere, `..` and a symlink leaving the project are refused before import.

<a id="files-ignore-rules-and-languages"></a>
### Files, ignore rules and languages

- **filesystem-access**: reads return UTF-8 text and reject on a missing file. Existence checks return false instead of throwing. Writes create intermediate directories and replace the file atomically (temp file renamed). Sentinel-delimited regions let SpecGuard own part of a hand-written file. Generated run state is kept out of version control through a managed ignore block.
- **ignore-block-nested-repos**: when a workspace manifest lists repos or units inside the git root, `init` and `migrate` write any-depth patterns (`**/.specguard/runs/` and so on). A repo whose manifest lists only itself or outside repos keeps root-anchored patterns.
- **activity-log-git-clean**: for untracked activity logs, persistence honors an existing ignore rule or adds a literal, project-specific rule to Git's local `info/exclude`. This covers nested folders, symlinked paths and linked worktrees. It does not edit versioned files or the index. Appends after commits leave a clean repo clean, and exclusions are idempotent. If no ignore rule can be established, optional persistence is skipped rather than creating an unignored file.
- **language-profiles**: source globs, test file naming, test command and result parsing for TypeScript, Python, Go, Rust and Java. The language is detected from marker files with a fixed tie-break, and per-app prefix stripping is honoured when deriving feature names.
- **no-private-names**: no tracked file contains a private project, employer or internal host name. A test compares every word of every tracked file with a list kept as SHA-256 hashes and fails naming the offending file.

<a id="errors"></a>
### Errors

- **errors-and-exit-codes**: typed errors carry an exit code (default 1), and codes are stable across releases (see Interfaces).

<a id="migration"></a>
### Migration

- **migrate-detect-format**: the format is detected from facts alone.
  - Per-file specs left in place mean v0.1, even beside drafted capability specs.
  - Capability specs plus tracked proofs or trace, a missing or outdated ignore block, or local rows claiming a CI origin mean v0.2-0.3.
  - Capability specs with everything current mean v0.6.
  - No specs of either kind mean none.
- **migrate-ordered-plan**: every step is listed in one fixed order (including `untrack-activity-log` after `untrack-trace`). Each has a state (todo, done, skip, person or agent), a description, and the exact paths and commands. States follow from the facts, and steps the repo cannot take (no git) are skipped with a "Blocked:" reason.
- **migrate-person-steps**: human steps are labelled `person` with the exact command. The planner never lists the as-built approval, or any approve command, as a step the tool runs. It is skipped only when every claim is already approved.
- **migrate-dry-run**: the text names the detected format and every step with its state, changed paths and commands. It also lists what is left for the person and the flags to apply with, and states that it changed nothing.
- **migrate-never-touches**: every dry run lists what is never touched: capability spec text and claims, test files apart from claim tags, source, `specs/history`, existing approvals, other workflows, git history and remotes.
- **migrate-v1-route**: for a v0.1 repo the default is to archive per-file specs and redraft capability specs as built. Consolidating is the alternative and, when asked for, replaces the archive, draft, tag and ledger steps with `spec consolidate`.
- **migrate-noop-current**: a current repo, or one with no specs, plans every step as done or skip, so the migration is a no-op success.
- **migrate-dry-run-changes-nothing**: by default, `specguard migrate` only prints the plan. Facts come from the git index, ignore block, proof ledger, spec frontmatter and the state file. A dry run writes no file and leaves the index and status as they were. It exits 0 only when nothing is left, 12 while agent work is pending, and 14 while steps remain for the tool or a person.
- **migrate-apply-untracks-state**: `migrate --yes` refreshes the managed ignore block and runs `git rm --cached` on the generated proof ledger, trace and any legacy tracked activity log, keeping contents on disk. It never commits, pushes or adds files to the index.
- **migrate-rows-provisional**: committed proof rows with origin absent or `ci` become origin `local` with an `imported: tracked-ledger@<sha>` marker. Rows already local keep their bytes. The untouched ledger is saved first under `.specguard/cache/migrate/<timestamp>/` with a manifest of what was applied and how to undo it.
- **migrate-archive-v1-keeps-history**: per-file specs move to `specs/_archive/v1/` via `git mv` (or a plain move without git), never over an existing archived file. Proof rows keyed to archived specs move into the backup. A markdown file without `kind:` counts as a per-file spec only if it has acceptance criteria or a `module:`.
- **migrate-resumable**: host-agent steps (drafting capability specs, tagging tests, or `spec consolidate` with `--consolidate`) are printed as exact commands and never run. The run exits 12 and records progress in `.specguard/cache/migrate/state.json`. A repo that has archived per-file specs and drafted none still reads as v0.1. Rerunning `migrate --yes` resumes, treating the tag step as done once a capability's tests carry its claim tags, until migration is marked complete.
- **migrate-idempotent-rerun**: rerunning on a migrated repo is a no-op success: every step is done or skip, nothing is written, the exit code is 0, and the uncommitted tree a first run left is not refused.
- **migrate-refuses-dirty-tree**: `migrate --yes` refuses a dirty working tree (exit 2, nothing changed, paths named) unless `--allow-dirty` is given. A migration already under way is not refused.
- **migrate-config-and-hooks-additive**: `proofStore` and `enforce` are inserted into the config text only when absent, leaving every other byte and key order as written. A config that has both is not written. Guard hooks join `.claude/settings.json` only when it already has SpecGuard hooks and lacks them. An invalid or hook-less file is left alone.
- **migrate-person-steps-never-run**: approving what the code does today, committing and pushing are printed with their exact commands and never run. After an apply, those steps keep the exit code at 14. Migrate never touches source, tests, capability specs, `specs/history/` or existing approvals.

<a id="code-map"></a>
## Code map

The spec lists files without per-file responsibilities. The only explicit mapping is that `resolveConfigDir` lives in `src/core/overlay.ts`. The groupings below are inferred from file names.

**Sources (22 owned files)**
- Config and overlays: `src/core/config.ts`, `src/core/overlay.ts`
- Model layer: `src/core/llm.ts`, `src/core/llm-runtime.ts`, `src/core/llm-usage.ts`, `src/core/llm-replay.ts`, `src/core/agent-work.ts`
- Redaction: `src/core/redact.ts`
- File access and ignore handling: `src/core/reader.ts`, `src/core/writer.ts`, `src/core/sentinels.ts`, `src/core/state-ignore.ts`, `src/core/activity-ignore.ts`
- Languages: `src/core/language-profiles.ts`
- Errors, exit codes, version and shared types: `src/core/errors.ts`, `src/core/exit-codes.ts`, `src/core/version.ts`, `src/core/types.ts`
- Migration: `src/core/migrate-plan.ts`, `src/cli/commands/migrate.ts`, `src/pipelines/migrate.ts`, `src/legacy/index.ts`

<a id="tests"></a>
## Tests

- Activity-log ignore: `tests/core/activity-ignore.test.ts`, `extension/src/dashboard/activity-log.test.ts`
- Config: `tests/core/config.test.ts`, `tests/core/config-phase3.test.ts`, `tests/core/contracts-phase3.test.ts`
- Overlays: `tests/core/overlay.test.ts`, `tests/core/config-overlay.test.ts`, `tests/helpers/overlay-fixture.ts` (a helper rather than a test)
- Model layer: `tests/core/llm.test.ts`, `tests/core/llm-layer.test.ts`, `tests/core/llm-tiers.test.ts`
- Host agent: `tests/core/agent-work.test.ts`, `tests/pipelines/host-agent-flow.test.ts`
- Redaction: `tests/core/redact.test.ts`
- Files: `tests/core/reader.test.ts`, `tests/core/writer.test.ts`
- Errors and exit codes: `tests/core/errors.test.ts`, `tests/core/exit-codes.test.ts`
- Languages and version: `tests/core/language-profiles.test.ts`, `tests/core/version.test.ts`
- Repository hygiene: `tests/regression/no-private-names.test.ts`
- Migration: `tests/core/migrate-plan.test.ts`, `tests/pipelines/migrate.test.ts`, `tests/cli/migrate.test.ts`

**Scenarios the tests should cover**
- A nested repo with no config does not use the parent's config (not-found error, exit 1).
- `extends` merges one level deep, and a cycle is an invalid-config error.
- A budget cap of 20 calls stops the run and exits 8.
- A record-then-replay run reproduces output with no network, and a changed prompt gives a miss naming the hash.
- A primary that returns server errors is retried and then falls back, while an authentication error is not retried.
- Redaction masks an email, a card number and a bearer token plus a project pattern, and a second pass changes nothing.
- Globs never return paths under dependency or VCS folders, and results are sorted, unique and absolute.

<a id="security-and-data"></a>
## Security and data

- Config stores only the names of environment variables that hold keys, never values. Errors and logs must not contain a resolved key.
- The redactor is the single gate before text leaves the machine. Redaction fails closed for hooks. Hook modules must be project-local files, and plugin or hook modules execute code and load only from paths the project names.
- `provider: none` is a hard off switch, and `llm.allowImages` blocks image calls. Spend caps are a safety control as well as a cost control.
- Replay recordings contain prompts and responses. Treat them as repository content. Their prompt previews are redacted first.
- Globs never reach dependency or VCS directories, which also keeps third-party code out of prompts.
- Config loading never walks past the repo boundary. Overlay matching also stops at git boundaries, and ambiguity is an error, never a guess.
- The overlay registry is written with mode 600 in a 700 folder.
- Host-agent request files contain credential-masked prompts.
- Migration never commits, pushes or adds files to the index, and it backs up the ledger before changing it.

<a id="extending-it"></a>
## Extending it

The spec defines these extension points. It says nothing about internal registration APIs, so check the code for those.

- **Add a provider:** the layer registers providers beyond `anthropic`, `openai`, `replay` and `none`. A new provider must follow the layer's rules:
  - take its key only from a named environment variable
  - never leak the key
  - fail clearly when the key is missing
  - validate structured output
  - use the shared retry, fallback, budget and usage behaviour
- **Add a pipeline:** name it so that overrides under `llm.pipelines.<name>` work, and choose `fast` or `frontier` as its tier. The name comes from the running CLI command or MCP tool.
- **Add redaction rules:** use `llm.redactPatterns`, `validate.redaction.*` patterns, blank page selectors or a hook. A hook must be synchronous, return a string of at most 2,000,000 characters, and live inside the project.
- **Add or adjust a language profile:** supply source globs, test naming, test command and result parsing, and keep marker-file detection and the tie-break deterministic.
- **Change prices:** override the built-in table with `llm.pricing`.
- **Add a migration step:** keep the plan order fixed and give the step a state derived from facts. Make it additive, never touch the "never touched" list, and print person and agent steps as commands instead of running them.
- **Add an exit code:** codes are stable across releases, so existing values must not change. Typed errors carry the code, with a default of 1.
- **Any change to the reported version:** keep it in the single version source so the CLI, MCP server and extension stay consistent.
