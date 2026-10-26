import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/mcp/server.js';

async function toolNames(legacy: boolean): Promise<string[]> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ legacy }).connect(b);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(a);
  return (await client.listTools()).tools.map((t) => t.name);
}

describe('mcp surface has no approval tool [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approve-cli-only]
  it('no tool name contains "approve", with or without the legacy tools', async () => {
    for (const legacy of [false, true]) {
      const names = await toolNames(legacy);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => n.toLowerCase().includes('approve'))).toEqual([]);
    }
  });
});
