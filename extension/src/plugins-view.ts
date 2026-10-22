/**
 * The Plugins view: browse, enable, disable, add and remove the plugins of the active project.
 *
 * Everything goes through the CLI (`specguard plugin ...`), which edits the project's own config and
 * enforces the rules (an npm plugin runs third-party code, so adding one needs an explicit
 * confirmation here as well as `--yes` there).
 */
import * as vscode from 'vscode';
import { describeRow, rowContext, suggestPluginId, type PluginRow } from './plugins-model.js';
import { changePlugins, getPlugins, isPluginEnabled, onDidChangePlugins } from './plugins-state.js';
import { openAndRun } from './dashboard/panel.js';
import { getActiveWorkspaceRoot } from './workspace-state.js';
import type { ApiHub } from './api/hub.js';

type Node = { kind: 'row'; row: PluginRow } | { kind: 'message'; text: string; command?: vscode.Command };

export class PluginsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;
  private rows: PluginRow[] | undefined;
  private error: string | undefined;

  constructor() {
    this.sub = onDidChangePlugins(() => void this.refresh());
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  async refresh(fresh = true): Promise<void> {
    const root = getActiveWorkspaceRoot();
    if (!root) {
      this.rows = undefined;
      this.error = 'Open a folder to see its plugins.';
    } else {
      const res = await getPlugins(root, { fresh });
      this.rows = res.rows;
      this.error = res.rows ? undefined : res.error ?? 'Could not read the plugin list.';
    }
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.command = node.command;
      return item;
    }
    const r = node.row;
    const item = new vscode.TreeItem(r.title, vscode.TreeItemCollapsibleState.None);
    item.id = `${r.source}:${r.id}`;
    item.description = describeRow(r);
    item.contextValue = rowContext(r);
    item.iconPath = new vscode.ThemeIcon(r.error ? 'error' : r.enabled ? 'pass-filled' : 'circle-large-outline');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${r.title}** (\`${r.id}\`)\n\n${r.description}\n\n`);
    if (r.commands.length > 0) md.appendMarkdown(`Adds: ${r.commands.map((c) => `\`specguard ${c}\``).join(', ')}\n\n`);
    if (r.provides.length > 0) md.appendMarkdown(`Provides: ${r.provides.join(', ')}\n\n`);
    if (r.configKey) md.appendMarkdown(`Config: \`${r.configKey}\`\n\n`);
    if (r.error) md.appendMarkdown(`**Error:** ${r.error}\n`);
    item.tooltip = md;
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) return [];
    if (this.rows === undefined && this.error === undefined) await this.refresh(false);
    if (!this.rows) return [{ kind: 'message', text: this.error ?? 'No plugin information.' }];
    return this.rows.map((row) => ({ kind: 'row' as const, row }));
  }
}


/**
 * Make sure the plugin `id` is on before running something that needs it, offering to enable it.
 * True when the caller may go ahead (it is on, or its state could not be read and the CLI will say).
 */
export async function ensurePluginEnabled(id: string): Promise<boolean> {
  const root = getActiveWorkspaceRoot();
  if (!root) return true;
  const on = await isPluginEnabled(root, id);
  if (on !== false) return true;
  const pick = await vscode.window.showWarningMessage(`This needs the "${id}" plugin, which is off in this project. Enable it?`, 'Enable', 'Cancel');
  if (pick !== 'Enable') return false;
  const res = await changePlugins(root, ['enable', id]);
  if (!res.ok) void vscode.window.showErrorMessage(`SpecGuard: ${res.message || `could not enable ${id}`}`);
  return res.ok;
}

const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

export function registerPluginViews(context: vscode.ExtensionContext, hub: ApiHub | undefined, onChange: () => void): PluginsProvider {
  const provider = new PluginsProvider();
  const view = vscode.window.createTreeView('specguard.pluginsView', { treeDataProvider: provider });
  context.subscriptions.push(provider, view);

  const rowOf = (arg: unknown): PluginRow | undefined => (arg && typeof arg === 'object' && (arg as Node).kind === 'row' ? (arg as { row: PluginRow }).row : undefined);

  const apply = async (args: string[], verb: string): Promise<boolean> => {
    const root = getActiveWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.');
      return false;
    }
    const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `SpecGuard: ${verb}…` }, () => changePlugins(root, args));
    if (!res.ok) {
      void vscode.window.showErrorMessage(`SpecGuard: ${res.message || `could not ${verb}`}`);
      return false;
    }
    // The local API caches loaded plugins for its lifetime; a fresh one sees the change.
    hub?.reset();
    onChange();
    void vscode.window.showInformationMessage(`SpecGuard: ${res.message}. CLI and API pick it up now; restart the MCP server for agents to see it.`);
    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.plugins.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('specguard.plugins.run', (command?: string) => {
      if (command) void openAndRun(context, command);
    }),
    vscode.commands.registerCommand('specguard.plugins.enable', async (arg?: unknown) => {
      const row = rowOf(arg);
      if (row) await apply(['enable', row.id], `enabling ${row.id}`);
    }),
    vscode.commands.registerCommand('specguard.plugins.disable', async (arg?: unknown) => {
      const row = rowOf(arg);
      if (row) await apply(['disable', row.id], `disabling ${row.id}`);
    }),
    vscode.commands.registerCommand('specguard.plugins.remove', async (arg?: unknown) => {
      const row = rowOf(arg);
      if (!row || row.source !== 'npm') return;
      const pick = await vscode.window.showWarningMessage(`Remove "${row.id}" from this project's plugin list? The npm package stays installed.`, { modal: true }, 'Remove');
      if (pick === 'Remove') await apply(['remove', row.id], `removing ${row.id}`);
    }),
    vscode.commands.registerCommand('specguard.plugins.add', async () => {
      const pkg = (await vscode.window.showInputBox({
        title: 'Add an npm plugin (1/2)',
        prompt: 'npm package that exports a SpecGuard plugin',
        placeHolder: '@acme/specguard-plugin-checks',
        validateInput: (v) => (NPM_PACKAGE.test(v.trim()) ? undefined : 'Enter an npm package name'),
      }))?.trim();
      if (!pkg) return;
      const id = (await vscode.window.showInputBox({
        title: 'Add an npm plugin (2/2)',
        prompt: 'The id the package gives its plugin',
        value: suggestPluginId(pkg),
        validateInput: (v) => (PLUGIN_ID.test(v.trim()) ? undefined : 'Lowercase letters, digits and hyphens, starting with a letter'),
      }))?.trim();
      if (!id) return;
      const choice = await vscode.window.showWarningMessage(
        `Add "${pkg}"?`,
        {
          modal: true,
          detail: `SpecGuard imports this package to check it is a plugin, and then runs it whenever SpecGuard runs in this project. That is arbitrary code from npm: only continue if you trust "${pkg}". Install scripts are not run.`,
        },
        'Install and add',
        'Add (already installed)',
      );
      if (!choice) return;
      await apply(['add', id, '--package', pkg, '--yes', ...(choice === 'Install and add' ? ['--install'] : [])], `adding ${id}`);
    }),
  );

  void provider.refresh(false);
  return provider;
}
