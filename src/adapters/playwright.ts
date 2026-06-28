/**
 * Playwright adapter.
 *
 * Wraps @playwright/test behind a typed interface used by the validate and
 * heal pipelines. Handles browser lifecycle, navigation, screenshots, and
 * accessibility snapshots. Uses tiered resolution: local @playwright/test
 * first, Docker fallback if config requests it.
 *
 * @playwright/test is an OPTIONAL peer dependency. All functions check for
 * availability and return PlaywrightUnavailableError when not installed.
 *
 * Spec: specs/adapters/playwright.md
 *
 * Testability seam
 * ----------------
 * The `playwrightRunner` export allows unit tests to stub browser interactions
 * without launching a real browser.
 */
import path from 'node:path';
import { ensureDir, writeFile } from '../core/writer.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PlaywrightUnavailableError extends Error {
  constructor() {
    super(
      '@playwright/test is not installed. ' +
        'Run: npm install --save-dev @playwright/test && npx playwright install chromium\n' +
        'Or set runners.playwright = "docker" in .specguard/config.json',
    );
    this.name = 'PlaywrightUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of the current page state captured during navigation. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** HTTP status of the final navigation response (0 if not captured). */
  statusCode: number;
  /** Console error messages collected during navigation. */
  consoleErrors: string[];
}

/** Handle returned by `launchBrowser`, passed to all subsequent calls. */
export interface BrowserHandle {
  /** Internal browser instance (typed as unknown to avoid hard @playwright/test dep). */
  _browser: unknown;
  /** Internal page instance. */
  _page: unknown;
  /** Console errors collected since launch. */
  _consoleErrors: string[];
}

/** Options for launching a browser. */
export interface BrowserOpts {
  /** Run headless. Default: true. */
  headless?: boolean;
  /** Viewport width in pixels. Default: 1280. */
  width?: number;
  /** Viewport height in pixels. Default: 720. */
  height?: number;
}

// ---------------------------------------------------------------------------
// Runner seam
// ---------------------------------------------------------------------------

/**
 * Playwright runner seam. All internal calls route through this object so
 * tests can stub methods with vi.spyOn without a real browser.
 */
export const playwrightRunner = {
  async tryImport(): Promise<{ chromium: unknown } | null> {
    try {
      // Dynamic import via Function constructor avoids TypeScript resolving the
      // optional peer dep at compile time. This is intentional.
      // eslint-disable-next-line no-new-func
      const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
      const pw = await dynamicImport('@playwright/test');
      return pw as { chromium: unknown };
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether @playwright/test is available. Never throws.
 */
export async function isPlaywrightAvailable(): Promise<boolean> {
  const pw = await playwrightRunner.tryImport();
  return pw !== null;
}

/**
 * Launch a headless Chromium browser and return a handle.
 * Throws `PlaywrightUnavailableError` when @playwright/test is not installed.
 */
export async function launchBrowser(opts: BrowserOpts = {}): Promise<BrowserHandle> {
  const pw = await playwrightRunner.tryImport();
  if (!pw) throw new PlaywrightUnavailableError();

  const { headless = true, width = 1280, height = 720 } = opts;

  // Type the chromium launcher narrowly via unknown to avoid hard dep.
  const chromium = (pw as { chromium: { launch: (o: unknown) => Promise<unknown> } }).chromium;
  const browser = await chromium.launch({ headless });

  const ctx = await (
    browser as { newContext: (o: unknown) => Promise<unknown> }
  ).newContext({ viewport: { width, height } });

  const page = await (ctx as { newPage: () => Promise<unknown> }).newPage();
  const consoleErrors: string[] = [];

  (page as { on: (ev: string, cb: (msg: unknown) => void) => void }).on('console', (msg) => {
    const m = msg as { type: () => string; text: () => string };
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  return { _browser: browser, _page: page, _consoleErrors: consoleErrors };
}

/**
 * Close the browser and release resources.
 */
export async function closeBrowser(handle: BrowserHandle): Promise<void> {
  try {
    await (handle._browser as { close: () => Promise<void> }).close();
  } catch {
    // Best-effort cleanup — never throw.
  }
}

/**
 * Navigate to a URL and return a page snapshot.
 */
export async function navigateTo(handle: BrowserHandle, url: string): Promise<PageSnapshot> {
  const page = handle._page as {
    goto: (
      url: string,
      opts: unknown,
    ) => Promise<{ status: () => number } | null>;
    title: () => Promise<string>;
    url: () => string;
  };

  let statusCode = 0;
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    if (response) statusCode = response.status();
  } catch (err) {
    // Navigation timeout or network error — capture but don't throw.
    handle._consoleErrors.push(`navigation error: ${(err as Error).message}`);
  }

  const title = await page.title();
  const currentUrl = page.url();

  return {
    url: currentUrl,
    title,
    statusCode,
    consoleErrors: [...(handle._consoleErrors as string[])],
  };
}

/**
 * Take a screenshot of the current page and save it to `evidenceDir`.
 * Returns the absolute path to the saved file.
 */
export async function takeScreenshot(
  handle: BrowserHandle,
  label: string,
  evidenceDir: string,
): Promise<string> {
  await ensureDir(evidenceDir);
  const filename = `${label.replace(/[^a-z0-9_-]/gi, '_')}.png`;
  const filePath = path.join(evidenceDir, filename);

  const page = handle._page as {
    screenshot: (opts: unknown) => Promise<Buffer>;
  };

  const buffer = await page.screenshot({ path: filePath, fullPage: false });

  // writeFile from writer expects string content — use Node fs directly for binary.
  const { writeFile: fsWriteFile } = await import('node:fs/promises');
  await fsWriteFile(filePath, buffer);

  return filePath;
}

/**
 * Extract the accessibility tree as a compact string for LLM consumption.
 * Returns an empty string when the tree cannot be extracted.
 */
export async function getAccessibilitySnapshot(handle: BrowserHandle): Promise<string> {
  const page = handle._page as {
    accessibility?: {
      snapshot: () => Promise<unknown>;
    };
  };

  try {
    if (!page.accessibility) return '';
    const snapshot = await page.accessibility.snapshot();
    if (!snapshot) return '';
    return JSON.stringify(snapshot, null, 2);
  } catch {
    return '';
  }
}
