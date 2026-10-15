/**
 * The team server's MCP endpoint, for clients that connect by URL (Claude Desktop on the internal network, other
 * agents). Read-only: every tool answers through the same API a browser uses, as the same signed-in identity, so access
 * rules and redaction are the API's, not a second copy.
 *
 * Stateless: each request gets its own server, so nothing is kept between calls and no session can be hijacked.
 *
 * Spec: specs/capabilities/team-server.md
 */
import type http from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { cliVersion } from '../../core/version.js';
import type { Api, Identity } from '../api.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function buildRemoteMcp(api: Api, identity: Identity): McpServer {
  const server = new McpServer({ name: 'specguard-team-server', version: cliVersion() });
  const ask = async (apiPath: string): Promise<ToolResult> => {
    const res = await api.handle({ method: 'GET', path: `/api/v1${apiPath}`, identity });
    return { content: [{ type: 'text', text: res.body }], ...(res.status >= 400 ? { isError: true } : {}) };
  };
  const project = z.string().describe('Project name (see specguard_projects).');
  const enc = encodeURIComponent;

  server.registerTool('specguard_projects', { description: 'List the projects on this server, with the commit and branch each is shown from.', inputSchema: {} }, () => ask('/projects'));
  server.registerTool('specguard_system', { description: 'The system spec and every capability with its value and proof counts.', inputSchema: { project } }, ({ project: p }) => ask(`/projects/${enc(p)}/system`));
  server.registerTool('specguard_capability', { description: 'One capability: its value, requirements with proof and tests, owned files and history.', inputSchema: { project, id: z.string().describe('Capability id.') } }, ({ project: p, id }) => ask(`/projects/${enc(p)}/capabilities/${enc(id)}`));
  server.registerTool('specguard_read_spec', { description: 'The markdown of one spec, as written.', inputSchema: { project, id: z.string().describe('Spec id, or "system".') } }, ({ project: p, id }) => ask(`/projects/${enc(p)}/specs/${enc(id)}`));
  server.registerTool('specguard_audit', { description: 'Where the system and its specs disagree: unowned files, stale and failed proofs, untested requirements, code changed without recorded intent.', inputSchema: { project } }, ({ project: p }) => ask(`/projects/${enc(p)}/audit`));
  server.registerTool('specguard_coverage', { description: 'Coverage per capability and per workspace unit.', inputSchema: { project } }, ({ project: p }) => ask(`/projects/${enc(p)}/coverage`));
  server.registerTool(
    'specguard_docs',
    { description: 'Documentation generated from the specs, for the user, developer or agent audience. `system` is the whole-system guide.', inputSchema: { project, audience: z.enum(['user', 'dev', 'agent']), id: z.string().describe('Capability id, or "system".') } },
    ({ project: p, audience, id }) => ask(`/projects/${enc(p)}/docs/${audience}/${enc(id)}`),
  );
  server.registerTool('specguard_history', { description: 'The recorded prompts, plans and decisions behind one capability.', inputSchema: { project, capability: z.string().describe('Capability id.') } }, ({ project: p, capability }) => ask(`/projects/${enc(p)}/capabilities/${enc(capability)}/history`));
  server.registerTool('specguard_findings', { description: 'Unresolved security findings from the newest plan.', inputSchema: { project } }, ({ project: p }) => ask(`/projects/${enc(p)}/findings`));
  server.registerTool('specguard_plans', { description: 'Remediation plans, or one plan with every item and its status history.', inputSchema: { project, plan: z.string().optional().describe('Plan id or "latest"; omit to list.') } }, ({ project: p, plan }) => ask(`/projects/${enc(p)}/security/plans${plan ? `/${enc(plan)}` : ''}`));
  return server;
}

/** Answer one MCP HTTP request. The body was read and parsed by the caller. */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, body: unknown, api: Api, identity: Identity): Promise<void> {
  const server = buildRemoteMcp(api, identity);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
