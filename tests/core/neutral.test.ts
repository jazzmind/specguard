import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
// Built from parts so this file does not contain the word it forbids.
const FORBIDDEN = new RegExp(['pract', 'era'].join(''), 'i');

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'history', '_archive', 'runs', 'evidence'].includes(name)) continue;
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) files(abs, out);
    else if (/\.(ts|tsx|mjs|js|json|md|yml|yaml)$/.test(name)) out.push(abs);
  }
  return out;
}

describe('SpecGuard is platform-neutral [neutral]', () => {
  // [claims: capabilities/integration-surfaces#catalog-layout-config]
  it('names no customer platform in code, docs, specs or examples; layout comes from config [no-customer-names]', () => {
    const hits: string[] = [];
    const scope = ['src', 'extension/src', 'action', 'docs', 'specs', 'schemas', 'README.md', 'CLAUDE.md', 'AGENTS.md'];
    for (const entry of scope) {
      const abs = path.join(root, entry);
      let list: string[];
      try {
        list = statSync(abs).isDirectory() ? files(abs) : [abs];
      } catch {
        continue;
      }
      for (const file of list) if (FORBIDDEN.test(readFileSync(file, 'utf8'))) hits.push(path.relative(root, file));
    }
    expect(hits).toEqual([]);
  });
});
