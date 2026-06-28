# Playwright Adapter

<!-- module: src/adapters/playwright.ts -->
<!-- type: adapter -->
<!-- status: stable -->

## Overview

The Playwright adapter wraps `@playwright/test` browser automation behind a typed
interface used by the validate and heal pipelines. It handles browser lifecycle,
page navigation, screenshot capture, and accessibility snapshot extraction.

The adapter uses tiered resolution: if `@playwright/test` is importable (local install),
it uses that. If the config specifies `runners.playwright = 'docker'`, it routes through
the Docker adapter. If neither is available, it returns a descriptive error.

Screenshots and evidence files are always saved to `.specguard/evidence/<spec-key>/`.

## Acceptance Criteria

- `isPlaywrightAvailable()` returns `true` when `@playwright/test` can be dynamically imported, `false` otherwise. Never throws.
- `launchBrowser(opts)` launches a headless Chromium instance and returns a `BrowserHandle`.
- `closeBrowser(handle)` closes the browser gracefully.
- `navigateTo(handle, url)` navigates to the URL, waits for network idle, and returns a `PageSnapshot`.
- `takeScreenshot(handle, label, evidenceDir)` takes a screenshot and saves it to `evidenceDir/<label>.png`, returning the file path.
- `getAccessibilitySnapshot(handle)` returns the page's accessibility tree as a compact string for LLM consumption.
- All functions that require `@playwright/test` return a `PlaywrightUnavailableError` when the package is not installed.
- The adapter is testable via `playwrightRunner` seam for unit tests without a real browser.

## Scenarios

### Scenario 1: Playwright available — navigate and snapshot
**Steps:**
1. `isPlaywrightAvailable()` returns true
2. `launchBrowser()` succeeds
3. `navigateTo(handle, 'http://localhost:3000')` is called

**Expected Results:**
- Returns `PageSnapshot { url, title, statusCode, consoleErrors }`

### Scenario 2: Playwright not installed
**Steps:**
1. `@playwright/test` is not installed
2. Call `launchBrowser()`

**Expected Results:**
- Returns `PlaywrightUnavailableError` with install instructions

### Scenario 3: Screenshot saved to evidence dir
**Steps:**
1. `takeScreenshot(handle, 'homepage', '/tmp/evidence')`

**Expected Results:**
- File written to `/tmp/evidence/homepage.png`
- Returns absolute path to file

## Security Notes

- Screenshot files may contain sensitive page content — treat evidence dir as confidential.
- Never include page credentials or auth tokens in screenshot filenames.

## Dependencies

- `@playwright/test` (optional peer dependency)
- `src/adapters/docker.ts` (for Docker mode)
- `src/core/writer.ts`
