import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileBackend } from '../../src/server/central/file-backend.js';
import { startCentralServer, type RunningCentralServer } from '../../src/server/central/server.js';

export const BOOTSTRAP = 'bootstrap-secret-for-tests';

export interface TestServer {
  server: RunningCentralServer;
  base: string;
  /** Create a token through the admin API. */
  mint(body: Record<string, unknown>): Promise<string>;
  stop(): Promise<void>;
}

/** A real team server on an ephemeral port, backed by a temp directory. */
export async function startTestServer(opts: { basePath?: string } = {}): Promise<TestServer> {
  const backend = fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-ts-')));
  const server = await startCentralServer({
    backend,
    llm: { provider: 'litellm', model: 'fast', apiKeyEnv: 'NOKEY' },
    port: 0,
    host: '127.0.0.1',
    workDir: mkdtempSync(path.join(os.tmpdir(), 'sg-ts-work-')),
    auth: { bootstrapToken: BOOTSTRAP },
    ...opts,
  });
  return {
    server,
    base: server.url,
    mint: async (body) => {
      const res = await fetch(`${server.url}/api/v1/admin/tokens`, { method: 'POST', headers: { Authorization: `Bearer ${BOOTSTRAP}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status !== 201) throw new Error(`could not mint a token: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { token: string }).token;
    },
    stop: () => server.close(),
  };
}
