/**
 * Testability lint: can a test, or a named verifier, say whether this claim holds?
 *
 * A claim worded "should work properly" has no oracle: any behaviour passes. The lint reads each claim of a v2
 * spec, its examples table, and the capability's `layers:`, `assurance:` and `evidence:` frontmatter, and reports
 * findings by rule. It is deterministic and pure: the same input gives the same output, and no model is involved.
 * Whole tokens are matched, never substrings, so `fast-tier` never matches `fast`.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import { ConfigInvalidError } from './errors.js';
import type { ExampleIssue, ExampleIssueCode, ExampleTable } from './examples.js';
import { requiredLayersFor, type TestLayer } from './test-layers.js';
import type {
  Assurance,
  EvidenceDeclaration,
  ParsedSpec,
  RuleSeverity,
  TestabilityConfig,
  TestabilityRuleId,
} from './types.js';

export type { RuleSeverity, TestabilityConfig, TestabilityRuleId } from './types.js';

export interface ResolvedTestabilityConfig {
  /** Severity per fixed rule: the default with the config's overrides applied. `T-EX-*` appear only when overridden. */
  severity: Record<string, RuleSeverity>;
  /** Tokenized phrases. */
  allow: string[][];
  deny: string[][];
  maxClauses: number;
  maxWords: number;
  waive: Record<string, TestabilityRuleId[]>;
}

export interface TestabilityFinding {
  rule: TestabilityRuleId;
  severity: 'error' | 'warn';
  /** `specKey#claimId`; absent for capability-level findings. */
  claim?: string;
  example?: string;
  /** All offending terms for this rule in this claim (one finding per rule per claim), in order of appearance. */
  matches: string[];
  message: string;
  /** Set when a `waive` entry downgraded this finding from error to warn. */
  waived?: boolean;
}

export interface ClaimLintInput {
  ref: string;
  /** Undefined for a bullet without an anchor. */
  id?: string;
  text: string;
  examples?: ExampleTable;
  exampleIssues: ExampleIssue[];
  required: TestLayer[];
  evidence?: EvidenceDeclaration;
  assurance: Assurance;
}

export interface ClaimTestability {
  ref: string;
  /** No finding of severity error, after waivers. */
  testable: boolean;
  findings: TestabilityFinding[];
}

export interface CapabilityTestability {
  capability: string;
  claims: ClaimTestability[];
  /** Unknown layers or assurance values, evidence keys naming no claim, and example problems not tied to a claim. */
  capabilityFindings: TestabilityFinding[];
  testable: boolean;
}

const DEFAULT_SEVERITY: Record<string, RuleSeverity> = {
  'T-NO-ANCHOR': 'error',
  'T-EMPTY': 'error',
  'T-PLACEHOLDER': 'error',
  'T-VAGUE': 'error',
  'T-OPEN-LIST': 'error',
  'T-DENY': 'error',
  'T-HEDGE': 'warn',
  'T-SUBJECTIVE': 'warn',
  'T-PASSIVE': 'warn',
  'T-NO-OUTCOME': 'warn',
  'T-COMPOUND': 'warn',
  'T-LONG': 'warn',
  'T-VARIES-NO-EXAMPLES': 'warn',
  'T-SUCH-AS': 'off',
  'T-EVIDENCE-VERIFIER': 'error',
  'T-EVIDENCE-LAYER-CONFLICT': 'error',
  'T-ASSURANCE-UNKNOWN': 'error',
  'T-LAYER-UNKNOWN': 'error',
};

const EXAMPLE_CODES: readonly ExampleIssueCode[] = [
  'EX-NO-SEPARATOR',
  'EX-NO-ID-COLUMN',
  'EX-BAD-ID',
  'EX-DUP-ID',
  'EX-CELL-COUNT',
  'EX-EMPTY',
  'EX-ORPHAN-TABLE',
  'EX-MULTIPLE-TABLES',
  'EX-CLAIM-NO-ID',
];

/** True for a rule id the lint knows: a fixed rule or `T-EX-` plus an example issue code. */
export function isTestabilityRuleId(id: string): id is TestabilityRuleId {
  if (id in DEFAULT_SEVERITY) return true;
  return id.startsWith('T-EX-') && (EXAMPLE_CODES as readonly string[]).includes(`EX-${id.slice('T-EX-'.length)}`);
}

// ---------------------------------------------------------------------------
// Text preprocessing
// ---------------------------------------------------------------------------

const CODE = '⟨code⟩';
const LIT = '⟨lit⟩';
const URL_TOKEN = '⟨url⟩';

interface Token {
  /** Original case, for the case-sensitive placeholder rule. */
  orig: string;
  lc: string;
  /** Index of the `;`/`,` segment the token sits in. */
  seg: number;
  /** Covered by an `allow` phrase: never matched. */
  masked: boolean;
}

/** Replace code spans, double-quoted literals and URLs with placeholders. */
function strip(text: string): string {
  return text
    .replace(/`[^`]*`/g, CODE)
    .replace(/"[^"]*"|“[^”]*”/g, LIT)
    .replace(/https?:\/\/[^\s)]+/g, URL_TOKEN);
}

const TOKEN_CHARS = /[\p{L}\p{N}_⟨⟩'’/-]+/gu;

/** Whole-word tokens: split on whitespace and punctuation except `-` and `/`, which join (`fast-tier`, `and/or`). */
function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(TOKEN_CHARS) ?? []) {
    const token = raw.replace(/^[-/'’]+|[-/'’]+$/g, '');
    if (token) out.push(token);
  }
  return out;
}

/** Split at `;` and `,` outside parentheses. Parenthesized content stays in its segment. */
function segments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ';' || ch === ',')) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Clauses: the text without parenthesized content, split on `;` and on `.` before whitespace and an upper-case letter. */
function clauses(text: string): string[] {
  let bare = text;
  for (let prev = ''; prev !== bare; ) {
    prev = bare;
    bare = bare.replace(/\([^()]*\)/g, ' ');
  }
  return bare
    .split(/;|\.(?=\s+\p{Lu})/u)
    .map((part) => part.trim())
    .filter((part) => words(part).length > 0);
}

// ---------------------------------------------------------------------------
// Term lists
// ---------------------------------------------------------------------------

/** Tokenize each phrase and order longest first, so a phrase wins over its first word. */
function terms(list: string[]): string[][] {
  return list
    .map((phrase) => words(phrase.toLowerCase()))
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length);
}

const VAGUE = terms([
  'properly', 'correctly', 'appropriate', 'appropriately', 'suitable', 'suitably', 'adequate', 'adequately',
  'reasonable', 'reasonably', 'sensible', 'sensibly', 'user-friendly', 'intuitive', 'intuitively', 'seamless',
  'seamlessly', 'gracefully', 'smoothly', 'nicely', 'robust', 'robustly', 'elegantly',
  'should work', 'works well', 'works fine', 'as expected', 'as intended', 'as appropriate', 'as needed',
  'if needed', 'if necessary', 'when necessary', 'where applicable', 'where appropriate', 'when appropriate',
  'is working', 'are working',
]);
const OPEN_LIST = terms(['etc', 'and so on', 'and so forth', 'and more', 'among others', 'not limited to', 'and/or']);
const HEDGE = terms([
  'should', 'might', 'could', 'ideally', 'preferably', 'hopefully', 'if possible', 'where possible',
  'as much as possible', 'as far as possible', 'try to', 'tries to', 'generally', 'usually', 'typically',
  'normally', 'mostly', 'often', 'sometimes', 'in most cases',
]);
const SUBJECTIVE = terms([
  'fast', 'faster', 'quick', 'quickly', 'slow', 'slowly', 'efficient', 'efficiently', 'performant', 'scalable',
  'responsive', 'lightweight', 'large', 'small', 'huge', 'tiny', 'many', 'few', 'several', 'numerous', 'high',
  'low', 'timely', 'promptly', 'minimal', 'significant', 'significantly', 'substantial', 'instant', 'instantly',
  'real-time', 'easy', 'easily', 'simple', 'simply', 'clean', 'cleanly', 'good', 'better', 'best', 'nice',
  'beautiful', 'modern', 'secure', 'securely',
]);
const SEVERITY_NOUNS = new Set(['severity', 'priority', 'risk', 'confidence']);
const PASSIVE = terms(
  ['is', 'are', 'be', 'being', 'been', 'get', 'gets', 'got'].flatMap((aux) =>
    [
      'handled', 'managed', 'supported', 'processed', 'dealt with', 'taken care of', 'addressed', 'respected',
      'considered', 'taken into account', 'accounted for',
    ].map((part) => `${aux} ${part}`),
  ),
);
const VARIES = terms([
  'depending on', 'depends on', 'varies by', 'varies with', 'varies across', 'differs by', 'differs per',
  'differs across', 'according to the', 'based on the',
]);
const SUCH_AS = terms(['such as', 'e.g.', 'for example', 'for instance', 'including']);
const PLACEHOLDER_WORDS = new Set(['TBD', 'TODO', 'FIXME', 'XXX']);
const NEGATIONS = new Set(['never', 'only', 'no', 'not']);

const OUTCOME_STEMS = `return exit write show display list report record reject refuse fail send store create delete remove print emit
respond redirect contain include equal set become raise throw log call run skip keep mark add replace read use
block allow deny accept receive open close start stop retry wait count match output generate produce render save
load update change warn mask redact appear navigate disable enable hide limit cap require ask prompt notify sort
filter group link resolve map merge split treat fall honour honor scan detect recognise recognize classify ignore
lock expire grant revoke authenticate authorize validate verify check compute calculate derive assign tag import
export upload download fetch post serve route forward queue schedule trigger invoke persist cache restore preserve
survive retain default work`.split(/\s+/);

/** Every inflection of the outcome stems the rule accepts, including e-drop, y-to-ies and doubled-consonant forms. */
const OUTCOME_FORMS: ReadonlySet<string> = (() => {
  const forms = new Set<string>(['sent', 'kept', 'became', 'fell', 'fallen']);
  for (const stem of OUTCOME_STEMS) {
    forms.add(stem);
    for (const suffix of ['s', 'es', 'ed', 'd', 'ing', 'n', 'ies', 'ied']) forms.add(stem + suffix);
    const last = stem[stem.length - 1];
    if (stem.endsWith('e')) {
      forms.add(`${stem.slice(0, -1)}ing`);
    } else if (stem.endsWith('y')) {
      forms.add(`${stem.slice(0, -1)}ies`);
      forms.add(`${stem.slice(0, -1)}ied`);
    } else {
      forms.add(`${stem}${last}ing`);
      forms.add(`${stem}${last}ed`);
    }
  }
  return forms;
})();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Merge a raw `testability` block over the defaults. Throws on an unknown rule id, in `rules` or in `waive`. */
export function resolveTestabilityConfig(raw?: TestabilityConfig): ResolvedTestabilityConfig {
  const severity: Record<string, RuleSeverity> = { ...DEFAULT_SEVERITY };
  for (const [rule, level] of Object.entries(raw?.rules ?? {})) {
    if (!isTestabilityRuleId(rule)) throw new ConfigInvalidError(`testability.rules names unknown rule '${rule}'`);
    if (level !== undefined) severity[rule] = level;
  }
  const waive: Record<string, TestabilityRuleId[]> = {};
  for (const [ref, rules] of Object.entries(raw?.waive ?? {})) {
    for (const rule of rules) {
      if (!isTestabilityRuleId(rule)) throw new ConfigInvalidError(`testability.waive['${ref}'] names unknown rule '${rule}'`);
    }
    waive[ref] = [...rules];
  }
  return {
    severity,
    allow: terms(raw?.allow ?? []),
    deny: terms(raw?.deny ?? []),
    maxClauses: raw?.maxClauses ?? 3,
    maxWords: raw?.maxWords ?? 80,
    waive,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface Occurrence {
  start: number;
  len: number;
  text: string;
}

/** Scan left to right; at each position the longest term wins and its tokens are consumed. Masked tokens never match. */
function findTerms(tokens: Token[], list: string[][]): Occurrence[] {
  const found: Occurrence[] = [];
  for (let i = 0; i < tokens.length; ) {
    const hit = list.find((term) => term.every((word, k) => tokens[i + k] !== undefined && !tokens[i + k].masked && tokens[i + k].lc === word));
    if (hit) {
      found.push({ start: i, len: hit.length, text: hit.join(' ') });
      i += hit.length;
    } else {
      i += 1;
    }
  }
  return found;
}

function tokenize(stripped: string, allow: string[][]): { tokens: Token[]; digitSegments: Set<number> } {
  const tokens: Token[] = [];
  const digitSegments = new Set<number>();
  segments(stripped).forEach((segment, seg) => {
    if (/\d/.test(segment)) digitSegments.add(seg);
    for (const orig of words(segment)) tokens.push({ orig, lc: orig.toLowerCase(), seg, masked: false });
  });
  for (const phrase of allow) {
    for (let i = 0; i < tokens.length; i += 1) {
      if (phrase.every((word, k) => tokens[i + k]?.lc === word)) phrase.forEach((_w, k) => (tokens[i + k].masked = true));
    }
  }
  return { tokens, digitSegments };
}

const MESSAGES: Record<string, string> = {
  'T-NO-ANCHOR': 'The requirement has no claim id, so it cannot be traced, tested or approved (run `specguard claims assign`).',
  'T-EMPTY': 'The claim is too short to state a checkable behaviour.',
  'T-PLACEHOLDER': 'The claim is a placeholder, not a finished statement.',
  'T-VAGUE': 'Outcome wording with no test oracle: any behaviour would pass.',
  'T-OPEN-LIST': 'An open-ended list cannot be checked for completeness; name every case.',
  'T-DENY': 'The claim uses a term this project does not allow.',
  'T-HEDGE': 'Hedged wording does not say what must hold.',
  'T-SUBJECTIVE': 'A subjective term with no number or example to test against.',
  'T-PASSIVE': 'Names an activity, not an observable outcome.',
  'T-NO-OUTCOME': 'No observable outcome: say what is returned, written, shown, rejected or never done.',
  'T-COMPOUND': 'More than one behaviour in one claim; split it so each can be proven alone.',
  'T-LONG': 'The claim is too long to read as one behaviour.',
  'T-VARIES-NO-EXAMPLES': 'The behaviour varies, but the claim has no examples table showing the cases.',
  'T-SUCH-AS': 'An illustrative list leaves the full set unstated.',
  'T-EVIDENCE-VERIFIER': 'Declared evidence needs a named verifier.',
  'T-EVIDENCE-LAYER-CONFLICT': 'Agentic or manual evidence never stands in for an automated layer.',
  'T-ASSURANCE-UNKNOWN': 'Assurance value is not on the ladder (tested, property, bounded, proved-model, proved-code).',
  'T-LAYER-UNKNOWN': 'Unknown test layer name in `layers:`.',
};

interface Hit {
  rule: TestabilityRuleId;
  matches: string[];
  message?: string;
}

/** The severity a rule ends up with for a claim after overrides and waivers, or undefined when it is off. */
function applySeverity(
  hit: Hit,
  base: 'error' | 'warn' | undefined,
  cfg: ResolvedTestabilityConfig,
  claim: string | undefined,
): TestabilityFinding | undefined {
  const level = cfg.severity[hit.rule] ?? base ?? 'off';
  if (level === 'off') return undefined;
  const finding: TestabilityFinding = {
    rule: hit.rule,
    severity: level,
    matches: hit.matches,
    message: hit.message ?? MESSAGES[hit.rule] ?? hit.rule,
  };
  if (claim) finding.claim = claim;
  if (level === 'error' && claim && cfg.waive[claim]?.includes(hit.rule)) {
    finding.severity = 'warn';
    finding.waived = true;
  }
  return finding;
}

const byRule = (a: TestabilityFinding, b: TestabilityFinding): number => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);

/** Findings for the example issues of one claim (or the unattached ones), one per rule, in line order. */
function exampleHits(issues: ExampleIssue[]): Array<Hit & { base: 'error' | 'warn' }> {
  const grouped = new Map<TestabilityRuleId, ExampleIssue[]>();
  for (const issue of issues) {
    const rule = `T-EX-${issue.code.slice(3)}` as TestabilityRuleId;
    grouped.set(rule, [...(grouped.get(rule) ?? []), issue]);
  }
  return [...grouped].map(([rule, list]) => ({
    rule,
    base: list[0].severity,
    matches: list.map((issue) => `line ${issue.line}`),
    message: list.map((issue) => issue.message).join(' '),
  }));
}

/** Lint one claim. Evaluation order: remove `allow` phrases, run the rules, apply severity overrides, apply waivers. */
export function lintClaim(input: ClaimLintInput, cfg: ResolvedTestabilityConfig): ClaimTestability {
  const stripped = strip(input.text);
  const { tokens, digitSegments } = tokenize(stripped, cfg.allow);
  const hasTable = (input.examples?.rows.length ?? 0) > 0;
  const hits: Array<Hit & { base?: 'error' | 'warn' }> = [];
  const add = (rule: TestabilityRuleId, matches: string[] = [], message?: string): void => {
    hits.push({ rule, matches, message });
  };
  const texts = (list: Occurrence[]): string[] => list.map((o) => o.text);

  if (input.id === undefined) add('T-NO-ANCHOR');

  const empty = tokens.length < 3;
  if (empty) add('T-EMPTY');

  const placeholders: string[] = [];
  for (const token of tokens) if (!token.masked && PLACEHOLDER_WORDS.has(token.orig)) placeholders.push(token.orig);
  for (const o of findTerms(tokens, terms(['lorem ipsum']))) placeholders.push(o.text);
  if (/\?{2,}/.test(stripped)) placeholders.push('??');
  if (placeholders.length > 0) add('T-PLACEHOLDER', placeholders);

  const vague = findTerms(tokens, VAGUE);
  if (vague.length > 0) add('T-VAGUE', texts(vague));

  const open = findTerms(tokens, OPEN_LIST);
  if (open.length > 0) add('T-OPEN-LIST', texts(open));

  const denied = findTerms(tokens, cfg.deny);
  if (denied.length > 0) add('T-DENY', texts(denied));

  // `should not` and `could not` are negations, not hedges.
  const hedges = findTerms(tokens, HEDGE).filter(
    (o) => !((o.text === 'should' || o.text === 'could') && tokens[o.start + 1]?.lc === 'not'),
  );
  if (hedges.length > 0) add('T-HEDGE', texts(hedges));

  const subjective = findTerms(tokens, SUBJECTIVE).filter((o) => {
    if (digitSegments.has(tokens[o.start].seg)) return false;
    const next = tokens[o.start + o.len]?.lc;
    return !((o.text === 'high' || o.text === 'low') && next !== undefined && SEVERITY_NOUNS.has(next));
  });
  if (subjective.length > 0) add('T-SUBJECTIVE', texts(subjective));

  const passive = findTerms(tokens, PASSIVE);
  if (passive.length > 0) add('T-PASSIVE', texts(passive));

  // A placeholder or empty claim is unfinished, so a missing outcome adds nothing to what is already reported.
  const outcome =
    hasTable ||
    empty ||
    placeholders.length > 0 ||
    /\d/.test(stripped) ||
    tokens.some((t) => t.lc === CODE || t.lc === LIT || NEGATIONS.has(t.lc) || t.lc.endsWith("n't") || OUTCOME_FORMS.has(t.lc));
  if (!outcome) add('T-NO-OUTCOME');

  const clauseCount = clauses(stripped).length;
  if (clauseCount > cfg.maxClauses) add('T-COMPOUND', [], `${MESSAGES['T-COMPOUND']} (${clauseCount} clauses, at most ${cfg.maxClauses}.)`);
  if (tokens.length > cfg.maxWords) add('T-LONG', [], `${MESSAGES['T-LONG']} (${tokens.length} words, at most ${cfg.maxWords}.)`);

  if (!hasTable) {
    const varies = findTerms(tokens, VARIES);
    if (varies.length > 0) add('T-VARIES-NO-EXAMPLES', texts(varies));
  }
  const suchAs = findTerms(tokens, SUCH_AS);
  if (suchAs.length > 0) add('T-SUCH-AS', texts(suchAs));

  for (const hit of exampleHits(input.exampleIssues)) hits.push(hit);

  if (input.evidence) {
    if (!input.evidence.verifier.trim()) add('T-EVIDENCE-VERIFIER');
    const conflict =
      input.evidence.kind === 'agentic' ? input.required.filter((layer) => layer !== 'functional') : input.required;
    if (conflict.length > 0) add('T-EVIDENCE-LAYER-CONFLICT', conflict);
  }

  const findings = hits
    .map((hit) => applySeverity(hit, hit.base, cfg, input.ref))
    .filter((f): f is TestabilityFinding => f !== undefined)
    .sort(byRule);
  return { ref: input.ref, testable: findings.every((f) => f.severity !== 'error'), findings };
}

/** Lint every claim of a v2 spec, plus its examples tables and `layers:`, `assurance:` and `evidence:` frontmatter. */
export function lintCapability(spec: ParsedSpec, cfg: ResolvedTestabilityConfig, projectLayers: TestLayer[]): CapabilityTestability {
  const capability = spec.specKey;
  if (spec.meta.kind === undefined) return { capability, claims: [], capabilityFindings: [], testable: true };

  const ids = new Set(spec.claims.flatMap((claim) => (claim.id ? [claim.id] : [])));
  const claims = spec.claims.map((claim, index) => {
    const id = claim.id;
    const ref = `${capability}#${id ?? `unanchored-${index + 1}`}`;
    return lintClaim(
      {
        ref,
        id,
        text: claim.text,
        examples: claim.examples,
        exampleIssues: id ? spec.exampleIssues.filter((issue) => issue.claimId === id) : [],
        required: id ? requiredLayersFor(id, spec.meta.layers, projectLayers) : projectLayers,
        evidence: id ? spec.meta.evidence?.[id] : undefined,
        assurance: (id ? spec.meta.assurance?.claims[id] : undefined) ?? spec.meta.assurance?.default ?? 'tested',
      },
      cfg,
    );
  });

  const hits: Array<Hit & { base?: 'error' | 'warn' }> = [];
  if (spec.meta.layers && spec.meta.layers.unknown.length > 0) {
    hits.push({ rule: 'T-LAYER-UNKNOWN', matches: [...spec.meta.layers.unknown] });
  }
  if (spec.meta.assurance && spec.meta.assurance.unknown.length > 0) {
    hits.push({ rule: 'T-ASSURANCE-UNKNOWN', matches: [...spec.meta.assurance.unknown] });
  }
  const orphanEvidence = Object.keys(spec.meta.evidence ?? {}).filter((key) => !ids.has(key));
  if (orphanEvidence.length > 0) {
    hits.push({ rule: 'T-EVIDENCE-VERIFIER', matches: orphanEvidence, message: 'An `evidence:` entry names no claim of this capability.' });
  }
  for (const hit of exampleHits(spec.exampleIssues.filter((issue) => !issue.claimId || !ids.has(issue.claimId)))) hits.push(hit);

  const capabilityFindings = hits
    .map((hit) => applySeverity(hit, hit.base, cfg, undefined))
    .filter((f): f is TestabilityFinding => f !== undefined)
    .sort(byRule);
  return {
    capability,
    claims,
    capabilityFindings,
    testable: capabilityFindings.every((f) => f.severity !== 'error') && claims.every((c) => c.testable),
  };
}
