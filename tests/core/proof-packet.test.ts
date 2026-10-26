import { describe, expect, it } from 'vitest';

import type { ChangedClaim } from '../../src/core/change-claims.js';
import {
  APPROVAL_TRUSTS,
  PACKET_GITHUB_LIMIT,
  PACKET_MARKER,
  PACKET_MAX_CHARS,
  buildPacket,
  escapeMarkdownForComment,
  packetDigest,
  renderPacketMarkdown,
  type ChangeVerdict,
  type ClaimEvidence,
  type PacketApproval,
  type PacketInput,
  type ProofPacket,
} from '../../src/core/proof-packet.js';
import type { CapabilityStatement, ClaimStatement, PillarName, PillarStatus, Reason, SystemStatement } from '../../src/core/proof-statement.js';
import type { UnrequestedReport } from '../../src/core/unrequested.js';
import type { EnforceLevel } from '../../src/core/types.js';
import type { WeakeningFinding } from '../../src/core/weakening.js';

// ---- fixture builders -------------------------------------------------------

type Pillars = Record<PillarName, PillarStatus>;
const allOk: Pillars = { approved: 'ok', testable: 'ok', aligned: 'ok', conforms: 'ok' };
const pillars = (over: Partial<Pillars> = {}): Pillars => ({ ...allOk, ...over });

const claim = (ref: string, over: Partial<Pillars> = {}, reasons: Reason[] = []): ClaimStatement => ({ ref, pillars: pillars(over), reasons });

const reason = (code: Reason['code'], pillar: PillarName, extra: Partial<Reason> = {}): Reason => ({
  code,
  pillar,
  outcome: 'fail',
  gate: 'never',
  blocking: true,
  message: `${code} message`,
  ...extra,
});

const capStatement = (id: string, p: Pillars, claims: ClaimStatement[] = [], extra: Partial<CapabilityStatement> = {}): CapabilityStatement => {
  const verdict = (name: PillarName): CapabilityStatement['pillars'][PillarName] => ({ status: p[name], reasons: [], summary: '' });
  return {
    capability: id,
    title: id,
    status: 'active',
    level: 'not-certified',
    pillars: { approved: verdict('approved'), testable: verdict('testable'), aligned: verdict('aligned'), conforms: verdict('conforms') },
    blocking: [],
    claims,
    metrics: { claims: claims.length, approved: 0, testable: 0, proven: 0, meaningful: null, lineCoverage: null, diffCoverage: null, mutationScore: null },
    evidence: { origins: [], shas: [] },
    headline: '',
    ...extra,
  };
};

const statementOf = (...capabilities: CapabilityStatement[]): SystemStatement => ({
  version: 1,
  generated: '2026-10-25T12:00:00.000Z',
  policy: {} as SystemStatement['policy'],
  level: 'not-certified',
  capabilities,
  system: { reasons: [] },
  counts: { certified: 0, provisional: 0, 'not-certified': 0, planned: 0 },
  exitCode: 0,
});

const emptyUnrequested = (over: Partial<UnrequestedReport> = {}): UnrequestedReport => ({
  lines: [],
  withoutChange: [],
  claimable: true,
  diffCoverage: { changedExecutable: 0, hitByChangeTests: 0, pct: null },
  ...over,
});

const changedClaim = (ref: string, change: ChangedClaim['change'], text?: string, baseText?: string, extra: Partial<ChangedClaim> = {}): ChangedClaim => ({
  ref,
  capability: ref.split('#')[0]!.split('/').pop()!,
  change,
  ...(text !== undefined ? { text } : {}),
  ...(baseText !== undefined ? { baseText } : {}),
  ...extra,
});

const approval = (trust: PacketApproval['trust'], over: Partial<PacketApproval> = {}): PacketApproval => ({
  method: 'plan',
  by: 'wes',
  trust,
  source: '2026-10-25-checkout-plan',
  date: '2026-10-25',
  ...over,
});

const META: PacketInput['meta'] = {
  generated: '2026-10-25T12:00:00.000Z',
  head: 'abc1234def5678',
  base: 'def5678abc1234',
  baseRef: 'main',
  run: { id: '4711', url: 'https://github.com/o/r/actions/runs/4711' },
  tool: '0.6.0',
  provisional: false,
};

const input = (over: Partial<PacketInput> = {}): PacketInput => ({
  statement: statementOf(),
  changed: [],
  approvals: new Map(),
  sensitivity: new Map(),
  changes: [],
  weakening: [],
  unrequested: emptyUnrequested(),
  pipeline: [],
  enforce: new Map(),
  meta: META,
  policy: { unrequested: 'error' },
  ...over,
});

/** The design's example: `cart` blocks at enforce, `billing` warns. */
function goldenInput(): PacketInput {
  const weakened: WeakeningFinding = {
    kind: 'assertion-weakened',
    severity: 'error',
    file: 'tests/cart/total.test.ts',
    line: 41,
    test: 'sums line prices',
    claims: ['cart#total'],
    before: 'toBe(42)',
    after: 'toBeGreaterThan(0)',
    message: 'assertion weakened',
  };
  const change: ChangeVerdict = { id: '20261025-free-shipping-a1b2', kind: 'feature', capabilities: ['cart'], verdict: 'fail', claims: ['cart#free-shipping', 'cart#total'] };
  return input({
    statement: statementOf(
      capStatement('cart', pillars({ approved: 'fail', aligned: 'fail' }), [claim('cart#free-shipping'), claim('cart#total', { approved: 'fail' }), claim('cart#legacy-coupon')], {
        limits: ['mutation not configured', 'sensitivity is red→green by construction'],
      }),
      capStatement('billing', pillars({ aligned: 'unknown' })),
    ),
    changed: [
      changedClaim('cart#free-shipping', 'added', 'Orders of $50.00 or more ship free.'),
      changedClaim('cart#total', 'modified', 'The total is the sum of line prices minus discounts.', 'The total is the sum of line prices.', { parts: ['text'] }),
      changedClaim('cart#legacy-coupon', 'removed', undefined, 'A LEGACY10 code takes 10% off.'),
    ],
    approvals: new Map([
      ['cart#free-shipping', approval('verified', { method: 'pr', by: 'alice', source: 'review' })],
      ['cart#total', approval('recorded')],
      ['cart#legacy-coupon', approval('verified', { method: 'pr', by: 'alice', source: 'review', date: '' })],
    ]),
    sensitivity: new Map<string, ClaimEvidence['sensitivity']>([
      ['cart#free-shipping', { kind: 'red-green', status: 'ok', redTests: 2 }],
      ['cart#total', { kind: 'red-green', status: 'fail', redTests: 0 }],
    ]),
    changes: [change],
    weakening: [weakened],
    unrequested: emptyUnrequested({
      lines: [
        { file: 'src/cart/total.ts', capability: 'cart', lines: [[40, 41]], class: 'unrequested' },
        { file: 'src/cart/round.ts', capability: 'cart', lines: [[12, 12]], class: 'incidental' },
      ],
      withoutChange: [{ file: 'src/billing/tax.ts', capabilities: ['billing'] }],
      diffCoverage: { changedExecutable: 10, hitByChangeTests: 7, pct: 70 },
    }),
    pipeline: [{ file: '.github/workflows/specguard.yml', kind: 'workflow', severity: 'warn' }],
    enforce: new Map<string, EnforceLevel>([['cart', 'enforce'], ['billing', 'warn']]),
  });
}


/** A second fixture: provisional (local), one capability that warns, one only observed, nothing enforced. */
function localInput(): PacketInput {
  return input({
    statement: statementOf(
      capStatement('cart', pillars(), [claim('cart#fee')]),
      capStatement('legacy', pillars({ conforms: 'fail' }), [claim('legacy#old', { conforms: 'fail' }, [reason('CLAIM_FAILED', 'conforms', { claim: 'legacy#old', fix: 'specguard test run' })])]),
    ),
    changed: [changedClaim('cart#fee', 'added', 'A fee of 2% applies.'), changedClaim('legacy#old', 'modified', 'Old rule, now stricter.', 'Old rule.')],
    approvals: new Map([['cart#fee', approval('self-approved', { method: 'command', source: 'e1' })], ['legacy#old', approval('missing')]]),
    sensitivity: new Map<string, ClaimEvidence['sensitivity']>([['cart#fee', { kind: 'mutation', status: 'ok', score: 85, killed: 6 }]]),
    unrequested: emptyUnrequested({ lines: [{ file: 'src/cart/fee.ts', capability: 'cart', lines: [[3, 3], [9, 10]], class: 'incidental' }], diffCoverage: { changedExecutable: 6, hitByChangeTests: 3, pct: 50 } }),
    enforce: new Map<string, EnforceLevel>([['cart', 'warn']]),
    meta: { ...META, baseRef: undefined, run: undefined, provisional: true },
  });
}


const SPEC = 'capabilities/spec-first-changes';
const verdictOf = (over: Partial<PacketInput>): ProofPacket => buildPacket(input(over));
const capOf = (p: ProofPacket, id: string): ProofPacket['capabilities'][number] => p.capabilities.find((c) => c.capability === id)!;

/** One changed claim in `cart`, with the statement and approval of a passing capability, plus overrides. */
const cartInput = (over: Partial<PacketInput> = {}, level: EnforceLevel = 'enforce', pillarOver: Partial<Pillars> = {}): PacketInput =>
  input({
    statement: statementOf(capStatement('cart', pillars(pillarOver), [claim('cart#fee', pillarOver)])),
    changed: [changedClaim('cart#fee', 'added', 'A fee applies.')],
    approvals: new Map([['cart#fee', approval('verified', { method: 'pr', by: 'alice', source: 'review 7' })]]),
    sensitivity: new Map<string, ClaimEvidence['sensitivity']>([['cart#fee', { kind: 'red-green', status: 'ok', redTests: 1 }]]),
    enforce: new Map<string, EnforceLevel>([['cart', level]]),
    ...over,
  });

describe('renderPacketMarkdown golden files', () => {
  // [claims: capabilities/spec-first-changes#packet-sections]
  it('markdown golden file for the design example (cart blocks, billing warns)', () => {
    const p = buildPacket(goldenInput());
    const d = packetDigest(p);
    const expected = `<!-- specguard-proof-packet v1 -->
## SpecGuard proof packet — ❌ blocked
\`cart\` blocks the merge: 1 claim not approved, 2 changed lines no claim test reaches.
<sub>head \`abc1234\` · base \`main@def5678\` · run [#4711](https://github.com/o/r/actions/runs/4711) · SpecGuard 0.6.0</sub>

### What the requirements now say (3)
| | Requirement | Now | Approved |
|---|---|---|---|
| ➕ | \`cart#free-shipping\` | Orders of $50.00 or more ship free. | @alice (PR review, 2026-10-25) |
| ✏️ | \`cart#total\` | The total is the sum of line prices minus discounts. <br><sub>was: The total is the sum of line prices.</sub> | ⏳ wes (plan) — needs a review |
| ➖ | \`cart#legacy-coupon\` | <sub>was: A LEGACY10 code takes 10% off.</sub> | @alice (PR review) |

### Evidence for changed requirements
| Requirement | Layers | Examples | Sensitivity | Tests | |
|---|---|---|---|---|---|
| \`cart#free-shipping\` | — | — | red→green ✓ (2 tests failed on base code) | strong | ✅ |
| \`cart#total\` | — | — | ✗ passes on base code | strong | ❌ |

### Capabilities
| Capability | Enforce | Approved | Testable | Aligned | Conforms | Effect |
|---|---|---|---|---|---|---|
| cart | enforce | ✗ | ✓ | ✗ | ✓ | ❌ blocks |
| billing | warn | ✓ | ✓ | ? | ✓ | ⚠️ warns |

### Changes
- \`20261025-free-shipping-a1b2\` (feature, cart): ❌ — \`cart#total\` has no failing test on base code
- Code in \`billing\` (src/billing/tax.ts) is not covered by an open change ⚠️

### Test weakening (1)
- ❌ \`tests/cart/total.test.ts:41\` *assertion-weakened* in "sums line prices": \`toBe(42)\` → \`toBeGreaterThan(0)\` (cart#total)

### Code no requirement asked for (2 lines)
- ❌ \`src/cart/total.ts\` lines 40–41 (cart): changed, reached by no test of a changed requirement
- ⚠️ \`src/cart/round.ts\` line 12 (cart): reached only by other requirements' tests

### Pipeline changes
- ⚠️ \`.github/workflows/specguard.yml\` changed in this PR

<details><summary>How to unblock (5)</summary>

1. A reviewer approves this PR (the approval covers \`cart#total\` at its current wording).
2. \`specguard change red 20261025-free-shipping-a1b2\` — make a test of \`cart#total\` fail on the old code.
3. Add a test for \`src/cart/total.ts\` lines 40–41 under a changed requirement, or remove the code.
4. Undo the loosening in \`tests/cart/total.test.ts\` (1 finding), or have a reviewer accept it.
5. \`specguard change start billing\` — cover the change to \`src/billing/tax.ts\` with a change record.
</details>

<sub>Limits: mutation not configured; sensitivity is red→green by construction. Machine-readable packet: artifact \`specguard-evidence/ci/packet.json\` (sha256 \`${d.slice(0, 12)}…\`).</sub>
<!-- specguard-packet-sha256: ${d} -->`;
    expect(renderPacketMarkdown(p)).toBe(expected);
  });

  // [claims: capabilities/spec-first-changes#packet-sections]
  it('markdown golden file for a provisional local packet: warns, observed capabilities collapsed, nothing enforced', () => {
    const p = buildPacket(localInput());
    const d = packetDigest(p);
    const expected = `<!-- specguard-proof-packet v1 -->
## SpecGuard proof packet — ⚠️ advisory
(local, provisional) \`cart\` warns (the merge is not blocked): 3 changed lines reached only by other requirements' tests.
<sub>head \`abc1234\` · base \`def5678\` · SpecGuard 0.6.0</sub>

### What the requirements now say (2)
| | Requirement | Now | Approved |
|---|---|---|---|
| ➕ | \`cart#fee\` | A fee of 2% applies. | wes (command) — self-approved |
| ✏️ | \`legacy#old\` | Old rule, now stricter. <br><sub>was: Old rule.</sub> | ❌ not approved |

### Evidence for changed requirements
| Requirement | Layers | Examples | Sensitivity | Tests | |
|---|---|---|---|---|---|
| \`cart#fee\` | — | — | mutation ✓ (85%, 6 killed) | strong | ✅ |
| \`legacy#old\` | — | — | — | strong | ❌ |

### Capabilities
| Capability | Enforce | Approved | Testable | Aligned | Conforms | Effect |
|---|---|---|---|---|---|---|
| cart | warn | ✓ | ✓ | ✓ | ✓ | ⚠️ warns |
<sub>No capability enforces yet: \`specguard enforce raise <cap>\`.</sub>

<details><summary>Observed (1): not gated</summary>

| Capability | Enforce | Approved | Testable | Aligned | Conforms | Effect |
|---|---|---|---|---|---|---|
| legacy | observe | ✓ | ✓ | ✓ | ✗ | observed |
</details>

### Code no requirement asked for
- ⚠️ \`src/cart/fee.ts\` lines 3, 9–10 (cart): reached only by other requirements' tests

<sub>Limits: provisional: a local run, not a CI result.</sub>
<!-- specguard-packet-sha256: ${d} -->`;
    expect(renderPacketMarkdown(p)).toBe(expected);
  });

  // [claims: capabilities/spec-first-changes#packet-sections]
  it('markdown golden file for an empty change: headline and Capabilities only', () => {
    const p = buildPacket(input());
    const d = packetDigest(p);
    expect(renderPacketMarkdown(p)).toBe(`<!-- specguard-proof-packet v1 -->
## SpecGuard proof packet — ➖ no change
No requirement, owned code or test change to judge.
<sub>head \`abc1234\` · base \`main@def5678\` · run [#4711](https://github.com/o/r/actions/runs/4711) · SpecGuard 0.6.0</sub>

### Capabilities
_No capability is touched by this change._

<sub>Machine-readable packet: artifact \`specguard-evidence/ci/packet.json\` (sha256 \`${d.slice(0, 12)}…\`).</sub>
<!-- specguard-packet-sha256: ${d} -->`);
  });

  // [claims: capabilities/spec-first-changes#packet-sections]
  it('sections with nothing to show are omitted; the packet JSON carries the same facts', () => {
    const p = buildPacket(cartInput());
    const md = renderPacketMarkdown(p);
    expect(md).toContain('### What the requirements now say (1)');
    expect(md).toContain('### Evidence for changed requirements');
    expect(md).toContain('### Capabilities');
    for (const omitted of ['### Changes', '### Test weakening', '### Code no requirement asked for', '### Pipeline changes', 'How to unblock', 'How to resolve']) expect(md).not.toContain(omitted);
    expect(p.schema).toBe('specguard.proof-packet');
    expect(p.version).toBe(1);
    expect(p.verdict).toBe('ready');
    expect(p.headline).toBe('1 changed requirement approved and proven.');
  });

  // [claims: capabilities/spec-first-changes#packet-sections]
  it('evidence rows come from the statement reasons: failing examples, weak strength, missing layers, mutation', () => {
    const reasons = [
      reason('EXAMPLE_FAILED', 'conforms', { claim: 'cart#fee', example: 'r2' }),
      reason('WEAK_ONLY', 'conforms', { claim: 'cart#fee' }),
      reason('LAYER_MISSING', 'conforms', { claim: 'cart#fee', outcome: 'unknown', data: { layer: 'e2e' } }),
    ];
    const p = buildPacket(
      cartInput({
        statement: statementOf(capStatement('cart', pillars({ conforms: 'fail' }), [claim('cart#fee', { conforms: 'fail' }, reasons)])),
        changed: [changedClaim('cart#fee', 'added', 'A fee applies.'), changedClaim('cart#fee/r1', 'added', 'row 1'), changedClaim('cart#fee/r2', 'added', 'row 2')],
        sensitivity: new Map<string, ClaimEvidence['sensitivity']>([['cart#fee', { kind: 'mutation', status: 'fail', score: 40, killed: 1 }]]),
      }),
    );
    expect(p.evidence).toEqual([
      {
        ref: 'cart#fee',
        layers: [{ layer: 'e2e', verdict: 'unproven', origin: 'ci' }],
        examples: { total: 2, proven: 1, failing: ['r2'] },
        sensitivity: { kind: 'mutation', status: 'fail', score: 40, killed: 1 },
        strength: 'weak',
        verdict: 'fail',
        reasons: expect.any(Array),
      },
    ]);
    const md = renderPacketMarkdown(p);
    expect(md).toContain('| `cart#fee` | e2e ? | 1/2 ✗: r2 | mutation ✗ (40%, 1 killed) | weak | ❌ |');
    expect(p.evidence[0]!.reasons.length).toBe(3);
  });
});

describe('verdicts', () => {
  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('verdict blocked/advisory/ready/no-change rules', () => {
    expect(verdictOf({}).verdict).toBe('no-change');
    expect(buildPacket(cartInput()).verdict).toBe('ready');
    expect(buildPacket(cartInput({}, 'enforce', { approved: 'fail' })).verdict).toBe('blocked');
    expect(buildPacket(cartInput({}, 'warn', { approved: 'fail' })).verdict).toBe('advisory');
    expect(buildPacket(cartInput({}, 'observe', { approved: 'fail' })).verdict).toBe('ready');
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('enforce unknown blocks; warn fail warns; observe collapses', () => {
    const unknown = buildPacket(cartInput({}, 'enforce', { conforms: 'unknown' }));
    expect(capOf(unknown, 'cart')).toMatchObject({ verdict: 'unknown', effect: 'blocks' });
    expect(unknown.verdict).toBe('blocked');

    const warn = buildPacket(cartInput({}, 'warn', { conforms: 'fail' }));
    expect(capOf(warn, 'cart')).toMatchObject({ verdict: 'fail', effect: 'warns' });

    const warnUnknown = buildPacket(cartInput({}, 'warn', { conforms: 'unknown' }));
    expect(capOf(warnUnknown, 'cart')).toMatchObject({ verdict: 'unknown', effect: 'warns' });

    const observed = buildPacket(cartInput({}, 'observe', { conforms: 'fail' }));
    expect(capOf(observed, 'cart')).toMatchObject({ verdict: 'fail', effect: 'none' });
    const md = renderPacketMarkdown(observed);
    expect(md).toContain('<details><summary>Observed (1): not gated</summary>');
    expect(md.indexOf('| cart | observe')).toBeGreaterThan(md.indexOf('<details><summary>Observed'));
    // A capability with no declared level is observed.
    expect(capOf(buildPacket(cartInput({ enforce: new Map() })), 'cart').enforce).toBe('observe');
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('only the changed claims count: an unchanged failing claim does not fail the capability', () => {
    const p = buildPacket(
      cartInput({
        statement: statementOf(
          capStatement('cart', pillars({ conforms: 'fail' }), [claim('cart#fee'), claim('cart#other', { conforms: 'fail' })], {
            blocking: [reason('CLAIM_FAILED', 'conforms', { claim: 'cart#other' })],
          }),
        ),
      }),
    );
    expect(capOf(p, 'cart')).toMatchObject({ verdict: 'pass', effect: 'none', blocking: [] });
    expect(p.verdict).toBe('ready');
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('error-level weakening, a change that did not pass and a spike fail the capability; warn-level weakening only warns', () => {
    const w = (severity: 'error' | 'warn'): WeakeningFinding => ({ kind: 'skip-added', severity, file: 'tests/a.test.ts', claims: ['cart#fee'], message: 'skip added' });
    expect(capOf(buildPacket(cartInput({ weakening: [w('error')] })), 'cart')).toMatchObject({ verdict: 'fail', effect: 'blocks' });
    const warned = buildPacket(cartInput({ weakening: [w('warn')] }));
    expect(capOf(warned, 'cart')).toMatchObject({ verdict: 'pass', effect: 'warns' });
    expect(warned.verdict).toBe('advisory');

    const change = (verdict: ChangeVerdict['verdict']): ChangeVerdict => ({ id: 'c1', kind: verdict === 'spike' ? 'spike' : 'feature', capabilities: ['cart'], verdict, claims: ['cart#fee'] });
    expect(buildPacket(cartInput({ changes: [change('pass')] })).verdict).toBe('ready');
    expect(buildPacket(cartInput({ changes: [change('fail')] })).verdict).toBe('blocked');
    const spike = buildPacket(cartInput({ changes: [change('spike')] }));
    expect(spike.verdict).toBe('blocked');
    expect(spike.fixes).toContain('`specguard change convert c1 --to feature` — a spike cannot merge; make it a feature with approved requirements and tests.');
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('precedence: blocked beats advisory beats ready beats no-change', () => {
    const blockedAndWarn = input({
      statement: statementOf(capStatement('cart', pillars({ approved: 'fail' })), capStatement('billing', pillars({ aligned: 'unknown' }))),
      changed: [changedClaim('cart#fee', 'added', 'x')],
      unrequested: emptyUnrequested({ withoutChange: [{ file: 'src/billing/tax.ts', capabilities: ['billing'] }] }),
      enforce: new Map<string, EnforceLevel>([['cart', 'enforce'], ['billing', 'warn']]),
    });
    expect(buildPacket(blockedAndWarn).verdict).toBe('blocked');
    expect(buildPacket(blockedAndWarn).capabilities.map((c) => c.effect)).toEqual(['blocks', 'warns']);
    // A pipeline file at error severity makes an otherwise ready packet advisory; at warn severity it does not.
    expect(buildPacket(cartInput({ pipeline: [{ file: '.github/workflows/x.yml', kind: 'workflow', severity: 'error' }] })).verdict).toBe('advisory');
    expect(buildPacket(cartInput({ pipeline: [{ file: '.github/workflows/x.yml', kind: 'workflow', severity: 'warn' }] })).verdict).toBe('ready');
    // A change that touches only a pipeline file is not "no change".
    expect(verdictOf({ pipeline: [{ file: 'a', kind: 'workflow', severity: 'warn' }] }).verdict).toBe('ready');
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('a removed claim alone passes (nothing is left to prove); code with no change record fails its capability', () => {
    const removed = buildPacket(
      input({ statement: statementOf(capStatement('cart', pillars())), changed: [changedClaim('cart#old', 'removed', undefined, 'Old.')], enforce: new Map<string, EnforceLevel>([['cart', 'enforce']]) }),
    );
    expect(removed.verdict).toBe('ready');
    expect(removed.evidence).toEqual([]);
    const noRecord = buildPacket(
      input({
        statement: statementOf(capStatement('billing', pillars())),
        unrequested: emptyUnrequested({ withoutChange: [{ file: 'src/billing/tax.ts', capabilities: ['billing'] }] }),
        enforce: new Map<string, EnforceLevel>([['billing', 'enforce']]),
      }),
    );
    expect(noRecord.verdict).toBe('blocked');
    expect(capOf(noRecord, 'billing').blocking.map((b) => b.code)).toEqual(['CODE_WITHOUT_CHANGE']);
    expect(noRecord.fixes).toEqual(['`specguard change start billing` — cover the change to `src/billing/tax.ts` with a change record.']);
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('an error-level weakening that names no claim applies to every touched capability', () => {
    const p = buildPacket(
      cartInput({ weakening: [{ kind: 'config-weakened', severity: 'error', file: '.specguard/config.json', claims: [], message: 'threshold lowered' }] }),
    );
    expect(capOf(p, 'cart')).toMatchObject({ verdict: 'fail', effect: 'blocks' });
    const alone = buildPacket(
      input({
        statement: statementOf(capStatement('cart', pillars())),
        weakening: [{ kind: 'config-weakened', severity: 'error', file: '.specguard/config.json', claims: [], message: 'threshold lowered' }],
        enforce: new Map<string, EnforceLevel>([['cart', 'enforce']]),
      }),
    );
    expect(alone.verdict).toBe('blocked');
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('fixes are deduplicated and ordered by precedence: approvals, tests, red, code, weakening, change record', () => {
    const p = buildPacket(goldenInput());
    expect(p.fixes).toEqual([
      'A reviewer approves this PR (the approval covers `cart#total` at its current wording).',
      '`specguard change red 20261025-free-shipping-a1b2` — make a test of `cart#total` fail on the old code.',
      'Add a test for `src/cart/total.ts` lines 40–41 under a changed requirement, or remove the code.',
      'Undo the loosening in `tests/cart/total.test.ts` (1 finding), or have a reviewer accept it.',
      '`specguard change start billing` — cover the change to `src/billing/tax.ts` with a change record.',
    ]);
    // The same statement fix raised by two claims appears once, and a testable fix precedes a conforms fix.
    const dup = buildPacket(
      cartInput({
        statement: statementOf(
          capStatement('cart', pillars({ conforms: 'fail', testable: 'fail' }), [claim('cart#fee', { conforms: 'fail', testable: 'fail' })], {
            blocking: [
              reason('CLAIM_UNPROVEN', 'conforms', { claim: 'cart#fee', fix: 'specguard test run' }),
              reason('LINT_ERROR', 'testable', { claim: 'cart#fee', fix: 'rewrite the claim as an observable behaviour' }),
              reason('CLAIM_STALE', 'conforms', { claim: 'cart#fee', fix: 'specguard test run' }),
            ],
          }),
        ),
      }),
    );
    expect(dup.fixes).toEqual(['Rewrite the claim as an observable behaviour (`cart#fee`).', '`specguard test run`']);
  });

  // [claims: capabilities/spec-first-changes#packet-verdict]
  it('the headline names the blocking capabilities and the first two causes; provisional packets are marked', () => {
    expect(buildPacket(goldenInput()).headline).toBe('`cart` blocks the merge: 1 claim not approved, 2 changed lines no claim test reaches.');
    const two = buildPacket(
      input({
        statement: statementOf(capStatement('a', pillars({ conforms: 'fail' }), [claim('a#x', { conforms: 'fail' })]), capStatement('b', pillars({ testable: 'fail' }), [claim('b#y', { testable: 'fail' })])),
        changed: [changedClaim('a#x', 'added', 'x'), changedClaim('b#y', 'added', 'y')],
        enforce: new Map<string, EnforceLevel>([['a', 'enforce'], ['b', 'enforce']]),
        meta: { ...META, provisional: true },
      }),
    );
    expect(two.headline).toBe('(local, provisional) `a` and `b` block the merge: 1 claim not testable, 1 claim not proven.');
    expect(buildPacket(cartInput({}, 'enforce', { conforms: 'unknown' })).headline).toBe('`cart` blocks the merge: 1 claim not proven.');
  });
});

describe('intent changes in plain language', () => {
  // [claims: capabilities/spec-first-changes#packet-intent-plain]
  it('added, modified and removed claims read as now/was text, never from a model', () => {
    const p = buildPacket(goldenInput());
    expect(p.intent.map((i) => i.summary)).toEqual([
      'new requirement now reads: Orders of $50.00 or more ship free.',
      'requirement now reads: The total is the sum of line prices minus discounts. (was: The total is the sum of line prices.)',
      'requirement removed (was: A LEGACY10 code takes 10% off.)',
    ]);
    expect(p.intent.map((i) => i.change)).toEqual(['added', 'modified', 'removed']);
    expect(p.intent[2]!.text).toBeUndefined();
    expect(p.intent[2]!.baseText).toBe('A LEGACY10 code takes 10% off.');
  });

  // [claims: capabilities/spec-first-changes#packet-intent-plain]
  it('example rows: added, changed, removed, and a claim whose only edit is in its rows', () => {
    const p = buildPacket(
      cartInput({
        changed: [
          changedClaim('cart#fee', 'modified', 'A fee applies.', 'A fee applies.', { parts: ['rows-added', 'rows-removed'] }),
          changedClaim('cart#fee/small', 'added', 'subtotal 10 | fee 1'),
          changedClaim('cart#fee/big', 'modified', 'subtotal 1000 | fee 20', 'subtotal 1000 | fee 10'),
          changedClaim('cart#fee/tiny', 'removed', undefined, 'subtotal 1 | fee 0'),
        ],
      }),
    );
    expect(p.intent.map((i) => i.summary)).toEqual([
      'requirement wording unchanged; example rows added, removed',
      'new example row now reads: subtotal 10 | fee 1',
      'example row now reads: subtotal 1000 | fee 20 (was: subtotal 1000 | fee 10)',
      'example row removed (was: subtotal 1 | fee 0)',
    ]);
    const md = renderPacketMarkdown(p);
    // Pipes in row text are escaped so the table keeps its columns.
    expect(md).toContain('| ➕ | `cart#fee/small` | subtotal 10 \\| fee 1 |');
    expect(md).toContain('| ➖ | `cart#fee/tiny` | <sub>was: subtotal 1 \\| fee 0</sub> |');
    // Rows roll up into their claim for evidence: one evidence row, two example rows counted.
    expect(p.evidence.map((e) => e.ref)).toEqual(['cart#fee']);
    expect(p.evidence[0]!.examples.total).toBe(2);
  });

  // [claims: capabilities/spec-first-changes#packet-intent-plain]
  it('an added claim with no text and a modified claim with no base still read sensibly', () => {
    const p = buildPacket(cartInput({ changed: [changedClaim('cart#a', 'added'), changedClaim('cart#b', 'modified', 'now'), changedClaim('cart#c', 'modified')] }));
    expect(p.intent.map((i) => i.summary)).toEqual(['new requirement added', 'requirement now reads: now', 'requirement now reads: (text unavailable)']);
  });
});

describe('approval trust labels', () => {
  const labelFor = (a: PacketApproval | undefined): string => {
    const p = buildPacket(cartInput({ approvals: a ? new Map([['cart#fee', a]]) : new Map() }));
    const row = renderPacketMarkdown(p).split('\n').find((l) => l.startsWith('| ➕ |'))!;
    return row.split(' | ').pop()!.replace(/ \|$/, '');
  };

  // [claims: capabilities/spec-first-changes#packet-approval-trust]
  it('each trust is shown the way the design says', () => {
    expect(labelFor(approval('verified', { method: 'pr', by: 'alice', source: 'review 123', date: '2026-10-25' }))).toBe('@alice (PR review #123, 2026-10-25)');
    expect(labelFor(approval('countersigned', { countersignedBy: 'alice' }))).toBe('wes via plan 2026-10-25-checkout-plan, countersigned by @alice');
    expect(labelFor(approval('inherited', { method: 'command', date: '2026-10-02' }))).toBe('wes (command, 2026-10-02; merged earlier)');
    expect(labelFor(approval('self-approved', { method: 'command' }))).toBe('wes (command) — self-approved');
    expect(labelFor(approval('recorded'))).toBe('⏳ wes (plan) — needs a review');
    expect(labelFor(approval('missing'))).toBe('❌ not approved');
    expect(labelFor(undefined)).toBe('❌ not approved');
    expect(APPROVAL_TRUSTS).toHaveLength(6);
  });

  // [claims: capabilities/spec-first-changes#packet-approval-trust]
  it('only a verified approval pings a person; names in other labels and in spec text cannot', () => {
    expect(labelFor(approval('recorded', { by: '@mallory' }))).toBe('⏳ mallory (plan) — needs a review');
    const spoofed = labelFor(approval('verified', { method: 'pr', by: 'alice', source: 'review 1', date: '' }));
    expect(spoofed).toBe('@alice (PR review #1)');
    const md = renderPacketMarkdown(buildPacket(cartInput({ changed: [changedClaim('cart#fee', 'added', 'Ask @mallory and @org/team about it.')] })));
    expect(md).not.toMatch(/@mallory|@org/);
    expect(md).toContain('@&#8203;mallory');
  });

  // [claims: capabilities/spec-first-changes#packet-approval-trust]
  it('a claim that is not approved is a fix for the capability that gates it, worded for a reviewer in CI and a person locally', () => {
    const unapproved = (provisional: boolean): ProofPacket =>
      buildPacket(cartInput({ approvals: new Map(), meta: { ...META, provisional } }, 'enforce', { approved: 'fail' }));
    expect(unapproved(false).fixes).toEqual(['A reviewer approves this PR (the approval covers `cart#fee` at its current wording).']);
    expect(unapproved(true).fixes).toEqual(['A person approves `cart#fee` with `specguard spec approve cart`.']);
  });
});

describe('unrequested code severity', () => {
  const unreq = emptyUnrequested({ lines: [{ file: 'src/cart/fee.ts', capability: 'cart', lines: [[5, 6]], class: 'unrequested' }], diffCoverage: { changedExecutable: 4, hitByChangeTests: 2, pct: 50 } });

  // [claims: capabilities/spec-first-changes#unrequested-severity]
  it('unrequested line -> enforce blocks; warn advisory (severity from config)', () => {
    const error = buildPacket(cartInput({ unrequested: unreq, policy: { unrequested: 'error' } }));
    expect(error.verdict).toBe('blocked');
    expect(capOf(error, 'cart').blocking.map((b) => b.code)).toEqual(['UNREQUESTED_CODE']);
    expect(renderPacketMarkdown(error)).toContain('- ❌ `src/cart/fee.ts` lines 5–6 (cart): changed, reached by no test of a changed requirement');

    const warn = buildPacket(cartInput({ unrequested: unreq, policy: { unrequested: 'warn' } }));
    expect(warn.verdict).toBe('advisory');
    expect(capOf(warn, 'cart')).toMatchObject({ verdict: 'pass', effect: 'warns', blocking: [] });
    expect(warn.headline).toBe('`cart` warns (the merge is not blocked): 2 changed lines no claim test reaches.');
    expect(renderPacketMarkdown(warn)).toContain('- ⚠️ `src/cart/fee.ts` lines 5–6 (cart)');
  });

  // [claims: capabilities/spec-first-changes#unrequested-severity]
  it('incidental and unknown lines never block; unknown coverage is stated as a limit', () => {
    const p = buildPacket(
      cartInput({
        unrequested: emptyUnrequested({
          lines: [
            { file: 'src/cart/a.ts', capability: 'cart', lines: [[1, 1]], class: 'incidental' },
            { file: 'src/cart/b.ts', capability: 'cart', lines: [[2, 3]], class: 'unknown' },
          ],
          claimable: false,
        }),
      }),
    );
    expect(capOf(p, 'cart')).toMatchObject({ verdict: 'pass', effect: 'warns' });
    expect(p.verdict).toBe('advisory');
    expect(p.limits[0]).toMatch(/^unrequested code could not be fully judged/);
    expect(renderPacketMarkdown(p)).toContain('lines 2–3 (cart): no fresh line coverage, so it cannot be judged');
    // Observed capabilities see the lines but the merge is not affected.
    expect(buildPacket(cartInput({ unrequested: unreq }, 'observe')).verdict).toBe('ready');
  });

  // [claims: capabilities/spec-first-changes#unrequested-severity]
  it('code with no covering change: a block at enforce (error mark), a warning below (warning mark)', () => {
    const withoutChange = emptyUnrequested({ withoutChange: [{ file: 'src/billing/tax.ts', capabilities: ['billing'] }, { file: 'src/billing/rate.ts', capabilities: ['billing'] }] });
    const at = (level: EnforceLevel): string =>
      renderPacketMarkdown(buildPacket(input({ statement: statementOf(capStatement('billing', pillars())), unrequested: withoutChange, enforce: new Map([['billing', level]]) })));
    expect(at('enforce')).toContain('- Code in `billing` (src/billing/tax.ts, src/billing/rate.ts) is not covered by an open change ❌');
    expect(at('warn')).toContain('is not covered by an open change ⚠️');
  });
});

describe('size limit and update in place', () => {
  const big = (rows: number): PacketInput => {
    const refs = Array.from({ length: rows }, (_, i) => `cart#claim-${String(i).padStart(4, '0')}`);
    const weak: WeakeningFinding[] = refs.slice(0, rows).map((r, i) => ({ kind: 'skip-added', severity: 'warn', file: `tests/cart/t${i}.test.ts`, line: i + 1, claims: [r], message: 'skip added ' + 'x'.repeat(150) }));
    return input({
      statement: statementOf(capStatement('cart', pillars({ approved: 'fail' }), refs.map((r) => claim(r, { approved: 'fail' })))),
      changed: refs.map((r) => changedClaim(r, 'added', `Requirement ${r} says something fairly long about how the cart behaves in this case. `.repeat(3))),
      approvals: new Map(),
      weakening: weak,
      unrequested: emptyUnrequested({ lines: refs.map((_, i) => ({ file: `src/cart/f${i}.ts`, capability: 'cart', lines: [[1, 2]] as Array<[number, number]>, class: 'unrequested' as const })) }),
      enforce: new Map<string, EnforceLevel>([['cart', 'enforce']]),
    });
  };

  // [claims: capabilities/spec-first-changes#packet-truncation]
  it('truncation keeps headline, capabilities and fixes, and the comment fits under the limit', () => {
    const p = buildPacket(big(600));
    // Asked for more than GitHub accepts, it still stops at GitHub's limit (the untruncated comment is far longer).
    const capped = renderPacketMarkdown(p, { maxChars: 1_000_000 });
    expect(capped.length).toBeLessThanOrEqual(PACKET_GITHUB_LIMIT);
    expect(capped).toContain('more in packet.json');
    for (const maxChars of [PACKET_MAX_CHARS, 20_000, 6_000]) {
      const md = renderPacketMarkdown(p, { maxChars });
      expect(md.length).toBeLessThanOrEqual(maxChars);
      expect(md.startsWith(`${PACKET_MARKER}\n`)).toBe(true);
      expect(md).toContain('## SpecGuard proof packet — ❌ blocked');
      expect(md).toContain(p.headline.replace(/`/g, '`'));
      expect(md).toContain('| cart | enforce | ✗ | ✓ | ✓ | ✓ | ❌ blocks |');
      expect(md).toContain('<details><summary>How to unblock');
      expect(md).toContain('more in packet.json');
      expect(md).toContain(`<!-- specguard-packet-sha256: ${packetDigest(p)} -->`);
    }
    // Whatever rows are left out, each table says how many and the heading still counts all of them.
    const mid = renderPacketMarkdown(p, { maxChars: 40_000 });
    expect(mid).toMatch(/<sub>\+\d+ more in packet\.json<\/sub>/);
    expect(mid).toContain('### What the requirements now say (600)');
  });

  // [claims: capabilities/spec-first-changes#packet-truncation]
  it('truncation is deterministic and never exceeds the GitHub limit, whatever maxChars asks for', () => {
    const p = buildPacket(big(600));
    expect(renderPacketMarkdown(p, { maxChars: 12_345 })).toBe(renderPacketMarkdown(p, { maxChars: 12_345 }));
    expect(renderPacketMarkdown(p, { maxChars: 1_000_000 }).length).toBeLessThanOrEqual(PACKET_GITHUB_LIMIT);
    expect(PACKET_MAX_CHARS).toBeLessThan(PACKET_GITHUB_LIMIT);
    expect(renderPacketMarkdown(p).length).toBeLessThanOrEqual(PACKET_MAX_CHARS);
    // A comment that already fits is not cut.
    const small = buildPacket(goldenInput());
    expect(renderPacketMarkdown(small)).not.toContain('more in packet.json');
  });

  // [claims: capabilities/spec-first-changes#packet-truncation]
  it('a tiny limit falls back to the verdict and headline, and the marker line survives any cut', () => {
    const p = buildPacket(big(50));
    const small = renderPacketMarkdown(p, { maxChars: 700 });
    expect(small.length).toBeLessThanOrEqual(700);
    expect(small).toContain('blocks the merge');
    expect(small.startsWith(PACKET_MARKER)).toBe(true);
    const tiny = renderPacketMarkdown(p, { maxChars: 40 });
    expect(tiny.length).toBeLessThanOrEqual(40);
    expect(tiny.startsWith(PACKET_MARKER)).toBe(true);
    expect(renderPacketMarkdown(p, { maxChars: 0 })).toBe('');
  });

  // [claims: capabilities/spec-first-changes#packet-truncation]
  it('many capabilities: observed ones are cut before the gated ones', () => {
    const caps = Array.from({ length: 300 }, (_, i) => `cap${String(i).padStart(3, '0')}`);
    const p = buildPacket(
      input({
        statement: statementOf(...caps.map((c) => capStatement(c, pillars({ approved: 'fail' }), [claim(`${c}#x`, { approved: 'fail' })]))),
        changed: caps.map((c) => changedClaim(`${c}#x`, 'added', 'x')),
        enforce: new Map<string, EnforceLevel>(caps.map((c, i) => [c, i === 299 ? 'enforce' : 'observe'])),
      }),
    );
    const md = renderPacketMarkdown(p, { maxChars: 9_000 });
    expect(md.length).toBeLessThanOrEqual(9_000);
    expect(md).toContain('| cap299 | enforce |');
    expect(md).toContain('blocks the merge');
  });

  // [claims: capabilities/spec-first-changes#packet-marker]
  it('PACKET_MARKER is the first line of every rendering, so CI can find and update its own comment', () => {
    expect(PACKET_MARKER).toBe('<!-- specguard-proof-packet v1 -->');
    for (const p of [buildPacket(input()), buildPacket(goldenInput()), buildPacket(localInput())]) {
      const md = renderPacketMarkdown(p);
      expect(md.split('\n')[0]).toBe(PACKET_MARKER);
      expect(md.split(PACKET_MARKER)).toHaveLength(2);
    }
    // Untrusted text cannot plant a second marker for CI to latch onto.
    const forged = renderPacketMarkdown(buildPacket(cartInput({ changed: [changedClaim('cart#fee', 'added', `${PACKET_MARKER} sneaky`)] })));
    expect(forged.split(PACKET_MARKER)).toHaveLength(2);
  });
});

describe('packetDigest', () => {
  // [claims: capabilities/spec-first-changes#packet-digest-stable]
  it('packetDigest stable: the same packet always has the same sha256, whatever the key order', () => {
    const p = buildPacket(goldenInput());
    const d = packetDigest(p);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(packetDigest(buildPacket(goldenInput()))).toBe(d);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(p).reverse()))) as ProofPacket;
    expect(packetDigest(reordered)).toBe(d);
    // Round-tripped through JSON (as the artifact is) it is unchanged.
    expect(packetDigest(JSON.parse(JSON.stringify(p)) as ProofPacket)).toBe(d);
  });

  // [claims: capabilities/spec-first-changes#packet-digest-stable]
  it('any change to the packet changes the digest', () => {
    const p = buildPacket(goldenInput());
    const d = packetDigest(p);
    expect(packetDigest({ ...p, verdict: 'ready' })).not.toBe(d);
    expect(packetDigest({ ...p, head: 'ffffffff' })).not.toBe(d);
    expect(packetDigest({ ...p, fixes: [...p.fixes, 'one more'] })).not.toBe(d);
    expect(packetDigest({ ...p, fixes: [...p.fixes].reverse() })).not.toBe(d);
  });
});

describe('what the packet never contains', () => {
  const TOKEN = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const dangerous = 'Orders | over `50` <img src=x onerror=alert(1)> [click](http://evil.example) ping @alice token=hunter22secret ' + TOKEN;

  // [claims: capabilities/spec-first-changes#packet-no-secrets]
  it('escaping of pipes, backticks, html in spec text', () => {
    const md = renderPacketMarkdown(buildPacket(cartInput({ changed: [changedClaim('cart#fee', 'added', dangerous)] })));
    const row = md.split('\n').find((l) => l.startsWith('| ➕ |'))!;
    expect(row).toContain('Orders \\| over \\`50\\` &lt;img src=x onerror=alert(1)> \\[click\\](http://evil.example) ping @&#8203;alice');
    // The row keeps exactly its four columns: no unescaped pipe came from the text.
    expect(row.replace(/\\\|/g, '').split('|').length).toBe(6);
    expect(md).not.toContain('<img');
  });

  // [claims: capabilities/spec-first-changes#packet-no-secrets]
  it('credentials in spec, test and finding text are masked in the markdown and in the packet JSON', () => {
    const w: WeakeningFinding = { kind: 'assertion-weakened', severity: 'error', file: 'tests/a.test.ts', line: 3, test: `uses ${TOKEN}`, claims: ['cart#fee'], before: `toBe('${TOKEN}')`, after: 'toBeDefined()', message: `before ${TOKEN}` };
    const p = buildPacket(cartInput({ changed: [changedClaim('cart#fee', 'modified', dangerous, `old ${TOKEN}`)], weakening: [w] }));
    const all = `${renderPacketMarkdown(p)}\n${JSON.stringify(p)}`;
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('hunter22secret');
    expect(all).toContain('[KEY]');
    expect(escapeMarkdownForComment(`password=${'hunter22'} and ${TOKEN}`)).toBe('password=\\[SECRET\\] and \\[KEY\\]');
  });

  // [claims: capabilities/spec-first-changes#packet-no-secrets]
  it('who opened the PR, the run url and absolute paths stay out of the comment; run links must be https', () => {
    const p = buildPacket(cartInput({ meta: { ...META, pr: { number: 9, author: 'carol-the-author', url: 'https://github.com/o/r/pull/9' }, run: { id: '77', url: 'javascript:alert(1)' } } }));
    const md = renderPacketMarkdown(p);
    expect(md).not.toContain('carol-the-author');
    expect(md).not.toContain('javascript:');
    expect(md).toContain('run #77');
    expect(md).not.toMatch(/\/Users\/|\/home\/|C:\\\\/);
  });

  // [claims: capabilities/spec-first-changes#packet-no-secrets]
  it('cell text is collapsed to one line and capped at 200 characters; backslashes cannot undo an escape', () => {
    const long = escapeMarkdownForComment(`line one\n\nline two ${'y'.repeat(500)}`);
    expect(long).not.toContain('\n');
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
    expect(escapeMarkdownForComment('a\\|b')).toBe('a\\\\\\|b');
    expect(escapeMarkdownForComment('x', 5)).toBe('x');
  });

  // [claims: capabilities/spec-first-changes#packet-no-secrets]
  it('fix and limit text built from statements cannot inject links or html either', () => {
    const p = buildPacket(
      cartInput({
        statement: statementOf(
          capStatement('cart', pillars({ conforms: 'fail' }), [claim('cart#fee', { conforms: 'fail' })], {
            blocking: [reason('CLAIM_FAILED', 'conforms', { claim: 'cart#fee', fix: 'see [docs](http://evil.example) <b>now</b> ' + TOKEN })],
            limits: ['<script>alert(1)</script> ' + TOKEN],
          }),
        ),
      }),
    );
    const md = renderPacketMarkdown(p);
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('<b>');
    expect(md).not.toMatch(/(?<!\\)\]\(http:\/\/evil/);
    expect(md).not.toContain(TOKEN);
  });
});

describe('changes and details', () => {
  // [claims: capabilities/spec-first-changes#packet-sections]
  it('refactor changes show the claims proven before and after and the changed-line coverage; chronology is advisory', () => {
    const refactor: ChangeVerdict = {
      id: 'r1',
      kind: 'refactor',
      capabilities: ['cart'],
      verdict: 'pass',
      claims: [],
      refactor: { claimsProvenBefore: 4, claimsProvenAfter: 4, changedLineCoverage: 96, mutation: { killed: 12, total: 14 } },
      chronology: { testsBeforeCode: false, note: 'code was committed before tests' },
    };
    const md = renderPacketMarkdown(buildPacket(cartInput({ changes: [refactor] })));
    expect(md).toContain('- `r1` (refactor, cart): ✅ — refactor: 4 claims proven before and after; changed lines 96% covered by claim tests; 12/14 mutants killed; code was committed before tests (advisory)');
  });

  // [claims: capabilities/spec-first-changes#packet-sections]
  it('limits: statement limits, unknown sensitivity and provisional runs are listed once each', () => {
    const p = buildPacket(
      cartInput({
        statement: statementOf(capStatement('cart', pillars(), [claim('cart#fee')], { limits: ['mutation not configured'] })),
        sensitivity: new Map<string, ClaimEvidence['sensitivity']>([['cart#fee', { kind: 'red-green', status: 'unknown', redTests: 0 }]]),
        meta: { ...META, provisional: true },
      }),
    );
    expect(p.limits).toEqual(['provisional: a local run, not a CI result', 'sensitivity unknown for 1 requirement: no red-green or mutation result', 'mutation not configured']);
    expect(p.provisional).toBe(true);
    const md = renderPacketMarkdown(p);
    expect(md).toContain('Limits: provisional: a local run, not a CI result; sensitivity unknown for 1 requirement: no red-green or mutation result; mutation not configured.');
    expect(md).not.toContain('Machine-readable packet');
  });
});

