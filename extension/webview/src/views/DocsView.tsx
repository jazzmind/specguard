import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

export function DocsView({ vm }: { vm: ViewModel }) {
  const docs = vm.artifacts.filter((a) => a.kind === 'doc');
  if (docs.length === 0) {
    return <div style={{ padding: 16 }}><p>No generated docs yet.</p>
      <button onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'docs' })}>Run docs</button></div>;
  }
  return (
    <div style={{ padding: 16 }}>
      <h3>Generated user docs ({docs.length})</h3>
      <ul>{docs.map((d) => <li key={d.path}><button onClick={() => vscodeApi.postMessage({ type: 'openFile', path: d.path })}>{d.path}</button></li>)}</ul>
    </div>
  );
}
