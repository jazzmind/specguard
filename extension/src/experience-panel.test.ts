import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
vi.mock('vscode', () => ({ workspace: {}, window: {}, commands: {} }));
vi.mock('./output-routing.js', () => ({ queryCli: vi.fn() }));
vi.mock('./workspace-state.js', () => ({ getActiveWorkspaceRoot: vi.fn(), getWorkspaceManifestRoot: vi.fn() }));
vi.mock('./dashboard/panel.js', () => ({ refreshDashboard: vi.fn() }));
import { buildExperienceHtml } from './experience-panel.js';
// [claims: capabilities/workspaces#workspace-business-journeys]
describe('journey editor', () => {
  it('renders qualified links safely, orders steps and keeps scripts compatible with its CSP', () => {
    const html = buildExperienceHtml(true);
    expect(html).not.toMatch(/\sonclick=/i);
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    const nodes = { content: { innerHTML: '' }, message: { textContent: '' } };
    const context = vm.createContext({ acquireVsCodeApi: () => ({ postMessage: vi.fn() }), document: { addEventListener: vi.fn(), getElementById: (id: 'content' | 'message') => nodes[id] }, window: { addEventListener: vi.fn() } });
    new vm.Script(script).runInContext(context);
    context.fixture = { document: { title: '<script>alert(1)</script>', overview: '', groups: [], placements: [], journeys: [{ id: 'buy', title: 'Buy', summary: '', group: '', status: 'draft', order: 0, steps: [{ id: 'last', title: 'Last', summary: '', order: 2, refs: [] }, { id: 'first', title: 'First', summary: '', order: 1, refs: ['api:pay#once'] }] }] }, catalog: [], warnings: [] };
    new vm.Script('state=fixture;render()').runInContext(context);
    expect(nodes.content.innerHTML).toContain('&lt;script&gt;'); expect(nodes.content.innerHTML).not.toContain('<script>');
    expect(nodes.content.innerHTML.indexOf('<strong>First')).toBeLessThan(nodes.content.innerHTML.indexOf('<strong>Last'));
    expect(nodes.content.innerHTML).toContain('Missing reference');
    for (const action of ['draft', 'review', 'apply', 'addJourney', 'addGroup']) expect(html).toContain(`data-act="${action}"`);
  });
});
