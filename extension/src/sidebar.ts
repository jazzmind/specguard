/**
 * Coverage sidebar TreeDataProvider.
 *
 * Calls `specguard status --json` (via CLI) and renders per-app spec coverage
 * as a tree of items. Each item shows the spec key and whether it has a spec
 * and test file.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export interface CoverageItem {
  app: string;
  key: string;
  hasSpec: boolean;
  hasTest: boolean;
  specPath?: string;
}

export interface AppCoverage {
  name: string;
  specCount: number;
  sourceCount: number;
  testCount: number;
  percentage: number;
  items: CoverageItem[];
}

export class CoverageProvider implements vscode.TreeDataProvider<CoverageTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CoverageTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _apps: AppCoverage[] = [];
  private _loading = false;
  private _error: string | undefined;

  refresh(): Promise<void> {
    this._onDidChangeTreeData.fire();
    return this.loadCoverage();
  }

  getTreeItem(element: CoverageTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CoverageTreeItem): CoverageTreeItem[] {
    if (this._loading) {
      return [new CoverageTreeItem('Loading…', vscode.TreeItemCollapsibleState.None, 'loading')];
    }
    if (this._error) {
      return [new CoverageTreeItem(`Error: ${this._error}`, vscode.TreeItemCollapsibleState.None, 'error')];
    }

    if (!element) {
      // Root: show apps
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

    if (element.appData) {
      return element.appData.items.map((item) => {
        const status = !item.hasSpec ? '⚠ missing spec' : !item.hasTest ? '∅ no test' : '✓';
        const treeItem = new CoverageTreeItem(
          item.key,
          vscode.TreeItemCollapsibleState.None,
          item.hasSpec ? (item.hasTest ? 'ok' : 'no-test') : 'missing',
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
      const raw = await runCli(cli, ['status', '--json'], workspaceRoot);
      this._apps = parseStatusJson(raw);
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

class CoverageTreeItem extends vscode.TreeItem {
  appData?: AppCoverage;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: string,
  ) {
    super(label, collapsibleState);
    this.contextValue = type;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveCliPath(workspaceRoot: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('specguard');
  const custom = config.get<string>('cliPath', '');
  if (custom) return custom;

  // Try local workspace installation first.
  const localBin = path.join(workspaceRoot, 'node_modules', '.bin', 'specguard');
  return localBin;
}

function runCli(cliPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Run via `node` when the path is a .js file; otherwise run directly.
    const [cmd, cmdArgs] =
      cliPath.endsWith('.js')
        ? ['node', [cliPath, ...args]]
        : cliPath.endsWith('.ts')
          ? ['npx', ['tsx', cliPath, ...args]]
          : [cliPath, args];

    const proc = cp.spawn(cmd, cmdArgs, { cwd, env: process.env });
    const chunks: string[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    proc.stderr.on('data', () => {}); // ignore stderr for now
    proc.on('close', (code) => {
      if (code !== 0 && code !== 4) {
        reject(new Error(`specguard exited with code ${code}`));
        return;
      }
      resolve(chunks.join(''));
    });
    proc.on('error', reject);
  });
}

/**
 * Parse the text output of `specguard status` (non-JSON format) into
 * AppCoverage objects.
 *
 * The current CLI doesn't have a `--json` flag yet, so we parse the text
 * output. This is intentionally lenient — parse what we can.
 */
function parseStatusJson(raw: string): AppCoverage[] {
  const apps: AppCoverage[] = [];

  // Parse sections starting with "# <appName> (specs/<dir>)"
  const appSections = raw.split(/^# /m).filter(Boolean);

  for (const section of appSections) {
    const lines = section.split('\n');
    const header = lines[0] ?? '';
    const nameMatch = header.match(/^(\S+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const items: CoverageItem[] = [];
    for (const line of lines.slice(1)) {
      const okMatch = line.match(/^\s+\[ok\]\s+(\S+)/);
      const missingMatch = line.match(/^\s+\[missing-spec\]\s+(\S+)/);
      const noTestMatch = line.match(/^\s+\[ok\]\s+(\S+)\s+\(no test\)/);

      if (noTestMatch) {
        items.push({ app: name, key: noTestMatch[1], hasSpec: true, hasTest: false });
      } else if (okMatch) {
        items.push({ app: name, key: okMatch[1], hasSpec: true, hasTest: true });
      } else if (missingMatch) {
        items.push({ app: name, key: missingMatch[1], hasSpec: false, hasTest: false });
      }
    }

    // Parse summary line: "<appName>: N source files, M specs (P%), K tests (...)"
    const summaryMatch = section.match(/(\d+) source files, (\d+) specs \((\d+)%\), (\d+) tests/);
    const sourceCount = summaryMatch ? parseInt(summaryMatch[1], 10) : items.length;
    const specCount = summaryMatch ? parseInt(summaryMatch[2], 10) : items.filter((i) => i.hasSpec).length;
    const percentage = summaryMatch ? parseInt(summaryMatch[3], 10) : 0;

    apps.push({ name, specCount, sourceCount, testCount: 0, percentage, items });
  }

  return apps;
}
