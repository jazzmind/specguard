---
id: agentic-verification
kind: capability
title: Agentic Verification
parent: system
value: The running system is judged against what its specs say it is for, by a browser agent that can see and use it safely, so requirements are verified end to end and not only line by line.
status: active
sources:
  - "src/adapters/playwright.ts"
  - "src/adapters/auth-state-machine.ts"
  - "src/adapters/sessions.ts"
  - "src/adapters/guardrails.ts"
  - "src/pipelines/validate.ts"
  - "src/cli/commands/validate.ts"
  - "src/core/e2e-script.ts"
  - "src/core/untrusted.ts"
  - "src/core/validate-targets.ts"
tests:
  - "tests/adapters/playwright.test.ts"
  - "tests/adapters/auth-state-machine.test.ts"
  - "tests/adapters/auth-strategies.test.ts"
  - "tests/adapters/sessions.test.ts"
  - "tests/adapters/guardrails.test.ts"
  - "tests/pipelines/validate.test.ts"
  - "tests/pipelines/verify.test.ts"
docs:
  - "README.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-22-0-3-phase-3-test-layers-and-ci
  - 2026-10-22-header-role-fix-and-spec-level-security
  - 2026-10-22-security-no-requirement-governs-who-may
  - 2026-10-22-security-evidence-screenshots-containing
  - 2026-10-22-security-prompt-injection-via-page-conte
  - 2026-10-22-security-no-rate-limit-or-budget-cap-on-2
---

# Agentic Verification

## Problem & Value
Unit and integration tests show that individual pieces behave as coded. They do not show that the finished, running application lets a user accomplish what the spec promised, or that it delivers the business value the spec exists for. End-to-end suites close part of that gap but are expensive to write and brittle to maintain, and they only check what someone thought to script.

Agentic verification points an LLM-driven browser agent at the running application. It looks at the page the way a user would (a screenshot plus the accessibility tree), plans the few interactions needed to check each acceptance criterion, performs them under strict guardrails, and returns an evidence-backed verdict per criterion. Because it works from the spec's own words, it needs no scripted selectors, and it can never delete data or send messages on its own.

## Users & Journeys
- A developer runs `specguard validate --spec <key> --url http://localhost:3000` after a change to see which acceptance criteria the live page fails, with screenshots as evidence.
- A QA lead runs `specguard validate --all` against staging with `--allow-outbound` to exercise flows that send notifications, while deletion stays blocked.
- A security-minded engineer defines an auth profile per role (for example admin and member) so each spec is verified as the right kind of user and logins never mix.
- A reviewer reads `.specguard/reports/` to see UX, accessibility and functional issues the agent noticed beyond the stated criteria.
- A CI job reads the exit code and `.specguard/validation-history.json` to track whether verdicts are improving over time.
- a product owner reads a per-capability judgement of whether the observed behaviour actually delivers the stated value.

## Requirements
- [ ] Validation targets specs that declare a `url:`, accepts a single spec, all specs or one app, resolves relative URLs against a base URL override, and skips with a message a spec that has no URL. <!-- claim: validate-targets -->
- [ ] For each spec the agent perceives the page through a screenshot and an accessibility snapshot, plans a short list of atomic browser actions from the acceptance criteria, performs them and then judges each criterion against the resulting state. <!-- claim: perceive-plan-act-verify -->
- [ ] Every acceptance criterion receives exactly one verdict from PASS, FAIL, BLOCKED or INCONCLUSIVE, a FAIL cites its evidence, and a failed LLM call or unavailable evidence yields INCONCLUSIVE rather than a pass. <!-- claim: criterion-verdicts -->
- [ ] The command exits with the validation-failed code (2) when any criterion or login fails and 0 otherwise, so skipped specs and blocked actions alone do not fail a run. <!-- claim: validate-exit-code -->
- [ ] Screenshots and page evidence are stored per spec under `.specguard/evidence/`, and every run appends an entry with its verdicts and overall result to `.specguard/validation-history.json`. <!-- claim: evidence-and-history -->
- [ ] An optional review step, skipped with `--no-review` or for specs with no UI sections, produces a typed issue report of functional, UX, accessibility and visual problems under `.specguard/reports/`. <!-- claim: review-issue-report -->
- [ ] Planned actions are classified as safe, destructive or outbound by deterministic whole-word keyword rules, with the real control's role and accessible name taking precedence over the planner's description when the target is known. <!-- claim: action-classification -->
- [ ] Destructive and outbound actions are blocked before execution and surfaced as BLOCKED verdicts with the reason, deny and allow rules in configuration override the built-in lists, and outbound actions run only when explicitly allowed while destructive ones are never allowed. <!-- claim: guardrail-blocking -->
- [ ] Authentication profiles support form login, saved browser state, header and token credentials, and a project-supplied script, and a login succeeds when a configured success URL or selector is reached, or otherwise when the browser leaves the login page. <!-- claim: auth-strategies -->
- [ ] A login failure, unknown profile or missing credential environment variable is reported as a clear authentication failure for the affected specs, and a successful login is cached so each profile logs in once per run. <!-- claim: auth-failures-and-cache -->
- [ ] Each auth profile runs in its own browser context and a spec without a profile runs in an anonymous context that is never logged in. <!-- claim: one-context-per-profile -->
- [ ] Credentials are read only from environment variables and never appear in config output, evidence, history, logs or LLM prompts, and error text derived from a login is redacted. <!-- claim: credentials-never-leak -->
- [ ] Page text, accessibility text and console errors pass through the redactor before reaching the LLM, and no screenshot is sent when images are disallowed in configuration. <!-- claim: redact-before-llm -->
- [ ] The browser is headless unless configured or `--headed` is passed, runs locally or in Docker as configured, and a missing Playwright installation produces an error with install instructions. <!-- claim: browser-lifecycle -->
- [ ] Evidence, saved login state and report directories are created with a `.gitignore` that excludes their contents. <!-- claim: evidence-gitignored -->
- [ ] validation goals are built per capability from its Users & Journeys and Scenarios, so the agent walks real user journeys instead of isolated criteria. <!-- claim: capability-goals -->
- [ ] the judge also receives the capability's Problem & Value and returns a capability-level judgement of whether the observed behaviour delivers the stated value, reporting gaps as findings. <!-- claim: value-judgement -->
- [ ] verdicts are written into the proof ledger with evidence marked as agentic, so `check` treats browser verification as first-class proof alongside test results. <!-- claim: ledger-proof -->
- [ ] `verify` takes every v2 capability when given a base URL, even one with no `url:` of its own, and walks up to `validate.maxRounds` (default 3) plan-act rounds so one run can cross pages; the page is not reloaded between rounds <!-- claim: verify-walks-journeys -->
- [ ] Only PASS and FAIL verdicts are written as proof; BLOCKED and INCONCLUSIVE never overwrite a proof a test run earned, and a verdict is matched to a requirement by its id (exact, or followed by a delimiter) or its exact text, never by substring <!-- claim: verify-proof-matching -->
- [ ] A capability whose value is judged NO fails the verification even when every requirement passes, and the judgement with its gaps is written to `.specguard/reports/verify-<spec>.json` <!-- claim: verify-value-fails -->
- [ ] The planner may take `click`, `fill`, `navigate` (same site only), `waitFor` and `assertText` steps, a step that fails or does not hold is reported as `[action-failed]` instead of being swallowed, and `verify --emit-tests` (or `validate.emitTests`) turns a passing run in which every step ran into a `@playwright/test` file under `paths.e2eTests` (default `tests/e2e`) that starts from `BASE_URL`, carries `[layer: e2e]`, tags only the claims that have an assertion step of their own, is not written when a value would be redacted, and never replaces a file it did not generate <!-- claim: verify-emits-playwright -->
- [ ] Page content the model reads (the title, the accessibility tree, the HTML, console errors) and imported or fetched documents are fenced as untrusted data (`<untrusted-...>` tags the content cannot close, a closing tag inside it is defanged), every system message says that nothing inside the fence is an instruction, and what the model proposes is still classified and guarded deterministically, never trusted because it asked <!-- claim: untrusted-content-fenced -->
- [ ] One run is bounded: at most five browser steps per round whatever the model plans, `validate.maxRounds` of at most 10, and a wall-clock budget per spec (`validate.timeoutMs`, default 10 minutes) after which no further round is planned, the run says so and judges what it saw <!-- claim: verify-run-bounds -->
- [ ] A check started by an agent (the MCP tool) may target only loopback and the hosts listed in `validate.allowedHosts` (`host`, `host:port` on that port only, `*.domain` for subdomains only); any other target is BLOCKED before a browser or the model sees it; a person on the command line is not restricted <!-- claim: agent-target-allowlist -->
- [ ] The evidence, saved-login and report folders are private to their owner (mode 0700, login files 0600), and `validate.evidenceRetentionDays` removes evidence older than that at the start of a run (default: keep it) <!-- claim: evidence-retention -->

## Scenarios
### Scenario 1: All criteria pass
**Steps:**
1. A spec declares `url:` for a running app.
2. A developer runs `specguard validate --spec <key>`.

**Expected Results:**
- Each criterion gets a PASS verdict.
- A history entry is appended and the command exits 0.

### Scenario 2: A criterion fails with evidence
**Steps:**
1. The page does not show a confirmation the spec requires.
2. `specguard validate --spec <key>` runs.

**Expected Results:**
- The criterion is FAIL and the message cites a screenshot path under `.specguard/evidence/`.
- The command exits with code 2.

### Scenario 3: A destructive action is planned
**Steps:**
1. The planner proposes clicking a control named "Delete account" to check a criterion.
2. Guardrails classify the target by its accessible name.

**Expected Results:**
- The action is not executed and a `[blocked]` line is printed.
- The affected criterion is BLOCKED, not PASS or FAIL.
- The same holds with `--allow-outbound`, because destructive actions are never allowed.

### Scenario 4: Role-specific verification
**Steps:**
1. Two specs name different auth profiles, `admin` and `member`, with credentials in environment variables.
2. `specguard validate --all` runs.

**Expected Results:**
- Each profile logs in once, in its own browser context.
- A spec with no profile runs anonymously.
- If a credential variable is unset, the affected specs fail with a missing-variable message that contains no credential value.

### Scenario 5: Spec without a URL
**Steps:**
1. A spec has no `url:` and no base URL is provided.
2. `specguard validate --all` runs.

**Expected Results:**
- The spec is skipped with a reason and does not affect the exit code.

### Scenario 6: value-level judgement
**Steps:**
1. A capability spec lists user journeys and a Problem & Value statement.
2. The planned validation walks each journey.

**Expected Results:**
- A capability-level judgement states whether the observed behaviour delivers the stated value.
- Gaps appear as findings and verdicts are recorded in the proof ledger as agentic evidence.

## Security & Data Considerations
The agent acts on a live application, so safety rests on layered controls: deterministic guardrails block destructive and outbound actions before they run, credentials come only from environment variables and are redacted from every string that could be logged or sent, and each login lives in an isolated browser context. Page text, accessibility text and console errors are redacted before they reach the LLM, and screenshots are sent only when the configuration allows images. Evidence screenshots can contain personal data, so evidence and saved login state are git-ignored and should be treated as confidential. Verification should target staging or local environments with test accounts, not production data.

## Interfaces
- CLI: `specguard validate [--spec <key>] [--all] [--url <base>] [--app <name>] [--no-review] [--headed] [--allow-outbound]`. With neither `--spec` nor `--all` the command fails with a usage error.
- MCP tool: `specguard_validate`.
- Config: `auth.profiles[]` (name, strategy, loginUrl, usernameEnvVar, passwordEnvVar, successUrl, successSelector, storageStatePath, scriptPath), `validate.headless`, `validate.guardrails.{allow,deny,allowOutbound}`, `validate.redaction`, `llm.allowImages`, `runners.playwright`.
- Files: `.specguard/evidence/<spec-key>/`, `.specguard/auth/<profile>.json`, `.specguard/reports/validate-<spec-key>.json`, `.specguard/validation-history.json`.
- Exit codes: 0 all passed or skipped, 2 any criterion or login failed, 1 usage or internal error.

## Out of Scope
- Generating or running scripted tests (see conformance-testing).
- Load, performance or visual-regression testing.
- Bypassing guardrails or running destructive actions against any environment.
- Interactive second-factor logins; use saved state, tokens or a script instead.
