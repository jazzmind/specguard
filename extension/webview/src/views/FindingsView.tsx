import { useState } from 'react';
import type { ViewModel } from '../reducer.js';
import type { FindingItem, FindingCategory } from '../protocol.js';

const SEV_COLOR: Record<string, string> = {
  critical: '#f44336',
  error: '#e57373',
  warning: '#ffd54f',
  info: '#b0bec5',
};

const CAT_LABEL: Record<string, string> = {
  lint: 'Lint',
  security: 'Security',
  deps: 'Dependencies',
  'dead-code': 'Dead Code',
  quality: 'Quality',
};

const CATEGORIES: FindingCategory[] = ['lint', 'security', 'deps', 'dead-code', 'quality'];

function FindingRow({ f }: { f: FindingItem }) {
  const sevColor = SEV_COLOR[f.severity] ?? '#b0bec5';
  return (
    <tr style={{ fontSize: 12, borderBottom: '1px solid #2a2a2a' }}>
      <td style={{ padding: '4px 6px', color: sevColor }}>{f.severity}</td>
      <td style={{ padding: '4px 6px', color: '#aaa' }}>{CAT_LABEL[f.category] ?? f.category}</td>
      <td style={{ padding: '4px 6px', color: '#e0e0e0', fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file}{f.line ? `:${f.line}` : ''}</td>
      <td style={{ padding: '4px 6px', color: '#ccc' }}>{f.message}</td>
      <td style={{ padding: '4px 6px', color: '#666', fontFamily: 'monospace' }}>{f.rule ?? ''}</td>
    </tr>
  );
}

export function FindingsView({ vm }: { vm: ViewModel }) {
  const [catFilter, setCatFilter] = useState<FindingCategory | 'all'>('all');
  const [sevFilter, setSevFilter] = useState<string>('all');

  const filtered = vm.findings.filter((f) => {
    if (catFilter !== 'all' && f.category !== catFilter) return false;
    if (sevFilter !== 'all' && f.severity !== sevFilter) return false;
    return true;
  });

  const counts = CATEGORIES.reduce<Record<string, number>>((acc, c) => {
    acc[c] = vm.findings.filter((f) => f.category === c).length;
    return acc;
  }, {});

  if (vm.findings.length === 0) {
    return (
      <div style={{ padding: '16px', color: '#555', fontStyle: 'italic', fontSize: 13 }}>
        No findings yet. Run <code>quality</code> or <code>deps</code> to see results.
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Summary pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {CATEGORIES.filter((c) => counts[c] > 0).map((c) => (
          <button
            key={c}
            onClick={() => setCatFilter(catFilter === c ? 'all' : c)}
            style={{
              padding: '2px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 11,
              background: catFilter === c ? '#4fc3f7' : '#333',
              color: catFilter === c ? '#000' : '#ccc',
            }}
          >
            {CAT_LABEL[c]} {counts[c]}
          </button>
        ))}
        <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value)} style={{ marginLeft: 'auto', fontSize: 11, background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: 4 }}>
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </div>
      {/* Table */}
      <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ fontSize: 11, color: '#666', textAlign: 'left', borderBottom: '1px solid #333' }}>
              <th style={{ padding: '4px 6px' }}>Severity</th>
              <th style={{ padding: '4px 6px' }}>Category</th>
              <th style={{ padding: '4px 6px' }}>File</th>
              <th style={{ padding: '4px 6px' }}>Message</th>
              <th style={{ padding: '4px 6px' }}>Rule</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f) => <FindingRow key={f.id} f={f} />)}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: '#555', marginTop: 8 }}>{filtered.length} of {vm.findings.length} findings shown</div>
    </div>
  );
}
