---
title: "Playwright Adapter"
sidebar_label: "Playwright Adapter"
description: "The Playwright adapter wraps browser automation behind a typed interface, handling browser lifecycle, navigation, screenshots, and accessibility snapshots for the validate and heal pipelines."
category: "adapters"
order: 20
generated: true
---

# Playwright Adapter

The Playwright adapter gives SpecGuard's validate and heal pipelines a consistent, typed interface for browser automation. Under the hood it delegates to [`@playwright/test`](https://playwright.dev/), but you don't need to interact with Playwright directly — the adapter manages the full browser lifecycle, page navigation, screenshot capture, and accessibility snapshot extraction on your behalf.

---

## How the adapter resolves Playwright

The adapter uses a three-tier resolution strategy so it works across different environments without manual configuration:

1. **Local install** — if `@playwright/test` is importable from your project, the adapter uses it directly.
2. **Docker mode** — if your config sets `runners.playwright = 'docker'`, the adapter routes all browser work through the Docker adapter instead.
3. **Unavailable** — if neither option is available, every browser function returns a descriptive `PlaywrightUnavailableError` rather than throwing an unhandled exception, so failures are always explicit and actionable.

You can check availability programmatically at any time:

```ts
import { isPlaywrightAvailable } from '@specguard/adapters/playwright';

if (!isPlaywrightAvailable()) {
  console.warn('Playwright is not installed. Install @playwright/test or set runners.playwright = "docker".');
}
```

`isPlaywrightAvailable()` returns `true` or `false` and never throws.

---

## Core capabilities

### Launching and closing a browser

```ts
const handle = await launchBrowser({ headless: true });
// ... do work ...
await closeBrowser(handle);
```

`launchBrowser(opts)` starts a headless Chromium instance and returns a `BrowserHandle` that you pass to every subsequent call. `closeBrowser(handle)` shuts it down gracefully.

---

### Navigating to a page

```ts
const snapshot = await navigateTo(handle, 'https://example.com');
```

`navigateTo(handle, url)` loads the given URL, waits for network idle, and returns a `PageSnapshot` representing the settled state of the page. This snapshot is what the validate and heal pipelines inspect.

---

### Taking a screenshot

```ts
const filePath = await takeScreenshot(handle, 'homepage-hero', evidenceDir);
// → .specguard/evidence/<spec-key>/homepage-hero.png
```

`takeScreenshot(handle, label, evidenceDir)` captures the current viewport and saves it to `evidenceDir/<label>.png`, returning the full file path. All evidence files are stored under `.specguard/evidence/<spec-key>/` by default.

---

### Extracting an accessibility snapshot

```ts
const a11yTree = await getAccessibilitySnapshot(handle);
```

`getAccessibilitySnapshot(handle)` returns the page's accessibility tree as a compact string optimised for LLM consumption. The validate pipeline uses this alongside screenshots to reason about page structure without relying solely on visual information.

---

## Evidence storage

Every screenshot and evidence file produced by the adapter is written to:

```
.specguard/evidence/<spec-key>/
```

This directory is created automatically. You can commit it to version control to track visual history, or add it to `.gitignore` if you prefer to treat evidence as ephemeral build artefacts.

---

## Error handling

If `@playwright/test` is not installed and Docker mode is not configured, any function that requires a real browser returns a `PlaywrightUnavailableError`. This is a typed error value — not an exception — so your pipeline code can handle it with a normal conditional check rather than a `try/catch`.

---

## Installation

Install `@playwright/test` as a dev dependency in your project:

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

Or, to use Docker mode instead, set the following in your SpecGuard config:

```ts
// specguard.config.ts
export default {
  runners: {
    playwright: 'docker',
  },
};
```

---

## Dependencies

| Package | Role |
|---|---|
| `@playwright/test` | Optional peer dependency — provides the browser engine |
| Docker adapter | Used when `runners.playwright = 'docker'` |
| `src/core/writer.ts` | Handles writing evidence files to disk |
