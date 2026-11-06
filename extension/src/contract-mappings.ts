/**
 * Contract-mapping helpers for the extension: whether a repo enables the `contract-mappings` plugin, where its
 * mapping file is, and how the QuickPick choices become CLI flags. No VS Code imports.
 */
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_MAPPINGS_FILE = '.specguard/contract-mappings.json';

export type MapMode = 'text' | 'text-llm' | 'assess' | 'code' | 'code-llm';
export type ContractsMode = 'build' | 'force' | 'llm';

interface ConfigShape {
  plugins?: Array<string | { name?: string }>;
  disabledPlugins?: string[];
  contractMappings?: { file?: string };
}

/** True when the config lists the plugin and has not switched it off. */
export function contractMappingsEnabled(config: unknown): boolean {
  const c = (config ?? {}) as ConfigShape;
  if (!Array.isArray(c.plugins)) return false;
  const names = c.plugins.map((e) => (typeof e === 'string' ? e : e?.name));
  return names.includes('contract-mappings') && !(c.disabledPlugins ?? []).includes('contract-mappings');
}

/** The mapping file relative to the repo, honouring `contractMappings.file`. */
export function mappingsFileName(config: unknown): string {
  const file = (config as ConfigShape | undefined)?.contractMappings?.file;
  return typeof file === 'string' && file ? file : DEFAULT_MAPPINGS_FILE;
}

/** The flags `contracts-map` takes for a mode. A dry run changes nothing for assess, which never writes. */
export function mapArgs(mode: MapMode, dryRun: boolean, repoKey?: string): string[] {
  const args: string[] = [];
  if (mode === 'assess') args.push('--assess');
  if (mode === 'text-llm' || mode === 'code-llm') args.push('--with-llm');
  if (mode === 'code' || mode === 'code-llm') args.push('--with-code');
  if (dryRun && mode !== 'assess') args.push('--dry-run');
  if (repoKey) args.push('--repo', repoKey);
  return args;
}

/** The flags `contracts` takes for a mode. */
export function contractsArgs(mode: ContractsMode): string[] {
  return mode === 'force' ? ['--force'] : mode === 'llm' ? ['--with-llm'] : [];
}

export const MAP_MODES: { mode: MapMode; label: string; description: string }[] = [
  { mode: 'text', label: 'Spec text only', description: 'no model, nothing sent anywhere' },
  { mode: 'text-llm', label: 'Spec text + model', description: 'sends the text of unmatched specs to the model' },
  { mode: 'assess', label: 'Assess whether code helps', description: 'no model, writes nothing' },
  { mode: 'code', label: 'With code (local)', description: 'matches client calls to endpoint definitions, no model' },
  { mode: 'code-llm', label: 'With code + model', description: 'local code matching plus the model for what is left' },
];

export const CONTRACTS_MODES: { mode: ContractsMode; label: string; description: string }[] = [
  { mode: 'build', label: 'Build', description: 'update the contract graph' },
  { mode: 'force', label: 'Rebuild from scratch', description: '--force' },
  { mode: 'llm', label: 'With model', description: 'read free-text Dependencies with a model (--with-llm)' },
];

export interface RepoLike { key: string; absPath: string; ignore?: boolean }

/** The mapping files that exist for the repos (each read from that repo's own config location). */
export function existingMappingFiles(repos: RepoLike[], readConfig: (repo: RepoLike) => unknown, exists: (file: string) => boolean = fs.existsSync): string[] {
  const files: string[] = [];
  for (const repo of repos) {
    const file = path.resolve(repo.absPath, mappingsFileName(readConfig(repo)));
    if (exists(file)) files.push(file);
  }
  return files;
}

/** Read a repo's config JSON, or undefined when there is none or it does not parse. */
export function readConfigFile(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}
