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
import {
  ageLabel,
  contractsDescription,
  coveragePercent,
  coverageRowDescription,
  coverageRowLabel,
  docsOutputDescription,
  layersRow,
  outputBasis,
  specsOutputDescription,
  testsOutputDescription,
  traceRow,
  type LayerCount,
} from './coverage-label.js';
import { parseCoverageText, augmentCoverageFromDisk } from './dashboard/coverage-parse.js';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';
import { loadProjectData } from './api/data.js';
import { getHub } from './api/shared.js';
import { projectNameOf } from './api/hub.js';
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
  /** No `.specguard/config.json` in the active folder. The view stays empty so its welcome (Initialize) shows. */
  private _noConfig = false;
  /** Where the numbers came from: the team server or this machine, and why not the server if it was configured. */
  private _source: { label: string; notice?: string } | undefined;

  /**
   * Stable section nodes. Replacing them on every root `getChildren` call makes
   * VS Code ask for children of the previous object, which no longer matches and
   * comes back empty.
   */
  private readonly _coverageSection = this._makeSection('coverage', 'Coverage', 'shield');
  private readonly _outputsSection = this._makeSection('outputs', 'Outputs', 'package');
  private readonly _workspaceSection = this._makeSection('workspace', 'Workspace', 'globe');

  private _makeSection(id: string, label: string, iconId: string): CoverageTreeItem {
    const item = new CoverageTreeItem(label, vscode.TreeItemCollapsibleState.Expanded, 'section');
    item.id = `specguard.section.${id}`;
    item.iconPath = new vscode.ThemeIcon(iconId);
    item.isSectionNode = true;
    return item;
  }

  private _labelSections(): void {
    const root = getActiveWorkspaceRoot();
    this._coverageSection.label = root
      ? `Coverage — ${path.basename(root)}${this._source ? ` · ${this._source.label}` : ''}`
      : 'Coverage';
    // Drives the "Initialize Workspace" button: shown only while there is no manifest to show.
    void vscode.commands.executeCommand('setContext', 'specguard.hasWorkspaceManifest', Boolean(getWorkspaceManifestRoot()));
    const manifest = loadWorkspaceManifest();
    this._workspaceSection.label = manifest ? `Workspace — ${manifest.name}` : 'Workspace';
  }

  refresh(): Promise<void> {
    return this.loadCoverage();
  }

  getTreeItem(element: CoverageTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CoverageTreeItem): CoverageTreeItem[] {
    // Root level: sections
    if (!element) {
      if (this._noConfig) {
        this._labelSections();
        return getWorkspaceManifestRoot() ? [this._workspaceSection] : [];
      }
      if (this._loading) {
        return [new CoverageTreeItem('Loading…', vscode.TreeItemCollapsibleState.None, 'loading')];
      }
      if (this._error) {
        // The workspace rollup is read from files, so it still shows when this project's own coverage failed.
        this._labelSections();
        return [new CoverageTreeItem(`Error: ${this._error}`, vscode.TreeItemCollapsibleState.None, 'error'), ...(getWorkspaceManifestRoot() ? [this._workspaceSection] : [])];
      }
      this._labelSections();
      return [this._coverageSection, this._outputsSection, ...(getWorkspaceManifestRoot() ? [this._workspaceSection] : [])];
    }

    // Coverage section
    if (element === this._coverageSection) {
      if (this._apps.length === 0) {
        return [new CoverageTreeItem('No specs found', vscode.TreeItemCollapsibleState.None, 'info')];
      }
      const notice = this._source?.notice ? [Object.assign(new CoverageTreeItem(this._source.notice, vscode.TreeItemCollapsibleState.None, 'info'), { iconPath: new vscode.ThemeIcon('info') })] : [];
      return [...notice, ...this._apps.map((app) => {
        const item = new CoverageTreeItem(coverageRowLabel(app), vscode.TreeItemCollapsibleState.Collapsed, 'app');
        item.description = coverageRowDescription(app);
        item.tooltip = app.basis === 'capability'
          ? `${app.percentage}% of ${app.sourceCount} source files are owned by a capability`
          : `${app.specCount} of ${app.sourceCount} source files have a spec`;
        item.iconPath = app.percentage >= 80
          ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconFailed'));
        item.appData = app;
        return item;
      })];
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
      contractsItem.description = contractsDescription(contractSummary.staleCount, contractSummary.nodeCount);
      const ageStr = contractSummary.generatedAt
        ? ageLabel(Date.now() - new Date(contractSummary.generatedAt).getTime())
        : 'not generated';
      contractsItem.tooltip = `An edge is unverified when lastVerified is missing or older than 30 days. Last built: ${ageStr}. Click to open contracts.json`;
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
        const activeMark = isActive ? '  (active)' : '';
        item.description = `${repo.specLabel}${activeMark}`;
        item.iconPath = new vscode.ThemeIcon(
          'pass-filled',
          new vscode.ThemeColor('testing.iconPassed'),
        );
        const archived = repo.archivedSpecs > 0 ? `\n${repo.archivedSpecs} archived v1 specs are not counted` : '';
        const system = repo.hasSystemSpec ? '\nincludes a system spec' : '';
        item.tooltip = `${repo.absPath}\n${repo.specLabel}${system}${archived}`;
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
    const basis = outputBasis(this._apps);
    const totalSpecs = this._apps.reduce((s, a) => s + a.specCount, 0);
    const specItem = new CoverageTreeItem(`Specs: ${totalSpecs}`, vscode.TreeItemCollapsibleState.None, 'output-item');
    specItem.iconPath = new vscode.ThemeIcon('book');
    specItem.description = totalSpecs > 0 ? specsOutputDescription(basis) : 'run reverse or import';
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
    testItem.description = testsOutputDescription(totalTests, basis);
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
    docItem.description = docsOutputDescription(docCount, basis);
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
    const traceJson = path.join(root, '.specguard', 'trace.json');
    const matrixFile = path.join(root, '.specguard', 'traceability.json');
    const traceAge = fs.existsSync(traceJson) ? Date.now() - fs.statSync(traceJson).mtimeMs : undefined;
    const matrixAge = traceAge === undefined && fs.existsSync(matrixFile) ? Date.now() - fs.statSync(matrixFile).mtimeMs : undefined;
    const trace = traceRow({ traceAgeMs: traceAge, matrixAgeMs: matrixAge });
    const traceFile = traceAge !== undefined ? traceJson : matrixFile;
    const traceItem = new CoverageTreeItem(trace.title, vscode.TreeItemCollapsibleState.None, 'output-item');
    traceItem.iconPath = new vscode.ThemeIcon(traceAge !== undefined || matrixAge !== undefined ? 'list-tree' : 'circle-outline');
    traceItem.description = trace.description;
    traceItem.tooltip = trace.tooltip;
    if ((traceAge !== undefined || matrixAge !== undefined) && fs.existsSync(traceFile)) {
      traceItem.command = {
        command: 'vscode.open',
        title: 'Open traceability',
        arguments: [vscode.Uri.file(traceFile)],
      };
    }
    items.push(traceItem);

    // Proof by test layer, when the project requires layers.
    if (traceAge !== undefined) {
      try {
        const raw = JSON.parse(fs.readFileSync(traceJson, 'utf-8')) as { totals?: { layerCounts?: Record<string, LayerCount> } };
        const layers = layersRow(raw.totals?.layerCounts);
        if (layers) {
          const layerItem = new CoverageTreeItem(layers.title, vscode.TreeItemCollapsibleState.None, 'output-item');
          layerItem.iconPath = new vscode.ThemeIcon('layers');
          layerItem.description = layers.description;
          layerItem.tooltip = layers.tooltip;
          items.push(layerItem);
        }
      } catch { /* an unreadable trace shows no layers row */ }
    }

    return items;
  }

  private async loadCoverage(): Promise<void> {
    const workspaceRoot = getActiveWorkspaceRoot();
    if (!workspaceRoot || !fs.existsSync(path.join(workspaceRoot, '.specguard', 'config.json'))) {
      this._apps = [];
      this._error = undefined;
      this._noConfig = true;
      this._loading = false;
      this._onDidChangeTreeData.fire();
      return;
    }
    this._noConfig = false;

    this._loading = true;
    this._error = undefined;
    this._onDidChangeTreeData.fire();

    try {
      // Functional specs are read through the API: the team server if one answers, else a local `serve`.
      const hub = getHub();
      if (hub) {
        try {
          const live = await hub.get(workspaceRoot);
          const data = await loadProjectData(live.client, { name: projectNameOf(workspaceRoot, live), workspaceRoot });
          if (data.functional) {
            this._apps = data.apps;
            this._source = { label: live.source === 'server' ? `team server · ${live.project}` : 'local', ...(live.notice ? { notice: live.notice } : {}) };
            return;
          }
        } catch {
          /* the API is not available: use the command line below */
        }
      }
      // Per-file specs (or no API): the command line's coverage report.
      this._source = undefined;
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
    return coveragePercent(this._apps);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(cliPath: string, args: string[], cwd: string): Promise<string> {
  const chunks: string[] = [];
  const handle = spawnCli(cliPath, args, cwd, (line) => chunks.push(line));
  return handle.promise.then((code) => {
    const text = chunks.join('\n').trim();
    if (code !== 0 && code !== 4) {
      throw new Error(text || `specguard status exited with code ${code}`);
    }
    return text;
  });
}
