/**
 * Remediation plans behind one interface: files for the CLI, a database for a team server.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { RemediationPlanSchema, type RemediationPlan } from '../remediation-schema.js';
import { writeFile } from '../writer.js';
import { serially } from './lock.js';

export interface PlanStore {
  /** Where plans live, for messages. */
  readonly location: string;
  /** Plan ids, oldest first. */
  list(): Promise<string[]>;
  /** `latest` is the newest plan. Null when the plan does not exist or does not validate. */
  read(id: string): Promise<RemediationPlan | null>;
  /** Store a plan under its own id. Returns where it went. */
  write(plan: RemediationPlan): Promise<string>;
  /**
   * Read, change and write one plan as a step. Concurrent updates run one after another. Returns null when
   * the plan is missing, and does not write when `fn` throws.
   */
  update<T>(id: string, fn: (plan: RemediationPlan) => T | Promise<T>): Promise<T | null>;
}

/** Safe file stem for a plan id: no path separators or dots that could leave the plans folder. */
export const planStem = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '');

export function listPlanFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function readPlanFile(dir: string, id: string): RemediationPlan | null {
  const resolved = id === 'latest' ? listPlanFiles(dir).pop() : planStem(id);
  if (!resolved) return null;
  try {
    const parsed = RemediationPlanSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, `${resolved}.json`), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Plans as `<dir>/<id>.json`, written atomically. */
export function filePlanStore(dir: string): PlanStore {
  const read = async (id: string): Promise<RemediationPlan | null> => readPlanFile(dir, id);
  return {
    location: dir,
    list: async () => listPlanFiles(dir),
    read,
    write: async (plan) => {
      const file = path.join(dir, `${planStem(plan.id)}.json`);
      await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
      return file;
    },
    update: (id, fn) =>
      serially(`plan:${dir}:${planStem(id)}`, async () => {
        const plan = readPlanFile(dir, id);
        if (!plan) return null;
        const out = await fn(plan);
        await writeFile(path.join(dir, `${planStem(plan.id)}.json`), `${JSON.stringify(plan, null, 2)}\n`);
        return out;
      }),
  };
}
