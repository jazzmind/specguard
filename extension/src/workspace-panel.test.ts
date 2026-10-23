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
});
