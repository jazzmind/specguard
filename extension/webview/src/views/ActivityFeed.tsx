import { useState } from 'react';
import type { ViewModel } from '../reducer.js';
import type { ActivityEntry } from '../protocol.js';
import { vscodeApi } from '../vscode.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  pass: '✓',
  fail: '✗',
  error: '!',
  info: 'ℹ',
};

const STATUS_COLOR: Record<string, string> = {
  running: '#4fc3f7',
  pass: '#81c784',
  fail: '#e57373',
  error: '#ff8a65',
  info: '#b0bec5',
};

const SOURCE_BADGE: Record<string, string> = {
  mcp: 'MCP',
  extension: 'EXT',
  cli: 'CLI',
};

// ---------------------------------------------------------------------------
// EntryRow — single expandable activity row
// ---------------------------------------------------------------------------

function EntryRow({ entry, currentLogs }: { entry: ActivityEntry; currentLogs: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const color = STATUS_COLOR[entry.status] ?? '#b0bec5';
  const icon = STATUS_ICON[entry.status] ?? '?';
  const badge = SOURCE_BADGE[entry.source] ?? entry.source;

  // Prefer the log snapshot stored in the entry; fall back to current live logs.
  const logLines = (entry.logLines && entry.logLines.length > 0)
    ? entry.logLines
    : (entry.status === 'running' ? currentLogs : []);

  const hasLogs = logLines.length > 0;
  const isRunning = entry.status === 'running';
  const canExpand = hasLogs || isRunning;

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscodeApi.postMessage({ type: 'cancel', pipeline: entry.pipeline });
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscodeApi.postMessage({ type: 'clearActivityEntry', entryId: entry.id });
  };

  return (
    <div style={{ borderBottom: '1px solid #222' }}>
      {/* Summary row — click to expand */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '4px 0',
          fontSize: 12,
          cursor: canExpand ? 'pointer' : 'default',
          userSelect: 'none',
        }}
        onClick={() => canExpand && setExpanded((v) => !v)}
        title={canExpand ? (expanded ? 'Click to collapse logs' : 'Click to expand logs') : undefined}
      >
        <span style={{ color: '#555', minWidth: 70, flexShrink: 0 }}>{ts}</span>
        <span style={{ color, minWidth: 14, textAlign: 'center' }}>{icon}</span>
        <span style={{ background: '#333', color: '#aaa', fontSize: 10, padding: '0 4px', borderRadius: 2, flexShrink: 0 }}>{badge}</span>
        <span style={{ color: '#e0e0e0', fontWeight: 600, fontFamily: 'monospace' }}>{entry.pipeline}</span>
        {entry.message && (
          <span style={{ color: '#777', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.message}
          </span>
        )}
        {entry.durationMs !== undefined && (
          <span style={{ color: '#555', flexShrink: 0, marginLeft: 4 }}>{entry.durationMs}ms</span>
        )}
        {hasLogs && (
          <span style={{ color: '#555', flexShrink: 0, fontSize: 10 }}>
            {expanded ? '▲' : `▼ ${logLines.length} lines`}
          </span>
        )}
        {isRunning && !hasLogs && (
          <span style={{ color: '#4fc3f7', fontSize: 10, flexShrink: 0 }}>live…</span>
        )}

        {/* Per-entry action buttons */}
        <div style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', gap: 4 }}>
          {isRunning && (
            <button
              className="sg-wf-btn sg-wf-btn-cancel"
              style={{ fontSize: 9, padding: '1px 6px' }}
              onClick={handleStop}
            >
              Stop
            </button>
          )}
          {!isRunning && (
            <button
              style={{
                background: 'none', border: 'none', color: '#555', cursor: 'pointer',
                fontSize: 14, padding: '0 3px', lineHeight: 1,
              }}
              onClick={handleDismiss}
              title="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Expanded log panel */}
      {expanded && canExpand && (
        <pre style={{
          margin: '0 0 4px 90px',
          padding: '6px 8px',
          background: '#111',
          color: hasLogs ? '#ccc' : '#555',
          fontSize: 10,
          fontFamily: 'Menlo, Consolas, monospace',
          lineHeight: 1.5,
          maxHeight: 320,
          overflowY: 'auto',
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {hasLogs ? logLines.join('\n') : (isRunning ? '(waiting for output…)' : '')}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------

export function ActivityFeed({ vm }: { vm: ViewModel }) {
  const entries = [...vm.activity].reverse(); // newest first
  const running = vm.activity.filter((e) => e.status === 'running').length;
  const passed = vm.activity.filter((e) => e.status === 'pass').length;
  const failed = vm.activity.filter((e) => e.status === 'fail' || e.status === 'error').length;

  const clearCompleted = () => vscodeApi.postMessage({ type: 'clearActivity', scope: 'completed' });
  const clearAll = () => vscodeApi.postMessage({ type: 'clearActivity', scope: 'all' });

  const btnStyle: React.CSSProperties = {
    fontSize: 10,
    padding: '2px 8px',
    background: 'transparent',
    border: '1px solid #444',
    borderRadius: 3,
    color: '#888',
    cursor: 'pointer',
  };

  return (
    <div style={{ padding: '12px 16px' }}>
      {/* Header row: stats + clear buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, fontSize: 12 }}>
        {running > 0 && <span style={{ color: '#4fc3f7' }}>⏳ {running} running</span>}
        <span style={{ color: '#81c784' }}>✓ {passed} passed</span>
        {failed > 0 && <span style={{ color: '#e57373' }}>✗ {failed} failed</span>}
        <span style={{ color: '#555', fontSize: 11 }}>{vm.activity.length} total</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {vm.activity.length > 0 && (
            <button style={btnStyle} onClick={clearCompleted} title="Remove all non-running entries">
              Clear completed
            </button>
          )}
          {vm.activity.length > 0 && (
            <button style={{ ...btnStyle, borderColor: '#5a3a3a', color: '#e57373' }} onClick={clearAll} title="Remove all activity entries">
              Clear all
            </button>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <p style={{ color: '#555', fontStyle: 'italic', fontSize: 12 }}>
          No activity yet. Run a pipeline or trigger from an agent.
        </p>
      ) : (
        <div style={{ maxHeight: 520, overflowY: 'auto', fontFamily: 'monospace' }}>
          {entries.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              currentLogs={vm.logs[e.pipeline] ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}
