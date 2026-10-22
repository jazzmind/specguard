/**
 * A RemediationPlan as SARIF 2.1.0, the format GitHub code scanning reads, so findings show up on the pull
 * request and in the Security tab instead of only in a plan file.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import type { RemediationPlan } from './remediation-schema.js';
import { UNRESOLVED } from './remediation-schema.js';

type SarifLevel = 'error' | 'warning' | 'note';

const LEVEL: Record<string, SarifLevel> = { critical: 'error', high: 'error', moderate: 'warning', low: 'note', info: 'note' };
/** GitHub's `security-severity` scale (0-10) for the severities a plan uses. */
const SCORE: Record<string, string> = { critical: '9.5', high: '8.0', moderate: '5.5', low: '3.0', info: '1.0' };

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: { driver: { name: string; version?: string; informationUri?: string; rules: Array<Record<string, unknown>> } };
    results: Array<Record<string, unknown>>;
  }>;
}

/**
 * Convert the unresolved items of a plan. Items already fixed, verified or marked won't-fix are left out, so a
 * resolved finding closes its alert on the next upload.
 */
export function planToSarif(plan: RemediationPlan): SarifLog {
  const rules = new Map<string, Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];
  for (const item of plan.items) {
    if (!UNRESOLVED.includes(item.status)) continue;
    const finding = item.findings[0];
    const ruleId = finding?.ruleId ?? `${finding?.detector ?? item.type}/${item.type}`;
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: ruleId.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/ (\w)/g, (_m, c: string) => c.toUpperCase()),
        shortDescription: { text: item.title },
        properties: { 'security-severity': SCORE[item.severity] ?? '5.0', tags: ['security', item.type] },
      });
    }
    const files = item.files.length > 0 ? item.files : finding?.file ? [finding.file] : [];
    results.push({
      ruleId,
      level: LEVEL[item.severity] ?? 'warning',
      message: { text: `${item.title}. ${item.summary}` },
      // The plan item id is stable across scans, so GitHub tracks one alert for it.
      partialFingerprints: { 'specguard/planItem/v1': item.id },
      locations: (files.length > 0 ? files : ['.']).map((file) => ({
        physicalLocation: {
          artifactLocation: { uri: file.replace(/\\/g, '/') },
          ...(file === finding?.file && finding?.line ? { region: { startLine: finding.line } } : {}),
        },
      })),
      properties: { severity: item.severity, status: item.status, capability: item.capability ?? null, claims: item.claims },
    });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'SpecGuard', ...(plan.tool.version ? { version: plan.tool.version } : {}), informationUri: 'https://github.com/jazzmind/specguard', rules: [...rules.values()] } },
        results,
      },
    ],
  };
}
