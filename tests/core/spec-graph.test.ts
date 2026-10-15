import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { buildSpecGraph } from '../../src/core/spec-graph.js';
import { makeRepo, type TmpRepo } from '../helpers/repo.js';

const system = (extra = '') => `---\nid: system\nkind: system\n${extra}---\n# System\n\n## Problem\n\nx\n`;
const capability = (id: string, sources: string[], extra = '') =>
  `---\nid: ${id}\nkind: capability\nparent: system\nvalue: v\nsources:\n${sources.map((s) => `  - "${s}"`).join('\n')}\n${extra}---\n# ${id}\n\n## Problem & Value\n\nvalue\n\n## Requirements\n\n- [ ] a <!-- claim: a-claim -->\n`;

function repoWith(files: Record<string, string>, extraConfig: Record<string, unknown> = {}): TmpRepo {
  const repo = makeRepo(extraConfig);
  // makeRepo seeds a v1 spec; remove its effect by overwriting specs we care about only.
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  return repo;
}

async function graphOf(repo: TmpRepo) {
  return buildSpecGraph(await loadConfig(repo.dir));
}

describe('spec graph [spec-graph]', () => {
  // [claims: capabilities/spec-authoring#graph-file-ownership]
  it('maps one file to several specs and reports unowned files [file-ownership]', async () => {
    const repo = repoWith({
      'specs/system.md': system(),
      'specs/auth.md': capability('auth', ['src/auth/**', 'src/shared/session.ts']),
      'specs/profile.md': capability('profile', ['src/profile/**', 'src/shared/session.ts']),
      'src/auth/login.ts': '',
      'src/profile/view.ts': '',
      'src/shared/session.ts': '',
      'src/orphan.ts': '',
    });
    const graph = await graphOf(repo);
    expect(graph.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(graph.specsForFile('src/auth/login.ts')).toEqual(['auth']);
    expect(graph.specsForFile(`${repo.dir}/src/shared/session.ts`)).toEqual(['auth', 'profile']);
    expect(graph.unowned(['src/orphan.ts', 'src/auth/login.ts'])).toEqual(['src/orphan.ts']);
    expect(graph.nodes.get('auth')?.ownedFiles).toEqual(['src/auth/login.ts', 'src/shared/session.ts']);
  });

  // [claims: capabilities/spec-authoring#graph-tree]
  it('links capabilities under the system spec [tree]', async () => {
    const repo = repoWith({
      'specs/system.md': system(),
      'specs/auth.md': capability('auth', ['src/auth/**']),
      'src/auth/login.ts': '',
    });
    const graph = await graphOf(repo);
    expect(graph.system?.id).toBe('system');
    expect(graph.nodes.get('system')?.children).toContain('auth');
  });

  // [claims: capabilities/spec-authoring#graph-validation]
  it('requires exactly one system spec once v2 specs exist [one-system]', async () => {
    const none = await graphOf(repoWith({ 'specs/auth.md': capability('auth', ['src/**']), 'src/a.ts': '' }));
    expect(none.issues.map((i) => i.code)).toContain('no-system');
    const two = await graphOf(repoWith({ 'specs/system.md': system(), 'specs/other.md': system().replace('id: system', 'id: other') }));
    expect(two.issues.map((i) => i.code)).toContain('multiple-system');
  });

  // [claims: capabilities/spec-authoring#graph-validation]
  it('flags a filename that differs from the id, an unknown parent and a missing Problem & Value [validation]', async () => {
    const graph = await graphOf(
      repoWith({
        'specs/system.md': system(),
        'specs/auth.md': capability('login', ['src/**']).replace('parent: system', 'parent: ghost'),
        'specs/thin.md': '---\nid: thin\nkind: capability\nparent: system\nsources:\n  - "src/**"\n---\n# Thin\n',
        'src/a.ts': '',
      }),
    );
    const codes = graph.issues.map((i) => `${i.code}:${i.spec ?? ''}`);
    expect(codes).toContain('id-filename:login');
    expect(codes).toContain('unknown-parent:login');
    expect(codes).toContain('missing-problem-value:thin');
  });

  // [claims: capabilities/spec-authoring#graph-validation]
  it('hard-fails duplicate claim ids inside one spec [duplicate-claim]', async () => {
    const dup = capability('auth', ['src/**']).replace('- [ ] a <!-- claim: a-claim -->', '- [ ] a <!-- claim: a-claim -->\n- [ ] b <!-- claim: a-claim -->');
    const graph = await graphOf(repoWith({ 'specs/system.md': system(), 'specs/auth.md': dup, 'src/a.ts': '' }));
    expect(graph.issues.find((i) => i.code === 'duplicate-claim')).toMatchObject({ level: 'error', spec: 'auth' });
  });

  // [claims: capabilities/spec-authoring#graph-validation]
  it('warns past granularity.maxCapabilities [too-many]', async () => {
    const files: Record<string, string> = { 'specs/system.md': system(), 'src/a.ts': '' };
    for (const id of ['one', 'two', 'three']) files[`specs/${id}.md`] = capability(id, ['src/**']);
    const graph = await graphOf(repoWith(files, { granularity: { maxCapabilities: 2 } }));
    expect(graph.issues.find((i) => i.code === 'too-many-capabilities')?.level).toBe('warn');
  });

  it('applies no v2 rules to a v1-only repo and ignores history entries [v1-repo]', async () => {
    const repo = repoWith({ 'specs/history/2026-01-01-note.md': '---\nid: note\nkind: prompt+plan\n---\n# n\n' });
    const graph = await graphOf(repo);
    expect(graph.issues).toEqual([]);
    expect(graph.nodes.has('note')).toBe(false);
    expect(graph.system).toBeUndefined();
  });
});
