import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/mcp/server.js';
import { writeAgentRequest } from '../../src/core/agent-work.js';
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
const HASH = 'ab'.repeat(32);

describe('mcp agent work tool [integration-surfaces]', () => {
  const seed = () => {
    const repo = makeRepo();
    writeAgentRequest(repo.dir, path.join(repo.dir, '.specguard', 'replay'), { hash: HASH, kind: 'object', pipeline: 'summarize', prompt: 'p', jsonSchema: { type: 'object' } });
    return repo;
  };

  // [claims: capabilities/integration-surfaces#agent-work-tools]
  it('is one of the default tools, lists requests in full and records an answer by hash prefix', async () => {
    const repo = seed();
    const client = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('specguard_agent_work');

    const listed = JSON.parse(text(await client.callTool({ name: 'specguard_agent_work', arguments: { action: 'list', cwd: repo.dir } })));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ hash: HASH, pipeline: 'summarize', jsonSchema: { type: 'object' } });

    const res = await client.callTool({ name: 'specguard_agent_work', arguments: { action: 'answer', hash: HASH.slice(0, 10), answer: { summaries: [] }, cwd: repo.dir } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const recorded = JSON.parse(readFileSync(path.join(repo.dir, '.specguard', 'replay', `${HASH}.json`), 'utf8'));
    expect(recorded).toMatchObject({ hash: HASH, response: { summaries: [] } });
  });

  // [claims: capabilities/integration-surfaces#agent-work-tools]
  it('refuses an unknown request, a missing answer, and answers in read-only mode', async () => {
    const repo = seed();
    const client = await connect();
    const unknown = await client.callTool({ name: 'specguard_agent_work', arguments: { action: 'answer', hash: 'ffffffffff', answer: {}, cwd: repo.dir } });
    expect((unknown as { isError?: boolean }).isError).toBe(true);
    const missing = await client.callTool({ name: 'specguard_agent_work', arguments: { action: 'answer', hash: HASH, cwd: repo.dir } });
    expect(text(missing)).toContain('answer is required');
    expect(existsSync(path.join(repo.dir, '.specguard', 'replay', `${HASH}.json`))).toBe(false);

    process.env.SPECGUARD_MCP_READONLY = '1';
    try {
      const names = (await (await connect()).listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('specguard_agent_work');
    } finally {
      delete process.env.SPECGUARD_MCP_READONLY;
    }
  });
});
