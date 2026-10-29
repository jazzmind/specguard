import { useEffect } from 'react';
import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

export function SettingsView({ vm }: { vm: ViewModel }) {
  const cfg = vm.projectConfig;
  useEffect(() => { vscodeApi.postMessage({ type: 'readProjectConfig' }); }, []);
  return <div style={{ padding: 24, maxWidth: 900 }}>
    <h2>Repository settings</h2>
    <p>Shared defaults are managed at the workspace level. Set overrides when this repo needs a different provider or server.</p>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, margin: '24px 0' }}>
      <section><h3>AI provider</h3><p>{cfg?.llm.provider} · {cfg?.llm.model}</p><p>{cfg?.llmSource ?? 'Loading…'}</p><p>API key: {cfg?.keySource ?? 'Checking…'}</p></section>
      <section><h3>Team server</h3><p>{cfg?.serverUrl || 'Not configured'}</p><p>{cfg?.serverSource ?? 'Loading…'}</p></section>
    </div>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button className="btn" onClick={() => vscodeApi.postMessage({ type: 'openWorkspaceSettings' })}>Workspace Settings</button>
      <button className="btn" onClick={() => vscodeApi.postMessage({ type: 'openRepositorySettings' })}>Configure this repo</button>
    </div>
    <p>API keys and server tokens are stored securely in VS Code. Existing environment variables and project .env files remain supported.</p>
  </div>;
}
