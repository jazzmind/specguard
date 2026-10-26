import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { CHANGES_DIR } from '../../src/core/change-record.js';
import { buildServer } from '../../src/mcp/server.js';
import { addFreeShippingClaim, changeRepo } from '../helpers/change-fixture.js';

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(b);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(a);
  return client;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');
const CHANGE_TOOLS = ['specguard_change_start', 'specguard_change_red', 'specguard_change_green', 'specguard_change_status', 'specguard_change_report'];

describe('mcp change tools [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-mcp-tools]
  it('offers the five change tools by default, no tool that approves or closes a change, and only status and report when read-only', async () => {
    const names = (await (await connect()).listTools()).tools.map((t) => t.name);
    for (const t of CHANGE_TOOLS) expect(names).toContain(t);
    expect(names.filter((n) => /approve|abandon|convert|done/.test(n))).toEqual([]);

    process.env.SPECGUARD_MCP_READONLY = '1';
    try {
      const readOnly = (await (await connect()).listTools()).tools.map((t) => t.name);
      expect(readOnly.filter((n) => n.startsWith('specguard_change_')).sort()).toEqual(['specguard_change_report', 'specguard_change_status']);
    } finally {
      delete process.env.SPECGUARD_MCP_READONLY;
    }
  });

  // [claims: capabilities/spec-first-changes#change-mcp-tools]
  it('starts a change, reports its stage with the next step, and refuses what the stage does not allow', async () => {
    const repo = changeRepo();
    const client = await connect();
    const call = async (name: string, args: Record<string, unknown>) => text(await client.callTool({ name, arguments: { cwd: repo.dir, ...args } }));

    expect(await call('specguard_change_start', { capabilities: ['nope'] })).toContain('no capability named nope');
    expect(existsSync(path.join(repo.dir, CHANGES_DIR))).toBe(false);

    const started = await call('specguard_change_start', { capabilities: ['shop'], why: 'free shipping' });
    expect(started).toContain('(feature) for shop');
    const [file] = readdirSync(path.join(repo.dir, CHANGES_DIR));
    const id = file!.replace(/\.json$/, '');

    let status = JSON.parse(await call('specguard_change_status', {}));
    expect(status.changes[0]).toMatchObject({ id, kind: 'feature', stage: 'spec', next: 'edit the requirements in the spec of shop' });
    expect(status.changes[0].blocks[0].code).toBe('NO_INTENT_CHANGE');

    addFreeShippingClaim(repo);
    status = JSON.parse(await call('specguard_change_status', { id }));
    expect(status.changes[0].next).toBe('specguard spec approve capabilities/shop#free-shipping');

    // an agent cannot talk its way past the stages: red before approval is refused
    expect(await call('specguard_change_red', { id })).toContain('not ready for red (stage spec)');
    expect(await call('specguard_change_green', { id })).toContain('not ready for green');
    expect(JSON.parse(await call('specguard_change_status', { id })).changes[0].stage).toBe('spec');
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-mcp-tools]
  it('returns the provisional packet as markdown followed by its JSON, and an error for an unknown change', async () => {
    const repo = changeRepo();
    const client = await connect();
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { cwd: repo.dir, ...args } });
    await call('specguard_change_start', { capabilities: ['shop'], why: 'free shipping' });
    addFreeShippingClaim(repo);

    const report = await call('specguard_change_report', {});
    const body = text(report);
    expect(body.split('\n')[0]).toBe('<!-- specguard-proof-packet v1 -->');
    expect(JSON.parse(body.slice(body.indexOf('\n{\n'))).provisional).toBe(true);

    const missing = await call('specguard_change_status', { id: 'no-such-change' });
    expect((missing as { isError?: boolean }).isError).toBe(true);
    expect(text(missing)).toContain('no change "no-such-change"');
  }, 120_000);
});
