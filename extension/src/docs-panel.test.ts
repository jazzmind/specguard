import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ window: {}, commands: {}, env: {}, Uri: {}, ViewColumn: { Active: 1 } }));
import { initDocs } from './docs-content.js';
import { buildDocsHtml } from './docs-panel.js';

const repo = path.resolve(__dirname, '../..');

// [claims: capabilities/integration-surfaces#extension-docs-viewer]
describe('the docs panel page', () => {
  const ext = mkdtempSync(path.join(tmpdir(), 'sg-docs-'));
  const docs = path.join(ext, 'media', 'docs');
  mkdirSync(path.join(docs, 'guide'), { recursive: true });
  copyFileSync(path.join(repo, 'docs', 'manifest.json'), path.join(docs, 'manifest.json'));
  writeFileSync(path.join(docs, 'index.md'), '# Home\n\n[go](guide/what-is-specguard.md#goal)\n');
  writeFileSync(path.join(docs, 'guide', 'what-is-specguard.md'), '<a id="goal"></a>\n## Goal\n\n<script>x()</script>\n[out](https://example.com)\n');
  initDocs(ext);

  it('has the restrictive CSP, a nonce script, no inline handlers and the manifest table of contents', () => {
    const html = buildDocsHtml({ file: 'guide/what-is-specguard.md', anchor: 'goal' }, 'vscode-resource:', 'N0NCE');
    expect(html).toContain("default-src 'none'; style-src vscode-resource: 'unsafe-inline'; script-src 'nonce-N0NCE'");
    expect(html).toContain('<script nonce="N0NCE">');
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('<h2 id="goal">Goal</h2>');
    expect(html).toContain('What is SpecGuard and why it exists');
    expect(html).toContain('data-kind="external" data-url="https://example.com"');
    expect(html).not.toContain('<script>x()');
    expect(html).toContain('const anchor = "goal"');
  });
  it('shows the index for a page that is not shipped', () => {
    const html = buildDocsHtml({ file: 'guide/missing.md' }, 'c:', 'n');
    expect(html).toContain('<h1 id="home">Home</h1>');
    expect(html).toContain('data-kind="page" data-file="guide/what-is-specguard.md" data-anchor="goal"');
  });
});
