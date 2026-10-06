import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/mcp/server.js';
import { makeRepo } from '../helpers/repo.js';

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(b);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(a);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

describe('mcp results/proof ingest tools', () => {
  it('lists both ingest tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('specguard_results_ingest');
    expect(names).toContain('specguard_proof_ingest');
  });

  it('results_ingest writes the proof ledger', async () => {
    const repo = makeRepo();
    repo.write('a.xml', `<testsuite name="s"><testcase classname="c" name="t1 @claim:core/awards#award-once"/></testsuite>`);
    const client = await connect();
    const res = await client.callTool({ name: 'specguard_results_ingest', arguments: { files: ['a.xml'], runId: 'mcp-1', cwd: repo.dir } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const ledger = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs;
    expect(ledger['core/awards#award-once']).toMatchObject({ verdict: 'proven', runId: 'mcp-1' });
  });

  it('results_ingest rejects an unknown format', async () => {
    const repo = makeRepo();
    const client = await connect();
    const res = await client.callTool({ name: 'specguard_results_ingest', arguments: { files: ['a.xml'], format: 'nope', cwd: repo.dir } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res)).toContain('unknown format');
  });

  it('proof_ingest merges a verdicts file', async () => {
    const repo = makeRepo();
    repo.write('v.json', JSON.stringify({ runId: 'r1', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven', exercised: 3 }] }));
    const client = await connect();
    await client.callTool({ name: 'specguard_proof_ingest', arguments: { verdicts: 'v.json', cwd: repo.dir } });
    const ledger = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs;
    expect(ledger['core/awards#award-once']).toMatchObject({ verdict: 'proven' });
  });
});
