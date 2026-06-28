import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DashboardEvent, DashboardCommand, FindingItem, ActivityEntry } from './protocol.js';
import { RUNNABLE_PIPELINES } from './protocol.js';
import { resolveCliPath, spawnCli } from './cli.js';
import { parseCoverageText } from './coverage-parse.js';
import { toMatrixModel } from './matrix-model.js';
import { artifactEventFor, cliArgsFor } from './flow-events.js';
import { ActivityLogService } from './activity-log.js';

export class DashboardHost {
  private watcher?: vscode.FileSystemWatcher;
  private sourceWatcher?: vscode.FileSystemWatcher;
  private activityWatcher?: fs.FSWatcher;
  private driftTimer?: ReturnType<typeof setTimeout>;
  private autoDocsTimer?: Map<string, ReturnType<typeof setTimeout>>;
  private activityLog: ActivityLogService;
  private lastActivityCount = 0;

  constructor(private post: (e: DashboardEvent) => void, private workspaceRoot: string) {
    this.activityLog = new ActivityLogService(workspaceRoot);
    this.autoDocsTimer = new Map();
  }

  start(): void {
    // Watch spec/test/doc artifact changes
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{specs,tests,docs}/**/*.{md,ts,js}');
    const emitArtifact = (uri: vscode.Uri, change: 'create' | 'update') => {
      const rel = path.relative(this.workspaceRoot, uri.fsPath);
      const ev = artifactEventFor(rel, change);
      if (ev) this.post(ev);

      // Auto-docs: if spec changed and autoDocs is enabled, trigger doc-generate
      const cfg = vscode.workspace.getConfiguration('specguard');
      if (cfg.get<boolean>('autoDocs', false) && rel.includes('specs') && rel.endsWith('.md')) {
        this._scheduleAutoDocs(rel);
      }
    };
    this.watcher.onDidCreate((u) => emitArtifact(u, 'create'));
    this.watcher.onDidChange((u) => emitArtifact(u, 'update'));

    // Watch source files for drift (debounced 5s)
    this.sourceWatcher = vscode.workspace.createFileSystemWatcher('**/{src,app,lib}/**/*.{ts,js,tsx,jsx}');
    const scheduleDrift = () => {
      if (this.driftTimer) clearTimeout(this.driftTimer);
      this.driftTimer = setTimeout(() => { void this._runDriftBackground(); }, 5_000);
    };
    this.sourceWatcher.onDidChange(scheduleDrift);
    this.sourceWatcher.onDidCreate(scheduleDrift);
    this.sourceWatcher.onDidDelete(scheduleDrift);

    // Watch activity-log.json for MCP/agent events
    const logFile = path.join(this.workspaceRoot, '.specguard', 'activity-log.json');
    this._watchActivityLog(logFile);

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

  getActivityLog(): ActivityLogService {
    return this.activityLog;
  }

  private async run(pipeline: string, extra: string[]): Promise<void> {
    const entry = RUNNABLE_PIPELINES.find((p) => p.id === pipeline);
    if (entry?.destructive) {
      const choice = await vscode.window.showWarningMessage(
        `Run "${entry.label ?? pipeline}"? It may call the LLM and write files.`,
        { modal: true },
        'Run',
      );
      if (choice !== 'Run') {
        this.post({ type: 'pipeline:log', pipeline, line: 'cancelled by user' });
        return;
      }
    }

    this.post({ type: 'pipeline:start', pipeline });
    const startMs = Date.now();

    // Log start to activity log
    this.activityLog.append({ pipeline, status: 'running', source: 'extension' });

    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      const code = await spawnCli(cli, cliArgsFor(pipeline, extra), this.workspaceRoot,
        (line) => this.post({ type: 'pipeline:log', pipeline, line }));

      const ok = code === 0 || code === 4;
      this.post({ type: 'pipeline:done', pipeline, exitCode: code });

      // Log completion to activity log
      this.activityLog.append({
        pipeline,
        status: ok ? 'pass' : 'fail',
        source: 'extension',
        durationMs: Date.now() - startMs,
        message: `exit code ${code}`,
      });

      await this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', scope: pipeline, message: msg });
      this.activityLog.append({ pipeline, status: 'error', source: 'extension', message: msg });
    }
  }

  async refresh(): Promise<void> {
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
    // Findings from quality/dep JSON outputs (if present)
    this._pushFindings();
    // Activity log entries
    this._pushActivityLog();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.sourceWatcher?.dispose();
    this.activityWatcher?.close();
    this.activityLog.dispose();
    if (this.driftTimer) clearTimeout(this.driftTimer);
    this.autoDocsTimer?.forEach((t) => clearTimeout(t));
  }

  // ---------------------------------------------------------------------------
  // Activity log file watcher
  // ---------------------------------------------------------------------------

  private _watchActivityLog(logFile: string): void {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    }
    try {
      this.activityWatcher = fs.watch(logFile, { persistent: false }, () => {
        this._pushActivityLog();
      });
    } catch {
      // File may not exist yet — retry after a delay
      setTimeout(() => this._watchActivityLog(logFile), 5_000);
    }
  }

  private _pushActivityLog(): void {
    const entries = this.activityLog.getEntries();
    if (entries.length !== this.lastActivityCount) {
      this.lastActivityCount = entries.length;
      this.post({ type: 'activity', entries });
    }
  }

  // ---------------------------------------------------------------------------
  // Background drift run (triggered by source file changes)
  // ---------------------------------------------------------------------------

  private async _runDriftBackground(): Promise<void> {
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      const lines: string[] = [];
      const code = await spawnCli(cli, ['drift'], this.workspaceRoot, (l) => lines.push(l));
      const hasDrift = code === 3;
      if (hasDrift) {
        this.activityLog.append({
          pipeline: 'drift',
          status: 'info',
          source: 'extension',
          message: lines.filter((l) => l.startsWith('[drift]')).join('; ') || 'spec drift detected',
        });
        this._pushActivityLog();
      }
    } catch {
      // Background task — ignore errors
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-docs on spec change
  // ---------------------------------------------------------------------------

  private _scheduleAutoDocs(specRel: string): void {
    const key = specRel;
    const existing = this.autoDocsTimer?.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.autoDocsTimer?.delete(key);
      void this._runAutoDocs(specRel);
    }, 3_000);
    this.autoDocsTimer?.set(key, timer);
  }

  private async _runAutoDocs(specRel: string): Promise<void> {
    // Derive spec key from relative path like specs/core/parser.md -> core/parser
    const match = specRel.match(/specs[/\\](.+)\.md$/i);
    if (!match) return;
    const specKey = match[1].replace(/\\/g, '/');
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      await spawnCli(cli, ['docs', '--spec', specKey], this.workspaceRoot, () => { /* suppress */ });
      this.activityLog.append({ pipeline: 'docs', status: 'pass', source: 'extension', message: `auto-generated for ${specKey}` });
      this._pushActivityLog();
    } catch {
      // Auto-docs is best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Findings push
  // ---------------------------------------------------------------------------

  private _pushFindings(): void {
    const findings: FindingItem[] = [];

    const tryLoad = (file: string, category: string) => {
      try {
        if (!fs.existsSync(file)) return;
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
        if (!raw || typeof raw !== 'object') return;

        // code-quality.json format
        const asQuality = raw as { findings?: unknown[] };
        if (Array.isArray(asQuality.findings)) {
          for (const f of asQuality.findings) {
            const item = f as Record<string, unknown>;
            findings.push({
              id: `${category}-${findings.length}`,
              severity: (item['severity'] as string ?? 'warning') as FindingItem['severity'],
              category: category as FindingItem['category'],
              file: String(item['file'] ?? item['path'] ?? ''),
              line: typeof item['line'] === 'number' ? item['line'] : undefined,
              message: String(item['message'] ?? ''),
              rule: String(item['rule'] ?? item['ruleId'] ?? ''),
              source: String(item['source'] ?? category),
            });
          }
        }
      } catch {
        // Best-effort
      }
    };

    tryLoad(path.join(this.workspaceRoot, '.specguard', 'code-quality.json'), 'lint');
    tryLoad(path.join(this.workspaceRoot, '.specguard', 'dep-check.json'), 'deps');

    if (findings.length > 0) {
      this.post({ type: 'findings', data: findings });
    }
  }
}
