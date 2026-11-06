import { describe, expect, it } from 'vitest';
import { classifyLink, groupPages, preprocessMarkdown, renderMarkdown, resolveTopic, type DocManifest, type HelpTopics } from './docs-content.js';

const manifest: DocManifest = { version: 1, pages: [
  { id: 'contracts', title: 'Contracts', audience: 'user', group: 'Quickstarts', file: 'guide/contracts.md', sections: [{ anchor: 'steps', title: 'Steps' }] },
  { id: 'arch', title: 'Architecture', audience: 'dev', group: 'Developer', file: 'dev/architecture.md', sections: [] },
  { id: 'what', title: 'What', audience: 'user', group: 'Start here', file: 'guide/what.md', sections: [] },
] };
const topics: HelpTopics = { 'workspace.status': { title: 'Status', text: 't', page: 'guide/vscode-extension.md', anchor: 'workspace-status' } };

// [claims: capabilities/integration-surfaces#extension-docs-viewer]
describe('documentation topics', () => {
  it('resolves a help key to its page and anchor', () => {
    expect(resolveTopic('workspace.status', topics, manifest)).toEqual({ file: 'guide/vscode-extension.md', anchor: 'workspace-status' });
  });
  it('resolves page.md#anchor for a shipped page, with or without an anchor', () => {
    expect(resolveTopic('guide/contracts.md#steps', topics, manifest)).toEqual({ file: 'guide/contracts.md', anchor: 'steps' });
    expect(resolveTopic('dev/architecture.md', topics, manifest)).toEqual({ file: 'dev/architecture.md', anchor: undefined });
  });
  it('opens the index for nothing, an unknown key, an unshipped page or a path outside the docs', () => {
    for (const t of [undefined, '', 'no.such.key', 'guide/missing.md#x', '../../etc/passwd', '__proto__']) expect(resolveTopic(t, topics, manifest)).toEqual({ file: 'index.md' });
  });
  it('groups pages with user groups before developer groups', () => {
    expect(groupPages(manifest).map((g) => g.group)).toEqual(['Quickstarts', 'Start here', 'Developer']);
  });
});

// [claims: capabilities/integration-surfaces#extension-docs-viewer]
describe('links in a rendered page', () => {
  it('rewrites relative .md links to in-panel navigation resolved from the current page', () => {
    expect(classifyLink('contracts.md#steps', 'guide/vscode-extension.md')).toEqual({ kind: 'page', file: 'guide/contracts.md', anchor: 'steps' });
    expect(classifyLink('../reference/x.md', 'guide/a/b.md')).toEqual({ kind: 'page', file: 'guide/reference/x.md', anchor: undefined });
    expect(classifyLink('#goal', 'guide/a.md')).toEqual({ kind: 'anchor', anchor: 'goal' });
  });
  it('sends http(s) links out and neutralises everything else', () => {
    expect(classifyLink('https://example.com/a', 'index.md')).toEqual({ kind: 'external', url: 'https://example.com/a' });
    for (const h of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', '//evil.test/a.md', 'image.png', '../../../x.md', '#']) expect(classifyLink(h, 'guide/a.md').kind).toBe('none');
  });
  it('renders links with data attributes and a placeholder href', () => {
    const html = renderMarkdown('[a](contracts.md#steps) [b](https://example.com) [c](javascript:alert(1))', 'guide/x.md');
    expect(html).toContain('data-kind="page" data-file="guide/contracts.md" data-anchor="steps"');
    expect(html).toContain('data-kind="external" data-url="https://example.com"');
    expect(html).not.toMatch(/<a [^>]*javascript:/); // markdown-it leaves an unsafe link as plain text
    expect(html).not.toMatch(/href="(?!#")/);
  });
});

// [claims: capabilities/integration-surfaces#extension-docs-viewer]
describe('anchor lines and raw HTML', () => {
  const page = '---\ntitle: T\n---\n<a id="goal"></a>\n# Goal\ntext\n\n<a id="the-steps"></a>\n## Steps\n\n## No anchor here\n';
  it('turns anchor lines into heading ids and drops the front matter', () => {
    const { markdown, ids } = preprocessMarkdown(page);
    expect(markdown).not.toContain('<a id');
    expect(markdown).not.toContain('title: T');
    expect(ids).toEqual(['goal', 'the-steps', undefined]);
    const html = renderMarkdown(page, 'guide/x.md');
    expect(html).toContain('<h1 id="goal">Goal</h1>');
    expect(html).toContain('<h2 id="the-steps">Steps</h2>');
    expect(html).toContain('<h2 id="no-anchor-here">No anchor here</h2>');
  });
  it('keeps anchor-looking lines inside code fences', () => {
    const html = renderMarkdown('```\n<a id="x"></a>\n```\n# H\n', 'a.md');
    expect(html).toContain('&lt;a id=&quot;x&quot;&gt;&lt;/a&gt;');
    expect(html).toContain('<h1 id="h">H</h1>');
  });
  it('does not pass raw HTML through', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a id="x" onclick="y()">z</a>\n', 'a.md');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<a id=/);
    expect(html).toContain('&lt;script&gt;');
  });
});
