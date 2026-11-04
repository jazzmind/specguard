import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runPublish, runPublishCheck } from '../../src/pipelines/publish.js';
import { loadConfig } from '../../src/core/config.js';
import { fileBackend } from '../../src/server/central/file-backend.js';
import { startCentralServer, type RunningCentralServer } from '../../src/server/central/server.js';
import { makeRunRepo } from '../helpers/publish-fixture.js';

const BOOTSTRAP = 'bootstrap-secret-for-tests';
let server: RunningCentralServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startServer(): Promise<{ base: string; token: string }> {
  server = await startCentralServer({
    backend: fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-'))),
    llm: { provider: 'litellm', model: 'fast', apiKeyEnv: 'NOKEY' },
    port: 0,
    host: '127.0.0.1',
    workDir: mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-work-')),
    auth: { bootstrapToken: BOOTSTRAP, maintainerEmails: ['ada@acme.test'], allowedDomain: 'acme.test', trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] },
  });
  const admin = { authorization: `Bearer ${BOOTSTRAP}`, 'content-type': 'application/json' };
  expect((await fetch(`${server.url}/api/v1/projects`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'demo' }) })).status).toBe(201);
  const res = await fetch(`${server.url}/api/v1/admin/tokens`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'm', role: 'maintainer' }) });
  return { base: server.url, token: ((await res.json()) as { token: string }).token };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const WEBM = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(900_000, 7)]); // > 1 chunk of 768 KB
const ZIP = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(2000, 9)]);

describe('publish with evidence against a real local server', () => {
  // [claims: capabilities/team-server#evidence-upload-protocol, capabilities/team-server#publish-state-check, capabilities/team-server#server-test-report, capabilities/team-server#publish-digest-check]
  it('checks, uploads a run with media in chunks, serves the report and evidence, and then reports up to date', async () => {
    const { base, token } = await startServer();
    const { repo } = await makeRunRepo({
      server: { url: base, project: 'demo' },
      files: [
        { name: 'shot.png', content: PNG, contentType: 'image/png' },
        { name: 'video.webm', content: WEBM, contentType: 'video/webm' },
        { name: 'trace.zip', content: ZIP, contentType: 'application/zip' },
      ],
    });
    const env = { ...process.env, SPECGUARD_TOKEN: token } as NodeJS.ProcessEnv;
    const config = () => loadConfig(repo.dir);

    // never published -> needs publish
    const before = await runPublishCheck(await config(), { env, evidence: 'all' });
    expect(before.publish).toMatchObject({ needsPublish: true });
    expect((before.publish as { reasons: string[] }).reasons).toContain('never-published');

    // publish snapshot + run + every blob
    const pushed = await runPublish(await config(), { push: true, evidence: 'all', env });
    expect(pushed.failed, pushed.messages.join('\n')).toBe(0);

    // the server has the run, complete, and serves the report with media inline
    const auth = { authorization: `Bearer ${token}` };
    const state = (await (await fetch(`${base}/api/v1/projects/demo/publish-state`, { headers: auth })).json()) as { runs: Array<{ runId: string; status: string; files: number }>; snapshot: { digest: { total: string } } };
    expect(state.runs[0]).toMatchObject({ runId: 'run-1', status: 'complete', files: 3 });
    const html = await (await fetch(`${base}/api/v1/projects/demo/runs/latest/report/index.html`, { headers: auth })).text();
    expect(html).not.toContain('file://');
    const img = html.match(/<img src="(evidence\/[^"]+\.png)"/);
    expect(img, 'screenshot is in the report').toBeTruthy();
    const imgRes = await fetch(`${base}/api/v1/projects/demo/runs/latest/report/${img![1]}`, { headers: auth });
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await imgRes.arrayBuffer()).equals(PNG)).toBe(true);
    const vid = html.match(/src="(evidence\/[^"]+\.webm)"/);
    expect(vid, 'video is in the report').toBeTruthy();
    const range = await fetch(`${base}/api/v1/projects/demo/runs/latest/report/${vid![1]}`, { headers: { ...auth, range: 'bytes=0-9' } });
    expect(range.status).toBe(206);
    // the trace downloads as an attachment, never inline
    const tr = html.match(/href="(evidence\/[^"]+\.zip)"/);
    expect(tr, 'trace is linked').toBeTruthy();
    expect((await fetch(`${base}/api/v1/projects/demo/runs/latest/report/${tr![1]}`, { headers: auth })).headers.get('content-disposition')).toMatch(/attachment/);

    // now up to date, and the server's digest matches the local one (no false "changed")
    const after = await runPublishCheck(await config(), { env, evidence: 'all' });
    expect(after.publish, JSON.stringify(after.publish)).toMatchObject({ needsPublish: false, reasons: [] });
    expect(after.exitCode).toBe(0);

    // republishing uploads nothing new: every blob is already there
    const again = await runPublish(await config(), { push: true, evidence: 'all', env });
    expect(again.failed).toBe(0);

    // edit a spec -> exactly that file is reported as changed
    const spec = path.join(repo.dir, 'specs/capabilities/auth.md');
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}\nAn extra sentence.\n`);
    const changed = await runPublishCheck(await config(), { env, evidence: 'all' });
    const c = changed.publish as { needsPublish: boolean; reasons: string[]; specFiles: { modified: string[] } };
    expect(c.needsPublish).toBe(true);
    expect(c.reasons).toContain('specs-changed');
    expect(c.specFiles.modified).toContain('specs/capabilities/auth.md');
    expect(changed.exitCode).toBe(9);
  }, 60_000);
});
