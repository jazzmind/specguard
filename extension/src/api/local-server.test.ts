import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { ApiClient } from './client.js';
import { startLocalServer } from './local-server.js';

// Tests run from the extension directory; the repository's compiled CLI is one level up.
const rootCli = path.resolve(process.cwd(), '..', 'dist', 'cli', 'index.js');
const haveCli = fs.existsSync(rootCli);

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-local-'));
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('.specguard/config.json', JSON.stringify({ apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: { routes: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] }, framework: 'vitest', testOutput: 'tests/' }], llm: { provider: 'none', model: 'none', apiKeyEnv: 'NONE' } }));
  write('specs/system.md', '---\nid: system\nkind: system\nvalue: v\n---\n# System\n\n## Problem\n\nx\n');
  write('specs/capabilities/auth.md', '---\nid: auth\nkind: capability\nparent: system\nvalue: People sign in.\nsources:\n  - "src/auth/**"\n---\n# Auth\n\n## Problem & Value\n\nPeople sign in.\n\n## Requirements\n\n- [ ] A valid code signs in <!-- claim: login -->\n');
  write('src/auth/login.ts', 'export const login = 1;\n');
  return root;
}

describe('local server [ext-local-server]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it.skipIf(!haveCli)('starts `specguard serve` on a free port, serves the workspace through the API, and stops [serve]', async () => {
    const handle = await startLocalServer(rootCli, project());
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const client = new ApiClient({ baseUrl: handle.url });
      expect((await client.health()).apiVersion).toBe(1);
      const caps = await client.get<{ capabilities: Array<{ id: string }> }>('/capabilities');
      expect(caps.capabilities.map((c) => c.id)).toContain('auth');
      const coverage = await client.get<{ capabilities: Array<{ id: string; files: number }> }>('/coverage');
      expect(coverage.capabilities.find((c) => c.id === 'auth')!.files).toBe(1);
    } finally {
      handle.dispose();
    }
  }, 30_000);

  // [claims: capabilities/team-server#local-first-fallback]
  it('reports a command line that does not exist, and one that exits at once, instead of hanging [failures]', async () => {
    await expect(startLocalServer('', os.tmpdir())).rejects.toThrow(/no SpecGuard command line/);
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-bad-')), 'cli.js');
    fs.writeFileSync(script, "console.error('boom: no config'); process.exit(3);");
    await expect(startLocalServer(script, os.tmpdir(), process.env, 10_000)).rejects.toThrow(/exited \(3\).*boom: no config/);
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('gives up when the server never says where it is listening [silent]', async () => {
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-silent-')), 'cli.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const started = Date.now();
    await expect(startLocalServer(script, os.tmpdir(), process.env, 600)).rejects.toThrow(/did not start/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
