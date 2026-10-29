import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
vi.mock('vscode', () => ({}));
vi.mock('./workspace-state.js', () => ({}));
vi.mock('./settings.js', () => ({}));
import { settingsHtml } from './settings-panel.js';

// [claims: capabilities/integration-surfaces#extension-workspace-settings]
describe('the shared settings editor', () => {
  it('renders accessible fields and navigation with a nonce-only script and no secret inputs', () => {
    const html = settingsHtml();
    expect(html).toContain("script-src 'nonce-");
    expect(html).not.toMatch(/\sonclick=/i);
    expect(html).not.toContain('type="password"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-act="workspace"');
    expect(html).toContain('data-act="dashboard"');
    for (const field of ['provider', 'model', 'endpoint', 'keyEnv', 'serverUrl', 'mode', 'project']) expect(html).toContain(`for="${field}"`);
  });
  it('shows inherited repo settings and posts only enabled overrides, never credential values', () => {
    const html = settingsHtml();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    const elements = new Map<string, any>();
    function element(id: string): any {
      if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, textContent: '', classList: { toggle: vi.fn() }, replaceChildren: vi.fn(), addEventListener: vi.fn() });
      return elements.get(id);
    }
    let receive: (event: unknown) => void = () => {};
    let click: (event: unknown) => void = () => {};
    const post = vi.fn();
    const context = vm.createContext({ acquireVsCodeApi: () => ({ postMessage: post }),
      Option: class { constructor(public text: string, public value: string) {} },
      document: { getElementById: element, addEventListener: (_: string, fn: typeof click) => { click = fn; } },
      window: { addEventListener: (_: string, fn: typeof receive) => { receive = fn; } },
    });
    new vm.Script(script).runInContext(context);
    expect(post).toHaveBeenCalledWith({ type: 'ready' });
    receive({ data: { type: 'settings', selectedRoot: '/repo', roots: [{ root: '/repo', name: 'repo' }], snapshot: {
      layer: {}, llm: { provider: 'anthropic', model: 'shared-model', apiKeyEnv: 'KEY' }, server: { url: 'https://team.test', mode: 'auto', project: 'repo' },
      llmSource: 'Inherited from workspace', serverSource: 'Inherited from workspace', keySource: 'Workspace secure storage', hasKey: true,
    } } });
    expect(element('aiFields').disabled).toBe(true);
    expect(element('aiSource').textContent).toBe('Inherited from workspace');
    click({ target: { closest: () => ({ dataset: { act: 'save' } }) } });
    expect(post).toHaveBeenLastCalledWith({ type: 'save', layer: {} });
    element('aiOverride').checked = true;
    element('model').value = 'repo-model';
    click({ target: { closest: () => ({ dataset: { act: 'save' } }) } });
    expect(post).toHaveBeenLastCalledWith({ type: 'save', layer: { llm: { provider: 'anthropic', model: 'repo-model', apiKeyEnv: 'KEY', baseUrl: '' } } });
    click({ target: { closest: () => ({ dataset: { act: 'key' } }) } });
    expect(post.mock.calls.at(-1)![0]).not.toHaveProperty('apiKey');
  });
});
