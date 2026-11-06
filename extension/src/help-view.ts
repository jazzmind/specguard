/** The Help & Docs sidebar view: the shipped documentation pages grouped by the manifest. */
import * as vscode from 'vscode';
import { groupPages, loadManifest, type DocPage } from './docs-content.js';

type HelpNode = { kind: 'group'; label: string; pages: DocPage[] } | { kind: 'page'; page: DocPage };

export class HelpProvider implements vscode.TreeDataProvider<HelpNode> {
  readonly onDidChangeTreeData = new vscode.EventEmitter<void>().event;

  getTreeItem(node: HelpNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('book');
      item.id = `specguard.help.${node.label}`;
      return item;
    }
    const item = new vscode.TreeItem(node.page.title, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('file');
    item.command = { command: 'specguard.openDocs', title: 'Open documentation', arguments: [node.page.file] };
    return item;
  }

  getChildren(node?: HelpNode): HelpNode[] {
    if (node?.kind === 'group') return node.pages.map((page) => ({ kind: 'page', page }));
    if (node) return [];
    return groupPages(loadManifest()).map((g) => ({ kind: 'group', label: g.group, pages: g.pages }));
  }
}
