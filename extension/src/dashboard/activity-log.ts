/**
 * Activity log service.
 *
 * - In-memory ring buffer of the last 500 entries (ActivityEntry[])
 * - Persisted to .specguard/activity-log.json (append-only, rotated at 1 MB)
 * - VS Code OutputChannel "SpecGuard" for searchable logs
 *
 * This module is the bridge between:
 *   - Extension host pipeline runs (DashboardHost calls append)
 *   - MCP tool invocations (server.ts appends via the file directly)
 *   - The webview (host.ts watches the file and pushes activity events)
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityStatus = 'running' | 'pass' | 'fail' | 'error' | 'info';
export type ActivitySource = 'extension' | 'mcp' | 'cli';

export interface ActivityEntry {
  id: string;
  timestamp: number;
  pipeline: string;
  status: ActivityStatus;
  source: ActivitySource;
  message?: string;
  durationMs?: number;
  counts?: { created?: number; updated?: number; skipped?: number; failed?: number };
  /** Full log output captured during this run. */
  logLines?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MEMORY = 500;
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// ActivityLogService
// ---------------------------------------------------------------------------

export class ActivityLogService {
  private entries: ActivityEntry[] = [];
  private channel: vscode.OutputChannel;
  private logFile: string;

  constructor(private workspaceRoot: string) {
    this.channel = vscode.window.createOutputChannel('SpecGuard');
    this.logFile = path.join(workspaceRoot, '.specguard', 'activity-log.json');
    this._loadExisting();
    this._reconcileStaleRunning();
  }

  /**
   * Append a new entry; write to file + output channel.
   *
   * When appending a terminal status (pass/fail/error), the most-recent
   * matching `running` entry for the same pipeline+source is removed from the
   * in-memory buffer so the feed shows one consolidated row per run rather
   * than a start row and an end row.
   */
  append(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): ActivityEntry {
    const full: ActivityEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      ...entry,
    };

    // Remove the dangling `running` entry when we get a terminal status.
    const terminal: ActivityStatus[] = ['pass', 'fail', 'error'];
    if (terminal.includes(full.status)) {
      const idx = this._findLastRunning(full.pipeline, full.source);
      if (idx !== -1) this.entries.splice(idx, 1);
    }

    // In-memory ring buffer
    this.entries.push(full);
    if (this.entries.length > MAX_MEMORY) this.entries = this.entries.slice(-MAX_MEMORY);

    // Output channel
    const ts = new Date(full.timestamp).toLocaleTimeString();
    const statusIcon = { running: '⏳', pass: '✓', fail: '✗', error: '!', info: 'i' }[full.status];
    const msg = `[${ts}] ${statusIcon} ${full.pipeline}${full.message ? ': ' + full.message : ''}`;
    this.channel.appendLine(msg);

    // File persistence
    this._persistEntry(full);

    return full;
  }

  /** Get all in-memory entries (newest last). */
  getEntries(): ActivityEntry[] {
    return [...this.entries];
  }

  /** Show the output channel. */
  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Remove a single entry by id from the buffer and file. */
  removeEntry(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this._overwriteFile();
  }

  /**
   * Remove all entries from the in-memory buffer and the log file.
   * Active runs (currently `running`) are preserved unless `includeRunning` is true.
   */
  clearAll(includeRunning = false): void {
    this.entries = includeRunning
      ? []
      : this.entries.filter((e) => e.status === 'running');
    this._overwriteFile();
  }

  /**
   * Remove all non-running entries (pass/fail/error/info) from the buffer and file.
   */
  clearCompleted(): void {
    this.entries = this.entries.filter((e) => e.status === 'running');
    this._overwriteFile();
  }

  /**
   * After loading from file, mark any `running` entry that has no later
   * terminal (pass/fail/error) entry for the same pipeline+source as stale.
   * Also marks running entries older than 2 hours as stale regardless of context.
   * This handles crashes / hard restarts where the completion was never written.
   */
  private _reconcileStaleRunning(): void {
    const terminal = new Set<ActivityStatus>(['pass', 'fail', 'error']);
    const terminatedKeys = new Set<string>();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();

    // Walk newest-first to build the set of pipelines that did complete.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (terminal.has(e.status)) terminatedKeys.add(`${e.pipeline}::${e.source}`);
    }

    let changed = false;
    for (const e of this.entries) {
      if (e.status === 'running') {
        const isStaleByContext = !terminatedKeys.has(`${e.pipeline}::${e.source}`);
        const isStaleByAge = (now - e.timestamp) > TWO_HOURS_MS;
        if (isStaleByContext || isStaleByAge) {
          e.status = 'error';
          e.message = isStaleByAge
            ? 'stale — started >2h ago (likely from a previous session)'
            : 'stale — never completed (extension restarted)';
          changed = true;
        }
      }
    }

    if (changed) {
      this._overwriteFile();
    }
  }

  private _overwriteFile(): void {
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.logFile, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  /** Find the index of the most-recent `running` entry for this pipeline+source. */
  private _findLastRunning(pipeline: string, source: ActivitySource): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.status === 'running' && e.pipeline === pipeline && e.source === source) return i;
    }
    return -1;
  }

  private _loadExisting(): void {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const raw = fs.readFileSync(this.logFile, 'utf-8').trim();
      if (!raw) return;
      const parsed = JSON.parse(raw) as ActivityEntry[];
      if (Array.isArray(parsed)) {
        this.entries = parsed.slice(-MAX_MEMORY);
      }
    } catch {
      // File corrupt or missing — start fresh
    }
  }

  private _persistEntry(entry: ActivityEntry): void {
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let existing: ActivityEntry[] = [];
      if (fs.existsSync(this.logFile)) {
        try {
          const stat = fs.statSync(this.logFile);
          if (stat.size > MAX_FILE_BYTES) {
            const raw = JSON.parse(fs.readFileSync(this.logFile, 'utf-8')) as ActivityEntry[];
            existing = Array.isArray(raw) ? raw.slice(-200) : [];
          } else {
            const raw = JSON.parse(fs.readFileSync(this.logFile, 'utf-8')) as ActivityEntry[];
            existing = Array.isArray(raw) ? raw : [];
          }
        } catch {
          existing = [];
        }
      }

      existing.push(entry);
      fs.writeFileSync(this.logFile, JSON.stringify(existing, null, 2), 'utf-8');
    } catch {
      // Never throw — log persistence is best-effort
    }
  }
}
