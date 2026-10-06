import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { guessRepoRole, workspaceRepoKey } from '../../src/core/workspace-heuristics.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-role-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });
const cfg = (app: Record<string, unknown>) => JSON.stringify({ apps: [{ name: 'a', repo: '.', specDir: 'specs', sources: {}, testOutput: 't', framework: 'vitest', ...app }], llm: {} });

describe('workspace heuristics', () => {
  it('derives repo keys from the directory name only', () => {
    expect(workspaceRepoKey('Acme_Admin App')).toBe('acme-admin-app');
    expect(workspaceRepoKey('practera-admin-app')).toBe('practera-admin-app');
    expect(workspaceRepoKey('--x--')).toBe('x');
  });

  it('classifies by content, not by name', () => {
    expect(guessRepoRole(repo({ 'package.json': pkg({ react: '18' }) }))).toBe('consumer');
    expect(guessRepoRole(repo({ 'package.json': pkg({ next: '15', express: '4' }) }))).toBe('consumer');
    expect(guessRepoRole(repo({ 'package.json': pkg({ fastify: '4' }) }))).toBe('provider');
    expect(guessRepoRole(repo({ 'openapi.yaml': 'openapi: 3.0.0' }))).toBe('provider');
    expect(guessRepoRole(repo({ 'pyproject.toml': 'dependencies = ["fastapi"]' }))).toBe('provider');
    expect(guessRepoRole(repo({ 'go.mod': 'module x' }))).toBe('provider');
    expect(guessRepoRole(repo({ '.specguard/config.json': cfg({ framework: 'playwright' }) }))).toBe('test');
    expect(guessRepoRole(repo({ 'mkdocs.yml': 'site_name: x' }))).toBe('docs');
    expect(guessRepoRole(repo({ '.specguard/config.json': cfg({ language: 'python' }), 'x.py': '' }))).toBe('provider');
    // a repo literally named "api" or "app" says nothing
    const named = path.join(mkdtempSync(path.join(os.tmpdir(), 'sg-role-')), 'api');
    mkdirSync(named);
    writeFileSync(path.join(named, 'package.json'), pkg({ react: '18' }));
    expect(guessRepoRole(named)).toBe('consumer');
  });
});
