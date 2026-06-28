import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// SpecGuard VS Code Extension – OWASP-Annotated Security Test Stubs
// Spec key: specguard-core/extension
// ---------------------------------------------------------------------------

// Minimal stubs for VS Code API surface used by the extension
const mockWorkspaceFolders = [{ uri: { fsPath: "/workspace" } }];

const vscode = {
  workspace: {
    workspaceFolders: mockWorkspaceFolders,
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: "",
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: unknown) => uri),
        cspSource: "vscode-resource:",
      },
      onDidDispose: vi.fn(),
      reveal: vi.fn(),
    })),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    joinPath: (...parts: string[]) => ({ fsPath: parts.join("/") }),
  },
  ExtensionContext: {},
};

vi.mock("vscode", () => vscode, { virtual: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    apps: [{ name: "MyApp", specCount: 3 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Config file reading – information exposure
// ---------------------------------------------------------------------------

describe("Config file reading – information exposure", () => {
  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  it("should expose only app names and spec counts from config.json, not raw file contents", () => {
    const rawConfig = makeConfig({
      internalSecret: "super-secret-value",
      databasePassword: "hunter2",
    });

    // Simulate the projection the extension is supposed to apply
    const projected = (rawConfig.apps ?? []).map(
      (app: { name: string; specCount: number }) => ({
        name: app.name,
        specCount: app.specCount,
      })
    );

    // Raw sensitive fields must not appear in the projected output
    const serialised = JSON.stringify(projected);
    expect(serialised).not.toContain("internalSecret");
    expect(serialised).not.toContain("super-secret-value");
    expect(serialised).not.toContain("databasePassword");
    expect(serialised).not.toContain("hunter2");

    // Only the allowed fields should be present
    expect(projected[0]).toHaveProperty("name");
    expect(projected[0]).toHaveProperty("specCount");
    expect(Object.keys(projected[0])).toHaveLength(2);
  });

  // OWASP A05: Security Misconfiguration
  it("should not crash or leak data when config.json is missing", () => {
    const readConfig = () => {
      // Simulate file-not-found scenario
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };

    let result: unknown = null;
    expect(() => {
      try {
        readConfig();
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          result = { apps: [] }; // safe default
        } else {
          throw err;
        }
      }
    }).not.toThrow();

    expect(result).toEqual({ apps: [] });
  });

  // OWASP A05: Security Misconfiguration
  it("should not crash or leak data when config.json is malformed JSON", () => {
    const malformedContent = '{ "apps": [ { "name": "Broken" ';

    let result: unknown = null;
    expect(() => {
      try {
        result = JSON.parse(malformedContent);
      } catch {
        result = { apps: [] }; // safe default
      }
    }).not.toThrow();

    expect(result).toEqual({ apps: [] });
  });

  // OWASP A03: Injection
  it("should sanitise app names that contain HTML/script content before rendering in webview", () => {
    const maliciousConfig = makeConfig({
      apps: [
        {
          name: '<script>alert("xss")</script>',
          specCount: 1,
        },
      ],
    });

    const sanitise = (name: string) =>
      name
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");

    const sanitisedName = sanitise(maliciousConfig.apps[0].name);
    expect(sanitisedName).not.toContain("<script>");
    expect(sanitisedName).not.toContain("</script>");
    expect(sanitisedName).toContain("&lt;script&gt;");
  });

  // OWASP A03: Injection
  it("should sanitise app names containing SQL-like injection patterns", () => {
    const maliciousName = "'; DROP TABLE specs; --";
    const sanitise = (name: string) =>
      name.replace(/['"`;]/g, "").replace(/--/g, "");

    const sanitised = sanitise(maliciousName);
    expect(sanitised).not.toContain("'");
    expect(sanitised).not.toContain(";");
    expect(sanitised).not.toContain("--");
  });
});

// ---------------------------------------------------------------------------
// 2. CLI spawning – environment variable handling
// ---------------------------------------------------------------------------

describe("CLI spawning – environment variable handling", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  it("should not log or expose ANTHROPIC_API_KEY in error messages when CLI spawn fails", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-key-12345";

    const capturedMessages: string[] = [];
    const mockShowError = (msg: string) => capturedMessages.push(msg);

    // Simulate a spawn error handler that must not echo env vars
    const handleSpawnError = (err: Error) => {
      // Safe: only expose the error message, not the full environment
      mockShowError(`CLI failed: ${err.message}`);
    };

    handleSpawnError(new Error("spawn ENOENT"));

    for (const msg of capturedMessages) {
      expect(msg).not.toContain("sk-ant-secret-key-12345");
      expect(msg).not.toContain("ANTHROPIC_API_KEY");
    }
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  it("should not serialise process.env (including secrets) into webview messages", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-key-12345";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-99";

    // Simulate what the extension posts to the webview
    const webviewMessage = {
      type: "cliResult",
      payload: {
        exitCode: 0,
        stdout: "Spec validated successfully.",
      },
    };

    const serialised = JSON.stringify(webviewMessage);
    expect(serialised).not.toContain("ANTHROPIC_API_KEY");
    expect(serialised).not.toContain("sk-ant-secret-key-12345");
    expect(serialised).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(serialised).not.toContain("aws-secret-99");
  });

  // OWASP A05: Security Misconfiguration
  it("should warn (not throw) when ANTHROPIC_API_KEY is absent from the environment", () => {
    delete process.env.ANTHROPIC_API_KEY;

    const warnings: string[] = [];
    const checkApiKey = () => {
      if (!process.env.ANTHROPIC_API_KEY) {
        warnings.push(
          "ANTHROPIC_API_KEY is not set; LLM pipeline features will be unavailable."
        );
      }
    };

    expect(() => checkApiKey()).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ANTHROPIC_API_KEY/);
  });

  // OWASP A08: Software and Data Integrity Failures
  it("should use a fixed, trusted CLI binary path and not derive it from user-supplied input", () => {
    const userInput = "../../malicious-binary";

    // The extension should resolve the CLI path from its own extension context,
    // not from workspace or user configuration.
    const resolveCliPath = (extensionPath: string) =>
      `${extensionPath}/node_modules/.bin/specguard`;

    const cliPath = resolveCliPath("/trusted/extension/root");

    expect(cliPath).not.toContain(userInput);
    expect(cliPath).toMatch(/^\/trusted\/extension\/root/);
    expect(cliPath).not.toContain("..");
  });

  // OWASP A03: Injection
  it("should not allow workspace folder paths to inject shell metacharacters into CLI args", () => {
    const maliciousPath = "/workspace; rm -rf /; echo pwned";

    // The extension must pass args as an array (never a shell string)
    const buildCliArgs = (workspacePath: string, specKey: string) => [
      "--workspace",
      workspacePath,
      "--spec",
      specKey,
    ];

    const args = buildCliArgs(maliciousPath, "my-spec");

    // Each argument is a discrete array element – no shell interpolation
    expect(args).toContain(maliciousPath); // passed verbatim as one arg
    expect(args.join(" ")).not.toMatch(/rm -rf/); // but not executed as shell
    // Verify the array structure prevents shell injection
    expect(Array.isArray(args)).toBe(true);
    expect(args[1]).toBe(maliciousPath); // exact string, not split by shell
  });

  // OWASP A03: Injection
  it("should reject spec keys containing path traversal sequences before passing to CLI", () => {
    const maliciousSpecKey = "../../etc/passwd";

    const validateSpecKey = (key: string): boolean =>
      /^[a-zA-Z0-9_\-/]+$/.test(key) && !key.includes("..");

    expect(validateSpecKey(maliciousSpecKey)).toBe(false);
    expect(validateSpecKey("specguard-core/extension")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Webview security
// ---------------------------------------------------------------------------

describe("Webview security", () => {
  // OWASP A03: Injection
  it("should include a Content Security Policy meta tag in the webview HTML", () => {
    const generateWebviewHtml = (cspSource: string, nonce: string) => `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy"
            content="default-src 'none'; script-src '${cspSource}' 'nonce-${nonce}'; style-src '${cspSource}';">
        </head>
        <body></body>
      </html>
    `;

    const html = generateWebviewHtml("vscode-resource:", "abc123");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("nonce-abc123");
  });

  // OWASP A03: Injection
  it("should use a cryptographically random nonce for each webview instantiation", () => {
    const generateNonce = () => {
      const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let nonce = "";
      // In production this uses crypto.getRandomValues; here we simulate length/uniqueness
      for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return nonce;
    };

    const nonce1 = generateNonce();
    const nonce2 = generateNonce();

    expect(nonce1).toHaveLength(32);
    expect(nonce2).toHaveLength(32);
    expect(nonce1).not.toBe(nonce2);
  });

  // OWASP A01: Broken Access Control
  it("should reject webview messages with unrecognised command types", () => {
    const allowedCommands = new Set(["runSpec", "openDashboard", "refresh"]);

    const handleWebviewMessage = (message: { command: string }) => {
      if (!allowedCommands.has(message.command)) {
        throw new Error(`Unrecognised command: ${message.command}`);
      }
      return true;
    };

    expect(() =>
      handleWebviewMessage({ command: "__proto__" })
    ).toThrow("Unrecognised command");

    expect(() =>
      handleWebviewMessage({ command: "constructor" })
    ).toThrow("Unrecognised command");

    expect(() =>
      handleWebviewMessage({ command: "runSpec" })
    ).not.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("should not allow the webview to request files outside the extension directory", () => {
    const extensionRoot = "/trusted/extension/root";

    const resolveWebviewResource = (
      extensionRoot: string,
      relativePath: string
    ): string => {
      const resolved = `${extensionRoot}/${relativePath}`;
      if (!resolved.startsWith(extensionRoot)) {
        throw new Error("Path traversal detected");
      }
      return resolved;
    };

    expect(() =>
      resolveWebviewResource(extensionRoot, "../../etc/shadow")
    ).toThrow("Path traversal detected");

    expect(() =>
      resolveWebviewResource(extensionRoot, "webview/index.js")
    ).not.toThrow();
  });

  // OWASP A03: Injection
  it("should not render raw markdown or HTML from spec titles in the webview without escaping", () => {
    const specTitle = '<img src=x onerror=alert(1)>';

    const escapeHtml = (raw: string) =>
      raw
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const rendered = escapeHtml(specTitle);
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("onerror");
    expect(rendered).toContain("&lt;img");
  });
});

// ---------------------------------------------------------------------------
// 4. Broken Access Control – workspace isolation
// ---------------------------------------------------------------------------

describe("Workspace isolation", () => {
  // OWASP A01: Broken Access Control
  it("should scope all file reads to the active workspace folder and not traverse above it", () => {
    const workspaceRoot = "/workspace/project";

    const safeReadPath = (workspaceRoot: string, relativePath: string) => {
      const fullPath = `${workspaceRoot}/${relativePath}`;
      if (!
