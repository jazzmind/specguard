import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectFramework, getFrameworkProfile, readEntryPoints } from '../../src/core/framework-profiles.js';
import { buildIndexPrompt } from '../../src/pipelines/index-generate.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-fw-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

describe('framework profiles', () => {
  it('detects frameworks from manifests', () => {
    expect(detectFramework(repo({ 'package.json': pkg({ next: '1', react: '1' }) })).id).toBe('next');
    expect(detectFramework(repo({ 'package.json': pkg({ react: '1' }) })).id).toBe('react');
    expect(detectFramework(repo({ 'package.json': pkg({ '@angular/core': '1' }) })).id).toBe('angular');
    expect(detectFramework(repo({ 'package.json': pkg({ vue: '1' }) })).id).toBe('vue');
    expect(detectFramework(repo({ 'package.json': pkg({ express: '4' }) })).id).toBe('express');
    expect(detectFramework(repo({ 'package.json': pkg({ fastify: '4' }) })).id).toBe('fastify');
    expect(detectFramework(repo({ 'package.json': pkg({ '@nestjs/core': '10' }) })).id).toBe('nestjs');
    expect(detectFramework(repo({ 'requirements.txt': 'fastapi==0.1\nuvicorn' })).id).toBe('fastapi');
    expect(detectFramework(repo({ 'pyproject.toml': 'dependencies = ["Flask"]' })).id).toBe('flask');
    expect(detectFramework(repo({ 'requirements.txt': 'Django' })).id).toBe('django');
    expect(detectFramework(repo({ 'go.mod': 'module x' })).id).toBe('go-http');
    expect(detectFramework(repo({ 'pom.xml': '<artifactId>spring-boot-starter</artifactId>' })).id).toBe('spring');
    expect(detectFramework(repo({ 'notes.txt': '' })).id).toBe('generic');
  });

  it('reads profile entry points, and app.entryPoints replaces them', async () => {
    const dir = repo({
      'package.json': pkg({ express: '4' }),
      'src/server.ts': 'app.get("/a")',
      'src/custom/routes.ts': 'router.post("/b")',
      'src/custom/more.ts': 'x',
    });
    const profile = detectFramework(dir);
    const defaults = await readEntryPoints(dir, profile);
    expect(defaults.map((e) => e.file)).toEqual(['src/server.ts']);
    const custom = await readEntryPoints(dir, profile, { entryPoints: ['src/custom/*.ts'] });
    expect(custom.map((e) => e.file)).toEqual(['src/custom/more.ts', 'src/custom/routes.ts']);
    const capped = await readEntryPoints(dir, profile, { entryPoints: ['src/custom/*.ts'] }, { maxFiles: 1, perFileChars: 3 });
    expect(capped).toHaveLength(1);
    expect(capped[0].source).toHaveLength(1);
  });

  it('builds a prompt that names the surface and does not assume a frontend', () => {
    const express = getFrameworkProfile('express')!;
    const prompt = buildIndexPrompt('svc', '', ['a.md'], [{ file: 'src/server.ts', source: 'x' }], express);
    expect(prompt).toContain('Express codebase');
    expect(prompt).toContain('endpoints');
    expect(prompt).not.toMatch(/frontend|App\.tsx|React/);
    const next = buildIndexPrompt('web', '', [], [{ file: 'app/page.tsx', source: 'y' }], getFrameworkProfile('next')!);
    expect(next).toContain('routes');
    expect(next).toContain('```tsx');
  });
});
