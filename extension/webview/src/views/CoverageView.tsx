import type { ViewModel } from '../reducer.js';
import type { AppCoverage } from '../protocol.js';

function DonutChart({ pct }: { pct: number }) {
  const r = 28;
  const circ = 2 * Math.PI * r;
  const arc = circ * (pct / 100);
  const color = pct >= 80 ? '#81c784' : pct >= 50 ? '#ffd54f' : '#e57373';
  return (
    <svg width={72} height={72} viewBox="0 0 72 72">
      <circle cx={36} cy={36} r={r} fill="none" stroke="#333" strokeWidth={8} />
      <circle
        cx={36} cy={36} r={r} fill="none" stroke={color} strokeWidth={8}
        strokeDasharray={`${arc} ${circ - arc}`}
        strokeLinecap="round"
        transform="rotate(-90 36 36)"
      />
      <text x={36} y={40} textAnchor="middle" fill={color} fontSize={13} fontWeight="bold">{Math.round(pct)}%</text>
    </svg>
  );
}

function AppCard({ app }: { app: AppCoverage }) {
  const specPct = app.sourceCount > 0 ? (app.specCount / app.sourceCount) * 100 : 0;
  const testPct = app.specCount > 0 ? (app.testCount / app.specCount) * 100 : 0;
  const missing = app.items.filter((i) => !i.hasSpec);

  return (
    <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 6, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <DonutChart pct={app.percentage} />
          <div style={{ fontSize: 10, color: '#666', textAlign: 'center', marginTop: 2 }}>overall</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, color: '#e0e0e0', marginBottom: 4 }}>{app.name}</div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 2 }}>
            {app.specCount} specs / {app.sourceCount} source files
          </div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
            {app.testCount} tests
          </div>
          {/* Mini bar charts */}
          <div style={{ fontSize: 11, color: '#666', marginBottom: 2 }}>Spec coverage</div>
          <div style={{ height: 6, background: '#333', borderRadius: 3, marginBottom: 6 }}>
            <div style={{ height: '100%', width: `${Math.min(specPct, 100)}%`, background: specPct >= 80 ? '#81c784' : '#ffd54f', borderRadius: 3, transition: 'width .3s' }} />
          </div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 2 }}>Test coverage</div>
          <div style={{ height: 6, background: '#333', borderRadius: 3 }}>
            <div style={{ height: '100%', width: `${Math.min(testPct, 100)}%`, background: testPct >= 80 ? '#81c784' : '#ffd54f', borderRadius: 3, transition: 'width .3s' }} />
          </div>
        </div>
      </div>
      {missing.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 11, color: '#e57373', cursor: 'pointer' }}>
            {missing.length} source file{missing.length !== 1 ? 's' : ''} missing specs
          </summary>
          <ul style={{ margin: '4px 0 0 12px', padding: 0, fontSize: 11, color: '#888' }}>
            {missing.slice(0, 10).map((i) => <li key={i.key} style={{ marginBottom: 2 }}>{i.key}</li>)}
            {missing.length > 10 && <li style={{ color: '#555' }}>…and {missing.length - 10} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

export function CoverageView({ vm }: { vm: ViewModel }) {
  if (vm.coverage.length === 0) {
    return (
      <div style={{ padding: 16, color: '#555', fontStyle: 'italic', fontSize: 13 }}>
        No coverage data yet. Run <code>status</code> to populate.
      </div>
    );
  }

  const overall = vm.coverage.reduce((sum, a) => sum + a.percentage, 0) / vm.coverage.length;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <DonutChart pct={overall} />
        <div>
          <div style={{ fontWeight: 600, color: '#e0e0e0', fontSize: 14 }}>Overall Coverage</div>
          <div style={{ fontSize: 12, color: '#888' }}>{vm.coverage.length} app{vm.coverage.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      {vm.coverage.map((a) => <AppCard key={a.name} app={a} />)}
    </div>
  );
}
