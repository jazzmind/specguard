/**
 * Pipeline changes: files in a pull request that run or guard the gates themselves. A change to the workflow, the
 * SpecGuard config, the code owners file or the Action can weaken the checks that judge the same PR, so the proof
 * packet lists them for the reviewer. Pure: it reads file names and statuses, never file contents.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import type { PipelineChange } from '../core/proof-packet.js';

/** The part of a GitHub "list pull request files" entry this module reads. */
export interface ChangedFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

function kindOf(path: string): PipelineChange['kind'] | undefined {
  const p = normalize(path);
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(p)) return 'workflow';
  if (/^\.github\/actions\/.+/.test(p) || /^action\.ya?ml$/.test(p) || /^action\/.+/.test(p)) return 'action';
  if (p === '.specguard/config.json') return 'specguard-config';
  if (p === 'CODEOWNERS' || p === '.github/CODEOWNERS' || p === 'docs/CODEOWNERS') return 'codeowners';
  // Other CI systems: the same risk, listed under the same kind.
  if (p === '.gitlab-ci.yml' || p === 'azure-pipelines.yml' || p === 'Jenkinsfile' || p === 'bitbucket-pipelines.yml' || /^\.circleci\/.+\.ya?ml$/.test(p)) return 'workflow';
  return undefined;
}

/**
 * Pipeline files touched by a pull request. Adding or editing one is a `warn`; deleting one, or renaming it away from
 * its path, is an `error` because the gate it ran or guarded is gone. A file renamed into a pipeline path is a `warn`.
 * One entry per file, sorted by file name; an `error` for a file wins over a `warn`.
 */
export function pipelineChanges(files: ChangedFile[]): PipelineChange[] {
  const found = new Map<string, PipelineChange>();
  const note = (file: string, kind: PipelineChange['kind'], severity: PipelineChange['severity']): void => {
    const f = normalize(file);
    const cur = found.get(f);
    if (!cur || (cur.severity === 'warn' && severity === 'error')) found.set(f, { file: f, kind, severity });
  };
  for (const f of files) {
    const kind = kindOf(f.filename);
    if (kind) note(f.filename, kind, f.status === 'removed' ? 'error' : 'warn');
    if (f.previous_filename) {
      const was = kindOf(f.previous_filename);
      if (was && normalize(f.previous_filename) !== normalize(f.filename)) note(f.previous_filename, was, 'error');
    }
  }
  return [...found.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
