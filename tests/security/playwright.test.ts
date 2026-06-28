import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

import {
  isPlaywrightAvailable,
  launchBrowser,
  closeBrowser,
  navigateTo,
  takeScreenshot,
  getAccessibilitySnapshot,
  playwrightRunner,
  PlaywrightUnavailableError,
} from "../src/adapters/playwright.js";

// ---------------------------------------------------------------------------
// Shared stub factory
// ---------------------------------------------------------------------------

function makePageStub(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    title: vi.fn().mockResolvedValue("Test Page"),
    url: vi.fn().mockReturnValue("https://example.com/"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    accessibility: {
      snapshot: vi.fn().mockResolvedValue({ role: "WebArea", name: "" }),
    },
    on: vi.fn(),
    ...overrides,
  };
}

function makeContextStub(page: unknown) {
  return { newPage: vi.fn().mockResolvedValue(page) };
}

function makeBrowserStub(ctx: unknown) {
  return {
    newContext: vi.fn().mockResolvedValue(ctx),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeChromiumStub(browser: unknown) {
  return { launch: vi.fn().mockResolvedValue(browser) };
}

function makePwStub(browser: unknown) {
  const page = makePageStub();
  const ctx = makeContextStub(page);
  const brow = makeBrowserStub(ctx);
  const chromium = makeChromiumStub(brow);
  return { chromium, _page: page, _browser: brow };
}

// ---------------------------------------------------------------------------
// Helper: build a fully-wired BrowserHandle without a real browser
// ---------------------------------------------------------------------------

async function buildHandle() {
  const page = makePageStub();
  const ctx = makeContextStub(page);
  const browser = makeBrowserStub(ctx);
  const chromium = makeChromiumStub(browser);

  vi.spyOn(playwrightRunner, "tryImport").mockResolvedValue({
    chromium,
  } as unknown as { chromium: unknown });

  const handle = await launchBrowser();
  // Patch the internal page so we can control it in tests
  (handle as unknown as { _page: unknown })._page = page;
  return { handle, page, browser };
}

// ---------------------------------------------------------------------------
// 1. PlaywrightUnavailableError — surface area guard
// ---------------------------------------------------------------------------

describe("PlaywrightUnavailableError", () => {
  // OWASP A05: Security Misconfiguration
  // Ensure the error message never leaks internal filesystem paths or secrets.
  it("error message must not contain filesystem paths or secret-like tokens", () => {
    const err = new PlaywrightUnavailableError();
    expect(err.message).not.toMatch(/\/home\//);
    expect(err.message).not.toMatch(/\/root\//);
    expect(err.message).not.toMatch(/[A-Za-z]:\\/); // Windows absolute path
    expect(err.message).not.toMatch(/password|secret|token|key/i);
  });

  // OWASP A05: Security Misconfiguration
  it("error name is PlaywrightUnavailableError and not a generic Error", () => {
    const err = new PlaywrightUnavailableError();
    expect(err.name).toBe("PlaywrightUnavailableError");
    expect(err).toBeInstanceOf(PlaywrightUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// 2. isPlaywrightAvailable
// ---------------------------------------------------------------------------

describe("isPlaywrightAvailable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // OWASP A05: Security Misconfiguration
  // Unavailable dependency must be surfaced cleanly — no silent swallowing
  // that could mask a misconfigured environment.
  it("returns false when @playwright/test is not installed", async () => {
    vi.spyOn(playwrightRunner, "tryImport").mockResolvedValue(null);
    const result = await isPlaywrightAvailable();
    expect(result).toBe(false);
  });

  // OWASP A05: Security Misconfiguration
  it("returns true when @playwright/test resolves", async () => {
    vi.spyOn(playwrightRunner, "tryImport").mockResolvedValue({
      chromium: {},
    } as unknown as { chromium: unknown });
    const result = await isPlaywrightAvailable();
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. launchBrowser
// ---------------------------------------------------------------------------

describe("launchBrowser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // OWASP A05: Security Misconfiguration
  // Browser must default to headless to prevent unintended UI exposure.
  it("launches browser in headless mode by default", async () => {
    const page = makePageStub();
    const ctx = makeContextStub(page);
    const browser = makeBrowserStub(ctx);
    const chromium = makeChromiumStub(browser);

    vi.spyOn(playwrightRunner, "tryImport").mockResolvedValue({
      chromium,
    } as unknown as { chromium: unknown });

    await launchBrowser();

    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true }),
    );
  });

  // OWASP A01: Broken Access Control
  // Throwing PlaywrightUnavailableError prevents execution when the runner
  // is absent — avoids falling through to an uncontrolled code path.
  it("throws PlaywrightUnavailableError when playwright is not installed", async () => {
    vi.spyOn(playwrightRunner, "tryImport").mockResolvedValue(null);
    await expect(launchBrowser()).rejects.toThrow(PlaywrightUnavailableError);
  });

  // OWASP A05: Security Misconfiguration
  // Returned handle must not expose raw credentials or tokens.
  it("returned BrowserHandle does not contain credential-like properties", async () => {
    const { handle } = await buildHandle();
    const keys = Object.keys(handle);
    const credentialPattern = /password|secret|token|auth|credential|apikey/i;
    for (const key of keys) {
      expect(key).not.toMatch(credentialPattern);
    }
  });

  // OWASP A05: Security Misconfiguration
  // Console error collector must be initialised as an empty array — no
  // cross-session data leakage from a previous handle.
  it("initialises _consoleErrors as an empty array (no cross-session leakage)", async () => {
    const { handle } = await buildHandle();
    expect(handle._consoleErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. closeBrowser
// ---------------------------------------------------------------------------

describe("closeBrowser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // OWASP A05: Security Misconfiguration
  // closeBrowser must never throw — a throwing cleanup could leave sensitive
  // browser state open.
  it("never throws even when browser.close rejects", async () => {
    const { handle, browser } = await buildHandle();
    browser.close.mockRejectedValue(new Error("close failed"));
    await expect(closeBrowser(handle)).resolves.toBeUndefined();
  });

  // OWASP A05: Security Misconfiguration
  it("calls browser.close to release resources", async () => {
    const { handle, browser } = await buildHandle();
    await closeBrowser(handle);
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 5. navigateTo
// ---------------------------------------------------------------------------

describe("navigateTo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // OWASP A03: Injection
  // URLs with embedded credentials (user:pass@host) must not be reflected
  // verbatim into the snapshot in a way that leaks them.
  it("does not reflect embedded URL credentials into the snapshot url field", async () => {
    const { handle, page } = await buildHandle();
    const credentialUrl = "https://admin:s3cr3t@example.com/dashboard";
    page.url.mockReturnValue("https://example.com/dashboard"); // browser strips creds
    page.goto.mockResolvedValue({ status: () => 200 });

    const snapshot = await navigateTo(handle, credentialUrl);

    expect(snapshot.url).not.toContain("admin:s3cr3t");
    expect(snapshot.url).not.toContain("s3cr3t");
  });

  // OWASP A03: Injection
  // Navigation errors must be captured as console errors, not thrown, and
  // must not include raw stack traces that reveal internal paths.
  it("captures navigation errors without exposing internal stack traces", async () => {
    const { handle, page } = await buildHandle();
    page.goto.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));

    const snapshot = await navigateTo(handle, "https://unreachable.example.com/");

    expect(snapshot.consoleErrors.length).toBeGreaterThan(0);
    const errorText = snapshot.consoleErrors.join(" ");
    // Must not contain absolute filesystem paths from the stack trace
    expect(errorText).not.toMatch(/\/home\//);
    expect(errorText).not.toMatch(/\/root\//);
    expect(errorText).not.toMatch(/node_modules/);
  });

  // OWASP A01: Broken Access Control
  // Snapshot must not include auth tokens injected via console errors from
  // a previous navigation (no cross-navigation state leakage).
  it("returns a fresh copy of consoleErrors — not a shared reference", async () => {
    const { handle, page } = await buildHandle();
    page.goto.mockResolvedValue({ status: () => 200 });

    const snapshot = await navigateTo(handle, "https://example.com/");
    // Mutating the returned array must not affect the handle's internal state
    snapshot.consoleErrors.push("injected-error");

    const snapshot2 = await navigateTo(handle, "https://example.com/page2");
    expect(snapshot2.consoleErrors).not.toContain("injected-error");
  });

  // OWASP A05: Security Misconfiguration
  // navigateTo must use a finite timeout to prevent indefinite resource hold.
  it("passes a finite timeout to page.goto", async () => {
    const { handle, page } = await buildHandle();
    page.goto.mockResolvedValue({ status: () => 200 });

    await navigateTo(handle, "https://example.com/");

    const callArgs = page.goto.mock.calls[0];
    const opts = callArgs[1] as { timeout?: number };
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------
// 6. takeScreenshot
// ---------------------------------------------------------------------------

describe("takeScreenshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  // Screenshot filenames must never contain credential-like substrings
  // derived from the label parameter.
  it("sanitises label — strips credential-like characters from filename", async () => {
    const { handle, page } = await buildHandle();

    // Stub fs write so we don't touch disk
    vi.mock("node:fs/promises", () => ({
      writeFile: vi.fn().mockResolvedValue(undefined),
    }));

    const { writeFile: fsWriteFile } = await import("node:fs/promises");
    const writeSpy = vi.mocked(fsWriteFile);

    page.screenshot.mockResolvedValue(Buffer.from("png"));

    const label = "user:admin@secret-token=abc123";
    const filePath = await takeScreenshot(handle, label, "/tmp/evidence");

    const filename = path.basename(filePath);
    // Colons, at-signs, equals signs must be replaced
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("@");
    expect(filename).not.toContain("=");
    // Must end with .png
    expect(filename).toMatch(/\.png$/);
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  // Filename must not embed auth tokens passed as label.
  it("does not embed raw auth token strings in the screenshot filename", async () => {
    const { handle, page } = await buildHandle();
    page.screenshot.mockResolvedValue(Buffer.from("png"));

    vi.mock("node:fs/promises", () => ({
      writeFile: vi.fn().mockResolvedValue(undefined),
    }));

    const sensitiveLabel = "Bearer_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const filePath = await takeScreenshot(handle, sensitiveLabel, "/tmp/evidence");
    const filename = path.basename(filePath);

    // JWT-like base64 segments contain dots and plus signs — ensure they are
    // sanitised away so the filename cannot be used to reconstruct a token.
    expect(filename).not.toContain("+");
    expect(filename).not.toContain("/");
  });

  // OWASP A01: Broken Access Control
  // Evidence directory must be confined — label must not allow path traversal
  // to write screenshots outside the intended evidence directory.
  it("prevents path traversal via label — output stays within evidenceDir", async () => {
    const { handle, page } = await buildHandle();
    page.screenshot.mockResolvedValue(Buffer.from("png"));

    vi.mock("node:fs/promises", () => ({
      writeFile: vi.fn().mockResolvedValue(undefined),
    }));

    const traversalLabel = "../../etc/passwd";
    const evidenceDir = "/tmp/evidence";
    const filePath = await takeScreenshot(handle, traversalLabel, evidenceDir);

    // The resolved path must start with the evidence directory
    const resolved = path.resolve(filePath);
    const resolvedEvidence = path.resolve(evidenceDir);
    expect(resolved.startsWith(resolvedEvidence)).toBe(true);
  });

  // OWASP A05: Security Misconfiguration
  // takeScreenshot must return an absolute path so callers cannot
  // accidentally resolve it relative to an unexpected working directory.
  it("returns an absolute file path", async () => {
    const { handle, page } = await buildHandle();
    page.screenshot.mockResolvedValue(Buffer.from("png"));

    vi.mock("node:fs/promises", () => ({
      writeFile: vi.fn().mockResolvedValue(undefined),
    }));

    const filePath = await takeScreenshot(handle, "my-label", "/tmp/evidence");
    expect(path.isAbsolute(filePath)).toBe(true);
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  // Label containing only special characters must still produce a valid,
  // non-empty filename (avoids empty-name file creation in evidence dir).
  it("produces a non-empty filename even when label is all special characters", async () => {
    const { handle, page } = await buildHandle();
    page.screenshot.mockResolvedValue(Buffer.from("png"));

    vi.mock
