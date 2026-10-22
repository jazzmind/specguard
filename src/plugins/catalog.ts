/**
 * What SpecGuard ships as built-in plugins, described for a person choosing among them.
 *
 * Metadata only: loading stays in `index.ts`, which imports `./<id>/index` lazily and is what the
 * bundled CLI's esbuild glob follows. A test keeps this list in step with the plugin directories
 * and with each plugin's own `id`.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import type { SpecGuardPlugin } from './types.js';

export interface BuiltinPluginInfo {
  id: string;
  title: string;
  description: string;
  /** The parts of the plugin interface it implements. */
  provides: (keyof SpecGuardPlugin)[];
  /** Config key that tunes it, when it has one. */
  configKey?: string;
  /** On for every project `specguard init` creates. */
  defaultOn: boolean;
}

export const BUILTIN_PLUGINS: readonly BuiltinPluginInfo[] = [
  {
    id: 'quality',
    title: 'Code quality',
    description: 'Runs ESLint, Knip and Ruff over the apps and writes .specguard/code-quality.json (adds the `quality` command).',
    provides: ['commands'],
    defaultOn: true,
  },
  {
    id: 'git',
    title: 'Commit SpecGuard output',
    description: 'Stages and commits only what SpecGuard generated (tests, docs, specs, reports), never source code (adds the `commit` command).',
    provides: ['commands'],
    defaultOn: true,
  },
  {
    id: 'feature-catalog',
    title: 'Feature catalog',
    description: 'Maps specs to the feature ids of a YAML catalog and reports each feature\'s channel state and agent gate (adds the `features` command).',
    provides: ['commands', 'catalogProviders', 'discoverers', 'externalIdAdapters', 'resultSources', 'featureState', 'moduleStems'],
    configKey: 'featureState',
    defaultOn: false,
  },
  {
    id: 'contract-mappings',
    title: 'Contract mappings',
    description: 'Reads contract mapping files to add edges to the cross-repo contract graph.',
    provides: ['contractImporters'],
    configKey: 'contractMappings',
    defaultOn: false,
  },
];

export const builtinPluginInfo = (id: string): BuiltinPluginInfo | undefined => BUILTIN_PLUGINS.find((p) => p.id === id);
