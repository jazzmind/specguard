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
tests:
  - "tests/core/config.test.ts"
  - "tests/core/llm.test.ts"
  - "tests/core/llm-layer.test.ts"
  - "tests/core/llm-tiers.test.ts"
  - "tests/core/redact.test.ts"
  - "tests/core/reader.test.ts"
  - "tests/core/writer.test.ts"
  - "tests/core/errors.test.ts"
  - "tests/core/exit-codes.test.ts"
  - "tests/core/language-profiles.test.ts"
  - "tests/core/version.test.ts"
docs:
  - "README.md"
  - "docs/user/config.md"
  - "docs/user/llm.md"
  - "docs/user/errors.md"
  - "docs/user/exit-codes.md"
  - "docs/user/reader.md"
  - "docs/user/writer.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
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
- [ ] Configuration is found by searching upward from the working directory for `.specguard/config.json`, stopping at the repository boundary so a repo without its own config never inherits a parent repo's; no config yields a not-found error that names the search start and suggests `specguard init` <!-- claim: config-discovery -->
- [ ] Configuration is validated against one schema: invalid JSON or an invalid field fails with a readable invalid-config error, unknown keys and `_comment` are tolerated, and the directory that holds `.specguard/` is exposed to every pipeline as the root <!-- claim: config-validation -->
- [ ] A config may extend exactly one other config by explicit path (file or directory) and nothing else is inherited: keys merge one level deep, a child's `apps` and arrays replace the parent's, and a cycle or missing target is an invalid-config error <!-- claim: config-extends -->
- [ ] Config describes one or more apps, each with language, repo directory, spec directory, source globs, framework, test output, test command settings, entry points, exclusions and path-prefix stripping, plus top-level paths, granularity, plugin and validation settings; sensible defaults apply to anything omitted, including TypeScript as the default language <!-- claim: config-apps-and-defaults -->
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
- [ ] The redactor masks emails, phone numbers, US social security numbers, Luhn-valid card numbers, bearer and basic credentials (a token-shaped value, never the words in prose such as "basic requirements"), JWTs, private-key blocks, `password=`-style assignments and common API-key shapes with fixed placeholders, in time linear in the input; projects can add patterns, blank page selectors and a hook, redaction applies to every text kind, and re-redacting already redacted text changes nothing <!-- claim: secret-redaction -->
- [ ] File access goes through small reader and writer helpers: reads return UTF-8 text and reject on a missing file, existence checks return false instead of throwing, and writes create intermediate directories and replace the file atomically (a temp file renamed over it, so a reader never sees half a write); sentinel-delimited regions let SpecGuard own part of a hand-written file without touching the rest, and generated run state is kept out of version control through a managed ignore block <!-- claim: filesystem-access -->
- [ ] Language and framework profiles describe source globs, test file naming, test command and result parsing for TypeScript, Python, Go, Rust and Java, detect the language from marker files with a fixed tie-break, and honour per-app prefix stripping when deriving feature names <!-- claim: language-profiles -->
- [ ] Failures use typed errors that carry an exit code (default 1), and exit codes are stable across releases: 0 success, 1 internal, 2 validation failed, 3 drift, 4 missing specs, 5 security issues, 7 heal failed, 8 budget exceeded, with remediation-specific codes 8 to 11 scoped to that command <!-- claim: errors-and-exit-codes -->
- [ ] One build version is reported everywhere: `--version` prints it, `--version --json` prints name, version and Node version on one line, and the MCP server and extension report the same value <!-- claim: single-version-source -->
- [ ] A glob names a path literally where it can: a parenthesised segment such as the Next.js route group `app/(authenticated)/page.tsx` matches the folder `(authenticated)` instead of being read as a glob group, while extglob forms (`!(a|b)`, `@(a|b)`) and already-escaped characters keep their meaning <!-- claim: glob-literal-parens -->

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
