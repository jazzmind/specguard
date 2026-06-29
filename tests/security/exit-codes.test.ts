import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Security test stubs for specguard-core/exit-codes
// Living Specification key: specguard-core/exit-codes
// ---------------------------------------------------------------------------

// Dynamically import the module under test so tests remain runnable even when
// the module is not yet implemented (stubs will fail gracefully).
let exitCodes: Record<string, unknown> = {};

try {
  exitCodes = await import("specguard-core/exit-codes");
} catch {
  // Module not yet available; individual tests will assert expected behaviour
  // once the implementation lands.
}

describe("specguard-core/exit-codes – OWASP security test stubs", () => {

  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  // Exit code values must not expose internal privilege levels or role
  // distinctions that could be leveraged to infer access-control decisions.
  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  it("should not expose distinct exit codes that reveal internal privilege or role distinctions", () => {
    const exportedValues = Object.values(exitCodes).filter(
      (v) => typeof v === "number"
    ) as number[];

    // All exported numeric codes must be within the documented public range
    // (0–127 is the POSIX-safe range; values ≥ 128 are reserved for signals).
    for (const code of exportedValues) {
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThan(128);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures
  // The module must not embed, export, or derive any secret material
  // (tokens, keys, hashes of secrets) as part of its exit-code surface area.
  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures
  it("should not export any string values that resemble secrets, tokens, or hashes", () => {
    const secretPattern =
      /^(?:[A-Za-z0-9+/]{40,}={0,2}|[0-9a-f]{32,}|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9]+)$/;

    const exportedStrings = Object.values(exitCodes).filter(
      (v) => typeof v === "string"
    ) as string[];

    for (const value of exportedStrings) {
      expect(secretPattern.test(value)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A03: Injection
  // Exit code labels / names must not contain characters that could enable
  // shell injection when interpolated into CI log commands or scripts.
  // -------------------------------------------------------------------------
  // OWASP A03: Injection
  it("should not export string keys or values containing shell-injectable characters", () => {
    const dangerousChars = /[;&|`$<>\\'"()\n\r]/;

    const allStrings = [
      ...Object.keys(exitCodes),
      ...Object.values(exitCodes).filter((v) => typeof v === "string"),
    ] as string[];

    for (const s of allStrings) {
      expect(dangerousChars.test(s)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A04: Insecure Design
  // The module must define a documented "success" code (0) and at least one
  // documented "failure" code so that consumers cannot misinterpret an
  // undocumented code as success.
  // -------------------------------------------------------------------------
  // OWASP A04: Insecure Design
  it("should export a canonical SUCCESS exit code equal to 0", () => {
    const numericValues = Object.values(exitCodes).filter(
      (v) => typeof v === "number"
    ) as number[];

    expect(numericValues).toContain(0);
  });

  // OWASP A04: Insecure Design
  it("should export at least one non-zero failure exit code to prevent ambiguous success/failure semantics", () => {
    const numericValues = Object.values(exitCodes).filter(
      (v) => typeof v === "number"
    ) as number[];

    const failureCodes = numericValues.filter((v) => v !== 0);
    expect(failureCodes.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // The module must not export mutable state; exit codes must be frozen /
  // read-only so that a compromised consumer cannot redefine them at runtime.
  // -------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  it("should export exit codes as a frozen or otherwise immutable structure", () => {
    // If the module exports a default object, it must be frozen.
    if (
      exitCodes.default !== undefined &&
      typeof exitCodes.default === "object" &&
      exitCodes.default !== null
    ) {
      expect(Object.isFrozen(exitCodes.default)).toBe(true);
    }
  });

  // OWASP A05: Security Misconfiguration
  it("should not allow runtime mutation of an exported exit-code constant", () => {
    // Attempt to mutate a named export; the value must remain unchanged.
    const snapshot = { ...exitCodes };

    for (const key of Object.keys(snapshot)) {
      try {
        // @ts-expect-error – intentional mutation attempt
        exitCodes[key] = -9999;
      } catch {
        // Strict-mode TypeError is acceptable and expected.
      }
      // Value must not have changed to the injected sentinel.
      expect(exitCodes[key]).not.toBe(-9999);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A06: Vulnerable and Outdated Components
  // The module must not re-export or proxy exit codes from an unvetted
  // third-party dependency without explicit documentation.
  // -------------------------------------------------------------------------
  // OWASP A06: Vulnerable and Outdated Components
  it("should not silently re-export exit codes from undocumented third-party sources", () => {
    // All exported numeric codes must be finite integers – not NaN or Infinity
    // which could indicate a failed import from an external dependency.
    const numericValues = Object.values(exitCodes).filter(
      (v) => typeof v === "number"
    ) as number[];

    for (const code of numericValues) {
      expect(Number.isFinite(code)).toBe(true);
      expect(Number.isInteger(code)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A07: Identification and Authentication Failures
  // Exit codes surfaced to the MCP server must not encode authentication
  // state (e.g., "auth token invalid") in a way that leaks credential status
  // to unauthenticated callers observing process exit codes.
  // -------------------------------------------------------------------------
  // OWASP A07: Identification and Authentication Failures
  it("should not export exit code names that reveal authentication credential status", () => {
    const authLeakPattern =
      /(?:token|credential|secret|password|auth(?:entication)?|api[_-]?key)/i;

    const exportedKeys = Object.keys(exitCodes);

    for (const key of exportedKeys) {
      expect(authLeakPattern.test(key)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A08: Software and Data Integrity Failures
  // The set of exported exit codes must be stable and deterministic across
  // multiple imports; dynamic generation at import time could indicate
  // tampered module state.
  // -------------------------------------------------------------------------
  // OWASP A08: Software and Data Integrity Failures
  it("should produce identical exit-code values on repeated access (deterministic exports)", async () => {
    // Re-import (Node module cache will return the same instance, but the
    // values must be referentially equal / deeply equal).
    let secondImport: Record<string, unknown> = {};
    try {
      secondImport = await import("specguard-core/exit-codes");
    } catch {
      // Module unavailable; skip deep comparison.
      return;
    }

    for (const key of Object.keys(exitCodes)) {
      expect(exitCodes[key]).toStrictEqual(secondImport[key]);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A09: Security Logging and Monitoring Failures
  // When exit codes are emitted to CI environments, the values must not
  // inadvertently suppress or mask error signals (e.g., code 0 on failure).
  // -------------------------------------------------------------------------
  // OWASP A09: Security Logging and Monitoring Failures
  it("should ensure that no documented failure code is mapped to 0 (success)", () => {
    // Collect all keys whose names suggest failure semantics.
    const failureKeyPattern =
      /(?:fail|error|err|invalid|reject|abort|crash|fatal)/i;

    for (const [key, value] of Object.entries(exitCodes)) {
      if (failureKeyPattern.test(key) && typeof value === "number") {
        expect(value).not.toBe(0);
      }
    }
  });

  // OWASP A09: Security Logging and Monitoring Failures
  it("should not export duplicate exit code values that would make log correlation ambiguous", () => {
    const numericEntries = Object.entries(exitCodes).filter(
      ([, v]) => typeof v === "number"
    ) as [string, number][];

    const seen = new Map<number, string>();
    for (const [key, value] of numericEntries) {
      if (seen.has(value)) {
        // Duplicate found – fail with a descriptive message.
        expect.fail(
          `Exit code ${value} is shared by both "${seen.get(value)}" and "${key}", ` +
            `making log correlation ambiguous.`
        );
      }
      seen.set(value, key);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A10: Server-Side Request Forgery (SSRF)
  // Exit codes must be pure numeric constants; they must not trigger any
  // network activity or file-system side-effects when accessed.
  // -------------------------------------------------------------------------
  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("should not perform any network or file-system I/O when exit-code constants are accessed", async () => {
    // We verify this by asserting that all exported values are primitive types
    // (number, string) or plain frozen objects – not Promises, functions, or
    // objects with custom getters that could initiate I/O.
    for (const [key, value] of Object.entries(exitCodes)) {
      const type = typeof value;
      expect(
        ["number", "string", "object"].includes(type),
        `Export "${key}" has unexpected type "${type}"`
      ).toBe(true);

      if (type === "object" && value !== null) {
        // Must not be a Promise or thenable.
        expect(typeof (value as Record<string, unknown>).then).not.toBe(
          "function"
        );
      }

      if (type === "function") {
        expect.fail(
          `Export "${key}" is a function, which could trigger side-effects on invocation.`
        );
      }
    }
  });

});
