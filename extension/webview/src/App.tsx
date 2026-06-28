import { useEffect, useReducer, useState } from 'react';
import type { DashboardEvent } from './protocol.js';
import { initialViewModel, reduce, type ViewModel } from './reducer.js';
import { vscodeApi } from './vscode.js';
import { FlowView } from './views/FlowView.js';

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
        {tab === 'matrix' && <pre>Matrix view (Task 9) — rows: {vm.matrix?.rows.length ?? 0}</pre>}
        {tab === 'docs' && <pre>Docs view (Task 9)</pre>}
        {tab === 'activity' && <pre>Activity view (Task 9) — artifacts: {vm.artifacts.length}</pre>}
      </main>
      {vm.errors.length > 0 && <footer className="sg-errors">{vm.errors.at(-1)}</footer>}
    </div>
  );
}
