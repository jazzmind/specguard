/**
 * The PR proof packet: what the requirements now say, the evidence for each changed requirement, the verdict per
 * capability and for the whole change, rendered as one markdown comment and one JSON document. The same builder
 * serves CI and `change report` (which marks the packet provisional). Pure: build and render only; no LLM, so every
 * sentence is made from text already in the specs, history and statement.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import { createHash } from 'node:crypto';

import type { ChangedClaim, ClaimChange } from './change-claims.js';
import type { ChangeKind } from './change-record.js';
import type { EffectiveVerdict } from './proof-ledger.js';
import { PILLARS, REASON_LABELS, type ClaimStatement, type PillarName, type PillarStatus, type Reason, type SystemStatement } from './proof-statement.js';
import { createSecretRedactor } from './redact.js';
import type { UnrequestedLines, UnrequestedReport } from './unrequested.js';
import type { EnforceLevel } from './types.js';
import type { WeakeningFinding } from './weakening.js';

export const PACKET_SCHEMA = 'specguard.proof-packet';
export const PACKET_VERSION = 1;
/** First line of the packet comment; CI finds its own comment by it. */
export const PACKET_MARKER = '<!-- specguard-proof-packet v1 -->';
/** Default `maxChars` of the markdown rendering. GitHub rejects a comment of more than 65536 characters. */
export const PACKET_MAX_CHARS = 60_000;
export const PACKET_GITHUB_LIMIT = 65_536;

export const PACKET_VERDICTS = ['ready', 'blocked', 'advisory', 'no-change'] as const;
export type PacketVerdict = (typeof PACKET_VERDICTS)[number];

export const APPROVAL_TRUSTS = ['verified', 'countersigned', 'self-approved', 'inherited', 'recorded', 'missing'] as const;
export type ApprovalTrust = (typeof APPROVAL_TRUSTS)[number];

export interface PacketApproval {
  method: 'pr' | 'plan' | 'command' | 'as-built';
  by: string;
  trust: ApprovalTrust;
  /** pr: review id + reviewer; plan/command/as-built: history entry id. */
  source: string;
  date: string;
  countersignedBy?: string;
}

export interface IntentChange {
  ref: string;
  capability: string;
  change: ClaimChange;
  text?: string;
  baseText?: string;
  /** Plain-language one-liner: "now reads: ..." / "was: ...". Text only, never LLM. */
  summary: string;
  /** Absent for removed claims unless an approved removal (a PR review covers removals). */
  approval?: PacketApproval;
}

export interface ClaimEvidence {
  ref: string;
  layers: Array<{ layer: string; verdict: EffectiveVerdict; origin: 'ci' | 'local' | 'note' }>;
  examples: { total: number; proven: number; failing: string[] };
  sensitivity:
    | { kind: 'red-green'; status: 'ok' | 'fail' | 'unknown'; redTests: number }
    | { kind: 'mutation'; status: 'ok' | 'fail' | 'unknown'; score: number | null; killed: number }
    | { kind: 'none' };
  strength: 'strong' | 'weak' | 'skipped' | 'conditional' | 'unknown';
  verdict: 'pass' | 'fail' | 'unknown';
  /** ReasonCode labels from the statement, in precedence order. */
  reasons: string[];
}

export interface CapabilityVerdict {
  capability: string;
  title: string;
  enforce: EnforceLevel;
  pillars: Record<PillarName, PillarStatus>;
  verdict: 'pass' | 'fail' | 'unknown';
  /** What this capability does to the merge: enforce+fail -> blocks; warn+fail -> warns; observe -> none. */
  effect: 'blocks' | 'warns' | 'none';
  blocking: Array<{ code: string; message: string; fix?: string }>;
}

export interface ChangeVerdict {
  id: string;
  kind: ChangeKind;
  capabilities: string[];
  verdict: 'pass' | 'fail' | 'spike';
  claims: string[];
  /** Advisory, from PR commit order. */
  chronology?: { testsBeforeCode: boolean | null; note: string };
  refactor?: { claimsProvenBefore: number; claimsProvenAfter: number; changedLineCoverage: number | null; mutation?: { killed: number; total: number } };
}

export interface PipelineChange {
  file: string;
  kind: 'workflow' | 'specguard-config' | 'codeowners' | 'action';
  severity: 'warn' | 'error';
}

export interface ProofPacket {
  schema: typeof PACKET_SCHEMA;
  version: 1;
  generated: string;
  head: string;
  base: string;
  baseRef?: string;
  pr?: { number: number; author: string; url?: string };
  run?: { id: string; url?: string };
  /** specguard version. */
  tool: string;
  verdict: PacketVerdict;
  headline: string;
  intent: IntentChange[];
  evidence: ClaimEvidence[];
  capabilities: CapabilityVerdict[];
  changes: ChangeVerdict[];
  weakening: WeakeningFinding[];
  unrequested: UnrequestedReport;
  pipeline: PipelineChange[];
  /** Ordered fix commands (deduplicated), first = most important. */
  fixes: string[];
  limits: string[];
  /** True for `change report` (local). */
  provisional: boolean;
}

export interface PacketInput {
  /** Change mode (base given). */
  statement: SystemStatement;
  changed: ChangedClaim[];
  /** By ref, after the CI trust rules. */
  approvals: Map<string, PacketApproval>;
  sensitivity: Map<string, ClaimEvidence['sensitivity']>;
  changes: ChangeVerdict[];
  weakening: WeakeningFinding[];
  unrequested: UnrequestedReport;
  pipeline: PipelineChange[];
  enforce: Map<string, EnforceLevel>;
  meta: Pick<ProofPacket, 'generated' | 'head' | 'base' | 'baseRef' | 'pr' | 'run' | 'tool' | 'provisional'>;
  policy: { unrequested: 'error' | 'warn' };
}


// ---------------------------------------------------------------------------
// Text safety: spec, test and finding text is attacker-controlled, and a PR comment renders markdown and mentions
// ---------------------------------------------------------------------------

const secrets = createSecretRedactor();

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);
const scrub = (s: string): string => secrets.text(s);
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Keep a mention from pinging anyone and a bracket from becoming a link; the angle bracket and ampersand from becoming HTML. */
function neutralize(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]')
    .replace(/@(?=[A-Za-z0-9])/g, '@&#8203;');
}

/**
 * Text from a spec, a test or a finding, made safe for one markdown table cell or list item: credentials masked,
 * newlines collapsed, capped, and `\`, `|`, backticks, `<`, `&`, brackets and mentions escaped.
 */
export function escapeMarkdownForComment(text: string, maxChars: number = 200): string {
  const flat = clip(collapse(scrub(text)), maxChars);
  return neutralize(flat.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`'));
}

/** A code span of untrusted text: no backtick can end it early, newlines are gone, credentials are masked. */
function code(text: string, opts: { max?: number; table?: boolean } = {}): string {
  const flat = clip(collapse(scrub(text)).replace(/`/g, "'"), opts.max ?? 120);
  return `\`${opts.table ? flat.replace(/\|/g, '\\|') : flat}\``;
}

/** A sentence we built ourselves (it may hold code spans): only what would be live markup or a mention is neutralized. */
function inline(text: string, max: number): string {
  const flat = clip(collapse(scrub(text)), max);
  // Code spans stay as written (a `<report>` placeholder in a command must not show as an entity).
  return flat.split(/(`[^`]*`)/).map((seg, i) => (i % 2 === 1 ? seg : neutralize(seg))).join('');
}

const refList = (refs: string[], max: number = 3): string => {
  const shown = refs.slice(0, max).map((r) => code(r)).join(', ');
  return refs.length > max ? `${shown} and ${refs.length - max} more` : shown;
};

const capNames = (names: string[]): string => {
  const q = names.map((n) => code(n));
  if (q.length <= 1) return q.join('');
  if (q.length <= 3) return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
  return `${q.slice(0, 3).join(', ')} and ${q.length - 3} more`;
};

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/** `specKey#claim/row` -> `specKey#claim`; a claim ref is returned as is. */
function claimRefOf(ref: string): string {
  const hash = ref.indexOf('#');
  if (hash < 0) return ref;
  const slash = ref.indexOf('/', hash);
  return slash < 0 ? ref : ref.slice(0, slash);
}

const isRowRef = (ref: string): boolean => claimRefOf(ref) !== ref;

/** The capability id a claim ref belongs to: the last segment of its spec key. */
function capabilityOfRef(ref: string): string {
  const specKey = ref.split('#')[0] ?? ref;
  return specKey.split('/').pop() ?? specKey;
}

// ---------------------------------------------------------------------------
// buildPacket
// ---------------------------------------------------------------------------

const RANK: Record<PillarStatus, number> = { ok: 0, unknown: 1, fail: 2 };
const worst = (a: PillarStatus, b: PillarStatus): PillarStatus => (RANK[b] > RANK[a] ? b : a);
const EFFECT_RANK: Record<CapabilityVerdict['effect'], number> = { blocks: 0, warns: 1, none: 2 };

function summarize(c: ChangedClaim): string {
  const subject = isRowRef(c.ref) ? 'example row' : 'requirement';
  const now = c.text !== undefined ? clip(collapse(scrub(c.text)), 300) : '';
  const was = c.baseText !== undefined ? clip(collapse(scrub(c.baseText)), 300) : '';
  if (c.change === 'added') return now ? `new ${subject} now reads: ${now}` : `new ${subject} added`;
  if (c.change === 'removed') return was ? `${subject} removed (was: ${was})` : `${subject} removed`;
  const parts = c.parts ?? [];
  if (parts.length > 0 && !parts.includes('text')) {
    const words = parts.map((x) => x.replace('rows-', '')).join(', ');
    return `${subject} wording unchanged; example rows ${words}`;
  }
  return `${subject} now reads: ${now || '(text unavailable)'}${was ? ` (was: ${was})` : ''}`;
}

function approvalCounts(a: PacketApproval | undefined): boolean {
  return a !== undefined && a.trust !== 'missing' && a.trust !== 'recorded';
}

function strengthOf(reasons: Reason[]): ClaimEvidence['strength'] {
  const codes = new Set(reasons.map((r) => r.code));
  if (codes.has('TESTS_SKIPPED_ONLY')) return 'skipped';
  if (codes.has('CONDITIONAL_ONLY')) return 'conditional';
  if (codes.has('WEAK_ONLY') || codes.has('LAYER_NOT_MEANINGFUL') || codes.has('EXAMPLE_NOT_MEANINGFUL')) return 'weak';
  if (codes.has('STRENGTH_UNKNOWN') || codes.has('NO_TAGGED_TESTS')) return 'unknown';
  return 'strong';
}

function rangesText(ranges: Array<[number, number]>): string {
  const count = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
  const body = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  return `${count === 1 ? 'line' : 'lines'} ${body}`;
}

const countLines = (l: UnrequestedLines): number => l.lines.reduce((n, [a, b]) => n + (b - a + 1), 0);

interface Fix {
  priority: number;
  text: string;
}

/**
 * Verdict rules. Per capability touched by the PR: pass when the changed claims' four pillars are ok, there is no
 * error-level weakening, no unrequested line (policy `error`), no file without a change (when required) and every
 * covering change passed; unknown when the only problems are unknown reasons. Effect: enforce + fail or unknown blocks;
 * warn + not pass warns; observe has none. Overall: blocked, else advisory, else no-change, else ready.
 *
 * Beyond those rules: a passing capability that is not at `observe` still `warns` when it has warning-level findings
 * (incidental lines, unrequested lines under policy `warn`, warning-level weakening), a `spike` change counts as failed,
 * a pipeline change of severity `error` makes an otherwise ready packet advisory, and an error-level weakening finding
 * that names no claim applies to every touched capability.
 */
export function buildPacket(input: PacketInput): ProofPacket {
  const { statement, changed, approvals, sensitivity, changes, unrequested, pipeline, enforce, meta, policy } = input;

  const weakening: WeakeningFinding[] = input.weakening.map((w) => ({
    ...w,
    ...(w.test !== undefined ? { test: scrub(w.test) } : {}),
    ...(w.before !== undefined ? { before: scrub(w.before) } : {}),
    ...(w.after !== undefined ? { after: scrub(w.after) } : {}),
    message: scrub(w.message),
  }));

  const capStatements = new Map(statement.capabilities.map((c) => [c.capability, c]));
  const claimStatements = new Map<string, ClaimStatement>();
  for (const c of statement.capabilities) for (const cl of c.claims) claimStatements.set(cl.ref, cl);

  // ---- intent -------------------------------------------------------------
  const intent: IntentChange[] = changed.map((c) => {
    const approval = approvals.get(c.ref);
    return {
      ref: c.ref,
      capability: c.capability,
      change: c.change,
      ...(c.text !== undefined ? { text: scrub(c.text) } : {}),
      ...(c.baseText !== undefined ? { baseText: scrub(c.baseText) } : {}),
      summary: summarize(c),
      ...(approval ? { approval } : {}),
    };
  });

  // ---- evidence (changed, surviving claims; rows roll up into their claim) --
  const claimRefs: string[] = [];
  for (const c of changed) {
    if (c.change === 'removed') continue;
    const ref = claimRefOf(c.ref);
    if (!claimRefs.includes(ref)) claimRefs.push(ref);
  }
  const evidence: ClaimEvidence[] = claimRefs.map((ref) => {
    const cs = claimStatements.get(ref);
    const reasons = (cs?.reasons ?? []).filter((r) => r.outcome !== 'note');
    const layers: ClaimEvidence['layers'] = [];
    for (const r of reasons) {
      const layer = r.data?.layer;
      if (typeof layer !== 'string' || layers.some((l) => l.layer === layer)) continue;
      layers.push({ layer, verdict: r.code === 'LAYER_MISSING' || r.code === 'LAYER_UNTESTED' ? 'unproven' : 'failed', origin: 'ci' });
    }
    const rows = changed.filter((c) => c.change !== 'removed' && isRowRef(c.ref) && claimRefOf(c.ref) === ref).map((c) => c.ref);
    const exampleReasons = reasons.filter((r) => r.example !== undefined);
    const failing = [...new Set(exampleReasons.filter((r) => r.outcome === 'fail').map((r) => r.example!))];
    const unproven = new Set(exampleReasons.map((r) => r.example!));
    const total = Math.max(rows.length, unproven.size);
    const sens = sensitivity.get(ref) ?? { kind: 'none' as const };
    let status: PillarStatus = cs ? 'ok' : 'unknown';
    if (cs) for (const p of PILLARS) status = worst(status, cs.pillars[p]);
    if (sens.kind !== 'none') status = worst(status, sens.status);
    const verdict: ClaimEvidence['verdict'] = status === 'ok' ? 'pass' : status;
    return {
      ref,
      layers,
      examples: { total, proven: Math.max(0, total - unproven.size), failing },
      sensitivity: sens,
      strength: strengthOf(reasons),
      verdict,
      reasons: [...new Set(reasons.map((r) => REASON_LABELS[r.code] ?? r.code))],
    };
  });

  // ---- which capabilities the PR touches ---------------------------------
  const touched = new Set<string>();
  for (const c of changed) touched.add(c.capability);
  for (const l of unrequested.lines) touched.add(l.capability);
  for (const w of unrequested.withoutChange) for (const c of w.capabilities) touched.add(c);
  for (const ch of changes) for (const c of ch.capabilities) touched.add(c);
  for (const w of weakening) for (const r of w.claims) touched.add(capabilityOfRef(r));
  const unattributed = weakening.some((w) => w.severity === 'error' && w.claims.length === 0);
  if (unattributed && touched.size === 0) for (const c of capStatements.keys()) touched.add(c);

  // ---- per capability -----------------------------------------------------
  const capabilityVerdicts: CapabilityVerdict[] = [];
  for (const id of [...touched].sort()) {
    const stmt = capStatements.get(id);
    const mine = changed.filter((c) => c.capability === id);
    const mineRefs = new Set(mine.filter((c) => c.change !== 'removed').map((c) => claimRefOf(c.ref)));
    const mineClaims = [...mineRefs].map((r) => claimStatements.get(r)).filter((c): c is ClaimStatement => c !== undefined);

    const pillars = {} as Record<PillarName, PillarStatus>;
    for (const p of PILLARS) {
      if (!stmt) pillars[p] = mineRefs.size > 0 ? 'unknown' : 'ok';
      else if (mineRefs.size === 0) pillars[p] = stmt.pillars[p].status;
      else {
        let status: PillarStatus = mineClaims.length < mineRefs.size ? 'unknown' : 'ok';
        for (const cl of mineClaims) status = worst(status, cl.pillars[p]);
        // Whether the code matches the requirements is a property of the capability as well as of the changed claims.
        pillars[p] = p === 'aligned' ? worst(status, stmt.pillars.aligned.status) : status;
      }
    }

    const mineWeak = weakening.filter((w) => w.claims.some((r) => capabilityOfRef(r) === id) || (w.claims.length === 0 && w.severity === 'error' && unattributed));
    const errWeak = mineWeak.filter((w) => w.severity === 'error');
    const lines = unrequested.lines.filter((l) => l.capability === id);
    const unreqLines = lines.filter((l) => l.class === 'unrequested');
    const withoutChange = unrequested.withoutChange.filter((w) => w.capabilities.includes(id));
    const failedChanges = changes.filter((ch) => ch.capabilities.includes(id) && ch.verdict !== 'pass');

    const blocking: CapabilityVerdict['blocking'] = [];
    for (const r of stmt?.blocking ?? []) {
      if (r.claim !== undefined && mineRefs.size > 0 && !mineRefs.has(claimRefOf(r.claim))) continue;
      blocking.push({ code: r.code, message: scrub(r.message), ...(r.fix !== undefined ? { fix: r.fix } : {}) });
    }
    for (const w of errWeak) blocking.push({ code: 'TEST_WEAKENING', message: w.message });
    if (policy.unrequested === 'error') {
      for (const l of unreqLines) blocking.push({ code: 'UNREQUESTED_CODE', message: `${l.file} ${rangesText(l.lines)}: changed, reached by no test of a changed requirement`, fix: `add a test for ${l.file} under a changed requirement, or remove the code` });
    }
    for (const w of withoutChange) blocking.push({ code: 'CODE_WITHOUT_CHANGE', message: `${w.file} changed with no open change covering ${id}`, fix: `specguard change start ${id}` });
    for (const ch of failedChanges) blocking.push({ code: ch.verdict === 'spike' ? 'CHANGE_IS_SPIKE' : 'CHANGE_NOT_VALIDATED', message: ch.verdict === 'spike' ? `change ${ch.id} is a spike: it cannot merge` : `change ${ch.id} did not validate` });

    const pillarFail = PILLARS.some((p) => pillars[p] === 'fail');
    const pillarUnknown = PILLARS.some((p) => pillars[p] === 'unknown');
    const failing = pillarFail || errWeak.length > 0 || (policy.unrequested === 'error' && unreqLines.length > 0) || withoutChange.length > 0 || failedChanges.length > 0;
    const verdict: CapabilityVerdict['verdict'] = failing ? 'fail' : pillarUnknown ? 'unknown' : 'pass';

    const level = enforce.get(id) ?? 'observe';
    let effect: CapabilityVerdict['effect'] = 'none';
    if (level === 'enforce' && verdict !== 'pass') effect = 'blocks';
    else if (level === 'warn' && verdict !== 'pass') effect = 'warns';
    const hasWarning = lines.some((l) => l.class === 'incidental') || (policy.unrequested === 'warn' && unreqLines.length > 0) || mineWeak.some((w) => w.severity === 'warn');
    if (effect === 'none' && level !== 'observe' && hasWarning) effect = 'warns';

    capabilityVerdicts.push({ capability: id, title: stmt?.title ?? id, enforce: level, pillars, verdict, effect, blocking });
  }
  capabilityVerdicts.sort((a, b) => EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect] || a.capability.localeCompare(b.capability));
  const effectOf = new Map(capabilityVerdicts.map((c) => [c.capability, c.effect]));
  const gated = (id: string): boolean => (effectOf.get(id) ?? 'none') !== 'none';

  // ---- overall verdict ----------------------------------------------------
  const codeChanged = unrequested.diffCoverage.changedExecutable > 0 || unrequested.lines.length > 0 || unrequested.withoutChange.length > 0 || changes.length > 0;
  let verdict: PacketVerdict;
  if (capabilityVerdicts.some((c) => c.effect === 'blocks')) verdict = 'blocked';
  else if (capabilityVerdicts.some((c) => c.effect === 'warns') || pipeline.some((c) => c.severity === 'error')) verdict = 'advisory';
  else if (changed.length === 0 && !codeChanged && weakening.length === 0 && pipeline.length === 0) verdict = 'no-change';
  else verdict = 'ready';

  // ---- headline -----------------------------------------------------------
  const headlineOf = (): string => {
    if (verdict === 'no-change') return 'No requirement, owned code or test change to judge.';
    const target = verdict === 'blocked' ? 'blocks' : 'warns';
    const subject = capabilityVerdicts.filter((c) => c.effect === target);
    const ids = new Set(subject.map((c) => c.capability));
    if (verdict === 'ready' || (verdict === 'advisory' && subject.length === 0)) {
      if (verdict === 'advisory') {
        const files = pipeline.filter((c) => c.severity === 'error').map((c) => c.file);
        return `Nothing blocks the merge, but a pipeline file changed: ${refList(files)}.`;
      }
      const n = claimRefs.length;
      const observed = capabilityVerdicts.filter((c) => c.verdict !== 'pass');
      const base = n > 0 ? `${plural(n, 'changed requirement')} approved and proven.` : 'Owned code changed and every touched capability passes.';
      return observed.length > 0 ? `${base} Not gated, with findings: ${capNames(observed.map((c) => c.capability))}.` : base;
    }
    const causes: string[] = [];
    const subjectClaims = [...new Set(changed.filter((c) => c.change !== 'removed' && ids.has(c.capability)).map((c) => claimRefOf(c.ref)))];
    const stmtOf = (ref: string): ClaimStatement | undefined => claimStatements.get(ref);
    const notApproved = subjectClaims.filter((ref) => {
      const cs = stmtOf(ref);
      return cs ? cs.pillars.approved !== 'ok' : !approvalCounts(approvals.get(ref));
    }).length;
    if (notApproved > 0) causes.push(`${plural(notApproved, 'claim')} not approved`);
    const notTestable = subjectClaims.filter((ref) => (stmtOf(ref)?.pillars.testable ?? 'ok') !== 'ok').length;
    if (notTestable > 0) causes.push(`${plural(notTestable, 'claim')} not testable`);
    const notProven = subjectClaims.filter((ref) => (stmtOf(ref)?.pillars.conforms ?? 'ok') !== 'ok').length;
    if (notProven > 0) causes.push(`${plural(notProven, 'claim')} not proven`);
    const unreqCount = unrequested.lines.filter((l) => l.class === 'unrequested' && ids.has(l.capability)).reduce((n, l) => n + countLines(l), 0);
    if (unreqCount > 0) causes.push(`${plural(unreqCount, 'changed line')} no claim test reaches`);
    const misaligned = subject.filter((c) => c.pillars.aligned !== 'ok' && !unrequested.lines.some((l) => l.capability === c.capability && l.class === 'unrequested'));
    if (misaligned.length > 0) causes.push(`code not aligned with the requirements in ${plural(misaligned.length, 'capability', 'capabilities')}`);
    const weak = weakening.filter((w) => w.severity === 'error' && (w.claims.length === 0 || w.claims.some((r) => ids.has(capabilityOfRef(r))))).length;
    if (weak > 0) causes.push(`${plural(weak, 'test weakening finding')}`);
    const incidentalCount = unrequested.lines.filter((l) => l.class === 'incidental' && ids.has(l.capability)).reduce((n, l) => n + countLines(l), 0);
    if (incidentalCount > 0) causes.push(`${plural(incidentalCount, 'changed line')} reached only by other requirements' tests`);
    const weakWarn = weakening.filter((w) => w.severity === 'warn' && w.claims.some((r) => ids.has(capabilityOfRef(r)))).length;
    if (weakWarn > 0) causes.push(`${plural(weakWarn, 'test weakening warning')}`);
    const noRecord = unrequested.withoutChange.filter((w) => w.capabilities.some((c) => ids.has(c))).length;
    if (noRecord > 0) causes.push(`${plural(noRecord, 'changed file')} without a change record`);
    const badChanges = changes.filter((ch) => ch.verdict !== 'pass' && ch.capabilities.some((c) => ids.has(c))).length;
    if (badChanges > 0 && causes.length === 0) causes.push(`${plural(badChanges, 'change')} not validated`);
    if (causes.length === 0) causes.push('the proof is incomplete');
    const verb = subject.length === 1 ? target : target === 'blocks' ? 'block' : 'warn';
    const lead = verdict === 'blocked' ? `${capNames(subject.map((c) => c.capability))} ${verb} the merge` : `${capNames(subject.map((c) => c.capability))} ${verb} (the merge is not blocked)`;
    return `${lead}: ${causes.slice(0, 2).join(', ')}.`;
  };
  const headline = `${meta.provisional ? '(local, provisional) ' : ''}${headlineOf()}`;

  // ---- fixes --------------------------------------------------------------
  const fixes: Fix[] = [];
  const unapprovedRefs = new Map<string, string[]>();
  for (const c of changed) {
    if (c.change === 'removed' || isRowRef(c.ref) || !gated(c.capability)) continue;
    const cs = claimStatements.get(c.ref);
    const a = approvals.get(c.ref);
    const needs = cs ? cs.pillars.approved !== 'ok' : !approvalCounts(a);
    if (!needs && a?.trust !== 'missing') continue;
    unapprovedRefs.set(c.capability, [...(unapprovedRefs.get(c.capability) ?? []), c.ref]);
  }
  const allUnapproved = [...unapprovedRefs.values()].flat();
  if (allUnapproved.length > 0) {
    if (meta.provisional) {
      fixes.push({ priority: 1, text: `A person approves ${refList(allUnapproved)} with \`specguard spec approve ${[...unapprovedRefs.keys()].join(' ')}\`.` });
    } else {
      fixes.push({ priority: 1, text: `A reviewer approves this PR (the approval covers ${refList(allUnapproved)} at ${allUnapproved.length === 1 ? 'its' : 'their'} current wording).` });
    }
  }
  for (const cv of capabilityVerdicts) {
    if (cv.effect === 'none') continue;
    const stmt = capStatements.get(cv.capability);
    for (const r of stmt?.blocking ?? []) {
      if (r.pillar === 'approved' || r.fix === undefined) continue;
      const refs = changed.filter((c) => c.capability === cv.capability && c.change !== 'removed').map((c) => claimRefOf(c.ref));
      if (r.claim !== undefined && refs.length > 0 && !refs.includes(claimRefOf(r.claim))) continue;
      const priority = r.pillar === 'testable' ? 2 : r.pillar === 'conforms' ? 3 : 4;
      const isCommand = r.fix.startsWith('specguard ');
      const suffix = !isCommand && r.claim !== undefined && !r.fix.includes(r.claim) ? ` (${code(r.claim)})` : '';
      const text = isCommand ? `${code(r.fix, { max: 200 })}` : `${r.fix.charAt(0).toUpperCase()}${r.fix.slice(1)}${suffix}.`;
      fixes.push({ priority, text });
    }
  }
  for (const ch of changes) {
    if (ch.verdict === 'pass' || !ch.capabilities.some(gated)) continue;
    if (ch.verdict === 'spike') {
      fixes.push({ priority: 8, text: `${code(`specguard change convert ${ch.id} --to feature`, { max: 200 })} — a spike cannot merge; make it a feature with approved requirements and tests.` });
      continue;
    }
    const needRed = ch.claims.filter((ref) => {
      const s = sensitivity.get(ref);
      return s !== undefined && s.kind === 'red-green' && s.status !== 'ok';
    });
    if (needRed.length > 0) {
      fixes.push({ priority: 3, text: `${code(`specguard change red ${ch.id}`, { max: 200 })} — make a test of ${needRed.length === 1 ? '' : 'each of '}${refList(needRed)} fail on the old code.` });
    }
  }
  for (const l of unrequested.lines) {
    if (l.class !== 'unrequested' || !gated(l.capability)) continue;
    fixes.push({ priority: 5, text: `Add a test for ${code(l.file)} ${rangesText(l.lines)} under a changed requirement, or remove the code.` });
  }
  const weakFiles = new Map<string, number>();
  for (const w of weakening) {
    if (w.severity !== 'error') continue;
    if (w.claims.length > 0 && !w.claims.some((r) => gated(capabilityOfRef(r)))) continue;
    weakFiles.set(w.file, (weakFiles.get(w.file) ?? 0) + 1);
  }
  for (const [file, n] of weakFiles) fixes.push({ priority: 6, text: `Undo the loosening in ${code(file)} (${plural(n, 'finding')}), or have a reviewer accept it.` });
  for (const w of unrequested.withoutChange) {
    const id = w.capabilities.find(gated);
    if (id === undefined) continue;
    fixes.push({ priority: 7, text: `${code(`specguard change start ${id}`, { max: 200 })} — cover the change to ${code(w.file)} with a change record.` });
  }
  const seen = new Set<string>();
  const orderedFixes = fixes
    .map((f, i) => ({ ...f, i }))
    .sort((a, b) => a.priority - b.priority || a.i - b.i)
    .map((f) => f.text)
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)));

  // ---- limits -------------------------------------------------------------
  const limits: string[] = [];
  if (meta.provisional) limits.push('provisional: a local run, not a CI result');
  if (!unrequested.claimable && codeChanged) limits.push('unrequested code could not be fully judged: no fresh claim-scoped line coverage (enable apps[].test.coverage and run the change tests with --coverage)');
  const unknownSens = evidence.filter((e) => e.sensitivity.kind !== 'none' && e.sensitivity.status === 'unknown').length;
  if (unknownSens > 0) limits.push(`sensitivity unknown for ${plural(unknownSens, 'requirement')}: no red-green or mutation result`);
  for (const id of [...touched].sort()) for (const l of capStatements.get(id)?.limits ?? []) limits.push(l);
  const uniqueLimits = [...new Set(limits.map((l) => scrub(l)))];

  return {
    schema: PACKET_SCHEMA,
    version: PACKET_VERSION,
    generated: meta.generated,
    head: meta.head,
    base: meta.base,
    ...(meta.baseRef !== undefined ? { baseRef: meta.baseRef } : {}),
    ...(meta.pr !== undefined ? { pr: meta.pr } : {}),
    ...(meta.run !== undefined ? { run: meta.run } : {}),
    tool: meta.tool,
    verdict,
    headline,
    intent,
    evidence,
    capabilities: capabilityVerdicts,
    changes: changes.map((c) => ({ ...c })),
    weakening,
    unrequested,
    pipeline: pipeline.map((c) => ({ ...c })),
    fixes: orderedFixes,
    limits: uniqueLimits,
    provisional: meta.provisional,
  };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every depth; `undefined` members are dropped, as `JSON.stringify` does. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 hex of the packet JSON in a stable key order. */
export function packetDigest(p: ProofPacket): string {
  return createHash('sha256').update(stableStringify(p)).digest('hex');
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const esc = (s: string, max: number = 200): string => escapeMarkdownForComment(s, max);

const TITLES: Record<PacketVerdict, string> = { ready: '✅ ready', blocked: '❌ blocked', advisory: '⚠️ advisory', 'no-change': '➖ no change' };
const CHANGE_ICON: Record<ClaimChange, string> = { added: '➕', modified: '✏️', removed: '➖' };
const MARK: Record<PillarStatus, string> = { ok: '✓', fail: '✗', unknown: '?' };
const EFFECT_TEXT: Record<CapabilityVerdict['effect'], string> = { blocks: '❌ blocks', warns: '⚠️ warns', none: '' };

/** How much of each section survives, tried in order until the comment fits. Capabilities and fixes are cut last. */
interface Level {
  rows: number;
  capabilities: number;
  fixes: number;
}
const LEVELS: Level[] = [
  { rows: Infinity, capabilities: Infinity, fixes: Infinity },
  { rows: 50, capabilities: Infinity, fixes: Infinity },
  { rows: 25, capabilities: Infinity, fixes: Infinity },
  { rows: 10, capabilities: Infinity, fixes: Infinity },
  { rows: 5, capabilities: Infinity, fixes: Infinity },
  { rows: 3, capabilities: Infinity, fixes: Infinity },
  { rows: 1, capabilities: Infinity, fixes: Infinity },
  { rows: 0, capabilities: 50, fixes: 20 },
  { rows: 0, capabilities: 10, fixes: 5 },
];

const more = (n: number): string => `<sub>+${n} more in packet.json</sub>`;

function approvalLabel(a: PacketApproval | undefined): string {
  if (!a || a.trust === 'missing') return '❌ not approved';
  const by = esc(a.by.replace(/^@/, ''), 60);
  const method = esc(a.method, 20);
  const date = a.date ? esc(a.date, 20) : '';
  switch (a.trust) {
    case 'verified': {
      const id = /\d+/.exec(a.source)?.[0];
      return `@${by} (PR review${id ? ` #${id}` : ''}${date ? `, ${date}` : ''})`;
    }
    case 'countersigned':
      return `${by} via ${method} ${esc(a.source, 80)}, countersigned by ${a.countersignedBy ? `@${esc(a.countersignedBy.replace(/^@/, ''), 60)}` : 'a reviewer'}`;
    case 'inherited':
      return `${by} (${method}${date ? `, ${date}` : ''}; merged earlier)`;
    case 'self-approved':
      return `${by} (${method}) — self-approved`;
    case 'recorded':
      return `⏳ ${by} (${method}) — needs a review`;
    default:
      return '❌ not approved';
  }
}

function sensitivityText(s: ClaimEvidence['sensitivity']): string {
  if (s.kind === 'none') return '—';
  if (s.kind === 'red-green') {
    if (s.status === 'ok') return s.redTests > 0 ? `red→green ✓ (${plural(s.redTests, 'test')} failed on base code)` : 'red→green ✓';
    if (s.status === 'fail') return '✗ passes on base code';
    return 'red→green ? (not run)';
  }
  const detail = [s.score !== null ? `${s.score}%` : undefined, `${s.killed} killed`].filter((x) => x !== undefined).join(', ');
  return `mutation ${s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '?'} (${detail})`;
}

function layersText(e: ClaimEvidence): string {
  if (e.layers.length === 0) return '—';
  return e.layers
    .map((l) => `${esc(l.layer, 30)} ${l.verdict === 'proven' ? '✓' : l.verdict === 'failed' || l.verdict === 'error' ? '✗' : '?'}${l.origin === 'local' ? ' (local)' : ''}`)
    .join(' · ');
}

function examplesText(e: ClaimEvidence): string {
  const { total, proven, failing } = e.examples;
  if (total === 0 && failing.length === 0) return '—';
  const ok = failing.length === 0 && proven >= total;
  return `${proven}/${total} ${ok ? '✓' : '✗'}${failing.length > 0 ? `: ${failing.slice(0, 3).map((f) => esc(f, 40)).join(', ')}` : ''}`;
}

function changeDetail(ch: ChangeVerdict, evidence: Map<string, ClaimEvidence>): string {
  const bits: string[] = [];
  if (ch.verdict === 'spike') bits.push('spike: cannot merge');
  else if (ch.verdict === 'fail') {
    for (const ref of ch.claims) {
      const e = evidence.get(ref);
      if (!e) continue;
      const s = e.sensitivity;
      if (s.kind === 'red-green' && s.status === 'fail') bits.push(`${code(ref)} has no failing test on base code`);
      else if (s.kind === 'red-green' && s.status === 'unknown') bits.push(`${code(ref)} has no red-green result yet`);
      else if (e.verdict !== 'pass') bits.push(`${code(ref)}: ${esc(e.reasons[0] ?? 'not proven', 80)}`);
    }
    if (bits.length === 0) bits.push('not validated');
  }
  if (ch.refactor) {
    const r = ch.refactor;
    const proven = r.claimsProvenBefore === r.claimsProvenAfter ? `${plural(r.claimsProvenBefore, 'claim')} proven before and after` : `${plural(r.claimsProvenBefore, 'claim')} proven before, ${r.claimsProvenAfter} after`;
    const parts = [`refactor: ${proven}`];
    if (r.changedLineCoverage !== null) parts.push(`changed lines ${r.changedLineCoverage}% covered by claim tests`);
    if (r.mutation) parts.push(`${r.mutation.killed}/${r.mutation.total} mutants killed`);
    bits.push(parts.join('; '));
  }
  if (ch.chronology) bits.push(`${esc(ch.chronology.note, 160)} (advisory)`);
  return bits.join('; ');
}

function capabilityRow(c: CapabilityVerdict): string {
  const effect = c.effect !== 'none' ? EFFECT_TEXT[c.effect] : c.verdict === 'pass' ? '✅ passes' : 'observed';
  return `| ${esc(c.capability, 80)} | ${esc(c.enforce, 12)} | ${PILLARS.map((p) => MARK[c.pillars[p]]).join(' | ')} | ${effect} |`;
}

const CAP_HEADER = ['| Capability | Enforce | Approved | Testable | Aligned | Conforms | Effect |', '|---|---|---|---|---|---|---|'];

function renderAt(p: ProofPacket, lv: Level, digest: string): string {
  const out: string[] = [];
  const cut = <T,>(items: T[], limit: number): { shown: T[]; rest: number } => ({ shown: items.slice(0, limit), rest: Math.max(0, items.length - limit) });
  const evidence = new Map(p.evidence.map((e) => [e.ref, e]));
  const effectOf = new Map(p.capabilities.map((c) => [c.capability, c.effect]));

  // Headline.
  const runUrl = p.run?.url !== undefined && /^https?:\/\/[^\s()<>[\]]+$/.test(p.run.url) ? p.run.url : undefined;
  const base = p.baseRef !== undefined ? `${p.baseRef}@${p.base.slice(0, 7)}` : p.base.slice(0, 7);
  const subParts = [
    `head ${code(p.head.slice(0, 7))}`,
    `base ${code(base)}`,
    ...(p.run ? [runUrl ? `run [#${esc(p.run.id, 40)}](${runUrl})` : `run #${esc(p.run.id, 40)}`] : []),
    `SpecGuard ${esc(p.tool, 40)}`,
  ];
  out.push([PACKET_MARKER, `## SpecGuard proof packet — ${TITLES[p.verdict] ?? esc(String(p.verdict), 20)}`, inline(p.headline, 500), `<sub>${subParts.join(' · ')}</sub>`].join('\n'));

  // What the requirements now say.
  if (p.intent.length > 0) {
    const { shown, rest } = cut(p.intent, lv.rows);
    const lines = [`### What the requirements now say (${p.intent.length})`, '| | Requirement | Now | Approved |', '|---|---|---|---|'];
    for (const i of shown) {
      const text = i.text !== undefined ? esc(i.text) : '';
      const was = i.baseText !== undefined ? `<sub>was: ${esc(i.baseText)}</sub>` : '';
      let now: string;
      if (i.change === 'added') now = text || '—';
      else if (i.change === 'removed') now = was || '—';
      else now = [text, was].filter((x) => x !== '').join(' <br>') || '—';
      lines.push(`| ${CHANGE_ICON[i.change] ?? '•'} | ${code(i.ref, { table: true })} | ${now} | ${approvalLabel(i.approval)} |`);
    }
    if (rest > 0) lines.push(more(rest));
    out.push(lines.join('\n'));
  }

  // Evidence.
  if (p.evidence.length > 0) {
    const { shown, rest } = cut(p.evidence, lv.rows);
    const lines = ['### Evidence for changed requirements', '| Requirement | Layers | Examples | Sensitivity | Tests | |', '|---|---|---|---|---|---|'];
    for (const e of shown) {
      lines.push(`| ${code(e.ref, { table: true })} | ${layersText(e)} | ${examplesText(e)} | ${sensitivityText(e.sensitivity)} | ${esc(e.strength, 20)} | ${e.verdict === 'pass' ? '✅' : e.verdict === 'fail' ? '❌' : '❔'} |`);
    }
    if (rest > 0) lines.push(more(rest));
    out.push(lines.join('\n'));
  }

  // Capabilities (always shown).
  {
    const rank = { blocks: 0, warns: 1, none: 2 } as const;
    const sorted = [...p.capabilities].sort((a, b) => (rank[a.effect] ?? 3) - (rank[b.effect] ?? 3));
    const observed = sorted.filter((c) => c.enforce === 'observe');
    const gated = sorted.filter((c) => c.enforce !== 'observe');
    const lines = ['### Capabilities'];
    if (p.capabilities.length === 0) lines.push('_No capability is touched by this change._');
    else {
      if (gated.length > 0) {
        const { shown, rest } = cut(gated, lv.capabilities);
        lines.push(...CAP_HEADER, ...shown.map(capabilityRow));
        if (rest > 0) lines.push(more(rest));
      }
      if (!p.capabilities.some((c) => c.enforce === 'enforce')) lines.push('<sub>No capability enforces yet: `specguard enforce raise <cap>`.</sub>');
      if (observed.length > 0) {
        const room = Math.max(0, lv.capabilities - gated.length);
        const { shown, rest } = cut(observed, room);
        lines.push('', `<details><summary>Observed (${observed.length}): not gated</summary>`, '', ...CAP_HEADER, ...shown.map(capabilityRow));
        if (rest > 0) lines.push(more(rest));
        lines.push('</details>');
      }
    }
    out.push(lines.join('\n'));
  }

  // Changes.
  {
    const items: string[] = [];
    for (const ch of p.changes) {
      const icon = ch.verdict === 'pass' ? '✅' : '❌';
      const detail = changeDetail(ch, evidence);
      items.push(`- ${code(ch.id)} (${esc(ch.kind, 20)}${ch.capabilities.length > 0 ? `, ${ch.capabilities.map((c) => esc(c, 60)).join(', ')}` : ''}): ${icon}${detail ? ` — ${detail}` : ''}`);
    }
    const groups = new Map<string, { capabilities: string[]; files: string[] }>();
    for (const w of p.unrequested.withoutChange) {
      const key = w.capabilities.join('\u0000');
      const g = groups.get(key) ?? { capabilities: w.capabilities, files: [] };
      g.files.push(w.file);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const icon = g.capabilities.some((c) => effectOf.get(c) === 'blocks') ? '❌' : '⚠️';
      const files = g.files.slice(0, 5).map((f) => esc(f, 120)).join(', ') + (g.files.length > 5 ? `, +${g.files.length - 5} more` : '');
      items.push(`- Code in ${g.capabilities.map((c) => code(c)).join(', ')} (${files}) is not covered by an open change ${icon}`);
    }
    if (items.length > 0) {
      const { shown, rest } = cut(items, lv.rows);
      out.push(['### Changes', ...shown, ...(rest > 0 ? [more(rest)] : [])].join('\n'));
    }
  }

  // Test weakening.
  if (p.weakening.length > 0) {
    const { shown, rest } = cut(p.weakening, lv.rows);
    const lines = [`### Test weakening (${p.weakening.length})`];
    for (const w of shown) {
      const where = code(w.line !== undefined ? `${w.file}:${w.line}` : w.file, { max: 160 });
      const detail = w.before !== undefined && w.after !== undefined ? `: ${code(w.before, { max: 80 })} → ${code(w.after, { max: 80 })}` : ` — ${esc(w.message, 200)}`;
      lines.push(`- ${w.severity === 'error' ? '❌' : '⚠️'} ${where} *${esc(w.kind, 40)}*${w.test !== undefined ? ` in "${esc(w.test, 80)}"` : ''}${detail}${w.claims.length > 0 ? ` (${w.claims.slice(0, 3).map((c) => esc(c, 80)).join(', ')}${w.claims.length > 3 ? ', …' : ''})` : ''}`);
    }
    if (rest > 0) lines.push(more(rest));
    out.push(lines.join('\n'));
  }

  // Unrequested code.
  if (p.unrequested.lines.length > 0) {
    const unrequestedCount = p.unrequested.lines.filter((l) => l.class === 'unrequested').reduce((n, l) => n + countLines(l), 0);
    const { shown, rest } = cut(p.unrequested.lines, lv.rows);
    const lines = [`### Code no requirement asked for${unrequestedCount > 0 ? ` (${plural(unrequestedCount, 'line')})` : ''}`];
    for (const l of shown) {
      const owner = effectOf.get(l.capability);
      const where = `${code(l.file, { max: 160 })} ${rangesText(l.lines)} (${esc(l.capability, 60)})`;
      if (l.class === 'unrequested') lines.push(`- ${owner === 'warns' || owner === 'none' ? '⚠️' : '❌'} ${where}: changed, reached by no test of a changed requirement`);
      else if (l.class === 'incidental') lines.push(`- ⚠️ ${where}: reached only by other requirements' tests`);
      else lines.push(`- ⚠️ ${where}: no fresh line coverage, so it cannot be judged`);
    }
    if (rest > 0) lines.push(more(rest));
    out.push(lines.join('\n'));
  }

  // Pipeline changes.
  if (p.pipeline.length > 0) {
    const { shown, rest } = cut(p.pipeline, lv.rows);
    out.push(['### Pipeline changes', ...shown.map((c) => `- ${c.severity === 'error' ? '❌' : '⚠️'} ${code(c.file, { max: 160 })} changed in this PR`), ...(rest > 0 ? [more(rest)] : [])].join('\n'));
  }

  // How to unblock.
  if (p.fixes.length > 0) {
    const { shown, rest } = cut(p.fixes, lv.fixes);
    const title = p.verdict === 'blocked' ? 'How to unblock' : 'How to resolve';
    out.push([`<details><summary>${title} (${p.fixes.length})</summary>`, '', ...shown.map((f, i) => `${i + 1}. ${inline(f, 400)}`), ...(rest > 0 ? [more(rest)] : []), '</details>'].join('\n'));
  }

  // Footer.
  {
    const limits = p.limits.slice(0, 10).map((l) => inline(l, 300).replace(/[.;]+$/, ''));
    const sentences: string[] = [];
    if (limits.length > 0) sentences.push(`Limits: ${limits.join('; ')}.`);
    if (!p.provisional) sentences.push(`Machine-readable packet: artifact \`specguard-evidence/ci/packet.json\` (sha256 \`${digest.slice(0, 12)}…\`).`);
    const lines: string[] = [];
    if (sentences.length > 0) lines.push(`<sub>${sentences.join(' ')}</sub>`);
    lines.push(`<!-- specguard-packet-sha256: ${digest} -->`);
    out.push(lines.join('\n'));
  }

  return out.join('\n\n');
}

/**
 * Markdown comment, sections with nothing to show omitted (except the headline and Capabilities), cut to `maxChars`
 * (default PACKET_MAX_CHARS, never more than GitHub's PACKET_GITHUB_LIMIT). Long tables lose rows from the end, in fixed
 * steps (50, 25, 10, 5, 3, 1, 0) until the whole comment fits; the headline, the Capabilities table and the fixes go last, and
 * the first line is always PACKET_MARKER so CI can update its comment in place.
 */
export function renderPacketMarkdown(p: ProofPacket, opts?: { maxChars?: number }): string {
  const max = Math.max(0, Math.min(opts?.maxChars ?? PACKET_MAX_CHARS, PACKET_GITHUB_LIMIT));
  const digest = packetDigest(p);
  for (const lv of LEVELS) {
    const md = renderAt(p, lv, digest);
    if (md.length <= max) return md;
  }
  const minimal = [PACKET_MARKER, `## SpecGuard proof packet — ${TITLES[p.verdict] ?? esc(String(p.verdict), 20)}`, inline(p.headline, 300), '<sub>Too long for one comment: the full packet is in packet.json.</sub>', `<!-- specguard-packet-sha256: ${digest} -->`].join('\n');
  return minimal.length <= max ? minimal : minimal.slice(0, max);
}
