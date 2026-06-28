/**
 * Activity log service.
 *
 * - In-memory ring buffer of the last 500 entries (ActivityEntry[])
 * - Persisted to .specguard/activity-log.json (append-only, rotated at 1 MB)
 * - VS Code OutputChannel "SpecGuard" for searchable, searchable logs
 *
 * This module is the bridge between:
 *   - Extension host pipeline runs (DashboardHost calls appendEntry)
 *   - MCP tool invocations (server.ts appends via the file directly)
 *   - The webview (host.ts watches the file and pushes ActivityLog events)
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
  }

  /** Append a new entry; write to file + output channel. */
  append(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): ActivityEntry {
    const full: ActivityEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      ...entry,
    };

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
            // Rotate: keep only the last 200 entries
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
