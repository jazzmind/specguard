import { useState } from 'react';
import type { ViewModel } from '../reducer.js';
import type { FindingItem, FindingCategory, FindingSeverity } from '../protocol.js';
import { vscodeApi } from '../vscode.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEV_RANK: Record<FindingSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const SEV_COLOR: Record<FindingSeverity, string> = {
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

// Findings from lint/quality can be auto-fixed; others cannot.
const AUTO_FIXABLE_CATS = new Set<FindingCategory>(['lint', 'quality', 'dead-code']);

type SortKey = 'severity' | 'category' | 'file' | 'message';

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

function SortableHeader({
  label, sortKey, current, dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <th
      style={{
        padding: '4px 6px', cursor: 'pointer', userSelect: 'none',
        color: active ? '#e0e0e0' : '#666',
        fontSize: 11, textAlign: 'left',
        borderBottom: '1px solid #333',
        whiteSpace: 'nowrap',
      }}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && <span style={{ marginLeft: 3, fontSize: 9 }}>{dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Finding row
// ---------------------------------------------------------------------------

function FindingRow({ f, onOpen, onFix }: {
  f: FindingItem;
  onOpen: (f: FindingItem) => void;
  onFix: (f: FindingItem) => void;
}) {
  const sevColor = SEV_COLOR[f.severity] ?? '#b0bec5';
  const canFix = AUTO_FIXABLE_CATS.has(f.category as FindingCategory);

  return (
    <tr style={{ fontSize: 12, borderBottom: '1px solid #1e1e1e' }}>
      <td style={{ padding: '4px 6px', color: sevColor, fontWeight: 600, whiteSpace: 'nowrap' }}>{f.severity}</td>
      <td style={{ padding: '4px 6px', color: '#aaa', whiteSpace: 'nowrap' }}>{CAT_LABEL[f.category] ?? f.category}</td>
      <td style={{
        padding: '4px 6px', color: '#e0e0e0', fontFamily: 'monospace',
        maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
        title={f.file}
      >
        {f.file}{f.line ? `:${f.line}` : ''}
      </td>
      <td style={{ padding: '4px 6px', color: '#ccc', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.message}>
        {f.message}
      </td>
      <td style={{ padding: '4px 6px', color: '#666', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{f.rule ?? ''}</td>
      <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
        <button
          style={actionBtnStyle}
          onClick={() => onOpen(f)}
          title="Open file in editor"
        >
          Open
        </button>
        {canFix && (
          <button
            style={{ ...actionBtnStyle, borderColor: '#3a5a3a', color: '#4ec9b0', marginLeft: 4 }}
            onClick={() => onFix(f)}
            title="Run ESLint --fix on this file"
          >
            Fix
          </button>
        )}
      </td>
    </tr>
  );
}

const actionBtnStyle: React.CSSProperties = {
  fontSize: 10, padding: '1px 6px',
  background: 'transparent', border: '1px solid #444', borderRadius: 3,
  color: '#888', cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// FindingsView
// ---------------------------------------------------------------------------

export function FindingsView({ vm }: { vm: ViewModel }) {
  const [catFilter, setCatFilter] = useState<FindingCategory | 'all'>('all');
  const [sevFilter, setSevFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortKey>('severity');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  };

  const handleOpen = (f: FindingItem) => {
    vscodeApi.postMessage({ type: 'openFile', path: f.file, line: f.line });
  };

  const handleFix = (f: FindingItem) => {
    // Run quality --fix on the specific file
    vscodeApi.postMessage({ type: 'run', pipeline: 'quality', args: ['--fix', '--file', f.file] });
  };

  const handleFixAll = () => {
    vscodeApi.postMessage({ type: 'run', pipeline: 'quality', args: ['--fix'] });
  };

  const handlePlanAll = () => {
    const issues = filtered.slice(0, 20)
      .map((f) => `${f.severity} ${f.category}: ${f.message} (${f.file}${f.line ? `:${f.line}` : ''})`)
      .join('; ');
    vscodeApi.postMessage({
      type: 'run',
      pipeline: 'plan-fix',
      args: ['--pipeline', 'quality', '--issues', issues],
    });
  };

  // Filter
  const base = vm.findings.filter((f) => {
    if (catFilter !== 'all' && f.category !== catFilter) return false;
    if (sevFilter !== 'all' && f.severity !== sevFilter) return false;
    return true;
  });

  // Sort
  const filtered = [...base].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'severity') cmp = (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);
    else if (sortBy === 'category') cmp = a.category.localeCompare(b.category);
    else if (sortBy === 'file') cmp = a.file.localeCompare(b.file);
    else if (sortBy === 'message') cmp = a.message.localeCompare(b.message);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const counts = CATEGORIES.reduce<Record<string, number>>((acc, c) => {
    acc[c] = vm.findings.filter((f) => f.category === c).length;
    return acc;
  }, {});

  const hasFixable = filtered.some((f) => AUTO_FIXABLE_CATS.has(f.category as FindingCategory));

  if (vm.findings.length === 0) {
    return (
      <div style={{ padding: '16px', color: '#555', fontStyle: 'italic', fontSize: 13 }}>
        No findings yet. Run <code>quality</code> or <code>deps</code> to see results.
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Toolbar: category pills + severity selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
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
        <select
          value={sevFilter}
          onChange={(e) => setSevFilter(e.target.value)}
          style={{ fontSize: 11, background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: 4, padding: '2px 4px' }}
        >
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        {/* Batch action buttons */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {hasFixable && (
            <button
              style={{ ...actionBtnStyle, borderColor: '#3a5a3a', color: '#4ec9b0' }}
              onClick={handleFixAll}
              title="Run ESLint --fix on all fixable findings"
            >
              Fix All
            </button>
          )}
          <button
            style={{ ...actionBtnStyle, borderColor: '#3a3a6a', color: '#9d9dff' }}
            onClick={handlePlanAll}
            title="Generate an agent-consumable fix plan for visible findings"
          >
            Plan
          </button>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', maxHeight: 440, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <SortableHeader label="Severity" sortKey="severity" current={sortBy} dir={sortDir} onSort={handleSort} />
              <SortableHeader label="Category" sortKey="category" current={sortBy} dir={sortDir} onSort={handleSort} />
              <SortableHeader label="File" sortKey="file" current={sortBy} dir={sortDir} onSort={handleSort} />
              <SortableHeader label="Message" sortKey="message" current={sortBy} dir={sortDir} onSort={handleSort} />
              <th style={{ padding: '4px 6px', fontSize: 11, color: '#666', textAlign: 'left', borderBottom: '1px solid #333' }}>Rule</th>
              <th style={{ padding: '4px 6px', fontSize: 11, color: '#666', textAlign: 'left', borderBottom: '1px solid #333' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f) => (
              <FindingRow key={f.id} f={f} onOpen={handleOpen} onFix={handleFix} />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: '#555', marginTop: 8 }}>
        {filtered.length} of {vm.findings.length} findings shown
        {filtered.length < vm.findings.length && (
          <button
            style={{ ...actionBtnStyle, marginLeft: 8 }}
            onClick={() => { setCatFilter('all'); setSevFilter('all'); }}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
