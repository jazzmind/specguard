import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  aggregateClaims,
  detectResultFormat,
  parseResults,
  ResultParseError,
} from '../../src/core/test-results.js';

const fx = (name: string) => readFileSync(path.join(__dirname, '..', 'fixtures', 'results', name), 'utf8');

describe('test results', () => {
  it('detects every format and rejects unknown content', () => {
    expect(detectResultFormat(fx('vitest.json'))).toBe('vitest');
    expect(detectResultFormat(fx('playwright.json'))).toBe('playwright');
    expect(detectResultFormat(fx('junit.xml'))).toBe('junit');
    expect(detectResultFormat(fx('pytest.json'))).toBe('pytest');
    expect(detectResultFormat(fx('go.jsonl'))).toBe('go');
    expect(detectResultFormat(fx('cargo.jsonl'))).toBe('cargo');
    expect(detectResultFormat('{"hello":1}')).toBeNull();
    expect(detectResultFormat('plain text')).toBeNull();
  });

  it('parses vitest results including pass, fail, skip', () => {
    const rows = parseResults(fx('vitest.json'));
    expect(rows.map((r) => r.status)).toEqual(['pass', 'fail', 'pass', 'skip']);
    expect(rows[0]).toMatchObject({ file: 'tests/awards.test.ts', durationMs: 4, claims: ['core/awards#award-once'] });
    expect(rows[1].message).toContain('AssertionError');
    expect(rows[1].claims).toEqual(['core/awards#no-dupes']);
  });

  it('parses playwright suites, tags, annotations', () => {
    const rows = parseResults(fx('playwright.json'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ status: 'pass', claims: ['web/checkout#pay-card'], externalIds: ['PROJ-T12'], fullTitle: 'Checkout pays with card' });
    expect(rows[0].tags).toContain('@smoke');
    expect(rows[1]).toMatchObject({ status: 'fail', claims: ['web/checkout#bad-card'], message: 'expected visible' });
    expect(rows[2]).toMatchObject({ status: 'skip', claims: ['web/checkout#skipped-one'] });
  });

  it('parses junit xml with properties', () => {
    const rows = parseResults(fx('junit.xml'));
    expect(rows.map((r) => r.status)).toEqual(['pass', 'fail', 'skip']);
    expect(rows[0]).toMatchObject({ claims: ['core/awards#award-once'], externalIds: ['PROJ-T99'], file: 'tests/test_awards.py' });
    expect(rows[0].tags).toContain('@slow');
    expect(rows[1].claims).toEqual(['core/awards#no-dupes']);
    expect(rows[1].message).toBe('assert 2 == 1');
  });

  it('parses pytest-json-report', () => {
    const rows = parseResults(fx('pytest.json'));
    expect(rows.map((r) => r.status)).toEqual(['pass', 'fail', 'skip']);
    expect(rows[0].claims).toEqual(['core/awards#award-once']);
    expect(rows[1]).toMatchObject({ file: 'tests/test_awards.py', title: 'TestX::test_boom', claims: ['core/awards#no-dupes'] });
  });

  it('parses go and cargo json lines', () => {
    const go = parseResults(fx('go.jsonl'));
    expect(go.map((r) => [r.title, r.status])).toEqual([['TestAwardOnce', 'pass'], ['TestNoDupes', 'fail']]);
    const cargo = parseResults(fx('cargo.jsonl'));
    expect(cargo.map((r) => [r.title, r.status])).toEqual([['award_once', 'pass'], ['boom', 'fail']]);
  });

  it('honours an explicit format and throws a typed error on bad input', () => {
    expect(() => parseResults('not json', 'vitest')).toThrow(ResultParseError);
    expect(() => parseResults('{"a":1}', 'auto')).toThrow(/unrecognised/);
    expect(() => parseResults('<html></html>', 'junit')).toThrow(ResultParseError);
  });

  it('aggregates claims', () => {
    const rows = [...parseResults(fx('vitest.json')), ...parseResults(fx('playwright.json'))];
    const agg = Object.fromEntries(aggregateClaims(rows).map((a) => [a.claim, a]));
    expect(agg['core/awards#award-once']).toMatchObject({ verdict: 'proven', exercised: 2, counterexamples: 0 });
    expect(agg['core/awards#no-dupes']).toMatchObject({ verdict: 'failed', exercised: 0, counterexamples: 1 });
    expect(agg['core/awards#no-dupes'].failures).toEqual(['awards no duplicates [claim: core/awards#no-dupes]']);
    expect(agg['core/awards#deferred']).toMatchObject({ verdict: 'unexercised', exercised: 0 });
    expect(agg['web/checkout#skipped-one'].verdict).toBe('unexercised');
  });
});
