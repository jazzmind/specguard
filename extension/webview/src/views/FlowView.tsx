import type { ViewModel, NodeState } from '../reducer.js';
import type { PipelineRunInfo } from '../protocol.js';
import { vscodeApi } from '../vscode.js';
import './flow.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function runPipeline(id: string) {
  vscodeApi.postMessage({ type: 'run', pipeline: id });
}

// ---------------------------------------------------------------------------
// StatusChip — shows pass/fail/running/never
// ---------------------------------------------------------------------------

function StatusChip({ state, info }: { state: NodeState; info?: PipelineRunInfo }) {
  if (state === 'running') return <span className="sg-chip sg-chip-running">Running…</span>;
  if (state === 'done') {
    const ago = info ? timeAgo(info.finishedAt) : '';
    return <span className="sg-chip sg-chip-pass">Passed {ago && `· ${ago}`}</span>;
  }
  if (state === 'failed') {
    const ago = info ? timeAgo(info.finishedAt) : '';
    return <span className="sg-chip sg-chip-fail">Failed {ago && `· ${ago}`}</span>;
  }
  if (info) {
    const ago = timeAgo(info.finishedAt);
    const chipClass = info.status === 'pass' ? 'sg-chip-pass' : 'sg-chip-fail';
    return <span className={`sg-chip ${chipClass}`}>{info.status === 'pass' ? 'Passed' : 'Failed'} · {ago}</span>;
  }
  return <span className="sg-chip sg-chip-never">Never run</span>;
}

// ---------------------------------------------------------------------------
// ErrorTail — expandable last few log lines when a pipeline failed
// ---------------------------------------------------------------------------

function ErrorTail({ lines }: { lines: string[] }) {
  const meaningful = lines.filter((l) => l.trim() && !l.startsWith('[skip]'));
  if (meaningful.length === 0) return null;
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ fontSize: 10, color: '#f48771', cursor: 'pointer' }}>Show error</summary>
      <pre className="sg-error-tail">{meaningful.join('\n')}</pre>
    </details>
  );
}

// ---------------------------------------------------------------------------
// PipelineCard — a single horizontal card for one pipeline
// ---------------------------------------------------------------------------

interface PipelineCardProps {
  id: string;
  label: string;
  description: string;
  state: NodeState;
  info?: PipelineRunInfo;
  logs?: string[];
  disabled?: boolean;
  disabledHint?: string;
  destructive?: boolean;
}

function PipelineCard({ id, label, description, state, info, logs, disabled, disabledHint, destructive }: PipelineCardProps) {
  const isFailed = state === 'failed' || info?.status === 'fail';
  const tail = isFailed ? (logs?.filter((l) => l.trim()).slice(-5) ?? info?.tail ?? []) : [];
  return (
    <div className={`sg-wf-card ${isFailed ? 'sg-wf-card-failed' : state === 'done' || info?.status === 'pass' ? 'sg-wf-card-passed' : ''}`}>
      <div className="sg-wf-card-left">
        <span className="sg-wf-card-label">{label}</span>
        <span className="sg-wf-card-desc">{description}</span>
        {isFailed && <ErrorTail lines={tail} />}
      </div>
      <div className="sg-wf-card-right">
        <StatusChip state={state} info={info} />
        {disabled ? (
          <button className="sg-wf-btn sg-wf-btn-disabled" disabled title={disabledHint}>
            {label}
          </button>
        ) : (
          <button
            className={`sg-wf-btn ${destructive ? 'sg-wf-btn-destructive' : ''}`}
            onClick={() => runPipeline(id)}
            disabled={state === 'running'}
            title={destructive ? 'This pipeline calls the LLM and writes files' : undefined}
          >
            {state === 'running' ? 'Running…' : 'Run'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section heading
// ---------------------------------------------------------------------------

function SectionHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="sg-wf-section-head">
      <span className="sg-wf-section-title">{title}</span>
      <span className="sg-wf-section-sub">{sub}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arrow row for bootstrap workflows
// ---------------------------------------------------------------------------

function ArrowFlow({ steps }: { steps: string[] }) {
  return (
    <div className="sg-wf-arrow-flow">
      {steps.map((s, i) => (
        <span key={s}>
          {i > 0 && <span className="sg-wf-arrow">→</span>}
          <span className="sg-wf-arrow-step">{s}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main FlowView
// ---------------------------------------------------------------------------

export function FlowView({ vm }: { vm: ViewModel }) {
  const state = (id: string): NodeState => vm.nodeStates[id] ?? 'idle';
  const info = (id: string) => vm.lastRunInfo[id];
  const logs = (id: string) => vm.logs[id];

  const totalSpecs = vm.coverage.reduce((s, a) => s + a.specCount, 0);
  const hasSpecs = totalSpecs > 0;

  return (
    <div className="sg-wf">

      {/* ── Bootstrap ───────────────────────────────────────────────────── */}
      {!hasSpecs && (
        <div className="sg-wf-section">
          <SectionHeading
            title="Step 1 — Create Specs"
            sub="Run one of these to generate your first Living Specs. Once specs exist this section is hidden."
          />

          <div className="sg-wf-bootstrap">
            <div className="sg-wf-bootstrap-option">
              <ArrowFlow steps={['Source code', 'reverse', 'Specs']} />
              <div style={{ marginTop: 8 }}>
                <PipelineCard
                  id="reverse"
                  label="reverse"
                  description="Reads your source code and generates Living Specs. Best for brownfield projects."
                  state={state('reverse')}
                  info={info('reverse')}
                  logs={logs('reverse')}
                  destructive
                />
              </div>
            </div>
            <div className="sg-wf-bootstrap-sep">or</div>
            <div className="sg-wf-bootstrap-option">
              <ArrowFlow steps={['PRD / Jira / MD', 'import', 'Specs']} />
              <div style={{ marginTop: 8 }}>
                <PipelineCard
                  id="import"
                  label="import"
                  description="Converts a PRD, Jira ticket, or doc into a spec. Requires a source file argument."
                  state="idle"
                  disabled
                  disabledHint="Run from terminal: specguard import <file>"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Main Loop ───────────────────────────────────────────────────── */}
      <div className="sg-wf-section">
        <SectionHeading
          title={hasSpecs ? 'Pipeline Loop' : 'Step 2 — Pipeline Loop'}
          sub="Run these pipelines on your specs. Each one is independent — run in any order."
        />

        <div className="sg-wf-pipeline-grid">
          <PipelineCard id="generate" label="generate" description="Generate test code from specs" state={state('generate')} info={info('generate')} logs={logs('generate')} destructive />
          <PipelineCard id="security" label="security" description="Generate security tests and run SAST analysis" state={state('security')} info={info('security')} logs={logs('security')} destructive />
          <PipelineCard id="validate" label="validate" description="Validate specs against your running app (browser automation)" state={state('validate')} info={info('validate')} logs={logs('validate')} destructive />
          <PipelineCard id="docs" label="docs" description="Generate user-facing documentation from specs" state={state('docs')} info={info('docs')} logs={logs('docs')} destructive />
          <PipelineCard id="drift" label="drift" description="Detect specs that are out of sync with the current source code" state={state('drift')} info={info('drift')} logs={logs('drift')} />
          <PipelineCard id="matrix" label="matrix" description="Build traceability matrix linking specs to tests and docs" state={state('matrix')} info={info('matrix')} logs={logs('matrix')} />
          <PipelineCard id="quality" label="quality" description="Run ESLint and dead-code checks (Knip)" state={state('quality')} info={info('quality')} logs={logs('quality')} />
          <PipelineCard id="deps" label="deps" description="Audit dependencies for vulnerabilities and unused packages" state={state('deps')} info={info('deps')} logs={logs('deps')} />
        </div>
      </div>

      {/* ── Finalise ────────────────────────────────────────────────────── */}
      <div className="sg-wf-section">
        <SectionHeading
          title="Finalise"
          sub="Heal failing tests, then commit all SpecGuard-generated files."
        />
        <div className="sg-wf-pipeline-grid">
          <PipelineCard id="heal" label="heal" description="Self-heal failing generated tests with LLM assistance" state={state('heal')} info={info('heal')} logs={logs('heal')} destructive />
          <PipelineCard id="commit" label="commit" description="Stage and commit all SpecGuard-generated files" state={state('commit')} info={info('commit')} logs={logs('commit')} destructive />
        </div>
      </div>

    </div>
  );
}
