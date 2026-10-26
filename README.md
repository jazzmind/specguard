# SpecGuard — Living Specs QA Agent

A reusable, codebase-agnostic system that keeps Living Specifications as the **single source of truth** for your codebase — running in parallel with your coding agent to automatically gather requirements, generate tests, validate security, and produce documentation at every plan phase.

Inspired by [PrintingPress](https://printingpress.dev)'s approach of a slim skill + CLI + MCP. Drop it into any project in under five minutes.

---

## Quick start

SpecGuard keeps your specs as the source of truth and shows, per requirement, whether tests prove the code still delivers it. Start inside your coding agent: it does the model work, so **no API key is needed**.

**Claude Code**

```
/plugin marketplace add jazzmind/specguard
/plugin install specguard@specguard
/specguard:start
```

**Codex**

```
codex plugin marketplace add jazzmind/specguard
```

then install `specguard` from `/plugins` and ask it to run `specguard start`. Codex does not announce itself, so set `SPECGUARD_HOST_AGENT=1` for any `specguard` command you run in its shell (the plugin's MCP server and skills already do).

**Any terminal** (with an API key set once by `specguard key set`, or inside any agent with `SPECGUARD_HOST_AGENT=1`)

```bash
npx -y -p specguard-ai specguard start
```

`start` sets the project up if needed (one config file and a specs README, nothing else), drafts specs from your code, links your existing tests to the requirements they prove, runs them and tells you where things stand. When a step needs a model it writes a request under `.specguard/agent-requests/` and exits with code 12 ("waiting for the agent", not a failure); the agent answers (`specguard agent pending`, `specguard agent answer <hash> --file ...`, or the `specguard_agent_work` MCP tool) and you run the same command again. The package is `specguard-ai`; `npx specguard` is a different, unrelated package.

The drafted specs describe what the code does today. They are drafts for you to read and correct, not yet statements of what the system should do.

## The change protocol

A change to a capability goes in one order: **spec, approval by a person, tests, red, code, green, validated.** The requirement is written and approved before it is built, its tests are seen failing before the code exists, and review reads a short proof packet instead of the diff. Every stage is detected from git, the specs, the test tags and the run records, so editing a file cannot move a change forward.

**What an agent does** (the plugin ships a `specguard-change` skill with this loop):

```bash
specguard change start shop --why "free shipping over fifty dollars"   # one committed record of intent: .specguard/changes/<id>.json
# edit the requirement in the capability spec, then stop: a person approves it
# write tests and tag each with the requirement: // [claims: capabilities/shop#free-shipping]
specguard change red          # runs exactly those tests against the old code; they must fail
# write the code
specguard change green        # records the passing run; push, and CI validates
specguard change status       # the stage, what blocks it, and the one next command
```

`--refactor` is for changes with no new requirement (code and a green run of the capability's claim tests are enough). `--spike` allows code first but can never merge as a spike; `change convert <id> --to feature` turns it into a feature once its requirements and tests exist. Once red is recorded and code exists, the tagged tests and changed requirements are locked: editing either sends the change back to `tests`, and red must be recorded again.

**What a person does.** Approve the new wording in their own terminal (`specguard spec approve <refs> --yes`: an agent environment is refused, `history add` cannot write approvals, and the edit guard denies hand-written approval files), choose how strict each capability is, and close or give up changes (`change done`, `change abandon`, `change convert`).

**The three enforce levels** are set per capability by `enforce:` in the spec's frontmatter and applied by the edit guard, which runs before every agent edit or shell command:

| Level | Editing a capability's code without a valid change |
|---|---|
| `observe` (the default, or `enforce.default` in the config) | allowed, and logged to `.specguard/cache/hooks.jsonl` |
| `warn` | allowed, with a message that names the command to run |
| `enforce` | denied, until a change for that capability is approved and has a valid red |

Spec files and tests stay editable at every level. At `enforce`, an open refactor or spike change opens its capability's code at once. The guard fails open (an error allows the edit and says so; `hooks.onError: "deny"` flips that), is silent outside a SpecGuard project, and answers from a cached index in about 50 ms.

**How to turn it on.** A person runs `specguard enforce raise <capability>`: one step up the ladder, and `--to enforce` is accepted only while the capability is certified (`specguard enforce show` says whether each could be raised now; `enforce lower` needs `--why` and is recorded in history). The Claude Code plugin already wires the guard. For Codex run `specguard init --codex`, which writes `.codex/hooks.json` and a rule that forbids approving from a shell, then trust the hooks in `/hooks`. To bring an older repository to this layout, `specguard migrate` lists every step (a dry run), and `--yes` does the ones the tool may do itself.

**Where proofs live.** Local test runs write `.specguard/proofs.json`, `.specguard/runs/` and `.specguard/cache/`, which a repository set up or migrated by SpecGuard keeps out of git, and which count as local evidence only. CI evidence is a git note on the commit under `refs/notes/specguard`, written by `specguard proof publish` (or `specguard ci run`) and read by `check` after `specguard proof fetch`. A capability is `certified` only when its proof comes from such a CI note at a clean commit; the same evidence from a local run is `provisional`. `specguard proof notes` summarizes the nearest note, and `proof prune` removes the notes of commits nothing reaches.

**What the pull request shows.** One comment, kept up to date, with the proof packet: what the requirements now say in plain words, the evidence for each changed requirement (layers, examples, whether its tests fail without the change), each capability's certification, test weakening, code that no requirement asked for, and changes to the pipeline itself. `specguard change report` builds the same packet locally, marked provisional, and `specguard ci run` builds it in CI and posts it.

## The Problem

Coding agents write code fast. Specifications, tests, security analysis, and documentation lag behind — or never exist at all. When they do exist, they're written once and immediately go stale. The gap between what the code does and what it's supposed to do grows with every PR.

SpecGuard closes that gap by running beside your coding agent. When the agent completes a plan phase, SpecGuard automatically:

- Captures the requirements that were just implemented into structured Living Spec files
- Generates or updates QA tests from those specs
- Runs generated tests and self-heals failures
- Flags security issues via hybrid LLM + SAST analysis
- Detects spec drift when code changes outpace documented behaviour
- Regenerates user documentation
- Maintains a requirement-to-test traceability matrix

Every artifact traces back to a single spec file. The spec is the source of truth for code, tests, docs, and security review — not a side artifact.

---

## Functional specs, history and the four pillars

Code is fluid. Specs, and the tests that prove the code conforms to them, are the source of truth. SpecGuard keeps that true in four ways:

1. **Specs and requirement history.** One master spec (`specs/system.md`) states the problem, the users and the value, and links to about 10-15 *capability* specs. A capability describes functionality that delivers user or business value and links to the many code files, tests and docs behind it, not to one file. `specs/history/` records the prompts, approved plans and decisions that shaped them.
2. **Conformance.** `test run` runs your tests and records the verdicts in one proof ledger; `verify` drives the running app with a browser agent and judges it against each capability's stated problem and value, recording that as proof too.
3. **Documentation.** `serve` exposes the specs, the traceability matrix and the audit over an HTTP API, and generates user, developer and agent docs on demand with a fast model, cached until the spec changes.
4. **Security.** `security scan` reviews code, dependencies and secrets, and also reviews each capability spec for flaws that are missing or wrong requirements. It writes a `RemediationPlan` ([schema](schemas/remediation-plan.v1.json)) that other systems can consume and update.

Multi-repo and monorepo workspaces run across all four.

```bash
specguard spec draft [--yes]            # existing code -> system spec + capability specs (reviewable map first)
specguard spec consolidate [--yes]      # per-file specs -> capability specs; rekeys tags, proofs and drift state
specguard spec graph                    # the spec tree, owned files, and rule violations
specguard spec index                    # refresh the capability map in specs/system.md
specguard spec tag [--yes] [--index <file>]  # link existing tests (JS/TS, Python, Go, Rust, Java/Kotlin) to requirements; --index records them in a text file instead of editing the tests
specguard history add|log               # requirement history; `init --history-hooks` records prompts and plans
specguard check [--gaps|--coverage|--matrix|--drift]   # spec health for the whole system
specguard test run [--affected]         # run tests, ingest results into the proof ledger
specguard verify --all --url <base>     # browser-verify each capability against its value
specguard serve                         # docs and audit API at /api/v1, plus a web UI
specguard security scan|fix|plan        # one plan of findings, fixes, and status tracking
specguard publish [--push]              # a snapshot of this project for a team server (CI runs this)
specguard check --team                  # what the team server has proven, set against this working tree
specguard login --server <url>          # remember a team server token on this machine
specguard server                        # run the team server (optional; see docs/team-server.md)
```

`status`, `drift`, `matrix` and `gap-analysis` keep working, with the same exit codes, and delegate to the same model in a repo that uses capability specs. Specs are described in [specs/README.md](specs/README.md).

### Workspaces, test layers, plugins and self-healing (0.3)

```bash
specguard workspace init --from sandbox.code-workspace && specguard workspace ignore hub
specguard check --workspace sandbox.code-workspace --refresh   # one picture across repos
specguard plugin list                                          # browse, enable, disable, add, remove
specguard init --ci github                                     # PR gate that comments, SARIF, scheduled remediation
specguard remediate --from failing --pr                        # repair the app for failing claims (a PR for a person)
```

Proofs now record the test layer that earned them (unit, integration, e2e, security, functional), capabilities can require layers, a passing `verify` can become a Playwright test, and dependency fixes that provably keep every proof can be auto-merged on a protected branch. See [docs/workspaces-layers-plugins.md](docs/workspaces-layers-plugins.md).

### Security model

SpecGuard runs as you and holds your files and keys, so it limits what it sends and what an agent can make it do: credentials are masked in every model prompt, page content and imported documents are fenced as untrusted data, `import <url>` reaches only public addresses, the MCP server writes only spec files inside the project (and can run read-only with `SPECGUARD_MCP_READONLY=1`), browser checks started by an agent are limited to loopback and `validate.allowedHosts`, and test commands do not inherit its model keys. `specguard serve` is loopback-only; the team server has tokens, a sign-in header honoured only from `SPECGUARD_TRUSTED_PROXIES`, rate limits and an audit trail. What it assumes, and why some things have no authentication, is in the **Trust model** of [specs/system.md](specs/system.md).

### Local first, with an optional team server

Everything above runs on your machine and needs nothing else. A **team server** is optional: CI publishes a snapshot of each commit (`publish`), and the server then shows everyone the same proof state, generates each document once for the whole team, and holds the remediation plans that trackers update. The command line, the MCP server and the VS Code extension all use the server when one answers and fall back to local files when it does not, and tell you which they used. Only specs, history, the trace, proof rows and the newest plan ever leave a machine. See [docs/team-server.md](docs/team-server.md).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            SpecGuard Core                                │
│                                                                         │
│  Import ──→ Spec Parser ──→ Pipelines ──→ Artifacts                    │
│  (PRD/Jira/     ↑               │                                      │
│   Markdown)     │               ├─ Forward Gen (tests)                  │
│                 │               ├─ Security (LLM + SAST)                │
│  Reverse Gen ───┘               ├─ Validation (live app)               │
│  (code → spec)                  ├─ Docs                                │
│                                 ├─ Drift                                │
│                                 ├─ Heal (run + fix)                     │
│                                 └─ Matrix (traceability)                │
└──────────────────────┬──────────────────┬───────────────────────────────┘
                       │                  │
         ┌─────────────┼──────────────────┼──────────────┐
         │             │                  │              │
    specguard CLI  specguard-mcp      SKILL.md      VS Code Ext.
    (CI / shell)   (IDE agents)     (parallel agent) (one-click)
```

Three surfaces expose the same core — a single SKILL.md orchestrates them all (PrintingPress pattern: one CLI with compound commands, not N separate tools).

### CLI (`specguard`)

A lean CLI for shell agents and CI pipelines. Commands map directly to pipelines:

```bash
specguard init                              # scaffold .specguard/ config in any repo
specguard import <file>                     # PRD/Jira/Markdown → specs
specguard reverse [--app <name>]            # code → specs
specguard generate [--spec <key>]           # specs → tests
specguard heal [--spec <key>]              # run tests, fix failures, re-run
specguard validate [--spec <key>] [--url <base>]  # live app + spec → issues
specguard security [--spec <key>]           # spec + code → security tests
specguard docs [--spec <key>]              # specs → user documentation
specguard drift                             # detect code changes that outpace specs
specguard matrix                            # export requirement-to-test traceability
specguard status                            # show spec coverage across the codebase
specguard align --all                       # map existing tests to spec scenarios and claims
specguard results ingest <files...>         # test-runner reports -> proof verdicts (no LLM)
specguard proof status                      # proven / failed / stale / unproven claims
```

Install the CLI with `npm install -g specguard-ai` (the package is `specguard-ai`, the binary is `specguard`), or run any command without installing: `npx -p specguard-ai specguard <command>` (npx can hang offline or under load). `specguard init`/`scaffold` wire the MCP server and the hook to a local binary (`SPECGUARD_CLI`, `node_modules/.bin/specguard`, or a global install) and fall back to npx only when none exists; choose with `--runner node|npx|path` (`--runner-path <file>`). An existing differing MCP entry or hook is never rewritten silently: a diff is printed and `--update-hooks` applies it.

### MCP Server (`specguard-mcp`)

Exposes every pipeline as an MCP tool. IDE agents (Cursor, Claude Desktop, Windsurf) call tools directly — no shell required. The MCP server auto-discovers via `.cursor/mcp.json` after install.

Available tools:

| Tool | Description |
|---|---|
| `specguard_import` | Ingest external requirements docs into spec format |
| `specguard_reverse` | Generate specs from existing code and tests |
| `specguard_generate` | Generate tests from spec files |
| `specguard_heal` | Run generated tests, capture failures, fix and re-run |
| `specguard_validate` | Validate a live page against its spec |
| `specguard_security` | Generate security tests (LLM + optional SAST) |
| `specguard_docs` | Generate user documentation from specs |
| `specguard_drift` | Check for spec drift after a code change |
| `specguard_matrix` | Export requirement-to-test traceability matrix |
| `specguard_status` | List spec coverage across the project |
| `specguard_results_ingest` | Ingest test-runner reports as proof verdicts |
| `specguard_proof_ingest` | Merge a verdicts file into the proof ledger |
| `specguard_proof_status` | Proven / failed / stale / unproven claims |
| `specguard_read_spec` | Read a spec file by key (e.g. `auth/login`) |
| `specguard_write_spec` | Write or update a spec file |

### Cursor Skill (`SKILL.md`)

The parallel agent companion. Placed in `.cursor/skills/specguard/SKILL.md`, it teaches Cursor when and how to run SpecGuard automatically:

- **After each plan phase**: calls `specguard_reverse` on changed files, then `specguard_generate` for affected specs
- **After security-sensitive changes**: calls `specguard_security`
- **After test generation**: calls `specguard_heal` to run and self-correct failures
- **Before a PR**: calls `specguard_drift` and `specguard_validate` to catch regressions
- **On demand**: any of the above triggered manually with natural language

### VS Code / Cursor Extension

One-click installation that:

1. Runs `specguard init` to scaffold `.specguard/config.json` in the workspace
2. Uses the bundled CLI, or the one you install with `npm install -g specguard-ai` (it warns when an installed CLI is not the version the extension was built for)
3. Registers `specguard-mcp` in `.cursor/mcp.json` and VSCode MCP settings
4. Copies `SKILL.md` into `.cursor/skills/specguard/`
5. Adds a sidebar panel for spec coverage, drift status, and recent validation reports

---

## Pipelines

### Pipeline 1: Import — External Docs → Specs

Ingests external requirements documents (PRDs, Jira exports, API specs, architecture notes, plain Markdown) and converts them into structured Living Spec files. This is the entry point for brownfield projects that already have requirements written elsewhere.

```bash
specguard import requirements.pdf
specguard import prd.md --app my-app
specguard import jira-export.csv --format jira
specguard import openapi.yaml --format api-spec
```

**Supported formats:** Markdown, PDF, Word (.docx), CSV (Jira export), OpenAPI/Swagger YAML/JSON, plain text.

**Output:** Structured spec files in `specs/<area>/<feature>.md`, with metadata inferred from the source document (auth scopes from API specs, user stories from Jira tickets, etc.).

The `import` pipeline complements `reverse` — use `import` when you have existing written requirements, use `reverse` when the code is the source of truth.

---

### Pipeline 2: Reverse Generation — Code → Specs

Reads existing source files (components, routes, API handlers, existing tests) and generates structured Living Spec Markdown files for features that don't yet have a spec, or updates stale specs when code has changed.

**When it runs:** After a coding agent completes a plan phase. After any significant code change. Manually any time.

```bash
specguard reverse --app my-app
specguard reverse --app my-app --force   # overwrite existing specs
specguard reverse --file src/pages/checkout.tsx  # single file
```

**Config-driven discovery** — no hard-coded file lists. The `.specguard/config.json` tells SpecGuard where your routes, pages, API handlers, and existing tests live for each app in your monorepo (or single repo).

**Output:** Structured Markdown files in `specs/<area>/<feature>.md`.

---

### Pipeline 3: Forward Generation — Specs → Tests

Reads Living Spec files and generates test stubs (or full tests) for the configured test framework. Uses the LLM to explore spec scenarios and produce concrete, testable code.

**Framework support:** Playwright (default), Jest, Vitest, Cypress, pytest, JUnit, or any custom template.

```bash
specguard generate --spec auth/login
specguard generate --all
specguard generate --spec auth/login --framework vitest
specguard generate --spec api/users --framework pytest
```

**Test types generated per spec:**
- Functional tests from `## Scenarios`
- Boundary/negative tests inferred from `## Security Notes`
- Accessibility checks from `## Accessibility Requirements`

**Output:** Test files in the location configured per framework (e.g. `tests/auth/login.spec.ts`).

---

### Pipeline 4: Heal — Run Tests + Self-Correct

Runs the generated tests, captures failures, and uses the LLM to diagnose and fix broken test code. This closes the generate-run-fix loop without human intervention. Incorporates guardrails to prevent destructive actions during test execution.

```bash
specguard heal --spec auth/login          # run + fix tests for one spec
specguard heal --all                       # run + fix all generated tests
specguard heal --max-retries 3            # limit self-heal attempts
```

**Process:**
1. Run tests via the configured test runner (Playwright, Jest, etc.)
2. If tests pass, done.
3. If tests fail, capture the error output + stack trace.
4. Send failure context + spec + test code to the LLM.
5. LLM diagnoses whether the failure is a test bug (fix the test) or an app bug (flag it).
6. If test bug: regenerate the failing test, re-run. Repeat up to `--max-retries`.
7. If app bug: report it as a validation issue linked to the spec scenario.

**Defect attribution:** Not all failures are equal. The heal pipeline distinguishes:
- **Test bug** — selector changed, timing issue, test logic error → fix the test
- **App bug** — 5xx from a user-driven action, missing element that spec says must exist → flag as defect
- **Infra artifact** — network timeout, CI flake, navigation failure to a constructed URL → retry, don't flag

This mirrors the [QA-Agent](./QA-Agent-README.md) approach: a 5xx counts as a defect only when it's *feature-driven* (clicking product UI). A 5xx from raw navigation to a hand-built URL is infrastructure noise.

**Guardrails:** When the heal loop re-runs tests against a live app, actions are classified before execution:
- **Safe** — read, navigate, fill form, click non-destructive buttons → execute
- **Destructive** — delete, archive, purge, drop → block and flag
- **Outbound** — send email, invite user, trigger payment → block and flag

This prevents a self-healing test from accidentally deleting production data.

**Output:** Fixed test files + a heal report showing what was corrected, what remains broken (app bugs), and any blocked actions.

---

### Pipeline 5: Validation — Live App + Spec → Issue Reports

Drives a real browser through the spec's scenarios using a **PERCEIVE → PLAN → ACT → VERIFY** agent loop, then produces a structured, evidence-backed issue report. This is not a static screenshot comparison — it exercises multi-step flows as described in the spec's `## Scenarios` section.

```bash
specguard validate --spec auth/login --url http://localhost:3000
specguard validate --all --url http://localhost:3000
specguard validate --all --url https://staging.example.com --out reports/validation.json
specguard validate --spec admin/users --url http://localhost:3000 --auth admin
```

**The validation loop (per scenario):**

```
PERCEIVE  → snapshot page (element list + screenshot + ARIA tree)
PLAN      → reason: which element, which action, why (mapped to spec step)
ACT       → one browser action (click, type, navigate)
VERIFY    → re-snapshot, check expected results from spec, capture evidence
            ↓
         Flow complete? → next scenario
         Not yet? → back to PERCEIVE
```

**Authentication:** Pages requiring login are handled by a **deterministic auth state machine** — not by the LLM. The state machine:
1. Navigates to the login page
2. Fills credentials from config (never sent to the LLM provider)
3. Handles 2FA if required (email OTP extraction)
4. Hands the authenticated browser session to the validation agent

This eliminates LLM spend on auth, prevents credential exposure, and makes login auditable. Configure auth per spec via the `auth:` metadata field and `.specguard/config.json`:

```json
{
  "auth": {
    "admin": {
      "loginUrl": "/login",
      "username": "${ADMIN_USER}",
      "password": "${ADMIN_PASS}",
      "2fa": "email"
    },
    "user": {
      "loginUrl": "/login",
      "username": "${TEST_USER}",
      "password": "${TEST_PASS}"
    }
  }
}
```

**Issue types:**

| Type | Description |
|---|---|
| `functional` | Page doesn't match the spec's Visual Expectations or scenario expected results |
| `ux` | Violates UX Guidelines (loading states, error specificity, focus) |
| `accessibility` | Fails ARIA, WCAG 2.2 AA, or keyboard navigation requirements |
| `visual` | Layout breaks, missing content, rendering problems |
| `runtime` | 5xx errors, unhandled exceptions, or console errors during flow execution |

**Evidence-backed verdicts:** Every issue must cite specific evidence — a screenshot path, HTTP status code, console error, or ARIA snapshot diff. Issues without evidence are discarded. This makes reports trustworthy and actionable.

```json
{
  "type": "functional",
  "severity": "major",
  "description": "Submit button remains disabled after valid form input",
  "evidence": [
    "screenshots/auth-login-step3.png",
    "aria: button[name='Submit'][disabled]"
  ],
  "spec_scenario": "Scenario 1: Valid email entry",
  "spec_step": 3
}
```

**Defect attribution:** Not all errors are defects:
- **5xx from a user-driven action** (clicking a button the spec says to click) → real defect, report it
- **5xx from navigation to a constructed URL** → infrastructure artifact, retry silently
- **4xx** (missing assets, auth chatter, prefetch) → never a defect on its own

**Severity:** `critical` / `major` / `minor`. Exits non-zero when critical or major issues are found — safe for CI gates.

---

### Pipeline 6: Security Analysis — Spec + Code → Security Tests

Hybrid analysis combining LLM-powered reasoning with optional SAST (Static Application Security Testing) tools. The LLM cross-references spec scenarios against OWASP patterns while SAST tools scan for concrete vulnerabilities.

```bash
specguard security --spec auth/login
specguard security --all
specguard security --all --with-sast       # enable Semgrep + the language's dependency audit
```

**LLM-driven analysis:**
- Auth bypass scenarios derived from spec `auth:` metadata
- Input validation boundary tests from spec scenarios
- Privilege escalation paths from role-based spec sections
- Sensitive data exposure in API responses
- CSRF and XSS surface area from form-based scenarios

**SAST integration (opt-in via `--with-sast` or config):**
- Runs Semgrep (polyglot) plus the language's dependency audit (`npm audit` or `pip-audit`)
- Feeds SAST findings into the LLM for contextual analysis against the spec
- Produces annotated security test stubs that address both LLM-inferred and SAST-detected issues

**Output:** Security test stubs annotated with OWASP category and severity, plus a structured JSON report at `.specguard/security.json`.

---

### Pipeline 7: Doc Generation — Specs → User Documentation

Strips test-specific content (scenarios, seed references, traceability keys) and transforms Living Specs into clean user-facing documentation pages.

```bash
specguard docs --spec auth/login
specguard docs --all --out docs/user
```

**Output:** Markdown files with frontmatter compatible with VitePress, Docusaurus, MkDocs, or any static site generator.

---

### Pipeline 8: Drift Detection — Code Changes → Spec Staleness

Compares recent code changes (git diff) against the specs that describe that code. Flags specs that are likely stale and surfaces which scenarios may no longer be accurate.

```bash
specguard drift                          # check HEAD against last commit
specguard drift --since main             # check branch diff against main
specguard drift --spec auth/login        # check one spec
```

**Output:** A drift report listing stale specs, the code lines that triggered the flag, and suggested spec sections to review.

---

### Pipeline 9: Traceability Matrix

Generates a structured mapping from requirements (spec scenarios) to generated tests, security tests, and documentation. This is the auditability layer — proving which requirement is covered by which test.

```bash
specguard matrix                          # print to stdout
specguard matrix --out traceability.json  # export as JSON
specguard matrix --format csv             # export as CSV (Jira-importable)
```

**Output:**

```json
{
  "specs/auth/login.md": {
    "scenarios": [
      {
        "name": "Scenario 1: Valid email entry",
        "tests": ["tests/auth/login.spec.ts:14"],
        "security_tests": ["tests/security/auth-login.spec.ts:8"],
        "docs": "docs/user/auth/login.md",
        "status": "covered"
      },
      {
        "name": "Scenario 3: Rate limiting",
        "tests": [],
        "security_tests": ["tests/security/auth-login.spec.ts:42"],
        "docs": "docs/user/auth/login.md",
        "status": "partial"
      }
    ]
  }
}
```

---

### Validation Memory

SpecGuard maintains a **per-host validation registry** — tracking what's been validated, when, and what the result was. This complements drift detection with runtime evidence.

```bash
specguard status --validated               # show validation history
```

After each validation run, SpecGuard records:
- Host + spec key + scenario name
- Last validation timestamp
- Result (pass/fail/blocked)
- Evidence paths (screenshots, reports)

This enables intelligent scheduling: `specguard validate --stale` re-validates only specs whose underlying code has changed since their last passing validation. Combined with drift detection, this gives a complete picture of "what's tested, what's stale, what's broken."

The registry is stored locally in `.specguard/validation-history.json` and is designed to be committed to the repo (no secrets, no large binaries — just metadata).

---

## The Spec Format

Each spec is a structured Markdown file. The format is the same whether hand-written, imported from a PRD, or generated by `reverse`:

```markdown
# Feature Title

<!--
  app: <repo or app name>
  url: <route path, e.g. /checkout>
  auth: <public | user | admin | <custom-scope>>
  framework: <playwright | jest | vitest | cypress | pytest | junit>
  security: <enabled | disabled>
  docs: <enabled | disabled>
  source: <reverse | import | manual>
-->

## Overview
Short description of what this feature does and why it exists.
Cover all sub-states and flows (e.g. "new user" vs "returning user").

## Visual Expectations
- Bullet list of what the user should see
- Include headings, key UI elements, loading states, error states
- Note responsive behaviour where relevant

## Accessibility Requirements
- Specific ARIA roles and labels required
- Focus order expectations
- Keyboard navigation requirements
- WCAG 2.2 AA criteria relevant to this page

## Scenarios

### Scenario 1: <concise name>
**Auth:** public
**Precondition:** (if applicable)

**Steps:**
1. Navigate to /feature
2. Perform action
3. Observe result

**Expected Results:**
- What the user should see
- What state the app should be in

---

### Scenario 2: <concise name>
...

## Security Notes
- Known attack surfaces (e.g. "form accepts user-supplied HTML")
- Auth boundaries that must be enforced
- Data fields that must never be exposed to unauthorised users
- OWASP categories relevant to this feature

## UX Guidelines
- Interaction quality expectations
- Loading state behaviour
- Error message specificity requirements
```

The `<!-- -->` metadata block is the machine-readable layer. All pipelines read it to know which app, URL, auth scope, and framework to use.

---

## Parallel Agent Mode

The core design principle: SpecGuard runs beside your coding agent, not after it.

```
Coding Agent                          SpecGuard Agent
─────────────────────────────         ──────────────────────────────────
1. Receive task
2. Plan phase 1                  →    [triggered] reverse-generate on
   (e.g. "add checkout page")          changed files → create/update
                                        specs/checkout/payment.md
3. Implement                     →    [triggered] generate tests from
                                        new spec → tests/checkout/
                                        payment.spec.ts
                                 →    [triggered] heal: run tests, fix
                                        any selector/timing issues
4. Plan phase 2                  →    [triggered] security scan →
   (e.g. "add auth middleware")         security/auth-middleware.spec.ts
5. PR ready                      →    [triggered] validate + drift +
                                        matrix → report regressions,
                                        export traceability
```

### Trigger Points

The Cursor Skill hooks into these natural pause points in the coding agent's workflow:

| Trigger | Pipeline(s) Run |
|---|---|
| Plan phase completed | `reverse`, `generate`, `heal` |
| Security-sensitive files changed (auth, middleware, API) | `security` |
| PR / branch ready | `drift`, `validate`, `matrix` |
| Spec file manually saved | `generate` (if `--watch` mode) |
| External requirements updated | `import` |
| Manual invocation | Any pipeline |

### Manual Invocation

Natural language works via the skill:

```
Run specguard on the checkout feature
Import this PRD into specs
Validate the login page against the spec
Generate security tests for the auth middleware
Check for spec drift since main
Show me the traceability matrix for auth
Heal the failing checkout tests
```

---

## Installation

### Option 1: VS Code / Cursor Extension (recommended)

Install the **SpecGuard** extension from the VS Code marketplace or Cursor extension panel. It handles everything:

1. Installs the `specguard` CLI binary
2. Runs `specguard init` to scaffold `.specguard/config.json`
3. Registers `specguard-mcp` in your IDE's MCP config
4. Adds the Cursor skill to `.cursor/skills/specguard/SKILL.md`

### Option 2: Manual Installation

**Install the CLI:**

```bash
npm install -g specguard-ai        # installs the `specguard` and `specguard-mcp` binaries
# or run without installing:
npx -p specguard-ai specguard --help
```

**Scaffold config in your repo:**

```bash
cd your-project
specguard init
```

This creates:

```
your-project/
  .specguard/
    config.json        # app definitions, framework settings, output paths
  specs/
    README.md          # spec directory documentation
  .cursor/
    skills/
      specguard/
        SKILL.md       # parallel agent skill
    mcp.json           # updated with specguard-mcp entry
```

**Register the MCP server** (if not using the extension):

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "specguard-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "specguard-ai", "specguard-mcp"]
    }
  }
}
```

(With a global install, `"command": "specguard-mcp"` with no args works too.)

---

## Configuration

`.specguard/config.json`:

```json
{
  "apps": [
    {
      "name": "my-app",
      "repo": ".",
      "specDir": "specs/my-app",
      "sources": {
        "routes": ["src/App.tsx", "src/router.ts"],
        "pages": ["src/pages/**/*.tsx"],
        "api": ["src/api/**/*.ts", "app/api/**/*.ts"],
        "tests": ["tests/**/*.spec.ts", "e2e/**/*.spec.ts"]
      },
      "framework": "playwright",
      "testOutput": "tests/",
      "baseUrl": "http://localhost:3000",
      "security": {
        "enabled": true,
        "sast": ["semgrep"],
        "customRules": true,
        "owasp_mapping": true
      },
      "docs": true
    }
  ],
  "runners": {
    "playwright": "local",
    "semgrep": "docker",
    "zap": "docker",
    "testRunner": "local"
  },
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "llm_alternatives": {
    "ollama": {
      "provider": "ollama",
      "model": "qwen2.5-coder:32b",
      "baseUrl": "http://localhost:11434"
    },
    "openai": {
      "provider": "openai",
      "model": "gpt-4o",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  },
  "triggers": {
    "onPlanPhase": true,
    "onSecurityFiles": ["**/auth/**", "**/middleware/**", "**/api/**"],
    "onPR": true,
    "healAfterGenerate": true
  },
  "heal": {
    "maxRetries": 3,
    "testCommand": "npm test"
  },
  "matrix": {
    "format": "json",
    "output": ".specguard/traceability.json"
  }
}
```

`config.json` is committed, so it only *names* the environment variable (`apiKeyEnv`); the key itself never goes in it.
Give SpecGuard the key once, for every workspace on the machine:

```
specguard key set                    # hidden prompt; or: pbpaste | specguard key set
specguard key set --scope workspace  # only this workspace (.specguard/.env next to workspace.json)
specguard key set --scope repo       # only this repo (.specguard/.env)
specguard key status                 # which files define it (never shows it)
```

The key is written to a git-ignored `.env` with mode 600 (`~/.config/specguard/.env` for the default user scope).
Precedence, highest first: the real environment, the repo's `.specguard/.env`, the workspace's, then the user's.
In VS Code, run **SpecGuard: Set API Key**.

### LLM Provider Options

Set the provider in `llm`. The API key is read from the env var named by `apiKeyEnv`; its value is never logged.

| Provider | Best For | Notes |
|---|---|---|
| `anthropic` | Production quality, structured output | Recommended default. Requires API key. |
| `openai` | Alternative cloud provider | GPT-4o or later. `OPENAI_BASE_URL` points it at any OpenAI-compatible server. |
| `litellm` | Local proxy, local models | Talks to `LITELLM_BASE_URL` (default `http://localhost:4000`); a key is optional. |
| `replay` | CI and tests | Serves recorded responses, offline and deterministic (see below). |
| `none` | Deterministic-only runs | Every LLM call is refused; `align` runs on claim tags and titles alone. |

```jsonc
"llm": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "pipelines": { "align": { "model": "claude-haiku-4-5" } },      // per-pipeline override
  "fallback": [{ "provider": "openai", "model": "gpt-4o", "apiKeyEnv": "OPENAI_API_KEY" }],
  "timeoutMs": 120000, "retries": 2, "backoffMs": 1000,           // retries only timeouts, 429, 5xx, resets
  "budget": { "maxUsd": 5, "maxCalls": 200 },                     // hard cap per run: exit code 8
  "allowImages": true,                                            // false: validate sends no screenshots
  "replay": { "dir": ".specguard/replay" }
}
```

- **Usage log:** every real call adds tokens, calls and an estimated cost to `.specguard/llm-usage.json` (total, per pipeline, per model). Prices come from a built-in table; override with `llm.pricing`.
- **Budget:** when `llm.budget` is reached, later calls throw and the command exits with code 8 and says why.
- **Record and replay:** run once with a real provider and `--record` (for example `specguard align --all --record`); commit `.specguard/replay/`. In CI set `"provider": "replay"` and the same prompts are answered from the recordings. A prompt with no recording fails with its hash instead of calling out.

### Multi-repo / Monorepo

```json
{
  "apps": [
    {
      "name": "frontend",
      "repo": "packages/web",
      "specDir": "specs/web",
      "sources": { "pages": ["src/pages/**/*.tsx"] },
      "framework": "playwright",
      "testOutput": "packages/web/tests/"
    },
    {
      "name": "api",
      "repo": "packages/api",
      "specDir": "specs/api",
      "sources": { "api": ["src/routes/**/*.ts"] },
      "framework": "jest",
      "testOutput": "packages/api/tests/"
    },
    {
      "name": "backend-python",
      "repo": "services/core",
      "specDir": "specs/core",
      "sources": { "api": ["app/routes/**/*.py"] },
      "language": "python",
      "framework": "pytest",
      "testOutput": "services/core/tests/"
    }
  ]
}
```

### Specs kept in a separate repo (overlays)

Some teams keep the SpecGuard config, specs and test results for a whole workspace in ONE separate "overlay" repository and never write anything into the application repos. The overlay holds one config per application, and each config's `apps[].repo` points out to the real repository (relative to the folder that holds `.specguard/`):

```
shop-specs/                        (a git repo)
  apps/api/.specguard/config.json    apps: [{ "name": "api", "repo": "../../../shop-api", "specDir": "specs", ... }]
  apps/api/specs/  apps/api/tags/
  apps/web/.specguard/config.json    apps: [{ "name": "web", "repo": "../../../shop-web", ... }]
```

Register it once per machine; the real repos are then configured, whether you open one of them or a `.code-workspace` that contains them:

```bash
specguard overlay add ../shop-specs   # scans it, shows what it covers and what it skipped, registers it
specguard overlay list                # registered overlays (stale entries are flagged)
specguard overlay resolve .           # which config, overlay and app this directory uses, or why none
specguard overlay refresh             # rescan after configs were added, moved or deleted
specguard overlay remove ../shop-specs
```

`add` and `refresh` write only the per-user registry (`~/.config/specguard/overlays.json`, or `$XDG_CONFIG_HOME/specguard/`, mode 600). Nothing is written into the application repos: specs, the proof ledger, caches and the edit guard's index and log all live in the overlay. Run from inside `shop-api`, a command loads the overlay app's config exactly as if you had run it from `shop-specs/apps/api`, and `check` and `status` say so on their first line.

Without registering, `SPECGUARD_OVERLAY=<dir>[:<dir>...]` (the path-list separator) names overlay roots that are scanned on the fly (handy in plugin or MCP configs), and `SPECGUARD_CONFIG=<path to a .specguard/config.json, or its folder>` names one config for every directory. The `--config` flag keeps working as before.

Resolution order for a directory: its repository's own `.specguard/config.json` (as before, up to the git boundary); then `SPECGUARD_CONFIG`; then overlay entries (`SPECGUARD_OVERLAY` roots first, then the registry), taking the entry whose repo is the deepest ancestor-or-equal of the directory, else the entry whose repo sits inside the git repository the directory is in (so a repo opened at its root resolves when the overlay config points at an app folder inside it; a folder above the git root matches nothing). A repo's own config always wins over an overlay. If two overlay configs name the same repo (or, started at a git root, different apps inside it, in which case start from inside one app), SpecGuard stops with an error that names both and says how to pick (`--config` or `SPECGUARD_CONFIG`); it never guesses. `workspace sync` treats an overlay-covered folder as a normal repo, the Claude Code and Codex edit guard judges edits in it, and the VS Code extension shows it as configured.

---

## Test Results and Proofs

A spec claim is an acceptance-criteria bullet with a stable id: `- Award is skipped when already earned <!-- claim: award-once -->`. A *proof* is the recorded result of running the tests that cover a claim. No LLM is involved in producing one.

1. **Tag the tests.** Put `@claim:<specKey>#<claimId>` in the test title (or a Playwright tag or annotation). `specguard generate` puts the tag in every test it writes.

   ```ts
   it('awards once @claim:core/awards#award-once', () => { /* ... */ });
   test('pays by card', { tag: '@claim:web/checkout#pay-card' }, async ({ page }) => { /* ... */ });
   ```

2. **Run your tests with a machine-readable reporter** and ingest the files:

   ```bash
   npx vitest run --reporter=json --outputFile=reports/vitest.json
   specguard results ingest reports/vitest.json reports/playwright.json reports/junit.xml
   ```

   Formats: Vitest/Jest JSON, Playwright JSON, JUnit XML (also pytest `--junitxml`, `go-junit-report`, Maven Surefire), pytest-json-report, `go test -json`, `cargo test` JSON. `--format` overrides detection.

3. **Read the verdicts.** Per claim: any failing test gives `failed` (with the failing titles as counterexamples); at least one pass and no failure gives `proven`; only skipped or no tests gives `unexercised`. `specguard proof status` lists them and exits 2 when a claim is failed or stale. A proof goes stale when its spec, a recorded source file, or the lockfiles change.

**Spec keys.** A claim ref is `<specKey>#<claimId>`, where `<specKey>` is the spec's path under `paths.specsRoot` without extension (`specs/api/services/messaging.md` is `api/services/messaging`), whichever app owns it. The ledger, drift registry, `matrix`, `align` and `status` all use that key; old `<app>/<key>` registry entries migrate automatically. At ingest each row records the hashes of the files the spec lists in its `sources:` header (else `module:`), so editing one of them makes exactly those claims stale. `sources` globs (config and header) resolve relative to the app's `repo`; a root-relative pattern is accepted with a one-time warning.

**Partial vs full runs.** A partial ingest only updates the claims present in the files. `--unexercised` (alias `--sweep`) stores `unexercised` for claims absent from every ingested file only with `--full-run` (or when the files already touch every app that has claims), and never downgrades a `proven` claim whose spec and sources still match.

`results ingest` options: `--run-id <id>`, `--unexercised`/`--sweep` and `--full-run` (see above), `--ledger <file>` (default `paths.proofLedger` or `.specguard/proofs.json`; keep a baseline and a patched ledger side by side). `specguard matrix` shows, per claim, the tests that carry its tag.

### Running tests from SpecGuard

Per-app `test` blocks tell `heal` (and your scripts) how to run each app's tests and where the report goes:

```jsonc
"apps": [{
  "name": "web", "repo": "packages/web", "framework": "vitest", "specDir": "specs/web", "testOutput": "packages/web/tests/",
  "test": { "command": "pnpm --filter web test", "reporter": "vitest", "timeoutMs": 300000 }
}, {
  "name": "api", "repo": "services/api", "language": "python", "framework": "pytest", "specDir": "specs/api", "testOutput": "services/api/tests/",
  "test": { "command": "pytest", "cwd": "services/api", "reporter": "pytest" }
}]
```

Reporters: `vitest`, `jest`, `playwright`, `pytest` (JUnit XML), `junit` (set `resultsFile` to a glob such as `target/surefire-reports/TEST-*.xml`), `go`, `cargo`. SpecGuard adds the right flags (`--reporter=json --outputFile`, `PLAYWRIGHT_JSON_OUTPUT_NAME`, `--junitxml`) and reads the report file, never stdout. If `resultsFile` is set the command runs exactly as written. With `runners.testRunner: "docker"` and `test.image`, tests run in that image with the repo mounted. `specguard init` detects monorepos (pnpm, Yarn, npm, Nx, Turbo, Lerna, Go `go.work`, Cargo and uv workspaces) and writes one app per ecosystem over every package's sources plus `.specguard/workspace.json` listing each package as a unit with its own test command. Capabilities cut across packages, so specs follow functionality, not package layout. `specguard test run --affected` runs only the changed units and the units that depend on them.

`specguard heal` treats a report it cannot read as a failure, runs every app (`--app <name>` for one, `--spec <key>` for one spec's tests), and `--classify-only` classifies failures without ever rewriting a test.

### Plugins and layout

Core SpecGuard is platform-neutral. Optional functionality is a plugin named in `config.plugins`. A plugin can add CLI commands (also exposed as MCP tools), contract importers, catalog providers and discoverers. Built in:

| Plugin | Adds |
|---|---|
| `quality` | `specguard quality`: ESLint, Knip and Ruff findings in `.specguard/code-quality.json` |
| `git` | `specguard commit`: stage and commit only generated files, with a changelog |
| `feature-catalog` | `specguard features [--state]`: a feature catalog and its state across UI, API and agent-tool channels ([docs/feature-catalog.md](docs/feature-catalog.md)) |
| `contract-mappings` | contract edges from a JSON mappings file whose location and keys are config |

`specguard init` enables `quality` and `git` for new projects. A plugin that cannot be loaded is reported once and its commands are skipped; core commands win a name clash. Layout is configured, not assumed:

```jsonc
{
  "plugins": ["quality", "git"],
  "paths": { "specsRoot": "specs", "docsOut": "docs/user", "securityTests": "tests/security", "proofLedger": ".specguard/proofs.json" },
  "featureState": { "catalog": "catalog", "reporters": [{ "path": "reports/vitest.json" }], "repoChannels": { "web": "ui", "api": "api" } },
  "apps": [{ "name": "web", "stripPrefix": "src/features/", "entryPoints": ["src/routes.tsx"] /* ... */ }]
}
```

A repo never inherits a parent repo's config: the search stops at the repository root. Use `"extends": "../.specguard/config.json"` to inherit on purpose. `.specguard/` run state (activity log, analysis, drift registry, traceability, LLM usage, auth state, evidence) is git-ignored by `specguard init`.

---

## Spec Coverage

```bash
specguard status
```

Output:

```
SpecGuard Status — my-app
──────────────────────────────────────────────────────
  Pages discovered:   24
  Specs written:      18  (75%)
  Tests generated:    16  (89% of specs with tests)
  Tests passing:      14  (88% of generated tests)
  Security tests:      9  (50% of specs with security)
  Docs generated:     14  (78% of specs with docs)

  Stale specs (drift detected):
    ⚠  auth/login          — src/pages/login.tsx changed 2d ago
    ⚠  checkout/payment    — src/api/stripe.ts changed 4h ago

  Failing tests (heal candidates):
    ✗  tests/checkout/payment.spec.ts — 2 failures
    ✗  tests/auth/login.spec.ts — 1 failure

  Missing specs:
    ✗  admin/reports
    ✗  settings/billing
    ✗  onboarding/invite
──────────────────────────────────────────────────────
  Run `specguard reverse --app my-app` to fill gaps.
  Run `specguard heal --all` to fix failing tests.
```

---

## CI Integration

The GitHub Action (`jazzmind/specguard`, defined in [`action.yml`](action.yml)) installs `specguard-ai`, runs the gates you choose, writes a job summary, uploads `.specguard/` (without `.env` or saved auth state) as an artifact, and fails the job on the thresholds you set.

```yaml
# .github/workflows/specguard.yml
name: SpecGuard
on: [pull_request]

jobs:
  specguard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - run: npm ci && npx vitest run --reporter=json --outputFile=reports/vitest.json || true

      - uses: jazzmind/specguard@v0
        with:
          version: latest                     # or an exact version
          gates: status,drift,proof,results   # also: align, validate, security, check, test, verify, scan
          results: reports/vitest.json        # Vitest/Jest/Playwright JSON, JUnit XML, ...
          drift-since: origin/${{ github.base_ref }}
          fail-on: missing-specs,drift,proof-failed,proof-stale,results
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # only drift/align/validate need it
```

`fail-on` thresholds: `missing-specs`, `drift`, `proof-failed`, `proof-stale`, `proof-unexercised`, `proof-unproven`, `align-below:<percent>`, `results`, `validate`, `security`, `deps`, `none`. The full reference, a Playwright and a JUnit example, and the replay setup for key-free CI are in [docs/ci.md](docs/ci.md).

Without the action, the same gates are plain commands:

```yaml
      - run: npx -p specguard-ai specguard results ingest reports/vitest.json --run-id ${{ github.run_id }}
      - run: npx -p specguard-ai specguard proof status     # exits 2 on failed or stale proofs
      - run: npx -p specguard-ai specguard drift --since origin/main
```

Exit codes follow the [PrintingPress typed-exit convention](https://github.com/mvanhorn/cli-printing-press):

| Code | Meaning |
|---|---|
| 0 | All checks passed |
| 1 | Internal error |
| 2 | Validation failed (critical/major issues found) |
| 3 | Drift detected (specs are stale) |
| 4 | Missing specs (uncovered features) |
| 5 | Security issues found |
| 7 | Heal failed (tests still broken after max retries, or a test report could not be read) |
| 8 | LLM budget exceeded (`llm.budget`) |

`specguard remediate` has its own exit codes (command-scoped: 8 is also "budget exceeded" for every other command):

| Code | Meaning under `remediate` |
|---|---|
| 0 | Nothing to remediate, or every advisory already has a branch/PR |
| 5 | Security findings present (`--scan-only`, or nothing could be planned automatically) |
| 8 | Branch/PR produced and the behavior verdict is PRESERVED |
| 9 | Verdict CHANGED (draft PR, or branch left for review) |
| 10 | Verdict INCONCLUSIVE |
| 11 | Baseline not green, or a tool/setup error |

---

## Migrating to functional specs

A repo with one spec per source file moves to capability specs with `specguard spec consolidate`. It clusters the existing specs into capabilities and shows the proposed map in `.specguard/spec-map.md` to review (edit `.specguard/spec-map.json`, then rerun with `--from-map`). It then merges their requirements, rewrites claim tags in your tests, rekeys the proof ledger and drift registry, archives the old specs under `specs/_archive/v1/`, and writes `.specguard/claim-migration.json` so results that still carry old tags are accepted for one release. A repo with no specs yet uses `specguard spec draft`. Specs in either format are read side by side during the move.

### Patterns Adopted from QA-Agent

The [QA-Agent](./QA-Agent-README.md) project is an autonomous browser-driven QA tester. SpecGuard adopts several of its patterns:

| QA-Agent Pattern | SpecGuard Adoption |
|---|---|
| PERCEIVE-PLAN-ACT-VERIFY agent loop | `validate` pipeline drives multi-step flows, not just static screenshots |
| Deterministic auth state machine | Auth handled by code, not LLM — credentials never reach the model |
| Guardrails (`classify_action()`) | `heal` and `validate` block destructive/outbound actions before execution |
| Evidence-backed verdicts | Every issue must cite screenshot, HTTP status, or console error |
| Defect attribution (5xx from action vs navigation) | Distinguish app bugs from infra artifacts in reports |
| Per-domain feature memory | Validation history tracks what's been tested per host, when, and result |

**Not adopted** (different architectural goals):
- A required hosted service — SpecGuard is a dev tool that works fully offline; the [team server](docs/team-server.md) is an optional shared layer
- Human-in-the-loop steering — contradicts the parallel-agent autonomous design
- DeepAgents/LangGraph framework — SpecGuard uses ai-sdk directly
- Web UI / SPA — SpecGuard's UI is the IDE extension
- OpenRouter routing — SpecGuard supports providers directly

---

## Runtime Architecture

SpecGuard separates what it **owns** (brain) from what it **delegates to** (runners/scanners). The CLI probes the environment and uses the best available runner via tiered resolution.

### What Ships With SpecGuard (npm package)

| Layer | Contents | Language |
|---|---|---|
| Core | Spec parser, LLM orchestration, pipeline logic | TypeScript |
| Adapters | Thin wrappers that invoke runners via local or Docker | TypeScript |
| Security Rules | Custom Semgrep rulesets (`.yaml`), OWASP mapping data | YAML/JSON |
| Docker Shims | `docker run` commands with correct mounts/args/tags | Shell |

### What Does NOT Ship With SpecGuard

| Tool | How It's Resolved | Why |
|---|---|---|
| Playwright browsers | User runs `npx playwright install` | 400MB+ binary, project-specific version |
| Test frameworks (Jest, Vitest, pytest) | User's project `devDependencies` | Already in their project |
| Semgrep binary | Docker container (`semgrep/semgrep:1.78.0`) | Avoid Python dep on host |
| OWASP ZAP | Docker container (`zaproxy/zap-stable`) | Java runtime, heavy |
| Python itself | Not required unless using native SAST mode | Keep Node-only for most users |

### Tiered Runner Resolution

For each external tool, SpecGuard resolves in this order:

```
1. Local install detected on PATH? → use it directly (fastest, zero overhead)
2. Docker/Colima available? → use pinned container image (reliable fallback)
3. Neither? → offer to auto-install or error with clear instructions
```

Config controls the strategy per tool:

```json
{
  "runners": {
    "playwright": "local",
    "semgrep": "docker",
    "zap": "docker",
    "testRunner": "local"
  }
}
```

| Mode | Behaviour |
|---|---|
| `"local"` | Expect the tool on PATH or in `node_modules`. Error if missing. |
| `"docker"` | Always use the pinned container image. Requires Docker. |
| `"auto"` | Try local first, fall back to Docker, error if neither available. |

### Playwright Strategy

Playwright is Node-native — no container needed for most use cases:

- SpecGuard declares `@playwright/test` as an **optional peer dependency**
- If the project already uses Playwright, SpecGuard uses their version
- If not, `specguard init --with-playwright` adds it to the project's `devDependencies`
- Browser binaries are managed by Playwright itself (`npx playwright install chromium`)
- For CI without a display server, Playwright's built-in headless mode handles this

### Security Scanner Strategy

**Custom rules ship as data, not as binaries.** SpecGuard's security value-add is spec-aware rulesets:

```
.specguard/
  rules/
    semgrep/
      auth-boundary-check.yaml    # verify auth middleware matches spec auth: metadata
      input-validation.yaml       # check that spec scenario inputs have validation
      data-exposure.yaml          # flag fields in API responses not declared in spec
      xss-surface.yaml            # form inputs identified in spec Visual Expectations
    owasp/
      mapping.json                # OWASP Top 10 → spec section mapping
```

These rules are **portable YAML** — they ship with the npm package and run on any Semgrep instance (local or Docker):

```bash
# What SpecGuard actually executes:
docker run --rm \
  -v "${PROJECT_DIR}:/src" \
  -v "${SPECGUARD_RULES}:/rules" \
  semgrep/semgrep:1.78.0 \
  semgrep scan --config /rules --config p/owasp-top-ten /src
```

The LLM then receives both the SAST findings and the spec context to produce contextualised security test stubs — understanding *why* a finding matters for this specific feature.

### Auth State Machine

Validation of authenticated pages uses a **deterministic state machine** — not the LLM. This is a direct adoption of the [QA-Agent](./QA-Agent-README.md) pattern that eliminates LLM spend on auth, prevents credential retries, and keeps passwords out of LLM context.

```
NavigateToLogin
    → FillCredentials (from config, env vars — never sent to LLM)
    → WaitForResult
        → Success → hand session to validation agent
        → 2FA Required → extract code (IMAP or browser-based webmail)
            → EnterCode → Success
        → LoginFailed → abort with clear error
```

**Credential isolation:** Usernames and passwords are loaded from environment variables referenced in config. They exist in-memory only during the login flow and are never included in any LLM prompt, log output, or report. The `redact()` utility strips them from any string before logging.

**Per-auth-scope sessions:** Config defines named auth profiles (e.g., `admin`, `user`, `viewer`). Each spec's `auth:` metadata references a profile. The validation pipeline logs in once per profile and reuses the session across all specs requiring that profile.

### Guardrails

When SpecGuard drives a browser (validation, heal), every action is classified before execution:

| Classification | Examples | Behaviour |
|---|---|---|
| **Safe** | Navigate, read text, fill form, click navigation | Execute immediately |
| **Destructive** | Delete, archive, purge, drop, remove | Block, log, flag in report |
| **Outbound** | Send, invite, share, publish, pay, submit payment | Block, log, flag in report |

Classification is deterministic (not LLM-driven): whole-word matching, so `postcode` does not match `post`, and when the target element is known its role and accessible name decide (typing in a text field is safe; a button or link is judged by its own name). Add words with `validate.guardrails.deny` / `allow`; `--allow-outbound` (or `validate.guardrails.allowOutbound`) lets outbound actions run on staging, and destructive actions stay blocked. This is a safety net, not a permission system: it prevents the most common destructive mistakes without adding latency.

Blocked actions appear in the validation/heal report as `BLOCKED` verdicts with the reason.

### CI / GitHub Actions

The action in this repository (`jazzmind/specguard`) sets up Node, installs the CLI, runs the gates and uploads the evidence; see [CI Integration](#ci-integration) and [docs/ci.md](docs/ci.md). Docker and Playwright are only needed for the SAST and `validate` gates; set `install-playwright: true` for `validate`.

### Environment Requirements Summary

| Environment | Required | Optional |
|---|---|---|
| Local dev | Node.js 20+ | Docker (for SAST scanners) |
| CI | Node.js 20+, Docker | — |
| IDE agent (Cursor) | Node.js 20+ | Docker (scanners run if available) |

---

## Design Decisions

**Single SKILL.md orchestrator, not N separate skills.** The hackathon notes proposed 8 separate skills (requirements_parser, code_analyzer, test_case_designer, etc.). We use one skill that orchestrates compound CLI commands — the PrintingPress pattern. Fewer tool definitions = less token overhead for the agent. The internal steps (parse, analyze, design) still happen inside each pipeline.

**Code-first with import as escape hatch.** The primary flow is `reverse` (code is the source of truth). The `import` command exists for brownfield projects with existing PRDs/Jira exports, but once imported, the spec file becomes the source of truth — not the original document.

**No agent framework middleware.** No LangGraph, CrewAI, or AutoGen. Direct LLM calls via ai-sdk (Vercel AI SDK) with `generateObject`/`generateText`. The orchestration happens in the Cursor Skill, not in a framework. Keeps the dependency tree minimal and the code debuggable.

**No git/PR management built in, with one opt-in exception.** SpecGuard generates artifacts (specs, tests, docs, reports). It does not create branches or raise PRs — that's the coding agent's job. The single exception is `specguard remediate`: it patches a vulnerable dependency or code issue in a temporary git worktree, runs your tests before and after, and commits on a `specguard/remediate/<id>` branch. It pushes and opens a PR (via `gh`) only when you pass `--pr`, and it never merges: humans always merge. See [docs/ci-remediate.md](docs/ci-remediate.md).

### `specguard remediate`

```bash
specguard remediate --scan-only --json          # detect only (ecosystem audit + OSV, Semgrep, gitleaks); exit 5 if findings
specguard remediate --dry-run                   # whole loop in a throwaway worktree, nothing left behind
specguard remediate --pr                        # branch + push + gh pr create (draft unless PRESERVED)
specguard remediate --advisory GHSA-xxxx --min-severity critical --allow-major --ledger .specguard/proofs.json
```

The verdict is PRESERVED only when no baseline-passing test fails or disappears, no proven claim drops, claim and test counts do not fall, the advisory is gone, nothing new at or above the threshold appeared, build and typecheck are green, and (for dependency bumps) the proofs went stale through the dependency fingerprint and were re-proven. Otherwise CHANGED (with the exact differing tests and claims) or INCONCLUSIVE (flaky tests, unparseable output, coverage gaps). `heal` never rewrites a test during remediation. Evidence lands in `.specguard/remediation/<runId>.json` plus baseline and patched proof ledgers. Suppress known advisories in `.specguard/vuln-ignore.json` (entries expire). Over MCP only `scan-only` and `dry-run` are available.

**Hybrid security: LLM + SAST.** Pure LLM security analysis misses things scanners catch (regex-based CVE patterns, known-vulnerable dependency versions). Pure SAST misses semantic issues (is this auth check actually protecting the right resource?). The hybrid feeds SAST findings into the LLM for contextual reasoning against the spec.

**Native brain, containerised scanners.** The CLI itself is pure TypeScript/Node — zero Python, Java, or Go required on the host. Heavyweight tools (Semgrep, ZAP) run in pinned Docker containers with SpecGuard's custom rules mounted as volumes. This gives reproducibility without polluting the host environment. Playwright is the exception — it's Node-native and runs locally for speed.

**Security rules as portable data.** SpecGuard ships custom Semgrep rulesets as YAML files, not as scanner binaries. The rules are spec-aware (they reference spec metadata like `auth:` scopes and scenario inputs). This means the security intelligence is in the rules + LLM reasoning, not in a proprietary scanner.

---

## Roadmap

### Phase 1: Core

- [ ] CLI binary (TypeScript, ships as npm package)
- [ ] MCP server (`specguard-mcp`)
- [ ] Cursor Skill (`SKILL.md`)
- [ ] `specguard init` scaffolding
- [ ] Tiered runner resolution (local → Docker → error)
- [ ] Docker adapter shims for scanner containers

### Phase 2: Pipelines

- [ ] Pipeline: Import (PRD/Jira/Markdown → specs)
- [ ] Pipeline: Reverse Generation (code → specs)
- [ ] Pipeline: Forward Generation (Playwright, Jest, Vitest)
- [ ] Pipeline: Heal (run + fix loop + guardrails)
- [ ] Pipeline: Validation (PERCEIVE-PLAN-ACT-VERIFY agent loop)
- [ ] Pipeline: Security (LLM + custom Semgrep rules)
- [ ] Pipeline: Doc Generation
- [ ] Pipeline: Drift Detection
- [ ] Pipeline: Traceability Matrix
- [ ] `specguard status` coverage report
- [ ] Deterministic auth state machine (login + 2FA)
- [ ] Action guardrails (safe/destructive/outbound classification)
- [ ] Evidence-backed verdicts (screenshot + HTTP + console citing)
- [ ] Defect attribution (app bug vs infra artifact)
- [ ] Validation memory (per-host history registry)

### Phase 3: Security Rules

- [ ] Custom Semgrep rulesets: auth-boundary-check
- [ ] Custom Semgrep rulesets: input-validation
- [ ] Custom Semgrep rulesets: data-exposure
- [ ] Custom Semgrep rulesets: xss-surface
- [ ] OWASP Top 10 → spec section mapping (JSON)
- [ ] SAST: npm audit adapter (Node projects)
- [ ] SAST: OWASP ZAP adapter (dynamic scanning)

### Phase 4: Distribution

- [ ] GitHub Action (`specguard/action@v1`) with Docker layer caching
- [ ] VS Code / Cursor Extension
- [ ] Ollama / local model support
- [ ] Forward Generation: pytest / JUnit support
- [ ] Forward Generation: Cypress support
- [ ] Web dashboard for spec coverage
- [ ] Zephyr Scale / Jira integration for traceability

---

## Contributing

This project is in active development. The core pipelines were extracted from production use and generalised. PRs welcome — especially:

- Framework adapters for test generation (pytest, JUnit, Cypress)
- SAST tool integrations beyond Semgrep
- LLM provider adapters (Azure OpenAI, Google Gemini, etc.)
- Import parsers for additional requirement formats (Notion, Confluence, Linear)

---

## License

MIT
