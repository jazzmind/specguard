/**
 * Renders v2 specs from structured data.
 *
 * `spec draft` and `spec consolidate` ask the LLM for structured content and
 * write the markdown here, so every generated spec has exactly the format the
 * parser and the spec graph expect. Globs are written as double-quoted YAML
 * strings, which is also valid JSON string syntax.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import { SENTINEL_END, SENTINEL_START } from './sentinels.js';

export interface RenderedScenario {
  name: string;
  steps: string[];
  expected: string[];
}

export interface RenderedRequirement {
  id: string;
  text: string;
}

export interface CapabilityDoc {
  id: string;
  kind: 'capability' | 'component';
  title: string;
  parent: string;
  value: string;
  status: string;
  sources: string[];
  tests: string[];
  docs: string[];
  history: string[];
  problemAndValue: string;
  users: string[];
  requirements: RenderedRequirement[];
  scenarios: RenderedScenario[];
  security: string;
  interfaces: string;
  outOfScope: string;
}

const q = (s: string): string => JSON.stringify(s);

function list(key: string, items: string[]): string {
  if (items.length === 0) return '';
  return `${key}:\n${items.map((i) => `  - ${q(i)}`).join('\n')}\n`;
}

/** Collapse newlines so a value fits on one frontmatter line. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function renderCapabilitySpec(doc: CapabilityDoc): string {
  const front =
    `---\nid: ${doc.id}\nkind: ${doc.kind}\ntitle: ${q(oneLine(doc.title))}\nparent: ${doc.parent}\n` +
    `value: ${q(oneLine(doc.value))}\nstatus: ${doc.status}\n` +
    list('sources', doc.sources) +
    list('tests', doc.tests) +
    list('docs', doc.docs) +
    list('history', doc.history) +
    '---\n';

  const users = doc.users.length > 0 ? doc.users.map((u) => `- ${u}`).join('\n') : '- _To be written._';
  const reqs = doc.requirements.map((r) => `- [ ] ${oneLine(r.text)} <!-- claim: ${r.id} -->`).join('\n');
  const scenarios = doc.scenarios
    .map(
      (s, i) =>
        `### Scenario ${i + 1}: ${oneLine(s.name)}\n**Steps:**\n${s.steps.map((st, n) => `${n + 1}. ${oneLine(st)}`).join('\n')}\n\n**Expected Results:**\n${s.expected.map((e) => `- ${oneLine(e)}`).join('\n')}`,
    )
    .join('\n\n');

  return (
    `${front}\n# ${oneLine(doc.title)}\n\n` +
    `## Problem & Value\n\n${doc.problemAndValue.trim()}\n\n` +
    `## Users & Journeys\n\n${users}\n\n` +
    `## Requirements\n\n${reqs}\n\n` +
    `## Scenarios\n\n${scenarios}\n\n` +
    `## Security & Data Considerations\n\n${doc.security.trim() || '_None identified._'}\n\n` +
    `## Interfaces\n\n${doc.interfaces.trim() || '_None._'}\n\n` +
    `## Out of Scope\n\n${doc.outOfScope.trim() || '_None stated._'}\n`
  );
}

export interface SystemDoc {
  title: string;
  problem: string;
  users: string[];
  value: string;
  nonGoals: string[];
  history: string[];
}

export interface CapabilityRow {
  id: string;
  title: string;
  value: string;
  status: string;
  /** Path of the spec relative to the specs root, without `.md`. */
  specKey: string;
  /** Count of claims with ids. */
  claims: number;
}

export const CAPABILITY_MAP_KEY = 'capability-map';

/** The marked table that `spec index` regenerates. */
export function renderCapabilityMap(rows: CapabilityRow[]): string {
  const body = rows
    .map((r) => `| [${oneLine(r.title).replace(/\|/g, '\\|')}](${r.specKey}.md) | ${oneLine(r.value).replace(/\|/g, '\\|')} | ${r.status} | ${r.claims} |`)
    .join('\n');
  return `| Capability | Value | Status | Claims |\n|---|---|---|---|\n${body}`;
}

export function renderSystemSpec(doc: SystemDoc, rows: CapabilityRow[]): string {
  const front =
    `---\nid: system\nkind: system\ntitle: ${q(oneLine(doc.title))}\nvalue: ${q(oneLine(doc.value))}\nstatus: active\n` +
    list('history', doc.history) +
    '---\n';
  const users = doc.users.map((u) => `- ${u}`).join('\n');
  const nonGoals = doc.nonGoals.length > 0 ? doc.nonGoals.map((n) => `- ${n}`).join('\n') : '- _None stated._';
  return (
    `${front}\n# ${oneLine(doc.title)}\n\n` +
    `## Problem\n\n${doc.problem.trim()}\n\n` +
    `## Users\n\n${users}\n\n` +
    `## Value\n\n${doc.value.trim()}\n\n` +
    `## Capability Map\n\n${SENTINEL_START(CAPABILITY_MAP_KEY)}\n${renderCapabilityMap(rows)}\n${SENTINEL_END(CAPABILITY_MAP_KEY)}\n\n` +
    `## Non-goals\n\n${nonGoals}\n`
  );
}
