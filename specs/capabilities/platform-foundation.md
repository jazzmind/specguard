---
id: platform-foundation
kind: capability
title: Platform Foundation
parent: system
value: Every SpecGuard capability runs on one predictable engine for configuration, model access, cost control, redaction, file access and exit codes, so behaviour is consistent, safe and testable.
status: active
sources:
  - "src/core/config.ts"
  - "src/core/llm.ts"
  - "src/core/llm-runtime.ts"
  - "src/core/llm-usage.ts"
  - "src/core/llm-replay.ts"
  - "src/core/agent-work.ts"
  - "src/core/redact.ts"
  - "src/core/reader.ts"
  - "src/core/writer.ts"
  - "src/core/language-profiles.ts"
  - "src/core/errors.ts"
  - "src/core/exit-codes.ts"
  - "src/core/types.ts"
  - "src/core/version.ts"
  - "src/core/sentinels.ts"
  - "src/core/state-ignore.ts"
  - "src/core/activity-ignore.ts"
  - "src/core/migrate-plan.ts"
  - "src/cli/commands/migrate.ts"
  - "src/pipelines/migrate.ts"
  - "src/legacy/index.ts"
  - "src/core/overlay.ts"
tests:
  - "tests/core/activity-ignore.test.ts"
  - "tests/core/contracts-phase3.test.ts"
  - "extension/src/dashboard/activity-log.test.ts"
  - "tests/core/config.test.ts"
  - "tests/core/config-phase3.test.ts"
  - "tests/core/llm.test.ts"
  - "tests/core/llm-layer.test.ts"
  - "tests/core/llm-tiers.test.ts"
  - "tests/core/redact.test.ts"
  - "tests/core/reader.test.ts"
  - "tests/core/writer.test.ts"
  - "tests/core/errors.test.ts"
  - "tests/core/exit-codes.test.ts"
  - "tests/core/agent-work.test.ts"
  - "tests/pipelines/host-agent-flow.test.ts"
  - "tests/regression/no-private-names.test.ts"
  - "tests/core/language-profiles.test.ts"
  - "tests/core/version.test.ts"
  - "tests/core/migrate-plan.test.ts"
  - "tests/pipelines/migrate.test.ts"
  - "tests/cli/migrate.test.ts"
  - "tests/core/overlay.test.ts"
  - "tests/core/config-overlay.test.ts"
  - "tests/helpers/overlay-fixture.ts"
docs:
  - "README.md"
  - "docs/user/config.md"
  - "docs/user/llm.md"
  - "docs/user/errors.md"
  - "docs/user/exit-codes.md"
  - "docs/user/reader.md"
  - "docs/user/writer.md"
history:
  - 2026-10-29-editor-endpoint-startup
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-22-intent-catch-up-for-the-2026-10-19-chang
  - 2026-10-22-security-hardening-from-audit-sast-and-p
  - 2026-10-22-header-role-fix-and-spec-level-security
  - 2026-10-22-security-plugin-and-hook-modules-are-loa
  - 2026-10-22-security-no-rate-limit-or-throttle-on-re
  - 2026-10-22-security-replay-recordings-containing-se
  - 2026-10-25-specguard-proves-intent-not-metrics-thre
  - 2026-10-25-0-4-the-host-coding-agent-does-the-model
  - 2026-10-26-migration-planning-is-a-pure-idempotent
  - 2026-10-26-migrate-applies-the-plan-idempotently-an
  - 2026-10-26-overlay-spec-sources-specs-kept-outside
  - 2026-10-27-host-agent-tests-isolate-the-inherited-c
  - 2026-10-27-keep-runtime-activity-logging-out-of-com
  - 2026-10-28-workspace-defaults-and-secure-editor-cre
---

# Platform Foundation

## Problem & Value
A tool that reads whole repositories, calls paid language models and gates CI builds has to behave the same way in every command. If each pipeline loaded configuration its own way, handled model failures differently, scanned dependency folders, or invented its own exit codes, the tool would be unpredictable, expensive and unsafe to automate. It would also be impossible to test without a live model.

Platform Foundation is the shared engine underneath every other capability. It finds and validates configuration, gives every pipeline one model-access layer with retries, fallbacks, spend caps, usage accounting and deterministic replay, redacts sensitive text before it leaves the machine, reads and writes files safely, knows how to treat each language and framework, and reports outcomes through a small stable set of exit codes. Users get predictable cost and behaviour; maintainers get one place to fix cross-cutting problems.

## Users & Journeys
- A developer runs any SpecGuard command inside a repo and it finds the right `.specguard/config.json` without silently inheriting a parent repo's settings.
- A team lead sets a spend cap in config so a runaway pipeline stops instead of running up a bill, and CI sees a distinct exit code when that happens.
- A platform engineer routes the fast and frontier tiers to different models, and overrides one pipeline to use a stronger model.
- A test author records real model responses once with `--record` and replays them in CI with no network and no API key.
- A security reviewer relies on the redactor to mask emails, card numbers and tokens before page snapshots or prompts are sent to a model.
- A CI script branches on exit codes (2 validation failed, 3 drift, 5 security issues, 8 budget reached) to decide what to do next.
- A monorepo owner declares several apps in one config, each with its own language, spec directory and test runner.

## Requirements
- [ ] For activity logs that Git does not track, persistence honors an existing ignore rule or adds a literal, project-specific rule to Git's local `info/exclude`, including nested folders, symlinked paths and linked worktrees, without editing versioned files or the Git index; repeated appends after commits leave an otherwise clean repository clean, exclusions are idempotent, and a failure to establish an ignore rule skips optional persistence rather than creating an unignored file <!-- claim: activity-log-git-clean -->
- [ ] Configuration is found by searching upward from the working directory for `.specguard/config.json`, stopping at the repository boundary so a repo without its own config never inherits a parent repo's; no config, and no overlay covering the directory, yields a not-found error that names the search start and suggests `specguard init` <!-- claim: config-discovery -->
- [ ] Configuration is validated against one schema: invalid JSON or an invalid field fails with a readable invalid-config error, unknown keys and `_comment` are tolerated, and the directory that holds `.specguard/` is exposed to every pipeline as the root <!-- claim: config-validation -->
- [ ] An editor may pass non-secret AI settings to its child CLI through `SPECGUARD_IDE_LLM`: only provider, model, key environment-variable name and endpoint override the project AI settings, after extends and before normal schema validation. Project paths, budgets and other settings are retained and no project file is rewritten; an omitted endpoint clears a previous provider endpoint. Child CLI environments omit inactive or unset endpoint variables instead of supplying empty strings, so SDK initialization cannot prevent overlay discovery or plugin listing. Malformed JSON and invalid fields fail as invalid configuration. <!-- claim: config-editor-ai-defaults -->
- [ ] A config may extend exactly one other config by explicit path (file or directory) and nothing else is inherited: keys merge one level deep, a child's `apps` and arrays replace the parent's, and a cycle or missing target is an invalid-config error <!-- claim: config-extends -->
- [ ] Config describes one or more apps, each with language, repo directory, spec directory, source globs, framework, test output, test command settings, entry points, exclusions and path-prefix stripping, plus top-level paths, granularity, plugin and validation settings; sensible defaults apply to anything omitted, including TypeScript as the default language and the whole `llm` block (Anthropic with `ANTHROPIC_API_KEY`, or the key variable that goes with a named provider), so a project needs no model setup to start <!-- claim: config-apps-and-defaults -->
- [ ] Glob expansion never descends into dependency, build or VCS directories (node_modules, dist, build, coverage, .next, .git) even when a pattern would reach them, returns only sorted, de-duplicated absolute file paths, and skips dot-files <!-- claim: default-glob-excludes -->
- [ ] Every model call goes through one layer that supports multiple providers, takes the API key only from a named environment variable, never logs or includes the key in an error, fails clearly on a missing key or unknown provider, and validates structured output against the caller's schema <!-- claim: llm-provider-layer -->
- [ ] Each model attempt has a timeout; retryable failures (timeouts, rate limits, server errors, network resets) are retried with exponential backoff and jitter a configurable number of times, while authentication, validation and missing-key failures are never retried <!-- claim: llm-timeout-retry -->
- [ ] After a target exhausts its attempts, an ordered fallback chain (global or per pipeline) is tried; a budget or disabled-model error never triggers fallback <!-- claim: llm-fallback-chain -->
- [ ] Named model tiers `fast` and `frontier` can be configured; pipelines that summarise, document or propose history use `fast` and those that cluster or review specs use `frontier`, a pipeline's own override wins over its tier, and the tier wins over the global default <!-- claim: llm-model-tiers -->
- [ ] A per-pipeline override can set provider, model, key variable, tier and fallback for one named pipeline, where the pipeline name comes from the running CLI command or MCP tool <!-- claim: llm-pipeline-overrides -->
- [ ] A hard spend cap on tokens, calls or estimated dollars applies per process run, or per request scope in a server (each scope has its own count, budget, config and user, so concurrent requests cannot spend or reset one another's): once reached or projected to be crossed, every later call in that run or scope fails with a budget error and the CLI exits 8 and says why; a scope's user and labels are sent to the provider, and its usage is reported to its callback <!-- claim: llm-budget-cap -->
- [ ] Every real call adds tokens, call count and estimated cost to a usage log, in total and per pipeline and model, using a built-in price table that config can override <!-- claim: llm-usage-log -->
- [ ] A replay provider serves recorded responses keyed by a hash of the prompt, system text and image bytes with no network call; a miss names the hash and how to record, and `--record` or config writes every real response so a later run reproduces it <!-- claim: llm-replay-record -->
- [ ] Setting the provider to `none` makes every model call fail with a disabled error without touching the network so deterministic-only runs work, and disallowing images rejects any call that carries them <!-- claim: llm-disabled-and-images -->
- [ ] With `llm.provider: "host"`, or a keyed provider whose key is not set while running inside a coding agent (Claude Code is recognised on its own, other agents through `SPECGUARD_HOST_AGENT=1`, which `=0` turns off), a model call with no recorded answer writes a request file (system text, credential-masked prompt and, for structured output, the JSON Schema of the answer) under `.specguard/agent-requests/`, records it as pending and raises a typed error whose exit code is 12, without calling any model; the agent records its answer in the replay store, the next run validates it with the caller's schema and serves it, and an answer that fails the schema is set aside with the reason written on the request so it is asked again <!-- claim: host-agent-provider -->
- [ ] Host-agent calls never leave a mess: a step that makes many requests (file summaries, one spec per capability, test tagging) asks for all of them in one round (summaries in batches of up to 25 files), applies nothing and writes no system spec until every answer is in, never records a guessed verdict (a drift judgement still waiting for the agent leaves the change unassessed instead of recording "every requirement affected"), and a call a hook makes on its own opts out so a hook never leaves a request behind <!-- claim: host-agent-batching -->
- [ ] No tracked file of the repository contains the name of a private project, an employer or an internal host: a test compares every word of every tracked file with a list kept as SHA-256 hashes, so the list names no one, and fails with the offending file <!-- claim: no-private-names -->
- [ ] The redactor masks emails, phone numbers, US social security numbers, Luhn-valid card numbers, bearer and basic credentials (a token-shaped value, never the words in prose such as "basic requirements"), JWTs, private-key blocks, `password=`-style assignments and common API-key shapes with fixed placeholders, in time linear in the input; projects can add patterns, blank page selectors and a hook, redaction applies to every text kind, and re-redacting already redacted text changes nothing <!-- claim: secret-redaction -->
- [ ] File access goes through small reader and writer helpers: reads return UTF-8 text and reject on a missing file, existence checks return false instead of throwing, and writes create intermediate directories and replace the file atomically (a temp file renamed over it, so a reader never sees half a write); sentinel-delimited regions let SpecGuard own part of a hand-written file without touching the rest, and generated run state is kept out of version control through a managed ignore block <!-- claim: filesystem-access -->
- [ ] Language and framework profiles describe source globs, test file naming, test command and result parsing for TypeScript, Python, Go, Rust and Java, detect the language from marker files with a fixed tie-break, and honour per-app prefix stripping when deriving feature names <!-- claim: language-profiles -->
- [ ] Failures use typed errors that carry an exit code (default 1), and exit codes are stable across releases: 0 success, 1 internal, 2 validation failed, 3 drift, 4 missing specs, 5 security issues, 7 heal failed, 8 budget exceeded, 12 waiting for the host agent (not a failure), with remediation-specific codes 8 to 11 scoped to that command <!-- claim: errors-and-exit-codes -->
- [ ] One build version is reported everywhere: `--version` prints it, `--version --json` prints name, version and Node version on one line, and the MCP server and extension report the same value <!-- claim: single-version-source -->
- [ ] A glob names a path literally where it can: a parenthesised segment such as the Next.js route group `app/(authenticated)/page.tsx` matches the folder `(authenticated)` instead of being read as a glob group, while extglob forms (`!(a|b)`, `@(a|b)`) and already-escaped characters keep their meaning <!-- claim: glob-literal-parens -->
- [ ] What SpecGuard writes down for people to read later is passed through the secret redactor first: activity-log messages (a failure can quote a command line or a response that held a credential) and the prompt preview in an LLM replay recording, which is committed <!-- claim: log-redaction -->
- [ ] Every model call, from every pipeline, has credentials masked in its prompt and system message before it leaves the machine (JWTs, bearer and basic tokens, provider API keys, private keys, `password=` and `secret=` values; a prompt with nothing sensitive is unchanged byte for byte, so replay recordings still match); `llm.redactPatterns` adds the project's own patterns, a pattern that is not a regular expression is skipped, and `llm.redactPrompts: false` is the only way to turn it off <!-- claim: prompt-redaction -->
- [ ] A redaction hook fails closed: it must be a synchronous function returning a string of at most 2,000,000 characters, and a throw, a promise or any other result raises an error instead of letting text through that the project's own rules never saw <!-- claim: redaction-hook-fails-closed -->
- [ ] A redaction hook module is a file inside the project: a URL, an absolute path elsewhere, `..` and a symlink that leaves the project are refused before it is imported <!-- claim: hook-path-inside-project -->
- [ ] The migration planner detects the repository's format from facts alone: per-file specs left in place mean v0.1 (even beside drafted capability specs), capability specs with tracked proofs or trace, a missing or outdated ignore block, or local rows claiming a CI origin mean v0.2-0.3, capability specs with everything current mean v0.6, and no specs of either kind mean none. <!-- claim: migrate-detect-format -->
- [ ] The migration plan always lists every step in one fixed order (including `untrack-activity-log` after `untrack-trace`) with a state (todo, done, skip, person or agent), a description, and the exact paths and commands involved; each step's state follows from the facts, so a half-migrated repo shows only what is left, and steps the repository cannot take (no git) are skipped with a "Blocked:" reason. <!-- claim: migrate-ordered-plan -->
- [ ] Steps that need a human are labelled person and carry the exact command to run, and the planner never lists the as-built approval (or any approve command) as a step the tool runs; it is skipped only when every claim is already approved. <!-- claim: migrate-person-steps -->
- [ ] The migration dry-run text names the detected format, every step with its state, changed paths and commands, what is left for the person, and the flags to apply with, and states that it changed nothing. <!-- claim: migrate-dry-run -->
- [ ] Every migration dry run lists what is never touched (capability spec text and claims, test files apart from claim tags, source, specs/history, existing approvals, other workflows, git history and remotes), and no planned change edits or deletes those. <!-- claim: migrate-never-touches -->
- [ ] The default route for a v0.1 repository, whatever its spec count, is to archive the per-file specs and redraft capability specs as built; consolidating is listed as the alternative and, when asked for, replaces the archive, draft, tag and ledger steps with `spec consolidate`. <!-- claim: migrate-v1-route -->
- [ ] A repository that is already current (and one with no specs) plans every step as done or skip, so the migration is a no-op success. <!-- claim: migrate-noop-current -->
- [ ] `specguard migrate` reads the repository without changing it and, by default, only prints the plan: the facts come from the git index, the ignore block, the proof ledger, spec frontmatter and the migration's state file; a dry run writes no file (no state, no backup) and leaves the git index and status as they were, and exits 0 only when nothing is left, 12 while agent work is pending, and 14 while steps remain for the tool or a person <!-- claim: migrate-dry-run-changes-nothing -->
- [ ] `migrate --yes` refreshes the managed ignore block and stops tracking the generated proof ledger, trace and any legacy tracked activity log with `git rm --cached`, keeping their contents on disk; it never commits, never pushes and never adds a file to the index, so the only staged changes are the removals it names <!-- claim: migrate-apply-untracks-state -->
- [ ] Committed proof rows whose origin is absent or `ci` become origin `local` with an `imported: tracked-ledger@<sha>` marker, because a committed row earned no CI trust; rows that were already local keep their bytes, and the untouched ledger is saved first under `.specguard/cache/migrate/<timestamp>/` next to a manifest of what was applied and how to undo it <!-- claim: migrate-rows-provisional -->
- [ ] Per-file (v1) specs are archived under `specs/_archive/v1/` with `git mv` (history follows them) or a plain move without git, never over an existing archived file; proof rows keyed to the archived specs move out of the local ledger into the backup, and a markdown file without `kind:` counts as a per-file spec only when it has acceptance criteria or a `module:`, so a stray note is never moved <!-- claim: migrate-archive-v1-keeps-history -->
- [ ] Steps that need the host agent (drafting capability specs, tagging tests, or `spec consolidate` with `--consolidate`) are printed as exact commands and never run by migrate; the run exits 12 and records its progress in `.specguard/cache/migrate/state.json`, so a repository that has archived its per-file specs and drafted none yet still reads as v0.1, and rerunning `migrate --yes` resumes, treating the tag step as done once a capability's tests carry its claim tags, until the migration is marked complete <!-- claim: migrate-resumable -->
- [ ] Rerunning `migrate --yes` on a migrated repository is a no-op success: every step reads done or skip, nothing is written, the exit code is 0, and the tree a first run left uncommitted is not refused <!-- claim: migrate-idempotent-rerun -->
- [ ] `migrate --yes` refuses to start on a working tree with uncommitted changes (exit 2, nothing changed, the paths named) unless `--allow-dirty` is given; a migration already under way, which left its own changes, is not refused <!-- claim: migrate-refuses-dirty-tree -->
- [ ] Configuration and hooks are only added to: `proofStore` and `enforce` are inserted into the user's config text when absent, leaving every other byte, key order and value as written (a config that has both is not written), and the guard hooks join `.claude/settings.json` only when it already has SpecGuard hooks and lacks them; an invalid or hook-less file is left alone <!-- claim: migrate-config-and-hooks-additive -->
- [ ] Everything that is a person's decision is printed with its exact command and never run: approving what the code does today, committing and pushing; after an apply those steps keep the exit code at 14, and migrate never touches source, tests, capability specs, `specs/history/` or existing approvals <!-- claim: migrate-person-steps-never-run -->
- [ ] When a repository has no config of its own, the config is resolved in one fixed order (`resolveConfigDir(start, env)` in `src/core/overlay.ts`, used by `loadConfig`): (a) the repository's own `.specguard/config.json` exactly as before, including the git-boundary rule and `extends`; (b) `SPECGUARD_CONFIG`; (c) overlay entries, the roots named by `SPECGUARD_OVERLAY` first and then the per-user registry, each tier taking the entry whose repo is the deepest ancestor-or-equal of the start directory; (d) otherwise null, which `loadConfig` reports as the same not-found error as before <!-- claim: overlay-resolution-order -->
- [ ] A repository's own config always wins over an overlay entry or `SPECGUARD_CONFIG`, and a config loaded from the repository's own `.specguard/` carries no overlay metadata and behaves exactly as it did before overlays existed <!-- claim: overlay-repo-config-wins -->
- [ ] `loadConfig` in overlay mode returns the overlay app's config exactly as if the command had run from the overlay app's directory: `rootDir` is the folder that holds that `.specguard/`, so specs, the proof ledger, caches and the trace resolve inside the overlay, and `apps[].repo` resolves to the real repository; the config carries `resolvedVia` (`overlay`, `env-overlay` or `env-config`, with the overlay root, repo and app) so a message can say where it came from <!-- claim: overlay-mode-semantics -->
- [ ] An overlay is scanned for `**/.specguard/config.json` up to four levels below its root (skipping node_modules, .git, dist and dot-folders): each `apps[].repo` is read as raw JSON and resolved against the folder that holds `.specguard/`; an app whose repo is that folder itself is an ordinary in-repo config, and a config that is not valid JSON, has no apps, or names a repo directory that does not exist is skipped and reported with the reason <!-- claim: overlay-scan -->
- [ ] The per-user overlay registry is `$XDG_CONFIG_HOME/specguard/overlays.json`, else `~/.config/specguard/overlays.json` (and none when the given environment names no home, so a test never touches the real one); it holds `{ version: 1, overlays: [{ root, addedAt, entries: [{ repo, config, app }] }] }` derived from scans, is written atomically with mode 600 in a 700 folder, and a missing, corrupt or foreign file reads as empty with the problem named, never as an error <!-- claim: overlay-registry -->
- [ ] An overlay entry matches a directory when its repo is an ancestor-or-equal of it, compared by real path (so `/tmp` and `/private/tmp` agree), the deepest such repo wins, and the walk stops at a git boundary the way the in-repo lookup does, so a nested repository with no config is not taken to be part of an outer repo that an overlay covers <!-- claim: overlay-deepest-match -->
- [ ] Two entries with the same repo but different overlay configs are ambiguous: resolution fails with a typed error that names both configs (with their overlay roots and apps) and says to pick one with `--config` or `SPECGUARD_CONFIG`, and never guesses; one config that names the same repo through several apps is not ambiguous <!-- claim: overlay-ambiguity -->
- [ ] `SPECGUARD_OVERLAY=<dir>[:<dir>...]` (the path-list separator) names overlay roots that are scanned on the fly with no registration and take precedence over the registry; a nonexistent root contributes nothing <!-- claim: overlay-env-roots -->
- [ ] `SPECGUARD_CONFIG` names a `.specguard/config.json`, its `.specguard` folder or the folder above it, and then applies to every start directory that has no config of its own, beating the registry; a value that names no config is an invalid-config error, and the `--config <path>` flag keeps working as before <!-- claim: overlay-env-config -->
- [ ] A registry entry whose config file was deleted is ignored with a warning that names the fix (`specguard overlay refresh <root>`), so the directory reads as not configured rather than failing, and the not-found error carries a hint about `specguard overlay add` when an overlay is registered but none matched <!-- claim: overlay-stale-entry -->
- [ ] With no overlay registered or named in the environment and no config, `loadConfig` throws the same `ConfigNotFoundError` message as before, with no extra hint, and resolving reads no file other than the registry <!-- claim: overlay-no-change -->
- [ ] An overlay entry also covers the git repository that encloses its repo folder: when no entry's repo contains the start directory, entries whose enclosing git root (nearest `.git` above the entry's repo, by real path) equals the git root enclosing the start match, so a repo opened at its root resolves to the entry for the app folder inside it; exactly one distinct config resolves to it, several distinct configs (a monorepo whose apps each have an entry, started at its root) are the ambiguity error with a message that says to start inside one of the apps (listing their folders) or pass `--config` or `SPECGUARD_CONFIG`; the walk never goes above the start's own git root, so a folder that holds several repos, or one outside any repo, matches nothing <!-- claim: overlay-enclosing-git-root -->

## Scenarios
### Scenario 1: Run inside a sub-repo with no config
**Steps:**
1. A developer has a parent folder with `.specguard/config.json` and a nested git repo with none.
2. The developer runs `specguard status` inside the nested repo.

**Expected Results:**
- The command fails with a not-found error naming the directory it searched from and suggesting `specguard init`.
- The parent config is not used.
- The exit code is 1.

### Scenario 2: Inherit a shared config on purpose
**Steps:**
1. A repo's config sets `"extends": "../shared"` and overrides `llm.budget` and `apps`.
2. A command loads the config.

**Expected Results:**
- Parent keys merge one level deep; the child's `apps` replace the parent's.
- If the shared config points back to the child, loading fails with an invalid-config error about the cycle.

### Scenario 3: A runaway pipeline hits the spend cap
**Steps:**
1. Config sets `llm.budget.maxCalls` to 20.
2. A developer runs `specguard reverse --all` on a large app.

**Expected Results:**
- After 20 calls, further calls fail with a budget error and the command stops.
- The CLI says the budget was reached and exits 8.
- The usage log shows the tokens, calls and estimated cost spent, by pipeline and model.

### Scenario 4: Deterministic CI with replay
**Steps:**
1. A developer runs a pipeline once with `--record`.
2. CI runs the same pipeline with `provider: "replay"` and no API key.
3. A later change alters a prompt.

**Expected Results:**
- CI reproduces the recorded output with no network call.
- After the prompt change, the miss error names the prompt hash and says how to record again.

### Scenario 5: Provider failure falls back
**Steps:**
1. Config sets a primary model and a two-entry fallback chain.
2. The primary returns server errors; the first fallback is healthy.

**Expected Results:**
- The primary is retried with backoff up to the configured limit.
- The first fallback then serves the request.
- An authentication error on the primary is not retried.

### Scenario 6: Sensitive text is masked before sending
**Steps:**
1. A validation run collects page text containing an email, a card number and a bearer token.
2. The text is redacted before being sent to a model.

**Expected Results:**
- Placeholders replace all three values.
- A project pattern for internal ticket ids also masks those.
- Running the redactor again on the result changes nothing.

### Scenario 7: Dependencies are never scanned
**Steps:**
1. An app's source glob is `**/*.ts` and the repo contains `node_modules` and `dist`.
2. Any pipeline expands the glob.

**Expected Results:**
- No path under `node_modules`, `dist`, `.git` or similar is returned.
- Results are sorted, unique and absolute.

## Security & Data Considerations
Config stores only the names of environment variables that hold keys and credentials, never their values; error messages and logs must not contain a resolved key. Prompts and page text can contain personal or secret data, so the redactor is the single gate before text leaves the machine, and the LLM layer supports a hard off switch (`provider: none`) and an image block for sensitive environments. Spend caps are a safety control as well as a cost control. Replay recordings contain prompts and responses and should be treated as repository content. Globs never reach dependency or VCS directories, which also keeps third-party code out of model prompts. Config loading never walks past the repo boundary, so a stray parent config cannot silently change behaviour. Config-selected plugin or hook modules execute code and are loaded only from paths the project names.

## Interfaces
- Files: `.specguard/config.json` (with optional `extends`), `.specguard/llm-usage.json`, `.specguard/replay/` (default replay directory), managed ignore block in `.gitignore`, sentinel regions in hand-written docs.
- Config keys: `apps[]`, `paths.*`, `granularity.*`, `plugins`, `llm.provider|model|apiKeyEnv`, `llm.models.fast|frontier`, `llm.pipelines.<name>`, `llm.fallback`, `llm.timeoutMs|retries|backoffMs`, `llm.budget.maxUsd|maxTokens|maxCalls`, `llm.pricing`, `llm.replay.*`, `llm.allowImages`, `validate.redaction.*`.
- CLI flags and output: `--config <path>`, `--record`, `--version`, `--version --json`, `--json`.
- Exit codes: 0, 1, 2, 3, 4, 5, 7, 8 as listed above; `remediate` uses 8 to 11 for its own outcomes.
- Providers: `anthropic`, `openai`, `replay`, `none`, plus any provider the layer registers.

## Out of Scope
- Deciding which specs exist or whether code satisfies them (other capabilities).
- Running tests or browsers; this capability only describes how to find the right command.
- Hosting a model gateway or managing API keys; it reads keys from the environment.
- Any customer or platform specific configuration; those live in project config or plugins.
