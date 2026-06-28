import { useState } from 'react';
import type { ViewModel } from '../reducer.js';
import { RUNNABLE_PIPELINES } from '../protocol.js';
import { vscodeApi } from '../vscode.js';

export function ActivityView({ vm }: { vm: ViewModel }) {
  const [pipeline, setPipeline] = useState(RUNNABLE_PIPELINES[0].id);
  const counts = {
    specs: vm.artifacts.filter((a) => a.kind === 'spec').length,
    tests: vm.artifacts.filter((a) => a.kind === 'test').length,
    docs: vm.artifacts.filter((a) => a.kind === 'doc').length,
  };
  const run = () => {
    vscodeApi.postMessage({ type: 'run', pipeline });
  };
  const log = vm.logs[pipeline] ?? [];
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <span>● {counts.specs} specs</span><span>● {counts.tests} tests</span><span>● {counts.docs} docs</span>
      </div>
      <select value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
        {RUNNABLE_PIPELINES.map((p) => <option key={p.id} value={p.id}>{p.id}{p.destructive ? ' ⚠' : ''}</option>)}
      </select>
      <button onClick={run} style={{ marginLeft: 8 }}>Run</button>
      {log.length > 0 && <pre style={{ background: '#111', color: '#0f0', padding: 8, marginTop: 12, maxHeight: 280, overflow: 'auto' }}>{log.join('\n')}</pre>}
    </div>
  );
}
