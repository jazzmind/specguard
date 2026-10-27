import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectHealth } from './project-health.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-health-')); roots.push(root);
  const write = (rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  write('.specguard/config.json', JSON.stringify({ apps: [{ name: 'web', specDir: 'specs' }], featureState: { catalog: 'catalog', catalogExclude: ['notes.yaml'] } }));
  write('.specguard/sg-version.json', '{"version":"0.6.0"}');
  write('.gitignore', '.specguard/trace.json\n');
  write('specs/capabilities/cart.md', '---\nkind: capability\nid: cart\nfeature: [cart]\n---\n# Cart\n');
  write('catalog/features.yaml', 'version: 1\nfeatures:\n  - id: cart\n  - id: checkout\n    specs: [web:capabilities/cart]\n  - id: missing\n');
  write('catalog/notes.yaml', 'not a feature catalog');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.com'); git('config', 'commit.gpgsign', 'false'); git('add', '-A'); git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  write('.specguard/trace.json', JSON.stringify({ statement: { head: sha }, tool: { version: '0.6.0' }, totals: { claims: 3, proven: 2, failed: 0, stale: 0 } }));
  return { root, write, git, sha };
}
describe('workspace version and catalog health', () => {
  // [claims: capabilities/integration-surfaces#extension-workspace-alignment]
  it('separates setup/check versions and clean checked Git revision from current catalog link coverage', async () => {
    const { root, sha, git } = fixture();
    const h = await projectHealth(root, root, '0.6.0');
    expect(h).toMatchObject({ setupCurrent: true, checkedWith: '0.6.0', checkVersionCurrent: true, codeRevision: sha, checkedRevision: sha, codeCurrent: true, specFormat: 'capability' });
    expect(h.catalog).toMatchObject({ features: 3, linked: 2, missing: ['missing'] });
    expect(h.catalog?.files).toHaveLength(1);
    expect(h.catalog?.revision).toHaveLength(12);
    git('add', '-f', '.specguard/trace.json');
    expect((await projectHealth(root, root, '0.6.0')).codeCurrent).toBe(true);
  }, 20_000);
  // [claims: capabilities/integration-surfaces#extension-workspace-alignment]
  it('notices dirty code, a new commit, a different checker version and changed catalog content', async () => {
    const { root, write, git } = fixture();
    const before = await projectHealth(root, root, '0.6.0');
    write('new-code.ts', 'export const x = 1;');
    expect((await projectHealth(root, root, '0.7.0'))).toMatchObject({ dirty: true, codeCurrent: false, setupCurrent: false, checkVersionCurrent: false });
    git('add', '-A'); git('commit', '-qm', 'new code');
    expect((await projectHealth(root, root, '0.6.0')).codeCurrent).toBe(false);
    write('catalog/features.yaml', 'version: 1\nfeatures:\n  - id: changed\n');
    const after = await projectHealth(root, root, '0.6.0');
    expect(after.catalog?.revision).not.toBe(before.catalog?.revision);
    expect(after.catalog?.missing).toEqual(['changed']);
  }, 20_000);
  // [claims: capabilities/integration-surfaces#extension-workspace-alignment]
  it('reports unsupported catalogs and absent historical versions without calling them aligned', async () => {
    const { root, write } = fixture();
    write('catalog/features.yaml', 'version: 99\nfeatures: []');
    write('.specguard/trace.json', '{}');
    const h = await projectHealth(root, root, '0.6.0');
    expect(h.catalog?.error).toContain('unsupported');
    expect(h.checkedWith).toBe(null);
    expect(h.checkedRevision).toBe(null);
    expect(h.checkVersionCurrent).toBe(false);
    expect(h.codeCurrent).toBe(false);
  }, 20_000);
});
