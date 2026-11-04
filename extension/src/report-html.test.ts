import { describe, expect, it } from 'vitest';

import { prepareReportHtml, resolveReportLink } from './report-html.js';

const OPTS = { baseHref: 'https://file+.vscode-resource.vscode-cdn.net/r/repos/es', cspSource: 'https://file+.vscode-resource.vscode-cdn.net', nonce: 'N0NCE', canGoBack: true, isHome: false };

describe('prepareReportHtml [test-report-panel]', () => {
  // [claims: capabilities/integration-surfaces#vscode-test-report]
  it('adds the base, a strict CSP and nonces, and replaces any CSP or base the page had', () => {
    const html = prepareReportHtml(
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><base href="http://evil/"><style>x{}</style></head><body><h1>t</h1><script>1+1</script></body></html>',
      OPTS,
    );
    expect(html).toContain('<base href="https://file+.vscode-resource.vscode-cdn.net/r/repos/es/">');
    expect(html).not.toContain('default-src *');
    expect(html).not.toContain('http://evil/');
    expect(html).toContain("script-src 'nonce-N0NCE'");
    expect(html).toContain("media-src https://file+.vscode-resource.vscode-cdn.net");
    expect(html).toContain('<script nonce="N0NCE">1+1</script>');
    expect(html.match(/<script(?![^>]*nonce=)/g)).toBeNull();
    expect(html).toContain('data-sg="back"');
    expect(html).not.toContain('data-sg="back" disabled');
  });

  // [claims: capabilities/integration-surfaces#vscode-test-report]
  it('disables Back with no history and Workspace on the home page', () => {
    const html = prepareReportHtml('<body></body>', { ...OPTS, canGoBack: false, isHome: true });
    expect(html).toContain('data-sg="back" disabled');
    expect(html).toContain('data-sg="home" disabled');
  });
});

describe('resolveReportLink [test-report-panel]', () => {
  const root = '/ws/.specguard/report/workspace';
  // [claims: capabilities/integration-surfaces#vscode-test-report]
  it('resolves pages and evidence relative to the open page, and refuses to leave the report root', () => {
    expect(resolveReportLink('repos/es/index.html', 'index.html', root)).toEqual({ kind: 'page', rel: 'repos/es/index.html' });
    expect(resolveReportLink('../../index.html', 'repos/es/index.html', root)).toEqual({ kind: 'page', rel: 'index.html' });
    expect(resolveReportLink('evidence/run/a%20b.png', 'repos/es/index.html', root)).toEqual({ kind: 'file', abs: `${root}/repos/es/evidence/run/a b.png`, ext: 'png' });
    expect(resolveReportLink('evidence/t.zip', 'repos/es/index.html', root)).toMatchObject({ kind: 'file', ext: 'zip' });
    expect(resolveReportLink('../../../../etc/passwd', 'repos/es/index.html', root)).toBeNull();
    expect(resolveReportLink('javascript:alert(1)', 'index.html', root)).toBeNull();
  });

  // [claims: capabilities/integration-surfaces#vscode-test-report]
  it('sends http links out and file URLs to the file handler', () => {
    expect(resolveReportLink('https://example.com/x', 'index.html', root)).toEqual({ kind: 'external', url: 'https://example.com/x' });
    expect(resolveReportLink('file:///a/b/report%20x/index.html', 'index.html', root)).toEqual({ kind: 'file', abs: '/a/b/report x/index.html', ext: 'html' });
  });
});
