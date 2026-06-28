import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

export function MatrixView({ vm }: { vm: ViewModel }) {
  const m = vm.matrix;

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--vscode-foreground, #eee)' }}>
        Traceability Matrix
      </h2>
      <p style={{ margin: '0 0 12px', fontSize: 11, color: '#888', lineHeight: 1.5 }}>
        Maps each Living Spec to its source module, generated tests, and documentation.
        A spec with no tests (<span style={{ color: '#f48771' }}>—</span>) means{' '}
        <code style={{ background: '#333', padding: '0 3px', borderRadius: 3, fontSize: 10 }}>specguard generate --all</code>{' '}
        has not been run yet. Run <strong>matrix</strong> from the Pipelines tab to refresh.
      </p>

      {(!m || m.rows.length === 0) ? (
        <div style={{ marginTop: 8 }}>
          <p style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>
            No traceability data yet. Run the <strong>matrix</strong> pipeline to generate it.
          </p>
          <button
            onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'matrix' })}
            style={{
              padding: '6px 14px',
              background: 'var(--vscode-button-background, #0e639c)',
              color: 'var(--vscode-button-foreground, #fff)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Run matrix
          </button>
        </div>
      ) : (
        <div>
          <div style={{ marginBottom: 8, fontSize: 11, color: '#666' }}>
            Generated {m.generatedAt ?? '—'} &nbsp;·&nbsp; {m.rows.length} spec{m.rows.length !== 1 ? 's' : ''}
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #444' }}>
                <th align="left" style={{ padding: '6px 8px 6px 0', color: '#aaa', fontWeight: 600 }}>Spec</th>
                <th align="left" style={{ padding: '6px 8px', color: '#aaa', fontWeight: 600 }}>Source module</th>
                <th align="center" style={{ padding: '6px 8px', color: '#aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>Tests</th>
                <th align="center" style={{ padding: '6px 8px', color: '#aaa', fontWeight: 600 }}>Docs</th>
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={`${r.appName}/${r.specKey}`} style={{ borderTop: '1px solid #2a2a2a' }}>
                  <td style={{ padding: '7px 8px 7px 0' }}>
                    <button
                      onClick={() => vscodeApi.postMessage({ type: 'openFile', path: r.sourceModule })}
                      style={{
                        background: 'none', border: 'none', color: 'var(--vscode-textLink-foreground, #4fc3f7)',
                        cursor: 'pointer', padding: 0, fontSize: 12, textAlign: 'left',
                        textDecoration: 'underline',
                      }}
                      title={`Open source: ${r.sourceModule}`}
                    >
                      {r.title}
                    </button>
                  </td>
                  <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 11, color: '#888' }}>
                    {r.sourceModule || '—'}
                  </td>
                  <td align="center" style={{ padding: '7px 8px', color: r.hasTests ? '#4ec9b0' : '#f48771', fontWeight: 600 }}>
                    {r.hasTests ? `✓ ${r.testCount}` : '—'}
                  </td>
                  <td align="center" style={{ padding: '7px 8px', color: r.hasDocs ? '#4ec9b0' : '#666', fontWeight: 600 }}>
                    {r.hasDocs ? '✓' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button
              onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'matrix' })}
              style={{
                padding: '5px 12px',
                background: 'none',
                color: 'var(--vscode-foreground, #ccc)',
                border: '1px solid #444',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Refresh matrix
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
