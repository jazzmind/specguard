import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveModel, llmGenerateText, llmGenerateObject } from "../src/core/llm.js";
import { SpecGuardError } from "../src/core/errors.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_KEY = "sk-super-secret-api-key-value-1234567890";
const KEY_ENV = "TEST_LLM_API_KEY";

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// ---------------------------------------------------------------------------
// resolveModel — API key secrecy
// ---------------------------------------------------------------------------

describe("resolveModel – API key never leaks into diagnostics", () => {
  // OWASP A09: Security Logging and Monitoring Failures
  // The error thrown when the env var is missing must contain only the var
  // *name*, never the resolved value (which is empty/absent here, but the
  // contract must hold for any value).
  it("error message for missing key contains the env-var NAME, not a key value", () => {
    withEnv(KEY_ENV, undefined, () => {
      let caught: unknown;
      try {
        resolveModel("anthropic", "claude-3-5-sonnet-20241022", KEY_ENV);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SpecGuardError);
      const msg = (caught as SpecGuardError).message;
      expect(msg).toContain(KEY_ENV);
      // The message must NOT contain the literal key value (even though it is
      // absent here, the pattern must not accidentally embed it).
      expect(msg).not.toContain(FAKE_KEY);
    });
  });

  // OWASP A09: Security Logging and Monitoring Failures
  // When the env var IS set, the resolved key value must not appear in any
  // error thrown for an *unknown provider*.
  it("error message for unknown provider does NOT contain the resolved API key value", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      let caught: unknown;
      try {
        resolveModel("unknown-provider", "some-model", KEY_ENV);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SpecGuardError);
      const msg = (caught as SpecGuardError).message;
      expect(msg).not.toContain(FAKE_KEY);
    });
  });

  // OWASP A09: Security Logging and Monitoring Failures
  // An empty-string value for the env var is treated as missing; the error
  // must still only reference the var name.
  it("error message for empty-string key contains the env-var NAME only", () => {
    withEnv(KEY_ENV, "", () => {
      let caught: unknown;
      try {
        resolveModel("openai", "gpt-4o", KEY_ENV);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SpecGuardError);
      const msg = (caught as SpecGuardError).message;
      expect(msg).toContain(KEY_ENV);
      expect(msg).not.toMatch(/sk-/);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveModel — missing / invalid key throws SpecGuardError
// ---------------------------------------------------------------------------

describe("resolveModel – missing API key", () => {
  // OWASP A05: Security Misconfiguration
  // Unset env var must cause a hard failure, not a silent undefined key.
  it("throws SpecGuardError when env var is unset", () => {
    withEnv(KEY_ENV, undefined, () => {
      expect(() =>
        resolveModel("anthropic", "claude-3-5-sonnet-20241022", KEY_ENV)
      ).toThrowError(SpecGuardError);
    });
  });

  // OWASP A05: Security Misconfiguration
  it("throws SpecGuardError when env var is an empty string", () => {
    withEnv(KEY_ENV, "", () => {
      expect(() =>
        resolveModel("openai", "gpt-4o", KEY_ENV)
      ).toThrowError(SpecGuardError);
    });
  });

  // OWASP A05: Security Misconfiguration
  // The error message must reference the env-var name so operators can act.
  it("error message references the env-var name for operator diagnostics", () => {
    withEnv(KEY_ENV, undefined, () => {
      let msg = "";
      try {
        resolveModel("anthropic", "claude-3-5-sonnet-20241022", KEY_ENV);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain(KEY_ENV);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveModel — unknown provider
// ---------------------------------------------------------------------------

describe("resolveModel – unknown provider", () => {
  // OWASP A05: Security Misconfiguration
  it("throws SpecGuardError for an unsupported provider string", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      expect(() =>
        resolveModel("gemini", "gemini-pro", KEY_ENV)
      ).toThrowError(SpecGuardError);
    });
  });

  // OWASP A05: Security Misconfiguration
  it("error message names the unsupported provider for diagnostics", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      let msg = "";
      try {
        resolveModel("gemini", "gemini-pro", KEY_ENV);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("gemini");
    });
  });

  // OWASP A09: Security Logging and Monitoring Failures
  it("unknown-provider error does NOT embed the API key value", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      let msg = "";
      try {
        resolveModel("gemini", "gemini-pro", KEY_ENV);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toContain(FAKE_KEY);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveModel — supported providers succeed when key is present
// ---------------------------------------------------------------------------

describe("resolveModel – valid configuration returns a model object", () => {
  // OWASP A05: Security Misconfiguration
  it("returns a truthy model for anthropic when key is set", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      const model = resolveModel("anthropic", "claude-3-5-sonnet-20241022", KEY_ENV);
      expect(model).toBeTruthy();
    });
  });

  // OWASP A05: Security Misconfiguration
  it("returns a truthy model for openai when key is set", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      const model = resolveModel("openai", "gpt-4o", KEY_ENV);
      expect(model).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// llmGenerateText — key secrecy in propagated errors
// ---------------------------------------------------------------------------

describe("llmGenerateText – API key never surfaces in thrown errors", () => {
  // OWASP A09: Security Logging and Monitoring Failures
  it("error propagated from a failed generate call does NOT contain the API key", async () => {
    // We mock generateText to simulate a downstream SDK error that might
    // accidentally echo back configuration details.
    vi.mock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        generateText: vi.fn().mockRejectedValue(
          new Error(`Authentication failed. Key: ${FAKE_KEY}`)
        ),
        generateObject: vi.fn().mockRejectedValue(
          new Error(`Authentication failed. Key: ${FAKE_KEY}`)
        ),
      };
    });

    withEnv(KEY_ENV, FAKE_KEY, async () => {
      // We cannot use withEnv's synchronous wrapper for async; set directly.
    });

    process.env[KEY_ENV] = FAKE_KEY;
    let caughtMessage = "";
    try {
      await llmGenerateText({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        prompt: "Hello",
        apiKeyEnv: KEY_ENV,
      });
    } catch (e) {
      caughtMessage = (e as Error).message;
    } finally {
      delete process.env[KEY_ENV];
      vi.restoreAllMocks();
    }

    // The raw SDK error may contain the key; the adapter must not re-throw it
    // verbatim if it does. This test documents the expectation.
    // NOTE: If the adapter does not sanitise SDK errors today, this test will
    // fail and drive the fix.
    expect(caughtMessage).not.toContain(FAKE_KEY);
  });
});

// ---------------------------------------------------------------------------
// llmGenerateText — missing key propagates before any network call
// ---------------------------------------------------------------------------

describe("llmGenerateText – missing key fails fast", () => {
  // OWASP A05: Security Misconfiguration
  it("rejects with SpecGuardError before attempting a network call when key is absent", async () => {
    withEnv(KEY_ENV, undefined, () => {});
    delete process.env[KEY_ENV];

    await expect(
      llmGenerateText({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        prompt: "Hello",
        apiKeyEnv: KEY_ENV,
      })
    ).rejects.toBeInstanceOf(SpecGuardError);
  });
});

// ---------------------------------------------------------------------------
// llmGenerateObject — missing key propagates before any network call
// ---------------------------------------------------------------------------

describe("llmGenerateObject – missing key fails fast", () => {
  // OWASP A05: Security Misconfiguration
  it("rejects with SpecGuardError before attempting a network call when key is absent", async () => {
    delete process.env[KEY_ENV];

    await expect(
      llmGenerateObject({
        provider: "openai",
        model: "gpt-4o",
        prompt: "Return JSON",
        apiKeyEnv: KEY_ENV,
        schema: z.object({ result: z.string() }),
      })
    ).rejects.toBeInstanceOf(SpecGuardError);
  });
});

// ---------------------------------------------------------------------------
// llmGenerateObject — key secrecy in thrown errors
// ---------------------------------------------------------------------------

describe("llmGenerateObject – API key never surfaces in thrown errors", () => {
  // OWASP A09: Security Logging and Monitoring Failures
  it("SpecGuardError for missing key does NOT contain any key-like value", async () => {
    delete process.env[KEY_ENV];

    let msg = "";
    try {
      await llmGenerateObject({
        provider: "openai",
        model: "gpt-4o",
        prompt: "Return JSON",
        apiKeyEnv: KEY_ENV,
        schema: z.object({ result: z.string() }),
      });
    } catch (e) {
      msg = (e as Error).message;
    }

    expect(msg).toContain(KEY_ENV);
    expect(msg).not.toContain(FAKE_KEY);
    expect(msg).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

// ---------------------------------------------------------------------------
// Key isolation — the resolved key must not be persisted or re-exported
// ---------------------------------------------------------------------------

describe("Module surface area – API key isolation", () => {
  // OWASP A02: Cryptographic Failures (sensitive data exposure)
  // The module must not export the resolved key or attach it to any
  // long-lived object accessible from outside the call.
  it("resolveModel return value does not expose the raw API key string", () => {
    process.env[KEY_ENV] = FAKE_KEY;
    let model: unknown;
    try {
      model = resolveModel("anthropic", "claude-3-5-sonnet-20241022", KEY_ENV);
    } finally {
      delete process.env[KEY_ENV];
    }

    // Serialise the model to a string and ensure the key is not present.
    const serialised = JSON.stringify(model) ?? "";
    expect(serialised).not.toContain(FAKE_KEY);
  });

  // OWASP A02: Cryptographic Failures (sensitive data exposure)
  it("resolveModel return value does not expose the raw API key in enumerable properties", () => {
    process.env[KEY_ENV] = FAKE_KEY;
    let model: Record<string, unknown> = {};
    try {
      model = resolveModel("anthropic", "claude-3-5-sonnet-20241022", KEY_ENV) as Record<string, unknown>;
    } finally {
      delete process.env[KEY_ENV];
    }

    const allValues = Object.values(model).map(String).join(" ");
    expect(allValues).not.toContain(FAKE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Input validation — prompt / system injection surface
// ---------------------------------------------------------------------------

describe("resolveModel – provider input is not used as a key lookup bypass", () => {
  // OWASP A03: Injection
  // A crafted provider string must not bypass the allowlist and must not
  // cause the key value to appear in the error.
  it("rejects a provider string containing shell-injection characters", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      expect(() =>
        resolveModel("anthropic; echo $TEST_LLM_API_KEY", "model", KEY_ENV)
      ).toThrowError(SpecGuardError);
    });
  });

  // OWASP A03: Injection
  it("rejects a provider string that is a prototype-pollution attempt", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      expect(() =>
        resolveModel("__proto__", "model", KEY_ENV)
      ).toThrowError(SpecGuardError);
    });
  });

  // OWASP A03: Injection
  it("rejects a provider string that is 'constructor'", () => {
    withEnv(KEY_ENV, FAKE_KEY, () => {
      expect(() =>
        resolveModel("constructor", "model", KEY_ENV)
      ).toThrowError(SpecGuardError);
    });
  });
});
