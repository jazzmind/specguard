import { describe, it, expect } from 'vitest';
import { initialViewModel, reduce } from './reducer.js';

describe('reduce', () => {
  it('marks a node running then done', () => {
    let vm = initialViewModel();
    vm = reduce(vm, { type: 'pipeline:start', pipeline: 'drift' });
    expect(vm.nodeStates['drift']).toBe('running');
    vm = reduce(vm, { type: 'pipeline:done', pipeline: 'drift', exitCode: 0 });
    expect(vm.nodeStates['drift']).toBe('done');
  });
  it('marks failed on non-zero (non-4) exit', () => {
    let vm = reduce(initialViewModel(), { type: 'pipeline:done', pipeline: 'heal', exitCode: 1 });
    expect(vm.nodeStates['heal']).toBe('failed');
  });
  it('treats exit code 4 (coverage gap) as done, not failed', () => {
    const vm = reduce(initialViewModel(), { type: 'pipeline:done', pipeline: 'status', exitCode: 4 });
    expect(vm.nodeStates['status']).toBe('done');
  });
  it('appends logs and records artifacts', () => {
    let vm = initialViewModel();
    vm = reduce(vm, { type: 'pipeline:log', pipeline: 'drift', line: 'hello' });
    expect(vm.logs['drift']).toEqual(['hello']);
    vm = reduce(vm, { type: 'artifact', kind: 'spec', path: 'specs/core/x.md', change: 'create' });
    expect(vm.artifacts.at(-1)).toMatchObject({ kind: 'spec', path: 'specs/core/x.md' });
  });
  // [claims: capabilities/integration-surfaces#extension-help-popovers]
  it('keeps the help topics the host sends', () => {
    const topic = { title: 'T', text: 'x', page: 'guide/a.md', anchor: 'a' };
    const vm = reduce(initialViewModel(), { type: 'helpTopics', topics: { 'dashboard.overview': topic } });
    expect(vm.helpTopics['dashboard.overview']).toEqual(topic);
  });
});
