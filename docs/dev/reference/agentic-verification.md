---
title: "Agentic Verification (developer reference)"
audience: dev
source: "specs/capabilities/agentic-verification.md"
generated: true
---
<a id="agentic-verification"></a>
# Agentic Verification

<a id="purpose"></a>
## Purpose

Agentic verification judges the running application against what its specs say it is for. An LLM-driven browser agent looks at the live page the way a user would, using a screenshot plus the accessibility tree. It plans the few interactions needed to check each acceptance criterion, performs them under strict guardrails, and returns an evidence-backed verdict per criterion.

It complements unit and integration tests, which only show that individual pieces behave as coded. It needs no scripted selectors because it works from the spec's own wording, and it cannot delete data or send messages on its own.

Typical uses:
- A developer runs `specguard validate --spec <key> --url http://localhost:3000` after a change and sees which criteria fail, with screenshots.
- A QA lead runs `specguard validate --all` against staging with `--allow-outbound`. Notification flows run, while deletion stays blocked.
- A security-minded engineer defines one auth profile per role so each spec is verified as the right kind of user.
- A reviewer reads `.specguard/reports/` for UX, accessibility and functional issues beyond the stated criteria.
- A CI job reads the exit code and `.specguard/validation-history.json` to track verdicts over time.
- A product owner reads the per-capability judgement of whether observed behaviour delivers the stated value.

<a id="responsibilities"></a>
## Responsibilities

- Select validation targets (a spec, all specs, or one app) and resolve their URLs.
- Run the perceive → plan → act → verify loop per spec. For `verify`, it walks multiple rounds across pages.
- Produce exactly one verdict per criterion (PASS, FAIL, BLOCKED, INCONCLUSIVE) and a capability-level value judgement.
- Classify and block destructive and outbound actions deterministically.
- Authenticate per profile in isolated browser contexts, with cached logins.
- Keep credentials and sensitive page content out of logs, evidence, history and LLM prompts.
- Store evidence, history and reports, and write PASS/FAIL verdicts into the proof ledger as agentic evidence.
- Optionally emit a `@playwright/test` file from a passing run.
- Bound each run and restrict agent-initiated targets.

<a id="interfaces"></a>
## Interfaces

**CLI**

```
specguard validate [--spec <key>] [--all] [--url <base>] [--app <name>] [--no-review] [--headed] [--allow-outbound]
```

With neither `--spec` nor `--all`, the command fails with a usage error.

The requirements also describe a `verify` command, which takes a base URL and `--emit-tests`. Its full flag list is not given in the spec.

**MCP tool:** `specguard_validate`

**Config**
- `auth.profiles[]`: `name`, `strategy`, `loginUrl`, `usernameEnvVar`, `passwordEnvVar`, `successUrl`, `successSelector`, `storageStatePath`, `scriptPath`
- `validate.headless`, `validate.guardrails.{allow,deny,allowOutbound}`, `validate.redaction`
- `llm.allowImages`, `runners.playwright`
- Also referenced by requirements: `validate.maxRounds`, `validate.timeoutMs`, `validate.allowedHosts`, `validate.evidenceRetentionDays`, `validate.emitTests`, `paths.e2eTests`

**Files**
- `.specguard/evidence/<spec-key>/`
- `.specguard/auth/<profile>.json`
- `.specguard/reports/validate-<spec-key>.json`
- `.specguard/reports/verify-<spec>.json`
- `.specguard/validation-history.json`
- Generated e2e tests under `paths.e2eTests` (default `tests/e2e`)

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | All passed or skipped |
| 2 | Any criterion or login failed |
| 1 | Usage or internal error |

<a id="requirements"></a>
## Requirements

**Targeting and flow**
- **validate-targets**: Targets specs that declare `url:`. Accepts one spec, all specs or one app. Resolves relative URLs against a base URL override. A spec with no URL is skipped with a message.
- **perceive-plan-act-verify**: The agent perceives via screenshot and accessibility snapshot. It plans a short list of atomic browser actions from the acceptance criteria, performs them, then judges each criterion against the resulting state.
- **criterion-verdicts**: Each criterion gets exactly one verdict from PASS, FAIL, BLOCKED or INCONCLUSIVE. A FAIL cites evidence. A failed LLM call or unavailable evidence yields INCONCLUSIVE, never a pass.
- **validate-exit-code**: Exits 2 when any criterion or login fails, otherwise 0. Skipped specs and blocked actions alone do not fail a run.
- **evidence-and-history**: Screenshots and page evidence are stored per spec under `.specguard/evidence/`. Every run appends an entry with verdicts and overall result to `.specguard/validation-history.json`.
- **review-issue-report**: An optional review step produces a typed report of functional, UX, accessibility and visual issues under `.specguard/reports/`. It is skipped with `--no-review` or for specs with no UI sections.

**Guardrails**
- **action-classification**: Actions are classified as safe, destructive or outbound by deterministic whole-word keyword rules. When the target is known, the real control's role and accessible name take precedence over the planner's description.
- **guardrail-blocking**: Destructive and outbound actions are blocked before execution and surface as BLOCKED verdicts with the reason. Deny and allow rules in config override the built-in lists. Outbound actions run only when explicitly allowed. Destructive ones are never allowed.

**Authentication**
- **auth-strategies**: Supports form login, saved browser state, header and token credentials, and a project-supplied script. A login succeeds when a configured success URL or selector is reached, or otherwise when the browser leaves the login page.
- **auth-failures-and-cache**: A login failure, unknown profile or missing credential env var is reported as a clear authentication failure for the affected specs. A successful login is cached so each profile logs in once per run.
- **one-context-per-profile**: Each profile has its own browser context. A spec without a profile runs in an anonymous context that is never logged in.
- **credentials-never-leak**: Credentials are read only from environment variables. They never appear in config output, evidence, history, logs or LLM prompts, and error text derived from a login is redacted.

**Data handling and browser**
- **redact-before-llm**: Page text, accessibility text and console errors pass through the redactor before reaching the LLM. No screenshot is sent when images are disallowed in config.
- **browser-lifecycle**: Headless unless configured or `--headed` is passed. Runs locally or in Docker as configured. A missing Playwright installation produces an error with install instructions.
- **evidence-gitignored**: Evidence, saved login state and report directories are created with a `.gitignore` that excludes their contents.

**Capability-level verification**
- **capability-goals**: Goals are built per capability from its Users & Journeys and Scenarios, so the agent walks real journeys instead of isolated criteria.
- **value-judgement**: The judge also receives the capability's Problem & Value and returns a capability-level judgement of whether observed behaviour delivers the stated value. Gaps are reported as findings.
- **ledger-proof**: Verdicts are written to the proof ledger with evidence marked as agentic, so `check` treats browser verification as first-class proof alongside test results.
- **verify-walks-journeys**: `verify` takes every v2 capability when given a base URL, even one with no `url:`. It walks up to `validate.maxRounds` (default 3) plan-act rounds so one run can cross pages. The page is not reloaded between rounds.
- **verify-proof-matching**: Only PASS and FAIL are written as proof. BLOCKED and INCONCLUSIVE never overwrite a proof a test run earned. A verdict matches a requirement by its id (exact, or followed by a delimiter) or its exact text, never by substring.
- **verify-value-fails**: A capability whose value is judged NO fails verification even when every requirement passes. The judgement and its gaps are written to `.specguard/reports/verify-<spec>.json`.
- **verify-emits-playwright**:
  - The planner may take `click`, `fill`, `navigate` (same site only), `waitFor` and `assertText` steps.
  - A step that fails or does not hold is reported as `[action-failed]`, not swallowed.
  - `verify --emit-tests` (or `validate.emitTests`) turns a passing run in which every step ran into a `@playwright/test` file under `paths.e2eTests` (default `tests/e2e`).
  - The file starts from `BASE_URL`, carries `[layer: e2e]`, and tags only claims that have their own assertion step.
  - It is not written when a value would be redacted, and it never replaces a file it did not generate.

**Hardening**
- **untrusted-content-fenced**: Page content the model reads (title, accessibility tree, HTML, console errors) and imported or fetched documents are fenced as untrusted data. The `<untrusted-...>` tags cannot be closed by the content, and a closing tag inside it is defanged. Every system message says nothing inside the fence is an instruction. What the model proposes is still classified and guarded deterministically.
- **verify-run-bounds**: At most five browser steps per round regardless of the plan, `validate.maxRounds` of at most 10, and a wall-clock budget per spec (`validate.timeoutMs`, default 10 minutes). After the budget, no further round is planned, the run says so, and it judges what it saw.
- **agent-target-allowlist**: A check started by an agent (the MCP tool) may target only loopback and hosts in `validate.allowedHosts`. Entries may be `host`, `host:port` (that port only) or `*.domain` (subdomains only). Any other target is BLOCKED before a browser or the model sees it. A person on the command line is not restricted.
- **evidence-retention**: Evidence, saved-login and report folders are private to the owner (mode 0700, login files 0600). `validate.evidenceRetentionDays` removes older evidence at the start of a run (default: keep it).

<a id="code-map"></a>
## Code map

**Sources** (9 owned files)

| File | Notes |
|---|---|
| `src/adapters/playwright.ts` | Browser adapter |
| `src/adapters/auth-state-machine.ts` | Authentication flow |
| `src/adapters/sessions.ts` | Sessions and contexts |
| `src/adapters/guardrails.ts` | Action classification and blocking |
| `src/pipelines/validate.ts` | Validation pipeline |
| `src/cli/commands/validate.ts` | CLI command |
| `src/core/e2e-script.ts` | Playwright test emission |
| `src/core/untrusted.ts` | Untrusted-content fencing |
| `src/core/validate-targets.ts` | Target selection and URL resolution |

The spec does not map each file to specific requirements. The file names suggest the groupings above, but confirm in the code.

<a id="tests"></a>
## Tests

- `tests/adapters/playwright.test.ts`
- `tests/adapters/auth-state-machine.test.ts`
- `tests/adapters/auth-strategies.test.ts`
- `tests/adapters/sessions.test.ts`
- `tests/adapters/guardrails.test.ts`
- `tests/pipelines/validate.test.ts`
- `tests/pipelines/verify.test.ts`

Scenarios to cover or keep covered:
- **All pass:** every criterion is PASS, a history entry is appended, exit 0.
- **Failure with evidence:** the criterion is FAIL, cites a screenshot path under `.specguard/evidence/`, exit 2.
- **Destructive action:** a control named "Delete account" produces a `[blocked]` line and a BLOCKED verdict. It is also blocked with `--allow-outbound`.
- **Role-specific auth:** each profile logs in once in its own context, a spec with no profile runs anonymously, and an unset credential variable fails the affected specs with no credential value in the message.
- **No URL:** the spec is skipped with a reason and the exit code is unaffected.
- **Value-level judgement:** journeys are walked, a capability judgement with findings is produced, and verdicts are recorded in the ledger as agentic evidence.

<a id="security-and-data"></a>
## Security and data

- **Layered safety:** deterministic guardrails block destructive and outbound actions before they run. Model output is never trusted because it asked.
- **Credentials:** read only from environment variables and redacted from every string that could be logged or sent. Each login lives in an isolated browser context.
- **LLM input:** page text, accessibility text and console errors are redacted before reaching the LLM. Screenshots are sent only when `llm.allowImages` permits. Page content is fenced as untrusted data.
- **Evidence:** screenshots may contain personal data. Evidence, saved login state and reports are git-ignored, owner-private (0700, login files 0600) and should be treated as confidential. Retention is configurable.
- **Targets:** agent-initiated checks are limited to loopback and `validate.allowedHosts`. Verify against staging or local environments with test accounts, not production data.
- **Out of scope:** bypassing guardrails, running destructive actions against any environment, and interactive second-factor logins (use saved state, tokens or a script).

<a id="extending-it"></a>
## Extending it

The spec describes configuration-level extension points. It does not describe code-level extension APIs.

- **Guardrail rules:** add `validate.guardrails.allow` or `deny` entries to override the built-in keyword lists. Use `allowOutbound`, or `--allow-outbound`, to permit outbound actions. Destructive actions cannot be allowed.
- **Auth:** add an entry to `auth.profiles[]` with one of the supported strategies (form login, saved state, header/token, or project script via `scriptPath`). Set `successUrl` or `successSelector` to make success detection explicit. For second-factor logins, use saved state, tokens or a script.
- **Agent targets:** add hosts to `validate.allowedHosts` (`host`, `host:port`, `*.domain`).
- **Run bounds:** tune `validate.maxRounds` (max 10) and `validate.timeoutMs`.
- **E2E emission:** enable `--emit-tests` or `validate.emitTests`, and change the output location with `paths.e2eTests`.
- **New planner step types or guardrail behaviour:** the likely places are `src/adapters/playwright.ts` and `src/adapters/guardrails.ts`, per the code map. Any change must preserve the invariants in the requirements: the five-step cap, deterministic classification, and untrusted-content fencing.
