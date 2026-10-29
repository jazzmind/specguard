/** Visible destination selection before writing pipelines. Spec: integration-surfaces. */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveCliPath, spawnCli } from './dashboard/cli.js';
import { configDirFor } from './project-config.js';

export async function queryCli<T = unknown>(root: string, args: string[]): Promise<T> {
  const lines: string[] = [];
  const handle = spawnCli(await resolveCliPath(root), [...args, '--json'], root, line => lines.push(line));
  const code = await handle.promise;
  if (code !== 0) throw new Error(lines.join('\n') || `SpecGuard exited ${code}`);
  for (const line of lines.reverse()) try { return JSON.parse(line); } catch { /* streamed progress */ }
  throw new Error('SpecGuard returned no JSON result');
}

interface Destination { kind: string; directory: string; saved: boolean; mappingOnly: boolean; }
interface AppOutputs { app: string; code: string; configRoot: string; testDirectories?: Record<string, string>; testDirectoryOptions?: Record<string, string[]>; outputs: Destination[]; }
const kinds: Record<string, string> = { reverse: 'specs', import: 'specs', 'spec-draft': 'specs', docs: 'docs', 'gap-analysis': 'plans' };

function suggestions(app: AppOutputs, kind: string, current: Destination): string[] {
  const dirs: string[] = [];
  if (!current.mappingOnly) dirs.push(current.directory);
  if (kind.startsWith('tests.')) {
    const layer = kind.split('.')[1];
    if (!current.saved) dirs.unshift(...(app.testDirectoryOptions?.[layer] ?? (app.testDirectories?.[layer] ? [app.testDirectories[layer]] : [])));
    for (let root = app.configRoot, depth = 0; depth < 4; root = path.dirname(root), depth++) {
      const e2e = path.join(root, 'e2e');
      if (layer === 'e2e' && fs.existsSync(path.join(e2e, 'playwright.config.ts'))) dirs.unshift(path.join(e2e, 'journeys'));
    }
    const native = layer === 'e2e' ? path.join(app.code, 'e2e') : path.join(app.code, 'tests');
    if (fs.existsSync(native)) dirs.push(native);
    dirs.push(path.join(app.configRoot, 'generated-tests', layer));
  }
  return [...new Set(dirs)];
}

/** Returns undefined on cancel, otherwise CLI arguments scoped to exactly the selected app. */
export async function prepareOutputRun(root: string, pipeline: string, extra: string[]): Promise<string[] | undefined> {
  let kind = kinds[pipeline];
  const args = [...extra];
  if (pipeline === 'generate') {
    const index = args.indexOf('--type');
    const selected = index >= 0 ? args[index + 1] : await vscode.window.showQuickPick(['unit', 'integration', 'e2e'], { title: 'Generate tests: choose test layer' });
    if (!selected) return;
    kind = `tests.${selected}`;
    if (index < 0) args.push('--type', selected);
    if (selected === 'e2e' && !args.includes('--framework')) args.push('--framework', 'playwright');
  }
  if (!kind) return args;
  const apps = await queryCli(root, ['outputs']) as AppOutputs[];
  const appIndex = args.indexOf('--app');
  const selected = appIndex >= 0 ? apps.find(a => a.app === args[appIndex + 1]) : apps.length === 1 ? apps[0]
    : (await vscode.window.showQuickPick(apps.map(a => ({ label: a.app, description: a.code, app: a })), { title: 'Choose application' }))?.app;
  if (!selected) return;
  const output = selected.outputs.find(o => o.kind === kind)!;
  const options = suggestions(selected, kind, output);
  if (output.saved) { const at = options.indexOf(output.directory); if (at >= 0) options.splice(at, 1); options.unshift(output.directory); }
  const picked = await vscode.window.showQuickPick([
    ...options.map(directory => ({ label: directory, description: directory === output.directory ? 'Current destination' : 'Suggested destination', directory })),
    { label: 'Choose another folder…', description: '', directory: '' },
  ], { title: `${pipeline} · ${selected.app} · ${kind}`, placeHolder: `Read code: ${selected.code} | Specs/config: ${selected.configRoot}. Choose where to write.` });
  if (!picked) return;
  let directory = picked.directory;
  if (!directory) {
    const value = await vscode.window.showInputBox({ title: `Destination for ${kind}`, value: options[0] ?? output.directory, prompt: 'Absolute path, or relative to the displayed config root', validateInput: value => value.trim() ? undefined : 'Enter a directory' });
    if (!value) return;
    directory = path.resolve(selected.configRoot, value);
  }
  if (kind === 'specs' && directory !== output.directory) {
    const choice = await vscode.window.showInformationMessage('Use this as the new spec root? Existing Markdown specs will be copied with their relative paths. Originals are retained; conflicts are refused.', { modal: true }, 'Copy specs and use folder');
    if (!choice) return;
  }
  if (appIndex < 0) args.push('--app', selected.app);
  const choice = await vscode.window.showQuickPick([
    { label: `Run ${pipeline}`, description: `AI generation writes: ${directory}` },
    { label: 'Open destination settings', description: 'Review all saved paths before running' },
  ], { title: `${selected.app}: destination saved for ${kind}` });
  if (!choice) return;
  if (choice.label === 'Open destination settings') {
    const file = path.join(configDirFor(root), '.specguard/output-locations.json');
    if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file));
    else await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ application: selected.app, kind, directory }, null, 2) }));
    return;
  }
  if (directory !== output.directory || !output.saved) await queryCli(root, ['outputs', '--app', selected.app, '--kind', kind, '--directory', directory]);
  return args;
}
