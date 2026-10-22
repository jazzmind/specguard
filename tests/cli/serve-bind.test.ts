import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isLoopbackHost } from '../../src/cli/commands/serve.js';
import { makeRepo } from '../helpers/repo.js';

const cli = path.resolve(__dirname, '../../src/cli/index.ts');
// tsx by absolute URL: the temporary project the command runs in has no node_modules of its own.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });

describe('where `serve` may listen [serve-bind]', () => {
  // [claims: capabilities/documentation-api#serve-bind-loopback]
  it('treats only this machine\'s own addresses as loopback', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com', '127.evil.example', '127.0.0.1.evil.example']) expect(isLoopbackHost(h), h).toBe(false);
  });

  // [claims: capabilities/documentation-api#serve-bind-loopback]
  it('refuses to bind a wider address without --allow-remote, and says what to do instead', () => {
    const repo = makeRepo();
    const res = run(repo.dir, 'serve', '--host', '0.0.0.0', '--port', '0');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('refusing to bind 0.0.0.0');
    expect(res.stderr).toContain('--allow-remote');
    expect(res.stderr).toContain('specguard server');
  });

  // [claims: capabilities/documentation-api#serve-bind-loopback]
  it('binds loopback by default and a wider address only when asked, with a note', async () => {
    const repo = makeRepo();
    const start = (...args: string[]) =>
      new Promise<{ out: () => string; stop: () => void }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', tsx, cli, 'serve', '--port', '0', ...args], { cwd: repo.dir });
        let out = '';
        const timer = setTimeout(() => reject(new Error(`no start: ${out}`)), 30_000);
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (out.includes('API')) {
            clearTimeout(timer);
            setTimeout(() => resolve({ out: () => out, stop: () => child.kill() }), 400); // the note is printed just after the first lines
          }
        });
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      });
    const plain = await start();
    expect(plain.out()).toContain('http://127.0.0.1:');
    plain.stop();
    const remote = await start('--host', '0.0.0.0', '--allow-remote');
    expect(remote.out()).toContain('bound beyond loopback by --allow-remote');
    remote.stop();
  }, 90_000);
});
