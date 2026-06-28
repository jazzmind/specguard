/**
 * Coverage sidebar TreeDataProvider.
 *
 * Calls `specguard status` (via CLI) and renders per-app spec coverage
 * as a tree of items. Each item shows the spec key and whether it has a spec
 * and test file. A second "Outputs" section shows artifact counts and
 * traceability status from the .specguard/ directory.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AppCoverage } from './dashboard/protocol.js';
import { parseCoverageText } from './dashboard/coverage-parse.js';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

type ItemType =
  | 'loading'
  | 'error'
  | 'info'
  | 'section'
  | 'app'
  | 'spec-item'
  | 'output-item';

class CoverageTreeItem extends vscode.TreeItem {
  appData?: AppCoverage;
  isSectionNode?: boolean;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: ItemType,
  ) {
    super(label, collapsibleState);
    this.contextValue = type;
  }
}

// ---------------------------------------------------------------------------
// CoverageProvider
// ---------------------------------------------------------------------------

export class CoverageProvider implements vscode.TreeDataProvider<CoverageTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CoverageTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _apps: AppCoverage[] = [];
  private _loading = false;
  private _error: string | undefined;

  /** Section sentinel nodes at the root level. */
  private readonly _coverageSection = this._makeSection('Coverage', '$(shield)');
  private readonly _outputsSection = this._makeSection('Outputs', '$(package)');

  private _makeSection(label: string, iconId: string): CoverageTreeItem {
    const item = new CoverageTreeItem(label, vscode.TreeItemCollapsibleState.Expanded, 'section');
    item.iconPath = new vscode.ThemeIcon(iconId.replace('$(', '').replace(')', ''));
    item.isSectionNode = true;
    return item;
  }

  refresh(): Promise<void> {
    this._onDidChangeTreeData.fire();
    return this.loadCoverage();
  }

  getTreeItem(element: CoverageTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CoverageTreeItem): CoverageTreeItem[] {
    // Root level: two sections
    if (!element) {
      if (this._loading) {
        return [new CoverageTreeItem('Loading…', vscode.TreeItemCollapsibleState.None, 'loading')];
      }
      if (this._error) {
        return [new CoverageTreeItem(`Error: ${this._error}`, vscode.TreeItemCollapsibleState.None, 'error')];
      }
      return [this._coverageSection, this._outputsSection];
    }

    // Coverage section
    if (element === this._coverageSection) {
      if (this._apps.length === 0) {
        return [new CoverageTreeItem('No specs found', vscode.TreeItemCollapsibleState.None, 'info')];
      }
      return this._apps.map((app) => {
        const label = `${app.name} (${app.percentage}%)`;
        const item = new CoverageTreeItem(label, vscode.TreeItemCollapsibleState.Collapsed, 'app');
        item.description = `${app.specCount}/${app.sourceCount} specs`;
        item.iconPath = app.percentage >= 80
          ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconFailed'));
        item.appData = app;
        return item;
      });
    }

    // Outputs section
    if (element === this._outputsSection) {
      return this._buildOutputItems();
    }

    // App children: spec items
    if (element.appData) {
      return element.appData.items.map((item) => {
        const status = !item.hasSpec ? '⚠ missing spec' : !item.hasTest ? '∅ no test' : '✓';
        const treeItem = new CoverageTreeItem(
          item.key,
          vscode.TreeItemCollapsibleState.None,
          'spec-item',
        );
        treeItem.description = status;
        treeItem.iconPath = !item.hasSpec
          ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconFailed'))
          : !item.hasTest
          ? new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconQueued'))
          : new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        if (item.specPath) {
          treeItem.command = {
            command: 'vscode.open',
            title: 'Open spec',
            arguments: [vscode.Uri.file(item.specPath)],
          };
        }
        return treeItem;
      });
    }

    return [];
  }

  private _buildOutputItems(): CoverageTreeItem[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];

    const items: CoverageTreeItem[] = [];

    // Spec count
    const totalSpecs = this._apps.reduce((s, a) => s + a.specCount, 0);
    const specItem = new CoverageTreeItem(`Specs: ${totalSpecs}`, vscode.TreeItemCollapsibleState.None, 'output-item');
    specItem.iconPath = new vscode.ThemeIcon('book');
    specItem.description = totalSpecs > 0 ? 'Living Specs' : 'run reverse or import';
    items.push(specItem);

    // Test count
    const totalTests = this._apps.reduce((s, a) => s + a.testCount, 0);
    const testItem = new CoverageTreeItem(`Tests: ${totalTests}`, vscode.TreeItemCollapsibleState.None, 'output-item');
    testItem.iconPath = new vscode.ThemeIcon(totalTests > 0 ? 'beaker' : 'beaker');
    testItem.description = totalTests > 0 ? 'generated tests' : 'run generate';
    testItem.iconPath = new vscode.ThemeIcon(totalTests > 0 ? 'pass-filled' : 'circle-outline');
    items.push(testItem);

    // Docs — count files in docs/user/
    const docsDir = path.join(root, 'docs', 'user');
    let docCount = 0;
    try {
      if (fs.existsSync(docsDir)) {
        docCount = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).length;
      }
    } catch { /* ignore */ }
    const docItem = new CoverageTreeItem(`Docs: ${docCount}`, vscode.TreeItemCollapsibleState.None, 'output-item');
    docItem.iconPath = new vscode.ThemeIcon(docCount > 0 ? 'file-text' : 'circle-outline');
    docItem.description = docCount > 0 ? 'user-facing docs' : 'run docs';
    items.push(docItem);

    // Traceability matrix
    const traceFile = path.join(root, '.specguard', 'traceability.json');
    const hasTrace = fs.existsSync(traceFile);
    const traceItem = new CoverageTreeItem(
      `Traceability: ${hasTrace ? 'present' : 'missing'}`,
      vscode.TreeItemCollapsibleState.None,
      'output-item',
    );
    traceItem.iconPath = new vscode.ThemeIcon(hasTrace ? 'list-tree' : 'circle-outline');
    traceItem.description = hasTrace ? 'run matrix to refresh' : 'run matrix';
    if (hasTrace) {
      try {
        const stat = fs.statSync(traceFile);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageStr = ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago` : `${Math.floor(ageMs / 3_600_000)}h ago`;
        traceItem.description = `updated ${ageStr}`;
      } catch { /* ignore */ }
    }
    items.push(traceItem);

    return items;
  }

  private async loadCoverage(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this._apps = [];
      return;
    }

    this._loading = true;
    this._error = undefined;
    this._onDidChangeTreeData.fire();

    try {
      const cli = await resolveCliPath(workspaceRoot);
      const raw = await runCli(cli, ['status'], workspaceRoot);
      this._apps = parseCoverageText(raw);
    } catch (err) {
      this._error = (err as Error).message ?? String(err);
      this._apps = [];
    } finally {
      this._loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  getCoveragePercent(): number {
    if (this._apps.length === 0) return 0;
    const total = this._apps.reduce((s, a) => s + a.sourceCount, 0);
    const covered = this._apps.reduce((s, a) => s + a.specCount, 0);
    if (total === 0) return 100;
    return Math.round((covered / total) * 100);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(cliPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    spawnCli(cliPath, args, cwd, (line) => chunks.push(line))
      .then((code) => {
        if (code !== 0 && code !== 4) {
          reject(new Error(`specguard status exited with code ${code}`));
        } else {
          resolve(chunks.join('\n'));
        }
      })
      .catch(reject);
  });
}
