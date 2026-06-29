import { useEffect, useReducer, useState } from 'react';
import type { DashboardEvent } from './protocol.js';
import { initialViewModel, reduce, type ViewModel } from './reducer.js';
import { vscodeApi } from './vscode.js';
import { OverviewView } from './views/OverviewView.js';
import { FlowView } from './views/FlowView.js';
import './views/flow.css';
import { MatrixView } from './views/MatrixView.js';
import { DocsView } from './views/DocsView.js';
import { ActivityView } from './views/ActivityView.js';
import { ActivityFeed } from './views/ActivityFeed.js';
import { FindingsView } from './views/FindingsView.js';
import { CoverageView } from './views/CoverageView.js';
import { PlansView } from './views/PlansView.js';

type Tab = 'overview' | 'flow' | 'activity' | 'findings' | 'coverage' | 'matrix' | 'docs' | 'plans';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'flow', label: 'Pipelines' },
  { id: 'plans', label: 'Plans' },
  { id: 'activity', label: 'Activity' },
  { id: 'findings', label: 'Findings' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'docs', label: 'Docs' },
];

export function App() {
  const [vm, dispatch] = useReducer((s: ViewModel, e: DashboardEvent) => reduce(s, e), undefined, initialViewModel);
  const [tab, setTab] = useState<Tab>('overview');

  // Count running pipelines for the activity badge.
  // nodeStates tracks extension-spawned runs; activity covers MCP-driven runs.
  // Use the larger of the two to avoid double-counting when the host syncs MCP
  // state back into nodeStates.
  const runningCount = Object.values(vm.nodeStates).filter((s) => s === 'running').length;
  const totalRunning = runningCount;

  useEffect(() => {
    const onMsg = (ev: MessageEvent<DashboardEvent>) => dispatch(ev.data);
    window.addEventListener('message', onMsg);
    vscodeApi.postMessage({ type: 'refresh' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    vscodeApi.postMessage({ type: 'refresh' });
    setTimeout(() => setRefreshing(false), 1500);
  };

  const ws = vm.workspace;
  return (
    <div className="sg-app">
      <div className="sg-workspace-bar">
        {ws && (
          <>
            <span className="sg-workspace-name">{ws.name}</span>
            <span className="sg-workspace-sep">/</span>
            <span className={`sg-workspace-badge ${ws.configFound ? 'sg-workspace-ok' : 'sg-workspace-missing'}`}>
              {ws.configFound ? `${ws.appCount} app${ws.appCount !== 1 ? 's' : ''}` : 'no config'}
            </span>
            {ws.configFound && ws.configApps.length > 0 && (
              <span className="sg-workspace-apps" title={ws.configApps.join(', ')}>
                {ws.configApps.join(', ')}
              </span>
            )}
            <span className="sg-workspace-path" title={ws.path}>{ws.path}</span>
          </>
        )}
        <button
          onClick={handleRefresh}
          title="Refresh dashboard"
          style={{
            background: 'none',
            border: 'none',
            color: refreshing ? '#4fc3f7' : '#888',
            cursor: 'pointer',
            fontSize: 14,
            padding: '2px 6px',
            borderRadius: 4,
            transition: 'color 0.2s',
            flexShrink: 0,
          }}
        >
          {refreshing ? '↻' : '↺'}
        </button>
      </div>
      <header className="sg-tabs">
        {TABS.map((t) => {
          let badge: number | null = null;
          if (t.id === 'activity' && totalRunning > 0) badge = totalRunning;
          if (t.id === 'findings' && vm.findings.length > 0) badge = vm.findings.length;
          const pendingPlans = vm.plans.filter((p) => p.status === 'pending').length;
          if (t.id === 'plans' && pendingPlans > 0) badge = pendingPlans;
          return (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {badge !== null && (
                <span style={{
                  marginLeft: 4, background: t.id === 'activity' ? '#4fc3f7' : '#e57373',
                  color: '#000', borderRadius: 10, padding: '0 5px', fontSize: 10, fontWeight: 'bold',
                }}>{badge}</span>
              )}
            </button>
          );
        })}
      </header>
      <main>
        {tab === 'overview' && <OverviewView vm={vm} />}
        {tab === 'flow' && <FlowView vm={vm} dispatch={dispatch} />}
        {tab === 'activity' && (
          <div>
            <ActivityFeed vm={vm} />
            <hr style={{ borderColor: '#333', margin: '0 16px' }} />
            <ActivityView vm={vm} />
          </div>
        )}
        {tab === 'findings' && <FindingsView vm={vm} />}
        {tab === 'plans' && <PlansView vm={vm} />}
        {tab === 'coverage' && <CoverageView vm={vm} />}
        {tab === 'matrix' && <MatrixView vm={vm} />}
        {tab === 'docs' && <DocsView vm={vm} />}
      </main>
      {vm.errors.length > 0 && <footer className="sg-errors">{vm.errors.at(-1)}</footer>}
    </div>
  );
}
