import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { buildServer, CORE_TOOLS } from '../../src/mcp/server.js';
import { WRITE_TOOLS } from '../../src/mcp/limits.js';
import { loadConfig } from '../../src/core/config.js';
import { runProofPublish } from '../../src/pipelines/proof-store-cmd.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { bareRemote, cloneOf, sh } from '../helpers/notes-git.js';
import { gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0]?.text ?? '';
const names = (): string[] => Object.keys((buildServer() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

async function connect(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(b);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(a);
  return client;
}

describe('specguard_proof_fetch [proof-store]', () => {
  // [claims: capabilities/proof-store#store-fetch-tool]
  it('is offered by the default server and is a write tool, and no tool can publish a note', () => {
    expect(CORE_TOOLS.has('specguard_proof_fetch')).toBe(true);
    expect(WRITE_TOOLS.has('specguard_proof_fetch')).toBe(true);
    expect(names()).toContain('specguard_proof_fetch');
    expect(names().filter((n) => /publish/i.test(n) && /proof/i.test(n))).toEqual([]);

    const before = process.env.SPECGUARD_MCP_READONLY;
    try {
      process.env.SPECGUARD_MCP_READONLY = '1';
      expect(names()).not.toContain('specguard_proof_fetch');
    } finally {
      if (before === undefined) delete process.env.SPECGUARD_MCP_READONLY;
      else process.env.SPECGUARD_MCP_READONLY = before;
    }
  });

  // [claims: capabilities/proof-store#store-fetch-tool]
  it('fetches the notes ref into the clone and changes no file of the working tree', async () => {
    const author = makeV2Repo();
    await ingestVerdicts({ runId: 'run-1', verdicts: [{ claim: 'capabilities/auth#login-valid-code', verdict: 'proven' }] }, author.dir, { provenance: { origin: 'ci' } });
    gitInit(author.dir);
    const remote = bareRemote();
    sh(author.dir, 'remote', 'add', 'origin', remote);
    sh(author.dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const published = await runProofPublish(await loadConfig(author.dir), { env: { GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv, sleep: async () => undefined });
    expect(published.exitCode).toBe(0);

    const reader = cloneOf(remote);
    // the MCP server's own activity log is the only file it may add
    const changed = (): string => sh(reader.dir, 'status', '--porcelain').split('\n').filter((l) => !l.endsWith('.specguard/activity-log.json')).join('\n');
    const treeBefore = changed();
    const client = await connect();
    const res = await client.callTool({ name: 'specguard_proof_fetch', arguments: { cwd: reader.dir } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(text(res)).toContain('fetched refs/notes/specguard from origin: 1 commit(s) have a proof note');
    expect(sh(reader.dir, 'notes', '--ref=refs/notes/specguard', 'list')).toContain(reader.head());
    expect(changed()).toBe(treeBefore);

    const skipped = await client.callTool({ name: 'specguard_proof_fetch', arguments: { cwd: reader.dir, ifOlder: '10m' } });
    expect(text(skipped)).toMatch(/nothing to do/);
  });
});
