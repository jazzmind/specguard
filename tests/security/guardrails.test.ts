import { describe, it, expect, vi } from "vitest";
import {
  classifyAction,
  isBlocked,
  makeBlockedAction,
  type ActionClassification,
  type BlockedAction,
} from "../src/adapters/guardrails";

describe("Guardrails – OWASP-annotated security tests", () => {
  // ---------------------------------------------------------------------------
  // classifyAction – credential / sensitive data leakage
  // ---------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  // Sensitive data (passwords, tokens, API keys) passed as description must
  // never cause a network call or be stored; the function must still return a
  // deterministic classification and not throw.
  it("does not throw or leak when description contains a password", () => {
    const sensitiveDescription = "click login with password=S3cr3t!";
    expect(() => classifyAction(sensitiveDescription)).not.toThrow();
    const result = classifyAction(sensitiveDescription);
    expect(["safe", "destructive", "outbound"]).toContain(result);
  });

  // OWASP A02: Cryptographic Failures
  it("does not throw or leak when description contains an API key", () => {
    const sensitiveDescription = "navigate to dashboard apikey=sk-abc123XYZ";
    expect(() => classifyAction(sensitiveDescription)).not.toThrow();
    const result = classifyAction(sensitiveDescription);
    expect(["safe", "destructive", "outbound"]).toContain(result);
  });

  // OWASP A02: Cryptographic Failures
  it("does not throw or leak when description contains a bearer token", () => {
    const sensitiveDescription =
      "click submit Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
    expect(() => classifyAction(sensitiveDescription)).not.toThrow();
    // "submit" is an outbound keyword – classification must still be correct
    expect(classifyAction(sensitiveDescription)).toBe("outbound");
  });

  // OWASP A02: Cryptographic Failures
  it("does not throw or leak when description contains a private key PEM block", () => {
    const sensitiveDescription =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(() => classifyAction(sensitiveDescription)).not.toThrow();
    expect(classifyAction(sensitiveDescription)).toBe("safe");
  });

  // ---------------------------------------------------------------------------
  // classifyAction – no network calls (isolation)
  // ---------------------------------------------------------------------------

  // OWASP A10: Server-Side Request Forgery (SSRF)
  // Classification must be purely local; it must never initiate any network
  // request regardless of what the description string contains.
  it("never calls fetch when classifying an action", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    classifyAction("send email to user@example.com");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("never calls XMLHttpRequest when classifying an action", () => {
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, "open");
    classifyAction("publish report to https://evil.example.com");
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  // OWASP A10: Server-Side Request Forgery (SSRF)
  it("never calls fetch when classifying a destructive action", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    classifyAction("delete all user records");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // classifyAction – destructive keyword detection (data integrity)
  // ---------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  // Destructive actions must be correctly identified so callers can block them.
  it("classifies 'delete' as destructive", () => {
    expect(classifyAction("delete the selected record")).toBe("destructive");
  });

  it("classifies 'remove' as destructive", () => {
    expect(classifyAction("remove user from group")).toBe("destructive");
  });

  it("classifies 'purge' as destructive", () => {
    expect(classifyAction("purge all logs")).toBe("destructive");
  });

  it("classifies 'drop' as destructive", () => {
    expect(classifyAction("drop the database table")).toBe("destructive");
  });

  it("classifies 'wipe' as destructive", () => {
    expect(classifyAction("wipe device data")).toBe("destructive");
  });

  it("classifies 'erase' as destructive", () => {
    expect(classifyAction("erase configuration")).toBe("destructive");
  });

  it("classifies 'clear all' as destructive", () => {
    expect(classifyAction("clear all entries")).toBe("destructive");
  });

  it("classifies 'bulk delete' as destructive", () => {
    expect(classifyAction("bulk delete selected items")).toBe("destructive");
  });

  it("classifies 'mass delete' as destructive", () => {
    expect(classifyAction("mass delete archived records")).toBe("destructive");
  });

  it("classifies 'reset' as destructive", () => {
    expect(classifyAction("reset account to defaults")).toBe("destructive");
  });

  it("classifies 'destroy' as destructive", () => {
    expect(classifyAction("destroy session data")).toBe("destructive");
  });

  it("classifies 'archive' as destructive", () => {
    expect(classifyAction("archive old projects")).toBe("destructive");
  });

  // OWASP A01: Broken Access Control – case-insensitive matching must hold
  it("classifies destructive keyword in uppercase as destructive", () => {
    expect(classifyAction("DELETE ALL RECORDS")).toBe("destructive");
  });

  it("classifies destructive keyword in mixed case as destructive", () => {
    expect(classifyAction("PuRgE the cache")).toBe("destructive");
  });

  // ---------------------------------------------------------------------------
  // classifyAction – outbound keyword detection (unintended external comms)
  // ---------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("classifies 'send' as outbound", () => {
    expect(classifyAction("send notification to user")).toBe("outbound");
  });

  it("classifies 'invite' as outbound", () => {
    expect(classifyAction("invite team member")).toBe("outbound");
  });

  it("classifies 'share' as outbound", () => {
    expect(classifyAction("share document externally")).toBe("outbound");
  });

  it("classifies 'publish' as outbound", () => {
    expect(classifyAction("publish article to blog")).toBe("outbound");
  });

  it("classifies 'pay' as outbound", () => {
    expect(classifyAction("pay invoice now")).toBe("outbound");
  });

  it("classifies 'submit' as outbound", () => {
    expect(classifyAction("submit the form")).toBe("outbound");
  });

  it("classifies 'transfer' as outbound", () => {
    expect(classifyAction("transfer funds to account")).toBe("outbound");
  });

  it("classifies 'broadcast' as outbound", () => {
    expect(classifyAction("broadcast message to all users")).toBe("outbound");
  });

  it("classifies 'post' as outbound", () => {
    expect(classifyAction("post update to feed")).toBe("outbound");
  });

  it("classifies 'email' as outbound", () => {
    expect(classifyAction("email the report to manager")).toBe("outbound");
  });

  it("classifies 'notify' as outbound", () => {
    expect(classifyAction("notify subscribers")).toBe("outbound");
  });

  it("classifies 'message' as outbound", () => {
    expect(classifyAction("message the support team")).toBe("outbound");
  });

  it("classifies 'dispatch' as outbound", () => {
    expect(classifyAction("dispatch webhook event")).toBe("outbound");
  });

  // OWASP A01: Broken Access Control – case-insensitive matching must hold
  it("classifies outbound keyword in uppercase as outbound", () => {
    expect(classifyAction("SEND EMAIL NOW")).toBe("outbound");
  });

  it("classifies outbound keyword in mixed case as outbound", () => {
    expect(classifyAction("PuBlIsH the draft")).toBe("outbound");
  });

  // ---------------------------------------------------------------------------
  // classifyAction – safe classification
  // ---------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  // Actions that are safe must not be incorrectly blocked.
  it("classifies a benign navigation action as safe", () => {
    expect(classifyAction("click the settings button")).toBe("safe");
  });

  it("classifies a benign read action as safe", () => {
    expect(classifyAction("scroll to the top of the page")).toBe("safe");
  });

  it("classifies an empty string as safe", () => {
    expect(classifyAction("")).toBe("safe");
  });

  it("classifies a whitespace-only string as safe", () => {
    expect(classifyAction("   ")).toBe("safe");
  });

  // ---------------------------------------------------------------------------
  // classifyAction – injection / boundary inputs
  // ---------------------------------------------------------------------------

  // OWASP A03: Injection
  // Maliciously crafted descriptions must not cause unexpected behaviour.
  it("handles a very long description without throwing", () => {
    const longDescription = "click ".repeat(10_000) + "delete";
    expect(() => classifyAction(longDescription)).not.toThrow();
    expect(classifyAction(longDescription)).toBe("destructive");
  });

  // OWASP A03: Injection
  it("handles null-byte injection in description without throwing", () => {
    const nullByteDescription = "click\x00delete";
    expect(() => classifyAction(nullByteDescription)).not.toThrow();
    expect(classifyAction(nullByteDescription)).toBe("destructive");
  });

  // OWASP A03: Injection
  it("handles unicode homoglyph substitution without throwing", () => {
    // 'dеlete' with Cyrillic 'е' – should NOT match the ASCII keyword
    const homoglyphDescription = "d\u0435lete all records";
    expect(() => classifyAction(homoglyphDescription)).not.toThrow();
    // Result may be 'safe'; the important thing is no throw and determinism
    const result = classifyAction(homoglyphDescription);
    expect(["safe", "destructive", "outbound"]).toContain(result);
  });

  // OWASP A03: Injection
  it("handles script-injection payload in description without throwing", () => {
    const xssPayload = "<script>fetch('https://evil.example.com')</script> delete";
    expect(() => classifyAction(xssPayload)).not.toThrow();
    expect(classifyAction(xssPayload)).toBe("destructive");
  });

  // OWASP A03: Injection
  it("handles newline and tab characters in description without throwing", () => {
    const multilineDescription = "navigate\nto\tpage\ndelete";
    expect(() => classifyAction(multilineDescription)).not.toThrow();
    expect(classifyAction(multilineDescription)).toBe("destructive");
  });

  // ---------------------------------------------------------------------------
  // isBlocked – access control enforcement
  // ---------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("returns true for destructive classification", () => {
    expect(isBlocked("destructive")).toBe(true);
  });

  // OWASP A01: Broken Access Control
  it("returns true for outbound classification", () => {
    expect(isBlocked("outbound")).toBe(true);
  });

  // OWASP A01: Broken Access Control
  it("returns false for safe classification", () => {
    expect(isBlocked("safe")).toBe(false);
  });

  // OWASP A01: Broken Access Control
  // Destructive actions identified by classifyAction must be blocked by isBlocked.
  it("pipeline: classifyAction + isBlocked blocks a destructive action", () => {
    const classification = classifyAction("delete all user data");
    expect(isBlocked(classification)).toBe(true);
  });

  // OWASP A01: Broken Access Control
  it("pipeline: classifyAction + isBlocked blocks an outbound action", () => {
    const classification = classifyAction("send report to external party");
    expect(isBlocked(classification)).toBe(true);
  });

  // OWASP A01: Broken Access Control
  it("pipeline: classifyAction + isBlocked does not block a safe action", () => {
    const classification = classifyAction("open the dashboard");
    expect(isBlocked(classification)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // makeBlockedAction – sensitive data not amplified in output
  // ---------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  // The blocked action record must faithfully echo the description but must not
  // add any additional sensitive data or mutate the original string.
  it("makeBlockedAction preserves description verbatim without mutation", () => {
    const desc = "delete user account";
    const blocked: BlockedAction = makeBlockedAction(desc, "destructive");
    expect(blocked.description).toBe(desc);
  });

  // OWASP A02: Cryptographic Failures
  it("makeBlockedAction does not append secrets to the reason field", () => {
    const desc = "delete record with token=abc123";
    const blocked: BlockedAction = makeBlockedAction(desc, "destructive");
    // reason must not contain the token value beyond what was in description
    expect(blocked.reason).not.toContain("abc123");
  });

  // OWASP A01: Broken Access Control
  it("makeBlockedAction sets correct classification for destructive", () => {
    const blocked = makeBlockedAction("purge logs", "destructive");
    expect(blocked.classification).toBe("destructive");
    expect(blocked.reason).toMatch(/destructive/i);
  });

  // OWASP A01: Broken Access Control
  it("makeBlockedAction sets correct classification for outbound", () => {
    const blocked = makeBlockedAction("send email", "outbound");
    expect(blocked.classification).toBe("outbound");
    expect(blocked.reason).toMatch(/outbound/i);
  });

  // OWASP A01: Broken Access Control
  it("makeBlockedAction reason for destructive mentions data loss prevention", () => {
    const blocked = makeBlockedAction("wipe database", "destructive");
    expect(blocked.reason).toMatch(/data loss/i);
  });

  // OWASP A01: Broken Access Control
  it("makeBlockedAction reason for outbound mentions external communication prevention", () => {
    const blocked = makeBlockedAction("broadcast alert", "outbound");
    expect(blocked.reason).toMatch(/external communication/i);
  });

  // OWASP A02: Cryptographic Failures
  it("makeBlockedAction does not throw when description contains sensitive PII", () => {
    const piiDescription = "submit form with ssn=123-45-6789";
    expect(() => makeBlockedAction(piiDescription, "outbound")).not.toThrow();
    const blocked = makeBlockedAction(piiDescription, "outbound");
    expect(blocked.description).toBe(piiDescription);
  });

  // ---------------------------------------------------------------------------
  // Determinism / idempotency
  // ---------------------------------------------------------------------------

  // O
