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
import { parseCoverageText, augmentCoverageFromDisk } from './dashboard/coverage-parse.js';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';
import {
  getActiveWorkspaceRoot,
  getWorkspaceManifestRoot,
  loadContractsSummary,
  loadWorkspaceManifest,
  type WorkspaceRepo,
} from './workspace-state.js';

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
  | 'output-item'
  | 'workspace-repo'
  | 'workspace-repo-ignored'
  | 'workspace-repos-group'
  | 'workspace-ignored-group';

class CoverageTreeItem extends vscode.TreeItem {
  appData?: AppCoverage;
  isSectionNode?: boolean;
  repoData?: WorkspaceRepo;
  repoList?: WorkspaceRepo[];

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
  private readonly _outputsSection = this._makeSection('Outputs', '$(package)');
  private _workspaceSection = this._makeSection('Workspace', '$(globe)');

  private _getCoverageSection(): CoverageTreeItem {
    const root = getActiveWorkspaceRoot();
    const label = root ? `Coverage — ${path.basename(root)}` : 'Coverage';
    const item = new CoverageTreeItem(label, vscode.TreeItemCollapsibleState.Expanded, 'section');
    item.iconPath = new vscode.ThemeIcon('shield');
    item.isSectionNode = true;
    return item;
  }

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

  private _coverageSection: CoverageTreeItem | undefined;

  getChildren(element?: CoverageTreeItem): CoverageTreeItem[] {
    // Root level: sections
    if (!element) {
      if (this._loading) {
        return [new CoverageTreeItem('Loading…', vscode.TreeItemCollapsibleState.None, 'loading')];
      }
      if (this._error) {
        return [new CoverageTreeItem(`Error: ${this._error}`, vscode.TreeItemCollapsibleState.None, 'error')];
      }
      this._coverageSection = this._getCoverageSection();
      const manifest = loadWorkspaceManifest();
      const wsLabel = manifest ? `Workspace — ${manifest.name}` : 'Workspace';
      const wsSection = this._makeSection(wsLabel, '$(globe)');
      wsSection.isSectionNode = true;
      // Store for identity check in getChildren
      this._workspaceSection = wsSection;
      return [this._coverageSection, this._outputsSection, ...(getWorkspaceManifestRoot() ? [this._workspaceSection] : [])];
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

    // Workspace section
    if (element === this._workspaceSection) {
      return this._buildWorkspaceItems();
    }

    // Workspace repos group (collapsible, default expanded)
    if (element.type === 'workspace-repos-group' && element.repoList) {
      return this._buildRepoRows(element.repoList);
    }

    // Workspace ignored group (collapsible, default collapsed)
    if (element.type === 'workspace-ignored-group' && element.repoList) {
      return element.repoList.map((repo) => {
        const item = new CoverageTreeItem(
          repo.key,
          vscode.TreeItemCollapsibleState.None,
          'workspace-repo-ignored',
        );
        item.repoData = repo;
        item.description = repo.role;
        item.iconPath = new vscode.ThemeIcon('eye-closed');
        item.tooltip = `${repo.absPath}\nIgnored — set "ignore": false in workspace.json to include`;
        return item;
      });
    }


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

  private _buildWorkspaceItems(): CoverageTreeItem[] {
    const manifest = loadWorkspaceManifest();
    if (!manifest) return [];

    const { repos, manifestRoot } = manifest;

    const activeRepos = repos.filter((r) => !r.ignore);
    const ignoredRepos = repos.filter((r) => r.ignore);
    const speccedCount = activeRepos.filter((r) => r.specCount > 0).length;
    const contractSummary = loadContractsSummary();

    const items: CoverageTreeItem[] = [];

    // ── 1. Action rows ──────────────────────────────────────────────────────

    const statusItem = new CoverageTreeItem(
      'Workspace Status',
      vscode.TreeItemCollapsibleState.None,
      'output-item',
    );
    statusItem.iconPath = new vscode.ThemeIcon('server-process');
    statusItem.description = 'health dashboard';
    statusItem.tooltip = 'Show workspace health dashboard';
    statusItem.command = { command: 'specguard.workspaceStatus', title: 'Workspace Status' };
    items.push(statusItem);

    const driftItem = new CoverageTreeItem(
      'Workspace Drift',
      vscode.TreeItemCollapsibleState.None,
      'output-item',
    );
    driftItem.iconPath = new vscode.ThemeIcon('git-compare');
    driftItem.description = 'cross-repo drift check';
    driftItem.tooltip = 'Run cross-repo drift detection across all repos';
    driftItem.command = { command: 'specguard.workspaceDrift', title: 'Workspace Drift' };
    items.push(driftItem);

    if (contractSummary) {
      const contractsItem = new CoverageTreeItem(
        `Contracts: ${contractSummary.edgeCount} edges`,
        vscode.TreeItemCollapsibleState.None,
        'output-item',
      );
      contractsItem.iconPath = new vscode.ThemeIcon(
        contractSummary.staleCount > 0 ? 'warning' : 'pass-filled',
        contractSummary.staleCount > 0
          ? new vscode.ThemeColor('testing.iconFailed')
          : new vscode.ThemeColor('testing.iconPassed'),
      );
      contractsItem.description = contractSummary.staleCount > 0
        ? `${contractSummary.staleCount} stale`
        : `${contractSummary.nodeCount} nodes`;
      const ageStr = contractSummary.generatedAt
        ? (() => {
            const ageMs = Date.now() - new Date(contractSummary.generatedAt!).getTime();
            return ageMs < 3_600_000
              ? `${Math.floor(ageMs / 60_000)}m ago`
              : `${Math.floor(ageMs / 3_600_000)}h ago`;
          })()
        : 'not generated';
      contractsItem.tooltip = `Last built: ${ageStr}. Click to open contracts.json`;
      const contractsPath = path.join(manifestRoot, '.specguard', 'contracts.json');
      if (fs.existsSync(contractsPath)) {
        contractsItem.command = {
          command: 'vscode.open',
          title: 'Open contracts.json',
          arguments: [vscode.Uri.file(contractsPath)],
        };
      }
      items.push(contractsItem);
    } else {
      const noContracts = new CoverageTreeItem(
        'Build Contract Graph',
        vscode.TreeItemCollapsibleState.None,
        'output-item',
      );
      noContracts.iconPath = new vscode.ThemeIcon('git-merge');
      noContracts.description = 'not built';
      noContracts.tooltip = 'Run "SpecGuard: Build Contract Graph" to generate contracts.json';
      noContracts.command = { command: 'specguard.contracts', title: 'Build contracts' };
      items.push(noContracts);
    }

    // ── 2. Repos group (collapsible, default expanded) ──────────────────────

    const sorted = [...activeRepos].sort((a, b) => {
      const activeRoot = getActiveWorkspaceRoot();
      const aIsActive = a.absPath === activeRoot;
      const bIsActive = b.absPath === activeRoot;
      if (aIsActive && !bIsActive) return -1;
      if (bIsActive && !aIsActive) return 1;
      return b.specCount - a.specCount;
    });

    const reposGroup = new CoverageTreeItem(
      `${speccedCount}/${activeRepos.length} repos specced`,
      vscode.TreeItemCollapsibleState.Expanded,
      'workspace-repos-group',
    );
    reposGroup.iconPath = new vscode.ThemeIcon(
      speccedCount === activeRepos.length ? 'pass-filled' : 'warning',
      speccedCount === activeRepos.length
        ? new vscode.ThemeColor('testing.iconPassed')
        : new vscode.ThemeColor('testing.iconFailed'),
    );
    const manifestPath = path.join(manifestRoot, '.specguard', 'workspace.json');
    reposGroup.tooltip = 'Click to open workspace.json';
    reposGroup.repoList = sorted;
    items.push(reposGroup);

    // ── 3. Ignored group (collapsible, default collapsed) ───────────────────

    if (ignoredRepos.length > 0) {
      const ignoredGroup = new CoverageTreeItem(
        'Ignored',
        vscode.TreeItemCollapsibleState.Collapsed,
        'workspace-ignored-group',
      );
      ignoredGroup.iconPath = new vscode.ThemeIcon('eye-closed');
      ignoredGroup.description = `${ignoredRepos.length} repos`;
      ignoredGroup.tooltip = 'Repos excluded from coverage. Set "ignore": false in workspace.json to include.';
      ignoredGroup.repoList = ignoredRepos;
      // clicking the header opens workspace.json
      ignoredGroup.command = {
        command: 'vscode.open',
        title: 'Open workspace.json',
        arguments: [vscode.Uri.file(manifestPath)],
      };
      items.push(ignoredGroup);
    }

    return items;
  }

  private _buildRepoRows(repos: WorkspaceRepo[]): CoverageTreeItem[] {
    const activeRoot = getActiveWorkspaceRoot();
    return repos.map((repo) => {
      const isActive = repo.absPath === activeRoot;
      const item = new CoverageTreeItem(
        repo.key,
        vscode.TreeItemCollapsibleState.None,
        'workspace-repo',
      );
      item.repoData = repo;

      if (!repo.hasConfig) {
        item.description = isActive ? 'no config  (active)' : 'no config';
        item.iconPath = new vscode.ThemeIcon('circle-slash');
        item.tooltip = `${repo.absPath}\nNo .specguard/config.json — run specguard init`;
      } else if (repo.specCount === 0) {
        item.description = isActive ? 'no specs  (active)' : 'no specs';
        item.iconPath = new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('testing.iconFailed'),
        );
        item.tooltip = `${repo.absPath}\n0 specs — run specguard reverse or gap-analysis`;
      } else {
        item.description = isActive
          ? `${repo.specCount} specs  (active)`
          : `${repo.specCount} specs`;
        item.iconPath = new vscode.ThemeIcon(
          'pass-filled',
          new vscode.ThemeColor('testing.iconPassed'),
        );
        item.tooltip = `${repo.absPath}\n${repo.specCount} spec files`;
      }

      if (!isActive) {
        item.command = {
          command: 'specguard.switchToRepo',
          title: 'Switch to repo',
          arguments: [repo.absPath, repo.key],
        };
      }

      return item;
    });
  }

  private _buildOutputItems(): CoverageTreeItem[] {
    const root = getActiveWorkspaceRoot();
    if (!root) return [];

    const items: CoverageTreeItem[] = [];

    // Spec count — click opens specs/ folder
    const totalSpecs = this._apps.reduce((s, a) => s + a.specCount, 0);
    const specItem = new CoverageTreeItem(`Specs: ${totalSpecs}`, vscode.TreeItemCollapsibleState.None, 'output-item');
    specItem.iconPath = new vscode.ThemeIcon('book');
    specItem.description = totalSpecs > 0 ? 'Living Specs' : 'run reverse or import';
    specItem.tooltip = 'Click to open specs directory';
    const specsDir = path.join(root, 'specs');
    if (fs.existsSync(specsDir)) {
      specItem.command = {
        command: 'revealFileInOS',
        title: 'Open specs folder',
        arguments: [vscode.Uri.file(specsDir)],
      };
    }
    items.push(specItem);

    // Test count — click opens the generated tests directory
    const totalTests = this._apps.reduce((s, a) => s + a.testCount, 0);
    const testItem = new CoverageTreeItem(`Tests: ${totalTests}`, vscode.TreeItemCollapsibleState.None, 'output-item');
    testItem.description = totalTests > 0 ? 'generated tests' : 'run generate';
    testItem.iconPath = new vscode.ThemeIcon(totalTests > 0 ? 'pass-filled' : 'circle-outline');
    testItem.tooltip = 'Click to open tests directory';
    const testsDir = path.join(root, 'tests');
    if (fs.existsSync(testsDir)) {
      testItem.command = {
        command: 'revealFileInOS',
        title: 'Open tests folder',
        arguments: [vscode.Uri.file(testsDir)],
      };
    }
    items.push(testItem);

    // Docs — count files in docs/user/, click opens folder
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
    docItem.tooltip = 'Click to open docs directory';
    if (docCount > 0 && fs.existsSync(docsDir)) {
      docItem.command = {
        command: 'revealFileInOS',
        title: 'Open docs folder',
        arguments: [vscode.Uri.file(docsDir)],
      };
    }
    items.push(docItem);

    // Traceability matrix — click opens the JSON file
    const traceFile = path.join(root, '.specguard', 'traceability.json');
    const hasTrace = fs.existsSync(traceFile);
    const traceItem = new CoverageTreeItem(
      `Traceability: ${hasTrace ? 'present' : 'missing'}`,
      vscode.TreeItemCollapsibleState.None,
      'output-item',
    );
    traceItem.iconPath = new vscode.ThemeIcon(hasTrace ? 'list-tree' : 'circle-outline');
    if (hasTrace) {
      try {
        const stat = fs.statSync(traceFile);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageStr = ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago` : `${Math.floor(ageMs / 3_600_000)}h ago`;
        traceItem.description = `updated ${ageStr}`;
      } catch { /* ignore */ }
      traceItem.tooltip = 'Click to open traceability.json';
      traceItem.command = {
        command: 'vscode.open',
        title: 'Open traceability.json',
        arguments: [vscode.Uri.file(traceFile)],
      };
    } else {
      traceItem.description = 'run matrix';
      traceItem.tooltip = 'Run "SpecGuard: Traceability Matrix" to generate';
    }
    items.push(traceItem);

    return items;
  }

  private async loadCoverage(): Promise<void> {
    const workspaceRoot = getActiveWorkspaceRoot();
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
      augmentCoverageFromDisk(this._apps, workspaceRoot);
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
  const chunks: string[] = [];
  const handle = spawnCli(cliPath, args, cwd, (line) => chunks.push(line));
  return handle.promise.then((code) => {
    if (code !== 0 && code !== 4) {
      throw new Error(`specguard status exited with code ${code}`);
    }
    return chunks.join('\n');
  });
}
