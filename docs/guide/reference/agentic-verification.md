---
title: "Agentic Verification"
audience: user
source: "specs/capabilities/agentic-verification.md"
generated: true
---
<a id="agentic-verification"></a>
# Agentic Verification

Agentic verification checks a running application against what its specs say it is for. A browser agent looks at the live page the way a user would, tries the interactions needed to check each acceptance criterion, and reports a verdict for each one with evidence. The result shows whether the finished product lets people do what the spec promised and delivers the value it was written for.

<a id="why-it-exists"></a>
## Why it exists

Unit and integration tests show that individual pieces behave as coded. They don't show that the running application lets a user accomplish what the spec promised. End-to-end test suites help, but they are expensive to write, brittle to maintain, and only check what someone thought to script.

The agent works from the spec's own words, so you don't write selectors or scripts. It runs under strict safety rules and can never delete data or send messages on its own.

<a id="what-you-can-do"></a>
## What you can do

**Verify a spec against a live app**
- Run `specguard validate --spec <key> --url http://localhost:3000` after a change to see which acceptance criteria the live page fails, with screenshots as evidence.
- Use `--all` to check every spec, or `--app <name>` to check one app.
- Specs that declare a `url:` are checked. Relative URLs are resolved against the base URL you pass with `--url`. A spec with no URL and no base URL is skipped with a message.
- Running `validate` with neither `--spec` nor `--all` gives a usage error.

**Get a verdict for every criterion**
- Each acceptance criterion gets exactly one verdict:
  - **PASS**: the criterion holds.
  - **FAIL**: the criterion doesn't hold, and the verdict cites its evidence.
  - **BLOCKED**: the needed action was stopped by a safety rule.
  - **INCONCLUSIVE**: there wasn't enough to decide, for example the AI call failed or evidence was unavailable. This is never treated as a pass.

**Verify as the right kind of user**
- Define an authentication profile for each role, such as admin and member.
- Profiles can use a form login, saved browser state, header or token credentials, or a script supplied by your project.
- A login succeeds when a configured success URL or element is reached. Otherwise it succeeds when the browser leaves the login page.
- Each profile logs in once per run, in its own isolated browser session, so logins never mix.
- A spec with no profile runs anonymously and is never logged in.
- Interactive second-factor logins aren't supported. Use saved state, tokens or a script instead.

**Allow outbound actions deliberately**
- Add `--allow-outbound` to exercise flows that send notifications, for example against staging.
- Destructive actions stay blocked even with this flag.

**Judge value, not only criteria**
- Validation goals are built for each capability from its Users & Journeys and Scenarios, so the agent walks real user journeys instead of isolated criteria.
- The agent also reads the capability's Problem & Value statement. It gives a judgement on whether the observed behaviour delivers that value, and reports any gaps as findings.
- A capability whose value is judged **NO** fails verification even if every requirement passes.

**Use `verify` for multi-page journeys**
- When you give `verify` a base URL, it covers every v2 capability, even ones with no `url:` of their own.
- It can work over several plan-and-act rounds, up to `validate.maxRounds` (default 3, maximum 10), so one run can cross pages. The page isn't reloaded between rounds.
- The agent can click, fill in fields, navigate (within the same site only), wait for something to appear, and assert that text is present.
- If a step fails or an assertion doesn't hold, it is reported as `[action-failed]` rather than ignored.

**Turn a good run into a regular test**
- Use `verify --emit-tests` (or set `validate.emitTests`) to turn a passing run in which every step ran into a Playwright test file. It goes under your end-to-end test folder (default `tests/e2e`).
- The generated test starts from `BASE_URL` and is labelled as an end-to-end test.
- Only claims that have an assertion step of their own are tagged.
- No file is written if it would have to contain a value that gets redacted.
- A file that wasn't generated this way is never replaced.

**Get a review beyond the criteria**
- An optional review step reports functional, UX, accessibility and visual problems the agent noticed beyond the stated criteria. It is saved under `.specguard/reports/`.
- Skip it with `--no-review`. It is also skipped automatically for specs with no UI sections.

**Run it from CI or from an agent**
- CI jobs can read the exit code and `.specguard/validation-history.json` to track whether results are improving.
- An agent can start a check through the `specguard_validate` tool.

<a id="what-to-expect"></a>
## What to expect

**Results and exit codes**
- Exit code **0**: everything passed, or specs were skipped.
- Exit code **2**: any criterion or login failed.
- Exit code **1**: a usage or internal error.
- Skipped specs and blocked actions alone don't fail a run.

**Where things are saved**
- Screenshots and page evidence are stored per spec under `.specguard/evidence/<spec-key>/`.
- A report per spec is written to `.specguard/reports/validate-<spec-key>.json`. `verify` writes `verify-<spec>.json`, which includes the value judgement and its gaps.
- Every run appends its verdicts and overall result to `.specguard/validation-history.json`.
- Verdicts also go into the proof ledger, marked as agentic evidence, so `check` treats browser verification as proof alongside test results.
  - Only PASS and FAIL are recorded. BLOCKED and INCONCLUSIVE never overwrite a proof that a test run earned.
  - A verdict is matched to a requirement by its id or its exact text, never by a partial match.

**Safety rules**
- Before anything runs, each planned action is classified as safe, destructive or outbound. Classification uses whole-word keyword rules. When the real control is known, its role and accessible name take precedence over the planner's description. For example, a control named "Delete account" is treated as destructive.
- Destructive and outbound actions are blocked before they run. A `[blocked]` line is printed and the affected criterion is BLOCKED, with the reason.
- You can adjust the built-in lists with allow and deny rules in configuration. Destructive actions are never allowed.
- The model's proposals are never trusted just because it asked. Everything it plans is still checked by the same fixed rules.

**Limits on a run**
- At most five browser steps run per round, however many the model plans.
- Each spec has a time budget (`validate.timeoutMs`, default 10 minutes). When it runs out, no further rounds are planned, the run says so, and it judges what it saw.
- An agent-started check can only target loopback addresses and hosts listed in `validate.allowedHosts`. Entries can be `host`, `host:port` (that port only), or `*.domain` (subdomains only). Any other target is BLOCKED before a browser or the model sees it. A person on the command line isn't restricted this way.

**Privacy and credentials**
- Credentials are read only from environment variables. They never appear in config output, evidence, history, logs or AI prompts, and error text from a login is redacted.
- If a profile is unknown, a login fails, or a credential variable is unset, the affected specs fail with a clear authentication message. The message contains no credential value.
- Page text, accessibility text and console errors are redacted before the AI sees them.
- Content from the page and from imported or fetched documents is passed to the AI as untrusted data, with an explicit statement that nothing in it is an instruction.
- No screenshot is sent to the AI unless your configuration allows images (`llm.allowImages`).
- Evidence, saved login and report folders are private to their owner and are excluded from git automatically.
- Screenshots can contain personal data, so treat evidence as confidential.
- To remove old evidence automatically, set `validate.evidenceRetentionDays`. Cleanup happens at the start of a run. By default evidence is kept.

**Browser setup**
- The browser runs headless unless you configure otherwise or pass `--headed`.
- It can run locally or in Docker, as configured.
- If Playwright isn't installed, you get an error with install instructions.

**Where to point it**
- Use staging or local environments with test accounts, not production data.

**What it doesn't do**
- Generate or run scripted tests, other than the optional `--emit-tests` output described above. See conformance-testing for scripted tests.
- Load, performance or visual-regression testing.
- Bypass the guardrails or run destructive actions against any environment.
