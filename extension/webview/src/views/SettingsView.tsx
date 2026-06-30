import { useEffect, useState } from 'react';
import type { ViewModel } from '../reducer.js';
import type { ProjectConfig } from '../protocol.js';
import { vscodeApi } from '../vscode.js';

type Provider = 'anthropic' | 'openai' | 'litellm';

const PROVIDER_DEFAULTS: Record<Provider, { model: string; apiKeyEnv: string; baseUrl?: string; label: string }> = {
  anthropic: { model: 'claude-sonnet-4-6', apiKeyEnv: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)' },
  openai: { model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY', label: 'OpenAI' },
  litellm: { model: 'gpt-4', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'http://localhost:4000', label: 'LiteLLM (local / custom)' },
};

const VSCODE_SETTINGS = [
  { key: 'specguard.cliPath', label: 'CLI Path', description: 'Path to the specguard CLI binary (leave empty for auto-detect)' },
  { key: 'specguard.autoRefresh', label: 'Auto Refresh', description: 'Automatically refresh coverage when spec files change' },
  { key: 'specguard.showStatusBar', label: 'Show Status Bar', description: 'Show spec coverage in the VS Code status bar' },
  { key: 'specguard.autoDocs', label: 'Auto Docs', description: 'Auto-generate documentation when specs change (debounced 3s)' },
];

export function SettingsView({ vm }: { vm: ViewModel }) {
  const cfg = vm.projectConfig;

  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(PROVIDER_DEFAULTS.anthropic.model);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:4000');
  const [saved, setSaved] = useState(false);

  // Sync form from incoming config
  useEffect(() => {
    if (!cfg?.configFound) return;
    const p = cfg.llm.provider as Provider;
    setProvider(p);
    setModel(cfg.llm.model);
    setApiKeyValue(cfg.envVars[cfg.llm.apiKeyEnv] ?? '');
    setBaseUrl(cfg.llm.baseUrl ?? PROVIDER_DEFAULTS[p]?.baseUrl ?? '');
  }, [cfg]);

  // Request current config from host on mount
  useEffect(() => {
    vscodeApi.postMessage({ type: 'readProjectConfig' });
  }, []);

  const handleProviderChange = (p: Provider) => {
    const defaults = PROVIDER_DEFAULTS[p];
    setProvider(p);
    setModel(defaults.model);
    setBaseUrl(defaults.baseUrl ?? '');
    setApiKeyValue('');
  };

  const handleSave = () => {
    const defaults = PROVIDER_DEFAULTS[provider];
    const newConfig: ProjectConfig = {
      llm: {
        provider,
        model,
        apiKeyEnv: defaults.apiKeyEnv,
        ...(provider === 'litellm' && baseUrl ? { baseUrl } : {}),
      },
      envVars: { [defaults.apiKeyEnv]: apiKeyValue },
      hasApiKey: false,
      configFound: true,
    };
    vscodeApi.postMessage({ type: 'saveProjectConfig', config: newConfig });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--vscode-input-background, #3c3c3c)',
    border: '1px solid var(--vscode-input-border, #555)',
    borderRadius: 4,
    color: 'var(--vscode-input-foreground, #ccc)',
    fontSize: 12,
    padding: '5px 8px',
    width: '100%',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: 'var(--vscode-descriptionForeground, #aaa)',
    marginBottom: 4,
    display: 'block',
  };

  const sectionHeader = (title: string) => (
    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: '#666', marginBottom: 10 }}>
      {title}
    </div>
  );

  const apiKeyEnv = PROVIDER_DEFAULTS[provider].apiKeyEnv;
  const keyIsSet = apiKeyValue === '***';

  return (
    <div style={{ padding: 16 }}>

      {/* LLM Configuration */}
      <div style={{ marginBottom: 24 }}>
        {sectionHeader('LLM Configuration')}

        {!cfg?.configFound ? (
          <div style={{ fontSize: 12, color: '#888', background: '#1a1d20', border: '1px solid #333', borderRadius: 6, padding: '12px 14px' }}>
            Initialize SpecGuard first (Overview tab) to configure LLM settings.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Provider */}
            <div>
              <label style={labelStyle}>Provider</label>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value as Provider)}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                {(Object.entries(PROVIDER_DEFAULTS) as [Provider, typeof PROVIDER_DEFAULTS[Provider]][]).map(([id, d]) => (
                  <option key={id} value={id}>{d.label}</option>
                ))}
              </select>
            </div>

            {/* Model */}
            <div>
              <label style={labelStyle}>Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={inputStyle}
                placeholder={PROVIDER_DEFAULTS[provider].model}
              />
            </div>

            {/* API Key */}
            <div>
              <label style={labelStyle}>
                API Key
                <span style={{ marginLeft: 6, color: '#555', fontWeight: 400 }}>
                  saved to .specguard/.env as <code style={{ fontSize: 10, background: '#1e1e1e', padding: '1px 4px', borderRadius: 3 }}>{apiKeyEnv}</code>
                </span>
              </label>
              <input
                type="password"
                value={keyIsSet ? '' : apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                placeholder={keyIsSet ? '(key already set — type to replace)' : provider === 'anthropic' ? 'sk-ant-...' : provider === 'openai' ? 'sk-...' : 'enter key or leave blank for local'}
                style={inputStyle}
              />
            </div>

            {/* URL — litellm (required) or openai (optional, for Azure/proxy) */}
            {(provider === 'litellm' || provider === 'openai') && (
              <div>
                <label style={labelStyle}>
                  {provider === 'litellm' ? 'Base URL' : 'Base URL'}
                  {provider === 'openai' && <span style={{ marginLeft: 6, color: '#555', fontWeight: 400 }}>optional — leave blank for api.openai.com</span>}
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  style={inputStyle}
                  placeholder={provider === 'litellm' ? 'http://localhost:4000' : 'https://api.openai.com/v1'}
                />
                {provider === 'litellm' && (
                  <span style={{ fontSize: 10, color: '#555', marginTop: 4, display: 'block' }}>
                    Saved as LITELLM_BASE_URL in .specguard/.env
                  </span>
                )}
              </div>
            )}

            <button
              onClick={handleSave}
              style={{
                padding: '6px 18px',
                background: saved ? '#4ec9b0' : 'var(--vscode-button-background, #0e639c)',
                color: 'var(--vscode-button-foreground, #fff)',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
                transition: 'background 0.3s', alignSelf: 'flex-start',
              }}
            >
              {saved ? 'Saved!' : 'Save Settings'}
            </button>
          </div>
        )}
      </div>

      {/* VS Code Extension Settings */}
      <div>
        {sectionHeader('VS Code Extension Settings')}
        <div style={{ marginBottom: 8, fontSize: 12, color: '#888', lineHeight: 1.5 }}>
          Click a setting to open it in VS Code settings.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {VSCODE_SETTINGS.map((s) => (
            <button
              key={s.key}
              onClick={() => vscodeApi.postMessage({ type: 'openSettings' })}
              style={{
                background: 'var(--vscode-editor-background)',
                border: '1px solid var(--vscode-panel-border)',
                borderRadius: 6, padding: '10px 14px', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left',
                color: 'inherit', width: '100%',
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--vscode-foreground)' }}>{s.label}</span>
              <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{s.description}</span>
              <code style={{ fontSize: 10, color: '#555', background: '#1e1e1e', padding: '1px 5px', borderRadius: 3, alignSelf: 'flex-start', marginTop: 2 }}>
                {s.key}
              </code>
            </button>
          ))}
        </div>
        <button
          onClick={() => vscodeApi.postMessage({ type: 'openSettings' })}
          style={{
            marginTop: 10, padding: '6px 14px',
            background: 'var(--vscode-button-background, #0e639c)',
            color: 'var(--vscode-button-foreground, #fff)',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
          }}
        >
          Open All SpecGuard Settings
        </button>
      </div>
    </div>
  );
}
