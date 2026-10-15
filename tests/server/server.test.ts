import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(opts: Parameters<typeof startServer>[1] = {}) {
  const repo = makeV2Repo();
  server = await startServer(await loadConfig(repo.dir), { port: 0, ...opts });
  return server;
}

function request(port: number, opts: { method?: string; path?: string; host?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/', method: opts.method ?? 'GET', headers: opts.host ? { Host: opts.host } : undefined }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server [serve]', () => {
  it('serves the API and the UI on a real socket [serves]', async () => {
    const s = await start();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await request(s.port, { path: '/api/v1/health' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, version: 1, apiVersion: 1, hashVersion: 1 });
    const ui = await request(s.port, { path: '/' });
    expect(ui.headers['content-type']).toContain('text/html');
    expect(ui.headers['content-security-policy']).toContain("default-src 'self'");
    expect(ui.headers['x-content-type-options']).toBe('nosniff');
    expect(ui.headers['cache-control']).toBe('no-store');
  });

  // [claims: capabilities/documentation-api#serve-host-guard]
  it('refuses a Host header that is not a local name, which blocks DNS rebinding [host-guard]', async () => {
    const s = await start();
    const evil = await request(s.port, { path: '/api/v1/system', host: 'evil.example' });
    expect(evil.status).toBe(403);
    expect((await request(s.port, { path: '/api/v1/health', host: 'localhost:4317' })).status).toBe(200);
    expect((await request(s.port, { path: '/api/v1/health', host: '127.0.0.1' })).status).toBe(200);
  });

  // [claims: capabilities/documentation-api#serve-readonly]
  it('answers a malformed request target with 400 and keeps serving, instead of crashing the process [bad-target]', async () => {
    const s = await start();
    const raw = (target: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(s.port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
        let out = '';
        socket.on('data', (c) => (out += c));
        socket.on('close', () => resolve(out));
      });
    for (const target of ['//[', '//a:b:c']) expect(await raw(target)).toMatch(/^HTTP\/1\.1 400/);
    // Broken HTTP framing is answered at the socket, not thrown.
    const garbage = await new Promise<string>((resolve) => {
      const socket = net.connect(s.port, '127.0.0.1', () => socket.write('NOT HTTP AT ALL\r\n\r\n'));
      let out = '';
      socket.on('data', (c) => (out += c));
      socket.on('close', () => resolve(out));
    });
    expect(garbage).toMatch(/^HTTP\/1\.1 400/);
    expect((await request(s.port, { path: '/api/v1/health' })).status).toBe(200);
    expect((await request(s.port, { path: '/api/v1/docs/%E0%A4%A' })).status).toBeLessThan(500);
  });

  // [claims: capabilities/documentation-api#serve-host-guard]
  it('allows no cross-origin reads unless an origin is named [cors]', async () => {
    const closed = await start();
    expect((await request(closed.port, { path: '/api/v1/health' })).headers['access-control-allow-origin']).toBeUndefined();
    await closed.close();
    const open = await start({ cors: 'https://portal.example' });
    expect((await request(open.port, { path: '/api/v1/health' })).headers['access-control-allow-origin']).toBe('https://portal.example');
  });

  // [claims: capabilities/documentation-api#serve-readonly]
  it('is read-only and answers HEAD without a body [methods]', async () => {
    const s = await start();
    expect((await request(s.port, { method: 'POST', path: '/api/v1/system' })).status).toBe(405);
    const head = await request(s.port, { method: 'HEAD', path: '/api/v1/health' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });
});
