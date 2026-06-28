import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  playwrightRunner,
  isPlaywrightAvailable,
  launchBrowser,
  closeBrowser,
  navigateTo,
  takeScreenshot,
  getAccessibilitySnapshot,
  PlaywrightUnavailableError,
} from '../../src/adapters/playwright.js';

let evidenceDir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-pw-'));
});

// ---------------------------------------------------------------------------
// Helpers to build minimal page / browser mocks
// ---------------------------------------------------------------------------

function makePage(overrides: Record<string, unknown> = {}) {
  const consoleListeners: Array<(msg: unknown) => void> = [];
  return {
    goto: vi.fn(async () => ({ status: () => 200 })),
    title: vi.fn(async () => 'Test Page'),
    url: vi.fn(() => 'http://localhost:3000/'),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
    accessibility: { snapshot: vi.fn(async () => ({ role: 'WebArea', name: 'Test' })) },
    on: vi.fn((ev: string, cb: (msg: unknown) => void) => {
      if (ev === 'console') consoleListeners.push(cb);
    }),
    _emit: (msg: unknown) => consoleListeners.forEach((l) => l(msg)),
    ...overrides,
  };
}

function makeHandle(pageOverrides: Record<string, unknown> = {}) {
  const page = makePage(pageOverrides);
  return {
    _browser: { close: vi.fn(async () => {}) },
    _page: page,
    _consoleErrors: [] as string[],
  };
}

function mockPw(page = makePage()) {
  const newPage = vi.fn(async () => page);
  const newContext = vi.fn(async () => ({ newPage }));
  const launch = vi.fn(async () => ({ newContext, close: vi.fn(async () => {}) }));
  vi.spyOn(playwrightRunner, 'tryImport').mockResolvedValue({
    chromium: { launch },
  });
  return { launch, newContext, newPage, page };
}

// ---------------------------------------------------------------------------
// isPlaywrightAvailable
// ---------------------------------------------------------------------------

describe('isPlaywrightAvailable', () => {
  it('returns true when @playwright/test can be imported', async () => {
    vi.spyOn(playwrightRunner, 'tryImport').mockResolvedValue({ chromium: {} });
    expect(await isPlaywrightAvailable()).toBe(true);
  });

  it('returns false when import fails', async () => {
    vi.spyOn(playwrightRunner, 'tryImport').mockResolvedValue(null);
    expect(await isPlaywrightAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// launchBrowser
// ---------------------------------------------------------------------------

describe('launchBrowser', () => {
  it('scenario 1: launches headless Chromium and returns a handle', async () => {
    const { launch } = mockPw();
    const handle = await launchBrowser();
    expect(launch).toHaveBeenCalledWith({ headless: true });
    expect(handle._browser).toBeDefined();
    expect(handle._page).toBeDefined();
    expect(Array.isArray(handle._consoleErrors)).toBe(true);
  });

  it('scenario 2: throws PlaywrightUnavailableError when not installed', async () => {
    vi.spyOn(playwrightRunner, 'tryImport').mockResolvedValue(null);
    await expect(launchBrowser()).rejects.toBeInstanceOf(PlaywrightUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// closeBrowser
// ---------------------------------------------------------------------------

describe('closeBrowser', () => {
  it('calls browser.close()', async () => {
    const handle = makeHandle();
    await closeBrowser(handle);
    expect((handle._browser as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it('does not throw when close() throws', async () => {
    const handle = makeHandle();
    (handle._browser as { close: ReturnType<typeof vi.fn> }).close.mockRejectedValue(
      new Error('already closed'),
    );
    await expect(closeBrowser(handle)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// navigateTo
// ---------------------------------------------------------------------------

describe('navigateTo', () => {
  it('scenario 1: returns PageSnapshot with url, title, statusCode', async () => {
    const handle = makeHandle();
    const snapshot = await navigateTo(handle, 'http://localhost:3000');
    expect(snapshot.url).toBe('http://localhost:3000/');
    expect(snapshot.title).toBe('Test Page');
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.consoleErrors).toEqual([]);
  });

  it('captures console errors from the page', async () => {
    const page = makePage();
    const handle = makeHandle();
    // Simulate a console error arriving during navigation.
    handle._consoleErrors.push('Failed to load resource');
    const snapshot = await navigateTo(handle, 'http://localhost:3000');
    expect(snapshot.consoleErrors).toContain('Failed to load resource');
  });
});

// ---------------------------------------------------------------------------
// takeScreenshot
// ---------------------------------------------------------------------------

describe('takeScreenshot', () => {
  it('scenario 3: saves screenshot and returns file path', async () => {
    const handle = makeHandle();
    const filePath = await takeScreenshot(handle, 'homepage', evidenceDir);
    expect(filePath).toMatch(/homepage\.png$/);
    expect(filePath.startsWith(evidenceDir)).toBe(true);
  });

  it('sanitises label for filename', async () => {
    const handle = makeHandle();
    const filePath = await takeScreenshot(handle, 'Step 1: Login!', evidenceDir);
    expect(filePath).not.toContain(':');
    expect(filePath).not.toContain(' ');
  });
});

// ---------------------------------------------------------------------------
// getAccessibilitySnapshot
// ---------------------------------------------------------------------------

describe('getAccessibilitySnapshot', () => {
  it('returns JSON string of accessibility tree', async () => {
    const handle = makeHandle();
    const result = await getAccessibilitySnapshot(handle);
    expect(result).toContain('WebArea');
  });

  it('returns empty string when accessibility API missing', async () => {
    const handle = makeHandle({ accessibility: undefined });
    const result = await getAccessibilitySnapshot(handle);
    expect(result).toBe('');
  });
});
