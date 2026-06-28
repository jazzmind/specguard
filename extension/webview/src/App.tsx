import { useEffect, useReducer, useState } from 'react';
import type { DashboardEvent } from './protocol.js';
import { initialViewModel, reduce, type ViewModel } from './reducer.js';
import { vscodeApi } from './vscode.js';
import { FlowView } from './views/FlowView.js';
import { MatrixView } from './views/MatrixView.js';
import { DocsView } from './views/DocsView.js';
import { ActivityView } from './views/ActivityView.js';

type Tab = 'flow' | 'matrix' | 'docs' | 'activity';

export function App() {
  const [vm, dispatch] = useReducer((s: ViewModel, e: DashboardEvent) => reduce(s, e), undefined, initialViewModel);
  const [tab, setTab] = useState<Tab>('flow');

  useEffect(() => {
    const onMsg = (ev: MessageEvent<DashboardEvent>) => dispatch(ev.data);
    window.addEventListener('message', onMsg);
    vscodeApi.postMessage({ type: 'refresh' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const tabs: Tab[] = ['flow', 'matrix', 'docs', 'activity'];
  return (
    <div className="sg-app">
      <header className="sg-tabs">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </header>
      <main>
        {tab === 'flow' && <FlowView vm={vm} />}
        {tab === 'matrix' && <MatrixView vm={vm} />}
        {tab === 'docs' && <DocsView vm={vm} />}
        {tab === 'activity' && <ActivityView vm={vm} />}
      </main>
      {vm.errors.length > 0 && <footer className="sg-errors">{vm.errors.at(-1)}</footer>}
    </div>
  );
}
