import { useEffect, useReducer, useRef, useState, useMemo } from 'react';
import type { DashboardEvent, DashboardTab } from './protocol.js';
import { initialViewModel, reduce, type ViewModel } from './reducer.js';
import { vscodeApi } from './vscode.js';
import { OverviewView } from './views/OverviewView.js';
import { FlowView } from './views/FlowView.js';
import './views/flow.css';
import { MatrixView } from './views/MatrixView.js';
import { DocsView } from './views/DocsView.js';
import { ActivityFeed } from './views/ActivityFeed.js';
import { FindingsView } from './views/FindingsView.js';
import { CoverageView } from './views/CoverageView.js';
import { PlansView } from './views/PlansView.js';
import { SpecsView } from './views/SpecsView.js';
import { SettingsView } from './views/SettingsView.js';

type MainTabId = 'overview' | 'actions' | 'docs' | 'settings';
type SubTabId = DashboardTab | 'traceability' | 'specs' | 'settings';

interface SubTabDef { id: SubTabId; label: string; }

interface TabGroup {
  id: MainTabId;
  label: string;
  subtabs: SubTabDef[];
}

const TAB_GROUPS: TabGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    subtabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'coverage', label: 'Coverage' },
    ],
  },
  {
    id: 'actions',
    label: 'Actions',
    subtabs: [
      { id: 'flow', label: 'Actions' },
      { id: 'plans', label: 'Plans' },
      { id: 'findings', label: 'Findings' },
      { id: 'activity', label: 'Activity' },
    ],
  },
  {
    id: 'docs',
    label: 'Docs',
    subtabs: [
      { id: 'docs', label: 'Docs' },
      { id: 'specs', label: 'Specs' },
      { id: 'traceability', label: 'Traceability' },
    ],
  },
  { id: 'settings', label: 'Settings', subtabs: [] },
];

/** Resolve the main tab id from a subtab id (for navigate events). */
function mainTabForSubTab(subTab: SubTabId): MainTabId {
  for (const group of TAB_GROUPS) {
    if (group.subtabs.some((s) => s.id === subTab)) return group.id;
  }
  return 'actions';
}

/** Resolve the default subtab for a main tab. */
function defaultSubTab(mainTab: MainTabId): SubTabId {
  const group = TAB_GROUPS.find((g) => g.id === mainTab);
  return group?.subtabs[0]?.id ?? 'flow';
}

export function App() {
  const [vm, dispatch] = useReducer((s: ViewModel, e: DashboardEvent) => reduce(s, e), undefined, initialViewModel);
  const [mainTab, setMainTab] = useState<MainTabId>('overview');
  const [subTab, setSubTab] = useState<SubTabId>('overview');
  const pendingScrollTo = useRef<string | null>(null);

  // Count running pipelines for the actions badge.
  const runningCount = Object.values(vm.nodeStates).filter((s) => s === 'running').length;
  const totalRunning = runningCount;

  const activeGroup = useMemo(
    () => TAB_GROUPS.find((g) => g.id === mainTab) ?? TAB_GROUPS[0],
    [mainTab],
  );

  useEffect(() => {
    const onMsg = (ev: MessageEvent<DashboardEvent>) => {
      const msg = ev.data;
      if (msg.type === 'navigate') {
        // Navigate events carry a subtab id (e.g. 'flow'). Resolve the main tab.
        const targetSub = msg.tab as SubTabId;
        const resolvedMain = mainTabForSubTab(targetSub);
        setMainTab(resolvedMain);
        setSubTab(targetSub);
        if (msg.scrollTo) {
          pendingScrollTo.current = msg.scrollTo;
        }
        return;
      }
      dispatch(msg);
    };
    window.addEventListener('message', onMsg);
    vscodeApi.postMessage({ type: 'refresh' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Scroll to a pipeline card after the tab renders.
  useEffect(() => {
    const target = pendingScrollTo.current;
    if (!target) return;
    pendingScrollTo.current = null;
    const tryScroll = (attempts = 0) => {
      const el = document.getElementById(`sg-card-${target}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (attempts < 5) {
        setTimeout(() => tryScroll(attempts + 1), 80);
      }
    };
    setTimeout(() => tryScroll(), 50);
  }, [subTab]);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    vscodeApi.postMessage({ type: 'refresh' });
    setTimeout(() => setRefreshing(false), 1500);
  };

  const handleMainTabClick = (groupId: MainTabId) => {
    setMainTab(groupId);
    setSubTab(defaultSubTab(groupId));
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

      {/* Main tabs */}
      <header className="sg-tabs">
        {TAB_GROUPS.map((g) => {
          let badge: number | null = null;
          if (g.id === 'actions' && totalRunning > 0) badge = totalRunning;
          return (
            <button key={g.id} className={mainTab === g.id ? 'active' : ''} onClick={() => handleMainTabClick(g.id)}>
              {g.label}
              {badge !== null && (
                <span style={{
                  marginLeft: 4, background: '#4fc3f7',
                  color: '#000', borderRadius: 10, padding: '0 5px', fontSize: 10, fontWeight: 'bold',
                }}>{badge}</span>
              )}
            </button>
          );
        })}
      </header>

      {/* Subtabs */}
      {activeGroup.subtabs.length > 0 && (
        <div className="sg-subtabs">
          {activeGroup.subtabs.map((st) => {
            let badge: number | null = null;
            if (st.id === 'findings' && vm.findings.length > 0) badge = vm.findings.length;
            const pendingPlans = vm.plans.filter((p) => p.status === 'pending').length;
            if (st.id === 'plans' && pendingPlans > 0) badge = pendingPlans;
            return (
              <button key={st.id} className={subTab === st.id ? 'active' : ''} onClick={() => setSubTab(st.id)}>
                {st.label}
                {badge !== null && (
                  <span style={{
                    marginLeft: 3, background: '#e57373',
                    color: '#000', borderRadius: 10, padding: '0 4px', fontSize: 9, fontWeight: 'bold',
                  }}>{badge}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <main>
        {subTab === 'overview' && <OverviewView vm={vm} />}
        {subTab === 'coverage' && <CoverageView vm={vm} />}
        {subTab === 'flow' && <FlowView vm={vm} dispatch={dispatch} />}
        {subTab === 'plans' && <PlansView vm={vm} />}
        {subTab === 'findings' && <FindingsView vm={vm} />}
        {subTab === 'activity' && <ActivityFeed vm={vm} />}
        {subTab === 'docs' && <DocsView vm={vm} />}
        {subTab === 'specs' && <SpecsView vm={vm} />}
        {subTab === 'traceability' && <MatrixView vm={vm} />}
        {subTab === 'settings' && <SettingsView />}
      </main>
      {vm.errors.length > 0 && <footer className="sg-errors">{vm.errors.at(-1)}</footer>}
    </div>
  );
}
