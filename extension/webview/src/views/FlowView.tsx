import { PIPELINE_NODES } from '../protocol.js';
import type { ViewModel, NodeState } from '../reducer.js';
import { vscodeApi } from '../vscode.js';
import './flow.css';

const COLUMN: Record<string, number> = {
  'docs-in': 0, code: 0, import: 1, reverse: 1, specs: 2,
  generate: 3, security: 3, validate: 3, docs: 3, drift: 3, matrix: 3,
  tests: 4, 'user-docs': 4, traceability: 4, heal: 5,
};

export function FlowView({ vm }: { vm: ViewModel }) {
  const stateOf = (id: string): NodeState => vm.nodeStates[id] ?? 'idle';
  const cols = [...new Set(Object.values(COLUMN))].sort((a, b) => a - b);
  return (
    <div className="sg-flow">
      {cols.map((c) => (
        <div className="sg-col" key={c}>
          {PIPELINE_NODES.filter((n) => COLUMN[n.id] === c).map((n) => (
            <div
              key={n.id}
              className={`sg-node sg-${n.kind} sg-${stateOf(n.id)}`}
              onClick={() => n.kind === 'pipeline' && vscodeApi.postMessage({ type: 'run', pipeline: n.id })}
              title={n.kind === 'pipeline' ? `Run ${n.label}` : n.label}
            >
              <span className="sg-node-label">{n.label}</span>
              {n.kind === 'pipeline' && vm.logs[n.id]?.length ? (
                <span className="sg-node-badge">{vm.logs[n.id].length}</span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
