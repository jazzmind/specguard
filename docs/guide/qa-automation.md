---
title: "Quickstart: QA automation"
audience: user
order: 18
source: "specs/guides/qa-automation.md"
generated: true
---
<a id="quickstart-qa-automation"></a>
# Quickstart: QA automation

> Prove requirements on every pull request, with layers of tests, browser verification and evidence kept in CI.

<a id="goal"></a>
## Goal
Run your tests on every pull request, record which requirements they prove, in which layer, and keep that evidence where CI can vouch for it.

<a id="prerequisites"></a>
## Prerequisites
- Capability specs with tagged tests (see [one repository](single-repo.md)).
- A GitHub repository, for the generated workflows. Other CI systems use the same commands.

<a id="steps"></a>
## Steps
<a id="write-the-workflows"></a>
### Write the workflows
```bash
specguard init --ci github
```

This writes two workflows. `.github/workflows/specguard.yml` runs on pull requests and pushes to the default branch with a full-history checkout, runs `check,test,scan,proof,publish`, comments the results on the pull request, uploads security findings to code scanning, and offers a manual browser `verify` run. It does not fail on security findings by default; add `scan` to `fail-on` once they are triaged. `.github/workflows/specguard-remediate.yml` opens weekday remediation pull requests (see [Vulnerability management](vulnerability-management.md)).

<a id="or-use-the-action-directly"></a>
### Or use the action directly
```yaml
- uses: jazzmind/specguard@v0   # pin to a release tag
  with:
    gates: status,drift,proof,results
    results: reports/*.json
    fail-on: missing-specs,drift,proof-failed,proof-stale,results
```

The action sets up Node, installs `specguard-ai`, runs each gate as `specguard --json <gate>` in a fixed order, writes a job summary and `.specguard/ci/<gate>.json`, uploads `.specguard/` as the `specguard-evidence` artifact (never `.specguard/.env` or `.specguard/auth/`), and fails the job when a `fail-on` threshold trips.

| Input | Meaning |
|---|---|
| `gates` | Any of `status`, `drift`, `proof`, `align`, `results`, `validate`, `security`, `check`, `test`, `verify`, `scan` |
| `fail-on` | Thresholds: `missing-specs`, `drift`, `proof-failed`, `proof-stale`, `proof-unexercised`, `proof-unproven`, `proof-incomplete`, `align-below:<n>`, `results`, a gate name, or `none` |
| `results` | Reporter files or globs for `results ingest` |
| `drift-since` | Git ref for `drift --since`, for example `origin/main` |
| `affected`, `affected-since` | With `affected: true` the `test` gate runs only the units a pull request changed and their dependents |
| `comment`, `sarif` | Post one updated pull request comment; upload findings to code scanning |
| `version` | `specguard-ai` version, or `local` to build the checked-out repository |

A gate that did not run never trips, and `proof-*` thresholds are skipped, with a note, when there is no ledger yet.

<a id="let-ci-run-your-tests-then-ingest"></a>
### Let CI run your tests, then ingest
```yaml
- run: npx vitest run --reporter=json --outputFile=reports/vitest.json
  continue-on-error: true
- run: npx playwright test --reporter=json
  env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reports/playwright.json }
  continue-on-error: true
- uses: jazzmind/specguard@v0
  with:
    gates: status,proof,results
    results: |
      reports/vitest.json
      reports/playwright.json
    fail-on: proof-failed,proof-stale,results
```

`continue-on-error` lets SpecGuard decide: a failing test that carries a claim tag fails the `results` threshold, with the failing titles as counterexamples in the summary. For JUnit (pytest, Maven, Go) pass the XML: `results: reports/pytest.xml`.

<a id="declare-which-layers-a-claim-needs"></a>
### Declare which layers a claim needs
A proof records the layer that earned it: `unit`, `integration`, `e2e`, `security` or `functional`. A capability states what its claims need:

```yaml
layers:
  default: [unit]
  claims:
    login-valid-code: [unit, e2e]
```

or `layers: [unit, e2e]` for every claim. A project default is `proof.requiredLayers`; `proof.enforceLayers` is `warn` (default), `fail` or `off`. A test gets its layer from an `@layer:e2e` tag, a `// [layer: e2e]` comment, the app's `test.layers` globs, the suite that ran it, `results ingest --layer`, a Playwright report, or a folder such as `e2e/`; otherwise `unit`. Run several suites per app with the `test.suites` block, and `specguard test run` ingests each with its layer. `check` then prints `[proof-incomplete] <claim> (missing: e2e)` and a `LAYERS:` line; use the `proof-incomplete` threshold in CI.

<a id="verify-the-running-app-with-a-browser-agent"></a>
### Verify the running app with a browser agent
```bash
specguard verify --all --url http://localhost:3000
specguard verify --all --url http://localhost:3000 --emit-tests
```

`verify` walks each capability's journeys in a browser and judges the app against the capability's stated problem and value, recording `functional` proof. `--emit-tests` turns a passing run into a Playwright test (`tests/e2e/<capability>.verify.spec.ts`) tagged only with the requirements the run asserted, so the same journey runs in CI without a model. Destructive actions stay blocked, and `--allow-outbound` is for staging only. Install a browser first with `npx playwright install chromium`.

<a id="certify-on-ci-evidence"></a>
### Certify on CI evidence
```bash
specguard proof publish
specguard proof fetch
specguard proof notes
specguard check
```

CI writes its proof as a git note under `refs/notes/specguard`; `check` reads it after `proof fetch`. A capability is `certified` only on that evidence at a clean commit, and `provisional` when the same evidence came from a local run. `specguard ci run` does the whole CI job: it builds the proof packet and posts the comment.

<a id="keep-ci-cheap-and-key-free"></a>
### Keep CI cheap and key-free
Record model answers once with `specguard align --all --record`, commit `.specguard/replay/`, and set `"llm": { "provider": "replay" }` in the CI config; prompts with a recording are answered offline and any other prompt fails with its hash. Set `"provider": "none"` to run only deterministic parts. Cap spend with `"llm": { "budget": { "maxUsd": 2 } }`; the step then exits with code 8, and `.specguard/llm-usage.json` shows what was spent per pipeline and model.

<a id="releases"></a>
### Releases
Pushing a tag `vX.Y.Z` runs the Release workflow: it checks the tag equals the root `package.json` version, runs the gates, publishes to npm with trusted publishing, and creates the GitHub release. See [Developing SpecGuard](../dev/developing-specguard.md).

<a id="read-the-results"></a>
### Read the results
```bash
specguard report --out reports/specguard
specguard matrix
```

`report` renders a test report (HTML and `report.json`) with evidence; `matrix` writes the requirement-to-test traceability matrix.

<a id="outcome"></a>
## Outcome
Every pull request shows which requirements are proven, failing, stale or missing a layer, with the numbers compared to the previous run on that pull request, and CI evidence decides certification.

<a id="related"></a>
## Related
- [Vulnerability management](vulnerability-management.md)
- [Collaborating with a team](team-collaboration.md)
- [How SpecGuard fits with other tools](fits-with-tools.md)

<a id="reference-pages"></a>
## Reference pages

- [Conformance Testing](./reference/conformance-testing.md)
- [Proof Store](./reference/proof-store.md)
- [Agentic Verification](./reference/agentic-verification.md)
- [Integration Surfaces - CLI, Agents, CI, IDE and Plugins](./reference/integration-surfaces.md)
