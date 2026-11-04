import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import type { SpecGuardConfig } from '../../src/core/types.js';
import { gitInit, makeV2Repo } from './v2-repo.js';
import type { TmpRepo } from './repo.js';

const AUTH = 'capabilities/auth#login-valid-code';

/** Playwright JSON with one passing test per attachment set. */
export function playwrightWith(attachments: Array<{ name: string; contentType: string; path: string }>): string {
  return JSON.stringify({
    config: {},
    suites: [
      {
        title: 'auth.spec.ts',
        file: 'auth.spec.ts',
        specs: [
          {
            title: `logs in @claim:${AUTH}`,
            file: 'auth.spec.ts',
            tests: [{ projectName: 'chromium', status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed', duration: 12, attachments }] }],
          },
        ],
      },
    ],
  });
}

export interface RunRepo {
  repo: TmpRepo;
  config: SpecGuardConfig;
}

/**
 * A v2 repo with a recorded run: `files` are written into the repo and attached to the one test. `server` goes into the
 * config so `publish` finds it.
 */
export async function makeRunRepo(opts: { server?: { url: string; project?: string }; files?: Array<{ name: string; content: string | Buffer; contentType?: string }>; runId?: string; git?: boolean } = {}): Promise<RunRepo> {
  const repo = makeV2Repo(opts.server ? { server: opts.server } : {});
  repo.write('.gitignore', '.specguard/\n');
  const attachments = (opts.files ?? []).map((f) => {
    repo.write(`shots/${f.name}`, f.content as string);
    return { name: f.name, contentType: f.contentType ?? 'image/png', path: `shots/${f.name}` };
  });
  if (opts.files) {
    repo.write('reports/pw.json', playwrightWith(attachments));
    await runResultsIngest(['reports/pw.json'], repo.dir, { runId: opts.runId ?? 'run-1' });
  }
  if (opts.git !== false) gitInit(repo.dir);
  return { repo, config: await loadConfig(repo.dir) };
}

export const abs = (repo: TmpRepo, rel: string): string => path.join(repo.dir, rel);
