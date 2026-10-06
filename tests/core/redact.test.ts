import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRedactor, loadRedactHook, luhnValid } from '../../src/core/redact.js';

describe('built-in masks', () => {
  const r = createRedactor();

  it('masks emails', () => {
    expect(r.text('Contact jane.doe+tag@example.co.uk now')).toBe('Contact [EMAIL] now');
    expect(r.text('value="a@b.io"')).toBe('value="[EMAIL]"');
  });

  it('masks phone numbers in common shapes and leaves other numbers alone', () => {
    for (const phone of ['(555) 123-4567', '555-123-4567', '555.123.4567', '+1 555 123 4567', '5551234567', '+44 20 7946 0958']) {
      expect(r.text(`call ${phone} today`)).toBe('call [PHONE] today');
    }
    expect(r.text('order 12345 total 99.50 on 2026-10-05')).toBe('order 12345 total 99.50 on 2026-10-05');
  });

  it('masks US social security numbers', () => {
    expect(r.text('SSN 123-45-6789 and 123 45 6789')).toBe('SSN [SSN] and [SSN]');
    expect(r.text('part 123-45-67890')).not.toContain('[SSN]');
  });

  it('masks payment cards that pass the Luhn check, not arbitrary long numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(r.text('card 4111 1111 1111 1111 ok')).toBe('card [CARD] ok');
    expect(r.text('card 4111-1111-1111-1111 ok')).toBe('card [CARD] ok');
    expect(r.text('tracking 1234567890123456')).toBe('tracking 1234567890123456');
  });

  it('masks bearer tokens, JWTs and API keys', () => {
    expect(r.text('Authorization: Bearer abcdefghijklmnop12345')).toBe('Authorization: Bearer [TOKEN]');
    expect(r.text('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fw ok')).toBe('jwt [TOKEN] ok');
    expect(r.text('key sk-abcdefghijklmnopqrstuv end')).toBe('key [KEY] end');
    expect(r.text('aws AKIAABCDEFGHIJKLMNOP end')).toBe('aws [KEY] end');
  });

  it('leaves clean text untouched', () => {
    const text = 'The dashboard shows 3 projects and 14 tasks.';
    expect(r.text(text)).toBe(text);
  });
});

describe('configuration', () => {
  it('builtin:false with nothing else is the identity; custom patterns still apply', () => {
    const off = createRedactor({ builtin: false });
    expect(off.text('a@b.com')).toBe('a@b.com');
    const custom = createRedactor({ builtin: false, patterns: ['ACCT-\\d+', '('] });
    expect(custom.text('id ACCT-99 and a@b.com')).toBe('id [REDACTED] and a@b.com');
  });

  it('exposes the selectors to blank', () => {
    expect(createRedactor({ blankSelectors: ['.ssn', '[data-pii]'] }).blankSelectors).toEqual(['.ssn', '[data-pii]']);
  });

  it('runs the hook after the masks and tells it what kind of text it is', () => {
    const seen: string[] = [];
    const r = createRedactor({}, (text, kind) => {
      seen.push(kind);
      return text.replace(/Acme/g, '[CO]');
    });
    expect(r.text('Acme: a@b.com', 'dom')).toBe('[CO]: [EMAIL]');
    expect(seen).toEqual(['dom']);
  });

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

  it('loads a default-exported function from inside the project', async () => {
    const dir = project();
    writeFileSync(path.join(dir, 'hooks', 'redact.mjs'), 'export default (text, kind) => `${kind}:${text.toUpperCase()}`;');
    const hook = await loadRedactHook(dir, 'hooks/redact.mjs');
    expect(hook('x', 'dom')).toBe('dom:X');
  });

  it('rejects a missing hook, a non-function export, and a path outside the project', async () => {
    const dir = project();
    await expect(loadRedactHook(dir, 'hooks/nope.mjs')).rejects.toThrow(/not found/);
    writeFileSync(path.join(dir, 'hooks', 'bad.mjs'), 'export default 42;');
    await expect(loadRedactHook(dir, 'hooks/bad.mjs')).rejects.toThrow(/default function/);
    await expect(loadRedactHook(dir, '../outside.mjs')).rejects.toThrow(/inside the project/);
  });
});
