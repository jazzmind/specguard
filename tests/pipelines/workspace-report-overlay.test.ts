import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorkspaceReport } from '../../src/pipelines/workspace-report.js';

describe('workspace report and overlay repositories', () => {
  it('leaves a registered overlay root out instead of reporting "No config found"', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wsr-'));
    const overlay = path.join(root, 'specs-overlay');
    mkdirSync(path.join(overlay, '.specguard'), { recursive: true });
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    writeFileSync(path.join(root, '.specguard', 'workspace.json'), JSON.stringify({ version: '1.0', name: 'w', repos: { 'specs-overlay': { path: 'specs-overlay', role: 'docs' } } }));
    const cfgHome = mkdtempSync(path.join(tmpdir(), 'cfg-'));
    mkdirSync(path.join(cfgHome, 'specguard'));
    writeFileSync(path.join(cfgHome, 'specguard', 'overlays.json'), JSON.stringify({ version: 1, overlays: [{ root: overlay, addedAt: 'x', entries: [] }] }));
    const old = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = cfgHome;
    try {
      const res = await runWorkspaceReport(root, {});
      expect(res.messages.join('\n')).toMatch(/overlay repository, left out/);
      const data = JSON.parse(readFileSync(path.join(root, '.specguard/report/workspace/workspace-report.json'), 'utf8'));
      expect(data.repos.map((r: { key: string }) => r.key)).not.toContain('specs-overlay');
    } finally {
      if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old;
    }
  });
});
