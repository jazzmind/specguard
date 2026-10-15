/**
 * The RemediationPlan: the one stable shape in which SpecGuard hands security
 * findings to other systems (trackers, bots, dashboards).
 *
 * A plan is a list of items. Each item says what was found, where, which
 * capability and requirements it touches, what kind of change would fix it,
 * which claims must stay proven afterwards, and where it stands in a fixed
 * lifecycle. Other systems read plans from `.specguard/security/plans/` or the
 * API, and report progress back with `security plan set-status`.
 *
 * Defined with zod/v4 so the JSON Schema published at
 * `schemas/remediation-plan.v1.json` is generated from this definition rather
 * than written by hand. Objects are loose: a consuming system may add its own
 * fields to a plan it stores.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import { z } from 'zod/v4';

export const SEVERITY_LEVELS = ['critical', 'high', 'moderate', 'low', 'info'] as const;
export type PlanSeverity = (typeof SEVERITY_LEVELS)[number];

export const ITEM_TYPES = ['spec', 'code', 'dependency', 'secret'] as const;
export const CHANGE_TYPES = ['code', 'spec', 'dependency', 'config'] as const;
export const DETECTORS = ['advisory', 'semgrep', 'gitleaks', 'spec-review'] as const;
export const ITEM_STATUSES = ['open', 'planned', 'in-progress', 'fixed', 'verified', 'wont-fix'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const FindingRefSchema = z.looseObject({
  id: z.string().describe('Stable id of the finding in its detector, such as an advisory id or a rule id plus location.'),
  detector: z.enum(DETECTORS),
  ruleId: z.string().optional(),
  message: z.string(),
  file: z.string().optional().describe('Repo-relative path.'),
  line: z.number().int().optional(),
});

export const StatusChangeSchema = z.looseObject({
  status: z.enum(ITEM_STATUSES),
  at: z.string().describe('ISO 8601 timestamp.'),
  by: z.string().optional(),
  note: z.string().optional(),
});

export const PlanItemSchema = z.looseObject({
  id: z.string().describe('Stable across scans: derived from what was found, not from when.'),
  title: z.string(),
  severity: z.enum(SEVERITY_LEVELS),
  type: z.enum(ITEM_TYPES).describe('What kind of finding this is.'),
  change: z.enum(CHANGE_TYPES).describe('What kind of change would fix it.'),
  summary: z.string().describe('The proposed change, in a sentence or two.'),
  findings: z.array(FindingRefSchema),
  capability: z.string().optional().describe('Id of the capability spec the finding falls under.'),
  claims: z.array(z.string()).describe('Claim refs (`specKey#claimId`) the finding bears on.'),
  files: z.array(z.string()).describe('Repo-relative paths a fix would touch.'),
  verify: z.looseObject({
    scope: z.enum(['listed', 'all-proven']).describe('`listed`: the claims below. `all-proven`: every claim proven now.'),
    claims: z.array(z.string()).describe('Claim refs that must still be proven after the fix.'),
  }),
  status: z.enum(ITEM_STATUSES),
  statusHistory: z.array(StatusChangeSchema),
  externalRef: z.string().optional().describe('Id of this item in an external tracker.'),
  fingerprint: z.string().describe('Hash of the finding; equal fingerprints across scans are the same item.'),
});

export const RemediationPlanSchema = z.looseObject({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string().describe('ISO 8601 timestamp.'),
  tool: z.looseObject({ name: z.literal('specguard'), version: z.string().optional() }),
  previous: z.string().optional().describe('Id of the plan this scan carried statuses over from.'),
  items: z.array(PlanItemSchema),
});

export type PlanItem = z.infer<typeof PlanItemSchema>;
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;
export type FindingRef = z.infer<typeof FindingRefSchema>;

/**
 * The lifecycle. An item can always be reopened; `verified` is only reachable
 * from `fixed`; closing as `wont-fix` is possible from any open state.
 */
const TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  open: ['planned', 'in-progress', 'fixed', 'wont-fix'],
  planned: ['open', 'in-progress', 'fixed', 'wont-fix'],
  'in-progress': ['open', 'planned', 'fixed', 'wont-fix'],
  fixed: ['open', 'verified'],
  verified: ['open'],
  'wont-fix': ['open'],
};

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Statuses that still need work. */
export const UNRESOLVED: readonly ItemStatus[] = ['open', 'planned', 'in-progress'];

const SEVERITY_RANK: Record<PlanSeverity, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };
export const severityRank = (s: PlanSeverity): number => SEVERITY_RANK[s];

export const PLAN_SCHEMA_FILE = 'schemas/remediation-plan.v1.json';

/** The JSON Schema other systems validate plans against. */
export function remediationPlanJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(RemediationPlanSchema) as Record<string, unknown>),
    $id: 'https://specguard.dev/schemas/remediation-plan.v1.json',
    title: 'SpecGuard RemediationPlan v1',
  };
}
