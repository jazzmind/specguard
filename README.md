# SpecGuard — Living Specs QA Agent

A reusable, codebase-agnostic system that keeps Living Specifications as the **single source of truth** for your codebase — running in parallel with your coding agent to automatically gather requirements, generate tests, validate security, and produce documentation at every plan phase.

Inspired by [PrintingPress](https://printingpress.dev)'s approach of a slim skill + CLI + MCP. Drop it into any project in under five minutes.

---

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
```

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
2. Installs the CLI binary (via `npm install -g specguard` or binary download)
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
specguard security --all --with-sast       # enable Semgrep/Bandit integration
```

**LLM-driven analysis:**
- Auth bypass scenarios derived from spec `auth:` metadata
- Input validation boundary tests from spec scenarios
- Privilege escalation paths from role-based spec sections
- Sensitive data exposure in API responses
- CSRF and XSS surface area from form-based scenarios

**SAST integration (opt-in via `--with-sast` or config):**
- Runs Semgrep (polyglot) or Bandit (Python) against source files referenced by the spec
- Feeds SAST findings into the LLM for contextual analysis against the spec
- Produces annotated security test stubs that address both LLM-inferred and SAST-detected issues

**Output:** Security test stubs annotated with OWASP category and severity, plus a structured JSON report.

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
npm install -g specguard
# or
brew install specguard
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
    "specguard": {
      "command": "specguard-mcp",
      "args": ["--workspace", "${workspaceFolder}"]
    }
  }
}
```

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
    "bandit": "auto",
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

### LLM Provider Options

SpecGuard supports multiple LLM providers. Set the active provider in `llm`, or override per-run:

```bash
specguard reverse --app my-app --llm ollama    # use local model
specguard generate --spec auth/login           # uses default (anthropic)
```

| Provider | Best For | Notes |
|---|---|---|
| `anthropic` | Production quality, structured output | Recommended default. Requires API key. |
| `openai` | Alternative cloud provider | GPT-4o or later. |
| `ollama` | Local/offline, cost-free iteration | Qwen Coder, DeepSeek Coder, Code Llama. Quality varies. |

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
      "baseUrl": "http://localhost:3000"
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
      "framework": "pytest",
      "testOutput": "services/core/tests/"
    }
  ]
}
```

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

Add to your CI pipeline to gate PRs on spec health:

```yaml
# .github/workflows/specguard.yml
name: SpecGuard
on: [pull_request]

jobs:
  specguard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g specguard

      - name: Check for spec drift
        run: specguard drift --since origin/main

      - name: Run security analysis
        run: specguard security --all --with-sast

      - name: Validate against staging
        run: specguard validate --all --url ${{ vars.STAGING_URL }}

      - name: Export traceability matrix
        run: specguard matrix --out traceability.json

      - name: Upload traceability artifact
        uses: actions/upload-artifact@v4
        with:
          name: traceability-matrix
          path: traceability.json

    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
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
| 7 | Heal failed (tests still broken after max retries) |

---

## Relationship to Practera Test Suite

SpecGuard generalises the approach proven in [practera-test-suite](https://github.com/nickengineer/practera-test-suite):

| Practera Implementation | SpecGuard |
|---|---|
| `packages/spec-tools/src/spec-parser.ts` | Core spec parser (same format) |
| `packages/spec-tools/src/validate.ts` | `specguard validate` |
| `packages/spec-tools/src/reverse-generate.ts` | `specguard reverse` |
| `packages/spec-tools/src/doc-generate.ts` | `specguard docs` |
| `.claude/agents/playwright-test-planner.md` | `specguard generate` (Playwright mode) |
| `.claude/agents/playwright-test-generator.md` | `specguard generate` (code output) |
| `.claude/agents/playwright-test-healer.md` | `specguard heal` |
| Hard-coded `APP_CONFIGS` in reverse-generate.ts | `.specguard/config.json` |
| Practera-specific `SPECS_DIR` paths | Config-driven `specDir` per app |
| No external requirements import | `specguard import` |
| No security pipeline | `specguard security` (LLM + SAST) |
| No drift detection | `specguard drift` |
| No traceability export | `specguard matrix` |
| Manual CLI only | Parallel agent via Cursor Skill |
| Anthropic-only | Pluggable LLM (Anthropic, OpenAI, Ollama) |

The spec format is **fully compatible**. Any `specs/` directory from the Practera test suite works with SpecGuard out of the box.

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
- Multi-tenant SaaS deployment — SpecGuard is a dev tool, not a hosted service
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
| Bandit | Docker container (`python:3.12-slim` + pip) | Python-only projects |
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
    "bandit": "auto",
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

Classification is keyword-based on the action's description/label (not LLM-driven — deterministic and fast). This is a safety net, not a permission system: it prevents the most common destructive mistakes without adding latency.

Blocked actions appear in the validation/heal report as `BLOCKED` verdicts with the reason.

### CI / GitHub Actions

A GitHub Action (`specguard/action@v1`) handles environment setup:

```yaml
- uses: specguard/action@v1
  with:
    scanners: semgrep,bandit    # pulls Docker images, caches layers
    playwright: true             # installs browsers
```

This avoids every CI workflow needing to manually configure Docker pulls and Playwright installs.

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

**No git/PR management built in.** SpecGuard generates artifacts (specs, tests, docs, reports). It does not create branches or raise PRs — that's the coding agent's job. Clean separation of concerns.

**Hybrid security: LLM + SAST.** Pure LLM security analysis misses things scanners catch (regex-based CVE patterns, known-vulnerable dependency versions). Pure SAST misses semantic issues (is this auth check actually protecting the right resource?). The hybrid feeds SAST findings into the LLM for contextual reasoning against the spec.

**Native brain, containerised scanners.** The CLI itself is pure TypeScript/Node — zero Python, Java, or Go required on the host. Heavyweight tools (Semgrep, Bandit, ZAP) run in pinned Docker containers with SpecGuard's custom rules mounted as volumes. This gives reproducibility without polluting the host environment. Playwright is the exception — it's Node-native and runs locally for speed.

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
- [ ] SAST: Bandit adapter (Python projects)
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

This project is in active development. The core pipelines are extracted from production use in the Practera test suite and are being generalised here. PRs welcome — especially:

- Framework adapters for test generation (pytest, JUnit, Cypress)
- SAST tool integrations beyond Semgrep
- LLM provider adapters (Azure OpenAI, Google Gemini, etc.)
- Import parsers for additional requirement formats (Notion, Confluence, Linear)

---

## License

MIT
