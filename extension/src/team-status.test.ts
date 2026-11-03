import { it, expect, vi } from 'vitest';
vi.mock('./api/connection.js', () => ({ readServerConfig: () => ({}), resolveServer: ({ workspaceRoot }: { workspaceRoot: string }) => workspaceRoot === '/team' ? { url: 'https://configured.invalid', project: 'app' } : null }));
vi.mock('./api/client.js', () => ({ SUPPORTED_API_VERSION: 1, ApiClient: class { async health() { return { ok: true, apiVersion: 1 }; } } }));
import { refreshTeamStatus, resolveTeam, teamProjectUrl, teamStatus } from './team-status.js';
// [claims: capabilities/integration-surfaces#extension-overlay-workspace]
it('distinguishes unconfigured, workspace-inherited, and disabled team connections without claiming authorization', async () => {
  await refreshTeamStatus('/none', '/none', undefined, {});
  expect(teamStatus('/none')).toBe('not configured');
  await refreshTeamStatus('/repo', '/overlay/app', '/team', {});
  expect(teamStatus('/repo')).toBe('available (project access not checked)');
  await refreshTeamStatus('/off', '/overlay/app', '/team', { mode: 'off' });
  expect(teamStatus('/off')).toBe('disabled');
});
// [claims: capabilities/team-server#project-onboarding]
it('links to the project page on the configured server, read from settings with no cache', () => {
  expect(resolveTeam('/none', undefined, {})).toBeNull();
  const team = resolveTeam('/overlay/app', '/team', {});
  expect(team).toEqual({ url: 'https://configured.invalid', project: 'app' });
  expect(teamProjectUrl({ url: 'https://s.test/specguard/', project: 'my app' })).toBe('https://s.test/specguard/?project=my%20app');
  expect(resolveTeam('/overlay/app', '/team', { mode: 'off' })).toBeNull();
});
