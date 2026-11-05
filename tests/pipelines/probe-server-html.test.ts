import { describe, expect, it } from 'vitest';
import { probeServer } from '../../src/pipelines/publish.js';

const htmlFetch = (url: string): typeof fetch =>
  (async () => Object.defineProperty(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'url', { value: url })) as unknown as typeof fetch;

describe('probeServer with a non-API answer', () => {
  it('names the sign-in gate instead of a JSON parse error', async () => {
    const p = await probeServer('http://h/specguard', htmlFetch('http://h/auth/login'));
    expect(p.reachable).toBe(false);
    expect(p.error).toMatch(/no SpecGuard token was found/);
    expect(p.error).not.toMatch(/Unexpected token/);
  });
  it('says the token was not accepted when one was sent', async () => {
    const p = await probeServer('http://h/specguard', htmlFetch('http://h/auth/login'), 1000, 'tok');
    expect(p.error).toMatch(/even though a token was sent/);
  });
  it('sends the token as a Bearer header', async () => {
    let seen = '';
    const f = (async (_u: string, init: RequestInit) => { seen = String((init.headers as Record<string, string>).Authorization); return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    await probeServer('http://h/specguard', f, 1000, 'tok');
    expect(seen).toBe('Bearer tok');
  });
  it('names a wrong URL when the page is not a login', async () => {
    const p = await probeServer('http://h/specguard', htmlFetch('http://h/specguard/api/v1/health'));
    expect(p.error).toMatch(/web page/);
  });
});
