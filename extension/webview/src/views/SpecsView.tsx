import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

const open = (p: string) => vscodeApi.postMessage({ type: 'openFile', path: p });

/** Derive a human-readable label from a spec file path. */
function labelFromPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const file = parts[parts.length - 1].replace(/\.md$/i, '');
  return file
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Derive an app/group name from the spec directory. */
function groupFromPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  // specs/{group}/file.md -> group
  const idx = parts.indexOf('specs');
  if (idx >= 0 && idx + 2 < parts.length) return parts[idx + 1];
  return 'root';
}

export function SpecsView({ vm }: { vm: ViewModel }) {
  const specs = vm.artifacts.filter((a) => a.kind === 'spec');

  if (specs.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ marginBottom: 12, color: 'var(--vscode-descriptionForeground)' }}>
          No Living Specs found. Run the <strong>reverse</strong> pipeline to generate specs from source code,
          or <strong>import</strong> to create specs from a PRD or Jira ticket.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'reverse' })}
            style={{
              padding: '5px 12px', background: 'var(--vscode-button-background, #0e639c)',
              color: 'var(--vscode-button-foreground, #fff)', border: 'none', borderRadius: 4,
              cursor: 'pointer', fontSize: 11,
            }}
          >
            Run reverse
          </button>
          <button
            onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'import' })}
            style={{
              padding: '5px 12px', background: 'none', color: 'var(--vscode-foreground, #ccc)',
              border: '1px solid #555', borderRadius: 4, cursor: 'pointer', fontSize: 11,
            }}
          >
            Run import
          </button>
        </div>
      </div>
    );
  }

  // Group specs by directory under specs/
  const groups = new Map<string, typeof specs>();
  for (const s of specs) {
    const key = groupFromPath(s.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: '#888' }}>
          {specs.length} Living Spec{specs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {Array.from(groups.entries()).map(([group, items]) => (
        <section key={group} style={{ marginBottom: 18 }}>
          <h4 style={{
            margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: 'var(--vscode-descriptionForeground)',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            borderBottom: '1px solid var(--vscode-panel-border)', paddingBottom: 4,
          }}>
            {group === 'root' ? 'Specs' : group}
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {items.map((s) => {
              const title = s.title ?? labelFromPath(s.path);
              return (
                <div
                  key={s.path}
                  onClick={() => open(s.path)}
                  style={{
                    background: 'var(--vscode-editor-background)',
                    border: '1px solid var(--vscode-panel-border)',
                    borderRadius: 4, padding: '8px 12px', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', gap: 2,
                  }}
                  title={s.path}
                >
                  <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--vscode-foreground)' }}>
                    {title}
                  </span>
                  {s.description && (
                    <span style={{
                      fontSize: 11, color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4,
                    }}>
                      {s.description}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--vscode-textLink-foreground)' }}>
                    {s.path}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
