import { vscodeApi } from '../vscode.js';

const SETTINGS = [
  { key: 'specguard.cliPath', label: 'CLI Path', description: 'Path to the specguard CLI binary (leave empty for auto-detect)' },
  { key: 'specguard.autoRefresh', label: 'Auto Refresh', description: 'Automatically refresh coverage when spec files change' },
  { key: 'specguard.showStatusBar', label: 'Show Status Bar', description: 'Show spec coverage in the VS Code status bar' },
  { key: 'specguard.autoDocs', label: 'Auto Docs', description: 'Auto-generate documentation when specs change (debounced 3s)' },
];

export function SettingsView() {
  const handleOpenSettings = () => vscodeApi.postMessage({ type: 'openSettings' });

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 600, color: 'var(--vscode-foreground, #eee)' }}>
        SpecGuard Settings
      </h3>

      <div style={{ marginBottom: 16, fontSize: 12, color: '#888', lineHeight: 1.5 }}>
        Configure SpecGuard behavior. Click a setting to open it in VS Code settings where you can edit the value.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {SETTINGS.map((s) => (
          <button
            key={s.key}
            onClick={handleOpenSettings}
            style={{
              background: 'var(--vscode-editor-background)',
              border: '1px solid var(--vscode-panel-border)',
              borderRadius: 6, padding: '10px 14px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left',
              color: 'inherit', width: '100%',
            }}
            title={`Open ${s.label} in VS Code settings`}
          >
            <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--vscode-foreground)' }}>
              {s.label}
            </span>
            <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>
              {s.description}
            </span>
            <code style={{
              fontSize: 10, color: '#555', background: '#1e1e1e',
              padding: '1px 5px', borderRadius: 3, alignSelf: 'flex-start', marginTop: 2,
            }}>
              {s.key}
            </code>
          </button>
        ))}
      </div>

      <button
        onClick={handleOpenSettings}
        style={{
          marginTop: 16, padding: '6px 14px',
          background: 'var(--vscode-button-background, #0e639c)',
          color: 'var(--vscode-button-foreground, #fff)',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
        }}
      >
        Open All SpecGuard Settings
      </button>
    </div>
  );
}
