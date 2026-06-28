/**
 * Spec Parser.
 *
 * Parses Living Specification Markdown files into structured `ParsedSpec`
 * objects. Every pipeline reads specs through this parser.
 *
 * All functions are pure (no filesystem access) except `loadAllSpecs`, which
 * is the only function permitted to touch `node:fs`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import type { ParsedSpec, SpecMeta, SpecScenario } from './types.js';

/** Metadata keys that map to typed fields on `SpecMeta`. */
const KNOWN_META_KEYS = new Set([
  'module',
  'type',
  'status',
  'auth',
  'url',
  'framework',
]);

/**
 * Parse the first `<!-- ... -->` HTML comment containing `key: value` lines
 * into a typed `SpecMeta`. Unknown keys are preserved in `meta.extra`.
 */
export function parseMetaComment(content: string): SpecMeta {
  const meta: SpecMeta = { extra: {} };

  const match = content.match(/<!--([\s\S]*?)-->/);
  if (!match) return meta;

  const body = match[1];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;

    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key) continue;

    if (KNOWN_META_KEYS.has(key)) {
      (meta as unknown as Record<string, string>)[key] = value;
    } else {
      meta.extra[key] = value;
    }
  }

  return meta;
}

/**
 * Extract the text under an `## <sectionName>` H2 heading, trimmed.
 * Returns an empty string if the section is missing. The section ends at the
 * next H2 heading (or end of file).
 */
export function extractSection(content: string, sectionName: string): string {
  const lines = content.split(/\r?\n/);
  const target = sectionName.trim().toLowerCase();

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h2 && h2[1].trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';

  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    collected.push(lines[i]);
  }

  return collected.join('\n').trim();
}

/**
 * Parse the `## Scenarios` section into an array of `SpecScenario`.
 * Each `### Scenario N: <name>` is one scenario. `**Steps:**` is a numbered
 * list, `**Expected Results:**` is a bullet list.
 */
export function parseScenarios(content: string): SpecScenario[] {
  const section = extractSection(content, 'Scenarios');
  if (!section) return [];

  const lines = section.split(/\r?\n/);
  const scenarios: SpecScenario[] = [];

  // Indices of `### ...` heading lines that start a scenario block.
  const blocks: { name: string; bodyStart: number; bodyEnd: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h3 = lines[i].match(/^###\s+(.+?)\s*$/);
    if (h3) {
      const name = stripScenarioPrefix(h3[1].trim());
      blocks.push({ name, bodyStart: i + 1, bodyEnd: lines.length });
      if (blocks.length > 1) {
        blocks[blocks.length - 2].bodyEnd = i;
      }
    }
  }

  for (const block of blocks) {
    const body = lines.slice(block.bodyStart, block.bodyEnd);
    scenarios.push({
      name: block.name,
      steps: extractList(body, 'Steps'),
      expectedResults: extractList(body, 'Expected Results'),
    });
  }

  return scenarios;
}

/** Strip a leading `Scenario N:` prefix from a scenario name. */
function stripScenarioPrefix(name: string): string {
  return name.replace(/^Scenario\s+\d+\s*:\s*/i, '').trim();
}

/**
 * Within a scenario body, find a `**Label:**` marker and collect the
 * following list items (numbered or bulleted) until the next blank line
 * boundary, another bold marker, or the end of the body.
 */
function extractList(bodyLines: string[], label: string): string[] {
  const target = label.trim().toLowerCase();

  let start = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    const m = bodyLines[i].match(/^\*\*(.+?):\*\*/);
    if (m && m[1].trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  const items: string[] = [];
  for (let i = start; i < bodyLines.length; i++) {
    const line = bodyLines[i];

    // Stop at the next bold marker (e.g. the other list's label).
    if (/^\*\*(.+?):\*\*/.test(line)) break;

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    const bulleted = line.match(/^\s*[-*]\s+(.*)$/);
    if (numbered) {
      items.push(numbered[1].trim());
    } else if (bulleted) {
      items.push(bulleted[1].trim());
    }
    // Non-list lines (blank lines, prose) are skipped but do not terminate
    // the list, so a list can survive an interleaved blank line.
  }

  return items;
}

/** Parse the H1 title (`# Title`) from spec content. */
function parseTitle(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return '';
}

/** Collect all H2 sections by name into a record of raw (trimmed) text. */
function parseAllSections(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  const sections: Record<string, string> = {};
  const names: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) names.push(h2[1].trim());
  }
  for (const name of names) {
    sections[name] = extractSection(content, name);
  }
  return sections;
}

/** Compute the stable spec key from a file path relative to the specs root. */
function computeSpecKey(filePath: string, specsRoot: string): string {
  let rel = path.relative(specsRoot, filePath);
  rel = rel.split(path.sep).join('/');
  if (rel.toLowerCase().endsWith('.md')) {
    rel = rel.slice(0, -3);
  }
  return rel;
}

/**
 * Parse raw spec content into a `ParsedSpec`. Pure — does not touch the
 * filesystem; `filePath` and `specsRoot` are used only to derive `specKey`.
 */
export function parseSpecContent(
  content: string,
  filePath: string,
  specsRoot: string,
): ParsedSpec {
  return {
    title: parseTitle(content),
    specKey: computeSpecKey(filePath, specsRoot),
    filePath,
    meta: parseMetaComment(content),
    overview: extractSection(content, 'Overview'),
    acceptanceCriteria: extractSection(content, 'Acceptance Criteria'),
    scenarios: parseScenarios(content),
    securityNotes: extractSection(content, 'Security Notes'),
    dependencies: extractSection(content, 'Dependencies'),
    sections: parseAllSections(content),
  };
}

/**
 * Recursively find all `.md` files under `dir` (excluding any `README.md`),
 * read each, and return the parsed specs. The only function here that
 * touches the filesystem. `dir` is used as the specs root for `specKey`.
 */
export function loadAllSpecs(dir: string): ParsedSpec[] {
  const files: string[] = [];

  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
      } else if (
        entry.toLowerCase().endsWith('.md') &&
        entry.toLowerCase() !== 'readme.md'
      ) {
        files.push(full);
      }
    }
  };

  walk(dir);

  return files.map((file) =>
    parseSpecContent(readFileSync(file, 'utf-8'), file, dir),
  );
}
