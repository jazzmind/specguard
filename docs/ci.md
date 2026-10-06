# SpecGuard in CI

## The GitHub Action

`action.yml` at the root of this repository is a composite action. It:

1. sets up Node,
2. installs `specguard-ai@<version>`,
3. runs the gates you list, in a fixed order, each as `specguard --json <gate>`,
4. writes a job summary and `.specguard/ci/<gate>.json` for every gate,
5. uploads `.specguard/` as an artifact (never `.specguard/.env` or `.specguard/auth/`),
6. fails the job when a `fail-on` threshold trips.

```yaml
- uses: jazzmind/specguard@v0   # pin to a release tag
  with:
    gates: status,drift,proof,results
    results: reports/*.json
    fail-on: missing-specs,drift,proof-failed,proof-stale,results
```

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `version` | `latest` | `specguard-ai` version to install. `local` builds the checked-out repo (SpecGuard's own CI). |
| `gates` | `status,proof` | Any of `status`, `drift`, `proof`, `align`, `results`, `validate`, `security`, `deps`. |
| `fail-on` | `missing-specs,drift,proof-failed,proof-stale,results` | Thresholds, below. |
| `results` | empty | Reporter files or globs for `results ingest` (comma or newline separated). The `results` gate does nothing without them. |
| `run-id` | `<run id>-<attempt>` | Run id stored in the proof ledger. |
| `drift-since` | `HEAD~1` | Git ref for `drift --since`, e.g. `origin/main`. |
| `validate-url` | empty | Base URL for `validate --all --url`. |
| `install-playwright` | `false` | Install browsers (needed by `validate`). |
| `working-directory` | `.` | Directory containing `.specguard/config.json`. |
| `upload-evidence`, `artifact-name` | `true`, `specguard-evidence` | Evidence artifact. |

Outputs: `failed` (`true` or `false`) and `tripped` (comma list).

### `fail-on` thresholds

| Threshold | Trips when |
|---|---|
| `missing-specs` | `status` found source files with no spec (exit 4) |
| `drift` | `drift` found drifted specs (exit 3) |
| `proof-failed` | the ledger has a failed or error claim |
| `proof-stale` | the ledger has a stale proof (spec, source, or lockfile changed) |
| `proof-unexercised` | the ledger has an unexercised claim |
| `proof-unproven` | a spec claim has no ledger row |
| `align-below:<n>` | the average alignment score is under n percent |
| `results` | `results ingest` exited non-zero (a failed claim or an unreadable report) |
| `validate`, `security`, `deps` | that gate exited non-zero |
| `none` | never fail; report only |

A gate that did not run never trips. `proof-*` thresholds are skipped, with a note in the summary, when there is no ledger yet.

## Examples

### Vitest and Playwright, claims proven on every PR

```yaml
jobs:
  specguard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx vitest run --reporter=json --outputFile=reports/vitest.json
        continue-on-error: true
      - run: npx playwright install --with-deps chromium
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

`continue-on-error` on the test steps lets SpecGuard decide: a failing test that carries a claim tag fails the `results` threshold, with the failing titles as counterexamples in the summary.

### JUnit (pytest, Maven, Go)

```yaml
      - run: pytest --junitxml=reports/pytest.xml || true
      - uses: jazzmind/specguard@v0
        with: { gates: results, results: reports/pytest.xml }
```

Maven: `results: target/surefire-reports/TEST-*.xml`. Go: `go test -json ./... > reports/go.jsonl`.

### Key-free CI with recorded LLM answers

Record once locally (`specguard align --all --record`), commit `.specguard/replay/`, then set `"llm": { "provider": "replay", ... }` in the CI config (or a CI-only config that `extends` the main one). Prompts with a recording are answered offline; any other prompt fails with its hash. Set `"llm": { "provider": "none" }` to run only the deterministic parts (`align` uses claim tags and titles alone).

### Capping spend

`"llm": { "budget": { "maxUsd": 2 } }` makes the run stop calling the LLM once the estimate crosses $2, and the step exits with code 8. `.specguard/llm-usage.json` in the evidence artifact shows what was spent, per pipeline and per model.

## Releases

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`: it checks the tag equals the root `package.json` version, runs typecheck, lint, tests and build for the CLI and extension, publishes `specguard-ai` to npm, then publishes the extension at the same version, then creates the GitHub release. The root `package.json` is the single version source: the bundled CLI inside the extension and the extension host are built with that version, and the extension warns when an installed CLI reports another version through `specguard --version --json`. Secrets: `NPM_TOKEN`, `VSCE_PAT`, optionally `OVSX_PAT`.

The extension's marketplace version (0.1.29) is above the CLI's (0.1.2), and the marketplace refuses a lower version: the first combined release has to be at least 0.1.30, for example 0.2.0.
