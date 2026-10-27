import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({
  TreeItem: class { label: string; constructor(label: string) { this.label = label; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {}, ThemeColor: class {},
  EventEmitter: class { event = vi.fn(); fire = vi.fn(); },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/project' } }], getConfiguration: vi.fn() },
  commands: { executeCommand: vi.fn() }, Uri: { file: (p: string) => ({ fsPath: p }) },
}));
import { CoverageProvider, WorkspaceProvider } from './sidebar.js';
describe('extension drawers and outputs', () => {
  // [claims: capabilities/integration-surfaces#extension-navigation-order]
  it('declares Workspace, Coverage, Pipelines, Plugins in order and makes workspace independent of coverage', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    expect(pkg.contributes.views['specguard-sidebar'].map((v: { name: string }) => v.name)).toEqual(['Workspace', 'Coverage', 'Pipelines', 'Plugins']);
    const coverage = new CoverageProvider();
    expect(coverage.getChildren().map((i) => i.label)).not.toContain('Workspace');
    expect(new WorkspaceProvider(coverage).getChildren()[0].command?.command).toBe('specguard.initWorkspace');
  });
  // [claims: capabilities/integration-surfaces#extension-output-browser]
  it('opens each output inventory inside the editor even when there are no generated files yet', () => {
    const coverage = new CoverageProvider();
    const section = coverage.getChildren().find((i) => i.label === 'Outputs')!;
    const outputs = coverage.getChildren(section).slice(0, 3);
    expect(outputs.map((i) => i.command?.command)).toEqual(['specguard.openOutputs', 'specguard.openOutputs', 'specguard.openOutputs']);
    expect(outputs.map((i) => i.command?.arguments)).toEqual([['specs'], ['tests'], ['docs']]);
  });
});
