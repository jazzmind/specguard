import type { ViewModel } from '../reducer.js';
import type { ActivityEntry } from '../protocol.js';

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

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const ts = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const color = STATUS_COLOR[entry.status] ?? '#b0bec5';
  const icon = STATUS_ICON[entry.status] ?? '?';
  const badge = SOURCE_BADGE[entry.source] ?? entry.source;

  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', borderBottom: '1px solid #2a2a2a', fontSize: 12 }}>
      <span style={{ color: '#666', minWidth: 70, flexShrink: 0 }}>{ts}</span>
      <span style={{ color, minWidth: 14, textAlign: 'center' }}>{icon}</span>
      <span style={{ background: '#333', color: '#aaa', fontSize: 10, padding: '0 4px', borderRadius: 2, flexShrink: 0 }}>{badge}</span>
      <span style={{ color: '#e0e0e0', fontWeight: 500 }}>{entry.pipeline}</span>
      {entry.message && <span style={{ color: '#888', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.message}</span>}
      {entry.durationMs !== undefined && (
        <span style={{ color: '#555', marginLeft: 'auto', flexShrink: 0 }}>{entry.durationMs}ms</span>
      )}
    </div>
  );
}

export function ActivityFeed({ vm }: { vm: ViewModel }) {
  const entries = [...vm.activity].reverse(); // newest first
  const running = vm.activity.filter((e) => e.status === 'running').length;
  const passed = vm.activity.filter((e) => e.status === 'pass').length;
  const failed = vm.activity.filter((e) => e.status === 'fail' || e.status === 'error').length;

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12 }}>
        {running > 0 && <span style={{ color: '#4fc3f7' }}>⏳ {running} running</span>}
        <span style={{ color: '#81c784' }}>✓ {passed} passed</span>
        {failed > 0 && <span style={{ color: '#e57373' }}>✗ {failed} failed</span>}
        <span style={{ color: '#666', marginLeft: 'auto' }}>{vm.activity.length} total</span>
      </div>
      {entries.length === 0 ? (
        <p style={{ color: '#555', fontStyle: 'italic', fontSize: 12 }}>No activity yet. Run a pipeline or trigger from an agent.</p>
      ) : (
        <div style={{ maxHeight: 400, overflowY: 'auto', fontFamily: 'monospace' }}>
          {entries.map((e) => <EntryRow key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  );
}
