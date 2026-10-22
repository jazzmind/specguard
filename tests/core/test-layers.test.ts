import { describe, expect, it } from 'vitest';

import {
  classifyTest,
  extractLayerTag,
  fileLayerComment,
  withLayerComment,
  parseLayerRequirements,
  requiredLayersFor,
} from '../../src/core/test-layers.js';
import {
  effectiveClaimProof,
  effectiveVerdict,
  layersOf,
  mergeLayerRecord,
  type ProofRecord,
} from '../../src/core/proof-ledger.js';

const fresh = { specHash: 'h', fileHashes: { 'a.ts': '1' } };
const rec = (over: Partial<ProofRecord> = {}): ProofRecord => ({
  claim: 'x#a', verdict: 'proven', runId: 'r1', specHash: 'h', fileHashes: { 'a.ts': '1' }, exercised: 1, counterexamples: 0, ingestedAt: '2026-10-22T10:00:00.000Z', ...over,
});

describe('classifying a test into a layer [layer-classify]', () => {
  const base = { file: 'tests/auth.test.ts', title: 'logs in' };

  // [claims: capabilities/conformance-testing#layer-classification]
  it('defaults to unit', () => {
    expect(classifyTest(base)).toBe('unit');
  });

  // [claims: capabilities/conformance-testing#layer-classification]
  it('applies the first matching rule: tag, file comment, config glob, suite, flag, runner, path', () => {
    expect(classifyTest({ ...base, title: 'logs in @layer:e2e', fileComment: 'security', configured: 'integration', suite: 'functional', forced: 'unit', format: 'playwright' })).toBe('e2e');
    expect(classifyTest({ ...base, fileComment: 'security', configured: 'integration', suite: 'functional', forced: 'unit' })).toBe('security');
    expect(classifyTest({ ...base, configured: 'integration', suite: 'functional', forced: 'unit' })).toBe('integration');
    expect(classifyTest({ ...base, suite: 'functional', forced: 'unit', format: 'playwright' })).toBe('functional');
    expect(classifyTest({ ...base, forced: 'integration', format: 'playwright' })).toBe('integration');
    expect(classifyTest({ ...base, format: 'playwright' })).toBe('e2e');
  });

  // [claims: capabilities/conformance-testing#layer-classification]
  it('reads path conventions', () => {
    expect(classifyTest({ ...base, file: 'tests/e2e/login.spec.ts' })).toBe('e2e');
    expect(classifyTest({ ...base, file: 'src/login.e2e.ts' })).toBe('e2e');
    expect(classifyTest({ ...base, file: 'tests/integration/db.test.ts' })).toBe('integration');
    expect(classifyTest({ ...base, file: 'api/orders.int.test.ts' })).toBe('integration');
    expect(classifyTest({ ...base, file: 'tests/security/xss.test.ts' })).toBe('security');
    expect(classifyTest({ ...base, file: 'tests/internal/thing.test.ts' })).toBe('unit'); // "int" must be a whole folder
  });

  // [claims: capabilities/conformance-testing#layer-classification]
  it('finds tags in titles, brackets and file headers, and ignores unknown layers', () => {
    expect(extractLayerTag('x @layer:integration y')).toBe('integration');
    expect(extractLayerTag('[layer: E2E]')).toBe('e2e');
    expect(extractLayerTag('@layer:nonsense')).toBeUndefined();
    expect(fileLayerComment('// [layer: security]\nimport x')).toBe('security');
    expect(fileLayerComment(`${'\n'.repeat(40)}// [layer: security]`)).toBeUndefined(); // only the first lines count
  });
});

describe('required layers [layer-requirements]', () => {
  // [claims: capabilities/conformance-testing#layer-requirements]
  it('reads a list as the default, and a map as default plus per-claim lists', () => {
    expect(parseLayerRequirements(['unit', 'e2e'])).toEqual({ default: ['unit', 'e2e'], claims: {}, unknown: [] });
    expect(parseLayerRequirements({ default: ['unit'], claims: { login: ['unit', 'e2e'], limit: 'security' } })).toEqual({
      default: ['unit'], claims: { login: ['unit', 'e2e'], limit: ['security'] }, unknown: [],
    });
    expect(parseLayerRequirements(['unit', 'smoke']).unknown).toEqual(['smoke']);
    expect(parseLayerRequirements(undefined)).toEqual({ default: [], claims: {}, unknown: [] });
  });

  // [claims: capabilities/conformance-testing#layer-requirements]
  it('takes the claim\'s own list, else the capability default, else the project default', () => {
    const spec = parseLayerRequirements({ default: ['unit'], claims: { login: ['unit', 'e2e'] } });
    expect(requiredLayersFor('login', spec, ['security'])).toEqual(['unit', 'e2e']);
    expect(requiredLayersFor('other', spec, ['security'])).toEqual(['unit']);
    expect(requiredLayersFor('other', parseLayerRequirements(undefined), ['security'])).toEqual(['security']);
    expect(requiredLayersFor('other', undefined)).toEqual([]);
  });
});

describe('proof across layers [layered-proofs]', () => {
  // [claims: capabilities/conformance-testing#layered-proofs]
  it('reads a row written before layers as one layer, and gives exactly the old verdict when nothing is required', () => {
    const legacy = rec();
    expect(Object.keys(layersOf(legacy))).toEqual(['unclassified']);
    expect(Object.keys(layersOf(rec({ evidence: 'agentic' })))).toEqual(['functional']);
    for (const r of [rec(), rec({ verdict: 'failed' }), rec({ specHash: 'other' }), rec({ fileHashes: { 'a.ts': '0' } }), undefined]) {
      expect(effectiveClaimProof(r, fresh).verdict).toBe(effectiveVerdict(r, fresh));
    }
  });

  // [claims: capabilities/conformance-testing#layered-proofs]
  it('is incomplete, not failed, when a required layer has no proof, and complete once it has', () => {
    const unit = mergeLayerRecord(undefined, rec(), 'unit');
    const one = effectiveClaimProof(unit, fresh, ['unit', 'e2e']);
    expect(one).toMatchObject({ verdict: 'proven', missing: ['e2e'], complete: false, layers: { unit: 'proven' } });
    const both = mergeLayerRecord(unit, rec({ runId: 'r2', ingestedAt: '2026-10-22T11:00:00.000Z' }), 'e2e');
    expect(effectiveClaimProof(both, fresh, ['unit', 'e2e'])).toMatchObject({ verdict: 'proven', missing: [], complete: true });
    expect(effectiveClaimProof(undefined, fresh, ['unit'])).toMatchObject({ verdict: 'unproven', missing: ['unit'], complete: false });
  });

  // [claims: capabilities/conformance-testing#layered-proofs]
  it('lets a failure in any layer decide, and does not let the next passing layer overwrite it', () => {
    const browserFail = mergeLayerRecord(mergeLayerRecord(undefined, rec(), 'unit'), rec({ verdict: 'failed', counterexamples: 1, evidence: 'agentic', ingestedAt: '2026-10-22T11:00:00.000Z' }), 'functional');
    expect(browserFail.verdict).toBe('failed');
    // the next unit run passes, later than the failure
    const after = mergeLayerRecord(browserFail, rec({ runId: 'r3', ingestedAt: '2026-10-22T12:00:00.000Z' }), 'unit');
    expect(after.verdict).toBe('failed'); // still the browser failure
    expect(effectiveClaimProof(after, fresh, []).verdict).toBe('failed');
    // the browser check passes later: now it is proven
    const fixed = mergeLayerRecord(after, rec({ runId: 'r4', evidence: 'agentic', ingestedAt: '2026-10-22T13:00:00.000Z' }), 'functional');
    expect(fixed.verdict).toBe('proven');
    expect(Object.keys(fixed.layers ?? {}).sort()).toEqual(['functional', 'unit']);
  });

  // [claims: capabilities/conformance-testing#layered-proofs]
  it('stales a claim when a required layer goes stale, and ignores a stale layer it does not require', () => {
    const e2e = rec({ fileHashes: { 'a.ts': '0' } }); // recorded against an older file
    const row = mergeLayerRecord(mergeLayerRecord(undefined, rec(), 'unit'), e2e, 'e2e');
    expect(effectiveClaimProof(row, fresh, ['unit', 'e2e']).verdict).toBe('stale');
    expect(effectiveClaimProof(row, fresh, ['unit'])).toMatchObject({ verdict: 'proven', complete: true, layers: { e2e: 'stale' } });
  });

  // [claims: capabilities/conformance-testing#layered-proofs]
  it('drops superseded unclassified evidence when classified evidence arrives, so an old failure cannot outlive its fix', () => {
    const oldFailure = rec({ verdict: 'failed', counterexamples: 1 });
    const merged = mergeLayerRecord(oldFailure, rec({ runId: 'r2', ingestedAt: '2026-10-22T12:00:00.000Z' }), 'unit');
    expect(Object.keys(merged.layers ?? {})).toEqual(['unit']);
    expect(merged.verdict).toBe('proven');
  });
});

describe('marking generated tests with their layer [layer-comment]', () => {
  // [claims: capabilities/conformance-testing#layer-classification]
  it('puts a layer comment at the top, after a shebang, once, in the language\'s comment syntax', () => {
    expect(withLayerComment("import x from 'y';\n", 'e2e', 'typescript')).toBe("// [layer: e2e]\nimport x from 'y';\n");
    expect(withLayerComment('import pytest\n', 'integration', 'python')).toBe('# [layer: integration]\nimport pytest\n');
    expect(withLayerComment('#!/usr/bin/env node\nrun();', 'unit', 'typescript')).toBe('#!/usr/bin/env node\n// [layer: unit]\nrun();');
    const once = withLayerComment('x', 'security', 'typescript');
    expect(withLayerComment(once, 'e2e', 'typescript')).toBe(once); // an existing layer is kept
    expect(fileLayerComment(withLayerComment('x', 'e2e', 'go'))).toBe('e2e');
  });
});
