import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRedactor, loadRedactHook, luhnValid } from '../../src/core/redact.js';

describe('built-in masks', () => {
  const r = createRedactor();

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('masks emails', () => {
    expect(r.text('Contact jane.doe+tag@example.co.uk now')).toBe('Contact [EMAIL] now');
    expect(r.text('value="a@b.io"')).toBe('value="[EMAIL]"');
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('masks phone numbers in common shapes and leaves other numbers alone', () => {
    for (const phone of ['(555) 123-4567', '555-123-4567', '555.123.4567', '+1 555 123 4567', '5551234567', '+44 20 7946 0958']) {
      expect(r.text(`call ${phone} today`)).toBe('call [PHONE] today');
    }
    expect(r.text('order 12345 total 99.50 on 2026-10-05')).toBe('order 12345 total 99.50 on 2026-10-05');
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('masks US social security numbers', () => {
    expect(r.text('SSN 123-45-6789 and 123 45 6789')).toBe('SSN [SSN] and [SSN]');
    expect(r.text('part 123-45-67890')).not.toContain('[SSN]');
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('masks payment cards that pass the Luhn check, not arbitrary long numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(r.text('card 4111 1111 1111 1111 ok')).toBe('card [CARD] ok');
    expect(r.text('card 4111-1111-1111-1111 ok')).toBe('card [CARD] ok');
    expect(r.text('tracking 1234567890123456')).toBe('tracking 1234567890123456');
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('masks bearer tokens, JWTs and API keys', () => {
    expect(r.text('Authorization: Bearer abcdefghijklmnop12345')).toBe('Authorization: Bearer [TOKEN]');
    expect(r.text('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fw ok')).toBe('jwt [TOKEN] ok');
    expect(r.text('key sk-abcdefghijklmnopqrstuv end')).toBe('key [KEY] end');
    expect(r.text('aws AKIAABCDEFGHIJKLMNOP end')).toBe('aws [KEY] end');
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('leaves clean text untouched', () => {
    const text = 'The dashboard shows 3 projects and 14 tasks.';
    expect(r.text(text)).toBe(text);
  });
});

describe('configuration', () => {
  // [claims: capabilities/platform-foundation#secret-redaction]
  it('builtin:false with nothing else is the identity; custom patterns still apply', () => {
    const off = createRedactor({ builtin: false });
    expect(off.text('a@b.com')).toBe('a@b.com');
    const custom = createRedactor({ builtin: false, patterns: ['ACCT-\\d+', '('] });
    expect(custom.text('id ACCT-99 and a@b.com')).toBe('id [REDACTED] and a@b.com');
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('exposes the selectors to blank', () => {
    expect(createRedactor({ blankSelectors: ['.ssn', '[data-pii]'] }).blankSelectors).toEqual(['.ssn', '[data-pii]']);
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('runs the hook after the masks and tells it what kind of text it is', () => {
    const seen: string[] = [];
    const r = createRedactor({}, (text, kind) => {
      seen.push(kind);
      return text.replace(/Acme/g, '[CO]');
    });
    expect(r.text('Acme: a@b.com', 'dom')).toBe('[CO]: [EMAIL]');
    expect(seen).toEqual(['dom']);
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('a throwing hook never leaks: the built-in result stands', () => {
    const r = createRedactor({}, () => {
      throw new Error('boom');
    });
    expect(r.text('a@b.com')).toBe('[EMAIL]');
  });
});

describe('loadRedactHook', () => {
  const project = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-hook-'));
    mkdirSync(path.join(dir, 'hooks'));
    return dir;
  };

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('loads a default-exported function from inside the project', async () => {
    const dir = project();
    writeFileSync(path.join(dir, 'hooks', 'redact.mjs'), 'export default (text, kind) => `${kind}:${text.toUpperCase()}`;');
    const hook = await loadRedactHook(dir, 'hooks/redact.mjs');
    expect(hook('x', 'dom')).toBe('dom:X');
  });

  // [claims: capabilities/platform-foundation#secret-redaction]
  it('rejects a missing hook, a non-function export, and a path outside the project', async () => {
    const dir = project();
    await expect(loadRedactHook(dir, 'hooks/nope.mjs')).rejects.toThrow(/not found/);
    writeFileSync(path.join(dir, 'hooks', 'bad.mjs'), 'export default 42;');
    await expect(loadRedactHook(dir, 'hooks/bad.mjs')).rejects.toThrow(/default function/);
    await expect(loadRedactHook(dir, '../outside.mjs')).rejects.toThrow(/inside the project/);
  });
});

describe('redaction safety [redact-safety]', () => {
  // [claims: capabilities/documentation-api#served-redaction]
  it('does not mangle ordinary prose that starts with Basic or Bearer, but masks real credentials [prose-vs-token]', async () => {
    const { createSecretRedactor } = await import('../../src/core/redact.js');
    const r = createSecretRedactor();
    expect(r.text('Basic requirements apply. Bearer tokenization is out of scope; basic documentation follows.')).toBe(
      'Basic requirements apply. Bearer tokenization is out of scope; basic documentation follows.',
    );
    expect(r.text('Authorization: Bearer abc123def456ghi789')).toBe('Authorization: Bearer [TOKEN]');
    expect(r.text('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic [TOKEN]');
  });

  // [claims: capabilities/requirement-history#history-redaction]
  it('masks password assignments, private keys and Google keys, and leaves type declarations alone [more-secrets]', async () => {
    const { createSecretRedactor } = await import('../../src/core/redact.js');
    const r = createSecretRedactor();
    expect(r.text('set password=hunter2 then go')).toBe('set password=[SECRET] then go');
    expect(r.text('{ secret: "s3cr3t!" }')).toContain('secret: [SECRET]');
    expect(r.text('token: string; password: Password')).toBe('token: string; password: Password');
    expect(r.text(`key AIza${'a'.repeat(35)} end`)).toBe('key [KEY] end');
    expect(r.text('-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----')).toBe('[PRIVATE KEY]');
  });

  // [claims: capabilities/requirement-history#history-inbox-capture]
  it('redacts a very long run of characters in linear time, because a prompt hook runs it synchronously [no-redos]', () => {
    const r = createRedactor();
    for (const blob of ['a'.repeat(300_000), 'a.'.repeat(150_000), `${'x1-'.repeat(100_000)}`, ' '.repeat(300_000)]) {
      const t0 = Date.now();
      r.text(blob);
      expect(Date.now() - t0).toBeLessThan(1500);
    }
    expect(r.text('write to wes@plymouthrock.com now')).toBe('write to [EMAIL] now');
  });
});
