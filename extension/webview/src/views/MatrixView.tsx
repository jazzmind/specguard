import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

export function MatrixView({ vm }: { vm: ViewModel }) {
  const m = vm.matrix;
  if (!m || m.rows.length === 0) {
    return <div style={{ padding: 16 }}><p>No traceability data.</p>
      <button onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'matrix' })}>Run matrix</button></div>;
  }
  return (
    <div style={{ padding: 16 }}>
      <p style={{ color: '#888' }}>generated {m.generatedAt ?? '—'}</p>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr><th align="left">Spec</th><th align="left">Source</th><th>Tests</th><th>Docs</th></tr></thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={`${r.appName}/${r.specKey}`} style={{ borderTop: '1px solid #333' }}>
              <td><button onClick={() => vscodeApi.postMessage({ type: 'openFile', path: r.sourceModule })}>{r.title}</button></td>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.sourceModule}</td>
              <td align="center" style={{ color: r.hasTests ? '#4ec9b0' : '#f48771' }}>{r.hasTests ? `✓ ${r.testCount}` : '—'}</td>
              <td align="center" style={{ color: r.hasDocs ? '#4ec9b0' : '#888' }}>{r.hasDocs ? '✓' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
