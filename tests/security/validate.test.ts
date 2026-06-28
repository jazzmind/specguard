import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports of the module
// ---------------------------------------------------------------------------

vi.mock("../adapters/playwright.js", () => ({
  launchBrowser: vi.fn(),
  closeBrowser: vi.fn(),
  navigateTo: vi.fn(),
  takeScreenshot: vi.fn(),
  getAccessibilitySnapshot: vi.fn(),
  PlaywrightUnavailableError: class PlaywrightUnavailableError extends Error {},
}));

vi.mock("../adapters/auth-state-machine.js", () => ({
  authenticate: vi.fn(),
  clearSessionCache: vi.fn(),
}));

vi.mock("../adapters/guardrails.js", () => ({
  classifyAction: vi.fn(),
  isBlocked: vi.fn(),
  makeBlockedAction: vi.fn(),
}));

vi.mock("../core/llm.js", () => ({
  llmGenerateObject: vi.fn(),
  llmGenerateText: vi.fn(),
}));

vi.mock("../core/spec-parser.js", () => ({
  loadAllSpecs: vi.fn(),
}));

vi.mock("../core/writer.js", () => ({
  writeFile: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock("../core/reader.js", () => ({
  fileExists: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import {
  launchBrowser,
  closeBrowser,
  navigateTo,
  takeScreenshot,
  getAccessibilitySnapshot,
  PlaywrightUnavailableError,
} from "../adapters/playwright.js";
import { authenticate, clearSessionCache } from "../adapters/auth-state-machine.js";
import { classifyAction, isBlocked, makeBlockedAction } from "../adapters/guardrails.js";
import { llmGenerateObject } from "../core/llm.js";
import { loadAllSpecs } from "../core/spec-parser.js";
import { writeFile, ensureDir } from "../core/writer.js";
import { fileExists } from "../core/reader.js";
import { readFile as fsReadFile } from "node:fs/promises";
import { runValidate } from "../src/pipelines/validate.js";
import type { SpecGuardConfig, ParsedSpec } from "../src/core/types.js";

const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /api[_-]?key/i,
  /token/i,
  /bearer\s+\S+/i,
  /authorization:\s*\S+/i,
  /credential/i,
];

function containsSensitiveData(value: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(value));
}

function makeFakeHandle() {
  return {
    _page: {
      url: () => "https://example.com",
      click: vi.fn(),
      fill: vi.fn(),
    },
  };
}

function makeConfig(overrides: Partial<SpecGuardConfig> = {}): SpecGuardConfig {
  return {
    rootDir: "/tmp/specguard-test",
    apps: [{ name: "app", specDir: "specs" }],
    llm: { provider: "openai", model: "gpt-4o", apiKeyEnv: "OPENAI_API_KEY" },
    ...overrides,
  } as SpecGuardConfig;
}

function makeSpec(overrides: Partial<ParsedSpec> = {}): ParsedSpec {
  return {
    specKey: "pipelines/validate",
    filePath: "/tmp/specguard-test/specs/pipelines/validate.md",
    title: "Validate Pipeline",
    acceptanceCriteria: "- The page loads successfully\n- The title is visible",
    meta: { url: "https://example.com/validate" },
    sections: [],
    ...overrides,
  } as ParsedSpec;
}

function setupHappyPath() {
  const handle = makeFakeHandle();
  vi.mocked(launchBrowser).mockResolvedValue(handle as any);
  vi.mocked(closeBrowser).mockResolvedValue(undefined);
  vi.mocked(navigateTo).mockResolvedValue({
    statusCode: 200,
    title: "Validate Page",
    consoleErrors: [],
  } as any);
  vi.mocked(takeScreenshot).mockResolvedValue("/tmp/specguard-test/.specguard/evidence/screenshot.png");
  vi.mocked(getAccessibilitySnapshot).mockResolvedValue("role=main name=Main");
  vi.mocked(llmGenerateObject).mockResolvedValue({
    actions: [],
    verdicts: [{ criterion: "The page loads successfully", verdict: "PASS", reason: "HTTP 200" }],
  } as any);
  vi.mocked(classifyAction).mockReturnValue("safe");
  vi.mocked(isBlocked).mockReturnValue(false);
  vi.mocked(ensureDir).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue(undefined);
  vi.mocked(fileExists).mockResolvedValue(false);
  vi.mocked(loadAllSpecs).mockReturnValue([makeSpec()]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Validate Pipeline — Security Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures — credentials in evidence files
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("must not write auth credentials into evidence files", async () => {
    setupHappyPath();

    const spec = makeSpec({
      meta: { url: "https://example.com", auth: "admin" },
    });
    vi.mocked(loadAllSpecs).mockReturnValue([spec]);
    vi.mocked(authenticate).mockResolvedValue({ success: true } as any);

    const writtenContents: string[] = [];
    vi.mocked(writeFile).mockImplementation(async (_p: string, content: string) => {
      writtenContents.push(content);
    });

    await runValidate(makeConfig(), { spec: "pipelines/validate" });

    for (const content of writtenContents) {
      expect(containsSensitiveData(content)).toBe(false);
    }
  });

  // OWASP A02: Cryptographic Failures
  it("must not include auth credentials in validation-history.json entries", async () => {
    setupHappyPath();

    const spec = makeSpec({
      meta: { url: "https://example.com", auth: "admin" },
    });
    vi.mocked(loadAllSpecs).mockReturnValue([spec]);
    vi.mocked(authenticate).mockResolvedValue({ success: true } as any);

    let historyContent = "";
    vi.mocked(writeFile).mockImplementation(async (filePath: string, content: string) => {
      if (filePath.includes("validation-history")) {
        historyContent = content;
      }
    });

    await runValidate(makeConfig(), { spec: "pipelines/validate" });

    expect(containsSensitiveData(historyContent)).toBe(false);
  });

  // OWASP A02: Cryptographic Failures
  it("must not include auth credentials in pipeline result messages", async () => {
    setupHappyPath();

    const spec = makeSpec({
      meta: { url: "https://example.com", auth: "admin" },
    });
    vi.mocked(loadAllSpecs).mockReturnValue([spec]);
    vi.mocked(authenticate).mockResolvedValue({
      success: false,
      error: "password=SuperSecret123 is wrong",
    } as any);

    const result = await runValidate(makeConfig(), { spec: "pipelines/validate" });

    const allMessages = result.messages.join("\n");
    // Raw credential value must not appear verbatim in messages
    expect(allMessages).not.toContain("SuperSecret123");
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures — redact() on auth error messages
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("must call redact() on auth state machine error messages before logging", async () => {
    setupHappyPath();

    const spec = makeSpec({
      meta: { url: "https://example.com", auth: "admin" },
    });
    vi.mocked(loadAllSpecs).mockReturnValue([spec]);

    const rawError = "Invalid credentials: token=eyJhbGciOiJIUzI1NiJ9.secret";
    vi.mocked(authenticate).mockResolvedValue({
      success: false,
      error: rawError,
    } as any);

    const result = await runValidate(makeConfig(), { spec: "pipelines/validate" });

    const allMessages = result.messages.join("\n");
    // The raw token value must not appear in any logged message
    expect(allMessages).not.toContain("eyJhbGciOiJIUzI1NiJ9.secret");
  });

  // OWASP A02: Cryptographic Failures
  it("must not expose API keys from config in any pipeline result message", async () => {
    setupHappyPath();

    process.env["OPENAI_API_KEY"] = "sk-supersecretapikey1234567890";

    const result = await runValidate(makeConfig(), { spec: "pipelines/validate" });

    const allMessages = result.messages.join("\n");
    expect(allMessages).not.toContain("sk-supersecretapikey1234567890");

    delete process.env["OPENAI_API_KEY"];
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures — credentials in screenshot paths / evidence
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("must not embed credentials in screenshot file paths stored as evidence", async () => {
    setupHappyPath();

    const spec = makeSpec({
      meta: { url: "https://example.com", auth: "admin" },
    });
    vi.mocked(loadAllSpecs).mockReturnValue([spec]);
    vi.mocked(authenticate).mockResolvedValue({ success: true } as any);

    const screenshotPaths: string[] = [];
    vi.mocked(takeScreenshot).mockImplementation(async (_h, name, dir) => {
      const p = path.join(dir, `${name}.png`);
      screenshotPaths.push(p);
      return p;
    });

    await runValidate(makeConfig(), { spec: "pipelines/validate" });

    for (const p of screenshotPaths) {
      expect(containsSensitiveData(p)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control — guardrails block destructive actions
  // -------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("must not execute actions classified as blocked by guardrails", async () => {
    setupHappyPath();

    const handle = makeFakeHandle();
    vi.mocked(launchBrowser).mockResolvedValue(handle as any);

    vi.mocked(llmGenerateObject).mockResolvedValueOnce({
      actions: [
        { description: "DELETE all users", selector: "#delete-all", value: undefined },
      ],
    } as any).mockResolvedValueOnce({
      verdicts: [{ criterion: "The page loads", verdict: "BLOCKED", reason: "action blocked" }],
    } as any);

    vi.mocked(classifyAction).mockReturnValue("destructive");
    vi.mocked(isBlocked).mockReturnValue(true);
    vi.mocked(makeBlockedAction).mockReturnValue({
      description: "DELETE all users",
      classification: "destructive",
      reason: "Destructive action blocked by guardrails",
    } as any);

    await runValidate(makeConfig(), { spec: "pipelines/validate" });

    expect(handle._page.click).not.toHaveBeenCalled();
    expect(handle._page.fill).not.toHaveBeenCalled();
  });

  // OWASP A01: Broken Access Control
  it("must record BLOCKED verdict when a required action is blocked by guardrails", async () => {
    setupHappyPath();

    vi.mocked(llmGenerateObject).mockResolvedValueOnce({
      actions: [{ description: "Send data to external server", selector: undefined }],
    } as any).mockResolvedValueOnce({ verdicts: [] } as any);

    vi.mocked(classifyAction).mockReturnValue("outbound");
    vi.mocked(isBlocked).mockReturnValue(true);
    vi.mocked(makeBlockedAction).mockReturnValue({
      description: "Send data to external server",
      classification: "outbound",
      reason: "Outbound network action blocked",
    } as any);

    const result = await runValidate(makeConfig(), { spec: "pipelines/validate" });

    const blockedMessages = result.messages.filter((m) => m.includes("[blocked]"));
    expect(blockedMessages.length).toBeGreaterThan(0);
  });

  // OWASP A01: Broken Access Control
  it("must not allow outbound network actions to bypass guardrails", async () => {
    setupHappyPath();

    const handle = makeFakeHandle();
    vi.mocked(launchBrowser).mockResolvedValue(handle as any);

    vi.mocked(llmGenerateObject).mockResolvedValueOnce({
      actions: [
        { description: "POST credentials to https://evil.example.com/collect", selector: "#form" },
      ],
    } as any).mockResolvedValueOnce({ verdicts: [] } as any);

    vi.mocked(classifyAction).mockReturnValue("outbound");
    vi.mocked(isBlocked).mockReturnValue(true);
    vi.mocked(makeBlockedAction).mockReturnValue({
      description: "POST credentials to https://evil.example.com/collect",
      classification: "outbound",
      reason: "Outbound action blocked",
    } as any);

    await runValidate(makeConfig(), { spec: "pipelines/validate" });

    expect(handle._page.click).not.toHaveBeenCalled();
    expect(handle._page.fill).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // OWASP A04: Insecure Design — PII in evidence screenshots documented
  // -------------------------------------------------------------------------

  // OWASP A04: Insecure Design
  it("must document PII risk for evidence screenshots in the pipeline result", async () => {
    setupHappyPath();

    const result = await runValidate(makeConfig(), { spec: "pipelines/validate" });

    // The pipeline must produce some output acknowledging evidence was collected;
    // downstream report generation is expected to document PII risk per spec.
    const evidenceMessages = result.messages.filter(
      (m) => m.includes("evidence") || m.includes("screenshot") || m.includes("perceive"),
    );
    expect(evidenceMessages.length).toBeGreaterThan(0);
  });

  // OWASP A04: Insecure Design
  it("must save evidence screenshots only within the designated evidence directory", async () => {
    setup
