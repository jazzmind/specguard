import { mkdtempSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { connect, resetProbeCache, serverTarget, ServerUnavailableError } from '../../src/client/index.js';
import { credentialsFile, forgetToken, normalizeServerUrl, readSavedToken, saveToken } from '../../src/client/credentials.js';
import { loadConfig } from '../../src/core/config.js';
import { startTestServer, type TestServer } from '../helpers/central.js';
import { makeRepo } from '../helpers/repo.js';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: mkdtempSync(path.join(os.tmpdir(), 'sg-home-')), ...extra });
let ts: TestServer | undefined;
const stubs: http.Server[] = [];
afterEach(async () => {
  await ts?.stop();
  ts = undefined;
  while (stubs.length) stubs.pop()!.close();
  resetProbeCache();
});

/** A tiny server that answers every request with `body`. */
async function stub(status: number, body: unknown): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  stubs.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const healthy = { ok: true, apiVersion: 1, engineVersion: '0.3.0', hashVersion: 1, writable: true };

describe('credentials [client-credentials]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('saves a token readable by its owner only, per server, and forgets it [save]', () => {
    const e = env();
    expect(readSavedToken('http://sandbox/specguard', e)).toBeUndefined();
    const file = saveToken('http://Sandbox/specguard/', 'sg_abc', e);
    expect(file).toBe(credentialsFile(e));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSavedToken('http://sandbox/specguard', e)).toBe('sg_abc');
    expect(readSavedToken('http://other/specguard', e)).toBeUndefined();
    saveToken('http://other/specguard', 'sg_def', e);
    expect(forgetToken('http://sandbox/specguard', e)).toBe(true);
    expect(forgetToken('http://sandbox/specguard', e)).toBe(false);
    expect(readSavedToken('http://other/specguard', e)).toBe('sg_def');
    expect(normalizeServerUrl('HTTP://Host:80/a//')).toBe('http://host/a');
  });
});

describe('server target [client-target]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('comes from config or the environment, takes the token from env or a saved login, and is absent when off [target]', async () => {
    const e = env();
    const plain = await loadConfig(makeRepo({}).dir);
    expect(serverTarget(plain, e)).toBeNull();
    const repo = makeRepo({ server: { url: 'http://sandbox/specguard/', project: 'portal', timeoutMs: 300 } });
    const config = await loadConfig(repo.dir);
    expect(serverTarget(config, e)).toMatchObject({ url: 'http://sandbox/specguard', project: 'portal', mode: 'auto', timeoutMs: 300 });
    expect(serverTarget(config, e)!.token).toBeUndefined();
    saveToken('http://sandbox/specguard', 'sg_saved', e);
    expect(serverTarget(config, e)!.token).toBe('sg_saved');
    expect(serverTarget(config, { ...e, SPECGUARD_TOKEN: 'sg_env' })!.token).toBe('sg_env');
    expect(serverTarget(config, { ...e, SPECGUARD_SERVER: 'http://elsewhere/sg', SPECGUARD_PROJECT: 'other' })).toMatchObject({ url: 'http://elsewhere/sg', project: 'other' });
    expect(serverTarget(await loadConfig(makeRepo({ server: { url: 'http://x', mode: 'off' } }).dir), e)).toBeNull();
    expect(serverTarget(plain, { ...e, SPECGUARD_SERVER: 'http://x' })).not.toBeNull();
    // With no project named, the directory name is used.
    expect(serverTarget(await loadConfig(makeRepo({ server: { url: 'http://x' } }).dir), e)!.project).toMatch(/^sg-repo-/);
  });
});

describe('connecting [client-connect]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('connects to a healthy server, and returns null with the reason when there is none, in auto mode [auto]', async () => {
    ts = await startTestServer();
    const up = await loadConfig(makeRepo({ server: { url: ts.base, project: 'demo' } }).dir);
    const conn = await connect(up, { env: env() });
    expect(conn).toMatchObject({ hashMismatch: false, health: { ok: true, writable: true, apiVersion: 1 } });
    const reasons: string[] = [];
    // Nothing listens on port 1.
    const down = await loadConfig(makeRepo({ server: { url: 'http://127.0.0.1:1', timeoutMs: 300 } }).dir);
    expect(await connect(down, { env: env(), onFallback: (r) => reasons.push(r) })).toBeNull();
    expect(reasons[0]).toMatch(/cannot reach|no answer/);
    expect(await connect(await loadConfig(makeRepo({}).dir), { env: env() })).toBeNull();
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('treats an unusable server as an error only in required mode [required]', async () => {
    const down = await loadConfig(makeRepo({ server: { url: 'http://127.0.0.1:1', timeoutMs: 300, mode: 'required' } }).dir);
    await expect(connect(down, { env: env() })).rejects.toBeInstanceOf(ServerUnavailableError);
    await expect(connect(down, { env: env() })).rejects.toThrow(/required/);
  });

  // [claims: capabilities/team-server#version-handshake]
  it('refuses a server that is not SpecGuard or speaks another API version, and flags other hash rules [versions]', async () => {
    const reasons: string[] = [];
    const cfg = async (url: string) => loadConfig(makeRepo({ server: { url, timeoutMs: 500 } }).dir);
    expect(await connect(await cfg(await stub(200, { hello: 'world' })), { env: env(), onFallback: (r) => reasons.push(r) })).toBeNull();
    expect(reasons.pop()).toContain('does not look like a SpecGuard server');
    expect(await connect(await cfg(await stub(200, { ...healthy, apiVersion: 99 })), { env: env(), onFallback: (r) => reasons.push(r) })).toBeNull();
    expect(reasons.pop()).toContain('API version 99');
    expect(await connect(await cfg(await stub(503, {})), { env: env(), onFallback: (r) => reasons.push(r) })).toBeNull();
    expect(reasons.pop()).toContain('503');
    const mismatch = await connect(await cfg(await stub(200, { ...healthy, hashVersion: 2 })), { env: env() });
    expect(mismatch).toMatchObject({ hashMismatch: true });
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('answers a slow server within the timeout by giving up on it [timeout]', async () => {
    const slow = http.createServer(() => undefined);
    stubs.push(slow);
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    const started = Date.now();
    const reasons: string[] = [];
    expect(await connect(await loadConfig(makeRepo({ server: { url, timeoutMs: 250 } }).dir), { env: env(), onFallback: (r) => reasons.push(r) })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(reasons[0]).toContain('no answer');
  });
});
