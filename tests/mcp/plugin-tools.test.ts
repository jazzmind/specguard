import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const seen: Array<{ name: string; ctx: { config: unknown; opts: Record<string, unknown>; args: string[] } }> = [];
vi.mock('../../src/plugins/commands.js', () => ({
  enabledPluginCommands: vi.fn(async () => [
    {
      name: 'typed',
      description: 'typed inputs, one named args and one named options',
      mcpParams: { args: z.string().optional(), options: z.string().optional(), limit: z.number().optional() },
      run: async (ctx: { config: unknown; opts: Record<string, unknown>; args: string[] }) => {
        seen.push({ name: 'typed', ctx });
        return { pipeline: 'typed', created: 0, updated: 0, skipped: 0, failed: 0, exitCode: 0, items: [], messages: ['ok'] };
      },
    },
    {
      name: 'free',
      description: 'free-form',
      needsConfig: false,
      run: async (ctx: { config: unknown; opts: Record<string, unknown>; args: string[] }) => {
        seen.push({ name: 'free', ctx });
        return { pipeline: 'free', created: 0, updated: 0, skipped: 0, failed: 0, exitCode: 0, items: [], messages: ['ok'] };
      },
    },
  ]),
}));

import { tryLoadCliConfig } from '../../src/cli/commands/helpers.js';
import { registerPluginTools } from '../../src/mcp/server.js';
import { makeRepo } from '../helpers/repo.js';

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

async function tools(cwd: string) {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _schema: unknown, handler: Handler) => void handlers.set(name, handler) };
  await registerPluginTools(server as never, cwd);
  return handlers;
}

describe('plugin tools on MCP [mcp-plugin-tools]', () => {
  // [claims: capabilities/integration-surfaces#plugin-commands]
  it('passes typed inputs through as options, even ones named args or options [typed-names]', async () => {
    const repo = makeRepo({});
    const handlers = await tools(repo.dir);
    seen.length = 0;
    await handlers.get('specguard_typed')!({ cwd: repo.dir, args: 'a', options: 'b', limit: 3 });
    expect(seen[0].ctx.opts).toEqual({ args: 'a', options: 'b', limit: 3 });
    expect(seen[0].ctx.args).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#plugin-commands]
  it('runs a command that needs no config in a directory without one, and still splits free-form args and options [no-config]', async () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), 'sg-bare-'));
    const handlers = await tools(bare);
    seen.length = 0;
    const res = (await handlers.get('specguard_free')!({ cwd: bare, args: ['x'], options: { flag: true } })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(seen[0].ctx).toMatchObject({ config: null, opts: { flag: true }, args: ['x'] });
    // A command that does need config reports the missing config instead of running.
    const failed = (await handlers.get('specguard_typed')!({ cwd: bare })) as { isError?: boolean };
    expect(failed.isError).toBe(true);
  });
});

describe('hook config loading [hook-config]', () => {
  // [claims: capabilities/requirement-history#history-hooks-silent]
  it('returns null instead of exiting when there is no SpecGuard config, so a hook never fails the session', async () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), 'sg-bare-'));
    expect(await tryLoadCliConfig({ config: bare } as never)).toBeNull();
    const repo = makeRepo({});
    expect(await tryLoadCliConfig({ config: repo.dir } as never)).not.toBeNull();
  });
});
