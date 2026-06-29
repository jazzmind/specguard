import type { ViewModel } from '../reducer.js';
import type { PlanItem } from '../protocol.js';
import { vscodeApi } from '../vscode.js';

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  pending:      { bg: '#3a3a1a', color: '#ffd54f', label: 'Pending' },
  'in-progress': { bg: '#1a2d3a', color: '#4fc3f7', label: 'In Progress' },
  done:          { bg: '#1a3a1a', color: '#81c784', label: 'Done' },
};

const STATUS_ORDER: Record<string, number> = { pending: 0, 'in-progress': 1, done: 2 };

// ---------------------------------------------------------------------------
// PlanCard
// ---------------------------------------------------------------------------

function PlanCard({ item }: { item: PlanItem }) {
  const sty = STATUS_STYLES[item.status] ?? STATUS_STYLES['pending'];
  const date = item.generatedAt ? new Date(item.generatedAt).toLocaleDateString() : '';
  const completedDate = item.completedAt ? new Date(item.completedAt).toLocaleDateString() : null;

  const openPlan = () => vscodeApi.postMessage({ type: 'openFile', path: item.filePath });
  const markStatus = (s: 'pending' | 'in-progress' | 'done') =>
    vscodeApi.postMessage({ type: 'markPlanStatus', filePath: item.filePath, status: s });

  return (
    <div style={{
      background: '#1e1e1e', border: '1px solid #333', borderRadius: 6,
      padding: '10px 14px', marginBottom: 8,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
          background: sty.bg, color: sty.color, whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {sty.label}
        </span>
        <button
          onClick={openPlan}
          style={{
            background: 'none', border: 'none', color: '#e0e0e0',
            cursor: 'pointer', fontSize: 13, fontWeight: 600, textAlign: 'left',
            padding: 0, flex: 1,
          }}
          title="Open plan file"
        >
          {item.title}
        </button>
      </div>

      {/* Meta */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: '#888' }}>
          pipeline: <code style={{ color: '#ccc' }}>{item.pipeline}</code>
        </span>
        {item.specKey && (
          <span style={{ fontSize: 11, color: '#888' }}>
            spec: <code style={{ color: '#ccc' }}>{item.specKey}</code>
          </span>
        )}
        <span style={{ fontSize: 11, color: '#555' }}>generated {date}</span>
        {completedDate && (
          <span style={{ fontSize: 11, color: '#555' }}>done {completedDate}</span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button style={btnStyle('#3a3a3a', '#ccc')} onClick={openPlan}>
          Open
        </button>
        {item.status !== 'in-progress' && (
          <button
            style={btnStyle('#1a2d3a', '#4fc3f7')}
            onClick={() => markStatus('in-progress')}
            title="Mark as in progress (agent is implementing)"
          >
            In Progress
          </button>
        )}
        {item.status !== 'done' && (
          <button
            style={btnStyle('#1a3a1a', '#81c784')}
            onClick={() => markStatus('done')}
            title="Mark as done (implementation complete)"
          >
            Mark Done
          </button>
        )}
        {item.status === 'done' && (
          <button
            style={btnStyle('#3a1a1a', '#e57373')}
            onClick={() => markStatus('pending')}
            title="Reopen (implementation needs more work)"
          >
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}

function btnStyle(bg: string, color: string): React.CSSProperties {
  return {
    fontSize: 11, padding: '2px 8px', borderRadius: 4,
    background: bg, border: `1px solid ${color}44`, color,
    cursor: 'pointer',
  };
}

// ---------------------------------------------------------------------------
// PlansView
// ---------------------------------------------------------------------------

export function PlansView({ vm }: { vm: ViewModel }) {
  if (vm.plans.length === 0) {
    return (
      <div style={{ padding: 24, color: '#555', fontSize: 13, fontStyle: 'italic' }}>
        No plans yet. Run <code>gap-analysis</code>, <code>drift</code>, or other pipelines
        to generate agent-consumable plan files in <code>.specguard/plans/</code>.
      </div>
    );
  }

  const byStatus = (status: string) => vm.plans.filter((p) => p.status === status);
  const pending = byStatus('pending');
  const inProgress = byStatus('in-progress');
  const done = byStatus('done');

  const total = vm.plans.length;
  const doneCount = done.length;

  return (
    <div style={{ padding: 16 }}>
      {/* Progress bar */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: '#888' }}>
            {doneCount} of {total} plans implemented
          </span>
          <span style={{ fontSize: 12, color: '#81c784', fontWeight: 600 }}>
            {total > 0 ? Math.round((doneCount / total) * 100) : 0}%
          </span>
        </div>
        <div style={{ background: '#333', borderRadius: 4, height: 6, overflow: 'hidden' }}>
          <div style={{
            background: '#81c784', height: '100%', borderRadius: 4,
            width: `${total > 0 ? (doneCount / total) * 100 : 0}%`,
            transition: 'width 0.3s ease',
          }} />
        </div>
      </div>

      {/* Sections */}
      {pending.length > 0 && (
        <Section title={`Pending (${pending.length})`} items={pending} />
      )}
      {inProgress.length > 0 && (
        <Section title={`In Progress (${inProgress.length})`} items={inProgress} />
      )}
      {done.length > 0 && (
        <Section title={`Done (${done.length})`} items={done} collapsed />
      )}
    </div>
  );
}

function Section({ title, items, collapsed = false }: { title: string; items: PlanItem[]; collapsed?: boolean }) {
  const [open, setOpen] = React.useState(!collapsed);
  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'none', border: 'none', color: '#aaa', cursor: 'pointer',
          fontSize: 12, fontWeight: 700, padding: '0 0 6px', display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && items.map((item) => (
        <PlanCard key={item.filePath} item={item} />
      ))}
    </div>
  );
}

// React import for Section (useState)
import React from 'react';
