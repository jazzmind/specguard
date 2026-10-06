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
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ensureDir } from '../core/writer.js';
import { isDockerAvailable, startContainer, stopContainer } from './docker.js';
import type { Redactor } from '../core/redact.js';

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
  /** This handle's browser context (one per auth profile). */
  _context?: unknown;
  /** True when closing this handle should close the whole browser. */
  _ownsBrowser?: boolean;
  /** Docker container running the Playwright server, when `runner` is docker. */
  _container?: { id: string };
  /** Rewrites a URL so the remote browser can reach it (localhost to host.docker.internal). */
  _rewriteUrl?: (url: string) => string;
}

/** Options for launching a browser. */
export interface BrowserOpts {
  /** Run headless. Default: true. */
  headless?: boolean;
  /** Viewport width in pixels. Default: 1280. */
  width?: number;
  /** Viewport height in pixels. Default: 720. */
  height?: number;
  /** `docker` runs the browser in a Playwright container (runners.playwright). Default `local`. */
  runner?: 'local' | 'docker';
  /** Image for the docker runner. Default: the official image matching the installed Playwright. */
  dockerImage?: string;
}

/** Per-context options: a saved login, or headers every request carries. */
export interface ContextOpts {
  /** Path to a Playwright storage-state file. */
  storageState?: string;
  extraHTTPHeaders?: Record<string, string>;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Runner seam
// ---------------------------------------------------------------------------

/**
 * Playwright runner seam. All internal calls route through this object so
 * tests can stub methods with vi.spyOn without a real browser.
 */
export const playwrightRunner: {
  tryImport(): Promise<{ chromium: unknown } | null>;
  version(): string | undefined;
  freePort(): Promise<number>;
  sleep(ms: number): Promise<void>;
} = {
  version: () => undefined,
  freePort: async () => 0,
  sleep: async () => undefined,
  async tryImport(): Promise<{ chromium: unknown } | null> {
    try {
      // Dynamic import via Function constructor avoids TypeScript resolving the
      // optional peer dep at compile time. This is intentional.
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

/** Installed Playwright version, or undefined. Seam for tests. */
playwrightRunner.version = function version(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return (require('@playwright/test/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
};

/** A free TCP port on 127.0.0.1. Seam for tests. */
playwrightRunner.freePort = function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

/** Sleep seam: tests replace it to avoid waiting. */
playwrightRunner.sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The URL as a browser inside a container must reach it: localhost means the host, not the container. */
export function containerUrl(url: string): string {
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i, '$1host.docker.internal');
}

async function newPage(
  browser: unknown,
  ctxOpts: ContextOpts,
): Promise<{ context: unknown; page: unknown; consoleErrors: string[] }> {
  const context = await (browser as { newContext: (o: unknown) => Promise<unknown> }).newContext({
    viewport: { width: ctxOpts.width ?? 1280, height: ctxOpts.height ?? 720 },
    ...(ctxOpts.storageState ? { storageState: ctxOpts.storageState } : {}),
    ...(ctxOpts.extraHTTPHeaders ? { extraHTTPHeaders: ctxOpts.extraHTTPHeaders } : {}),
  });
  const page = await (context as { newPage: () => Promise<unknown> }).newPage();
  const consoleErrors: string[] = [];
  (page as { on: (ev: string, cb: (msg: unknown) => void) => void }).on('console', (msg) => {
    const m = msg as { type: () => string; text: () => string };
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  return { context, page, consoleErrors };
}

/** Start the Playwright server in a container and connect to it. */
async function connectDocker(
  chromium: { connect?: (ws: string) => Promise<unknown> },
  opts: BrowserOpts,
): Promise<{ browser: unknown; container: { id: string } }> {
  if (!chromium.connect) throw new Error('This Playwright version cannot connect to a remote browser server.');
  if (!(await isDockerAvailable())) {
    throw new Error('runners.playwright is "docker" but Docker is not available. Start Docker or set runners.playwright to "local".');
  }
  const version = playwrightRunner.version();
  const image = opts.dockerImage ?? `mcr.microsoft.com/playwright:v${version ?? 'latest'}-noble`;
  const [name, ...tagParts] = image.split(':');
  const hostPort = await playwrightRunner.freePort();
  const started = await startContainer({
    image: name,
    tag: tagParts.join(':') || 'latest',
    ports: [{ host: hostPort, container: 3000 }],
    addHostGateway: true,
    args: ['npx', '-y', `playwright@${version ?? 'latest'}`, 'run-server', '--port', '3000', '--host', '0.0.0.0'],
  });
  if (!started.ok || !started.id) {
    throw new Error(`Could not start the Playwright container ${image}: ${started.stderr.trim() || 'docker run failed'}`);
  }
  const container = { id: started.id };
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const browser = await chromium.connect(`ws://127.0.0.1:${hostPort}/`);
      return { browser, container };
    } catch (err) {
      lastError = err;
      await playwrightRunner.sleep(1000);
    }
  }
  await stopContainer(container.id);
  throw new Error(`The Playwright container did not accept connections: ${(lastError as Error)?.message ?? 'timeout'}`);
}

/**
 * Launch Chromium and return a handle with its first context and page.
 * `runner: 'docker'` runs the browser in a Playwright container instead.
 * Throws `PlaywrightUnavailableError` when @playwright/test is not installed.
 */
export async function launchBrowser(opts: BrowserOpts = {}): Promise<BrowserHandle> {
  const pw = await playwrightRunner.tryImport();
  if (!pw) throw new PlaywrightUnavailableError();

  const { headless = true } = opts;

  // Type the chromium launcher narrowly via unknown to avoid hard dep.
  const chromium = (pw as { chromium: { launch: (o: unknown) => Promise<unknown>; connect?: (ws: string) => Promise<unknown> } }).chromium;
  let browser: unknown;
  let container: { id: string } | undefined;
  if (opts.runner === 'docker') {
    ({ browser, container } = await connectDocker(chromium, opts));
  } else {
    browser = await chromium.launch({ headless });
  }

  const { context, page, consoleErrors } = await newPage(browser, { width: opts.width, height: opts.height });
  return {
    _browser: browser,
    _page: page,
    _context: context,
    _consoleErrors: consoleErrors,
    _ownsBrowser: true,
    ...(container ? { _container: container, _rewriteUrl: containerUrl } : {}),
  };
}

/**
 * Open another context (and page) on the same browser. Each auth profile gets
 * its own, so one login never leaks into another. Closing the returned handle
 * closes only that context.
 */
export async function openSession(handle: BrowserHandle, ctxOpts: ContextOpts = {}): Promise<BrowserHandle> {
  const { context, page, consoleErrors } = await newPage(handle._browser, ctxOpts);
  return {
    _browser: handle._browser,
    _page: page,
    _context: context,
    _consoleErrors: consoleErrors,
    _ownsBrowser: false,
    _rewriteUrl: handle._rewriteUrl,
  };
}

/** Save the context's cookies and local storage so a later run can skip the login. */
export async function saveStorageState(handle: BrowserHandle, file: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const ctx = handle._context as { storageState?: (o: { path: string }) => Promise<unknown> } | undefined;
  if (!ctx?.storageState) throw new Error('This browser context cannot save its state.');
  await ctx.storageState({ path: file });
}

/**
 * Close the handle. A session closes only its context; the handle that launched
 * the browser closes the browser (and a Docker container, if any).
 */
export async function closeBrowser(handle: BrowserHandle): Promise<void> {
  try {
    if (handle._ownsBrowser === false) {
      await (handle._context as { close: () => Promise<void> }).close();
    } else {
      await (handle._browser as { close: () => Promise<void> }).close();
    }
  } catch {
    // Best-effort cleanup — never throw.
  }
  if (handle._container) await stopContainer(handle._container.id);
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
    const target = handle._rewriteUrl ? handle._rewriteUrl(url) : url;
    const response = await page.goto(target, { waitUntil: 'networkidle', timeout: 30_000 });
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
  opts: { maskSelectors?: string[] } = {},
): Promise<string> {
  await ensureDir(evidenceDir);
  const filename = `${label.replace(/[^a-z0-9_-]/gi, '_')}.png`;
  const filePath = path.join(evidenceDir, filename);

  const page = handle._page as {
    screenshot: (opts: unknown) => Promise<Buffer>;
    locator?: (selector: string) => unknown;
  };

  // Blank-selector elements are painted over in the image itself (Playwright `mask`),
  // so the file on disk and the image sent to the LLM never show them.
  const mask = page.locator ? (opts.maskSelectors ?? []).map((selector) => page.locator!(selector)) : [];
  const buffer = await page.screenshot({
    path: filePath,
    fullPage: false,
    ...(mask.length > 0 ? { mask, maskColor: '#000000' } : {}),
  });

  // writeFile from writer expects string content — use Node fs directly for binary.
  const { writeFile: fsWriteFile } = await import('node:fs/promises');
  await fsWriteFile(filePath, buffer);

  return filePath;
}

/**
 * Extract the accessibility tree as a compact string for LLM consumption.
 *
 * Primary: `page.locator('body').ariaSnapshot()` — returns a YAML-like string
 * (introduced in Playwright ~1.39, replaces the removed `page.accessibility` API).
 * Fallback: legacy `page.accessibility.snapshot()` for older Playwright versions.
 *
 * Returns an empty string when neither API is available or both fail.
 */
export async function getAccessibilitySnapshot(
  handle: BrowserHandle,
  redactor?: Redactor,
): Promise<string> {
  const raw = await withBlanked(handle, redactor?.blankSelectors ?? [], () => readAccessibilitySnapshot(handle));
  return redactor ? redactor.text(raw, 'a11y') : raw;
}

async function readAccessibilitySnapshot(handle: BrowserHandle): Promise<string> {
  const page = handle._page as {
    locator?: (selector: string) => { ariaSnapshot: () => Promise<string> };
    accessibility?: { snapshot: () => Promise<unknown> };
  };

  // Primary: modern ariaSnapshot() API.
  if (page.locator) {
    try {
      const snapshot = await page.locator('body').ariaSnapshot();
      if (snapshot) return snapshot;
    } catch {
      // ariaSnapshot not available — fall through to legacy path.
    }
  }

  // Legacy fallback: page.accessibility.snapshot() (removed in modern Playwright).
  try {
    if (!page.accessibility) return '';
    const snapshot = await page.accessibility.snapshot();
    if (!snapshot) return '';
    return JSON.stringify(snapshot, null, 2);
  } catch {
    return '';
  }
}

/**
 * Retrieve the full outer HTML of the current page, truncated to `maxChars`.
 * Useful for DOM-level analysis by the LLM (missing labels, wrong semantics,
 * incorrect ARIA attributes).
 * Returns an empty string when the page cannot be serialised.
 */
export async function getPageHtml(
  handle: BrowserHandle,
  maxChars = 40_000,
  redactor?: Redactor,
): Promise<string> {
  const page = handle._page as {
    content?: () => Promise<string>;
  };
  try {
    if (!page.content) return '';
    const html = await withBlanked(handle, redactor?.blankSelectors ?? [], () => page.content!());
    const masked = redactor ? redactor.text(html, 'dom') : html;
    return masked.length > maxChars ? masked.slice(0, maxChars) + '\n<!-- truncated -->' : masked;
  } catch {
    return '';
  }
}

// Page scripts are strings: this package has no DOM typings, and they run in the browser.
const BLANK_SCRIPT = `(sels) => {
  const saved = [];
  for (const sel of sels) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
    nodes.forEach((el) => {
      if (typeof el.value === 'string' && el.value) { saved.push([el, 'value', el.value]); el.value = '[REDACTED]'; }
      saved.push([el, 'html', el.innerHTML]);
      if (!('value' in el)) el.textContent = '[REDACTED]';
    });
  }
  window.__sgSaved = saved;
}`;

const RESTORE_SCRIPT = `() => {
  for (const [el, kind, value] of (window.__sgSaved || [])) {
    if (kind === 'value') el.value = value; else el.innerHTML = value;
  }
  window.__sgSaved = [];
}`;

/**
 * Blank the elements matching `selectors` (text and form values), run `fn`, then put
 * everything back, so the page the next action sees is unchanged.
 */
export async function withBlanked<T>(handle: BrowserHandle, selectors: string[], fn: () => Promise<T>): Promise<T> {
  const page = handle._page as { evaluate?: (fn: unknown, arg?: unknown) => Promise<unknown> };
  if (selectors.length === 0 || !page.evaluate) return fn();
  await page.evaluate(BLANK_SCRIPT, selectors);
  try {
    return await fn();
  } finally {
    await page.evaluate(RESTORE_SCRIPT);
  }
}


/**
 * What the guardrails need to know about the element an action will touch: its
 * role, accessible name, tag and input type. Returns null when the selector
 * matches nothing or the page cannot be inspected.
 */
export async function inspectTarget(
  handle: BrowserHandle,
  selector: string,
): Promise<{ role?: string; name?: string; tag?: string; type?: string } | null> {
  const page = handle._page as { evaluate?: (fn: unknown, arg?: unknown) => Promise<unknown> };
  if (!page.evaluate) return null;
  try {
    const found = await page.evaluate(INSPECT_SCRIPT, selector);
    return (found as { role?: string; name?: string; tag?: string; type?: string } | null) ?? null;
  } catch {
    return null;
  }
}

const INSPECT_SCRIPT = `(sel) => {
  let el;
  try { el = document.querySelector(sel); } catch (e) { return null; }
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const implicit = { a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button' };
  let role = el.getAttribute('role') || implicit[tag] || '';
  if (tag === 'input') {
    if (['submit', 'button', 'reset', 'image'].includes(type)) role = 'button';
    else if (['checkbox'].includes(type)) role = 'checkbox';
    else if (['radio'].includes(type)) role = 'radio';
    else role = 'textbox';
  }
  const labelled = el.getAttribute('aria-labelledby');
  const byIds = labelled ? labelled.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ') : '';
  const label = el.labels && el.labels[0] ? el.labels[0].textContent : '';
  const name = (el.getAttribute('aria-label') || byIds || label || (tag === 'input' ? el.value : '') || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  return { role, name, tag, type };
}`;
