import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

vi.mock('vscode', () => ({ workspace: { getConfiguration: vi.fn() }, window: {}, commands: {}, Uri: {}, EventEmitter: class {} }));

import { buildHtml } from './workspace-panel.js';

// [claims: capabilities/workspaces#workspace-status]
describe('the workspace panel page', () => {
  const html = buildHtml({} as never);

  it('has no inline event handlers, which its nonce-only CSP would block', () => {
    expect(html).toContain("script-src 'nonce-");
    expect(html).not.toMatch(/\sonclick=/i);
    expect(html).toMatch(/data-act="runDrift"/);
  });

  it('ships a script that parses, and routes clicks by data-act', () => {
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).toContain("addEventListener('click'");
    for (const act of ['ignore', 'switch', 'refreshAll', 'syncNow', 'runContracts', 'runDrift']) expect(script).toContain(act);
  });

  // [claims: capabilities/integration-surfaces#extension-workspace-alignment]
  it('renders current catalogs and separate setup, checker and Git versions without calling links verified', () => {
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    const content = { innerHTML: '' };
    const postMessage = vi.fn();
    let click: (event: unknown) => void = () => undefined;
    const context = vm.createContext({
      acquireVsCodeApi: () => ({ postMessage }),
      document: { querySelectorAll: () => [], getElementById: () => content, addEventListener: (_name: string, fn: typeof click) => { click = fn; } },
      window: { addEventListener: () => undefined },
    });
    new vm.Script(script).runInContext(context);
    const manifest = { name: 'workspace', repos: [{ key: 'web', absPath: '/web', role: 'consumer', specCount: 1, hasConfig: true,
      health: { extensionVersion: '0.6.0', setupVersion: '0.5.0', setupCurrent: false, checkedWith: '0.4.0', checkVersionCurrent: false,
        codeRevision: 'aaaaaaa', checkedRevision: 'bbbbbbb', dirty: true, codeCurrent: false, specFormat: 'capability',
        catalog: { directory: '/catalog', revision: 'abc123', features: 2, linked: 1, missing: ['checkout'], files: [{ name: '<features>.yaml', version: '1', features: 2 }] } },
    }] };
    context.fixture = manifest;
    new vm.Script('renderStatus(fixture, null)').runInContext(context);
    for (const value of ['Feature catalog', '1/2 features linked', 'checkout', 'abc123', 'SpecGuard setup', 'v0.5.0', 'Spec check engine', 'v0.4.0', 'aaaaaaa', 'bbbbbbb', 'Content alignment: not verified']) expect(content.innerHTML.replace(/<[^>]*>/g, '')).toContain(value);
    expect(content.innerHTML).toContain('&lt;features>.yaml');
    expect(content.innerHTML).toContain('repo-metrics');
    expect(content.innerHTML).toContain('<details class="repo-details">');
    expect(content.innerHTML).not.toContain('<table');
    click({ target: { closest: () => ({ dataset: { act: 'openCatalog', key: 'web', index: '0' } }) }, preventDefault: () => undefined });
    expect(postMessage).toHaveBeenCalledWith({ type: 'openCatalog', key: 'web', index: 0 });
    click({ target: { closest: () => ({ dataset: { act: 'openDashboard', key: 'web' } }) }, preventDefault: () => undefined });
    expect(postMessage).toHaveBeenCalledWith({ type: 'openDashboard', key: 'web' });
    expect(content.innerHTML).toContain('Open dashboard');
  });
});
