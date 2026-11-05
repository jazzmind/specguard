import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseCliLine, parseCheckOutput, teamSectionHtml, publishArgs, reasonsText, evidenceBytes, totalEvidenceBytes, repoStatus, reportUrl, formatBytes, type TeamCheck, type TeamRepoCheck, type TeamModel } from './team-publish.js';

const dir = path.resolve(__dirname, '../../tests/fixtures/publish-contract');
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const mixed = JSON.parse(read('workspace-check-mixed.json')) as TeamCheck;
const noServer = JSON.parse(read('workspace-check-no-server.json')) as TeamCheck;
const needs = JSON.parse(read('publish-check-needs.json')) as TeamRepoCheck;
const model = (over: Partial<TeamModel> = {}): TeamModel => ({ phase: 'idle', check: mixed, evidence: false, ...over });

// [claims: capabilities/integration-surfaces#extension-team-publish]
describe('parseCliLine', () => {
  it('reads every NDJSON progress fixture line and keeps plain lines as text', () => {
    const parsed = read('progress.ndjson').split('\n').filter(Boolean).map(parseCliLine);
    expect(parsed.filter((p) => p.kind === 'progress')).toHaveLength(3);
    expect(parsed[1]).toEqual({ kind: 'progress', progress: { sg: 'progress', key: 'es', phase: 'upload', done: 3, total: 12, bytes: 52428800 } });
    expect(parsed[3]).toEqual({ kind: 'text', text: 'plain log line that is not JSON' });
  });
  it('treats malformed or unrelated JSON as text', () => {
    expect(parseCliLine('{"sg":"progress","phase":"bogus"}').kind).toBe('text');
    expect(parseCliLine('{not json}').kind).toBe('text');
    expect(parseCliLine('{"other":1}').kind).toBe('text');
  });
});

// [claims: capabilities/integration-surfaces#extension-team-publish]
describe('parseCheckOutput, pipeline-wrapped', () => {
  it('finds the check under `publish` in the CLI result', () => {
    const wrapped = JSON.stringify({ pipeline: 'workspace-publish', exitCode: 9, messages: ['x'], publish: { schema: 'specguard-workspace-publish-check/1', workspace: 'w', server: { url: 'u', reachable: true, signedIn: true, features: [] }, definition: { needsPublish: true, reasons: ['missing'] }, repos: [] } });
    const out = parseCheckOutput([wrapped]);
    expect(out.check?.workspace).toBe('w');
  });
});

describe('parseCheckOutput', () => {
  it('finds a pretty-printed check among progress and log lines', () => {
    const lines = ['warming up', ...JSON.stringify(mixed, null, 2).split('\n'), '{"sg":"progress","phase":"hash","done":1,"total":2,"bytes":0}'];
    const out = parseCheckOutput(lines);
    expect(out.check?.workspace).toBe('demo');
    expect(parseCheckOutput(['just a log line', 'Error: boom']).check).toBeUndefined();
  });
});

// [claims: capabilities/integration-surfaces#extension-team-publish]
describe('row status and reasons', () => {
  it('classifies the mixed fixture: up to date, needs publish, never published, error', () => {
    expect(mixed.repos.map(repoStatus)).toEqual(['up-to-date', 'needs-publish', 'never-published', 'error']);
  });
  it('summarises reasons with spec counts and the run size', () => {
    expect(reasonsText(needs)).toBe('3 specs changed · proofs changed · new run (520 MB)');
  });
  it('sums the evidence still to upload and skips runs the server holds', () => {
    expect(evidenceBytes(needs)).toBe(520000000);
    expect(totalEvidenceBytes(mixed)).toBeGreaterThanOrEqual(520000000);
    expect(formatBytes(412000000)).toBe('412 MB');
    expect(formatBytes(0)).toBe('0 B');
  });
});

// [claims: capabilities/integration-surfaces#extension-team-publish]
describe('publishArgs', () => {
  it('builds the check, one repo, all repos and definition command lines', () => {
    expect(publishArgs('check')).toEqual(['workspace', 'publish', '--check', '--json']);
    expect(publishArgs('publish', 'es')).toEqual(['workspace', 'publish', '--repos', '--only', 'es', '--progress-json']);
    expect(publishArgs('publish', undefined, true)).toEqual(['workspace', 'publish', '--repos', '--progress-json', '--evidence']);
    expect(publishArgs('definition')).toEqual(['workspace', 'publish']);
  });
  it('refuses keys that could be read as flags or lists, and never carries a token', () => {
    expect(() => publishArgs('publish', '--evidence')).toThrow();
    expect(() => publishArgs('publish', 'a,b')).toThrow();
    expect(() => publishArgs('publish', '')).toThrow();
    for (const a of [publishArgs('check'), publishArgs('publish', 'es', true), publishArgs('definition')]) expect(a.join(' ')).not.toMatch(/token/i);
  });
});

// [claims: capabilities/integration-surfaces#extension-team-publish]
describe('teamSectionHtml', () => {
  it('shows the server, sign-in state, role and one row per repo with badges', () => {
    const html = teamSectionHtml(model());
    expect(html).toContain('https://team.example/specguard');
    expect(html).toContain('Signed in as maintainer');
    for (const label of ['Up to date', 'Needs publish', 'Never published', 'Error']) expect(html).toContain(label);
    expect((html.match(/data-act="teamPublish"/g) ?? []).length).toBe(4);
    expect(html).toContain('3 specs changed');
    expect(html).toContain('no config found');
    for (const act of ['teamCheck', 'teamPublishAll', 'teamPublishDef', 'teamOpenReport']) expect(html).toContain(`data-act="${act}"`);
  });
  it('has the evidence toggle off by default and shows the size still to upload', () => {
    const off = teamSectionHtml(model());
    expect(off).toMatch(/<input type="checkbox" data-team-evidence>/);
    expect(off).toMatch(/\d+ MB still to upload/);
    expect(teamSectionHtml(model({ evidence: true }))).toContain('data-team-evidence checked');
  });
  it('escapes strings from the CLI, including a spec file name and a repo key with markup', () => {
    expect(JSON.stringify(mixed)).toContain('specs/<b>.md');
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const check: TeamCheck = { ...mixed, workspace: evil, server: { ...mixed.server, url: `https://x.example/${evil}`, role: evil }, repos: [{ key: evil, error: evil }, { ...needs, key: `k${evil}`, reasons: ['specs-changed', evil], specFiles: { added: [], removed: [], modified: ['specs/<b>.md'] } }] };
    const html = teamSectionHtml(model({ check, error: evil, log: [evil], progress: { sg: 'progress', key: evil, phase: 'upload', done: 1, total: 2, bytes: 1 }, phase: 'publishing', busyKey: '' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;');
  });
  it('shows a settings prompt when no server is configured', () => {
    const html = teamSectionHtml({ phase: 'idle', noServer: true, evidence: false });
    expect(html).toContain('Set the server in Workspace Settings');
    expect(html).toContain('data-act="settings"');
    expect(html).not.toContain('teamPublish');
    // the CLI's own answer for an unconfigured server has an empty url and no repos
    expect(noServer.server.url).toBe('');
  });
  it('offers sign-in when the server is reachable but the caller is not signed in, and disables publishing', () => {
    const check: TeamCheck = { ...mixed, server: { ...mixed.server, signedIn: false, role: undefined } };
    const html = teamSectionHtml(model({ check }));
    expect(html).toContain('Not signed in');
    expect(html).toContain('data-act="teamSignIn"');
    expect(html).not.toMatch(/data-act="teamPublishAll"(?![^>]*disabled)/);
  });
  it('disables controls while busy and renders progress', () => {
    const html = teamSectionHtml(model({ phase: 'publishing', busyKey: 'es', progress: { sg: 'progress', key: 'es', phase: 'upload', done: 3, total: 12, bytes: 52428800 } }));
    expect(html).toContain('Uploading 3/12 (52.4 MB)');
    expect(html).toContain('<progress max="12" value="3">');
    expect(html).not.toMatch(/data-act="teamCheck"(?![^>]*disabled)/);
  });
});

// [claims: capabilities/integration-surfaces#extension-team-publish]
describe('reportUrl', () => {
  it('points at the workspace or repo report on the server, encoded, and refuses unknown repos', () => {
    expect(reportUrl(mixed)).toBe('https://team.example/specguard/api/v1/workspaces/demo/report/index.html');
    expect(reportUrl(mixed, 'es')).toBe('https://team.example/specguard/api/v1/workspaces/demo/report/repos/es/index.html');
    expect(reportUrl(mixed, '../x')).toBeUndefined();
    expect(reportUrl(noServer)).toBeUndefined();
  });
});
