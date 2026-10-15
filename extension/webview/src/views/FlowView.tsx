import { useState, useRef, useEffect } from 'react';
import type { ViewModel, NodeState } from '../reducer.js';
import type { DashboardEvent, PipelineRunInfo } from '../protocol.js';
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

function StatusChip({ state, info, findingCount }: { state: NodeState | 'done-with-findings'; info?: PipelineRunInfo; findingCount?: number }) {
  if (state === 'running') return <span className="sg-chip sg-chip-running">Running…</span>;
  if (state === 'done-with-findings') {
    const ago = info ? timeAgo(info.finishedAt) : '';
    return (
      <span className="sg-chip sg-chip-findings" title={`${findingCount} finding(s) — heal to fix`}>
        {findingCount} finding(s){ago && ` · ${ago}`}
      </span>
    );
  }
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
  /** Extra action buttons rendered after Plan/Heal/Commit (e.g. "Open Plans" for gap-analysis) */
  extraActions?: React.ReactNode;
}

function PipelineCard({
  id, label, description, state, info, logs, disabled, disabledHint, destructive,
  selectedLog, onSelectLog, highlighted, canHeal, canCommit, extraActions,
}: PipelineCardProps) {
  const isFailed = state === 'failed' || (state === 'idle' && info?.status === 'fail');
  const isRunning = state === 'running';
  const isDone = state === 'done' || (state === 'idle' && info?.status === 'pass');
  const hasRun = state !== 'idle' || info !== undefined;
  const tail = isFailed ? (logs?.filter((l) => l.trim()).slice(-5) ?? info?.tail ?? []) : [];
  const logOpen = selectedLog === id;

  // Finding count from last run: undefined = didn't report, 0 = clean pass, >0 = has findings.
  const findingCount = info?.findingCount;
  const hasFindings = findingCount !== undefined && findingCount > 0;

  // Show Heal when the pipeline failed OR when it passed but reported findings.
  // After heal succeeds, the host auto-commits — no Commit button needed.
  const showHeal = canHeal && (isFailed || (isDone && hasFindings));
  // Show Commit only when the pipeline passed cleanly with zero findings.
  const showCommit = canCommit && isDone && !hasFindings && !isFailed;
  // Annotate status chip if passed-with-findings.
  const chipState = (isDone && hasFindings) ? 'done-with-findings' as NodeState : state;

  return (
    <div
      id={`sg-card-${id}`}
      className={[
        'sg-wf-card',
        isFailed ? 'sg-wf-card-failed' : isDone ? (hasFindings ? 'sg-wf-card-findings' : 'sg-wf-card-passed') : '',
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
        {(isFailed || (isDone && hasFindings)) && <ErrorTail lines={tail} />}
        {logOpen && (
          <LiveLogPanel pipeline={id} lines={logs ?? []} isRunning={isRunning} />
        )}
      </div>
      <div className="sg-wf-card-right">
        <StatusChip state={chipState} info={info} findingCount={findingCount} />

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
            {showHeal && (
              <button
                className="sg-wf-btn sg-wf-btn-fix"
                onClick={() => runPipeline('heal', ['--pipeline', id])}
                title={hasFindings
                  ? `${findingCount} finding(s) — heal will fix and auto-commit`
                  : 'Auto-heal failing tests with LLM assistance (auto-commits on success)'}
              >
                Heal
              </button>
            )}
            {showCommit && (
              <button
                className="sg-wf-btn sg-wf-btn-commit"
                onClick={() => runPipeline('commit', ['--pipeline', id])}
                title={`Commit output from ${id} — specguard(${id}): ...`}
              >
                Commit
              </button>
            )}
            {extraActions}
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
// PipelineGroup — collapsible group of pipeline cards
// ---------------------------------------------------------------------------

function PipelineGroup({ id, title, sub, defaultOpen, children }: {
  id: string;
  title: string;
  sub: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="sg-wf-group" id={`sg-group-${id}`}>
      <button
        className="sg-wf-group-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sg-wf-group-chevron">{open ? '▾' : '▸'}</span>
        <span className="sg-wf-group-title">{title}</span>
        <span className="sg-wf-group-sub">{sub}</span>
      </button>
      {open && <div className="sg-wf-group-body">{children}</div>}
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

// Pipelines that can be healed after failure OR after a pass-with-findings.
// After a successful heal, the host auto-commits so no Commit button is needed.
const HEALABLE_PIPELINES = new Set([
  'generate', 'security', 'validate', 'heal',
  'quality', 'drift',
]);
// Pipelines whose clean-pass output (findingCount === 0) is worth committing.
const COMMITTABLE_PIPELINES = new Set([
  'generate', 'security', 'docs', 'drift', 'matrix', 'reverse', 'gap-analysis',
  'heal', 'validate', 'quality',
]);

export function FlowView({ vm, dispatch }: { vm: ViewModel; dispatch: (e: DashboardEvent) => void }) {
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

  const checkRunning = state('check') === 'running';

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
            </div>
            <div className="sg-wf-bootstrap-sep">or</div>
            <div className="sg-wf-bootstrap-option">
              <ArrowFlow steps={['PRD / Jira / MD', 'import', 'Specs']} />
            </div>
          </div>
        </div>
      )}

      {/* ── Pipeline Loop ────────────────────────────────────────────────── */}
      <div className="sg-wf-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #2a2a2a' }}>
          <div style={{ flex: 1 }}>
            <div className="sg-wf-section-title" style={{ marginBottom: 2 }}>
              {hasSpecs ? 'Action Loop' : 'Step 2 — Action Loop'}
            </div>
            <div className="sg-wf-section-sub">
              Run these actions on your specs. Use Check to see what needs attention.
            </div>
          </div>
          <button
            className={`sg-wf-btn ${checkRunning ? 'sg-wf-btn-disabled' : ''}`}
            style={{ flexShrink: 0, fontWeight: 600 }}
            onClick={() => runPipeline('check')}
            disabled={checkRunning}
            title="Spec health for the whole system: ownership, tests, proofs, gaps and drift"
          >
            {checkRunning ? 'Checking…' : 'Check'}
          </button>
        </div>

        <div className="sg-wf-groups">

          {/* ── Specs group ──────────────────────────────────────────────── */}
          <PipelineGroup id="specs" title="Specs" sub="create and refine Living Specification files" defaultOpen>
            <div className="sg-wf-pipeline-grid">
              {card('reverse', 'reverse', 'Generate Living Specs from source code (re-run to pick up new files)', { destructive: true })}
              <PipelineCard
                id="import"
                label="import"
                description="Convert a PRD, Jira ticket, or Markdown doc into a Living Spec"
                state={state('import')}
                info={info('import')}
                logs={logs('import')}
                selectedLog={selectedLog}
                onSelectLog={setSelectedLog}
                highlighted={triggeredPipelines.has('import')}
                canHeal={false}
                canCommit={false}
                destructive
              />
              <PipelineCard
                id="gap-analysis"
                label="gap-analysis"
                description="Detect unimplemented specs and generate implementation plans for your coding agent"
                state={state('gap-analysis')}
                info={info('gap-analysis')}
                logs={logs('gap-analysis')}
                selectedLog={selectedLog}
                onSelectLog={setSelectedLog}
                highlighted={triggeredPipelines.has('gap-analysis')}
                canHeal={false}
                canCommit={COMMITTABLE_PIPELINES.has('gap-analysis')}
                destructive
                extraActions={
                  <button
                    className="sg-wf-btn"
                    style={{ borderColor: '#3a5a5a', color: '#4fc3f7' }}
                    onClick={() => vscodeApi.postMessage({ type: 'openFile', path: '.specguard/plans' })}
                    title="Open the .specguard/plans/ directory to view generated implementation plans"
                  >
                    Open Plans
                  </button>
                }
              />
            </div>
          </PipelineGroup>

          {/* ── Tests group ──────────────────────────────────────────────── */}
          <PipelineGroup id="tests" title="Tests" sub="generate, validate, and track test quality" defaultOpen>
            <div className="sg-wf-pipeline-grid">
              {card('quality', 'quality', 'Run ESLint and dead-code checks (Knip)')}
              {card('validate', 'validate', 'Validate specs against your running app via browser automation', { destructive: true })}
              {card('drift', 'drift', 'Detect specs that have drifted out of sync with source code')}
              {card('generate', 'generate', 'Generate test code from specs', { destructive: true })}
              {card('test-run', 'test run', 'Run the tests and record the results as proof of each requirement')}
            </div>
          </PipelineGroup>

          {/* ── Security group ───────────────────────────────────────────── */}
          <PipelineGroup id="security" title="Security" sub="dependency audit, SAST, and security tests" defaultOpen>
            <div className="sg-wf-pipeline-grid">
              {card('security-scan', 'security scan', 'Code, dependency, secret and spec-level findings as one remediation plan')}
              {card('security', 'security', 'Generate security tests and run SAST analysis', { destructive: true })}
            </div>
          </PipelineGroup>

          {/* ── Docs group ───────────────────────────────────────────────── */}
          <PipelineGroup id="docs" title="Docs" sub="traceability matrix and user-facing documentation" defaultOpen>
            <div className="sg-wf-pipeline-grid">
              {card('matrix', 'matrix', 'Build traceability matrix linking specs → tests → docs')}
              {card('docs', 'docs', 'Generate user-facing documentation from specs', { destructive: true })}
            </div>
          </PipelineGroup>

        </div>
      </div>

    </div>
  );
}
