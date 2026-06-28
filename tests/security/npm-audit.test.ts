import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runNpmAudit, npmAuditRunner, type NpmAuditResult } from "../src/adapters/npm-audit.js";

describe("npm-audit adapter – OWASP-annotated security tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // The adapter must never throw; it must degrade gracefully when npm is absent.
  // ---------------------------------------------------------------------------
  it("returns ok:false and empty findings when npm is unavailable (spawn error)", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: null,
      status: null,
      error: new Error("spawn npm ENOENT"),
    });

    const result: NpmAuditResult = await runNpmAudit("/some/project");

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // Malformed / truncated JSON from npm audit must not crash the pipeline.
  // ---------------------------------------------------------------------------
  it("returns ok:false and empty findings when stdout is not valid JSON", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: "not-json{{{{",
      status: 0,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // Empty stdout must not crash the pipeline.
  // ---------------------------------------------------------------------------
  it("returns ok:false and empty findings when stdout is empty string", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: "",
      status: 0,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // null stdout must not crash the pipeline.
  // ---------------------------------------------------------------------------
  it("returns ok:false and empty findings when stdout is null", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: null,
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // OWASP A03: Injection
  // Package names containing shell-special characters must be stored verbatim
  // in ruleId/message without being interpreted or truncated.
  // ---------------------------------------------------------------------------
  it("stores package names with shell-special characters verbatim (v2 format)", async () => {
    const maliciousPkg = "evil-pkg; rm -rf /";
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          [maliciousPkg]: {
            severity: "critical",
            via: [{ title: "RCE via name", url: "https://example.com" }],
          },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe(`npm-audit/${maliciousPkg}`);
    // Must not execute or alter the string
    expect(result.findings[0].ruleId).toContain("rm -rf /");
  });

  // ---------------------------------------------------------------------------
  // OWASP A03: Injection
  // Advisory titles containing script/template injection payloads must be
  // stored verbatim and never evaluated.
  // ---------------------------------------------------------------------------
  it("stores XSS/template-injection payloads in message verbatim (v1 format)", async () => {
    const xssPayload = '<script>alert("xss")</script>';
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        advisories: {
          "1": {
            module_name: "some-pkg",
            title: xssPayload,
            severity: "high",
          },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(true);
    expect(result.findings[0].message).toBe(xssPayload);
  });

  // ---------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  // The findings array must NOT contain raw npm audit stdout; confidential
  // package metadata must be limited to the normalised SastFinding shape.
  // ---------------------------------------------------------------------------
  it("does not leak raw npm audit stdout into the findings array (v2 format)", async () => {
    const rawStdout = JSON.stringify({
      vulnerabilities: {
        "lodash": {
          severity: "high",
          via: [{ title: "Prototype Pollution", url: "https://example.com" }],
        },
      },
      metadata: { totalDependencies: 999, internalRepoUrl: "https://internal.corp/npm" },
    });

    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: rawStdout,
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("internalRepoUrl");
    expect(serialised).not.toContain("totalDependencies");
    expect(serialised).not.toContain("metadata");
  });

  // ---------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  // The findings array must NOT contain raw npm audit stdout; confidential
  // package metadata must be limited to the normalised SastFinding shape (v1).
  // ---------------------------------------------------------------------------
  it("does not leak raw npm audit stdout into the findings array (v1 format)", async () => {
    const rawStdout = JSON.stringify({
      advisories: {
        "1": {
          module_name: "express",
          title: "Open Redirect",
          severity: "moderate",
          internalNote: "tracked in JIRA-1234",
        },
      },
      metadata: { internalRepoUrl: "https://internal.corp/npm" },
    });

    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: rawStdout,
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("internalNote");
    expect(serialised).not.toContain("internalRepoUrl");
    expect(serialised).not.toContain("JIRA-1234");
  });

  // ---------------------------------------------------------------------------
  // OWASP A08: Software and Data Integrity Failures
  // Severity values must be normalised to uppercase; unexpected values must
  // not cause crashes and must be passed through without silent data loss.
  // ---------------------------------------------------------------------------
  it("normalises severity to uppercase for known values (v2 format)", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          "axios": { severity: "critical", via: [{ title: "SSRF" }] },
          "lodash": { severity: "high", via: [{ title: "Prototype Pollution" }] },
          "moment": { severity: "moderate", via: [{ title: "ReDoS" }] },
          "semver": { severity: "low", via: [{ title: "ReDoS" }] },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(true);
    const severities = result.findings.map((f) => f.severity);
    expect(severities).toContain("CRITICAL");
    expect(severities).toContain("HIGH");
    expect(severities).toContain("MODERATE");
    expect(severities).toContain("LOW");
    // Must not contain lowercase originals
    expect(severities).not.toContain("critical");
    expect(severities).not.toContain("high");
  });

  // ---------------------------------------------------------------------------
  // OWASP A08: Software and Data Integrity Failures
  // An unknown/missing severity must not crash the adapter.
  // ---------------------------------------------------------------------------
  it("handles missing severity without crashing (v2 format)", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          "unknown-pkg": { via: [{ title: "Something" }] },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // OWASP A08: Software and Data Integrity Failures
  // path field must always be 'package.json' — never a user-controlled value.
  // ---------------------------------------------------------------------------
  it("always sets path to 'package.json' regardless of audit content (v2)", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          "lodash": { severity: "high", via: [{ title: "Prototype Pollution" }] },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.findings.every((f) => f.path === "package.json")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // OWASP A08: Software and Data Integrity Failures
  // path field must always be 'package.json' — never a user-controlled value (v1).
  // ---------------------------------------------------------------------------
  it("always sets path to 'package.json' regardless of audit content (v1)", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        advisories: {
          "1": { module_name: "express", title: "Open Redirect", severity: "moderate" },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.findings.every((f) => f.path === "package.json")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // A JSON document with neither 'vulnerabilities' nor 'advisories' keys must
  // return ok:true with an empty findings array (not crash).
  // ---------------------------------------------------------------------------
  it("returns ok:true with empty findings for unrecognised JSON shape", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({ someOtherKey: {} }),
      status: 0,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // OWASP A03: Injection
  // A deeply nested or prototype-polluting JSON payload must not affect the
  // host process (e.g. via __proto__ or constructor keys).
  // ---------------------------------------------------------------------------
  it("is resilient to prototype-pollution payloads in audit JSON (v2 format)", async () => {
    const pollutedJson = JSON.stringify({
      vulnerabilities: {
        "__proto__": { severity: "critical", via: [{ title: "Pollution" }] },
        "constructor": { severity: "high", via: [{ title: "Ctor" }] },
      },
    });

    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: pollutedJson,
      status: 1,
    });

    // Must not throw
    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(true);
    // Object prototype must not have been polluted
    expect(({} as Record<string, unknown>).severity).toBeUndefined();
    expect(({} as Record<string, unknown>).title).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // An extremely large number of vulnerabilities must not cause an OOM crash;
  // the adapter must return a findings array without throwing.
  // ---------------------------------------------------------------------------
  it("handles a large number of vulnerabilities without crashing", async () => {
    const vulnerabilities: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) {
      vulnerabilities[`pkg-${i}`] = {
        severity: "low",
        via: [{ title: `Issue ${i}` }],
      };
    }

    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({ vulnerabilities }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(5000);
  });

  // ---------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  // The ruleId must be scoped to 'npm-audit/<pkg>' — never expose an arbitrary
  // attacker-controlled prefix that could collide with other rule namespaces.
  // ---------------------------------------------------------------------------
  it("scopes ruleId to npm-audit/ namespace for v2 findings", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          "lodash": { severity: "high", via: [{ title: "Prototype Pollution" }] },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.findings[0].ruleId).toMatch(/^npm-audit\//);
  });

  // ---------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  // The ruleId must be scoped to 'npm-audit/<pkg>' for v1 findings.
  // ---------------------------------------------------------------------------
  it("scopes ruleId to npm-audit/ namespace for v1 findings", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturnValue({
      stdout: JSON.stringify({
        advisories: {
          "1": { module_name: "express", title: "Open Redirect", severity: "moderate" },
        },
      }),
      status: 1,
    });

    const result = await runNpmAudit("/some/project");

    expect(result.findings[0].ruleId).toMatch(/^npm-audit\//);
  });

  // ---------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // When via array is empty the package name must be used as the message
  // fallback — no undefined/null must leak into the findings.
  // ---------------------------------------------------------------------------
  it("falls back to package name as message when via array is empty (v2)", async () => {
    vi.spyOn(npmAuditRunner, "run").mockReturn
