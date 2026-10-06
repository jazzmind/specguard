# Adopting SpecGuard in HiRocky

HiRocky is an npm-workspaces monorepo: `apps/api` (`@bm/api`, Vitest), `apps/web` (`@bm/web`, Vitest, `--passWithNoTests`), and a root Playwright suite (`e2e/journeys`, config `playwright.config.ts`). This is the exact setup, derived from what SpecGuard does. Replace the placeholders `<...>`.

## 1. Install

```bash
npm i -D specguard-ai          # binaries: specguard, specguard-mcp
npx specguard --version --json # {"name":"specguard-ai","version":...}
```

Without installing, use `npx -p specguard-ai specguard <command>`. Bare `npx specguard` resolves to an unrelated package and must not be used.

## 2. `.specguard/config.json`

```jsonc
{
  "apps": [
    {
      "name": "api", "repo": "apps/api", "language": "typescript", "framework": "vitest",
      "specDir": "specs/api", "testOutput": "apps/api/test/",
      "sources": { "api": ["apps/api/src/**/*.ts"], "tests": ["apps/api/test/**/*.test.ts"] },
      "test": { "command": "npm run test --workspace @bm/api", "reporter": "vitest",
                "resultsFile": "reports/vitest-api.json", "timeoutMs": 600000 }
    },
    {
      "name": "web", "repo": "apps/web", "language": "typescript", "framework": "vitest",
      "specDir": "specs/web", "testOutput": "apps/web/src/",
      "sources": { "api": ["apps/web/src/**/*.{ts,tsx}"], "tests": ["apps/web/src/**/*.test.{ts,tsx}"] },
      "exclude": ["apps/web/src/**/*.test.{ts,tsx}"],
      "test": { "command": "npm run test --workspace @bm/web", "reporter": "vitest",
                "resultsFile": "reports/vitest-web.json" }
    },
    {
      "name": "e2e", "repo": "e2e", "language": "typescript", "framework": "playwright",
      "specDir": "specs/e2e", "testOutput": "e2e/journeys/",
      "sources": { "api": ["e2e/journeys/**/*.ts"], "tests": ["e2e/journeys/**/*.spec.ts"] },
      "test": { "command": "npx playwright test --reporter=list,json", "reporter": "playwright",
                "resultsFile": "reports/playwright.json" }
    }
  ],
  "paths": { "specsRoot": "specs", "proofLedger": ".specguard/proofs.json" },
  "runners": { "playwright": "local", "testRunner": "local" },
  "llm": { "provider": "anthropic", "model": "<model>", "apiKeyEnv": "ANTHROPIC_API_KEY", "allowImages": false },
  "auth": {
    "profiles": [
      { "name": "admin", "strategy": "storageState", "storageStatePath": ".specguard/auth/admin.json",
        "loginUrl": "http://localhost:5173/login", "usernameEnvVar": "HIROCKY_ADMIN_EMAIL", "passwordEnvVar": "HIROCKY_ADMIN_PASSWORD",
        "successUrl": "/\\/dashboard/" }
    ]
  },
  "validate": {
    "headless": true,
    "guardrails": { "deny": [], "allow": ["postcode"], "allowOutbound": false },
    "redaction": { "builtin": true, "patterns": [], "blankSelectors": ["[data-pii]"] }
  }
}
```

Notes that follow from the code:

- When `test.resultsFile` is set the command runs verbatim and SpecGuard only reads that file, so the command must write it. Vitest resolves `--outputFile` relative to the workspace directory. Easiest: leave `resultsFile` unset and let SpecGuard inject the reporter flags (`--reporter=json --outputFile=<tmp>`, Playwright `PLAYWRIGHT_JSON_OUTPUT_NAME`) when it runs the command itself through `heal`. For CI, run the tests yourself (step 4) and ingest the files.
- Do not commit `.specguard/auth/`, `.specguard/evidence/`, `.specguard/reports/`; the first `validate` run writes a `.gitignore` in each. `.specguard/proofs.json` is meant to be committed.
- The `storageState` profile reads `.specguard/auth/admin.json`; when it is missing, SpecGuard logs in with the env vars and creates it. `successUrl` is a URL or a `/regex/`; omit it and any URL other than the login page counts as logged in. Other strategies: `header`, `token`, `script` (see `specs/adapters/auth-state-machine.md`).
- `llm.allowImages: false` keeps screenshots away from the LLM; DOM, a11y text and console errors are always redacted first (email, phone, SSN, card numbers, plus `patterns` and `blankSelectors`).

## 3. Tag tests with claims

A claim is an acceptance-criteria bullet in a spec with an anchor: `- User can reset password <!-- claim: reset-password -->`. The tag is `@claim:<specKey>#<claimId>`, e.g. `@claim:api/auth#reset-password`.

Vitest (api and web), in the title:

```ts
it('rejects an expired token @claim:api/auth#token-expiry', () => { /* ... */ });
```

Playwright, in the title or as a tag or annotation:

```ts
test('reset password @claim:web/auth#reset-password', async ({ page }) => { /* ... */ });
test('pays by card', { tag: '@claim:e2e/checkout#pay-card' }, async ({ page }) => { /* ... */ });
```

`[claim: ref]` suffixes and `[claims: a#b, c#d]` lists also work. `specguard generate` writes the tag into the tests it creates.

## 4. Produce reports and ingest

```bash
npm run test --workspace @bm/api -- --reporter=json --outputFile=../../reports/vitest-api.json
npm run test --workspace @bm/web -- --reporter=json --outputFile=../../reports/vitest-web.json
PLAYWRIGHT_JSON_OUTPUT_NAME=reports/playwright.json npx playwright test --reporter=list,json

npx specguard results ingest reports/vitest-api.json reports/vitest-web.json reports/playwright.json \
  --run-id "$(git rev-parse --short HEAD)" --unexercised
npx specguard proof status          # exits 2 on a failed or stale claim
npx specguard status                # spec coverage plus the proofs summary
```

A verdict file from another tool goes in with `specguard proof ingest verdicts.json` (`{"runId": "...", "verdicts": [{"claim": "api/auth#token-expiry", "verdict": "proven", "exercised": 3}]}`).

Verdict rules: any failing tagged test gives `failed` (counterexamples = failing titles); one pass and no failure gives `proven`; skipped only gives `unexercised`. A proof goes stale when its spec, a recorded source file, or the lockfiles change. `results ingest` exits 2 on a failed claim or an unreadable report.

## 5. Validate (browser)

```bash
npx playwright install chromium
npx specguard validate --all --url http://localhost:5173            # specs need a `url:` line
npx specguard validate --spec web/auth --url http://localhost:5173 --allow-outbound   # staging only
```

Add `--headed` to watch. Destructive actions (delete, remove, ...) stay blocked even with `--allow-outbound`. Guardrails match whole words and judge the target element's role and accessible name, so a field labelled "Postcode" is not blocked by "post".

## 6. GitHub Action

```yaml
name: specguard
on: [pull_request]
jobs:
  specguard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run test --workspace @bm/api -- --reporter=json --outputFile=../../reports/vitest-api.json
        continue-on-error: true
      - run: npm run test --workspace @bm/web -- --reporter=json --outputFile=../../reports/vitest-web.json
        continue-on-error: true
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test --reporter=list,json
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reports/playwright.json }
        continue-on-error: true
      - uses: jazzmind/specguard@v0
        with:
          gates: status,drift,proof,results
          results: |
            reports/vitest-api.json
            reports/vitest-web.json
            reports/playwright.json
          drift-since: origin/main
          fail-on: missing-specs,drift,proof-failed,proof-stale,results
```

See `docs/ci.md` for every input and threshold.
