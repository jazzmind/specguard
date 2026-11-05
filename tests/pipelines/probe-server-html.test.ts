import { describe, expect, it } from 'vitest';
import { probeServer } from '../../src/pipelines/publish.js';

const htmlFetch = (url: string): typeof fetch =>
  (async () => Object.defineProperty(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'url', { value: url })) as unknown as typeof fetch;

describe('probeServer with a non-API answer', () => {
  it('names the sign-in gate instead of a JSON parse error', async () => {
    const p = await probeServer('http://h/specguard', htmlFetch('http://h/auth/login'));
    expect(p.reachable).toBe(false);
    expect(p.error).toMatch(/sign-in page/);
    expect(p.error).not.toMatch(/Unexpected token/);
  });
  it('names a wrong URL when the page is not a login', async () => {
    const p = await probeServer('http://h/specguard', htmlFetch('http://h/specguard/api/v1/health'));
    expect(p.error).toMatch(/web page/);
  });
});
