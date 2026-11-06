import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class { label: string; constructor(label: string) { this.label = label; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class {}, EventEmitter: class { event = vi.fn(); },
}));
import { HelpProvider } from './help-view.js';
import { initDocs } from './docs-content.js';
import { buildHtml } from './workspace-panel.js';

const repo = path.resolve(__dirname, '../..');
const topics = JSON.parse(readFileSync(path.join(repo, 'docs', 'help-topics.json'), 'utf8')) as Record<string, { title: string; text: string; page: string; anchor: string }>;
const manifest = JSON.parse(readFileSync(path.join(repo, 'docs', 'manifest.json'), 'utf8')) as { pages: { file: string; sections: { anchor: string }[] }[] };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (n === 'node_modules') return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

// [claims: capabilities/integration-surfaces#extension-help-popovers]
describe('help keys used by the extension', () => {
  const files = [...sources(path.join(repo, 'extension', 'src')), ...sources(path.join(repo, 'extension', 'webview', 'src'))];
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const used = new Set<string>();
  for (const m of text.matchAll(/(?:data-help="|topic[:=]\s*['"{`]+|HELP\[')((?:workspace|dashboard|sidebar|docs|plugins|cli)\.[A-Za-z]+)/g)) used.add(m[1]);
  for (const m of text.matchAll(/['"`]((?:workspace|dashboard|sidebar)\.(?!json\b)[A-Za-z]+)['"`]/g)) used.add(m[1]);
  // Keys built from a name: the dashboard sub-tabs and the sidebar views.
  for (const m of readFileSync(path.join(repo, 'extension', 'webview', 'src', 'App.tsx'), 'utf8').matchAll(/\{ id: '([a-z]+)', label:/g)) used.add(`dashboard.${m[1]}`);
  for (const v of ['coverage', 'pipelines', 'plugins']) used.add(`sidebar.${v}`);

  it('finds the keys the dashboards and views use', () => {
    for (const k of ['dashboard.overview', 'dashboard.traceability', 'workspace.status', 'workspace.teamServer', 'sidebar.plugins']) expect(used).toContain(k);
  });
  it('has every one of them in docs/help-topics.json', () => {
    expect([...used].filter((k) => !topics[k])).toEqual([]);
  });
  it('points every topic at a shipped page and a real anchor', () => {
    for (const [key, t] of Object.entries(topics)) {
      const page = manifest.pages.find((p) => p.file === t.page);
      expect(page, key).toBeDefined();
      expect(page!.sections.map((s) => s.anchor), key).toContain(t.anchor);
    }
  });
  it('puts a help button beside the workspace dashboard sections', () => {
    const html = buildHtml({} as never);
    for (const k of ['workspace.status', 'workspace.drift', 'workspace.settings', 'workspace.repos', 'workspace.contracts']) expect(html).toContain(`data-help="${k}"`);
    expect(html).toContain('data-act="help"');
  });
});

// [claims: capabilities/integration-surfaces#extension-help-view]
describe('Help & Docs view', () => {
  it('lists the manifest pages in groups, each opening in the docs panel', () => {
    const ext = mkdtempSync(path.join(tmpdir(), 'sg-help-'));
    mkdirSync(path.join(ext, 'media', 'docs'), { recursive: true });
    copyFileSync(path.join(repo, 'docs', 'manifest.json'), path.join(ext, 'media', 'docs', 'manifest.json'));
    initDocs(ext);
    const provider = new HelpProvider();
    const groups = provider.getChildren();
    expect(groups.map((g) => (g as { label: string }).label)).toEqual(expect.arrayContaining(['Start here', 'Quickstarts', 'Reference', 'Developer']));
    const page = provider.getChildren(groups[0])[0];
    const item = provider.getTreeItem(page);
    expect(item.command?.command).toBe('specguard.openDocs');
    expect(String(item.command?.arguments?.[0])).toMatch(/\.md$/);
  });
  it('is declared in the sidebar with its commands and Help actions', () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'extension', 'package.json'), 'utf8'));
    expect(pkg.contributes.views['specguard-sidebar'].map((v: { id: string }) => v.id)).toContain('specguard.helpView');
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const c of ['specguard.openDocs', 'specguard.generateContractMappings', 'specguard.help.coverage', 'specguard.help.pipelines', 'specguard.help.plugins']) expect(ids).toContain(c);
    const titleActions = pkg.contributes.menus['view/title'].filter((m: { command: string }) => m.command.startsWith('specguard.help.'));
    expect(titleActions).toHaveLength(3);
  });
});
