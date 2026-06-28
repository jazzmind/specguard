/**
 * Standalone activity log writer for the MCP server.
 *
 * Writes ActivityEntry objects to .specguard/activity-log.json so the VS Code
 * extension can watch the file and display agent actions in the dashboard.
 *
 * This module has ZERO imports from the extension host — it only uses Node.js
 * built-ins and mirrors the same file format as ActivityLogService.
 */
import fs from 'node:fs';
import path from 'node:path';

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

const MAX_FILE_BYTES = 1 * 1024 * 1024;

/** Append a single entry to the activity log. Never throws. */
export function appendActivityLogEntry(
  workspaceRoot: string,
  entry: Omit<ActivityEntry, 'id' | 'timestamp'>,
): void {
  try {
    const logFile = path.join(workspaceRoot, '.specguard', 'activity-log.json');
    const dir = path.dirname(logFile);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let existing: ActivityEntry[] = [];
    if (fs.existsSync(logFile)) {
      try {
        const stat = fs.statSync(logFile);
        const raw = JSON.parse(fs.readFileSync(logFile, 'utf-8')) as ActivityEntry[];
        existing = Array.isArray(raw) ? (stat.size > MAX_FILE_BYTES ? raw.slice(-200) : raw) : [];
      } catch {
        existing = [];
      }
    }

    const full: ActivityEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      ...entry,
    };

    existing.push(full);
    fs.writeFileSync(logFile, JSON.stringify(existing, null, 2), 'utf-8');
  } catch {
    // Best-effort — never crash the MCP server
  }
}
