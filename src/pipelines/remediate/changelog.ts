/**
 * Release-note fetch (npm registry / PyPI / crates.io -> GitHub releases) and the
 * breaking-change analysis. HTTP is injected; the LLM goes through the shared LLM layer.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { z } from 'zod';

import type { Candidate } from '../../core/advisory.js';
import { compareVer } from '../../core/ecosystems/semver.js';
import { llmGenerateObject } from '../../core/llm.js';
import type { SpecGuardConfig } from '../../core/types.js';
import type { BreakingAnalysis, HttpGet } from './types.js';

export interface Changelog {
  text: string;
  source: string;
  url?: string;
}

const MAX_TEXT = 8000;

function githubRepo(url: string | undefined): { owner: string; repo: string } | undefined {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url ?? '');
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

async function json<T>(http: HttpGet, url: string): Promise<T | undefined> {
  try {
    const r = await http(url, { accept: 'application/json' });
    return r.status === 200 ? (JSON.parse(r.text) as T) : undefined;
  } catch {
    return undefined;
  }
}

async function repoFor(c: Candidate, http: HttpGet): Promise<{ owner: string; repo: string } | undefined> {
  switch (c.ecosystem.toLowerCase()) {
    case 'npm': {
      const doc = await json<{ repository?: { url?: string } | string }>(http, `https://registry.npmjs.org/${encodeURIComponent(c.package).replace('%40', '@')}`);
      const url = typeof doc?.repository === 'string' ? doc.repository : doc?.repository?.url;
      return githubRepo(url);
    }
    case 'pypi': {
      const doc = await json<{ info?: { project_urls?: Record<string, string>; home_page?: string } }>(http, `https://pypi.org/pypi/${c.package}/json`);
      const urls = Object.values(doc?.info?.project_urls ?? {});
      for (const u of [...urls, doc?.info?.home_page ?? '']) {
        const r = githubRepo(u);
        if (r) return r;
      }
      return undefined;
    }
    case 'crates.io': {
      const doc = await json<{ crate?: { repository?: string } }>(http, `https://crates.io/api/v1/crates/${c.package}`);
      return githubRepo(doc?.crate?.repository);
    }
    case 'go':
      return githubRepo(`https://${c.package}`);
    default:
      return undefined;
  }
}

/** Release notes between the installed and the target version, newest first. Never throws. */
export async function fetchChangelog(c: Candidate, http: HttpGet): Promise<Changelog | undefined> {
  try {
    const repo = await repoFor(c, http);
    if (!repo) return undefined;
    const rel = await json<Array<{ tag_name?: string; name?: string; body?: string; html_url?: string }>>(
      http,
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=50`,
    );
    if (!rel) return undefined;
    const inRange = rel.filter((r) => {
      const v = (r.tag_name ?? r.name ?? '').replace(/^[^\d]*/, '');
      return v && compareVer(v, c.fromVersion) > 0 && compareVer(v, c.toVersion) <= 0;
    });
    if (inRange.length === 0) return undefined;
    const text = inRange.map((r) => `## ${r.tag_name ?? r.name}\n${(r.body ?? '').trim()}`).join('\n\n').slice(0, MAX_TEXT);
    return { text, source: 'github-releases', url: `https://github.com/${repo.owner}/${repo.repo}/releases` };
  } catch {
    return undefined;
  }
}

const BREAKING_WORDS = /\b(breaking change|breaking:|backwards? incompatible|incompatible change|removed|no longer|drop(?:ped|s)? support|deprecat)/i;

/** Keyword fallback used when there is no changelog or no LLM. */
export function heuristicBreaking(c: Candidate, changelog: string | undefined): BreakingAnalysis {
  const hits = (changelog ?? '').split('\n').filter((l) => BREAKING_WORDS.test(l)).slice(0, 8).map((l) => l.trim().slice(0, 200));
  const major = c.bump === 'major';
  return {
    summary: changelog
      ? hits.length
        ? `Release notes mention ${hits.length} possibly breaking line(s).`
        : 'No breaking-change wording found in the release notes.'
      : `No release notes were available${major ? ' for a major bump' : ''}; judged from the version change alone.`,
    breaking: major || hits.length > 0,
    items: hits,
    confidence: changelog ? 'medium' : 'low',
    source: 'heuristic',
  };
}

const AnalysisSchema = z.object({
  breaking: z.boolean(),
  summary: z.string(),
  items: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
});

export const BREAKING_SYSTEM =
  'You review dependency release notes for breaking changes. Be conservative and factual: only report what the notes say. Answer in the requested JSON shape.';

export function breakingPrompt(c: Candidate, changelog: string): string {
  return `Package ${c.package} (${c.ecosystem}) is being updated from ${c.fromVersion} to ${c.toVersion} to fix a security advisory.\nRelease notes between these versions:\n\n${changelog}\n\nWhich changes could break callers of this package? Set breaking=true only when the notes describe an incompatible API or behavior change.`;
}

export async function analyzeBreaking(
  config: SpecGuardConfig,
  c: Candidate,
  changelog: string | undefined,
  llmEnabled: boolean,
  warn: (msg: string) => void,
): Promise<BreakingAnalysis> {
  if (!llmEnabled || !changelog) return heuristicBreaking(c, changelog);
  try {
    const out = await llmGenerateObject({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      pipeline: 'remediate',
      maxTokens: 800,
      temperature: 0,
      system: BREAKING_SYSTEM,
      prompt: breakingPrompt(c, changelog),
      schema: AnalysisSchema,
    });
    return { ...out, items: out.items ?? [], source: 'llm' };
  } catch (err) {
    warn(`LLM breaking-change analysis for ${c.package} skipped (${err instanceof Error ? err.message : String(err)}); using the keyword heuristic.`);
    return heuristicBreaking(c, changelog);
  }
}
