import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

function StatCard({ label, value, sub, ok }: { label: string; value: string | number; sub?: string; ok?: boolean }) {
  const color = ok === undefined ? '#888' : ok ? '#4ec9b0' : '#f48771';
  return (
    <div style={{
      background: '#1e1e1e', border: `1px solid ${color}44`, borderRadius: 6,
      padding: '10px 14px', minWidth: 100, flex: 1,
    }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function OverviewView({ vm, onNavigate }: { vm: ViewModel; onNavigate?: (tab: string) => void }) {
  const ws = vm.workspace;
  const hasSpecs = vm.coverage.some((a) => a.specCount > 0);
  const totalSpecs = vm.coverage.reduce((s, a) => s + a.specCount, 0);
  const totalTests = vm.coverage.reduce((s, a) => s + a.testCount, 0);
  const totalSource = vm.coverage.reduce((s, a) => s + a.sourceCount, 0);
  const totalDocs = vm.artifacts.filter((a) => a.kind === 'doc').length;
  const overallPct = vm.coverage.length > 0
    ? Math.round(vm.coverage.reduce((s, a) => s + a.percentage, 0) / vm.coverage.length)
    : 0;

  const driftInfo = vm.lastRunInfo['drift'];
  const matrixInfo = vm.lastRunInfo['matrix'];
  const recentActivity = vm.activity.slice(0, 6);

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: '#eee' }}>
          {ws ? ws.name : 'SpecGuard'}
        </h2>
        {ws?.configFound && vm.projectConfig && !vm.projectConfig.hasApiKey && (
          <div style={{
            background: '#3a2e10', border: '1px solid #e2c08d55', borderRadius: 6,
            padding: '10px 14px', marginTop: 8, fontSize: 12, color: '#e2c08d',
          }}>
            No API key set for <code>{vm.projectConfig.llm.apiKeyEnv}</code>.
            LLM-based pipelines (reverse, generate, heal…) will fail.{' '}
            <button
              onClick={() => onNavigate?.('settings')}
              style={{ background: 'none', border: 'none', color: '#4fc3f7', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}
            >
              Add key in Settings →
            </button>
          </div>
        )}
        {ws && !ws.configFound && (
          <div style={{
            background: '#3a1e1e', border: '1px solid #f4877155', borderRadius: 6,
            padding: '10px 14px', marginTop: 8, fontSize: 12, color: '#f48771',
          }}>
            No <code>.specguard/config.json</code> found.{' '}
            <button
              onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'init' })}
              style={{ background: 'none', border: 'none', color: '#4fc3f7', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}
            >
              Initialize SpecGuard
            </button>
          </div>
        )}
      </div>

      {/* Coverage stats */}
      {vm.coverage.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: '#666', marginBottom: 8 }}>
            Coverage
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <StatCard label="Spec coverage" value={`${overallPct}%`} sub={`${totalSpecs} specs / ${totalSource} sources`} ok={overallPct >= 80} />
            <StatCard label="Specs" value={totalSpecs} ok={totalSpecs > 0} />
            <StatCard label="Tests" value={totalTests} ok={totalTests > 0} />
            <StatCard label="Docs" value={totalDocs} />
          </div>
        </div>
      )}

      {/* Drift + Matrix status */}
      {(driftInfo || matrixInfo) && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: '#666', marginBottom: 8 }}>
            Health
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {driftInfo && (
              <StatCard
                label="Last drift check"
                value={driftInfo.status === 'pass' ? 'Clean' : 'Drifted'}
                sub={timeAgo(driftInfo.finishedAt)}
                ok={driftInfo.status === 'pass'}
              />
            )}
            {matrixInfo && (
              <StatCard
                label="Traceability"
                value={matrixInfo.status === 'pass' ? 'Up to date' : 'Stale'}
                sub={timeAgo(matrixInfo.finishedAt)}
                ok={matrixInfo.status === 'pass'}
              />
            )}
            {vm.findings.length > 0 && (
              <StatCard label="Findings" value={vm.findings.length} ok={false} />
            )}
          </div>
        </div>
      )}

      {/* Getting started — shown when no specs yet */}
      {!hasSpecs && ws?.configFound && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: '#666', marginBottom: 8 }}>
            Getting Started
          </div>
          <div style={{
            background: '#1a1d20', border: '1px solid #333', borderRadius: 6, padding: '12px 16px', fontSize: 12, color: '#aaa',
          }}>
            <p style={{ margin: '0 0 10px' }}>No Living Specs found yet. Choose how to create them:</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <button
                  onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'reverse' })}
                  style={{
                    padding: '5px 12px', background: '#0e639c', color: '#fff',
                    border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
                  }}
                >
                  Run reverse
                </button>
                <span style={{ fontSize: 11, color: '#888', paddingTop: 4 }}>
                  Reads your source code and generates specs automatically — best for existing codebases
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <button
                  onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'import' })}
                  style={{
                    padding: '5px 12px', background: '#1e1e1e', color: '#ccc',
                    border: '1px solid #555', borderRadius: 4, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
                  }}
                >
                  Run import
                </button>
                <span style={{ fontSize: 11, color: '#888', paddingTop: 4 }}>
                  Import from a PRD or Jira ticket — a file picker will open
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent activity */}
      {recentActivity.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: '#666', marginBottom: 8 }}>
            Recent Activity
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentActivity.map((a) => {
              const dot = a.status === 'pass' ? '#4ec9b0' : a.status === 'fail' ? '#f48771' : a.status === 'running' ? '#e2c08d' : '#888';
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                  <span style={{ color: '#aaa', minWidth: 70 }}>{a.pipeline}</span>
                  <span style={{ color: '#666' }}>{a.message ?? a.status}</span>
                  <span style={{ marginLeft: 'auto', color: '#555' }}>{timeAgo(new Date(a.timestamp).toISOString())}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state — no config, nothing running */}
      {vm.coverage.length === 0 && recentActivity.length === 0 && ws?.configFound && (
        <div style={{ color: '#555', fontSize: 12, fontStyle: 'italic' }}>
          Loading workspace data…
        </div>
      )}
    </div>
  );
}
