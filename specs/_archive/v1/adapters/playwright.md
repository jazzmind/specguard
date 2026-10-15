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
- `getAccessibilitySnapshot(handle)` uses `page.locator('body').ariaSnapshot()` (modern Playwright ≥1.39) and falls back to the legacy `page.accessibility.snapshot()` for older versions. Returns an empty string when neither is available.
- `getPageHtml(handle, maxChars?)` returns the full outer HTML of the current page, truncated to `maxChars` (default 40 000). Returns an empty string on failure.
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

### Scenario 4: Accessibility snapshot — modern Playwright
**Steps:**
1. `getAccessibilitySnapshot(handle)` is called on a page with a `locator` API
2. `page.locator('body').ariaSnapshot()` returns a YAML-like string

**Expected Results:**
- Returns the YAML aria snapshot string (not JSON)
- Does not call `page.accessibility.snapshot()`

### Scenario 5: Accessibility snapshot — legacy fallback
**Steps:**
1. Page does not expose `locator` (old Playwright) or `ariaSnapshot` throws
2. `getAccessibilitySnapshot(handle)` is called

**Expected Results:**
- Falls back to `page.accessibility.snapshot()` and returns the JSON stringified tree
- Returns empty string if both paths fail

### Scenario 6: Page HTML capture
**Steps:**
1. `getPageHtml(handle)` is called
2. `page.content()` returns the full HTML

**Expected Results:**
- Returns HTML string
- If HTML exceeds `maxChars`, appends `<!-- truncated -->` and does not exceed the limit

## Security Notes

- Screenshot files may contain sensitive page content — treat evidence dir as confidential.
- Never include page credentials or auth tokens in screenshot filenames.

## Dependencies

- `@playwright/test` (optional peer dependency)
- `src/adapters/docker.ts` (for Docker mode)
- `src/core/writer.ts`
