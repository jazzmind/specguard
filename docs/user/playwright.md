---
title: "Playwright Adapter"
sidebar_label: "Playwright Adapter"
generated: true
---

# Playwright Adapter

The Playwright adapter connects SpecGuard's validate and heal pipelines to a real browser, handling everything from launching Chromium to capturing screenshots and accessibility snapshots. It wraps `@playwright/test` behind a consistent interface so the rest of SpecGuard doesn't need to know the details of browser automation.

---

## How the adapter resolves a browser

The adapter uses a tiered approach to find a working browser environment:

1. **Local install** — If `@playwright/test` is installed in your project, the adapter uses it directly.
2. **Docker mode** — If your config sets `runners.playwright = 'docker'`, the adapter routes browser work through the Docker adapter instead.
3. **Neither available** — If neither option is usable, the adapter returns a clear, descriptive error rather than crashing silently.

You can check at any time whether Playwright is available in your environment — the `isPlaywrightAvailable()` function returns `true` or `false` and never throws, making it safe to call during startup or health checks.

---

## What the adapter does

### Launching and closing a browser

Call `launchBrowser(opts)` to start a headless Chromium instance. It returns a `BrowserHandle` that you pass to all subsequent calls. When you're done, call `closeBrowser(handle)` to shut the browser down gracefully.

### Navigating to a page

`navigateTo(handle, url)` loads the given URL and waits for network activity to settle before returning. You get back a `PageSnapshot` representing the loaded page state, ready for validation or healing steps.

### Taking screenshots

`takeScreenshot(handle, label, evidenceDir)` captures the current page and saves it as `<label>.png` inside the directory you specify. The function returns the full file path to the saved image.

All screenshots and evidence files produced during a run are saved under `.specguard/evidence/<spec-key>/` by default, keeping your evidence organized by spec.

### Extracting an accessibility snapshot

`getAccessibilitySnapshot(handle)` reads the page's accessibility tree and returns it as a compact string. This format is designed for efficient consumption by the LLM components in the validate and heal pipelines.

---

## When Playwright isn't installed

Any function that needs `@playwright/test` will return a `PlaywrightUnavailableError` if the package isn't installed, rather than throwing an unexpected exception. This lets calling code handle the missing dependency gracefully and surface a helpful message to you.

---

## Dependencies

| Dependency | Role |
|---|---|
| `@playwright/test` | Optional peer dependency — provides the browser automation engine |
| Docker adapter (`src/adapters/docker.ts`) | Used when Docker mode is configured |
| Writer (`src/core/writer.ts`) | Handles saving screenshots and evidence files to disk |
