import { useState, useRef, useEffect } from 'react';
import type { ViewModel, NodeState } from '../reducer.js';
import type { PipelineRunInfo, AnalysisRecommendation, FixPlan, FixPlanStep } from '../protocol.js';
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

function cancelPipeline(id: string) {
  vscodeApi.postMessage({ type: 'cancel', pipeline: id });
}

// ---------------------------------------------------------------------------
// StatusChip
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
// LiveLogPanel — auto-scrolling log pane shown when a pipeline is selected
// ---------------------------------------------------------------------------

function LiveLogPanel({ pipeline, lines, isRunning }: { pipeline: string; lines: string[]; isRunning: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  return (
    <div className="sg-log-panel">
      <div className="sg-log-panel-header">
        <span className="sg-log-panel-title">{pipeline} logs</span>
        {isRunning && <span className="sg-chip sg-chip-running" style={{ fontSize: 9, padding: '1px 6px' }}>Live</span>}
      </div>
      <pre ref={ref} className="sg-log-panel-body">
        {lines.length > 0 ? lines.join('\n') : '(no output yet)'}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PipelineCard
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
  selectedLog: string | null;
  onSelectLog: (id: string | null) => void;
  /** Show a "Fix" quick-action button after failure for heal-able pipelines */
  healable?: boolean;
}

function PipelineCard({
  id, label, description, state, info, logs, disabled, disabledHint, destructive,
  selectedLog, onSelectLog, healable,
}: PipelineCardProps) {
  const isFailed = state === 'failed' || info?.status === 'fail';
  const isRunning = state === 'running';
  const tail = isFailed ? (logs?.filter((l) => l.trim()).slice(-5) ?? info?.tail ?? []) : [];
  const logOpen = selectedLog === id;

  return (
    <div className={`sg-wf-card ${isFailed ? 'sg-wf-card-failed' : state === 'done' || info?.status === 'pass' ? 'sg-wf-card-passed' : ''}`}>
      <div className="sg-wf-card-left">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="sg-wf-card-label">{label}</span>
          <button
            className="sg-log-toggle"
            onClick={() => onSelectLog(logOpen ? null : id)}
            title={logOpen ? 'Hide logs' : 'Show logs'}
          >
            {logOpen ? '▲ logs' : '▼ logs'}
          </button>
        </div>
        <span className="sg-wf-card-desc">{description}</span>
        {isFailed && <ErrorTail lines={tail} />}
        {logOpen && (
          <LiveLogPanel pipeline={id} lines={logs ?? []} isRunning={isRunning} />
        )}
      </div>
      <div className="sg-wf-card-right">
        <StatusChip state={state} info={info} />
        {disabled ? (
          <button className="sg-wf-btn sg-wf-btn-disabled" disabled title={disabledHint}>
            {label}
          </button>
        ) : isRunning ? (
          <button className="sg-wf-btn sg-wf-btn-cancel" onClick={() => cancelPipeline(id)}>
            Cancel
          </button>
        ) : (
          <>
            <button
              className={`sg-wf-btn ${destructive ? 'sg-wf-btn-destructive' : ''}`}
              onClick={() => runPipeline(id)}
              title={destructive ? 'This pipeline calls the LLM and writes files' : undefined}
            >
              Run
            </button>
            {healable && isFailed && (
              <button className="sg-wf-btn sg-wf-btn-fix" onClick={() => runPipeline('heal')} title="Auto-fix with heal">
                Fix
              </button>
            )}
          </>
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
// AnalyzePanel — shows recommendations after analyze runs
// ---------------------------------------------------------------------------

function AnalyzePanel({ recommendations, onRunSelected }: {
  recommendations: AnalysisRecommendation[];
  onRunSelected: (pipelines: string[]) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(recommendations.map((r) => r.pipeline)));

  if (recommendations.length === 0) return null;

  const toggle = (pipeline: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(pipeline)) next.delete(pipeline); else next.add(pipeline);
      return next;
    });
  };

  const priorityColor: Record<string, string> = { high: '#f48771', medium: '#e2c08d', low: '#888' };

  return (
    <div className="sg-analyze-panel">
      <div className="sg-analyze-header">
        <span className="sg-analyze-title">Analysis Results</span>
        <span className="sg-analyze-sub">{recommendations.length} recommendations — select which to run</span>
      </div>
      {recommendations.map((r) => (
        <label key={r.pipeline} className="sg-analyze-row">
          <input
            type="checkbox"
            checked={checked.has(r.pipeline)}
            onChange={() => toggle(r.pipeline)}
          />
          <span className="sg-analyze-pipeline">{r.pipeline}</span>
          <span className="sg-analyze-priority" style={{ color: priorityColor[r.priority] ?? '#888' }}>
            {r.priority}
          </span>
          <span className="sg-analyze-reason">{r.reason}</span>
        </label>
      ))}
      <button
        className="sg-wf-btn sg-wf-btn-destructive"
        style={{ marginTop: 8 }}
        disabled={checked.size === 0}
        onClick={() => onRunSelected([...checked])}
      >
        Run selected ({checked.size})
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FixPlanPanel — shows a pending fix plan for human approval
// ---------------------------------------------------------------------------

function FixPlanPanel({ plan, onApprove, onReject }: {
  plan: FixPlan;
  onApprove: () => void;
  onReject: () => void;
}) {
  const actionLabel: Record<FixPlanStep['action'], string> = {
    'run-pipeline': '▶ pipeline',
    'edit-file': '✎ file',
    'run-command': '$ command',
  };

  return (
    <div className="sg-fix-plan">
      <div className="sg-fix-plan-header">
        <span className="sg-fix-plan-title">{plan.title}</span>
        <span className="sg-fix-plan-src">from: {plan.sourcePipeline}</span>
      </div>
      <p className="sg-fix-plan-summary">{plan.summary}</p>
      <ol className="sg-fix-plan-steps">
        {plan.steps.map((s) => (
          <li key={s.id} className="sg-fix-plan-step">
            <span className="sg-fix-plan-action-badge">{actionLabel[s.action]}</span>
            <span>{s.description}</span>
            {s.file && <code className="sg-fix-plan-code">{s.file}</code>}
            {s.pipeline && <code className="sg-fix-plan-code">{s.pipeline}</code>}
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="sg-wf-btn sg-wf-btn-destructive" onClick={onApprove}>Approve & Execute</button>
        <button className="sg-wf-btn" onClick={onReject}>Reject</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main FlowView
// ---------------------------------------------------------------------------

export function FlowView({ vm, dispatch }: { vm: ViewModel; dispatch: (e: unknown) => void }) {
  const [selectedLog, setSelectedLog] = useState<string | null>(null);

  const state = (id: string): NodeState => vm.nodeStates[id] ?? 'idle';
  const info = (id: string) => vm.lastRunInfo[id];
  const logs = (id: string) => vm.logs[id];

  const totalSpecs = vm.coverage.reduce((s, a) => s + a.specCount, 0);
  const hasSpecs = totalSpecs > 0;

  const analyzeRunning = state('analyze') === 'running';
  const hasRecommendations = vm.analysisRecommendations.length > 0;

  const handleRunSequence = (pipelines: string[]) => {
    vscodeApi.postMessage({ type: 'runSequence', pipelines });
  };

  const handleApproveFix = () => {
    if (!vm.pendingFixPlan) return;
    const pipelineSteps = vm.pendingFixPlan.steps
      .filter((s) => s.action === 'run-pipeline' && s.pipeline)
      .map((s) => s.pipeline as string);
    vscodeApi.postMessage({ type: 'runSequence', pipelines: pipelineSteps });
    // Clear the fix plan from the UI
    dispatch({ type: 'fix-plan', plan: null });
  };

  const handleRejectFix = () => {
    dispatch({ type: 'fix-plan', plan: null });
  };

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
                  selectedLog={selectedLog}
                  onSelectLog={setSelectedLog}
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
                  description="Converts a PRD, Jira ticket, or doc into a spec. Click Run to pick a file."
                  state="idle"
                  selectedLog={selectedLog}
                  onSelectLog={setSelectedLog}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Fix Plan Approval ────────────────────────────────────────────── */}
      {vm.pendingFixPlan && (
        <div className="sg-wf-section">
          <SectionHeading title="Fix Plan — Pending Approval" sub="Review and approve or reject the proposed fixes." />
          <FixPlanPanel plan={vm.pendingFixPlan} onApprove={handleApproveFix} onReject={handleRejectFix} />
        </div>
      )}

      {/* ── Main Loop ───────────────────────────────────────────────────── */}
      <div className="sg-wf-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #2a2a2a' }}>
          <div style={{ flex: 1 }}>
            <div className="sg-wf-section-title" style={{ marginBottom: 2 }}>
              {hasSpecs ? 'Pipeline Loop' : 'Step 2 — Pipeline Loop'}
            </div>
            <div className="sg-wf-section-sub">
              Run these pipelines on your specs. Each one is independent — run in any order.
            </div>
          </div>
          <button
            className={`sg-wf-btn ${analyzeRunning ? 'sg-wf-btn-disabled' : ''}`}
            style={{ flexShrink: 0, fontWeight: 600 }}
            onClick={() => runPipeline('analyze')}
            disabled={analyzeRunning}
            title="Analyze workspace and get pipeline recommendations"
          >
            {analyzeRunning ? 'Analyzing…' : '⚡ Analyze'}
          </button>
        </div>

        {/* Analyze results panel */}
        {hasRecommendations && (
          <AnalyzePanel
            recommendations={vm.analysisRecommendations}
            onRunSelected={handleRunSequence}
          />
        )}

        <div className="sg-wf-pipeline-grid">
          <PipelineCard id="generate" label="generate" description="Generate test code from specs" state={state('generate')} info={info('generate')} logs={logs('generate')} destructive selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="security" label="security" description="Generate security tests and run SAST analysis" state={state('security')} info={info('security')} logs={logs('security')} destructive selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="validate" label="validate" description="Validate specs against your running app (browser automation)" state={state('validate')} info={info('validate')} logs={logs('validate')} destructive healable selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="docs" label="docs" description="Generate user-facing documentation from specs" state={state('docs')} info={info('docs')} logs={logs('docs')} destructive selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="drift" label="drift" description="Detect specs that are out of sync with the current source code" state={state('drift')} info={info('drift')} logs={logs('drift')} selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="matrix" label="matrix" description="Build traceability matrix linking specs to tests and docs" state={state('matrix')} info={info('matrix')} logs={logs('matrix')} selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="quality" label="quality" description="Run ESLint and dead-code checks (Knip)" state={state('quality')} info={info('quality')} logs={logs('quality')} selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="deps" label="deps" description="Audit dependencies for vulnerabilities and unused packages" state={state('deps')} info={info('deps')} logs={logs('deps')} selectedLog={selectedLog} onSelectLog={setSelectedLog} />
        </div>
      </div>

      {/* ── Finalise ────────────────────────────────────────────────────── */}
      <div className="sg-wf-section">
        <SectionHeading
          title="Finalise"
          sub="Heal failing tests, then commit all SpecGuard-generated files."
        />
        <div className="sg-wf-pipeline-grid">
          <PipelineCard id="heal" label="heal" description="Self-heal failing generated tests with LLM assistance" state={state('heal')} info={info('heal')} logs={logs('heal')} destructive selectedLog={selectedLog} onSelectLog={setSelectedLog} />
          <PipelineCard id="commit" label="commit" description="Stage and commit all SpecGuard-generated files" state={state('commit')} info={info('commit')} logs={logs('commit')} destructive selectedLog={selectedLog} onSelectLog={setSelectedLog} />
        </div>
      </div>

    </div>
  );
}
