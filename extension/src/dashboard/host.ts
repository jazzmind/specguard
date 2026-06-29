import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DashboardEvent, DashboardCommand, FindingItem, ActivityEntry, WorkspaceInfo, PipelineRunInfo, AnalysisRecommendation } from './protocol.js';
import { RUNNABLE_PIPELINES } from './protocol.js';
import { resolveCliPath, spawnCli, SpawnHandle } from './cli.js';
import { parseCoverageText, augmentCoverageFromDisk } from './coverage-parse.js';
import { toMatrixModel } from './matrix-model.js';
import { artifactEventFor, cliArgsFor } from './flow-events.js';
import { ActivityLogService } from './activity-log.js';

export class DashboardHost {
  private watcher?: vscode.FileSystemWatcher;
  private sourceWatcher?: vscode.FileSystemWatcher;
  private activityWatcher?: fs.FSWatcher;
  private driftTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private autoDocsTimer?: Map<string, ReturnType<typeof setTimeout>>;
  private activityLog: ActivityLogService;
  private lastActivityCount = 0;
  /** Last drift exit code, to suppress duplicate activity log entries. */
  private lastDriftCode: number | undefined = undefined;
  /** Handles for in-flight CLI spawns, keyed by pipeline id. */
  private activeRuns = new Map<string, SpawnHandle>();

  constructor(private post: (e: DashboardEvent) => void, public readonly workspaceRoot: string) {
    this.activityLog = new ActivityLogService(workspaceRoot);
    this.autoDocsTimer = new Map();
  }

  start(): void {
    // Watch spec/test/doc artifact changes
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{specs,tests,docs}/**/*.{md,ts,js}');
    const emitArtifact = (uri: vscode.Uri, change: 'create' | 'update') => {
      const rel = path.relative(this.workspaceRoot, uri.fsPath);
      const ev = artifactEventFor(rel, change);
      if (ev) {
        if (ev.type === 'artifact' && ev.kind === 'doc') {
          const meta = this._readDocMeta(uri.fsPath);
          this.post({ ...ev, ...meta });
        } else {
          this.post(ev);
        }
      }

      // When a spec changes, schedule a coverage refresh so counts stay current.
      if (rel.includes('specs') && rel.endsWith('.md')) {
        this._scheduleRefresh();
      }

      // Auto-docs: if spec changed and autoDocs is enabled, trigger doc-generate
      const cfg = vscode.workspace.getConfiguration('specguard');
      if (cfg.get<boolean>('autoDocs', false) && rel.includes('specs') && rel.endsWith('.md')) {
        this._scheduleAutoDocs(rel);
      }
    };
    this.watcher.onDidCreate((u) => emitArtifact(u, 'create'));
    this.watcher.onDidChange((u) => emitArtifact(u, 'update'));

    // Watch source files for drift (debounced 30s to avoid flooding activity log)
    this.sourceWatcher = vscode.workspace.createFileSystemWatcher('**/{src,app,lib}/**/*.{ts,js,tsx,jsx}');
    const scheduleDrift = () => {
      if (this.driftTimer) clearTimeout(this.driftTimer);
      this.driftTimer = setTimeout(() => { void this._runDriftBackground(); }, 30_000);
    };
    this.sourceWatcher.onDidChange(scheduleDrift);
    this.sourceWatcher.onDidCreate(scheduleDrift);
    this.sourceWatcher.onDidDelete(scheduleDrift);

    // Watch activity-log.json for MCP/agent events
    const logFile = path.join(this.workspaceRoot, '.specguard', 'activity-log.json');
    this._watchActivityLog(logFile);

    this._pushWorkspaceInfo();
    void this.refresh();
  }

  async handle(cmd: DashboardCommand): Promise<void> {
    if (cmd.type === 'refresh') return this.refresh();
    if (cmd.type === 'openFile') {
      const resolved = path.resolve(this.workspaceRoot, cmd.path);
      const uri = vscode.Uri.file(resolved);
      // If path is a directory, reveal it in Explorer; otherwise open as document.
      const stat = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
      if (stat && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
      } else {
        const doc = await vscode.window.showTextDocument(uri);
        if (cmd.line !== undefined && cmd.line > 0) {
          const pos = new vscode.Position(cmd.line - 1, 0);
          doc.selection = new vscode.Selection(pos, pos);
          doc.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
      return;
    }
    if (cmd.type === 'run') {
      // `import` requires a file argument — open a VS Code file picker first.
      if (cmd.pipeline === 'import') {
        await this._runImportWithPicker();
        return;
      }
      return this.run(cmd.pipeline, cmd.args ?? []);
    }
    if (cmd.type === 'cancel') return this._cancelPipeline(cmd.pipeline);
    if (cmd.type === 'runSequence') return this._runSequence(cmd.pipelines);
    if (cmd.type === 'runSequenceBatch') return this._runSequenceBatch(cmd.pipelines);
    if (cmd.type === 'clearActivity') {
      if (cmd.scope === 'completed') {
        this.activityLog.clearCompleted();
      } else {
        this.activityLog.clearAll();
      }
      this.lastActivityCount = -1; // force re-push
      this._pushActivityLog();
      return;
    }
    if (cmd.type === 'markPlanStatus') {
      try {
        const resolved = path.resolve(this.workspaceRoot, cmd.filePath);
        this._updatePlanStatus(resolved, cmd.status);
        this._pushPlans();
      } catch (err) {
        this.post({ type: 'error', scope: 'markPlanStatus', message: (err as Error).message });
      }
      return;
    }
  }

  private async _runImportWithPicker(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Import as spec',
      title: 'Select a PRD, Jira export, or Markdown file to import',
      filters: { 'Documents': ['md', 'txt', 'yaml', 'yml', 'json'] },
      defaultUri: vscode.Uri.file(this.workspaceRoot),
    });
    if (!uris || uris.length === 0) return;
    const file = uris[0].fsPath;
    const rel = path.relative(this.workspaceRoot, file);
    this.post({ type: 'pipeline:log', pipeline: 'import', line: `Importing: ${rel}` });
    await this.run('import', [file]);
  }

  getActivityLog(): ActivityLogService {
    return this.activityLog;
  }

  // ---------------------------------------------------------------------------
  // Pipeline execution
  // ---------------------------------------------------------------------------

  private async run(pipeline: string, extra: string[]): Promise<void> {
    // Guard: refuse concurrent runs of the same pipeline.
    if (this.activeRuns.has(pipeline)) {
      this.post({ type: 'pipeline:log', pipeline, line: `[warn] ${pipeline} is already running — use Cancel first` });
      return;
    }

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
    this.activityLog.append({ pipeline, status: 'running', source: 'extension' });

    const collectedLines: string[] = [];
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      const handle = spawnCli(cli, cliArgsFor(pipeline, extra), this.workspaceRoot,
        (line) => {
          this.post({ type: 'pipeline:log', pipeline, line });
          collectedLines.push(line);
        });
      this.activeRuns.set(pipeline, handle);

      const code = await handle.promise;
      this.activeRuns.delete(pipeline);

      const cancelled = code === -1;
      const ok = !cancelled && (code === 0 || code === 4);

      this.post({ type: 'pipeline:done', pipeline, exitCode: code });

      // Parse finding count from lines like "deps: 54 finding(s)" or "quality: 3 finding(s)".
      const findingCount = parseFindingCount(collectedLines, pipeline);

      const runInfo: PipelineRunInfo = {
        pipeline,
        status: ok ? 'pass' : 'fail',
        exitCode: code,
        finishedAt: new Date().toISOString(),
        tail: collectedLines.filter((l) => l.trim()).slice(-5),
        ...(findingCount !== undefined ? { findingCount } : {}),
      };
      this.post({ type: 'pipeline:lastRun', info: runInfo });

      this.activityLog.append({
        pipeline,
        status: cancelled ? 'error' : ok ? 'pass' : 'fail',
        source: 'extension',
        durationMs: Date.now() - startMs,
        message: cancelled ? 'cancelled by user' : `exit code ${code}`,
        logLines: collectedLines,
      });

      // Pipeline-specific post-run: read JSON output files and push rich events
      if (!cancelled) {
        if (pipeline === 'analyze') {
          this._pushAnalysisResult();
        } else if (pipeline === 'plan-fix') {
          this._pushFixPlan();
        } else if (pipeline === 'heal' && ok) {
          // Auto-commit after a successful heal — no user action needed.
          this.post({ type: 'pipeline:log', pipeline: 'commit', line: '[auto] committing heal output…' });
          await this.run('commit', ['--pipeline', 'heal']);
        }
      }

      await this.refresh();
    } catch (err) {
      this.activeRuns.delete(pipeline);
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', scope: pipeline, message: msg });
      this.post({
        type: 'pipeline:lastRun',
        info: { pipeline, status: 'fail', exitCode: 1, finishedAt: new Date().toISOString(), tail: [msg] },
      });
      this.activityLog.append({ pipeline, status: 'error', source: 'extension', message: msg });
    }
  }

  private _cancelPipeline(pipeline: string): void {
    const handle = this.activeRuns.get(pipeline);
    if (!handle) {
      this.post({ type: 'pipeline:log', pipeline, line: `[warn] ${pipeline} is not currently running` });
      return;
    }
    handle.kill();
    this.activeRuns.delete(pipeline);
    this.post({ type: 'pipeline:log', pipeline, line: '[cancelled]' });
    this.post({ type: 'pipeline:done', pipeline, exitCode: -1 });
    this.activityLog.append({ pipeline, status: 'error', source: 'extension', message: 'cancelled by user' });
  }

  private async _runSequence(pipelines: string[]): Promise<void> {
    for (const p of pipelines) {
      await this.run(p, []);
    }
  }

  /** Like _runSequence but shows ONE confirmation dialog for all pipelines instead of per-pipeline prompts. */
  private async _runSequenceBatch(pipelines: string[]): Promise<void> {
    if (pipelines.length === 0) return;

    const destructiveIds = pipelines.filter((p) => {
      const entry = RUNNABLE_PIPELINES.find((e) => e.id === p);
      return entry?.destructive;
    });

    if (destructiveIds.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `Run ${pipelines.length} pipeline(s) in sequence: ${pipelines.join(', ')}?\nLLM-powered pipelines will call the AI and write files.`,
        { modal: true },
        'Run All',
      );
      if (choice !== 'Run All') {
        for (const p of pipelines) {
          this.post({ type: 'pipeline:log', pipeline: p, line: 'cancelled by user (batch)' });
        }
        return;
      }
    }

    // Run each pipeline, bypassing the individual destructive confirmation since we already asked.
    for (const p of pipelines) {
      if (this.activeRuns.has(p)) {
        this.post({ type: 'pipeline:log', pipeline: p, line: `[warn] ${p} is already running — skipped` });
        continue;
      }
      this.post({ type: 'pipeline:start', pipeline: p });
      const startMs = Date.now();
      this.activityLog.append({ pipeline: p, status: 'running', source: 'extension' });
      const collectedLines: string[] = [];
      try {
        const cli = await resolveCliPath(this.workspaceRoot);
        const handle = spawnCli(cli, cliArgsFor(p, []), this.workspaceRoot, (line) => {
          this.post({ type: 'pipeline:log', pipeline: p, line });
          collectedLines.push(line);
        });
        this.activeRuns.set(p, handle);
        const code = await handle.promise;
        this.activeRuns.delete(p);
        const cancelled = code === -1;
        const ok = !cancelled && (code === 0 || code === 4);
        this.post({ type: 'pipeline:done', pipeline: p, exitCode: code });
        this.post({
          type: 'pipeline:lastRun',
          info: { pipeline: p, status: ok ? 'pass' : 'fail', exitCode: code, finishedAt: new Date().toISOString(), tail: collectedLines.filter((l) => l.trim()).slice(-5) },
        });
        this.activityLog.append({ pipeline: p, status: cancelled ? 'error' : ok ? 'pass' : 'fail', source: 'extension', durationMs: Date.now() - startMs, message: cancelled ? 'cancelled by user' : `exit code ${code}`, logLines: collectedLines });
      } catch (err) {
        this.activeRuns.delete(p);
        const msg = err instanceof Error ? err.message : String(err);
        this.post({ type: 'pipeline:log', pipeline: p, line: `[error] ${msg}` });
        this.post({ type: 'pipeline:done', pipeline: p, exitCode: 1 });
        this.activityLog.append({ pipeline: p, status: 'error', source: 'extension', message: msg });
      }
    }
    await this.refresh();
  }

  private _pushAnalysisResult(): void {
    try {
      const analysisFile = path.join(this.workspaceRoot, '.specguard', 'analysis.json');
      if (!fs.existsSync(analysisFile)) return;
      const data = JSON.parse(fs.readFileSync(analysisFile, 'utf-8')) as {
        recommendations: AnalysisRecommendation[];
      };
      this.post({ type: 'analyze:result', recommendations: data.recommendations ?? [] });
    } catch { /* best-effort */ }
  }

  private _pushFixPlan(): void {
    try {
      const planFile = path.join(this.workspaceRoot, '.specguard', 'fix-plan.json');
      if (!fs.existsSync(planFile)) return;
      const data = JSON.parse(fs.readFileSync(planFile, 'utf-8')) as {
        title: string;
        summary: string;
        sourcePipeline: string;
        steps: Array<{ id: string; description: string; action: string; pipeline?: string; file?: string; command?: string }>;
      };
      this.post({
        type: 'fix-plan',
        plan: {
          title: data.title,
          summary: data.summary,
          sourcePipeline: data.sourcePipeline ?? 'unknown',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          steps: data.steps as any,
        },
      });
    } catch { /* best-effort */ }
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  async refresh(): Promise<void> {
    // Clear accumulated artifacts from any previous project before re-populating.
    this.post({ type: 'clearArtifacts' });

    // Coverage (best-effort, lenient text parse)
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      let out = '';
      const h = spawnCli(cli, ['status'], this.workspaceRoot, (l) => { out += l + '\n'; });
      await h.promise;
      const coverage = parseCoverageText(out);
      // Augment: for apps where `status` reports 0 source files (e.g. imported-from-PRD
      // projects), count spec .md files on disk so the dashboard reflects reality.
      augmentCoverageFromDisk(coverage, this.workspaceRoot);
      this.post({ type: 'coverage', data: coverage });
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
    // Emit existing doc artifacts with metadata
    this._pushExistingDocs();
    // Push last analysis result and fix plan if present
    this._pushAnalysisResult();
    this._pushFixPlan();
    // Findings from quality/dep JSON outputs (if present)
    this._pushFindings();
    // Plans from .specguard/plans/
    this._pushPlans();
    // Activity log entries (also syncs MCP-driven nodeStates)
    this._pushActivityLog();
    // Sync pipeline states from activity log (covers MCP-driven runs)
    this._syncMcpNodeStates();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.sourceWatcher?.dispose();
    this.activityWatcher?.close();
    this.activityLog.dispose();
    if (this.driftTimer) clearTimeout(this.driftTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.autoDocsTimer?.forEach((t) => clearTimeout(t));
    // Kill any in-flight processes
    this.activeRuns.forEach((h) => h.kill());
    this.activeRuns.clear();
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
        this._syncMcpNodeStates();
      });
    } catch {
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

  /**
   * Read the activity log and emit pipeline:start / pipeline:done events for
   * pipelines driven by MCP (agent-driven), so the FlowView cards reflect live
   * agent activity without the extension having spawned those processes.
   */
  private _syncMcpNodeStates(): void {
    const entries = this.activityLog.getEntries();
    // Find the latest entry per pipeline from MCP source.
    const latest = new Map<string, ActivityEntry>();
    for (const e of entries) {
      if (e.source === 'mcp') {
        const prev = latest.get(e.pipeline);
        if (!prev || e.timestamp > prev.timestamp) latest.set(e.pipeline, e);
      }
    }
    for (const [pipeline, e] of latest) {
      if (this.activeRuns.has(pipeline)) continue; // Extension owns this run
      if (e.status === 'running') {
        this.post({ type: 'pipeline:start', pipeline });
      } else {
        const exitCode = e.status === 'pass' ? 0 : 1;
        this.post({ type: 'pipeline:done', pipeline, exitCode });
        this.post({
          type: 'pipeline:lastRun',
          info: {
            pipeline,
            status: e.status === 'pass' ? 'pass' : 'fail',
            exitCode,
            finishedAt: new Date(e.timestamp).toISOString(),
            tail: e.message ? [e.message] : [],
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Background drift run (triggered by source file changes)
  // ---------------------------------------------------------------------------

  private async _runDriftBackground(): Promise<void> {
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      const lines: string[] = [];
      const h = spawnCli(cli, ['drift'], this.workspaceRoot, (l) => lines.push(l));
      const code = await h.promise;
      const hasDrift = code === 3;
      if (code !== this.lastDriftCode) {
        this.lastDriftCode = code;
        this.activityLog.append({
          pipeline: 'drift',
          status: hasDrift ? 'info' : 'pass',
          source: 'extension',
          message: hasDrift
            ? (lines.filter((l) => l.startsWith('[drift]')).join('; ') || 'spec drift detected')
            : 'no drift detected',
        });
        this._pushActivityLog();
      }
    } catch {
      // Background task — ignore errors
    }
  }

  // ---------------------------------------------------------------------------
  // Debounced refresh (triggered by spec file changes)
  // ---------------------------------------------------------------------------

  private _scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 1_500);
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
    const match = specRel.match(/specs[/\\](.+)\.md$/i);
    if (!match) return;
    const specKey = match[1].replace(/\\/g, '/');
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      const h = spawnCli(cli, ['docs', '--spec', specKey], this.workspaceRoot, () => { /* suppress */ });
      await h.promise;
      this.activityLog.append({ pipeline: 'docs', status: 'pass', source: 'extension', message: `auto-generated for ${specKey}` });
      this._pushActivityLog();
    } catch {
      // Auto-docs is best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace info push
  // ---------------------------------------------------------------------------

  private _pushWorkspaceInfo(): void {
    const configFile = path.join(this.workspaceRoot, '.specguard', 'config.json');
    const configFound = fs.existsSync(configFile);
    let configApps: string[] = [];
    if (configFound) {
      try {
        const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { apps?: Array<{ name?: string }> };
        if (Array.isArray(raw.apps)) {
          configApps = raw.apps.map((a) => a.name ?? '').filter(Boolean);
        }
      } catch { /* Best-effort */ }
    }
    const info: WorkspaceInfo = {
      name: path.basename(this.workspaceRoot),
      path: this.workspaceRoot,
      configFound,
      appCount: configApps.length,
      configApps,
    };
    this.post({ type: 'workspace', info });
  }

  // ---------------------------------------------------------------------------
  // Doc artifact metadata
  // ---------------------------------------------------------------------------

  private _readDocMeta(absPath: string): { title?: string; description?: string; category?: string; order?: number } {
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) return {};
      const block = match[1];
      const extract = (key: string): string | undefined => {
        const m = block.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm'));
        return m ? m[1].replace(/\\"/g, '"') : undefined;
      };
      const orderStr = extract('order');
      return {
        title: extract('title'),
        description: extract('description'),
        category: extract('category'),
        order: orderStr !== undefined ? parseInt(orderStr, 10) : undefined,
      };
    } catch {
      return {};
    }
  }

  private _pushExistingDocs(): void {
    const docsDir = path.join(this.workspaceRoot, 'docs', 'user');
    if (!fs.existsSync(docsDir)) return;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const rel = path.relative(this.workspaceRoot, full).replace(/\\/g, '/');
          const meta = this._readDocMeta(full);
          this.post({ type: 'artifact', kind: 'doc', path: rel, change: 'update', ...meta });
        }
      }
    };
    walk(docsDir);
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
      } catch { /* Best-effort */ }
    };

    tryLoad(path.join(this.workspaceRoot, '.specguard', 'code-quality.json'), 'lint');
    tryLoad(path.join(this.workspaceRoot, '.specguard', 'dep-check.json'), 'deps');

    if (findings.length > 0) {
      this.post({ type: 'findings', data: findings });
    }
  }

  /** Parse YAML frontmatter + title from a plan .md file without external deps. */
  private _parsePlanMeta(filePath: string): import('./protocol.js').PlanItem | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch?.[1]?.trim() ?? path.basename(filePath, '.md');

      // Fall back gracefully for plans without frontmatter (treat as pending)
      if (!fmMatch) {
        // Try to infer pipeline from filename (e.g. drift-2026-..., gap-analysis-2026-...)
        const base = path.basename(filePath, '.md');
        const pipeline = base.replace(/-\d{4}-.*$/, '') || 'unknown';
        return {
          filePath, title, pipeline,
          generatedAt: '', status: 'pending',
          specKey: undefined, completedAt: undefined,
        };
      }

      const fm = fmMatch[1];
      const get = (key: string) => fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
      const status = get('status') || 'pending';
      return {
        filePath,
        title,
        pipeline: get('pipeline') || 'unknown',
        generatedAt: get('generatedAt') || '',
        status: status as import('./protocol.js').PlanItem['status'],
        specKey: get('specKey') || undefined,
        completedAt: get('completedAt') || undefined,
      };
    } catch {
      return null;
    }
  }

  /** Update status field in a plan file's YAML frontmatter in-place. */
  private _updatePlanStatus(filePath: string, status: string): void {
    const content = fs.readFileSync(filePath, 'utf8');
    const now = new Date().toISOString();
    const fmRegex = /^(---\n)([\s\S]*?)\n(---)/;
    const match = content.match(fmRegex);
    if (!match) return;
    let fm = match[2];
    if (/^status:/m.test(fm)) {
      fm = fm.replace(/^status:.+$/m, `status: ${status}`);
    } else {
      fm = `${fm}\nstatus: ${status}`;
    }
    if (status === 'done') {
      if (/^completedAt:/m.test(fm)) {
        fm = fm.replace(/^completedAt:.+$/m, `completedAt: ${now}`);
      } else {
        fm = `${fm}\ncompletedAt: ${now}`;
      }
    } else {
      fm = fm.replace(/^completedAt:.+\n?/m, '');
    }
    fs.writeFileSync(filePath, content.replace(fmRegex, `${match[1]}${fm}\n${match[3]}`), 'utf8');
  }

  private _pushPlans(): void {
    const plansDir = path.join(this.workspaceRoot, '.specguard', 'plans');
    if (!fs.existsSync(plansDir)) return;
    const items: import('./protocol.js').PlanItem[] = [];
    try {
      for (const file of fs.readdirSync(plansDir)) {
        if (!file.endsWith('.md')) continue;
        const meta = this._parsePlanMeta(path.join(plansDir, file));
        if (meta) items.push(meta);
      }
    } catch { /* best-effort */ }
    items.sort((a, b) => {
      const rank: Record<string, number> = { pending: 0, 'in-progress': 1, done: 2 };
      const r = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
      return r !== 0 ? r : b.generatedAt.localeCompare(a.generatedAt);
    });
    this.post({ type: 'plans', items });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan CLI output lines for the standard "pipeline: N finding(s)" summary.
 * Returns the total finding count if the pattern is found, or undefined if
 * this pipeline does not report findings in that format.
 *
 * Examples matched:
 *   "deps: 54 finding(s)"
 *   "quality: 3 finding(s)"
 *   "[deps] 42 vulnerability(ies), 0 unused dep(s), 12 missing dep(s)"  → summed
 */
function parseFindingCount(lines: string[], pipeline: string): number | undefined {
  // Primary: "<pipeline>: N finding(s)" on its own line.
  const summaryRe = new RegExp(`^${pipeline}:\\s+(\\d+)\\s+finding`, 'i');
  for (const line of lines) {
    const m = summaryRe.exec(line.trim());
    if (m) return parseInt(m[1], 10);
  }

  // Secondary: lines starting with "[deps]" that list counts (e.g. "42 vulnerability(ies)").
  // Sum all numbers found in bracketed lines for the pipeline.
  if (pipeline === 'deps') {
    const bracketRe = /^\[deps\]\s+(.+)$/i;
    for (const line of lines) {
      const m = bracketRe.exec(line.trim());
      if (m) {
        let total = 0;
        for (const numMatch of m[1].matchAll(/(\d+)\s+\w/g)) {
          total += parseInt(numMatch[1], 10);
        }
        if (total > 0) return total;
      }
    }
  }

  return undefined;
}
