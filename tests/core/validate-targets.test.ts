import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkAgentTarget } from '../../src/core/validate-targets.js';
import { pruneEvidence } from '../../src/pipelines/validate.js';

describe('where an agent may point the browser check [validate-targets]', () => {
  const ok = (url: string, allowed: string[] = []) => checkAgentTarget(url, allowed).ok;

  // [claims: capabilities/agentic-verification#agent-target-allowlist]
  it('allows loopback always, and nothing else unless listed', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1/', 'http://[::1]:8080/x', 'https://app.localhost']) expect(ok(u), u).toBe(true);
    for (const u of ['https://example.com', 'http://169.254.169.254/', 'http://10.0.0.5/admin', 'http://intranet/']) expect(ok(u), u).toBe(false);
  });

  // [claims: capabilities/agentic-verification#agent-target-allowlist]
  it('matches a listed host on any port, a host:port on that port only, and a wildcard on subdomains only', () => {
    expect(ok('https://staging.example.com/x', ['staging.example.com'])).toBe(true);
    expect(ok('https://staging.example.com:9443/x', ['staging.example.com'])).toBe(true);
    expect(ok('https://staging.example.com:8443/', ['staging.example.com:8443'])).toBe(true);
    expect(ok('https://staging.example.com:9443/', ['staging.example.com:8443'])).toBe(false);
    expect(ok('https://staging.example.com/', ['staging.example.com:8443'])).toBe(false);
    expect(ok('https://a.test.example.com', ['*.test.example.com'])).toBe(true);
    expect(ok('https://test.example.com', ['*.test.example.com'])).toBe(false);
    expect(ok('https://evil-test.example.com', ['*.test.example.com'])).toBe(false);
    expect(ok('https://staging.example.com.evil.net', ['staging.example.com'])).toBe(false);
    expect(ok('https://STAGING.example.com', [' Staging.Example.com '])).toBe(true);
  });

  // [claims: capabilities/agentic-verification#agent-target-allowlist]
  it('refuses non-http URLs and text that is not a URL, with a reason', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/', 'not a url', '']) {
      const r = checkAgentTarget(u, ['x']);
      expect(r.ok, u).toBe(false);
      expect((r as { reason: string }).reason.length).toBeGreaterThan(5);
    }
  });
});

describe('evidence retention [evidence-retention]', () => {
  // [claims: capabilities/agentic-verification#evidence-retention]
  it('removes files older than the retention period, keeps newer ones and the .gitignore marker, and drops emptied folders', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-ev-'));
    mkdirSync(path.join(dir, 'auth'));
    mkdirSync(path.join(dir, 'old-only'));
    writeFileSync(path.join(dir, '.gitignore'), '*\n');
    writeFileSync(path.join(dir, 'auth', 'new.png'), 'x');
    writeFileSync(path.join(dir, 'auth', 'old.png'), 'x');
    writeFileSync(path.join(dir, 'old-only', 'a.png'), 'x');
    const old = new Date(Date.now() - 45 * 86_400_000);
    utimesSync(path.join(dir, 'auth', 'old.png'), old, old);
    utimesSync(path.join(dir, 'old-only', 'a.png'), old, old);
    utimesSync(path.join(dir, '.gitignore'), old, old);
    expect(pruneEvidence(dir, 30)).toBe(2);
    expect(existsSync(path.join(dir, 'auth', 'new.png'))).toBe(true);
    expect(existsSync(path.join(dir, 'auth', 'old.png'))).toBe(false);
    expect(existsSync(path.join(dir, 'old-only'))).toBe(false);
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(true);
    expect(pruneEvidence(path.join(dir, 'missing'), 30)).toBe(0);
  });
});
