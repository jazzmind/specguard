/**
 * Shared plan-writer utility.
 *
 * Every pipeline that detects issues can call `writePlan` to produce a
 * Markdown file under `.specguard/plans/` that coding agents (Claude, Cursor,
 * Copilot) can consume directly to fix the problem.
 *
 * File naming: `.specguard/plans/<pipeline>-<YYYYMMDD-HHmmss>.md`
 *
 * Format:
 *   ---
 *   pipeline: <name>
 *   generatedAt: <ISO>
 *   ---
 *
 *   # <title>
 *
 *   > <summary>
 *
 *   ## <section heading>
 *   - item 1
 *   - item 2
 *
 *   ...
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PlanSection {
  heading: string;
  /** Markdown list items — written as `- item`. Pass pre-formatted text when needed. */
  items: string[];
  /** If true, render as an ordered list instead of bullets. */
  ordered?: boolean;
}

export interface PlanOpts {
  /** Pipeline that produced the findings, e.g. `drift`. */
  pipeline: string;
  /** Short title for the plan document. */
  title: string;
  /** 1–3 sentence summary of what was found and the overall fix approach. */
  summary: string;
  /** Structured sections: findings, fix steps, files to edit, etc. */
  sections: PlanSection[];
  /** Absolute path to the project root (used to resolve the plans dir). */
  rootDir: string;
  /** Spec key this plan addresses (gap-analysis plans). */
  specKey?: string;
}

/** Frontmatter parsed from a plan file. */
export interface PlanMeta {
  pipeline: string;
  generatedAt: string;
  status: 'pending' | 'in-progress' | 'done';
  specKey?: string;
  completedAt?: string;
  filePath: string;
  title: string;
}

/**
 * Parse the frontmatter and title from a plan file.
 * Returns null if the file cannot be read or has no frontmatter.
 */
export function parsePlanMeta(filePath: string): PlanMeta | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const fm = match[1];
    const get = (key: string) => fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
    const titleMatch = content.match(/^#\s+(.+)$/m);
    return {
      pipeline: get('pipeline') || 'unknown',
      generatedAt: get('generatedAt') || '',
      status: (get('status') as PlanMeta['status']) || 'pending',
      specKey: get('specKey') || undefined,
      completedAt: get('completedAt') || undefined,
      filePath,
      title: titleMatch?.[1]?.trim() ?? path.basename(filePath, '.md'),
    };
  } catch {
    return null;
  }
}

/**
 * Update the `status` (and optionally `completedAt`) in a plan file's frontmatter.
 */
export function updatePlanStatus(
  filePath: string,
  status: 'pending' | 'in-progress' | 'done',
): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const now = new Date().toISOString();

  // Replace or add status line in frontmatter
  const fmRegex = /^(---\n)([\s\S]*?)\n(---)/;
  const match = content.match(fmRegex);
  if (!match) return;

  let fm = match[2];
  if (/^status:/m.test(fm)) {
    fm = fm.replace(/^status:.+$/m, `status: ${status}`);
  } else {
    fm = `${fm}\nstatus: ${status}`;
  }

  if (status === 'done') {
    if (/^completedAt:/m.test(fm)) {
      fm = fm.replace(/^completedAt:.+$/m, `completedAt: ${now}`);
    } else {
      fm = `${fm}\ncompletedAt: ${now}`;
    }
  } else {
    fm = fm.replace(/^completedAt:.+\n?/m, '');
  }

  const updated = content.replace(fmRegex, `${match[1]}${fm}\n${match[3]}`);
  fs.writeFileSync(filePath, updated, 'utf8');
}

/**
 * Write a Markdown plan file to `.specguard/plans/<pipeline>.md`.
 *
 * Uses a fixed filename per pipeline so re-runs overwrite rather than
 * accumulate duplicates. The `generatedAt` frontmatter records when the plan
 * was last regenerated. Status is reset to `pending` unless the previous
 * status was `in-progress` (i.e. an agent is actively working on it).
 *
 * Returns the absolute path to the written file.
 */
export function writePlan(opts: PlanOpts): string {
  const plansDir = path.join(opts.rootDir, '.specguard', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const filePath = path.join(plansDir, `${opts.pipeline}.md`);

  // Preserve status if agent is actively working on this plan.
  let preservedStatus: 'pending' | 'in-progress' | 'done' = 'pending';
  if (fs.existsSync(filePath)) {
    const existing = parsePlanMeta(filePath);
    if (existing?.status === 'in-progress') preservedStatus = 'in-progress';
    // 'done' resets to 'pending' — issue came back / needs re-examination
  }

  const lines: string[] = [
    '---',
    `pipeline: ${opts.pipeline}`,
    `generatedAt: ${new Date().toISOString()}`,
    `status: ${preservedStatus}`,
    ...(opts.specKey ? [`specKey: ${opts.specKey}`] : []),
    '---',
    '',
    `# ${opts.title}`,
    '',
    `> ${opts.summary}`,
    '',
  ];

  for (const section of opts.sections) {
    if (section.items.length === 0) continue;
    lines.push(`## ${section.heading}`, '');
    if (section.ordered) {
      section.items.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    } else {
      for (const item of section.items) lines.push(`- ${item}`);
    }
    lines.push('');
  }

  lines.push(
    '---',
    '',
    `_Generated by SpecGuard \`${opts.pipeline}\` pipeline · ${new Date().toISOString()}_`,
    `_Pass this file to your coding agent to apply the fixes automatically._`,
  );

  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}
