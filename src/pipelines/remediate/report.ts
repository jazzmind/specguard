/**
 * PR body and evidence rendering.
 *
 * Spec: specs/pipelines/remediate.md
 */
import type { VerdictResult } from '../../core/behavior-verdict.js';
import type { FileChange, ItemReport, PlanItem, TestSummary } from './types.js';

export interface BodyCtx {
  runId: string;
  item: PlanItem;
  result: ItemReport;
  verdict: VerdictResult;
  evidenceRel: string;
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function testLine(label: string, s: TestSummary | undefined): string {
  return s ? `| ${label} | ${s.total} | ${s.passed} | ${s.failed} | ${s.skipped} |` : `| ${label} | n/a | n/a | n/a | n/a |`;
}

function files(list: FileChange[]): string {
  return list.length ? list.map((f) => `- \`${f.path}\` (+${f.additions}/-${f.deletions})`).join('\n') : '- (none)';
}

export function renderPrBody(ctx: BodyCtx): string {
  const { item, result, verdict } = ctx;
  const v = verdict.verdict;
  const d = verdict.diff;
  const lines: string[] = [];
  lines.push(`## SpecGuard remediation: ${v}`);
  lines.push('');
  lines.push(
    v === 'PRESERVED'
      ? '**Behavior preserved.** Every baseline-passing test and proven claim still passes after the change, and the advisory is gone. A human still has to review and merge.'
      : v === 'CHANGED'
        ? '**Behavior changed.** This is a draft: the differences below need a human decision. Do not merge without reviewing them.'
        : '**Inconclusive.** SpecGuard could not prove that behavior is preserved. This is a draft: see the reasons below.',
  );
  lines.push('');
  lines.push('### Advisories fixed');
  lines.push('');
  lines.push('| Advisory | Aliases | Package | Severity | Installed | Fixed in | Direct |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const a of item.advisories) {
    lines.push(`| ${mdEscape(a.id)} | ${mdEscape(a.aliases.join(', ') || '-')} | ${mdEscape(a.package)} | ${a.severity} | ${mdEscape(a.installedVersion || '?')} | ${mdEscape(a.fixedVersions.join(', ') || '-')} | ${a.direct ? 'yes' : 'no'} |`);
  }
  if (item.changeType === 'dependency') {
    lines.push('');
    lines.push('### Version change');
    lines.push('');
    lines.push(`\`${item.candidate.package}\` ${item.candidate.fromVersion || '?'} -> **${item.candidate.toVersion}** (${item.candidate.bump}, ${item.candidate.mode === 'override' ? 'transitive, pinned through overrides' : 'direct dependency'})`);
    lines.push('');
    lines.push(`Risk: **${item.risk.level}** (${item.risk.score}/100): ${item.risk.factors.join('; ')}`);
    if (item.breaking) {
      lines.push('');
      lines.push(`Changelog / breaking-change analysis (${item.breaking.source}, confidence ${item.breaking.confidence}): ${item.breaking.summary}`);
      for (const i of item.breaking.items.slice(0, 8)) lines.push(`- ${i}`);
    }
  }
  lines.push('');
  lines.push('### Changed files');
  lines.push('');
  lines.push(files(result.changedFiles));
  lines.push('');
  lines.push('### Tests');
  lines.push('');
  lines.push(`Selected first (fast failure): **${result.selectedTests.total}** test(s) (${result.selectedTests.claimTagged} claim-tagged, ${result.selectedTests.importing} in files importing the package). The full suite then ran in every case.`);
  lines.push('');
  lines.push('| Run | Tests | Passed | Failed | Skipped |');
  lines.push('|---|---|---|---|---|');
  lines.push(testLine('Baseline (unpatched)', result.baseline));
  lines.push(testLine('Patched (full suite)', result.patched));
  lines.push('');
  lines.push(`Build: ${result.build?.skipped ? 'not configured' : result.build?.ok ? 'green' : 'RED'}. Typecheck: ${result.typecheck?.skipped ? 'not configured' : result.typecheck?.ok ? 'green' : 'RED'}.`);
  lines.push('');
  lines.push('### Baseline vs patched');
  lines.push('');
  lines.push(`- Tests: ${d.testCount.baseline} -> ${d.testCount.patched}`);
  lines.push(`- Claims: ${d.claimCount.baseline} -> ${d.claimCount.patched}`);
  lines.push(`- Regressed tests: ${d.regressedTests.length}`);
  for (const r of d.regressedTests.slice(0, 20)) lines.push(`  - \`${r.id}\` pass -> ${r.to}${r.message ? `: ${mdEscape(r.message.slice(0, 160))}` : ''}`);
  lines.push(`- Vanished tests: ${d.vanishedTests.length}`);
  for (const t of d.vanishedTests.slice(0, 20)) lines.push(`  - \`${t}\``);
  lines.push(`- Proven claims that dropped: ${d.claimDrops.length}`);
  for (const c of d.claimDrops.slice(0, 20)) lines.push(`  - \`${c.claim}\` ${c.from} -> ${c.to}`);
  if (d.flaky.length) {
    lines.push(`- Flaky (excluded from the comparison): ${d.flaky.length}`);
    for (const t of d.flaky.slice(0, 10)) lines.push(`  - \`${t}\``);
  }
  lines.push('');
  lines.push('### Static analysis');
  lines.push('');
  lines.push(
    result.sastDelta
      ? `Findings before: ${result.sastDelta.before}, after: ${result.sastDelta.after}${result.sastDelta.new.length ? `. New: ${result.sastDelta.new.join(', ')}` : '. No new findings.'}`
      : 'Not run (Semgrep unavailable or not applicable).',
  );
  lines.push('');
  lines.push('### Verdict');
  lines.push('');
  lines.push(`**${v}**`);
  for (const r of verdict.reasons) lines.push(`- [${r.level}] ${r.kind}: ${r.detail}`);
  for (const n of verdict.notes) lines.push(`- [note] ${n}`);
  if (verdict.reasons.length === 0) lines.push('- every preservation condition held');
  lines.push('');
  lines.push(`Run \`${ctx.runId}\`. Evidence: \`${ctx.evidenceRel}\` (baseline and patched proof ledgers, full report JSON).`);
  lines.push('');
  lines.push('_Opened by `specguard remediate`. It never merges: a human decides._');
  return lines.join('\n') + '\n';
}
