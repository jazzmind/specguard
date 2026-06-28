import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DashboardEvent, DashboardCommand } from './protocol.js';
import { RUNNABLE_PIPELINES } from './protocol.js';
import { resolveCliPath, spawnCli } from './cli.js';
import { parseCoverageText } from './coverage-parse.js';
import { toMatrixModel } from './matrix-model.js';
import { artifactEventFor, cliArgsFor } from './flow-events.js';

export class DashboardHost {
  private watcher?: vscode.FileSystemWatcher;
  constructor(private post: (e: DashboardEvent) => void, private workspaceRoot: string) {}

  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{specs,tests,docs}/**/*.{md,ts,js}');
    const emit = (uri: vscode.Uri, change: 'create' | 'update') => {
      const rel = path.relative(this.workspaceRoot, uri.fsPath);
      const ev = artifactEventFor(rel, change);
      if (ev) this.post(ev);
    };
    this.watcher.onDidCreate((u) => emit(u, 'create'));
    this.watcher.onDidChange((u) => emit(u, 'update'));
    void this.refresh();
  }

  async handle(cmd: DashboardCommand): Promise<void> {
    if (cmd.type === 'refresh') return this.refresh();
    if (cmd.type === 'openFile') {
      await vscode.window.showTextDocument(vscode.Uri.file(path.resolve(this.workspaceRoot, cmd.path)));
      return;
    }
    if (cmd.type === 'run') return this.run(cmd.pipeline, cmd.args ?? []);
  }

  private async run(pipeline: string, extra: string[]): Promise<void> {
    const entry = RUNNABLE_PIPELINES.find((p) => p.id === pipeline);
    if (entry?.destructive) {
      const choice = await vscode.window.showWarningMessage(
        `Run "${pipeline}"? It may call the LLM and write files.`,
        { modal: true },
        'Run',
      );
      if (choice !== 'Run') {
        this.post({ type: 'pipeline:log', pipeline, line: 'cancelled by user' });
        return;
      }
    }
    this.post({ type: 'pipeline:start', pipeline });
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      const code = await spawnCli(cli, cliArgsFor(pipeline, extra), this.workspaceRoot,
        (line) => this.post({ type: 'pipeline:log', pipeline, line }));
      this.post({ type: 'pipeline:done', pipeline, exitCode: code });
      await this.refresh();
    } catch (err) {
      this.post({ type: 'error', scope: pipeline, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async refresh(): Promise<void> {
    // Coverage (best-effort, lenient text parse)
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      let out = '';
      await spawnCli(cli, ['status'], this.workspaceRoot, (l) => { out += l + '\n'; });
      this.post({ type: 'coverage', data: parseCoverageText(out) });
    } catch (err) {
      this.post({ type: 'error', scope: 'status', message: err instanceof Error ? err.message : String(err) });
    }
    // Matrix from traceability.json (if present)
    try {
      const file = path.join(this.workspaceRoot, '.specguard', 'traceability.json');
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        this.post({ type: 'matrix', data: toMatrixModel(raw) });
      }
    } catch (err) {
      this.post({ type: 'error', scope: 'matrix', message: err instanceof Error ? err.message : String(err) });
    }
  }

  dispose(): void { this.watcher?.dispose(); }
}
