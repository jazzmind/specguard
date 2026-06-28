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

type Tab = 'overview' | 'flow' | 'activity' | 'findings' | 'coverage' | 'matrix' | 'docs';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'flow', label: 'Pipelines' },
  { id: 'activity', label: 'Activity' },
  { id: 'findings', label: 'Findings' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'docs', label: 'Docs' },
];

export function App() {
  const [vm, dispatch] = useReducer((s: ViewModel, e: DashboardEvent) => reduce(s, e), undefined, initialViewModel);
  const [tab, setTab] = useState<Tab>('overview');

  // Count running pipelines for badge
  const runningCount = Object.values(vm.nodeStates).filter((s) => s === 'running').length;
  const mcpRunningCount = vm.activity.filter((e) => e.status === 'running').length;
  const totalRunning = runningCount + mcpRunningCount;

  useEffect(() => {
    const onMsg = (ev: MessageEvent<DashboardEvent>) => dispatch(ev.data);
    window.addEventListener('message', onMsg);
    vscodeApi.postMessage({ type: 'refresh' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const ws = vm.workspace;
  return (
    <div className="sg-app">
      {ws && (
        <div className="sg-workspace-bar">
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
        </div>
      )}
      <header className="sg-tabs">
        {TABS.map((t) => {
          let badge: number | null = null;
          if (t.id === 'activity' && totalRunning > 0) badge = totalRunning;
          if (t.id === 'findings' && vm.findings.length > 0) badge = vm.findings.length;
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
        {tab === 'flow' && <FlowView vm={vm} />}
        {tab === 'activity' && (
          <div>
            <ActivityFeed vm={vm} />
            <hr style={{ borderColor: '#333', margin: '0 16px' }} />
            <ActivityView vm={vm} />
          </div>
        )}
        {tab === 'findings' && <FindingsView vm={vm} />}
        {tab === 'coverage' && <CoverageView vm={vm} />}
        {tab === 'matrix' && <MatrixView vm={vm} />}
        {tab === 'docs' && <DocsView vm={vm} />}
      </main>
      {vm.errors.length > 0 && <footer className="sg-errors">{vm.errors.at(-1)}</footer>}
    </div>
  );
}
