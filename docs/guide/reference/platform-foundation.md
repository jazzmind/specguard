---
title: "Platform Foundation"
audience: user
source: "specs/capabilities/platform-foundation.md"
generated: true
---
<a id="platform-foundation"></a>
# Platform Foundation

Platform Foundation is the shared engine under every SpecGuard command. It handles configuration, model access, spending limits, redaction of sensitive text, file handling, language support and exit codes. Every command therefore behaves the same way, whichever one you run.

<a id="why-it-exists"></a>
## Why it exists

SpecGuard reads whole repositories, calls paid language models and can gate CI builds. That only works if every command:

- loads configuration the same way,
- handles model failures the same way,
- skips dependency folders,
- reports results with the same exit codes.

Otherwise the tool would be unpredictable, expensive and unsafe to automate. Because everything shares one foundation, you get predictable cost and behaviour. Tests can also run without a live model.

<a id="what-you-can-do"></a>
## What you can do

<a id="configure-a-project"></a>
### Configure a project

- **Run commands from anywhere in a repo.** SpecGuard searches upward from your working directory for `.specguard/config.json`. It stops at the repository boundary, so a repo without its own config never silently picks up a parent repo's settings.
- **Start with almost nothing.** Omitted settings get sensible defaults. TypeScript is the default language, and the model setup defaults to Anthropic with the `ANTHROPIC_API_KEY` environment variable (or the matching key variable for a provider you name).
- **Describe one or more apps.** Each app can have its own language, repo directory, spec directory, source globs, framework, test output, test command, entry points, exclusions and path-prefix stripping. A monorepo owner can declare several apps in one config.
- **Share a base config.** A config can extend exactly one other config by explicit path (file or directory). Keys merge one level deep, and the child's `apps` and arrays replace the parent's. A cycle or missing target is an invalid-config error.
- **Let an editor supply AI settings.** An editor can pass non-secret AI settings (provider, model, key variable name, endpoint) to SpecGuard through `SPECGUARD_IDE_LLM`. These override the project's AI settings, but paths, budgets and other settings are kept and no project file is rewritten.
- **Point at a specific config.** Use `--config <path>` or the `SPECGUARD_CONFIG` environment variable.

<a id="use-a-config-that-lives-outside-the-repo-overlays"></a>
### Use a config that lives outside the repo (overlays)

If a repo has no config of its own, SpecGuard looks in this fixed order:

1. The repo's own `.specguard/config.json`. It always wins.
2. `SPECGUARD_CONFIG`. This can name the config file, its `.specguard` folder or the folder above it.
3. Overlay entries. Roots named in `SPECGUARD_OVERLAY` (separated like a path list) come first, then the per-user overlay registry. In each group, the entry whose repo is the closest enclosing match wins.
4. Otherwise a "not found" error that names where the search started and suggests `specguard init`.

Overlays work like this:

- A config found through an overlay behaves as if you had run the command from the overlay app's directory. Specs, the proof ledger and caches live inside the overlay, while the app's repo points to the real repository.
- An overlay is scanned for configs up to four levels below its root. Configs that are invalid, have no apps or name a missing repo directory are skipped and reported with the reason.
- The registry lives in your user config folder. If it is missing or unreadable, it reads as empty with the problem named, never as an error.
- If a registered overlay's config file has been deleted, SpecGuard ignores it and warns you to run `specguard overlay refresh <root>`.
- An overlay entry also covers the git repository that encloses its repo folder. Open a repo at its root and SpecGuard resolves to the single matching app folder inside it.
- If two entries claim the same repo with different configs, or a monorepo root matches several apps, SpecGuard never guesses. It fails with a message naming the candidates and asks you to start inside one app or pass `--config` or `SPECGUARD_CONFIG`.

<a id="control-how-models-are-used"></a>
### Control how models are used

- **Choose a provider.** Built-in providers are `anthropic`, `openai`, `replay` and `none`. Keys are read only from the environment variable you name, and keys are never logged or included in error messages. A missing key or unknown provider fails clearly.
- **Pick model tiers.** Configure `fast` and `frontier` models. Pipelines that summarise, document or propose history use `fast`. Pipelines that cluster or review specs use `frontier`. A pipeline's own override beats its tier, and the tier beats the global default.
- **Override a single pipeline.** Set provider, model, key variable, tier and fallback for one named pipeline.
- **Survive failures.** Each attempt has a timeout. Timeouts, rate limits, server errors and network resets are retried with exponential backoff and jitter, up to a number you configure. Authentication, validation and missing-key failures are never retried.
- **Fall back to other models.** After a target runs out of attempts, an ordered fallback chain (global or per pipeline) is tried. Budget and disabled-model errors never trigger fallback.
- **Get structured answers reliably.** When a model must return structured output, it is checked against the expected shape. A reply wrapped in code fences or chatter is still used if the object inside is valid. A reply cut off at the output limit is retried once with twice the room, up to 32,000 tokens. If a reply still can't be used, the error gives the reason and the start of the reply.
- **Turn models off.** `provider: "none"` makes every model call fail with a "disabled" error without touching the network, so deterministic-only runs work. Disallowing images rejects any call that carries one.

<a id="cap-spending-and-track-usage"></a>
### Cap spending and track usage

- **Set a hard cap** on tokens, calls or estimated dollars (`llm.budget.maxTokens`, `maxCalls`, `maxUsd`). The cap applies per process run. In a server it applies per request scope, so concurrent requests can't spend or reset one another's budgets.
- **Hit the cap safely.** Once the cap is reached, or a call is projected to cross it, every later call in that run or scope fails with a budget error. The CLI says why and exits with code 8.
- **See what was spent.** Every real call adds tokens, call count and estimated cost to a usage log, in total and per pipeline and model. A built-in price table does the estimating, and you can override it in config.

<a id="record-and-replay-model-responses"></a>
### Record and replay model responses

- Run with `--record` (or set it in config) to save every real model response.
- Run later with the `replay` provider to get the same answers with no network and no API key.
- Replay answers are matched by the exact prompt, system text and image content. If something changes and a response isn't found, the error names the prompt hash and explains how to record again.

<a id="work-with-a-coding-agent-host-mode"></a>
### Work with a coding agent (host mode)

If `llm.provider` is `host`, or a keyed provider has no key set while SpecGuard runs inside a coding agent, SpecGuard doesn't call a model. Claude Code is recognised automatically. Other agents need `SPECGUARD_HOST_AGENT=1`, and `=0` turns detection off. Instead, when a call has no recorded answer:

1. SpecGuard writes a request under `.specguard/agent-requests/`. It contains the system text, the credential-masked prompt and, for structured output, the shape of the expected answer.
2. It marks the request as pending and exits with code 12. This means "waiting for the agent", not a failure.
3. The agent records its answer.
4. On the next run, SpecGuard checks the answer against the expected shape and uses it. An answer that fails the check is set aside with the reason written on the request, so it is asked again.

For steps that make many requests (file summaries, one spec per capability, test tagging), all requests go out in one round. Summaries are batched up to 25 files at a time. Nothing is applied and no system spec is written until every answer is in. A drift judgement still waiting for the agent leaves the change unassessed rather than recording a guess. A call made by a hook never leaves a request behind.

<a id="keep-sensitive-text-private"></a>
### Keep sensitive text private

Before any text leaves your machine for a model, credentials in the prompt and system message are masked. This covers JWTs, bearer and basic tokens, provider API keys, private keys and `password=` or `secret=` values. A prompt with nothing sensitive is unchanged byte for byte, so recordings still match.

The full redactor also masks emails, phone numbers, US social security numbers, valid card numbers, JWTs, private-key blocks, `password=`-style assignments and common API-key shapes. It uses fixed placeholders, and running it again on already-redacted text changes nothing.

You can customize it:

- `llm.redactPatterns` adds your own patterns. A pattern that isn't a valid regular expression is skipped.
- `llm.redactPrompts: false` is the only way to turn prompt masking off.
- Projects can add patterns, blank page selectors and a redaction hook for page snapshots and other text. A hook must be a synchronous function returning a string of at most 2,000,000 characters. If it throws, returns a promise or returns anything else, SpecGuard raises an error rather than letting unchecked text through. The hook must be a file inside your project. URLs, absolute paths elsewhere, `..` and symlinks that leave the project are refused.

Things SpecGuard writes down for people to read later are also redacted. This applies to activity-log messages and to the prompt preview in a replay recording, which is committed.

<a id="find-files-safely"></a>
### Find files safely

- Glob matching never goes into `node_modules`, `dist`, `build`, `coverage`, `.next` or `.git`, even if a pattern would reach them. Results are sorted, unique, absolute paths, and dot-files are skipped.
- A parenthesised folder name such as the Next.js route group `app/(authenticated)/page.tsx` is matched literally. Extglob forms like `!(a|b)` and `@(a|b)`, and already-escaped characters, keep their usual meaning.
- Writes create any missing folders and replace the file in one step, so a reader never sees a half-written file.
- SpecGuard can own a marked region of a hand-written file without touching the rest of it.
- Generated run state is kept out of version control through a managed block in `.gitignore`. In an overlay or monorepo whose manifest lists repos inside the git root, `init` and `migrate` use any-depth patterns, such as `**/.specguard/runs/`, so nested repos' generated state is ignored too.
- For activity logs Git doesn't track, SpecGuard honors an existing ignore rule or adds a project-specific rule to Git's local exclude list. It does not edit versioned files or the Git index. If it can't set up an ignore rule, it skips optional persistence rather than create an unignored file.

<a id="support-several-languages"></a>
### Support several languages

Built-in profiles for TypeScript, Python, Go, Rust and Java cover source globs, test file naming, test commands and result parsing. The language is detected from marker files with a fixed tie-break. Per-app prefix stripping is honored when feature names are derived.

<a id="upgrade-an-existing-repository-with-specguard-migrate"></a>
### Upgrade an existing repository with `specguard migrate`

`specguard migrate` moves a repository to the current format.

- **Dry run by default.** It reads the repo and prints a plan without writing anything: no state file, no backup, and the git index and status are unchanged. The plan names the detected format and lists every step, always in the same order, with its state (todo, done, skip, person or agent), a description, and the exact paths and commands involved. It also lists what is left for a person, the flags to apply with, and what is never touched. It states that it changed nothing.
- **Format detection.** Per-file specs mean v0.1. Capability specs with tracked proofs or trace, a missing or outdated ignore block, or local rows claiming a CI origin mean v0.2–0.3. Capability specs with everything current mean v0.6. No specs means none.
- **Applying with `--yes`.** It refreshes the managed ignore block and stops tracking the generated proof ledger, trace and any legacy tracked activity log. It uses `git rm --cached`, so the contents stay on disk. It never commits, pushes or adds files to the index.
- **Committed proof rows** whose origin is absent or `ci` become `local`, because a committed row earned no CI trust. The untouched ledger is saved first under `.specguard/cache/migrate/<timestamp>/` with a manifest of what was applied and how to undo it.
- **v0.1 repositories.** The default route archives per-file specs under `specs/_archive/v1/` (using `git mv` where possible) and redrafts capability specs as built. Consolidating with `spec consolidate` is the alternative when requested. A markdown file without `kind:` counts as a per-file spec only if it has acceptance criteria or a `module:`.
- **Agent steps** (drafting capability specs, tagging tests, `spec consolidate`) are printed as exact commands and never run by migrate. Progress is recorded so rerunning `migrate --yes` resumes.
- **Person steps**, such as approving what the code does today, committing and pushing, are printed with their exact commands and never run. Migrate never approves anything.
- **Config and hooks are only added to.** `proofStore` and `enforce` are inserted into your config text if missing, leaving every other byte as written. Guard hooks join `.claude/settings.json` only if it already has SpecGuard hooks and lacks them.
- **Never touched:** capability spec text and claims, test files apart from claim tags, source, `specs/history`, existing approvals, other workflows, and git history and remotes.
- **Dirty trees.** `migrate --yes` refuses to start on a working tree with uncommitted changes (exit 2, naming the paths) unless you pass `--allow-dirty`. A migration already under way is not refused.
- **Already current repos.** A current repo, or one with no specs, plans every step as done or skip, and migrate succeeds as a no-op. Rerunning on a migrated repo is also a no-op with exit code 0.
- Steps the repo can't take, such as git-dependent steps with no git, are skipped with a "Blocked:" reason.

<a id="script-against-stable-exit-codes-and-versions"></a>
### Script against stable exit codes and versions

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Internal error |
| 2 | Validation failed |
| 3 | Drift |
| 4 | Missing specs |
| 5 | Security issues |
| 7 | Heal failed |
| 8 | Budget exceeded |
| 12 | Waiting for the host agent (not a failure) |

- `remediate` uses 8–11 for its own outcomes, and those apply only to that command.
- `migrate` additionally exits 14 while steps remain for the tool or a person.
- `--version` prints the build version. `--version --json` prints name, version and Node version on one line. The MCP server and editor extension report the same version.

<a id="what-to-expect"></a>
## What to expect

- **Clear errors.** An invalid config fails with a readable message. Unknown keys and `_comment` are tolerated. Without any config, the error names where the search began and suggests `specguard init`. If no overlay is registered or named, there is no extra hint.
- **No silent inheritance.** A nested repo without its own config does not use a parent repo's config, and an overlay never reaches past the start directory's own git root.
- **Predictable cost.** Spending stops at your cap, and the CLI says so and exits 8. Usage is recorded in `.specguard/llm-usage.json`.
- **Deterministic CI.** Replay runs make no network calls. If a prompt changes, you get a miss error with the hash and how to re-record.
- **Keys stay out of sight.** Config holds only the names of environment variables, never the keys, and errors and logs never contain a resolved key.
- **Treat recordings as repository content.** They contain prompts and responses.
- **Plugin and hook modules run code.** They are loaded only from paths your project names.
- **No private names in the repository.** A test checks every tracked file against a hashed list of private project, employer and internal host names and fails naming the offending file.
- **Out of scope.** Platform Foundation does not decide which specs exist or whether code satisfies them. It does not run tests or browsers; it only identifies the right test command. It does not host a model gateway or manage API keys, and it holds no customer-specific configuration.
