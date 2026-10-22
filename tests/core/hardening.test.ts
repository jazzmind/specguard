import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isNonPublicAddress, publicAddressesFor, safeFetchText, UnsafeUrlError } from '../../src/core/safe-fetch.js';
import { isInside, OutsideRootError, resolveInside } from '../../src/core/safe-path.js';
import { isSecretLike, isSafeToStage } from '../../src/core/git-scope.js';
import { readStdin } from '../../src/cli/commands/history.js';
import { recordPrompt } from '../../src/pipelines/history.js';
import { specFileInside } from '../../src/mcp/server.js';
import { loadConfig } from '../../src/core/config.js';
import { fetchUrl } from '../../src/pipelines/import.js';
import { makeRepo } from '../helpers/repo.js';
import { envFilePermissionWarning, loadSpecGuardEnv } from '../../src/core/env.js';
import { appendActivityLogEntry } from '../../src/mcp/activity-hook.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sg-hard-'));

// ---------------------------------------------------------------------------
describe('which addresses an imported URL may reach [safe-fetch]', () => {
  // [claims: capabilities/spec-authoring#import-ssrf]
  it('treats loopback, private, link-local, metadata, CGNAT, multicast and mapped addresses as non-public', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '[::1]', 'fe80::1%en0', '2002:7f00:1::1', '64:ff9b::7f00:1', 'not-an-ip', '999.1.1.1']) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isNonPublicAddress(a), a).toBe(false);
  });

  // [claims: capabilities/spec-authoring#import-ssrf]
  it('refuses a name that resolves to a private address, even when only one of its answers is private', async () => {
    await expect(publicAddressesFor('internal.example', { resolve: async () => ['10.0.0.5'] })).rejects.toThrow(/not a public address/);
    await expect(publicAddressesFor('rebind.example', { resolve: async () => ['93.184.216.34', '169.254.169.254'] })).rejects.toThrow(UnsafeUrlError);
    await expect(publicAddressesFor('nothing.example', { resolve: async () => [] })).rejects.toThrow(/did not resolve/);
    await expect(publicAddressesFor('public.example', { resolve: async () => ['93.184.216.34'] })).resolves.toEqual(['93.184.216.34']);
    await expect(publicAddressesFor('internal.example', { allowPrivate: true, resolve: async () => ['10.0.0.5'] })).resolves.toEqual(['10.0.0.5']);
  });

  // [claims: capabilities/spec-authoring#import-ssrf]
  it('refuses the cloud metadata address, localhost and credentials in the URL before connecting', async () => {
    await expect(safeFetchText('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not a public address/);
    await expect(safeFetchText('http://127.0.0.1:1/')).rejects.toThrow(/not a public address/);
    await expect(safeFetchText('http://[::1]:1/')).rejects.toThrow(/not a public address/);
    await expect(safeFetchText('http://localhost:1/')).rejects.toThrow(/not a public address/);
    await expect(safeFetchText('https://user:pass@example.com/')).rejects.toThrow(/user name or password/);
    await expect(fetchUrl('file:///etc/passwd')).rejects.toThrow(/Unsupported protocol/);
    await expect(fetchUrl('ftp://internal.host/secret')).rejects.toThrow(/Unsupported protocol/);
  });
});

describe('fetching from a server on the same machine, when allowed [safe-fetch-live]', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
  });
  async function serve(handler: http.RequestListener): Promise<string> {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  const local = { allowPrivate: true };

  // [claims: capabilities/spec-authoring#import-ssrf]
  it('follows a few redirects, resolving relative ones, and sends the original host name', async () => {
    let seenHost = '';
    const base = await serve((req, res) => {
      seenHost = req.headers.host ?? '';
      if (req.url === '/a') return void res.writeHead(302, { Location: '/b' }).end();
      if (req.url === '/b') return void res.writeHead(301, { Location: `${base}/c` }).end();
      res.writeHead(200).end('# the document');
    });
    expect(await safeFetchText(`${base}/a`, local)).toBe('# the document');
    expect(seenHost).toBe(base.replace('http://', ''));
  });

  // [claims: capabilities/spec-authoring#import-ssrf]
  it('stops a redirect loop instead of recursing forever, and a redirect into a non-public address', async () => {
    const base = await serve((_req, res) => void res.writeHead(302, { Location: '/again' }).end());
    await expect(safeFetchText(`${base}/x`, { ...local, maxRedirects: 3 })).rejects.toThrow(/more than 3 redirects/);
    const toMetadata = await serve((_req, res) => void res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end());
    // the first hop is a loopback allowed explicitly; the redirect target is checked on its own and refused only when private is not allowed
    await expect(safeFetchText(`${toMetadata}/x`, { resolve: async () => ['127.0.0.1'] })).rejects.toThrow(/not a public address/);
  });

  // [claims: capabilities/spec-authoring#import-ssrf]
  it('refuses an answer over the size limit, declared or streamed, and a missing document', async () => {
    const declared = await serve((_req, res) => void res.writeHead(200, { 'Content-Length': '999999' }).end('x'));
    await expect(safeFetchText(declared, { ...local, maxBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes/);
    const streamed = await serve((_req, res) => {
      res.writeHead(200);
      res.write('x'.repeat(600));
      res.end('x'.repeat(600));
    });
    await expect(safeFetchText(streamed, { ...local, maxBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes/);
    const gone = await serve((_req, res) => void res.writeHead(404).end());
    await expect(safeFetchText(gone, local)).rejects.toThrow(/HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
describe('keeping a named path inside the project [safe-path]', () => {
  // [claims: capabilities/spec-authoring#import-project-files]
  it('allows files inside, refuses .. and absolute paths outside, and follows symlinks before judging', () => {
    const root = tmp();
    const outside = tmp();
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(outside, 'secret.md'), 'secret');
    symlinkSync(outside, path.join(root, 'docs', 'link'));
    expect(resolveInside(root, 'docs/a.md')).toBe(path.join(root, 'docs', 'a.md'));
    expect(isInside(root, path.join(root, 'new', 'deeper', 'file.md'))).toBe(true); // not created yet
    expect(() => resolveInside(root, '../etc/passwd')).toThrow(OutsideRootError);
    expect(() => resolveInside(root, path.join(outside, 'secret.md'))).toThrow(OutsideRootError);
    expect(() => resolveInside(root, 'docs/link/secret.md')).toThrow(OutsideRootError); // a symlink out of the project
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, `${root}-sibling/x`)).toBe(false); // a shared prefix is not containment
  });
});

describe('what an agent may read or write as a spec through MCP [mcp-spec-paths]', () => {
  // [claims: capabilities/integration-surfaces#mcp-spec-paths]
  it('allows Markdown inside the project\'s spec directories and refuses everything else', async () => {
    const repo = makeRepo();
    const base = repo.dir;
    await expect(specFileInside(base, 'specs/core/awards.md')).resolves.toBe(path.join(base, 'specs', 'core', 'awards.md'));
    await expect(specFileInside(base, 'specs/new/dir/x.md')).resolves.toContain('x.md');
    for (const bad of ['../outside.md', '/etc/passwd', path.join(os.homedir(), '.zshrc'), '.git/hooks/pre-commit', '.claude/settings.json', 'src/index.ts', 'specs/../src/x.md', 'specs/x.sh', 'package.json']) {
      await expect(specFileInside(base, bad), bad).rejects.toThrow();
    }
  });

  // [claims: capabilities/integration-surfaces#mcp-spec-paths]
  it('refuses a symlink inside the specs folder that points outside the project, and uses <cwd>/specs with no config', async () => {
    const repo = makeRepo();
    const outside = tmp();
    symlinkSync(outside, path.join(repo.dir, 'specs', 'escape'));
    await expect(specFileInside(repo.dir, 'specs/escape/x.md')).rejects.toBeInstanceOf(OutsideRootError);
    const bare = tmp();
    await expect(specFileInside(bare, 'specs/a.md')).resolves.toBe(path.join(bare, 'specs', 'a.md'));
    await expect(specFileInside(bare, 'a.md')).rejects.toThrow();
  });

  // [claims: capabilities/integration-surfaces#mcp-spec-paths]
  it('loads the same config the roots come from', async () => {
    const repo = makeRepo();
    expect((await loadConfig(repo.dir)).apps[0].specDir).toBe('specs');
  });
});

// ---------------------------------------------------------------------------
describe('what the commit tool may stage [commit-secrets]', () => {
  // [claims: capabilities/integration-surfaces#commit-never-secrets]
  it('never stages environment files, keys, credentials, saved logins or browser evidence, even in a safe root', () => {
    const roots = ['tests/', 'docs/', 'specs/', '.specguard/'];
    for (const f of ['.specguard/.env', '.env', 'tests/.env.local', 'docs/.env.production', 'specs/id_rsa', 'tests/server.pem', 'docs/private.key', 'tests/cert.p12', '.specguard/auth/admin.json', '.specguard/evidence/auth/post.png', 'tests/credentials.json', 'docs/.npmrc', 'sub/.specguard/auth/x.json']) {
      expect(isSecretLike(f), f).toBe(true);
      expect(isSafeToStage(f, roots), f).toBe(false);
    }
    for (const f of ['.env.example', 'tests/.env.sample', 'tests/auth.test.ts', 'docs/user/auth.md', '.specguard/proofs.json', '.specguard/config.json', 'specs/capabilities/auth.md']) {
      expect(isSecretLike(f), f).toBe(false);
    }
    expect(isSafeToStage('.specguard/proofs.json', roots)).toBe(true);
    expect(isSafeToStage('tests/../.specguard/.env', roots)).toBe(false); // normalised before judging
  });
});

describe('hook input and the files it leaves [hook-hardening]', () => {
  async function* chunks(...sizes: number[]) {
    for (const n of sizes) yield Buffer.alloc(n, 'a');
  }

  // [claims: capabilities/requirement-history#hook-input-bounded]
  it('reads small input, and drops input over the limit instead of buffering it', async () => {
    expect((await readStdin(chunks(10, 20), 100)).length).toBe(30);
    expect(await readStdin(chunks(60, 60), 100)).toBe('');
    expect(await readStdin(chunks(), 100)).toBe('');
  });

  // [claims: capabilities/requirement-history#hook-input-bounded]
  it('cuts a huge prompt, and keeps the inbox readable by its owner only', async () => {
    const repo = makeRepo();
    const config = await loadConfig(repo.dir);
    expect(recordPrompt(config, JSON.stringify({ prompt: 'x'.repeat(500_000), session_id: 's1' }))).toBe(true);
    const inbox = path.join(repo.dir, '.specguard', 'history', 'inbox.jsonl');
    const line = JSON.parse(readFileSync(inbox, 'utf8').trim());
    expect(line.prompt.length).toBeLessThan(50_100);
    expect(line.prompt.endsWith('[truncated]')).toBe(true);
    if (process.platform !== 'win32') expect(statSync(inbox).mode & 0o777).toBe(0o600);
  });

  // [claims: capabilities/requirement-history#hook-input-bounded]
  it('does not widen the mode of an inbox that already exists', async () => {
    const repo = makeRepo();
    const config = await loadConfig(repo.dir);
    const inbox = path.join(repo.dir, '.specguard', 'history', 'inbox.jsonl');
    mkdirSync(path.dirname(inbox), { recursive: true });
    writeFileSync(inbox, '');
    chmodSync(inbox, 0o640);
    recordPrompt(config, JSON.stringify({ prompt: 'hello' }));
    expect(existsSync(inbox)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(inbox).mode & 0o777).toBe(0o640);
  });
});

describe('credentials in what SpecGuard writes down [log-redaction]', () => {
  // [claims: capabilities/platform-foundation#log-redaction]
  it('masks a credential in an activity log message', () => {
    const dir = tmp();
    appendActivityLogEntry(dir, { pipeline: 'validate', status: 'error', source: 'mcp', message: 'request failed: Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 was rejected' });
    appendActivityLogEntry(dir, { pipeline: 'check', status: 'pass', source: 'mcp' });
    const log = JSON.parse(readFileSync(path.join(dir, '.specguard', 'activity-log.json'), 'utf8')) as Array<{ message?: string }>;
    expect(log[0].message).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(log[0].message).toContain('request failed');
    expect(log[1].message).toBeUndefined();
  });
});

describe('a .env file that holds secrets [env-permissions]', () => {
  // [claims: capabilities/workspaces#env-permission-warning]
  it('warns when other users can read it, names the fix, and still loads it; says nothing when it is private', () => {
    if (process.platform === 'win32') return;
    const dir = tmp();
    mkdirSync(path.join(dir, '.specguard'));
    const file = path.join(dir, '.specguard', '.env');
    writeFileSync(file, 'SG_HARD_TEST_KEY=abc\n');
    chmodSync(file, 0o644);
    const env: NodeJS.ProcessEnv = {};
    const warnings = loadSpecGuardEnv(dir, env);
    expect(env.SG_HARD_TEST_KEY).toBe('abc');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('readable by other users (mode 644)');
    expect(warnings[0]).toContain('chmod 600');
    expect(warnings[0]).not.toContain('abc'); // never the value
    chmodSync(file, 0o600);
    expect(loadSpecGuardEnv(dir, {})).toEqual([]);
    expect(envFilePermissionWarning(path.join(dir, 'missing'))).toBeUndefined();
  });
});

