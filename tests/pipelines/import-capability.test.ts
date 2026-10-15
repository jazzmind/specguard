import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn() }));

import { loadConfig } from '../../src/core/config.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { buildSpecGraph } from '../../src/core/spec-graph.js';
import { listHistory } from '../../src/core/history.js';
import { appendRequirements, runImportIntoCapability } from '../../src/pipelines/import-capability.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const mocked = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;
let repo: TmpRepo;

const proposal = (over: Record<string, unknown> = {}) => ({
  additions: [
    { text: 'A code expires after ten minutes', id: 'Code Expires!', basis: 'section 2' },
    { text: 'Login succeeds with a valid code', id: 'login-valid-code', basis: 'duplicate of an existing one' },
    { text: 'Five failed attempts lock the address for an hour', id: 'login-valid-code', basis: 'section 3' },
  ],
  alreadyCovered: ['Users sign in with a code'],
  elsewhere: ['Carts are emptied after a day'],
  ...over,
});

beforeEach(() => {
  mocked.mockReset();
  repo = makeV2Repo();
  repo.write('requirements.md', '# Sign-in\n\n## Codes\nA code expires after ten minutes.\n');
});

describe('import into a capability [import-capability]', () => {
  // [claims: capabilities/spec-authoring#import-documents]
  it('only prints the proposal without --yes, and writes nothing [dry-run]', async () => {
    mocked.mockResolvedValue(proposal());
    const before = readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8');
    const r = await runImportIntoCapability(await loadConfig(repo.dir), { source: 'requirements.md', capability: 'auth' });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join('\n')).toContain('Rerun with --yes');
    expect(readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8')).toBe(before);
    expect(listHistory(await loadConfig(repo.dir))).toHaveLength(0);
  });

  // [claims: capabilities/spec-authoring#import-documents]
  it('appends new requirements with unique claim ids, skips ones the capability already has, and records history [writes]', async () => {
    mocked.mockResolvedValue(proposal());
    const config = await loadConfig(repo.dir);
    const r = await runImportIntoCapability(config, { source: 'requirements.md', capability: 'auth', yes: true });
    expect(r.updated).toBe(2);
    const node = (await buildSpecGraph(await loadConfig(repo.dir))).nodes.get('auth')!;
    const ids = node.spec.claims.map((c) => c.id);
    // The model's duplicate of an existing requirement is dropped; a clashing id gets a numeric suffix; ids are valid.
    expect(node.spec.claims.map((c) => c.text)).toContain('A code expires after ten minutes');
    expect(node.spec.claims.filter((c) => c.text === 'Login succeeds with a valid code')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['code-expires', 'login-valid-code-2']));
    // The rest of the spec is untouched and the graph is still valid.
    expect((await buildSpecGraph(await loadConfig(repo.dir))).issues.filter((i) => i.level === 'error')).toEqual([]);
    const history = listHistory(await loadConfig(repo.dir));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: 'import', affects: ['auth'] });
    expect(history[0].body).toContain('code-expires');
    expect(readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8')).toContain(history[0].id);
  });

  // [claims: capabilities/spec-authoring#import-documents]
  it('reports an unknown capability and an unreadable source as failures, and an empty proposal as nothing to do [errors]', async () => {
    const config = await loadConfig(repo.dir);
    const unknown = await runImportIntoCapability(config, { source: 'requirements.md', capability: 'nope', yes: true });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.messages.join('\n')).toContain('Known:');
    const missing = await runImportIntoCapability(config, { source: 'missing.md', capability: 'auth', yes: true });
    expect(missing.failed).toBe(1);
    mocked.mockResolvedValue(proposal({ additions: [] }));
    const none = await runImportIntoCapability(config, { source: 'requirements.md', capability: 'auth', yes: true });
    expect(none.exitCode).toBe(0);
    expect(none.updated).toBe(0);
    expect(listHistory(config)).toHaveLength(0);
  });
});

describe('appendRequirements [append-requirements]', () => {
  // [claims: capabilities/spec-authoring#import-documents]
  it('inserts at the end of the Requirements section, before the next heading, and creates the section when missing', () => {
    const doc = '# T\n\n## Requirements\n\n- [ ] one <!-- claim: one -->\n\n## Scenarios\n\nx\n';
    expect(appendRequirements(doc, ['- [ ] two <!-- claim: two -->'])).toBe('# T\n\n## Requirements\n\n- [ ] one <!-- claim: one -->\n- [ ] two <!-- claim: two -->\n\n## Scenarios\n\nx\n');
    expect(appendRequirements('# T\n\nbody\n', ['- [ ] a <!-- claim: a -->'])).toContain('## Requirements\n\n- [ ] a <!-- claim: a -->');
  });
});
