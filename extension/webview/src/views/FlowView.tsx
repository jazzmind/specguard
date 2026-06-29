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

function runPipeline(id: string, args?: string[]) {
  vscodeApi.postMessage({ type: 'run', pipeline: id, args });
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
  /** Glow/pulse when triggered from an Analyze batch run */
  highlighted?: boolean;
  /** Show inline Heal button after failure (pipelines that produce tests) */
  canHeal?: boolean;
  /** Show inline Commit button after success */
  canCommit?: boolean;
}

function PipelineCard({
  id, label, description, state, info, logs, disabled, disabledHint, destructive,
  selectedLog, onSelectLog, highlighted, canHeal, canCommit,
}: PipelineCardProps) {
  const isFailed = state === 'failed' || (state === 'idle' && info?.status === 'fail');
  const isRunning = state === 'running';
  const isDone = state === 'done' || (state === 'idle' && info?.status === 'pass');
  const hasRun = state !== 'idle' || info !== undefined;
  const tail = isFailed ? (logs?.filter((l) => l.trim()).slice(-5) ?? info?.tail ?? []) : [];
  const logOpen = selectedLog === id;

  const handlePlan = () => {
    const issuesSummary = tail.filter(Boolean).join('; ') || `${id} pipeline failed — see logs for details`;
    runPipeline('plan-fix', ['--pipeline', id, '--issues', issuesSummary]);
  };

  return (
    <div
      id={`sg-card-${id}`}
      className={[
        'sg-wf-card',
        isFailed ? 'sg-wf-card-failed' : isDone ? 'sg-wf-card-passed' : '',
        highlighted ? 'sg-wf-card-highlighted' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="sg-wf-card-left">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="sg-wf-card-label">{label}</span>
          <button
            className="sg-log-toggle"
            onClick={() => onSelectLog(logOpen ? null : id)}
            title={logOpen ? 'Hide logs' : 'Show logs'}
          >
            {logOpen ? '▲ logs' : (
              <>
                ▼ logs
                {(logs?.length ?? 0) > 0 && (
                  <span style={{ marginLeft: 4, fontSize: 9, color: isRunning ? '#4fc3f7' : '#888' }}>
                    ({logs!.length})
                  </span>
                )}
              </>
            )}
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
          <div className="sg-card-actions">
            <button
              className={`sg-wf-btn ${destructive ? 'sg-wf-btn-destructive' : ''}`}
              onClick={() => runPipeline(id)}
              title={destructive ? 'This pipeline calls the LLM and writes files' : undefined}
            >
              {hasRun ? 'Re-run' : 'Run'}
            </button>

            {/* Post-run actions */}
            {isFailed && (
              <button
                className="sg-wf-btn sg-wf-btn-plan"
                onClick={handlePlan}
                title="Generate an agent-consumable fix plan for these failures"
              >
                Plan
              </button>
            )}
            {isFailed && canHeal && (
              <button
                className="sg-wf-btn sg-wf-btn-fix"
                onClick={() => runPipeline('heal')}
                title="Auto-heal failing tests with LLM assistance"
              >
                Heal
              </button>
            )}
            {isDone && canCommit && (
              <button
                className="sg-wf-btn sg-wf-btn-commit"
                onClick={() => runPipeline('commit', ['--pipeline', id])}
                title={`Commit output from ${id} — specguard(${id}): ...`}
              >
                Commit
              </button>
            )}
          </div>
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

function AnalyzePanel({ recommendations, nodeStates, lastRunInfo, onRunSelected, onScrollTo }: {
  recommendations: AnalysisRecommendation[];
  nodeStates: Record<string, NodeState>;
  lastRunInfo: Record<string, import('../reducer.js').ViewModel['lastRunInfo'][string]>;
  onRunSelected: (pipelines: string[]) => void;
  onScrollTo: (pipeline: string) => void;
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

  const anyRunning = [...checked].some((p) => nodeStates[p] === 'running');

  const doneCount = recommendations.filter((r) => {
    const s = nodeStates[r.pipeline];
    return s === 'done' || s === 'failed';
  }).length;
  const runningPipeline = recommendations.find((r) => nodeStates[r.pipeline] === 'running')?.pipeline;

  return (
    <div className="sg-analyze-panel">
      <div className="sg-analyze-header">
        <span className="sg-analyze-title">Analysis Results</span>
        <span className="sg-analyze-sub">
          {anyRunning
            ? `Running ${runningPipeline ?? '…'} (${doneCount}/${recommendations.length})`
            : `${recommendations.length} recommendations — select which to run`}
        </span>
      </div>
      {recommendations.map((r) => {
        const ns = nodeStates[r.pipeline] ?? 'idle';
        const info = lastRunInfo[r.pipeline];
        const chipColor = ns === 'running' ? '#4fc3f7' : ns === 'done' ? '#4ec9b0' : ns === 'failed' ? '#f48771' : 'transparent';
        const chipLabel = ns === 'running' ? '● Running' : ns === 'done' ? '✓' : ns === 'failed' ? '✗' : '';
        return (
          <label key={r.pipeline} className="sg-analyze-row" style={{ cursor: ns === 'done' || ns === 'failed' ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={checked.has(r.pipeline)}
              onChange={() => toggle(r.pipeline)}
              disabled={anyRunning}
            />
            <span className="sg-analyze-pipeline">{r.pipeline}</span>
            <span className="sg-analyze-priority" style={{ color: priorityColor[r.priority] ?? '#888' }}>
              {r.priority}
            </span>
            <span className="sg-analyze-reason">{r.reason}</span>
            {chipLabel && (
              <span
                style={{ marginLeft: 'auto', fontSize: 10, color: chipColor, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0 }}
                title={info ? `exit ${info.exitCode} · ${info.finishedAt}` : undefined}
                onClick={(e) => { e.preventDefault(); onScrollTo(r.pipeline); }}
              >
                {chipLabel}
              </span>
            )}
          </label>
        );
      })}
      <button
        className="sg-wf-btn sg-wf-btn-destructive"
        style={{ marginTop: 8 }}
        disabled={checked.size === 0 || anyRunning}
        onClick={() => onRunSelected([...checked].sort((a, b) => {
          const order = recommendations.map((r) => r.pipeline);
          return order.indexOf(a) - order.indexOf(b);
        }))}
      >
        {anyRunning
          ? `Running… (${doneCount}/${recommendations.filter(r => checked.has(r.pipeline)).length})`
          : `Run selected (${checked.size})`}
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

// Pipelines that generate test output and can be healed automatically.
const HEALABLE_PIPELINES = new Set(['generate', 'security', 'validate', 'heal']);
// Pipelines whose output is worth committing immediately after success.
const COMMITTABLE_PIPELINES = new Set([
  'generate', 'security', 'docs', 'drift', 'matrix', 'reverse', 'gap-analysis',
  'heal', 'validate', 'quality', 'deps',
]);

export function FlowView({ vm, dispatch }: { vm: ViewModel; dispatch: (e: unknown) => void }) {
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [triggeredPipelines, setTriggeredPipelines] = useState<Set<string>>(new Set());
  const prevNodeStates = useRef<Record<string, NodeState>>({});

  // Auto-open the log panel when a pipeline transitions to 'running'.
  // Auto-clear highlight when a triggered pipeline finishes.
  useEffect(() => {
    const prev = prevNodeStates.current;
    const nowFinished: string[] = [];

    for (const [id, ns] of Object.entries(vm.nodeStates)) {
      const was = prev[id] ?? 'idle';
      if (ns === 'running' && was !== 'running') {
        setSelectedLog(id);
      } else if (ns === 'done' && was === 'running') {
        setSelectedLog((cur) => (cur === id ? null : cur));
        nowFinished.push(id);
      } else if (ns === 'failed' && was === 'running') {
        nowFinished.push(id);
      }
    }

    if (nowFinished.length > 0) {
      setTriggeredPipelines((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        let changed = false;
        for (const id of nowFinished) {
          if (next.has(id)) { next.delete(id); changed = true; }
        }
        return changed ? next : prev;
      });
    }

    prevNodeStates.current = { ...vm.nodeStates };
  }, [vm.nodeStates]);

  const state = (id: string): NodeState => vm.nodeStates[id] ?? 'idle';
  const info = (id: string) => vm.lastRunInfo[id];
  const logs = (id: string) => vm.logs[id];

  const totalSpecs = vm.coverage.reduce((s, a) => s + a.specCount, 0);
  const hasSpecs = totalSpecs > 0;

  const analyzeRunning = state('analyze') === 'running';
  const hasRecommendations = vm.analysisRecommendations.length > 0;

  const handleRunSequence = (pipelines: string[]) => {
    // Mark these pipelines as triggered so their cards highlight.
    setTriggeredPipelines(new Set(pipelines));
    vscodeApi.postMessage({ type: 'runSequenceBatch', pipelines });
    // Auto-scroll to the first pipeline in the batch.
    if (pipelines[0]) {
      setTimeout(() => {
        const el = document.getElementById(`sg-card-${pipelines[0]}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
    }
  };

  const handleScrollTo = (pipeline: string) => {
    setSelectedLog(pipeline);
    const el = document.getElementById(`sg-card-${pipeline}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleApproveFix = () => {
    if (!vm.pendingFixPlan) return;
    const pipelineSteps = vm.pendingFixPlan.steps
      .filter((s) => s.action === 'run-pipeline' && s.pipeline)
      .map((s) => s.pipeline as string);
    vscodeApi.postMessage({ type: 'runSequence', pipelines: pipelineSteps });
    dispatch({ type: 'fix-plan', plan: null });
  };

  const handleRejectFix = () => {
    dispatch({ type: 'fix-plan', plan: null });
  };

  // Convenience wrapper: render a standard pipeline card with common props wired.
  const card = (id: string, label: string, description: string, opts: {
    destructive?: boolean;
    disabled?: boolean;
    disabledHint?: string;
  } = {}) => (
    <PipelineCard
      id={id}
      label={label}
      description={description}
      state={state(id)}
      info={info(id)}
      logs={logs(id)}
      selectedLog={selectedLog}
      onSelectLog={setSelectedLog}
      highlighted={triggeredPipelines.has(id)}
      canHeal={HEALABLE_PIPELINES.has(id)}
      canCommit={COMMITTABLE_PIPELINES.has(id)}
      {...opts}
    />
  );

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
                {card('reverse', 'reverse', 'Reads your source code and generates Living Specs. Best for brownfield projects.', { destructive: true })}
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

      {/* ── Pipeline Loop ────────────────────────────────────────────────── */}
      <div className="sg-wf-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #2a2a2a' }}>
          <div style={{ flex: 1 }}>
            <div className="sg-wf-section-title" style={{ marginBottom: 2 }}>
              {hasSpecs ? 'Pipeline Loop' : 'Step 2 — Pipeline Loop'}
            </div>
            <div className="sg-wf-section-sub">
              Run these pipelines on your specs. Use ⚡ Analyze to get smart recommendations.
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

        {hasRecommendations && (
          <AnalyzePanel
            recommendations={vm.analysisRecommendations}
            nodeStates={vm.nodeStates}
            lastRunInfo={vm.lastRunInfo}
            onRunSelected={handleRunSequence}
            onScrollTo={handleScrollTo}
          />
        )}

        <div className="sg-wf-pipeline-grid">
          {/* Spec creation */}
          {card('reverse', 'reverse', 'Generate specs from source code (re-run to pick up new files)', { destructive: true })}
          {card('gap-analysis', 'gap-analysis', 'Detect unimplemented specs and generate implementation plans', { destructive: true })}

          {/* Core loop */}
          {card('generate', 'generate', 'Generate test code from specs', { destructive: true })}
          {card('security', 'security', 'Generate security tests and run SAST analysis', { destructive: true })}
          {card('validate', 'validate', 'Validate specs against your running app (browser automation)', { destructive: true })}
          {card('docs', 'docs', 'Generate user-facing documentation from specs', { destructive: true })}

          {/* Analysis */}
          {card('drift', 'drift', 'Detect specs out of sync with source code')}
          {card('matrix', 'matrix', 'Build traceability matrix linking specs to tests and docs')}
          {card('quality', 'quality', 'Run ESLint and dead-code checks (Knip)')}
          {card('deps', 'deps', 'Audit dependencies for vulnerabilities and unused packages')}

          {/* Heal & commit — inline next steps, no separate section */}
          {card('heal', 'heal', 'Self-heal failing generated tests with LLM assistance', { destructive: true })}
          {card('commit', 'commit', 'Stage and commit all SpecGuard-generated files to git', { destructive: true })}
        </div>
      </div>

    </div>
  );
}
