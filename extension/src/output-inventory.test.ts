import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectOutputs } from './output-inventory.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-outputs-')); roots.push(root);
  const write = (rel: string, text = '# Title\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  return { root, write };
}
describe('output inventories', () => {
  // [claims: capabilities/integration-surfaces#extension-output-browser]
  it('lists all configured specs, colocated tests and custom docs, excluding retired specs and dependencies', async () => {
    const { root, write } = fixture();
    write('.specguard/config.json', JSON.stringify({ apps: [{ name: 'web', specDir: 'requirements', sources: { tests: ['qa/**/*.py'] } }], paths: { docsOut: 'handbook' } }));
    for (const file of ['requirements/system.md', 'requirements/capabilities/cart.md', 'requirements/_archive/old.md', 'qa/cart.py', 'src/cart.test.ts', 'docs/developer/intro.md', 'handbook/cart.md', 'node_modules/foo/foo.test.ts']) write(file);
    expect((await collectOutputs('specs', root)).map((f) => f.relativePath)).toEqual(['requirements/capabilities/cart.md', 'requirements/system.md']);
    expect((await collectOutputs('tests', root)).map((f) => f.relativePath)).toEqual(['qa/cart.py', 'src/cart.test.ts']);
    expect((await collectOutputs('docs', root)).map((f) => f.relativePath)).toEqual(['docs/developer/intro.md', 'handbook/cart.md']);
  });
  // [claims: capabilities/integration-surfaces#extension-output-browser]
  it('reads specs and inherited settings from an overlay while finding code tests in the real repo', async () => {
    const { root, write } = fixture();
    write('overlay/.specguard/config.json', JSON.stringify({ extends: '../shared.json' }));
    write('shared.json', JSON.stringify({ apps: [{ specDir: 'specs' }] }));
    write('overlay/specs/system.md');
    write('app/src/a.spec.ts');
    const app = path.join(root, 'app');
    const overlay = path.join(root, 'overlay');
    expect((await collectOutputs('specs', app, overlay))[0].path).toBe(path.join(overlay, 'specs/system.md'));
    expect((await collectOutputs('tests', app, overlay))[0].relativePath).toBe('src/a.spec.ts');
  });
});
