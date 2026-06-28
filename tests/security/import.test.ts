import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchUrl, runImport } from "../src/pipelines/import.js";
import type { SpecGuardConfig } from "../src/core/types.js";
import * as llm from "../src/core/llm.js";
import * as reader from "../src/core/reader.js";
import * as writer from "../src/core/writer.js";
import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SpecGuardConfig> = {}): SpecGuardConfig {
  return {
    rootDir: "/tmp/specguard-test",
    llm: {
      provider: "openai",
      model: "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    apps: [
      {
        name: "test-app",
        specDir: "specs",
        srcDir: "src",
      },
    ],
    ...overrides,
  } as unknown as SpecGuardConfig;
}

// ---------------------------------------------------------------------------
// fetchUrl – SSRF / redirect safety
// ---------------------------------------------------------------------------

describe("fetchUrl – SSRF and redirect safety", () => {
  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("rejects file:// protocol directly", async () => {
    await expect(fetchUrl("file:///etc/passwd")).rejects.toThrow(
      /Unsupported protocol/i,
    );
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("rejects ftp:// protocol directly", async () => {
    await expect(fetchUrl("ftp://internal.host/secret")).rejects.toThrow(
      /Unsupported protocol/i,
    );
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("rejects data: URI scheme", async () => {
    await expect(fetchUrl("data:text/plain,hello")).rejects.toThrow(
      /Unsupported protocol/i,
    );
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("does not follow a redirect that points to file://", async () => {
    const mockGet = vi.spyOn(https, "get").mockImplementation(
      (_url: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (res: unknown) => void;
        const fakeRes = {
          statusCode: 301,
          headers: { location: "file:///etc/shadow" },
          resume: vi.fn(),
          on: vi.fn(),
        };
        callback(fakeRes);
        return { on: vi.fn(), setTimeout: vi.fn() } as unknown as ReturnType<typeof https.get>;
      },
    );

    await expect(fetchUrl("https://example.com/redirect")).rejects.toThrow(
      /Unsupported protocol|file/i,
    );

    mockGet.mockRestore();
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("does not follow a redirect that points to a private IPv4 address (169.254.x.x)", async () => {
    const mockGet = vi.spyOn(https, "get").mockImplementation(
      (_url: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (res: unknown) => void;
        const fakeRes = {
          statusCode: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
          resume: vi.fn(),
          on: vi.fn(),
        };
        callback(fakeRes);
        return { on: vi.fn(), setTimeout: vi.fn() } as unknown as ReturnType<typeof https.get>;
      },
    );

    // The redirect target is an http:// URL so fetchUrl will recurse; the
    // inner request should fail or the implementation should block it.
    // We assert the overall promise rejects or resolves without leaking
    // cloud metadata (implementation must block private IPs).
    const result = fetchUrl("https://example.com/redirect");
    await expect(result).rejects.toThrow();

    mockGet.mockRestore();
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("does not follow a redirect that points to localhost", async () => {
    const mockGet = vi.spyOn(https, "get").mockImplementation(
      (_url: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (res: unknown) => void;
        const fakeRes = {
          statusCode: 301,
          headers: { location: "http://localhost:8080/admin" },
          resume: vi.fn(),
          on: vi.fn(),
        };
        callback(fakeRes);
        return { on: vi.fn(), setTimeout: vi.fn() } as unknown as ReturnType<typeof https.get>;
      },
    );

    const result = fetchUrl("https://example.com/redirect");
    await expect(result).rejects.toThrow();

    mockGet.mockRestore();
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("does not follow a redirect that points to 10.x.x.x private range", async () => {
    const mockGet = vi.spyOn(https, "get").mockImplementation(
      (_url: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (res: unknown) => void;
        const fakeRes = {
          statusCode: 302,
          headers: { location: "http://10.0.0.1/internal" },
          resume: vi.fn(),
          on: vi.fn(),
        };
        callback(fakeRes);
        return { on: vi.fn(), setTimeout: vi.fn() } as unknown as ReturnType<typeof https.get>;
      },
    );

    const result = fetchUrl("https://example.com/redirect");
    await expect(result).rejects.toThrow();

    mockGet.mockRestore();
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("does not follow a redirect that points to 192.168.x.x private range", async () => {
    const mockGet = vi.spyOn(https, "get").mockImplementation(
      (_url: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (res: unknown) => void;
        const fakeRes = {
          statusCode: 301,
          headers: { location: "http://192.168.1.1/router" },
          resume: vi.fn(),
          on: vi.fn(),
        };
        callback(fakeRes);
        return { on: vi.fn(), setTimeout: vi.fn() } as unknown as ReturnType<typeof https.get>;
      },
    );

    const result = fetchUrl("https://example.com/redirect");
    await expect(result).rejects.toThrow();

    mockGet.mockRestore();
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("rejects non-http/https URLs constructed with unusual casing (e.g. FILE://)", async () => {
    await expect(fetchUrl("FILE:///etc/passwd")).rejects.toThrow(
      /Unsupported protocol/i,
    );
  });

  // OWASP A05: Security Misconfiguration – timeout enforcement
  it("enforces a request timeout and rejects on hang", async () => {
    const mockGet = vi.spyOn(https, "get").mockImplementation(
      (_url: unknown, _opts: unknown, _cb: unknown) => {
        let timeoutCb: (() => void) | undefined;
        const req = {
          on: vi.fn(),
          setTimeout: vi.fn((_ms: number, cb: () => void) => {
            timeoutCb = cb;
          }),
          destroy: vi.fn(() => {
            if (timeoutCb) timeoutCb();
          }),
        };
        // Simulate timeout firing immediately
        setTimeout(() => req.destroy(), 0);
        return req as unknown as ReturnType<typeof https.get>;
      },
    );

    await expect(fetchUrl("https://slow.example.com/doc")).rejects.toThrow(
      /Timeout/i,
    );

    mockGet.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runImport – credential leakage into LLM prompts
// ---------------------------------------------------------------------------

describe("runImport – LLM prompt credential sanitisation", () => {
  beforeEach(() => {
    vi.spyOn(reader, "readFile").mockResolvedValue(
      "# Requirements\n\nAPI_KEY=sk-secret123\npassword=hunter2\n\nDo the thing.",
    );
    vi.spyOn(reader, "fileExists").mockResolvedValue(false);
    vi.spyOn(writer, "writeFile").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // OWASP A02: Cryptographic Failures – secrets must not be forwarded to third-party LLM APIs
  it("does not include raw API key values from source document in the LLM prompt", async () => {
    let capturedPrompt = "";
    vi.spyOn(llm, "llmGenerateText").mockImplementation(async (opts) => {
      capturedPrompt = opts.prompt ?? "";
      return "# Imported Spec\n\n## Overview\nDo the thing.\n";
    });

    const config = makeConfig();
    await runImport(config, { source: "/tmp/requirements.md" });

    // The raw secret value must not appear verbatim in the prompt sent to the LLM.
    expect(capturedPrompt).not.toContain("sk-secret123");
    expect(capturedPrompt).not.toContain("hunter2");
  });

  // OWASP A02: Cryptographic Failures – auth credentials must not reach LLM
  it("does not include Bearer tokens found in source document in the LLM prompt", async () => {
    vi.spyOn(reader, "readFile").mockResolvedValue(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig\n\nRequirements here.",
    );

    let capturedPrompt = "";
    vi.spyOn(llm, "llmGenerateText").mockImplementation(async (opts) => {
      capturedPrompt = opts.prompt ?? "";
      return "# Imported Spec\n\n## Overview\nRequirements here.\n";
    });

    const config = makeConfig();
    await runImport(config, { source: "/tmp/requirements.md" });

    expect(capturedPrompt).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.payload.sig",
    );
  });

  // OWASP A02: Cryptographic Failures – private keys must not reach LLM
  it("does not include PEM private key material from source document in the LLM prompt", async () => {
    vi.spyOn(reader, "readFile").mockResolvedValue(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n\nRequirements.",
    );

    let capturedPrompt = "";
    vi.spyOn(llm, "llmGenerateText").mockImplementation(async (opts) => {
      capturedPrompt = opts.prompt ?? "";
      return "# Imported Spec\n\n## Overview\nRequirements.\n";
    });

    const config = makeConfig();
    await runImport(config, { source: "/tmp/requirements.md" });

    expect(capturedPrompt).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(capturedPrompt).not.toContain("MIIEowIBAAKCAQEA");
  });

  // OWASP A02: Cryptographic Failures – LLM system prompt must never contain API key env values
  it("does not pass the resolved LLM API key value into the system prompt or user prompt", async () => {
    process.env["OPENAI_API_KEY"] = "sk-live-supersecret";

    let capturedSystem = "";
    let capturedPrompt = "";
    vi.spyOn(llm, "llmGenerateText").mockImplementation(async (opts) => {
      capturedSystem = opts.system ?? "";
      capturedPrompt = opts.prompt ?? "";
      return "# Imported Spec\n\n## Overview\nDo the thing.\n";
    });

    const config = makeConfig();
    await runImport(config, { source: "/tmp/requirements.md" });

    expect(capturedSystem).not.toContain("sk-live-supersecret");
    expect(capturedPrompt).not.toContain("sk-live-supersecret");

    delete process.env["OPENAI_API_KEY"];
  });
});

// ---------------------------------------------------------------------------
// runImport – access control and path traversal
// ---------------------------------------------------------------------------

describe("runImport – access control and path traversal", () => {
  beforeEach(() => {
    vi.spyOn(reader, "fileExists").mockResolvedValue(false);
    vi.spyOn(writer, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(llm, "llmGenerateText").mockResolvedValue(
      "# Imported Spec\n\n## Overview\nContent.\n",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // OWASP A01: Broken Access Control – path traversal in --out option
  it("does not write outside rootDir when --out contains path traversal sequences", async () => {
    vi.spyOn(reader, "readFile").mockResolvedValue("# Requirements\nDo the thing.");

    let writtenPath = "";
    vi.spyOn(writer, "writeFile").mockImplementation(async (p, _content) => {
      writtenPath = p;
    });

    const config = makeConfig();
    await runImport(config, {
      source: "/tmp/requirements.md",
      out: "../../etc/cron.d/evil",
    });

    // The resolved write path must remain within rootDir or a safe location.
    // It must not escape to /etc or other sensitive system directories.
    expect(writtenPath).not.toMatch(/^\/etc\//);
    expect(writtenPath).not.toContain("/etc/cron");
  });

  // OWASP A01: Broken Access Control – unknown app name must be rejected
  it("throws when an unknown --app name is supplied", async () => {
    vi.spyOn(reader, "readFile").mockResolvedValue("# Requirements\nDo the thing.");

    const config = makeConfig();
    await expect(
      runImport(config, { source: "/tmp/requirements.md", app: "nonexistent-app" }),
    ).rejects.toThrow(/Unknown app/i);
  });

  // OWASP A01: Broken Access Control – ambiguous app must be rejected without explicit --app
  it("throws when multiple apps exist and no --app is specified", async () => {
    vi.spyOn(reader, "readFile").mockResolvedValue("# Requirements\nDo the thing.");

    const config = makeConfig({
      apps: [
        { name: "app-one", specDir: "specs", srcDir: "src" },
        { name: "app-two", specDir: "specs2", srcDir: "src2" },
      ],
    } as unknown as Partial<SpecGuardConfig>);

    await expect(
      runImport(config, { source: "/tmp/requirements.md" }),
    ).rejects.
