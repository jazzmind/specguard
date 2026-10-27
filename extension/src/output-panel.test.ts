import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ receive: undefined as undefined | ((msg: unknown) => Promise<void>), show: vi.fn(), get: vi.fn(), html: '' }));
vi.mock('vscode', () => ({
  window: { createWebviewPanel: () => ({ webview: { set html(s: string) { m.html = s; }, onDidReceiveMessage: (cb: typeof m.receive) => { m.receive = cb; } } }), showTextDocument: m.show, showErrorMessage: vi.fn() },
  ViewColumn: { Active: 1 }, Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o: { content: string }) => o },
}));
vi.mock('./output-inventory.js', () => ({ collectOutputs: async () => [{ path: '/project/docs/local.md', relativePath: 'docs/local.md', title: 'Local guide' }] }));
vi.mock('./project-config.js', () => ({ configDirFor: (root: string) => root }));
vi.mock('./api/shared.js', () => ({ getHub: () => ({ get: async () => ({ source: 'server', project: 'shop', client: { get: m.get } }) }) }));
import { openOutputs, outputHtml } from './output-panel.js';
describe('output browser', () => {
  // [claims: capabilities/integration-surfaces#extension-output-browser]
  it('lists local and team-server docs and opens authenticated remote markdown inside VS Code', async () => {
    m.get.mockImplementation(async (route: string) => route === '/docs' ? { documents: [{ id: 'cart', title: 'Cart guide', audiences: ['user'] }] } : { markdown: '# Server cart guide' });
    await openOutputs('/project', 'docs');
    expect(m.html).toContain('Local guide');
    expect(m.html).toContain('Cart guide');
    expect(m.html).toContain('Team server');
    await m.receive!({ type: 'open', index: 1 });
    expect(m.get).toHaveBeenCalledWith('/docs/user/cart');
    expect(m.show).toHaveBeenCalledWith({ language: 'markdown', content: '# Server cart guide' }, { preview: true });
    const before = m.show.mock.calls.length;
    await m.receive!({ type: 'open', index: 200 });
    expect(m.show).toHaveBeenCalledTimes(before);
  });
  // [claims: capabilities/integration-surfaces#extension-output-browser]
  it('escapes file metadata and includes accessible search and a nonce-only script', () => {
    const html = outputHtml('Specs', [{ title: '<script>bad</script>', detail: '" onclick="bad' }]);
    expect(html).toContain('&lt;script>bad&lt;/script>');
    expect(html).toContain('type="search"');
    expect(html).toContain('label for="filter"');
    expect(html).not.toMatch(/\sonclick="/);
    expect(html).toContain("script-src 'nonce-");
  });
});
