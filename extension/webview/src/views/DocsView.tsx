import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

const open = (p: string) => vscodeApi.postMessage({ type: 'openFile', path: p });
const runDocs = () => vscodeApi.postMessage({ type: 'run', pipeline: 'docs' });

/** Derive a human-readable label from a file path when no title is present. */
function labelFromPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const file = parts[parts.length - 1].replace(/\.md$/i, '');
  return file
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function DocsView({ vm }: { vm: ViewModel }) {
  const docs = vm.artifacts
    .filter((a) => a.kind === 'doc')
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  if (docs.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ marginBottom: 12, color: 'var(--vscode-descriptionForeground)' }}>
          No generated docs yet. Run the <strong>docs</strong> pipeline to create user-facing documentation from your Living Specs.
        </p>
        <button onClick={runDocs}>Run docs</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>Generated docs ({docs.length})</h3>
        <button onClick={runDocs} style={{ fontSize: 11 }}>Re-run docs</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {docs.map((d) => {
          const title = d.title ?? labelFromPath(d.path);
          const desc = d.description;
          return (
            <div
              key={d.path}
              onClick={() => open(d.path)}
              style={{
                background: 'var(--vscode-editor-background)',
                border: '1px solid var(--vscode-panel-border)',
                borderRadius: 4,
                padding: '10px 12px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
              title={d.path}
            >
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--vscode-foreground)' }}>
                {title}
              </span>

              {desc && (
                <span style={{
                  fontSize: 11,
                  color: 'var(--vscode-descriptionForeground)',
                  lineHeight: 1.45,
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>
                  {desc}
                </span>
              )}

              <span style={{ fontSize: 10, color: 'var(--vscode-textLink-foreground)', marginTop: 4 }}>
                {d.path}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
